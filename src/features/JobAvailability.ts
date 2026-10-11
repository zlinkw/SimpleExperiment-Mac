import * as Queue from "./DistributedPlanQueue";

/** Local-only decision. It neither stops Worker processes nor touches their artifacts. */
export async function changeJobAvailabilityFromUi(host: any, message: any,
  askReason: () => Promise<string | undefined>, confirm: (detail: string, restore: boolean) => Promise<boolean>) {
  const context = host.captureProjectContext(), client = host.client;
  const current = () => host.projectContextIsCurrent(context) && host.client === client;
  const queue: Queue.DistributedQueue = await host.loadDistributedQueue(context.root);
  const plan = queue.plans.find(row => row.id === String(message.planId || ""));
  const job = plan?.jobs.find(row => row.index === Number(message.jobIndex));
  if (!plan || !job || !Queue.sameDistributedPlanFile(plan.planFile, String(message.planFile || ""))
    || plan.projectId !== Queue.canonicalProjectId(context.root) || host.distributedPlanStopEpoch
    || job.attempt !== Number(message.attempt) || String(job.commandId || "") !== String(message.commandId || ""))
    throw new Error("目标 job 已变化，请刷新后重试。");
  const identity = Queue.jobAvailabilityIdentity(plan, job), restore = message.command === "restoreJobAvailability";
  let receipt: Record<string, unknown> | undefined;
  const fetchTerminal = async () => {
    if (!job.workerId && !job.commandId) return undefined;
    const snapshot = await client.getWorkerTasks(job.workerId);
    const matches = (snapshot?.tasks || []).filter((row: any) => String(row.commandId || "") === job.commandId);
    if (matches.length !== 1) throw new Error("原 Worker 的结束回执缺失或重复，未修改 job。");
    return matches[0];
  };
  if (!restore) {
    receipt = await fetchTerminal();
    Queue.markJobUnavailable(queue, plan.id, job.index, identity, "待填写原因", new Date().toISOString(), receipt);
  } else if (!Queue.jobIsUnavailable(plan, job)) throw new Error("job 当前未标记不可用。");
  if (!current()) return { status: "cancelled", message: "项目已切换，未修改 job。" };
  const reason = restore ? "" : await askReason();
  if (!restore && !reason?.trim()) return { status: "cancelled", message: "已取消标记，job 未修改。" };
  const detail = `${plan.planFile}\n运行 ${plan.id} · ${job.case} seed ${job.seed} · attempt ${job.attempt}\n`
    + `Worker ${job.workerId || "未派发"}\n目录 ${job.outputDir}\n`
    + (restore ? "撤销后恢复原状态；未派发 job 将重新排队，失败 job 需手动召回。"
      : `原因：${reason!.trim()}\n仅排除这个 job，停止其自动重试，不计入成功，不补齐正式汇总；保留原日志和结果。`);
  if (!await confirm(detail, restore) || !current()) return { status: "cancelled", message: "已取消操作，job 未修改。" };
  if (!restore) receipt = await fetchTerminal();
  if (!current()) return { status: "cancelled", message: "项目已切换，未修改 job。" };
  const generation = host.distributedQueueGeneration = (host.distributedQueueGeneration || 0) + 1;
  host.distributedTickAbort?.abort();
  host.detachStaleDistributedTick(host.distributedQueueTickPromise);
  await host.saveDistributedQueue(context.root, undefined, { queueGeneration: generation, mutateLatest: (latest: Queue.DistributedQueue) => {
    const latestJob = latest.plans.find(row => row.id === plan.id)?.jobs.find(row => row.index === job.index);
    if (!current() || host.distributedPlanStopEpoch || latestJob?.status !== job.status)
      throw new Error("项目或 job 状态已变化，未修改。");
    return restore ? Queue.restoreJobAvailability(latest, plan.id, job.index, identity)
      : Queue.markJobUnavailable(latest, plan.id, job.index, identity, reason!, new Date().toISOString(), receipt);
  } });
  host.postState();
  if (restore) void host.tickDistributedQueue().catch((error: Error) => host.recordActionError({ command: "distributedPlanQueue", message: error.message }));
  return { status: "completed", message: restore ? "已撤销不可用标记并恢复原状态。" : "已标记此 job 不可用；保留日志和结果，其他 job 不受影响。" };
}
