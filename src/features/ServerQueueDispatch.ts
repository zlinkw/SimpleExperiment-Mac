import { QueuedPlan } from "./DistributedPlanQueue";
import { cardSettings, quotaSettings } from "./GpuQuotaScheduling";

export type QueueCard = { workerId: string; gpuId: string; weight: number };
export const remainingQueueJobs = (plan: QueuedPlan) => plan.resultPathPolicy === "declared" && !plan.executionModeBlocked && !plan.recoveryConflict
  ? plan.jobs.filter(job => job.status === "pending" && !job.workerId && !job.commandId && !job.manualDispatch && !job.recallRequested
    && !job.stopIntent && !job.unavailable && !job.retainExistingOutputs) : [];

/** Queue weights are configured per-card quotas, independent of today's free slots. */
export function serverQueueCards(settings: any, workers: any[], gpu: any): QueueCard[] {
  return workers.flatMap(worker => {
    const rows = gpu?.[worker.id];
    if (!Array.isArray(rows) || !rows.length) throw Error("服务器 GPU 尚未查完，未分配排队任务：" + worker.id);
    const policy = quotaSettings(settings, worker, rows);
    if (policy.gpuMaxConcurrentCards === 0) return [];
    const ids = [...new Set<string>(rows.map(row => String(row.index ?? row.gpu_id ?? row.gpuId ?? row.id ?? "")))];
    if (ids.some(id => !/^(0|[1-9][0-9]*)$/.test(id))) throw Error("GPU 身份无效：" + worker.id);
    return ids.map(gpuId => ({ workerId: worker.id, gpuId, weight: cardSettings(policy, gpuId).gpuJobsPerCard })).filter(card => card.weight > 0);
  }).sort((a,b) => a.workerId.localeCompare(b.workerId) || Number(a.gpuId)-Number(b.gpuId));
}

/** Largest remainders preserve 1:6 exactly for seven-job multiples; stable rounding otherwise. */
export function quotaQueuePlacements(count: number, cards: QueueCard[]) {
  if (!Number.isSafeInteger(count) || count < 0 || !cards.length || cards.some(card => !Number.isInteger(card.weight) || card.weight <= 0))
    throw Error("没有可用的逐卡 job 配额，未派发服务器队列。");
  const total = cards.reduce((sum,card) => sum+card.weight,0);
  const allocations = cards.map((card,index) => ({ ...card,index,count:Math.floor(count*card.weight/total),remainder:count*card.weight%total,used:0 }));
  const order = [...allocations].sort((a,b) => b.remainder-a.remainder || a.index-b.index);
  const extra = count-allocations.reduce((sum,card) => sum+card.count,0);
  for (const card of order.slice(0,extra)) card.count++;
  const placements: QueueCard[] = [];
  for (let index=0;index<count;index++) {
    const card = allocations.filter(card => card.used<card.count).sort((a,b) => a.used/a.weight-b.used/b.weight || a.index-b.index)[0];
    card.used++; placements.push({workerId:card.workerId,gpuId:card.gpuId,weight:card.weight});
  }
  return { placements, allocations:allocations.map(({workerId,gpuId,weight,count})=>({workerId,gpuId,weight,count})) };
}
