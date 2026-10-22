import { cleanupDigest, cleanupError, cleanupRelative, type CleanupJobSelection, type CleanupPreview } from "./PlanCleanup";
import { cloneDistributedQueue, emptyDistributedQueue, mergeDurableWorkerSnapshots, remoteTaskMatchesJob,
  type DistributedQueue, type DurableWorkerSnapshot, type QueuedJob } from "./DistributedPlanQueue";

const pathKey = (value: unknown) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");

/** Retired ownership is only an audit source for cleanup, never a runnable queue. */
export const cleanupTaskEvidence = (snapshot: any) => {
  const tasks = snapshot.tasks || [], current = new Set(tasks.map((row: any) => row.commandId));
  return { ...snapshot, tasks: [...tasks, ...(snapshot.retiredTasks || []).filter((row: any) => !current.has(row.commandId))] };
};

/** Cleanup-only view. Never persist restored execution cards or bypass cleared tombstones. */
export function replacementEvidenceQueue(queue: DistributedQueue, snapshots: readonly DurableWorkerSnapshot[], projectId: string): DistributedQueue {
  snapshots = snapshots.map(cleanupTaskEvidence);
  const view = cloneDistributedQueue(queue);
  const commands = new Set((queue.clearedJobs || []).filter(entry => entry.projectId === projectId && entry.resultPathPolicy === "declared")
    .map(entry => entry.commandId));
  if (!commands.size) return view;
  // Reuse the existing message contract parser, bounded to retained ownership, not every server job.
  const recovered = mergeDurableWorkerSnapshots(emptyDistributedQueue(), snapshots.map(snapshot => ({ ...snapshot,
    tasks: snapshot.tasks?.filter(task => commands.has(String(task.commandId || ""))) })), projectId);
  for (const plan of recovered.plans) {
    if (plan.resultPathPolicy !== "declared" || plan.recoveryConflict) continue;
    for (const job of plan.jobs) {
      if (!["completed", "failed"].includes(job.status) || job.recoveryConflict || !job.collectionResultCsv) continue;
      const audit = queue.clearedJobs?.find(entry => entry.projectId === projectId && entry.resultPathPolicy === "declared"
        && entry.workflowId === plan.id && entry.planFile === plan.planFile && entry.planRevision === plan.revision
        && entry.codeFingerprint === plan.codeFingerprint && /^[a-f0-9]{64}$/i.test(entry.planRevision)
        && /^[a-f0-9]{64}$/i.test(entry.codeFingerprint) && entry.experimentIndex === job.index
        && entry.case === job.case && entry.seed === job.seed && entry.outputDir === job.outputDir
        && entry.globalJobId === job.globalJobId && job.globalJobId === plan.id + ":" + job.index
        && entry.workerId === job.workerId && entry.commandId === job.commandId && entry.runKey === job.runKey
        && (!entry.collectionResultCsv || entry.collectionResultCsv === job.collectionResultCsv)
        && (!entry.status || entry.status === job.status));
      if (!audit || !snapshots.some(snapshot => snapshot.workerId === job.workerId && snapshot.tasks?.some(task =>
        remoteTaskMatchesJob(plan, job, task) && task.status === job.status && (task.finishedAt || task.exitCode !== undefined)
        && !task.identityConflict))) continue;
      let target = view.plans.find(row => row.id === plan.id);
      if (target?.jobs.some(row => row.index === job.index)) continue;
      if (!target) { target = { ...plan, jobs: [] }; view.plans.push(target); }
      if (target.revision !== plan.revision || target.codeFingerprint !== plan.codeFingerprint || target.projectId !== projectId) continue;
      target.jobs.push({ ...job, checkpointSource: audit.checkpointSource || job.checkpointSource,
        mirroredWorkerIds: audit.mirroredWorkerIds, fragmentWorkerIds: audit.fragmentWorkerIds,
        cleanup: audit.cleanup, outputRetiredAt: audit.outputRetiredAt });
    }
  }
  return view;
}

/** Keep retirement on the original audit when a user intentionally cleared the card. */
export function replacementLifecycleJob(queue: DistributedQueue, selection: CleanupJobSelection): Pick<QueuedJob, "cleanup" | "outputRetiredAt"> | undefined {
  const job = queue.plans.find(plan => plan.id === selection.workflowId)?.jobs.find(job => job.index === selection.index
    && job.commandId === selection.commandId && ["completed", "failed"].includes(job.status));
  if (job) return job;
  if (selection.purpose !== "replace_outputs") return;
  const matches = queue.clearedJobs?.filter(entry => entry.workflowId === selection.workflowId && entry.experimentIndex === selection.index
    && entry.commandId === selection.commandId && entry.resultPathPolicy === "declared"
    && entry.globalJobId === selection.workflowId + ":" + selection.index);
  return matches?.length === 1 ? matches[0] : undefined;
}
export function replacementJobGroups(queue: DistributedQueue, planFile: string, jobs: any[], projectId: string, stablePlanId = ""): CleanupJobSelection[][] {
  return jobs.map(declaration => {
    const output = cleanupRelative(pathKey(declaration.output_dir)), csv = cleanupRelative(pathKey(declaration.result_csv));
    const matches = (queue.plans || []).filter(plan => plan.projectId === projectId && plan.resultPathPolicy === "declared"
      && (pathKey(plan.planFile).toLowerCase() === pathKey(planFile).toLowerCase() || stablePlanId && plan.stablePlanId === stablePlanId))
      .flatMap(plan => plan.jobs.filter(job => ["completed", "failed"].includes(job.status) && !job.reassignmentPending
        && job.case === declaration.case && Number(job.seed) === Number(declaration.seed)
        && pathKey(job.outputDir) === output && pathKey(job.collectionResultCsv) === csv
        && job.commandId && job.workerId && job.globalJobId === plan.id + ":" + job.index && !output.split("/").includes("attempts"))
        .map(job => ({ workflowId: plan.id, index: job.index, commandId: job.commandId!, purpose: "replace_outputs" as const })));
    for (const plan of queue.plans || []) for (const job of plan.jobs || []) if (pathKey(job.outputDir) === output
      && (job.cleanup?.state === "partial" || job.cleanup?.pendingNodes?.length))
      cleanupError("OUTPUT_REPLACEMENT_PENDING", "原清理尚未完成，请先核查操作：" + job.cleanup.operationId);
    for (const audit of queue.clearedJobs || []) if (audit.projectId === projectId && pathKey(audit.outputDir) === output
      && (audit.cleanup?.state === "partial" || audit.cleanup?.pendingNodes?.length))
      cleanupError("OUTPUT_REPLACEMENT_PENDING", "原清理尚未完成，请先核查操作：" + audit.cleanup.operationId);
    if (!matches.length) cleanupError("OUTPUT_OWNER_UNVERIFIED", "没有当前声明对应的已停止正式 job 登记：" + output);
    return matches.reverse(); // Preference only; every candidate still needs current owner proof.
  });
}

export type ReplacementPorts = {
  service: any;
  execute(id: string): Promise<any>;
  review(detail: string): Promise<void>;
  confirm(detail: string, phase: number): Promise<boolean>;
  assertCurrent(): void;
  planRevision: string;
  progress?(text: string): void;
};

/** One immutable batch, two user confirmations, then existing safe per-target executors. */
export async function replacePlanOutputs(ports: ReplacementPorts, planFile: string, groups: CleanupJobSelection[][]): Promise<string[]> {
  const previews: CleanupPreview[] = [];
  for (const group of groups) {
    let selected: CleanupPreview | undefined;
    let reason = "";
    for (const job of group) {
      ports.assertCurrent();
      ports.progress?.("核对 job " + job.index + " 的精确产物及全部关联节点…");
      const candidate: CleanupPreview = await ports.service.preview({ planFile, action: "delete", verifiedOnly: false, job, authorizationMode: "confirmed_paths" });
      if (candidate.scope.authorizationMode !== "confirmed_paths" && candidate.scope.planHash !== ports.planRevision) cleanupError("PLAN_REVISION_CHANGED");
      const approved = candidate.rows.filter(row => row.disposition === "delete");
      const coversEveryTarget = candidate.scope.candidates.every(target => candidate.rows.some(row => row.nodeId === target.nodeId && row.relativePath === target.relativePath
        && (["delete", "absent"].includes(row.disposition) || row.disposition === "protected" && row.inode && row.fingerprint
          && approved.some(other => other.inode === row.inode && other.device === row.device && other.fingerprint === row.fingerprint
            && cleanupDigest(other.rootIdentity) === cleanupDigest(row.rootIdentity)))));
      if (candidate.scope.candidates.length && !candidate.blockers.length
          && coversEveryTarget && candidate.rows.every(row => !["unverified"].includes(row.disposition))) { selected = candidate; break; }
      reason = [...candidate.blockers.map(row => (row.nodeId || "") + " " + row.code + ": " + row.detail), ...candidate.rows.filter(row => ["protected", "unverified"].includes(row.disposition)).map(row => row.absolutePath + ": " + (row.protectedReason || row.error))].join("；");
    }
    if (!selected) cleanupError("OUTPUT_REPLACEMENT_BLOCKED", "文件审核未通过，未删除任何产物。" + reason);
    if (selected.rows.some(row => row.disposition === "delete") && !previews.some(row => row.digest === selected!.digest)) previews.push(selected);
  }
  const exact = previews.flatMap(preview => preview.rows.filter(row => row.disposition === "delete").map(row => row.node.id + ":" + row.absolutePath));
  if (!exact.length) return [];
  if (new Set(exact).size !== exact.length) cleanupError("OUTPUT_REPLACEMENT_OVERLAP");
  const rows = previews.flatMap(preview => preview.rows.filter(row => row.disposition === "delete"));
  const detail = "PLAN：" + planFile + "\n版本：" + ports.planRevision + "\n永久替换以下独占 job 产物（不可恢复）：\n" + rows.map(row =>
    row.node.id + ": " + (row.node.kind === "remote" ? (row.node.user || "") + "@" + row.node.host + ":" + row.node.port : "本机")
    + "\n安全根：" + row.node.root + "\n精确目标：" + row.absolutePath + "\n类型：" + row.type + "；大小：" + row.size
    + "；指纹：" + row.fingerprint + "\n所有权证据：" + row.evidence.join("；")).join("\n\n")
    + "\nPLAN、配置、共享资产和本机汇总保留。活动任务不会自动停止。";
  await ports.review(detail);
  for (const phase of [1, 2]) {
    ports.assertCurrent();
    ports.progress?.("等待第 " + phase + " 次精确路径确认…");
    if (!await ports.confirm(detail, phase)) cleanupError("REPLACEMENT_CANCELLED", "已取消覆盖；未删除产物或提交任务。");
    ports.assertCurrent();
    for (const preview of previews) await ports.service.confirm({ token: preview.token, digest: preview.digest, phase, confirm: true,
      exactTargets: preview.rows.filter(row => row.disposition === "delete").map(row => row.node.id + ":" + row.absolutePath) });
  }
  // All nodes/operations must pass before the first mutation.
  for (const preview of previews) { ports.assertCurrent(); await ports.service.preflightConfirmed(preview.token); }
  const operationIds = previews.map(preview => preview.token);
  try {
    for (const id of operationIds) {
      ports.assertCurrent();
      ports.progress?.("执行已确认的精确产物替换：" + id);
      const result = await ports.execute(id);
      if (result.state !== "completed" || result.pendingNodes?.length) cleanupError("OUTPUT_REPLACEMENT_PARTIAL");
    }
  } catch (error: any) {
    throw Object.assign(new Error("覆盖未完成，未启动重跑。请在清理历史核查操作 " + operationIds.join("、") + "；" + String(error.message || error)),
      { apiData: { code: "OUTPUT_REPLACEMENT_PARTIAL", operationIds } });
  }
  return operationIds;
}
