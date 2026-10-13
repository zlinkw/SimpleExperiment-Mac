import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { planConfigScalarTokens, planStaticConfigReferences } from "./PlanArchive";
import { type DistributedQueue, canonicalProjectId, remoteTaskMatchesJob } from "./DistributedPlanQueue";
import { type PlanSyncLedger } from "./PlanArtifactSync";
import { cleanupDigest, cleanupRelative, cleanupError, type CleanupScope, type CleanupNode, type CleanupCandidate, type CleanupRemovedMetadata, type CleanupJobSelection } from "./PlanCleanup";
import { datasetPathKey, tablePaths } from "../results/ResultLayout";
import { methodTableName } from "../results/ProjectResultTables";

const terminal = new Set(["completed", "failed", "cancelled"]);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const normalized = (value: string) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
const ancestor = (a: string, b: string) => b === a || b.startsWith(a + "/");
const sameFile = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
export const cleanupStablePlanId = (text: string) => text.match(/^(?:plan_id|stable_plan_id):[ \t]*["']?([A-Za-z0-9._-]+)["']?[ \t]*$/m)?.[1];

export type CleanupEvidenceInput = { root: string; planFile: string; queue: DistributedQueue; ledger: PlanSyncLedger;
  nodes: CleanupNode[]; snapshots: Array<{ workerId: string; tasks?: any[]; error?: string; generatedAt?: string; fetchedAt?: string }>;
  operations?: any[]; registry?: any; resultDir?: string; extraEvidence?: CleanupCandidate[]; allowMissing?: boolean; archivedFiles?: Record<string, string>; removedMetadata?: CleanupRemovedMetadata; job?: CleanupJobSelection };

async function literalPlans(root: string): Promise<Array<{ file: string; text: string }>> {
  const found: Array<{ file: string; text: string }> = [];
  const walk = async (dir: string) => {
    const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch((error: any) => { if (error.code === "ENOENT") return []; throw error; });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("LINK_OR_REPARSE_POINT: " + dir + "/" + entry.name);
      const file = dir + "/" + entry.name;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        const stat = await fs.stat(path.join(root, file));
        if (stat.size > 1024 * 1024 || found.length > 5000) throw new Error("PLAN_SCAN_LIMIT");
        found.push({ file, text: await fs.readFile(path.join(root, file), "utf8") });
      }
    }
  };
  await walk("experiments/plans"); await walk("experiments/drafts"); await walk("tmp/plan");
  return found;
}

/** Read-only joins from registered attempts/sync receipts. Unknown legacy ownership is report-only. */
export async function collectPlanCleanupEvidence(input: CleanupEvidenceInput): Promise<CleanupScope> {
  if (input.job && (Object.keys(input.job).sort().join(",") !== "commandId,index,workflowId" || typeof input.job.workflowId !== "string"
      || typeof input.job.commandId !== "string" || !Number.isInteger(input.job.index))) cleanupError("INVALID_JOB_SELECTION");
  const file = cleanupRelative(normalized(input.planFile)), projectId = canonicalProjectId(input.root);
  const plans = await literalPlans(input.root);
  const virtual = new Map<string, string>();
  for (const [source, destination] of Object.entries(input.archivedFiles || {})) {
    cleanupRelative(source); cleanupRelative(destination);
    if (!destination.startsWith("clean_dir/")) throw new Error("UNSAFE_ARCHIVED_PATH");
    if (await fs.lstat(path.join(input.root, source)).then(() => true, (error: any) => { if (error.code === "ENOENT") return false; throw error; }))
      throw new Error("SOURCE_RECREATED_OR_CHANGED");
    const text = await fs.readFile(path.join(input.root, destination), "utf8");
    virtual.set(source, text);
    if (/^(?:experiments\/(?:plans|drafts)|tmp\/plan)\//.test(source)) plans.push({ file: source, text });
  }
  const removed = input.removedMetadata;
  for (const source of Object.keys(removed?.hashes || {})) {
    cleanupRelative(source);
    if (await fs.lstat(path.join(input.root, source)).then(() => true, (error: any) => { if (error.code === "ENOENT") return false; throw error; }))
      throw new Error("SOURCE_RECREATED_OR_CHANGED");
  }
  for (const source of Object.keys(removed?.hashes || {})) if (/^(?:experiments\/(?:plans|drafts)|tmp\/plan)\//.test(source)
    && !plans.some(row => sameFile(row.file, source))) plans.push({ file: source, text: "" });
  const planSha = (row: { file: string; text: string }) => removed?.hashes[row.file] || sha(row.text);
  const current = plans.find(row => sameFile(row.file, file));
  if (!current && !input.allowMissing) throw new Error("PLAN_NOT_FOUND");
  const stable = current && cleanupStablePlanId(current.text);
  const planKey = removed?.hashes[file] ? removed.planKey : cleanupDigest([projectId, stable || file]);
  const aliases = new Set(plans.filter(row => stable && cleanupStablePlanId(row.text) === stable).map(row => row.file));
  aliases.add(file);
  const selected = input.queue.plans.filter(row => (!input.job || row.id === input.job.workflowId)
    && (removed?.runIds.includes(row.id) || stable && row.stablePlanId === stable || [...aliases].some(alias => sameFile(normalized(row.planFile), alias))));
  const selectedJob = input.job && selected[0]?.jobs.find(job => job.index === input.job!.index && job.commandId === input.job!.commandId);
  if (input.job && (!Number.isInteger(input.job.index) || !input.job.workflowId || !input.job.commandId || selected.length !== 1
      || !selectedJob || selected[0].projectId !== projectId || selected[0].resultPathPolicy !== "declared"
      || !selectedJob.collectionResultCsv
      || selectedJob.globalJobId !== input.job.workflowId + ":" + input.job.index || selectedJob.status !== "failed"
      || selectedJob.reassignmentPending || selectedJob.unavailable || selectedJob.outputDir.split("/").includes("attempts")))
    cleanupError("FAILED_JOB_SCOPE_UNVERIFIED", "仅支持当前项目中身份完整、已停止的原正式失败 job；未改变清理范围。");
  const selectedJobs = (plan: typeof selected[number]) => input.job ? plan.jobs.filter(job => job === selectedJob) : plan.jobs;
  selected.forEach(row => aliases.add(normalized(row.planFile)));
  const runIds = selected.map(row => row.id), candidates: CleanupCandidate[] = [];
  // Exact publication paths come from the existing result layout and registry,
  // never from a directory/method prefix. Regenerated views are not cleanup targets.
  const generatedResults = new Set<string>();
  const resultDir = cleanupRelative(normalized(input.resultDir || "experiments/results"));
  for (const entry of Object.values(input.registry?.plans || {}) as any[]) for (const record of entry.records || []) {
    try {
      for (const table of [tablePaths(datasetPathKey(record.dataset), "final", "final"),
        tablePaths(datasetPathKey(record.dataset), methodTableName(record.method), "method")]) {
        generatedResults.add(path.posix.join(resultDir, table.relativePath));
        generatedResults.add(path.posix.join(resultDir, table.markdownPath));
      }
    } catch { /* Unrecognized records cannot establish an exclusion. */ }
  }
  const blockers: CleanupScope["blockers"] = [];
  const notices: NonNullable<CleanupScope["notices"]> = [];
  const configNotice = (config: string, source: string) => {
    const detail = source + "：" + config;
    if (!notices.some(row => row.code === "CONFIG_REFERENCE_UNVERIFIED" && row.detail === detail))
      notices.push({ code: "CONFIG_REFERENCE_UNVERIFIED", detail });
  };
  const scope: CleanupScope = { projectId, planKey, planFile: file, planHash: removed?.hashes[file] || (current ? sha(current.text) : "absent"), runIds, revision: "",
    nodes: input.nodes, candidates, blockers, notices, ...(input.job ? { job: { ...input.job } } : {}) };
  const add = (nodeId: string, rel: string, type: CleanupCandidate["type"], category: string, evidence: string[], owners = [planKey], protectedReason?: string) => {
    try { rel = cleanupRelative(normalized(rel)); }
    catch { blockers.push({ code: "UNSAFE_RECORDED_PATH", nodeId, detail: String(rel) }); return; }
    if (nodeId === "local" && generatedResults.has(rel)) return;
    const existing = candidates.find(row => row.nodeId === nodeId && row.relativePath === rel);
    if (existing) { existing.evidence = [...new Set([...existing.evidence, ...evidence])]; existing.owners = [...new Set([...existing.owners, ...owners])]; existing.protectedReason ||= protectedReason; return; }
    candidates.push({ nodeId, relativePath: rel, type, category, evidence, owners, dependencies: [], ...(protectedReason ? { protectedReason } : {}) });
  };
  for (const alias of plans.filter(row => aliases.has(row.file))) {
    add("local", alias.file, "file", "PLAN 文件", ["项目规范路径=" + projectId, "PLAN SHA256=" + planSha(alias), "PLAN ID=" + planKey]);
    candidates.find(row => row.relativePath === alias.file)!.expectedSha256 = removed?.hashes[alias.file] || sha(alias.text);
  }
  // The full graph includes config inheritance, not merely references of the selected PLAN.
  const configRefs = new Map<string, Set<string>>(), configHashes: Record<string, string> = {};
  const ownerPlans = new Map<string, Set<string>>();
  const resolveConfig = (value: string, parent?: string) => {
    let rel = normalized(value);
    if (path.isAbsolute(rel)) rel = normalized(path.relative(input.root, rel));
    else if (parent && !/^(?:configs|tmp\/config)\//i.test(rel)) rel = path.posix.join(path.posix.dirname(parent), rel);
    rel = cleanupRelative(path.posix.normalize(rel));
    // Windows aliases must join the same physical config before exclusivity is decided.
    return [...configRefs.keys()].find(existing => sameFile(existing, rel)) || rel;
  };
  const externalAssetRefs: Array<{ owner: string; path: string }> = [];
  const dynamicConfig = (text: string) => /\$\{|!(?:include|inherit)\b|(?:^|[\s:])[*&][A-Za-z_]/m.test(text);
  let unknownConfigReferences = plans.some(plan => dynamicConfig(plan.text))
    || input.queue.plans.some(plan => !aliases.has(normalized(plan.planFile)) && !plans.some(row => sameFile(row.file, normalized(plan.planFile))));
  const configGraph = async (config: string, owner: string, visiting = new Set<string>()) => {
    config = resolveConfig(config);
    const users = configRefs.get(config) || new Set<string>(); users.add(owner); configRefs.set(config, users);
    if (visiting.has(config)) return;
    visiting.add(config);
    const text = virtual.has(config) ? virtual.get(config)! : await fs.readFile(path.join(input.root, config), "utf8").catch((error: any) => {
      if (error.code === "ENOENT") {
        if (!removed?.hashes[config]) { unknownConfigReferences = true; configNotice(config, "配置文件缺失"); }
        return "";
      }
      throw error;
    });
    configHashes[config] = removed?.hashes[config] || sha(text);
    unknownConfigReferences ||= dynamicConfig(text) || /\.py$/i.test(config);
    for (const match of text.matchAll(/^[ \t]*(?:checkpoint(?:_path)?|pretrained(?:_path)?|weights(?:_path)?|resume(?:_from)?|code_backup_ref):[ \t]*["']?([^\r\n"'#]+)["']?[ \t]*(?:#.*)?$/gm)) {
      let asset = normalized(match[1].trim());
      if (/\$\{|!(?:include|inherit)\b/.test(asset)) continue;
      for (const node of input.nodes) {
        const base = normalized(node.root).replace(/\/$/, "");
        if (base && asset.startsWith(base + "/")) asset = asset.slice(base.length + 1);
      }
      if (asset.startsWith("./") || asset.startsWith("../")) asset = path.posix.normalize(path.posix.join(path.posix.dirname(config), asset));
      try { externalAssetRefs.push({ owner, path: cleanupRelative(asset) }); } catch {}
    }
    // A result/data filename in a config is not ownership of another config.
    // Only explicit config/inheritance fields may introduce cleanup candidates.
    const configKey = /^(?:_base_|base[-_]config|config(?:[-_](?:file|path))?|cfg|extends|inherits?|includes?)$/i;
    const values = [...text.matchAll(/^[ \t]*(?:-[ \t]*)?(?:_base_|base[-_]config|config(?:[-_](?:file|path))?|cfg|extends|inherits?|includes?)[ \t]*:[ \t]*([^\r\n]*(?:\r?\n[ \t]+-[^\r\n]*)*)/gmi)].map(match => match[1]);
    if (/\.json$/i.test(config)) {
      const visit = (value: any) => {
        if (!value || typeof value !== "object") return;
        for (const [key, item] of Object.entries(value)) {
          if (configKey.test(key)) values.push(...(Array.isArray(item) ? item : [item]).filter((entry): entry is string => typeof entry === "string"));
          else visit(item);
        }
      };
      try { visit(JSON.parse(text)); } catch { unknownConfigReferences = true; }
    }
    const refs = [...new Set([...planStaticConfigReferences(text), ...values.flatMap(value =>
      [...value.matchAll(/(?:["']([^"'\r\n]+\.(?:ya?ml|json))["']|(?:^|[\s\[,])([A-Za-z0-9_./\\:-]+\.(?:ya?ml|json))(?=$|[\s\],#]))/gmi)].map(match => match[1] || match[2]))])];
    for (const ref of refs) {
      try { await configGraph(resolveConfig(ref, config), owner, visiting); }
      catch { unknownConfigReferences = true; configNotice(ref, config); }
    }
  };
  for (const plan of plans) {
    const owner = aliases.has(plan.file) ? planKey : cleanupDigest([projectId, plan.file]);
    const names = ownerPlans.get(owner) || new Set<string>(); names.add(plan.file); ownerPlans.set(owner, names);
    // The archive parser omits absolute command arguments; cleanup must still
    // account for those references before claiming a local config is exclusive.
    const commandConfigs = [...plan.text.matchAll(/(?:--(?:base[-_]config|config(?:[-_](?:file|path))?|cfg)(?:\s*=\s*|\s+)|(?:^|[\s;&|])(?:base_config|config|cfg)\s*=\s*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;&|"']+))/gmi)]
      .map(match => match[1] || match[2] || match[3]);
    // {config} is the runner's generated job config, bound through this PLAN's
    // literal config declaration. Other templates cannot prove exclusivity.
    const hasConfigBinding = planConfigScalarTokens(plan.text).length > 0;
    for (const config of new Set([...planStaticConfigReferences(plan.text), ...commandConfigs])) {
      if (config === "{config}" && hasConfigBinding) continue;
      try { await configGraph(config, owner); }
      catch { unknownConfigReferences = true; configNotice(config, plan.file); }
    }
  }
  if (removed) for (const [config, owners] of Object.entries(removed.references)) if (owners.includes(planKey)) {
    await configGraph(config, planKey);
    // Retain old external dependents conservatively; current PLAN scans can add further dependents.
    for (const owner of owners) configRefs.get(config)!.add(owner);
  }
  for (const [config, owners] of configRefs) if (owners.has(planKey)) {
    const shared = owners.size > 1 || !/^(?:configs|tmp\/config)\//i.test(config) || /(?:^|\/)(?:base|_base_|defaults)(?:\/|\.)/i.test(config);
    add("local", config, "file", "专用配置", ["PLAN 配置引用图（含继承/命令/规范路径）：" + [...owners].flatMap(owner => [...ownerPlans.get(owner) || [owner]]).join("；"), "配置 SHA256=" + configHashes[config]], [...owners], shared ? "共享或基础配置" : unknownConfigReferences ? "动态/缺失历史 PLAN 的配置引用无法证明独占" : undefined);
    candidates.find(row => row.relativePath === config)!.expectedSha256 = configHashes[config];
  }
  const selectedIds = new Set(runIds);
  const associations = new Set<string>();
  for (const plan of selected) {
    if (plan.projectId && plan.projectId !== projectId) { blockers.push({ code: "PROJECT_ID_MISMATCH", detail: plan.id }); continue; }
    for (const job of selectedJobs(plan)) {
      if (!terminal.has(job.status) || job.reassignmentPending || job.automaticRetry?.retryAt && !job.automaticRetry.exhausted)
        blockers.push({ code: "ACTIVE_JOB", nodeId: job.workerId, detail: plan.id + ":" + job.index });
      for (const attempt of input.job ? [job] : [job, ...(job.history || [])]) {
        if (plan.resultPathPolicy === "declared" && attempt !== job && attempt.workerId === job.workerId
            && normalized(attempt.outputDir) === normalized(job.outputDir)) continue;
        const workerIds = [...new Set([attempt.workerId, ...job.fragmentWorkerIds || [], ...job.mirroredWorkerIds || []].filter(Boolean))] as string[];
        workerIds.forEach(id => associations.add(id));
        const output = normalized(attempt.outputDir);
        const conflicts = input.queue.plans.flatMap(other => other.jobs.filter(row => other.id !== plan.id || row.index !== job.index).flatMap(row => [row, ...(row.history || [])]))
          .filter(other => ancestor(output, normalized(other.outputDir)) || ancestor(normalized(other.outputDir), output));
        const trusted = Boolean(plan.projectId === projectId && plan.id && plan.revision && job.case && Number.isInteger(job.seed)
          && (plan.resultPathPolicy === "declared" ? job.globalJobId === plan.id + ":" + job.index && !output.split("/").includes("attempts") : Number.isInteger(attempt.attempt))
          && attempt.commandId && attempt.workerId && output);
        const reason = !trusted ? "旧记录缺少完整项目/job/attempt/命令所有权" : conflicts.length ? "其他 PLAN/job 引用该目录" : undefined;
        const evidence = ["任务登记 workflow=" + plan.id, "PLAN revision=" + plan.revision, "case=" + job.case + " seed=" + job.seed,
          "fold=" + String((job as any).fold ?? "未登记"),
          (plan.resultPathPolicy === "declared" ? "globalJobId=" + job.globalJobId : "attempt=" + attempt.attempt) + " commandId=" + (attempt.commandId || "未核实"), "Worker=" + (attempt.workerId || "未核实")];
        for (const worker of workerIds) {
          add(worker, output, "directory", "作业产物（权重/日志/预测/指标/协议/快照）", evidence, [planKey], reason);
          if (trusted) candidates.find(row => row.nodeId === worker && row.relativePath === output)!.expectedOwner = {
            workflowId: plan.id, commandId: attempt.commandId!, workerId: attempt.workerId!, outputDir: output,
            ...(plan.resultPathPolicy === "declared" ? { resultPathPolicy: "declared", globalJobId: job.globalJobId, index: job.index,
              planRevision: plan.revision, codeFingerprint: plan.codeFingerprint, collectionResultCsv: job.collectionResultCsv,
              ...(input.job ? { expectedState: "failed" } : {}) } : { attempt: attempt.attempt }), case: job.case, seed: job.seed };
        }
        if (input.job && job.collectionResultCsv && !ancestor(output, normalized(job.collectionResultCsv))) {
          add(attempt.workerId!, job.collectionResultCsv, "file", "该 job 声明的独立指标", [...evidence, "精确 collectionResultCsv 声明"], [planKey], reason);
          candidates.find(row => row.nodeId === attempt.workerId && row.relativePath === normalized(job.collectionResultCsv!))!.expectedOwner =
            candidates.find(row => row.nodeId === attempt.workerId && row.relativePath === output)!.expectedOwner;
        }
        // A local mirror is owned only when synchronization history declares that exact directory.
        for (const entry of Object.values(input.ledger.entries)) if (entry.runId === plan.id && sameFile(normalized(entry.planFile), normalized(plan.planFile))) {
          const synced = Object.entries(entry.destinations || {}).filter(([, receipt]) => receipt.status === "synced").map(([id]) => id);
          for (const destination of synced) {
            associations.add(destination);
            if ((entry.directoryPaths || []).includes(output)) {
              add(destination, output, "directory", "同步副本", [...evidence, "已确认同步 runId=" + entry.runId], [planKey], reason);
              candidates.find(row => row.nodeId === destination && row.relativePath === output)!.expectedOwner =
                candidates.find(row => row.nodeId === attempt.workerId && row.relativePath === output)?.expectedOwner;
            }
          }
        }
        for (const [artifact, hash] of Object.entries(job.artifacts || {})) if (/^[a-f0-9]{64}$/i.test(hash)) {
          const rel = normalized(artifact);
          if (!ancestor(output, rel)) add(job.workerId || "unverified", rel, "file", "登记的独立产物", [...evidence, "产物 SHA256=" + hash], [planKey], "需要独立 manifest 与外部引用证明");
        }
      }
    }
  }
  const knownCommands = new Set(selected.flatMap(plan => selectedJobs(plan).flatMap(job => [job, ...(job.history || [])]).map(attempt => attempt.commandId).filter(Boolean)));
  for (const snapshot of input.snapshots) for (const task of snapshot.tasks || []) {
    if (selectedJob && task.commandId !== selectedJob.commandId && !ancestor(selectedJob.outputDir, normalized(task.outputDir || task.output_dir || ""))
        && !ancestor(normalized(task.outputDir || task.output_dir || ""), selectedJob.outputDir)) continue;
    const taskPlan = normalized(task.planFile || task.plan_file || "");
    if (![...aliases].some(alias => sameFile(alias, taskPlan)) && !(stable && task.stablePlanId === stable)) continue;
    if (task.projectId && task.projectId !== projectId || knownCommands.has(task.commandId)) continue;
    associations.add(snapshot.workerId);
    const output = normalized(task.outputDir || task.output_dir || "");
    if (!output) { blockers.push({ code: "TASK_OUTPUT_UNVERIFIED", nodeId: snapshot.workerId, detail: String(task.commandId || "旧任务无精确产物登记") }); continue; }
    add(snapshot.workerId, output, "directory", "旧任务登记产物", ["当前任务登记的精确 PLAN=" + taskPlan,
      "workflow=" + String(task.workflowId || task.planWorkflowId || "未登记"), "commandId=" + String(task.commandId || "未登记")], [planKey],
      "缺少完整持久队列/版本及独占依赖证据；仅报告");
  }
  for (const entry of Object.values(input.ledger.entries)) if ([...aliases].some(alias => sameFile(normalized(entry.planFile), alias))) {
    associations.add(entry.sourceWorkerId); Object.keys(entry.destinations || {}).forEach(id => associations.add(id));
    for (const remote of [entry.sourceWorkerId, ...Object.keys(entry.destinations || {})]) {
      const localPlan = plans.find(row => sameFile(row.file, normalized(entry.planFile)));
      const confirmed = selectedIds.has(entry.runId) && (remote === entry.sourceWorkerId || entry.destinations[remote]?.status === "synced");
      add(remote, entry.planFile, "file", "远端 PLAN 同步副本", ["同步登记 revision=" + entry.revision + " runId=" + entry.runId, "精确 PLAN 路径与当前文件 SHA256 绑定"], [planKey],
        confirmed && localPlan ? undefined : "缺少已确认运行或 PLAN 文件哈希证据");
      if (confirmed && localPlan) {
        candidates.find(row => row.nodeId === remote && row.relativePath === normalized(entry.planFile))!.expectedSha256 = planSha(localPlan);
        for (const config of candidates.filter(row => row.nodeId === "local" && row.category === "专用配置")) {
          add(remote, config.relativePath, "file", "远端配置同步副本", ["已确认同步关联 runId=" + entry.runId, ...config.evidence], config.owners, config.protectedReason);
          candidates.find(row => row.nodeId === remote && row.relativePath === config.relativePath)!.expectedSha256 = config.expectedSha256;
        }
      }
      for (const artifact of entry.artifactPaths || []) if (!candidates.some(row => row.nodeId === remote && ancestor(row.relativePath, artifact)))
        add(remote, artifact, "file", "结果索引/同步副本", ["同步登记 runId=" + entry.runId], [planKey], "正式/历史结果或缺少独占 manifest");
    }
  }
  for (const deferred of input.queue.deferred || []) if ([...aliases].some(alias => sameFile(normalized(deferred.planFile), alias)) && ["pending", "processing", "blocked"].includes(deferred.status))
    blockers.push({ code: "ACTIVE_DEFERRED_PLAN", detail: deferred.id });
  for (const recovery of input.queue.failedAttemptRecoveries || []) if (selectedIds.has(recovery.plan.id) && recovery.status !== "completed")
    blockers.push({ code: "ACTIVE_ATTEMPT_RECOVERY", nodeId: recovery.job.workerId, detail: recovery.id });
  if (selectedJob) {
    // A job review never moves the PLAN, configurations, siblings, old revisions or unregistered copies.
    candidates.splice(0, candidates.length, ...candidates.filter(row => row.relativePath === selectedJob.outputDir || row.relativePath === selectedJob.collectionResultCsv));
    const jobNodes = new Set(candidates.map(row => row.nodeId));
    scope.nodes = scope.nodes.filter(node => jobNodes.has(node.id));
    const task = input.snapshots.find(snapshot => snapshot.workerId === selectedJob.workerId)?.tasks?.find(task => task.commandId === selectedJob.commandId);
    if (!task || !remoteTaskMatchesJob(selected[0], selectedJob, task) || task.status !== "failed" || !(task.finishedAt || task.exitCode !== undefined))
      blockers.push({ code: "FAILED_JOB_STOP_UNVERIFIED", nodeId: selectedJob.workerId, detail: input.job!.commandId });
  }
  for (const id of associations) if (!input.nodes.some(node => node.id === id)) {
    scope.nodes.push({ id, kind: "remote", root: "", error: "历史关联节点缺少当前主机/端口/项目根配置" });
  }
  for (const node of scope.nodes.filter(node => node.kind === "remote")) {
    const snapshot = input.snapshots.find(row => row.workerId === node.id);
    if (!snapshot || snapshot.error || !Number.isFinite(Date.parse(snapshot.generatedAt || "")) || Date.now() - Date.parse(snapshot.generatedAt || "") > 180000) {
      node.error ||= snapshot?.error || "当前任务/队列证据不可达或过期";
      blockers.push({ code: "OFFLINE_NODE", nodeId: node.id, detail: node.error });
    } else {
      if ((snapshot.tasks || []).some(task => !terminal.has(String(task.status).toLowerCase()) && (!selectedJob
          || !task.outputDir || candidates.some(candidate => candidate.nodeId === node.id
            && (ancestor(candidate.relativePath, normalized(task.outputDir)) || ancestor(normalized(task.outputDir), candidate.relativePath))))))
        blockers.push({ code: "ACTIVE_NODE_TASK", nodeId: node.id, detail: "该项目节点存在运行/排队/待核实任务" });
      for (const candidate of candidates.filter(row => row.nodeId === node.id)) {
        const conflicts = (snapshot.tasks || []).filter(task => {
          const output = normalized(task.outputDir || task.output_dir || "");
          return output && (ancestor(candidate.relativePath, output) || ancestor(output, candidate.relativePath))
            && task.commandId !== candidate.expectedOwner?.commandId && (selectedJob || !runIds.includes(String(task.workflowId || task.planWorkflowId || "")));
        });
        if (conflicts.length) candidate.dependencies.push("当前节点其他命令登记引用该精确目录");
      }
    }
  }
  // Published indexes and their sources are paper/formal evidence, never rewrite merged tables here.
  const protectedPaths = new Set<string>();
  const visit = (value: unknown, paths: Set<string>, depth = 0) => {
    if (depth > 20) return;
    if (typeof value === "string") {
      const rel = normalized(value);
      if (rel.includes("/") && !path.isAbsolute(value)) { try { paths.add(cleanupRelative(rel)); } catch {} }
      for (const node of input.nodes) {
        const base = normalized(node.root).replace(/\/$/, "");
        if (base && rel.startsWith(base + "/")) { try { paths.add(cleanupRelative(rel.slice(base.length + 1))); } catch {} }
      }
    } else if (Array.isArray(value)) value.forEach(item => visit(item, paths, depth + 1));
    else if (value && typeof value === "object") Object.values(value).forEach(item => visit(item, paths, depth + 1));
  };
  visit(input.registry, protectedPaths);
  const selectedResultPaths = new Set<string>();
  for (const [planFile, entry] of Object.entries(input.registry?.plans || {}) as Array<[string, any]>)
    if ([...aliases].some(alias => sameFile(alias, normalized(planFile))) || (entry.records || []).some((record: any) => runIds.includes(record.runId)))
      visit(entry, selectedResultPaths);
  if (!input.registry?.plans && runIds.includes(input.registry?.planRun)) visit(input.registry, selectedResultPaths);
  for (const rel of selectedResultPaths) {
    if (selectedJob) continue;
    if (rel !== "simple_cluster/results/project_table_registry.json" && [resultDir, "tmp/result", "simple_cluster/results"].some(base => ancestor(base, rel)))
      add("local", rel, "file", "专用结果/原始 sidecar/结果索引", ["项目结果索引的精确路径引用"], [planKey], "已有正式/历史或共享结果受保护");
  }
  for (const candidate of candidates) for (const ref of protectedPaths) if (ancestor(candidate.relativePath, ref))
    candidate.dependencies.push("正式/历史结果引用 " + ref);
  for (const candidate of candidates) for (const ref of externalAssetRefs) if (ref.owner !== planKey && ancestor(candidate.relativePath, ref.path))
    candidate.dependencies.push("其他 PLAN 配置引用 checkpoint/权重/代码备份 " + ref.path);
  if (selectedJob) for (const candidate of candidates) for (const plan of input.queue.plans) for (const other of plan.jobs) {
    if (plan.id === input.job!.workflowId && other.index === input.job!.index) continue;
    const otherCsv = normalized(other.collectionResultCsv || "");
    if (otherCsv && ancestor(candidate.relativePath, otherCsv)) candidate.dependencies.push("其他 job 登记的指标路径：" + plan.id + ":" + other.index);
    for (const key of ["checkpoint_path", "config_path"]) {
      let ref = normalized(other.checkpointSource?.[key] || "");
      for (const node of input.nodes) if (ref.startsWith(normalized(node.root).replace(/\/$/, "") + "/")) ref = ref.slice(normalized(node.root).replace(/\/$/, "").length + 1);
      if (ref && ancestor(candidate.relativePath, ref)) candidate.dependencies.push("其他 job 已登记的 checkpoint 来源：" + plan.id + ":" + other.index);
    }
  }
  if (!selectedJob) candidates.push(...input.extraEvidence || []);
  // Use registered identities and exact path overlap, never a name prefix or age.
  // A known unrelated PLAN with bounded, nonoverlapping paths is not this batch's
  // active operation. Unscoped operations still block because exclusion is unproven.
  const operationPath = (value: string) => {
    let rel = normalized(value);
    if (path.isAbsolute(rel) || rel.startsWith("/")) {
      const base = input.nodes.map(node => normalized(node.root).replace(/\/$/, ""))
        .find(root => root && (sameFile(root, rel) || (process.platform === "win32" ? rel.toLowerCase().startsWith(root.toLowerCase() + "/") : rel.startsWith(root + "/"))));
      if (!base) return;
      rel = sameFile(base, rel) ? "" : rel.slice(base.length + 1);
    }
    if (!rel) return ""; // Project-root operations overlap every target.
    try { return cleanupRelative(rel); } catch { return; }
  };
  for (const operation of input.operations || []) if (["running", "queued", "pending", "accepted"].includes(operation.status)) {
    const identities: string[] = [], paths: string[] = [];
    let unboundedPath = false;
    const inspect = (record: any, depth = 0) => {
      if (!record || typeof record !== "object" || depth > 8) return;
      if (Array.isArray(record)) { record.slice(0, 500).forEach(row => inspect(row, depth + 1)); return; }
      for (const [key, value] of Object.entries(record)) {
        if (/^(?:planFile|plan_file|planPath|plan_path|selectedPlanId|stablePlanId|stable_plan_id|planKey|workflowId|workflow_id|planWorkflowId|runId|commandId|command_id|targetCommandId)$/.test(key) && typeof value === "string" && value) {
          identities.push(value);
        } else if (/^(?:outputDir|output_dir|targetPath|relativePath|approvedAbsolutePath|approvedDestination|sourcePath|destinationPath|localPath|remotePath|path)$/.test(key) && typeof value === "string" && value) {
          const rel = operationPath(value);
          if (rel === undefined) unboundedPath = true; else paths.push(rel);
        } else if (["payload", "params", "request", "target", "targets", "latestEvent"].includes(key)) inspect(value, depth + 1);
      }
    };
    inspect(operation);
    const matches = identities.some(value => knownCommands.has(value) || !selectedJob && (selectedIds.has(value) || value === planKey || stable && value === stable
      || [...aliases].some(alias => sameFile(alias, operationPath(value) || normalized(value)))));
    const overlaps = paths.some(rel => rel === "" || candidates.some(candidate => {
      const a = process.platform === "win32" ? rel.toLowerCase() : rel;
      const b = process.platform === "win32" ? candidate.relativePath.toLowerCase() : candidate.relativePath;
      return ancestor(a, b) || ancestor(b, a);
    }));
    if (matches || overlaps || !identities.length || !paths.length || unboundedPath)
      blockers.push({ code: "ACTIVE_OPERATION", detail: String(operation.operationId || operation.id || operation.opId || operation.kind || "操作") });
  }
  candidates.forEach(candidate => { candidate.owners.sort(); candidate.dependencies.sort(); });
  candidates.sort((a, b) => Number(a.category === "PLAN 文件") - Number(b.category === "PLAN 文件") || a.nodeId.localeCompare(b.nodeId) || a.relativePath.localeCompare(b.relativePath));
  scope.nodes = scope.nodes.filter(node => node.id === "local" || associations.has(node.id));
  scope.blockers = blockers.filter(row => !row.nodeId || scope.nodes.some(node => node.id === row.nodeId));
  scope.references = Object.fromEntries([...configRefs].map(([config, owners]) => [config, [...owners]]));
  // Exclude lifecycle markers and wall-clock freshness from the revision, retain every ownership/status field.
  scope.revision = cleanupDigest({ projectId, file, resultDir, planHash: scope.planHash, plans: plans.map(row => [row.file, planSha(row)]).sort(), configHashes: Object.fromEntries(Object.entries(configHashes).sort()),
    queue: input.queue.plans.map(plan => ({ ...plan, cleanup: undefined, jobs: plan.jobs.map(job => ({ ...job, cleanup: undefined })) })), removedMetadata: removed, deferred: input.queue.deferred,
    recoveries: input.queue.failedAttemptRecoveries, ledger: input.ledger, nodes: scope.nodes.map(node => ({ ...node, error: undefined })), candidates, notices });
  return scope;
}
