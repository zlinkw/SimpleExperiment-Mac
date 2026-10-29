import type { QueuedJob, QueuedPlan, DistributedQueue, WorkerSlots } from "./DistributedPlanQueue";
import { cardSettings, type GpuQuotaSettings } from "./GpuQuotaScheduling";
import { gpuMemoryNumbers } from "./GpuMemoryScheduling";
import { hasVerifiedCompletion, hasTrustedTerminalProof } from "./VerifiedCompletion";

export type GpuBudgetEvidence = {
  version: 1; commandId: string; projectId: string; group: string; hardware: string;
  peakMb: number; ready: boolean; oom: boolean; durationSeconds?: number; concurrency?: number;
};
export type GpuBudgetReservation = { version: 1; group: string; hardware: string; budgetMb: number; probe: boolean; exclusive?: boolean;
  estimate?: { version: 1; peakMb: number; ready: true } };
export type BudgetWorker = WorkerSlots & { gpuBudgetSupported?: boolean; gpuRows?: any[]; gpuPolicy?: GpuQuotaSettings };
export type PlanGpuMemoryEstimates = { version: 1; binding: string; entries: Array<{
  group: string; hardware: string; peakMb: number; ready: boolean; oom: boolean;
}> };
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Exact source/configuration identity. Seeds share a conservative maximum within one case. */
export function budgetGroup(plan: QueuedPlan, job: QueuedJob): string {
  return JSON.stringify([plan.projectId || "", plan.id, plan.revision, plan.codeFingerprint, job.case, plan.executionMode || ""]);
}
export function budgetHardware(workerId: string, row: any): string {
  return JSON.stringify([workerId, String(row.name ?? row.gpuName ?? row.gpu_name ?? ""), gpuMemoryNumbers(row)?.total ?? 0]);
}
export function budgetSize(peakMb: number): number { return Math.ceil(peakMb * 1.2 + 1024); }
export function budgetEvidence(value: any, commandId: string, projectId: string): GpuBudgetEvidence | undefined {
  return value?.version === 1 && value.commandId === commandId && value.projectId === projectId
    && typeof value.group === "string" && typeof value.hardware === "string" && (positive(value.peakMb) || value.oom === true && value.peakMb === 0)
    && typeof value.ready === "boolean" && typeof value.oom === "boolean"
    ? { version: 1, commandId, projectId, group: value.group, hardware: value.hardware, peakMb: value.peakMb,
      ready: value.ready, oom: value.oom,
      ...(positive(value.durationSeconds) ? { durationSeconds: value.durationSeconds } : {}),
      ...(positive(value.concurrency) ? { concurrency: value.concurrency } : {}) } : undefined;
}
export function mergeBudgetEvidence(prior: GpuBudgetEvidence | undefined, next: GpuBudgetEvidence | undefined): GpuBudgetEvidence | undefined {
  if (!next) return prior;
  if (!prior || prior.commandId !== next.commandId || prior.projectId !== next.projectId || prior.group !== next.group || prior.hardware !== next.hardware) return next;
  return { ...prior, ...next, peakMb: Math.max(prior.peakMb, next.peakMb), oom: prior.oom || next.oom,
    ready: (prior.ready || next.ready) && !(prior.oom || next.oom) };
}

/** Compact PLAN-lifetime measurements, in the existing queue. Never a launch or completion proof. */
export function retainPlanMemoryEstimates(plan: QueuedPlan, prior?: QueuedPlan): QueuedPlan {
  const complete = plan.jobs.length >= Number(plan.planJobCount || plan.jobs.length)
    && plan.jobs.length > 0 && plan.jobs.every(job => hasVerifiedCompletion(plan, job));
  if (complete || plan.resultPathPolicy !== "declared") return { ...plan, gpuMemoryEstimates: undefined };
  const binding = JSON.stringify([plan.projectId, plan.id, plan.revision, plan.codeFingerprint, plan.executionMode]);
  const groups = new Set(plan.jobs.map(job => budgetGroup(plan, job)));
  const entries = new Map<string, PlanGpuMemoryEstimates["entries"][number]>();
  const add = (value: PlanGpuMemoryEstimates["entries"][number]) => {
    if (!value || typeof value !== "object") return;
    if (!groups.has(value.group) || typeof value.hardware !== "string" || !positive(value.peakMb) && !(value.oom === true && value.peakMb === 0)
      || typeof value.ready !== "boolean" || typeof value.oom !== "boolean") return;
    const key = JSON.stringify([value.group, value.hardware]), old = entries.get(key);
    const oom = Boolean(old?.oom || value.oom);
    entries.set(key, { group: value.group, hardware: value.hardware, peakMb: Math.max(old?.peakMb || 0, value.peakMb),
      ready: Boolean(old?.ready || value.ready) && !oom, oom });
  };
  for (const cache of [prior?.gpuMemoryEstimates, plan.gpuMemoryEstimates])
    if (cache?.version === 1 && cache.binding === binding && Array.isArray(cache.entries)) cache.entries.forEach(add);
  for (const job of plan.jobs) {
    const evidence = budgetEvidence(job.gpuMemoryProfile, job.commandId || "", plan.projectId || "");
    if (!evidence || evidence.group !== budgetGroup(plan, job)) continue;
    // A verified successful full run already observed its whole duration, including short jobs.
    add({ ...evidence, ready: evidence.ready || hasVerifiedCompletion(plan, job) && evidence.peakMb > 0 && !evidence.oom });
  }
  return { ...plan, gpuMemoryEstimates: entries.size ? { version: 1, binding,
    entries: [...entries.values()].sort((a,b) => a.group.localeCompare(b.group) || a.hardware.localeCompare(b.hardware)) } : undefined };
}

/** One round's admission ledger; durable reservations live on the existing job, never in a second queue. */
export function memoryBudgetAdmission(queue: DistributedQueue, workers: readonly BudgetWorker[]) {
  const profiles = new Map<string, Array<PlanGpuMemoryEstimates["entries"][number] & { durationSeconds?: number; concurrency?: number }>>();
  const held = new Map<string, Array<{ plan: QueuedPlan; job: QueuedJob; reservation?: GpuBudgetReservation }>>();
  const probes = new Set<string>();
  const profileKey = (group: string, hardware: string) => JSON.stringify([group, hardware]);
  const cardKey = (workerId: string, gpuId: string) => JSON.stringify([workerId, gpuId]);
  for (const plan of queue.plans) {
    for (const estimate of retainPlanMemoryEstimates(plan).gpuMemoryEstimates?.entries || []) {
      const key = profileKey(estimate.group, estimate.hardware);
      profiles.set(key, [...profiles.get(key) || [], estimate]);
    }
    for (const job of plan.jobs) {
      const group = budgetGroup(plan, job);
      const evidence = budgetEvidence(job.gpuMemoryProfile, job.commandId || "", plan.projectId || "");
      if (evidence && evidence.group === group) {
        const key = profileKey(group, evidence.hardware);
        profiles.set(key, [...profiles.get(key) || [], evidence]);
      }
      // Unknown/starting/unacknowledged starts retain their entire reservation.
      if (job.workerId && job.gpuId !== undefined && !hasVerifiedCompletion(plan, job)
        && !(job.lifecycleProtocol === 2 && ["exited", "failed", "missing"].includes(job.executionState || "") && !job.statusQueryError)
        && !(hasTrustedTerminalProof(plan, job) && !["queued", "starting", "running"].includes(job.executionState || ""))
        && !["completed", "failed", "cancelled"].includes(job.status)
        && (job.commandId || job.startIntent || job.dispatchConsent)) {
        const key = cardKey(job.workerId, String(job.gpuId));
        held.set(key, [...held.get(key) || [], { plan, job, reservation: job.gpuMemoryReservation }]);
        if (job.gpuMemoryReservation?.probe && !evidence?.ready)
          probes.add(profileKey(group, job.gpuMemoryReservation.hardware));
      }
    }
  }
  const estimates = (group: string, hardware: string) => profiles.get(profileKey(group, hardware)) || [];
  const peak = (group: string, hardware: string) => Math.max(0, ...estimates(group, hardware).map(p => p.peakMb));
  const ready = (group: string, hardware: string) => estimates(group, hardware).some(p => p.ready)
    && !estimates(group, hardware).some(p => p.oom);
  const pending = queue.plans.filter(plan => !plan.executionModeBlocked && !plan.recoveryConflict && plan.resultPathPolicy === "declared"
    && (plan.schedulingMode !== "server_prequeue" || plan.localDispatchOverride)).flatMap(plan => plan.jobs.filter(job => job.status === "pending" && !job.manualDispatch
    && !job.stopIntent && !job.recallRequested && !job.outputIsolationBlocked).map(job => ({ plan, job })));
  const cost = (plan: QueuedPlan) => {
    const samples = plan.jobs.flatMap(job => job.status === "completed" && job.gpuMemoryProfile?.durationSeconds ? [job.gpuMemoryProfile] : []);
    const seconds = samples.length ? Math.max(...samples.map(s => s.durationSeconds!)) : 1;
    return plan.jobs.filter(job => !["completed", "failed", "cancelled"].includes(job.status)).length * seconds;
  };
  const planned = new Map<QueuedJob, GpuBudgetReservation>();
  return {
    sortPlans: (plans: QueuedPlan[]) => [...plans].sort((a, b) => cost(b) - cost(a) || a.enqueuedAt.localeCompare(b.enqueuedAt)),
    choose(plan: QueuedPlan, job: QueuedJob, eligible: readonly WorkerSlots[], slots: Map<string, string[]>) {
      const group = budgetGroup(plan, job);
      const candidates: Array<{ workerId: string; gpuId: string; reservation: GpuBudgetReservation; score: number }> = [];
      for (const worker of eligible as BudgetWorker[]) {
        if (job.automaticWorkerId && job.automaticWorkerId !== worker.workerId) continue;
        if (!worker.gpuBudgetSupported || !worker.gpuPolicy || job.reassignmentWorkerId && job.reassignmentWorkerId !== worker.workerId) continue;
        for (const gpuId of new Set(slots.get(worker.workerId) || [])) {
          const row = worker.gpuRows?.find(row => String(row.index ?? row.gpu_id ?? row.gpuId ?? row.id) === gpuId);
          const memory = row && gpuMemoryNumbers(row);
          if (!memory) continue;
          const hardware = budgetHardware(worker.workerId, row), key = cardKey(worker.workerId, gpuId);
          const active = held.get(key) || [], policy = cardSettings(worker.gpuPolicy, gpuId);
          if (active.length >= policy.gpuJobsPerCard || memory.free < policy.gpuMinFreeMemoryGb * 1024) continue;
          const isReady = ready(group, hardware);
          if (estimates(group, hardware).some(p => p.oom)) continue;
          if (!isReady && (active.length || probes.has(profileKey(group, hardware)))) continue;
          if (active.some(item => !item.reservation || item.reservation.exclusive || !ready(budgetGroup(item.plan, item.job), hardware))) continue;
          let deficit = 0;
          let uncreditedUsed = memory.total - memory.free;
          for (const item of active) {
            // Credit only fresh, exactly attributed device allocations. Unknown attribution gets zero credit.
            const processes = Array.isArray(row.processes) ? row.processes : [];
            const matched = processes.filter((p: any) => p.pluginManaged === true && p.jobCommandId === item.job.commandId && p.jobProjectId === item.plan.projectId);
            const unique = [...new Map(matched.map((p: any) => [String(p.pid), p])).values()] as any[];
            const current = unique.reduce((sum: number, p: any) => sum + (positive(p.usedMemoryMb) ? p.usedMemoryMb : 0), 0);
            const estimate = budgetSize(peak(budgetGroup(item.plan, item.job), hardware));
            const reserved = item.reservation!.probe ? estimate : Math.max(item.reservation!.budgetMb, estimate);
            const credit = Math.min(current, uncreditedUsed);
            uncreditedUsed -= credit;
            deficit += Math.max(0, reserved - credit);
          }
          const measuredPeak = peak(group, hardware);
          const exclusive = isReady && !active.length && budgetSize(measuredPeak) > memory.free && measuredPeak + 1024 <= memory.free;
          const budgetMb = isReady && !exclusive ? budgetSize(measuredPeak) : memory.free;
          if (budgetMb <= 0 || memory.free - deficit < budgetMb) continue;
          // Keep the last compatible empty card available for an unmeasured configuration.
          const unknownWaiting = pending.some(item => {
            if (item.job.automaticWorkerId && item.job.automaticWorkerId !== worker.workerId) return false;
            const otherGroup = budgetGroup(item.plan, item.job);
            if (otherGroup === group || worker.codeScopeErrors?.[item.plan.id]
              || !worker.compatiblePlans?.includes(item.plan.id) && worker.codeFingerprint !== item.plan.codeFingerprint) return false;
            return !ready(otherGroup, hardware) && !estimates(otherGroup, hardware).some(p => p.oom)
              && !probes.has(profileKey(otherGroup, hardware));
          });
          if (isReady && !active.length && unknownWaiting) {
            const empty = [...new Set(slots.get(worker.workerId) || [])].filter(id => !(held.get(cardKey(worker.workerId, id)) || []).length);
            if (empty.length <= 1) continue;
          }
          if (isReady && active.length && unknownWaiting) {
            const ids = [...new Set((worker.gpuRows || []).map(row => String(row.index ?? row.gpu_id ?? row.gpuId ?? row.id)))];
            const draining = ids.filter(id => (held.get(cardKey(worker.workerId, id)) || []).length)
              .sort((a, b) => (held.get(cardKey(worker.workerId, a)) || []).length - (held.get(cardKey(worker.workerId, b)) || []).length || a.localeCompare(b))[0];
            if (draining === gpuId) continue;
          }
          const completed = estimates(group, hardware).filter(p => p.durationSeconds && p.concurrency);
          const solo = completed.filter(p => p.concurrency === 1);
          const shared = completed.filter(p => p.concurrency! > 1);
          // Normal completed jobs provide feedback; never run a synthetic training probe.
          if (active.length > 0 && solo.length && shared.length
            && Math.max(...shared.map(p => p.concurrency! / p.durationSeconds!)) <= Math.min(...solo.map(p => 1 / p.durationSeconds!))) continue;
          candidates.push({ workerId: worker.workerId, gpuId,
            reservation: { version: 1, group, hardware, budgetMb, probe: !isReady, ...(exclusive ? { exclusive: true } : {}),
              ...(isReady ? { estimate: { version: 1, peakMb: measuredPeak, ready: true } as const } : {}) },
            score: !isReady ? -memory.free : active.length * memory.total + memory.free - deficit - budgetMb });
        }
      }
      candidates.sort((a, b) => a.score - b.score || a.workerId.localeCompare(b.workerId) || a.gpuId.localeCompare(b.gpuId));
      const best = candidates[0];
      if (best) planned.set(job, best.reservation);
      else {
        const relevant = (eligible as BudgetWorker[]).filter(worker => !job.automaticWorkerId || worker.workerId === job.automaticWorkerId);
        const observed = relevant.flatMap(worker => (worker.gpuRows || []).flatMap(row => estimates(group, budgetHardware(worker.workerId, row))));
        job.blockReason = job.gpuMemoryWaitReason = job.automaticWorkerId && !relevant.some(worker => worker.online)
          ? "等待所选服务器连接与当前显卡状态；未派发"
          : observed.some(value => value.ready && !value.oom) ? "已有 PLAN 显存估计；等待预算余量、可用显卡或用户并行配额；未派发"
          : observed.some(value => value.oom) ? "该配置已观察到 OOM，暂停自动并发；请检查任务配置与显存预算"
          : "等待自动显存观察（连续 10 分钟或任务成功完成）；尚无该配置与硬件的可用估计，未派发";
      }
      return best;
    },
    reserve(plan: QueuedPlan, job: QueuedJob, workerId: string, gpuId: string) {
      const reservation = planned.get(job)!;
      job.gpuMemoryReservation = reservation;
      job.gpuMemoryWaitReason = undefined;
      const key = cardKey(workerId, gpuId);
      held.set(key, [...held.get(key) || [], { plan, job, reservation }]);
      if (reservation.probe) probes.add(profileKey(reservation.group, reservation.hardware));
    },
  };
}
