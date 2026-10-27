import { DistributedQueue, outputIsolationNotice, QueuedJob, QueuedPlan } from "./DistributedPlanQueue";
import { dispatchAdmissionDenied } from "../project/UnifiedDispatchAdmission";

export type ManualDispatchRequest = { workflowId: string; indices: number[]; workerId: string; gpuId: string;
  expectedCommands?: Record<string, string>; stopRunning?: boolean };
export type ManualDispatchPorts = {
  load(): Promise<DistributedQueue>;
  /** save 可携带 dispatchAdmission 并回传统一准入回执（旧宿主不返回回执=行为不变）。 */
  save(queue: DistributedQueue, options?: { dispatchAdmission?: boolean }): Promise<unknown>;
  assertCurrent(): void;
  online(workerId: string): boolean; supports(workerId: string): boolean; newCommandId(): string;
  prepare(plan: QueuedPlan): Promise<void>; stop(plan: QueuedPlan, job: QueuedJob): Promise<void>;
  /** r82：审核可返回 true/false、接受子集，或成对的 {accepted, blocked}——blocked 是隔离
   * 未完成/核验未知的准入排除（可见、不派发、绝不等于用户保留），与"取消"和"有意跳过"区分。 */
  review(plan: QueuedPlan, jobs: QueuedJob[]): Promise<boolean | number[] | { accepted?: number[];
    blocked?: Array<{ index: number; reason: string; stage?: string; code?: string; operationId?: string }> }>;
  send(plan: QueuedPlan, job: QueuedJob): Promise<unknown>; tick(): Promise<void>;
};

/** One placement intent; transport responses never prove acceptance or permit a second launch. */
export async function dispatchManualJobs(ports: ManualDispatchPorts, request: ManualDispatchRequest) {
  ports.assertCurrent();
  const indices = [...new Set(request.indices)];
  if (!indices.length || indices.some(index => !Number.isInteger(index) || index < 0) || !request.workerId || !String(request.gpuId).trim())
    throw new Error("请选择任务、服务器和 GPU。");
  let queue = await ports.load();
  const plan = queue.plans.find(row => row.id === request.workflowId);
  if (!plan || plan.resultPathPolicy !== "declared") throw new Error("当前正式 PLAN 不存在；历史任务只供查看。");
  const jobs = indices.map(index => plan.jobs.find(row => row.index === index));
  if (jobs.some(job => !job || job.status === "completed")) throw new Error("请选择尚未完成的任务；已完成任务请使用重跑入口。");
  const selected = jobs as QueuedJob[];
  if (ports.online(request.workerId) && !ports.supports(request.workerId)) throw new Error("目标 Worker 尚不支持手动派发，请更新其 Agent/Scheduler。");
  if (!ports.online(request.workerId) && selected.every(job => job.status === "pending" && !job.commandId)) {
    for (const job of selected) {
      job.manualDispatch = undefined;
      job.manualDispatchNotice = "目标服务器未连接，已回到自动派发队列。";
    }
    await ports.save(queue);
    return { status: "submitted", fallbackToAutomatic: true, indices };
  }
  const identities = new Map(selected.map(job => [job.index, job.commandId || ""]));
  for (const job of selected) {
    if (request.expectedCommands && request.expectedCommands[job.index] !== (job.commandId || "")) throw new Error("任务已变化，请刷新后重新选择；未重复派发。");
    const uncertain = job.status === "dispatching" || job.status === "unknown" && job.commandId && !["missing", "failed", "exited"].includes(job.executionState || "");
    if (uncertain && !request.stopRunning)
      throw new Error("原请求接收情况尚未核实；请使用“停止后派发”，先核实原任务已撤出再派发。");
    const originalExpected = Boolean(job.commandId) || ["dispatching", "queued", "running"].includes(job.status)
      || job.status === "unknown" && job.localQueueOnly !== true;
    if (originalExpected && (!job.commandId || !job.workerId))
      throw new Error("原任务的请求或服务器身份缺失，无法核实精确停止；未另行派发。");
    if (["running", "queued"].includes(job.status) && !request.stopRunning) throw new Error("请使用“停止后派发”撤出原任务。");
  }
  for (const job of selected) job.manualDispatch = { workerId: request.workerId, gpuId: String(request.gpuId), stage: "preparing" };
  await ports.save(queue); // Reserve before sync/stop: automatic allocation must skip this batch.
  let committed = false;
  try {
    if (ports.online(request.workerId)) await ports.prepare(plan);
    for (const job of selected) if (job.commandId && job.workerId) {
      ports.assertCurrent(); await ports.stop(plan, job);
      job.status = "cancelled"; job.executionState = "missing";
    }
    ports.assertCurrent();
    await ports.save(queue);
    const reviewed = await ports.review(plan, selected);
    if (reviewed === false) return { status: "cancelled", message: "文件审核已取消，未启动本批任务。" };
    // r82：三态消费——数组=接受子集；对象={accepted, blocked}成对；其余（true）=全部接受。
    // blocked 条目是隔离准入排除（本轮不派发），不得借用 retainExistingOutputs 的"用户保留"语义。
    const blockedDecisions = new Map<number, { index: number; reason: string; stage?: string; code?: string; operationId?: string }>();
    if (reviewed && !Array.isArray(reviewed) && typeof reviewed === "object")
      for (const row of reviewed.blocked || []) if (Number.isInteger(Number(row?.index))) blockedDecisions.set(Number(row.index), row);
    const accepted = Array.isArray(reviewed) ? selected.filter(job => reviewed.includes(job.index))
      : reviewed && typeof reviewed === "object" && !Array.isArray(reviewed)
        ? selected.filter(job => (reviewed.accepted || []).includes(job.index)) : selected;
    const online = ports.online(request.workerId);
    if (online) {
      if (!ports.supports(request.workerId)) throw new Error("目标 Worker 尚不支持手动派发，请更新其 Agent/Scheduler。");
    }
    ports.assertCurrent();
    const latest = await ports.load(), current = latest.plans.find(row => row.id === plan.id);
    if (!current || current.revision !== plan.revision) throw new Error("PLAN 已变化，未派发。");
    for (const original of selected.filter(job => !accepted.includes(job))) {
      const job = current.jobs.find(row => row.index === original.index); if (!job) continue;
      const decision = blockedDecisions.get(original.index);
      if (decision) {
        // 隔离未完成/核验未知：job 保持可见 pending、清掉手动派发身份（不得占用派发身份），
        // 打 job 级阻断标记+如实原因——它是"待重新审核"，不是"用户保留/沿用完成"。
        Object.assign(job, { manualDispatch: undefined, manualDispatchNotice: undefined, retainExistingOutputs: undefined,
          outputIsolationBlocked: { reason: String(decision.reason || "隔离结果未核实"),
            stage: decision.stage === "preview" || decision.stage === "execute" || decision.stage === "verify" ? decision.stage : "execute",
            ...(decision.code ? { code: String(decision.code) } : {}), ...(decision.operationId ? { operationId: String(decision.operationId) } : {}),
            declarationKey: job.outputDir, observedAt: new Date().toISOString() } });
        job.blockReason = outputIsolationNotice(job);
        continue;
      }
      Object.assign(job, { manualDispatch: undefined, retainExistingOutputs: true, status: "cancelled", manualDispatchNotice: "保留已有完成产物，本次未派发。" });
    }
    for (const original of accepted) {
      const job = current.jobs.find(row => row.index === original.index);
      if (!job || (job.commandId || "") !== identities.get(job.index)) throw new Error("任务已变化，未派发。");
      job.history = [...(job.history || []), ...(job.commandId ? [{ attempt: 0, status: job.status, commandId: job.commandId,
        workerId: job.workerId, outputDir: job.outputDir, stopReason: "manual-dispatch" }] : [])];
      Object.assign(job, { nextCommandId: ports.newCommandId(), commandId: undefined, workerId: undefined, gpuId: undefined,
        runKey: undefined, status: "pending", lifecycleProtocol: 2, actualExecutionMode: current.executionMode,
        executionState: undefined, resultState: undefined, finishedAt: undefined, error: undefined,
        runtimeDiagnostics: undefined, completionState: undefined, exitCode: undefined,
        stopIntent: undefined, automaticRetry: undefined, recallRequested: undefined, reassignmentPending: undefined,
        unavailable: undefined, cleanup: undefined, outputRetiredAt: undefined, trainingRecovery: undefined, retainExistingOutputs: undefined,
        // r82：走到这里=用户经既有审核路径、精确声明未变（上方身份核对）且本轮隔离完成核验通过，
        // 随同一次 save 事务性解除阻断标记——除此之外任何路径（投影/合并/重排/重试）都不得清标。
        outputIsolationBlocked: undefined,
        trustedTerminalStatus: undefined, admissionRejection: undefined, formalConflictEvidence: undefined, originalExecution: undefined,
        statusQueryError: undefined, lastObservedAt: undefined, tmuxWindowId: undefined, tmuxPane: undefined, tmuxSession: undefined,
        artifacts: undefined, artifactError: undefined, artifactRetryAfter: undefined, artifactStageBlock: undefined, latestArtifactSync: undefined, mirroredWorkerIds: undefined, fragmentWorkerIds: undefined,
        manualDispatchNotice: online ? undefined : "目标服务器未连接，已回到自动派发队列。",
        checkpointTestOnly: undefined, localQueueOnly: true, blockReason: online ? undefined : "目标服务器未连接，已回到自动派发队列。",
        manualDispatch: online ? { workerId: request.workerId, gpuId: String(request.gpuId), stage: "ready" } : undefined });
    }
    await ports.save(latest); committed = true;
    // A later disconnect before sending can still fall back. Once marked sent it can only be queried.
    await ports.tick();
    return { status: "submitted", fallbackToAutomatic: !online, indices: accepted.map(job => job.index) };
  } finally {
    if (!committed) {
      const latest = await ports.load();
      for (const p of latest.plans) if (p.id === plan.id) for (const job of p.jobs) if (identities.get(job.index) === (job.commandId || "") && job.manualDispatch?.stage === "preparing")
        job.manualDispatch = undefined;
      await ports.save(latest);
    }
  }
}

export async function dispatchReadyManualJobs(ports: ManualDispatchPorts) {
  const queue = await ports.load();
  for (const plan of queue.plans) for (const job of plan.jobs) {
    // r82：ready 清扫先核最新持久队列里的隔离阻断——阻断 job 留在 ready 状态等待重新审核，
    // 绝不发送、不清标记、不产生新副作用（现场缺口：手动 ready 路径此前无隔离概念）。
    if (job.manualDispatch?.stage !== "ready" || job.commandId || job.status !== "pending" || job.outputIsolationBlocked) continue;
    ports.assertCurrent();
    const placement = job.manualDispatch;
    if (!ports.online(placement.workerId)) {
      job.manualDispatch = undefined; job.manualDispatchNotice = job.blockReason = "目标服务器未连接，已回到自动派发队列。";
      await ports.save(queue); continue;
    }
    if (!ports.supports(placement.workerId)) {
      job.manualDispatchNotice = job.blockReason = "请更新目标 Worker 的 Agent/Scheduler 后继续手动派发。";
      await ports.save(queue); continue;
    }
    // 申请身份先落 const（返回契约 string）：保存可能原地剥回 job 对象，回执过滤必须持有原申请ID。
    const placedCommandId = job.nextCommandId || ports.newCommandId();
    Object.assign(job, { workerId: placement.workerId, gpuId: placement.gpuId, commandId: placedCommandId,
      status: "dispatching", manualDispatch: { ...placement, stage: "sent" } });
    job.runKey = job.commandId; job.nextCommandId = undefined;
    // Persist exact identity before the one and only POST — in the managed domain this same save
    // is the unified consent point; a denied intent is rewound to stage=ready by the save itself.
    const admission = await ports.save(queue, { dispatchAdmission: true });
    if (dispatchAdmissionDenied(admission, plan.id, job.index, placedCommandId)) continue;
    try { await ports.send(plan, job); }
    catch (error: any) { job.blockReason = "派发请求状态待查询：" + String(error.message || error); }
    await ports.save(queue);
  }
}
