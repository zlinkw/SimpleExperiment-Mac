import { cleanupDigest } from "./PlanCleanup";
import { outputIsolationNotice, type DistributedQueue, type QueuedJob, type QueuedPlan } from "./DistributedPlanQueue";

export function pendingIsolationJob(plan: QueuedPlan, job: QueuedJob): boolean {
  return plan.resultPathPolicy === "declared" && !plan.recoveryConflict && !plan.executionModeBlocked
    && job.status === "pending" && !!job.outputIsolationBlocked && !job.commandId && !job.workerId
    && !job.startIntent && !job.dispatchConsent && !job.manualDispatch && !job.stopIntent && !job.recallRequested
    && !job.verifiedCompletion && !job.unavailable && !job.retainExistingOutputs
    && job.outputIsolationBlocked.declarationKey === job.outputDir;
}
export function transferBusyIsolation(job: QueuedJob): boolean {
  const block = job.outputIsolationBlocked;
  if (!block || block.busyOnly === false || block.codes?.some(code => code !== "ACTIVE_TRANSFER")) return false;
  if (block.code) return block.code === "ACTIVE_TRANSFER";
  // Older execute rejections retained only this exact protocol message.
  return /^SimpleSFTP files[.]cleanup[.](?:preview|execute)：?\s*\[ACTIVE_TRANSFER\][.。]?$/u.test(block.reason);
}
export function isolationIdentity(plan: QueuedPlan, job: QueuedJob): string {
  const { recovery: _recovery, ...block } = job.outputIsolationBlocked || {};
  return cleanupDigest([plan.id, plan.projectId, plan.planFile, plan.revision, plan.codeFingerprint, plan.executionMode,
    job.index, job.case, job.seed, job.outputDir, job.collectionResultCsv, job.automaticWorkerId, block]);
}
export type IsolationRecoveryPorts = {
  load(): Promise<DistributedQueue>;
  save(mutate: (queue: DistributedQueue) => DistributedQueue): Promise<void>;
  assertCurrent(): void;
  canRecover?(plan: QueuedPlan, job: QueuedJob): boolean;
  busy(): Promise<{ state: "idle" | "busy" | "unknown"; detail?: string }>;
  inspect(plan: QueuedPlan, job: QueuedJob): Promise<{ state: "absent" | "present" | "unknown"; detail?: string }>;
  now?(): number;
};
export type IsolationSelection = { planId: string; index: number };

/** Rechecks only. Never confirms, executes, moves, deletes, stops or submits a job. */
export async function refreshOutputIsolation(ports: IsolationRecoveryPorts, selection?: IsolationSelection) {
  const now = ports.now?.() ?? Date.now();
  ports.assertCurrent();
  const queue = await ports.load();
  const candidates = queue.plans.flatMap(plan => plan.jobs.filter(job => pendingIsolationJob(plan, job) && transferBusyIsolation(job) && ports.canRecover?.(plan,job) !== false
    && (!selection || plan.id === selection.planId && job.index === selection.index)
    && (selection || !(Date.parse(job.outputIsolationBlocked!.recovery?.nextCheckAt || "") > now)))
    .map(job => ({ plan, job, identity: isolationIdentity(plan, job) })))
    .sort((a,b) => String(a.job.outputIsolationBlocked!.recovery?.checkedAt || "").localeCompare(String(b.job.outputIsolationBlocked!.recovery?.checkedAt || "")))
    .slice(0, selection ? 1 : 2);
  if (!candidates.length) return [];
  let busy: Awaited<ReturnType<IsolationRecoveryPorts["busy"]>>;
  try { busy = await ports.busy(); } catch (error: any) { busy = { state: "unknown", detail: String(error.message || error) }; }
  const outcomes: Array<{ planId: string; index: number; state: string }> = [];
  for (const { plan, job, identity } of candidates) {
    ports.assertCurrent();
    let observed: Awaited<ReturnType<IsolationRecoveryPorts["inspect"]>> = { state: "unknown", detail: busy.detail };
    if (busy.state === "idle") {
      try { observed = await ports.inspect(plan, job); }
      catch (error: any) { observed = { state: "unknown", detail: String(error.message || error) }; }
    }
    ports.assertCurrent();
    const state = busy.state === "busy" ? "waiting_transfer" : observed.state === "absent" ? "resumed"
      : observed.state === "present" ? "review_required" : "unknown";
    const checkedAt = new Date(ports.now?.() ?? Date.now()).toISOString();
    let applied = false;
    await ports.save(latest => {
      ports.assertCurrent();
      const currentPlan = latest.plans.find(row => row.id === plan.id);
      const current = currentPlan?.jobs.find(row => row.index === job.index);
      if (!currentPlan || !current || !pendingIsolationJob(currentPlan,current) || ports.canRecover?.(currentPlan,current) === false || isolationIdentity(currentPlan,current) !== identity) return latest;
      applied = true;
      return { ...latest, plans: latest.plans.map(p => p !== currentPlan ? p : { ...p, jobs: p.jobs.map(j => j !== current ? j : state === "resumed"
        ? { ...j, outputIsolationBlocked: undefined, gpuMemoryWaitReason: undefined, gpuMemoryReservation: undefined,
          blockReason: undefined, localQueueOnly: true }
        : (() => {
          const next = { ...j, outputIsolationBlocked: { ...j.outputIsolationBlocked!, recovery: {
            state: state as "waiting_transfer" | "review_required" | "unknown", checkedAt,
            nextCheckAt: new Date(Date.parse(checkedAt) + 30000).toISOString(), detail: String(observed.detail || busy.detail || "").slice(0,500) } } };
          next.blockReason = outputIsolationNotice(next);
          return next;
        })()) }) };
    });
    if (applied) outcomes.push({planId:plan.id,index:job.index,state});
  }
  return outcomes;
}
