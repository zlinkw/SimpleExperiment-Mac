import { cleanupDigest, cleanupRelative, type CleanupNode, type CleanupCandidate, type CleanupProgressSink } from "./PlanCleanup";

export type ManifestDeclaration = { index: number; case: string; seed: number; output_dir: string; result_csv: string };
export type ManifestSelection = { declarations: ManifestDeclaration[]; replacement: boolean };
const spelling = (value: unknown) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
function relativeTo(node: CleanupNode, value: unknown) {
  const text = spelling(value), prefix = spelling(node.root).replace(/\/+$/, "") + "/";
  return cleanupRelative(text.startsWith(prefix) ? text.slice(prefix.length) : text);
}
function linkedPlan(node: CleanupNode, value: unknown, file: string) {
  try { return relativeTo(node, value).toLowerCase() === spelling(file).toLowerCase(); } catch { return false; }
}

/** Historical records locate exact paths only. Their status/revision is never an ownership gate. */
export function recordedDeclarations(queue: any, file: string): ManifestDeclaration[] {
  const result: ManifestDeclaration[] = [];
  for (const plan of queue.plans || []) if (spelling(plan.planFile).toLowerCase() === spelling(file).toLowerCase()) {
    for (const job of plan.jobs || []) result.push({ index: job.index, case: job.case, seed: job.seed,
      output_dir: job.outputDir, result_csv: job.collectionResultCsv });
  }
  for (const job of queue.clearedJobs || []) if (spelling(job.planFile).toLowerCase() === spelling(file).toLowerCase())
    result.push({ index: job.experimentIndex, case: job.case, seed: job.seed, output_dir: job.outputDir, result_csv: job.collectionResultCsv });
  return result;
}

/** Only frozen declarations and actual per-output manifests authorize candidates. */
export async function discoverManifestCandidates(host: any, root: string, file: string, nodes: CleanupNode[], queue: any,
  explicit: ManifestDeclaration[] = [], pathOnly = false, onProgress?: CleanupProgressSink) {
  const declarations = [...explicit];
  const notices: any[] = [], blockers: any[] = [], candidates: CleanupCandidate[] = [];
  // Describe is the existing Scheduler's pure expansion; no sync, preview attempt, or project callback.
  await Promise.all(nodes.filter(node => !explicit.length && node.kind === "remote" && !node.error).map(async node => {
    try {
      const worker = (host.setupConfig.workerTunnels || []).find((row: any) => row.id === node.id);
      const response = await host.client.getWorkerTasks(node.id, { signal: AbortSignal.timeout(10000),
        discovery: { planFile: file, condaEnv: worker?.condaEnv || "" } });
      if (Array.isArray(response?.declaredJobs)) declarations.push(...response.declaredJobs);
    } catch (error: any) { notices.push({ code: "DECLARATIONS_QUERY_NOTICE", nodeId: node.id, detail: String(error.message || error) }); }
  }));
  // Historical paths are locators only when current expansion is unavailable.
  // They must not multiply a current PLAN review with every former output root.
  if (!declarations.length) declarations.push(...recordedDeclarations(queue, file));
  const unique = [...new Map(declarations.filter(row => row?.output_dir).map(row =>
    [spelling(row.output_dir) + "\0" + spelling(row.result_csv), row])).values()]
    .sort((a,b) => spelling(a.output_dir).localeCompare(spelling(b.output_dir)) || spelling(a.result_csv).localeCompare(spelling(b.result_csv)));
  if (!unique.length && nodes.some(node => node.kind === "remote"))
    blockers.push({ code: "PLAN_DECLARATIONS_UNVERIFIED", detail: "无法取得所选 PLAN 的精确 job 声明；可恢复连接后主动重查，未推断目录归属。" });
  const selected = explicit.length ? unique.filter(row => explicit.some(item => spelling(item.output_dir) === spelling(row.output_dir)
    && spelling(item.result_csv) === spelling(row.result_csv))) : unique;
  const planKey = cleanupDigest([root, file]);
  // One bounded read per actual node/output, even if several result declarations
  // refer to it. Process evidence below in a stable order, independent of latency.
  const reads = new Map<string, Promise<any>>(), requests: Array<() => Promise<void>> = [];
  let completed = 0;
  const keyFor = (node: CleanupNode, output: string) => JSON.stringify([node.id, output]);
  for (const node of nodes.filter(node => !node.error)) for (const declaration of selected) {
    let output: string;
    try { output = relativeTo(node, declaration.output_dir); } catch { continue; }
    const key = keyFor(node, output);
    if (reads.has(key)) continue;
    let resolve!: (value: any) => void;
    reads.set(key, new Promise(done => { resolve = done; }));
    requests.push(async () => {
      try { resolve({ info: await host.simpleSftpApiCall("files.cleanup.inspect", {
        node, target: { relativePath: output, type: "directory" }, manifestOnly: true, allowMissing: true }) }); }
      catch (error: any) { resolve({ error: String(error.message || error) }); }
      finally { try { onProgress?.({ phase: "manifests", message: node.id + "：已核对 " + output, completed: ++completed, total: requests.length }); } catch {} }
    });
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, async () => {
    while (cursor < requests.length) await requests[cursor++]();
  }));
  for (const node of nodes) {
    if (node.error) { blockers.push({ code: "OFFLINE_NODE", nodeId: node.id, detail: node.error }); continue; }
    for (const declaration of selected) {
      let output: string, csv = "";
      try { output = relativeTo(node, declaration.output_dir); }
      catch { blockers.push({ code: "UNSAFE_DECLARED_PATH", nodeId: node.id, detail: "output_dir：" + declaration.output_dir }); continue; }
      // Older cleared-job indexes only retained outputDir. An absent CSV is
      // missing discovery information, not an unsafe output path on every node.
      if (spelling(declaration.result_csv)) {
        try { csv = relativeTo(node, declaration.result_csv); }
        catch { blockers.push({ code: "UNSAFE_DECLARED_PATH", nodeId: node.id, detail: "result_csv：" + declaration.result_csv }); continue; }
      }
      const observed = await reads.get(keyFor(node, output))!;
      if (observed.error) { blockers.push({ code: "NODE_UNREACHABLE", nodeId: node.id, detail: observed.error }); continue; }
      const info = observed.info;
      if (info.target?.missing) continue;
      const records = info.target?.manifests || [];
      const linkedOwners = records.filter((record: any) => {
        const binding = record.binding || {};
        let ownedOutput = false;
        try { ownedOutput = relativeTo(node, binding.outputDir) === output; } catch {}
        const linked = linkedPlan(node, binding.planFile, file) || (record.planHints || []).some((hint: string) => linkedPlan(node, hint, file));
        const logical = binding.index !== undefined && Number(binding.index) === Number(declaration.index)
          || binding.case === declaration.case && Number(binding.seed) === Number(declaration.seed);
        return linked && ownedOutput && logical;
      });
      if (!linkedOwners.length) {
        if (pathOnly) {
          notices.push({ code: "PATH_CONFIRMATION_REQUIRED", nodeId: node.id, detail: output + "：任务关联未核实，请直接核对服务器及完整路径后决定删除。" });
          candidates.push({ nodeId: node.id, relativePath: output, type: "directory", category: "用户确认的任务输出目录",
            owners: [planKey], evidence: ["PLAN/旧记录定位路径=" + declaration.output_dir], dependencies: [] });
          if (csv && !csv.startsWith(output + "/")) candidates.push({ nodeId: node.id, relativePath: csv, type: "file", category: "用户确认的结果文件",
            owners: [planKey], evidence: ["声明结果路径=" + declaration.result_csv], dependencies: [] });
          continue;
        }
        blockers.push({ code: "OWNERSHIP_UNVERIFIED", nodeId: node.id, detail: output + "：产物清单尚不能证明与所选 PLAN/job 的关联" });
        candidates.push({ nodeId: node.id, relativePath: output, type: "directory", category: "归属未核实产物",
          owners: [], evidence: ["PLAN 精确声明=" + declaration.output_dir], dependencies: [], protectedReason: "清单关联未核实，只报告" });
        continue;
      }
      const owner = linkedOwners.find((record: any) => spelling(record.binding?.resultCsv)) || linkedOwners[0];
      if (!csv) {
        const manifestResults = new Set<string>();
        let unsafeResult = false;
        for (const record of linkedOwners) if (spelling(record.binding?.resultCsv)) {
          try { manifestResults.add(relativeTo(node, record.binding.resultCsv)); }
          catch { unsafeResult = true; blockers.push({ code: "UNSAFE_MANIFEST_RESULT_PATH", nodeId: node.id,
            detail: "产物清单中的结果路径无法安全解析：" + record.binding.resultCsv }); }
        }
        if (unsafeResult && !pathOnly) continue;
        if (manifestResults.size > 1) {
          blockers.push({ code: "RESULT_MANIFEST_LINK_UNVERIFIED", nodeId: node.id, detail: output + "：清单记录了不同的结果路径，需要核对" });
          if (!pathOnly) continue;
        }
        csv = !unsafeResult && manifestResults.size <= 1 ? [...manifestResults][0] || "" : "";
        notices.push({ code: "RESULT_PATH_FROM_MANIFEST", nodeId: node.id, detail: csv
          ? "旧记录未保存结果路径，已从匹配该任务的产物清单取得：" + csv
          : "旧记录和清单未提供独立结果路径；本次只审核已证明关联的输出目录，不推测其他结果文件。" });
      }
      const evidence = ["PLAN=" + file, "job=" + declaration.index + "/" + declaration.case + "/seed" + declaration.seed,
        "产物清单=" + owner.relativePath, "清单 SHA256=" + owner.sha256, "run=" + String(owner.binding?.runId || "清单已关联")];
      const dependencies: string[] = [];
      for (const plan of queue.plans || []) if (spelling(plan.planFile) !== spelling(file))
        for (const other of plan.jobs || []) if ([other.outputDir, other.collectionResultCsv].some(path => path &&
          [output, csv].some(selected => spelling(path) === selected || spelling(path).startsWith(selected + "/") || selected.startsWith(spelling(path) + "/"))))
          dependencies.push(plan.planFile);
      for (const record of records) if (record.binding?.planFile && !linkedPlan(node, record.binding.planFile, file))
        dependencies.push(String(record.binding.planFile));
      candidates.push({ nodeId: node.id, relativePath: output, type: "directory", category: "job 产物（清单关联）",
        owners: [planKey], evidence, dependencies: [...new Set(dependencies)] });
      if (csv && !csv.startsWith(output + "/")) {
        let boundCsv = "";
        try { boundCsv = relativeTo(node, owner.binding?.resultCsv); } catch {}
        if (boundCsv !== csv && !pathOnly) {
          blockers.push({ code: "RESULT_MANIFEST_LINK_UNVERIFIED", nodeId: node.id, detail: csv });
        } else candidates.push({ nodeId: node.id, relativePath: csv, type: "file", category: "独立测试结果（清单关联）",
          owners: [planKey], evidence, dependencies: [...new Set(dependencies)] });
      }
    }
  }
  return { candidates, blockers, notices, declarations: selected };
}
