import { observationMatches, taskLifecycle } from "./TaskLifecycle";
import { randomUUID } from "node:crypto";

export function taskQuery(plan: any, job: any) {
  return { lifecycleProtocol: 2, commandId: job.commandId, projectId: plan.projectId, workerId: job.workerId,
    workflowId: plan.id, planFile: plan.planFile, planRevision: plan.revision, codeFingerprint: plan.codeFingerprint,
    globalJobId: job.globalJobId, experimentIndex: job.index, case: job.case, seed: job.seed, resultPathPolicy: "declared",
    runKey: job.commandId, planJobCount: plan.planJobCount || plan.jobs.length, enqueuedAt: plan.enqueuedAt,
    outputDir: job.outputDir, collectionResultCsv: job.collectionResultCsv, executionMode: plan.executionMode,
    mode: job.actualExecutionMode || plan.executionMode,
    checkpointTestOnly: job.actualExecutionMode === "test" && plan.executionMode === "train_test" };
}

export async function queryTask(client: any, plan: any, job: any, timeoutMs = 8000, options: { executionOnly?: boolean } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error((options.executionOnly ? "停止核实查询超时" : "任务状态查询超时")
    + `（Worker ${job.workerId}，commandId ${job.commandId}）`)), timeoutMs);
  try {
    const request = { signal: controller.signal, queries: [taskQuery(plan, job)], ...(options.executionOnly ? { executionOnly: true } : { selectedOnly: true }) };
    const read = Promise.resolve().then(() => client.getWorkerTasks(job.workerId, request)).catch(error => {
      // 0.5.348 supports only an unselected execution inventory. This explicit
      // rejection may fall back to a read, never repeat the stop POST.
      if (options.executionOnly && String(error.message || error).includes("EXECUTION_INVENTORY_SELECTION_INVALID"))
        return client.getWorkerTasks(job.workerId, { signal: controller.signal, queries: request.queries });
      throw error;
    });
    const snapshot = await Promise.race([read,
      new Promise<any>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }))]);
    if (snapshot?.capabilities?.taskLifecycle !== 2) throw new Error("TASK_LIFECYCLE_PROTOCOL_REQUIRED：请更新 Worker Agent/Scheduler；未派发任务");
    if (snapshot.queryComplete !== true || snapshot.error)
      throw new Error(String(snapshot.error || "Worker 实时任务查询未完成；未确认任务已停止"));
    const task = (snapshot.tasks || []).find((row: any) => observationMatches(row.observation || {}, {
      commandId: job.commandId, projectId: plan.projectId, workerId: job.workerId }));
    if (!task) throw new Error("任务查询未返回所选 commandId 的证据");
    if (task.observation.queryError) throw new Error(task.observation.queryError);
    return { task, state: taskLifecycle(task.observation), snapshot };
  } finally { clearTimeout(timer); }
}

/** The POST outcome is never a completion gate. Only a subsequent observation settles intent. */
export async function stopPulledTask(client: any, plan: any, job: any, operationId: string) {
  const request = { ...taskQuery(plan, job), lifecycleProtocol: 2, schemaVersion: 1,
    targetCommandId: job.commandId, opId: operationId, operationId, stopBoundary: "local_command" };
  let transportError: unknown;
  void Promise.resolve().then(() => client.postWorkerAction(job.workerId, "stop-worker-task", request))
    .catch(error => { transportError = error; });
  const deadline = Date.now() + 8500;
  do {
    const { task } = await queryTask(client, plan, job, 8000, { executionOnly: true });
    if (task.observation.cancelled === true && !task.observation.tmux) {
      return { status: "completed", source: "pull", stoppedTasks: [{ ...taskQuery(plan, job),
        commandId: job.commandId, stopBoundary: "local_command", paneClosed: true, cacheRetired: true }], stoppedPids: [] };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error("停止尚未核实；保留原 commandId，可主动刷新。" + (transportError instanceof Error ? transportError.message : ""));
}

export function returnPulledJobToLocal(queue: any, planId: string, index: number, commandId: string) {
  const current = queue.plans.find((plan: any) => plan.id === planId)?.jobs.find((job: any) => job.index === index);
  if (!commandId || current?.commandId !== commandId) throw new Error("任务身份已变化；未重新派发。");
  // Explicit cancellation/requeue starts a new execution. Reusing the stable
  // original allocation hash would hit the Scheduler's original cancel fence.
  const nextCommandId = randomUUID().replace(/-/g, "");
  return { ...queue, plans: queue.plans.map((plan: any) => plan.id !== planId ? plan : { ...plan,
    jobs: plan.jobs.map((job: any) => job.index !== index ? job : { ...job, lifecycleProtocol: 2, status: "pending",
      commandId: undefined, nextCommandId, startIntent: undefined, runKey: undefined, workerId: undefined, gpuId: undefined, manualDispatch: undefined, localQueueOnly: true,
      recallRequested: undefined, recallOperationId: undefined, reassignmentPending: undefined, stopIntent: undefined,
      executionState: undefined, resultState: undefined, statusQueryError: undefined, lastObservedAt: undefined,
      runtimeDiagnostics: undefined, completionState: undefined, exitCode: undefined,
      tmuxPane: undefined, tmuxWindowId: undefined, tmuxSession: undefined, logPath: undefined, historyLogIdentity: undefined,
      finishedAt: undefined, actualExecutionMode: undefined, admissionRejection: undefined, dispatchAcknowledgedAt: undefined, lastDispatchAttemptAt: undefined,
      error: undefined, blockReason: undefined, trustedTerminalStatus: undefined,
      history: [...(job.history || []), { commandId, status: job.status, outputDir: job.outputDir, stopReason: "requeue",
        workerId: job.workerId, logPath: job.logPath, historyLogIdentity: job.historyLogIdentity }] }) } ) };
}
