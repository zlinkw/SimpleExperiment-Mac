import * as Queue from "./DistributedPlanQueue";

const terminal = (status: unknown) => ["completed", "failed", "cancelled", "canceled", "stopped", "succeeded", "error", "operation_failed", "operation_completed"].includes(String(status || "").toLowerCase());

/** Stop only the identities the user confirmed. Never clear output/history or bypass the final active guard. */
export async function preparePlanSafeRetry(host: any, planFile: string,
  confirm: (detail: string) => Promise<boolean>, cancelled: () => Error): Promise<boolean> {
  const context = host.captureProjectContext();
  const client = host.client;
  let stopEpoch = 0;
  const current = () => {
    if (!host.projectContextIsCurrent(context) || host.client !== client) throw new Error("项目已切换，已停止重新运行。");
    if (stopEpoch && host.distributedPlanStopEpoch !== stopEpoch) throw new Error("停止批次已变化，未重新运行。");
  };
  const reconciliation = await host.reconcileStalePlanRunOperations({ reason: "safe_retry" });
  const verifiedOperations = new Set(reconciliation?.checked || []);
  current();
  const queue: Queue.DistributedQueue = await host.loadDistributedQueue(context.root);
  const plans = queue.plans.filter(row => Queue.sameDistributedPlanFile(row.planFile, planFile));
  if (plans.some(row => Queue.hasUnresolvedPlanRecovery(row)))
    throw new Error("该 Plan 仍有未核实的远端任务，未启动新运行；请恢复连接并刷新状态后重试。");
  let jobs = plans.flatMap(plan => plan.jobs.filter(job => !terminal(job.status)).map(job => ({ plan, job })));
  const operations = host.longRunningPlanRunOperations().filter((row: any) =>
    Queue.sameDistributedPlanFile(row.planFile || row.plan || row.options?.planFile || "", planFile)
    && row.reconcileEvidenceActive !== false);
  if (operations.some((row: any) => row.lastReconcileError || row.outcomePending && !verifiedOperations.has(row.operationId)))
    throw new Error("旧运行状态尚未确认，未发送新任务；请恢复连接并刷新运行状态后重试。");
  const deferred = (queue.deferred || []).filter(row => row.status !== "superseded" && Queue.sameDistributedPlanFile(row.planFile, planFile));
  if (!jobs.length && !operations.length && !deferred.length) return false;
  // Capture run + attempt + command, never stop a newer run discovered after confirmation.
  const identity = ({ plan, job }: typeof jobs[number]) => `${plan.id}\0${job.index}\0${job.attempt}\0${job.commandId || ""}`;
  const snapshots = new Map<string, any>();
  const observedTerminal = new Map<string, Queue.JobState>();
  for (const { plan, job } of jobs) {
    if (job.recoveryConflict) throw new Error("任务归属冲突，未重新运行。");
    if (job.status === "pending" && !job.workerId && !job.commandId) continue;
    if (!job.workerId || !job.commandId) throw new Error("旧任务缺少精确运行身份，未重新运行。");
    if (!snapshots.has(job.workerId)) snapshots.set(job.workerId, await host.client.getWorkerTasks(job.workerId));
    current();
    const task = snapshots.get(job.workerId)?.tasks?.find((row: any) => Queue.remoteTaskMatchesJob(plan, job, row));
    if (!task) throw new Error("远端没有与旧任务身份匹配的记录，不能把记录缺失当作停止证明。");
    if (terminal(task.status)) observedTerminal.set(identity({ plan, job }),
      task.status === "completed" || task.status === "succeeded" ? "completed" : task.status === "failed" || task.status === "error" ? "failed" : "cancelled");
  }
  current();
  if (observedTerminal.size) {
    await host.saveDistributedQueue(context.root, undefined, { mutateLatest: (latest: Queue.DistributedQueue) => ({ ...latest,
      plans: latest.plans.map(plan => ({ ...plan, jobs: plan.jobs.map(job => {
        const status = observedTerminal.get(identity({ plan, job }));
        return status ? { ...job, status, trustedTerminalStatus: status } : job;
      }) })) }) });
    jobs = jobs.filter(row => !observedTerminal.has(identity(row)));
    if (!jobs.length && !operations.length && !deferred.length) return false;
  }
  const yes = await confirm(`Plan：${planFile}\n待处理 job：${jobs.length}；运行提交：${operations.length}；本地排队：${deferred.length}。\n仅停止这个 Plan 已确认的旧运行，收到退出回执后重新校验并提交。已有产物和历史记录保留。`);
  current();
  if (!yes) throw cancelled();
  if (host.distributedPlanStopEpoch) throw new Error("另一个 Plan 停止操作正在确认，请稍后重试。");
  const epoch = host.distributedPlanStopEpoch = 1;
  stopEpoch = epoch;
  host.distributedQueueGeneration = (host.distributedQueueGeneration || 0) + 1;
  const generation = host.distributedQueueGeneration;
  host.distributedTickAbort?.abort();
  host.detachStaleDistributedTick(host.distributedQueueTickPromise);
  const persist = async (ids: Set<string>) => {
    current();
    await host.saveDistributedQueue(context.root, undefined, { queueGeneration: generation, mutateLatest: (latest: Queue.DistributedQueue) => ({
      ...latest,
      plans: latest.plans.map(plan => ({ ...plan, jobs: plan.jobs.map(job => ids.has(identity({ plan, job }))
        ? { ...job, status: "cancelled", trustedTerminalStatus: "cancelled", recallRequested: false, reassignmentPending: false,
          stopReason: "user_retry", finishedAt: new Date().toISOString() } : job) })),
      deferred: (latest.deferred || []).map(row => deferred.some(old => old.id === row.id)
        ? { ...row, status: "superseded", reason: "用户确认重新运行" } : row),
    }) });
  };
  try {
    if (host.distributedQueueWritePromise) await host.boundedPromise(() => host.distributedQueueWritePromise, 8000, new Error("队列写入尚未退出，未重新运行。"));
    current();
    if (jobs.some(({ plan, job }) => host.distributedLaunchInFlight?.has(`${plan.id}\0${job.index}\0${job.attempt}`)))
      throw new Error("旧任务启动回执尚未落地，未重发；收到回执后请再次重试。");
    // Freeze only this Plan's unassigned work; other Plans resume after this bounded stop phase.
    await persist(new Set(jobs.filter(({ job }) => job.status === "pending" && !job.workerId && !job.commandId).map(identity)));
    for (const row of operations) {
      current();
      const result = await host.boundedPromise(() => host.stopExperimentRouted({ operationId: row.operationId, planFile,
        workerId: host.runOperationWorkerId(row), manualStopType: "scheduler_aborted" }), 30_000, new Error("旧运行停止回执超时，未重新运行。"));
      current();
      if (!result?.ok || !result.matchedOperations?.includes(row.operationId) || result.remainingActiveEvidence?.length)
        throw new Error("旧运行未确认停止，未重新运行。");
    }
    for (const target of jobs.filter(({ job }) => job.workerId || job.commandId)) {
      current();
      const task = snapshots.get(String(target.job.workerId))?.tasks?.find((row: any) => Queue.remoteTaskMatchesJob(target.plan, target.job, row));
      if (!terminal(task?.status)) await host.boundedPromise(() => host.stopDistributedJobForClear(target.plan, target.job), 30_000,
        new Error("旧 job 停止回执超时，未重新运行。"));
      current();
      await persist(new Set([identity(target)]));
    }
    await host.reconcileStalePlanRunOperations({ reason: "safe_retry_stopped" });
    current();
    const latest: Queue.DistributedQueue = await host.loadDistributedQueue(context.root);
    if (latest.plans.some(plan => Queue.sameDistributedPlanFile(plan.planFile, planFile)
      && (Queue.hasUnresolvedPlanRecovery(plan) || plan.jobs.some(job => !terminal(job.status)))))
      throw new Error("该 Plan 又出现未结束任务，未创建重复运行，请刷新后重试。");
    host.postState();
    return true;
  } finally {
    if (host.distributedPlanStopEpoch === epoch) host.distributedPlanStopEpoch = 0;
  }
}
