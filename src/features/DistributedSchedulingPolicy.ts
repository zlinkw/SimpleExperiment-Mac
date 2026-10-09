import { DistributedQueue, QueuedPlan, DurableWorkerSnapshot, durableCommandId,
  mergeDurableWorkerSnapshots, freshIdleGpuEvidence, hasUnresolvedPlanRecovery, workerCodeVersionAvailable } from "./DistributedPlanQueue";

export type SchedulingMode = "local_idle" | "server_prequeue";
export const PROGRESS_FRESHNESS_MS = 5_000;
/** Historical completion is stable; background telemetry only follows unresolved ownership. */
export function progressRefreshWorkerIds(queue: DistributedQueue, configuredIds: string[]): string[] {
  const needed = new Set<string>();
  for (const plan of queue.plans) {
    if (hasUnresolvedPlanRecovery(plan)) return [...new Set(configuredIds)];
    for (const job of plan.jobs || []) {
      if (["completed", "failed", "cancelled"].includes(job.status) && !job.recallRequested) continue;
      if (job.workerId) needed.add(job.workerId);
      else if (job.status !== "pending") return [...new Set(configuredIds)];
    }
  }
  return [...new Set(configuredIds)].filter(id => needed.has(id));
}

export function schedulingMode(value: unknown): SchedulingMode {
  return value === "server_prequeue" ? "server_prequeue" : "local_idle";
}

/** A GPU counts once. Other users' processes never increase the hosted share. */
export function prequeueGpuWeight(rows: unknown, idleUtil: number, idleMem: number,
  owner: { currentUser?: string; currentUserAliases?: string[]; myCommandKeywords?: string[];
    myProcessMatchMode?: string }, fallbackUser = "", capacity?: number): number {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const evidence = freshIdleGpuEvidence({ worker: rows }, ["worker"], idleUtil, idleMem);
  if (!evidence.complete) return 0;
  const ids = new Set(evidence.idleGpuIdsByWorker.get("worker") || []);
  const users = new Set([owner.currentUser || fallbackUser, ...(owner.currentUserAliases || [])]
    .map((user) => String(user).trim().toLowerCase()).filter(Boolean));
  const keywords = (owner.myCommandKeywords || []).map((word) => word.toLowerCase()).filter(Boolean);
  for (const row of rows) {
    const processes = Array.isArray(row.processes) ? row.processes : Array.isArray(row.procs) ? row.procs : [];
    const count = Number(row.processCount ?? row.process_count ?? processes.length);
    if (!processes.length || count > processes.length) continue;
    const own = (process: Record<string, unknown>) => {
      if (process.pluginManaged === true) return true;
      const user = String(process.username ?? process.user ?? process.userName ?? "").trim().toLowerCase();
      const command = String(process.command ?? process.cmdline ?? process.cmd ?? "").toLowerCase();
      const userMatch = Boolean(user && users.has(user));
      const commandMatch = keywords.some((word) => command.includes(word));
      // A keyword cannot turn another user's or an unidentified process into our capacity.
      return userMatch && (owner.myProcessMatchMode === "command_contains" ? commandMatch : true);
    };
    if (processes.every((process: unknown) => process && typeof process === "object" && own(process as Record<string, unknown>)))
      ids.add(String(row.index ?? row.gpu_id ?? row.gpuId ?? row.id));
  }
  return Number.isInteger(capacity) && Number(capacity) > 0 ? Math.min(ids.size, Number(capacity)) : ids.size;
}

export type PrequeueWorker = { workerId: string; online: boolean; weight: number; codeFingerprint: string };
export function allocateServerPrequeue(queue: DistributedQueue, workers: readonly PrequeueWorker[]) {
  const next: DistributedQueue = { ...queue, plans: queue.plans.map((plan) => ({ ...plan,
    jobs: plan.jobs.map((job) => ({ ...job })) })) };
  const assigned: Array<{ planId: string; jobIndex: number; workerId: string; commandId: string; attempt: number }> = [];
  for (const plan of next.plans) {
    if (plan.executionModeBlocked || schedulingMode(plan.schedulingMode) !== "server_prequeue" || plan.localDispatchOverride === true || plan.recoveryConflict) continue;
    const eligible = workers.filter((worker) => worker.online && worker.weight > 0
      && worker.codeFingerprint === plan.codeFingerprint && workerCodeVersionAvailable(next, worker.workerId, plan.codeFingerprint));
    if (!eligible.length) continue;
    const weights = plan.prequeueWeights || Object.fromEntries(eligible.map((worker) => [worker.workerId, worker.weight]));
    plan.prequeueWeights = weights;
    const loads = new Map<string, number>();
    for (const job of plan.jobs) if (job.workerId)
      loads.set(job.workerId, (loads.get(job.workerId) || 0) + 1);
    for (const job of plan.jobs.filter((job) => job.status === "pending" && !job.workerId && !job.commandId
      && job.localQueueOnly !== true && job.recallRequested !== true)) {
      const target = eligible.filter((worker) => Number(weights[worker.workerId]) > 0).sort((a, b) =>
        ((loads.get(a.workerId) || 0) + 1) / weights[a.workerId]
          - ((loads.get(b.workerId) || 0) + 1) / weights[b.workerId] || a.workerId.localeCompare(b.workerId))[0];
      if (!target) break;
      const commandId = durableCommandId(plan, job, target.workerId);
      Object.assign(job, { workerId: target.workerId, commandId, runKey: commandId,
        status: "dispatching", gpuId: undefined, blockReason: undefined });
      loads.set(target.workerId, (loads.get(target.workerId) || 0) + 1);
      assigned.push({ planId: plan.id, jobIndex: job.index, workerId: target.workerId, commandId, attempt: job.attempt });
    }
  }
  return { queue: next, dispatches: assigned };
}

/** Display projection only: it never changes scheduling identities or starts work. */
export function serverAuthoritativeProgress(queue: DistributedQueue, snapshots: readonly DurableWorkerSnapshot[],
  projectId: string, now = Date.now()): QueuedPlan[] {
  return mergeDurableWorkerSnapshots(queue, snapshots, projectId, now, PROGRESS_FRESHNESS_MS).plans;
}
