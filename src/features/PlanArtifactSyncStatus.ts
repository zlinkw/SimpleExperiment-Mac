import { createHash } from "node:crypto";
import type { DistributedQueue, QueuedPlan } from "./DistributedPlanQueue";
import { safePlanArtifactPath } from "./PlanArtifactSync";
import { collectDistributedJobArtifacts } from "./DistributedJobArtifacts";

export type PlanArtifactSyncStatus = {
  runId: string; revision: string; status: "checking" | "synced" | "partial" | "unknown";
  checkedAt: string; targetCount: number; syncedCount: number;
  pendingWorkerIds: string[]; unavailableWorkerIds: string[]; detail: string;
};
const planKey = (value: unknown) => String(value || "").replace(/\\/g, "/").toLowerCase();

/** Completion is independent of a previous sync ledger; a same-revision rerun is a new generation. */
export function latestCompletePlansForSyncCheck(queue: DistributedQueue, metadata: any[] = []): QueuedPlan[] {
  const current = new Map(metadata.map(plan => [planKey(plan.file || plan.planFile), plan]));
  const latest = new Map<string, QueuedPlan>();
  for (const plan of queue.plans) {
    const config = current.get(planKey(plan.planFile));
    const configuredCount = config?.cases?.length && config?.seeds?.length ? config.cases.length * config.seeds.length : Number(config?.jobCount);
    const expected = configuredCount > 0 ? configuredCount : Number(plan.fullPlanJobCount || plan.planJobCount || plan.jobs.length);
    if (!plan.id || config?.revision && config.revision !== plan.revision || plan.recoveryConflict || Number(plan.recoveryMissingCount || 0) > 0
      || !expected || plan.jobs.length !== expected || new Set(plan.jobs.map(job => job.index)).size !== expected
      || new Set(plan.jobs.map(job => `${job.case}\0${job.seed}`)).size !== expected
      || plan.jobs.some(job => job.status !== "completed" || job.outputRetiredAt || job.recoveryConflict
        || job.trustedTerminalStatus && job.trustedTerminalStatus !== "completed" || !job.workerId || !job.commandId
        || !job.outputDir || job.outputDir.startsWith("/") || /^[A-Za-z]:/.test(job.outputDir)
        || job.outputDir.includes("\\") || job.outputDir.split("/").some(part => !part || part === "." || part === ".."))) continue;
    const key = planKey(plan.planFile);
    const old = latest.get(key);
    if (!old || (Date.parse(plan.enqueuedAt) || 0) >= (Date.parse(old.enqueuedAt) || 0)) latest.set(key, plan);
  }
  return [...latest.values()].slice(0, 500);
}

/** A durable mirror receipt belongs to a complete formal run, never to a partial job or a basename. */
export function pendingCompletedPlanMirrors(queue: DistributedQueue, metadata: any[], workerIds: string[], now = Date.now()): QueuedPlan[] {
  return completeFormalPlansForWorkerMirror(queue, metadata).filter(plan => {
    if (plan.cleanup || plan.resultPathPolicy !== "declared" || !plan.revision || !plan.codeFingerprint
      || plan.jobs.some(job => job.unavailable || job.resultPathPolicy !== "declared" || job.globalJobId !== `${plan.id}:${job.index}`
        || !safePlanArtifactPath(job.outputDir) || job.outputDir.split("/").length < 2 || job.outputDir.split("/").includes("attempts")
        || job.collectionResultCsv && !safePlanArtifactPath(job.collectionResultCsv)
        || job.artifactRetryAfter && Date.parse(job.artifactRetryAfter) > now)) return false;
    return plan.jobs.some(job => !/^[a-f0-9]{64}$/i.test(job.artifacts?.[`${job.outputDir}/formal_job_owner.json`] || "")
      || job.artifactError || workerIds.some(id => !job.mirroredWorkerIds?.includes(id)));
  });
}

/** Mirror each frozen run, including a run finishing after the on-disk PLAN has advanced. */
export function completeFormalPlansForWorkerMirror(queue: DistributedQueue, metadata: any[]): QueuedPlan[] {
  return queue.plans.filter(plan => !plan.cleanup && plan.resultPathPolicy === "declared").flatMap(plan =>
    latestCompletePlansForSyncCheck({ ...queue, plans: [plan] }, metadata.filter(row => row.revision === plan.revision)));
}

/** Excludes changing mirror receipts; includes every execution binding used by a fresh pre-transfer check. */
export function completedPlanMirrorIdentity(plan: QueuedPlan): string {
  return JSON.stringify([plan.id, plan.projectId, plan.revision, plan.codeFingerprint, plan.resultPathPolicy, plan.executionMode,
    plan.jobs.map(job => [job.index, job.case, job.seed, job.globalJobId, job.commandId, job.workerId,
      job.outputDir, job.collectionResultCsv, job.actualExecutionMode, job.checkpointSource])]);
}

export function planArtifactSyncCheckKey(plans: QueuedPlan[], workerIds: string[], onlineIds: string[]): string {
  return createHash("sha256").update(JSON.stringify([workerIds.slice().sort(), onlineIds.slice().sort(), plans.map(plan => [
    plan.id, plan.revision, plan.jobs.map(job => [job.index, job.attempt, job.commandId, job.workerId, job.outputDir,
      Object.entries(job.artifacts || {}).sort(([a], [b]) => a.localeCompare(b))]),
  ])])).digest("hex");
}

/** Compare the complete latest attempt directory, including checkpoints, with each configured Worker. */
export function assessPlanArtifactSync(plan: QueuedPlan, workerIds: string[], inventories: Map<string, Record<string, string>>,
  requiredPaths: string[], checkedAt = new Date().toISOString()): PlanArtifactSyncStatus {
  const pending = new Set<string>();
  const unavailable = new Set<string>();
  let missingSource = false;
  const subtree = (workerId: string, directory: string, csv?: string) => {
    const inventory = inventories.get(workerId) || {};
    const files = collectDistributedJobArtifacts(directory,
      Object.fromEntries(Object.entries(inventory).map(([file, sha256]) => [file, { sha256 }])), false);
    if (csv && /^[a-f0-9]{64}$/i.test(inventory[csv] || "")) files[csv] = inventory[csv].toLowerCase();
    return Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  };
  for (const job of plan.jobs) {
    const csv = job.resultPathPolicy === "declared" ? job.collectionResultCsv : undefined;
    const source = subtree(job.workerId!, job.outputDir, csv);
    const expected = new Map(source);
    const known = Object.entries(job.artifacts || {}).filter(([file]) => file.startsWith(job.outputDir + "/") || csv && file === csv);
    const runScopedDirectory = job.outputDir.endsWith(`/attempts/${plan.id}`);
    const hasLegacyRunEvidence = requiredPaths.length > 0 && requiredPaths.every(file => known.some(([name, hash]) =>
      name === `${job.outputDir}/${file}` && /^[a-f0-9]{64}$/i.test(hash)));
    const formalEvidence = job.resultPathPolicy === "declared" && job.globalJobId === `${plan.id}:${job.index}`
      && known.some(([name, hash]) => name === `${job.outputDir}/formal_job_owner.json` && /^[a-f0-9]{64}$/i.test(hash));
    if (!(job.resultPathPolicy === "declared" ? formalEvidence : runScopedDirectory || hasLegacyRunEvidence) || !inventories.has(job.workerId!) || !source.length
      || requiredPaths.some(file => !expected.has(`${job.outputDir}/${file}`))
      || known.some(([file, hash]) => expected.get(file)?.toLowerCase() !== hash.toLowerCase())) {
      missingSource = true;
      unavailable.add(job.workerId!);
      continue;
    }
    const sourceKey = JSON.stringify(source.map(([file, hash]) => [file, hash.toLowerCase()]));
    for (const workerId of workerIds) {
      if (!inventories.has(workerId)) { unavailable.add(workerId); continue; }
      if (JSON.stringify(subtree(workerId, job.outputDir, csv).map(([file, hash]) => [file, hash.toLowerCase()])) !== sourceKey) pending.add(workerId);
    }
  }
  const syncedCount = missingSource ? 0 : workerIds.filter(id => !pending.has(id) && !unavailable.has(id)).length;
  return { runId: plan.id, revision: plan.revision, checkedAt, targetCount: workerIds.length, syncedCount,
    status: missingSource ? "unknown" : workerIds.length > 0 && syncedCount === workerIds.length ? "synced" : pending.size ? "partial" : "unknown",
    pendingWorkerIds: [...pending].slice(0, 64), unavailableWorkerIds: [...unavailable].slice(0, 64),
    detail: missingSource ? "最新运行的来源目录缺失、版本不符或尚未读取，不能确认全局同步。"
      : pending.size ? "部分服务器的最新运行目录缺少文件或内容不同；仅检测，未自动传输。"
      : unavailable.size ? "部分服务器暂不可用，不能确认全局同步。" : "最新运行的完整产物目录（包含权重、日志和指标）已在所有已启用 Worker 校验一致。" };
}
