import { cleanupDigest } from "../features/PlanCleanup";
import { canonicalProjectId, sameDistributedPlanFile } from "../features/DistributedPlanQueue";
import { isolationIdentity, pendingIsolationJob, refreshOutputIsolation } from "../features/OutputIsolationRecovery";

const flights = new WeakMap<object, Map<string, Promise<unknown>>>();
const reviews = new WeakMap<object, Set<string>>();
const reviewKey = (root: string, plan: any, job: any) => JSON.stringify([root,plan.id,job.index]);
export class OutputIsolationRecoveryHost {
  constructor(private readonly h: any, private readonly root: string) {}
  private ports() {
    const h = this.h, context = h.captureProjectContext(), stopEpoch = h.distributedPlanStopEpoch;
    const targets = () => cleanupDigest(h.workerCodeSyncTargets().map((w: any) => [w.id,w.host,w.user,w.port,w.remotePath]));
    const binding = targets();
    const assertCurrent = () => {
      if (context.root !== this.root || !h.projectContextIsCurrent(context) || stopEpoch !== h.distributedPlanStopEpoch || targets() !== binding)
        throw Error("项目、服务器或停止意图已变化，本轮未恢复排队。");
    };
    return {
      load: async () => {
        const queue = await h.loadDistributedQueue(this.root);
        return { ...queue, plans: queue.plans.filter((p: any) => p.projectId === canonicalProjectId(this.root)) };
      }, assertCurrent, canRecover:(plan: any,job: any)=>!reviews.get(h)?.has(reviewKey(this.root,plan,job)),
      save: async (mutate: any) => {
        await h.saveDistributedQueue(this.root, undefined, { controlMutation: true, mutateLatest: (queue: any) => { assertCurrent(); return mutate(queue); } });
        h.postState();
      },
      busy: async () => {
        const value = await h.simpleSftpApiCall("transfers.list", {}); assertCurrent();
        const busy = value?.busy;
        if (value?.ok !== true || !value.instanceId || busy?.schemaVersion !== 1 || typeof busy.busy !== "boolean")
          return { state: "unknown" as const, detail: "配套插件未返回本轮传输状态，将自动重查。" };
        return { state: busy.busy ? "busy" as const : "idle" as const };
      },
      inspect: async (_plan: any, job: any) => {
        const result = await h.planCleanupHost().inspectPendingOutputTargets(job); assertCurrent();
        return result;
      },
    };
  }
  refresh(selection?: { planId: string; index: number }) { return refreshOutputIsolation(this.ports(), selection); }
  async fromUi(message: any) {
    const h = this.h, ports = this.ports(); ports.assertCurrent();
    const queue = await ports.load(), plan = queue.plans.find((p: any) => p.id === String(message.planId));
    const job = plan?.jobs.find((j: any) => j.index === Number(message.jobIndex));
    if (!plan || !job || !sameDistributedPlanFile(plan.planFile, String(message.planFile)) || !pendingIsolationJob(plan,job))
      throw Error("所选 job 已变化或已启动，请刷新后重试。");
    const selected = {planId:plan.id,index:job.index};
    const result = await refreshOutputIsolation(ports, selected);
    if (result.some(row => row.state === "resumed")) { h.requestDistributedQueueRefresh(); return {status:"queued"}; }
    const latest = await ports.load(), currentPlan = latest.plans.find((p: any) => p.id === plan.id);
    const current = currentPlan?.jobs.find((j: any) => j.index === job.index);
    if (!currentPlan || !current || !pendingIsolationJob(currentPlan,current)) return {status:"changed"};
    if (current.outputIsolationBlocked?.recovery?.state === "waiting_transfer" || current.outputIsolationBlocked?.recovery?.state === "unknown")
      return {status:"blocked",message:current.blockReason};
    const identity = isolationIdentity(currentPlan,current);
    // Explicit button action enters the existing exact-path confirmation flow.
    // Background refresh never enters this flow or reuses old confirmations.
    let active = reviews.get(h); if (!active) { active = new Set(); reviews.set(h,active); }
    const key = reviewKey(this.root,currentPlan,current);
    if (active.has(key)) throw Error("这个 job 正在审核，请完成当前审核。");
    active.add(key);
    try {
      const { ManualDispatchHost } = require("./ManualDispatchHost");
      const review = await new ManualDispatchHost(h,this.root).review(currentPlan,[current]);
      ports.assertCurrent();
      if (review === false) return {status:"cancelled"};
      if (!review.accepted?.includes(current.index)) return {status:"blocked"};
      let applied = false;
      await ports.save((saved: any) => ({...saved,plans:saved.plans.map((p: any)=>p.id!==plan.id?p:{...p,jobs:p.jobs.map((j: any)=>{
        if (j.index!==job.index || !pendingIsolationJob(p,j) || isolationIdentity(p,j)!==identity) return j;
        applied = true;
        return {...j,outputIsolationBlocked:undefined,gpuMemoryWaitReason:undefined,gpuMemoryReservation:undefined,blockReason:undefined,localQueueOnly:true};
      })})}));
      if (!applied) return {status:"changed"};
      h.requestDistributedQueueRefresh();
      return {status:"queued"};
    } finally { active.delete(key); }
  }
}

export function queueOutputIsolationRecovery(h: any, root: string): Promise<unknown> {
  let roots = flights.get(h); if (!roots) { roots = new Map(); flights.set(h,roots); }
  const active = roots.get(root); if (active) return active;
  const task = new OutputIsolationRecoveryHost(h,root).refresh().then(rows => {
    if (rows.some(row => row.state === "resumed")) h.requestDistributedQueueRefresh();
  }).finally(() => { if (roots!.get(root) === task) roots!.delete(root); });
  roots.set(root,task); return task;
}
