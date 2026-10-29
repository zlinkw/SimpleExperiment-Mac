import { randomUUID } from "node:crypto";
import { canonicalProjectId } from "../features/DistributedPlanQueue";
import { runtimeEvidence, completionState } from "../features/RuntimeDiagnostics";

export function runtimeLogAnalysisMessage(report: any): string {
  const evidence = report.runtimeDiagnostics || {};
  const exit = report.exitCode == null ? "退出码未知" : "退出码 " + report.exitCode;
  if (report.executionState === "failed" || report.exitCode != null && report.exitCode !== 0)
    return "日志分析完成：执行失败，" + exit + "；详见任务卡片及窗口日志。";
  if (report.completionState === "review_required")
    return "日志分析完成：" + (report.status === "failed" || report.executionState === "exited" ? "任务失败，" : "")
      + "检出异常 " + evidence.count + " 次 · " + Object.keys(evidence.types || {}).join(", ")
      + " · 阶段 " + Object.keys(evidence.phases || {}).join(", ") + "；" + exit + "。详见任务卡片及窗口日志。";
  if (report.completionState === "verified") return "日志分析完成：完整日志未检出异常，" + exit + "。";
  return "日志仍待核实：" + (evidence.reason || "尚未读取完整日志") + "；" + exit + "。";
}

/** Explicit, read-only historical analysis. Nothing is written back to task history. */
export async function analyzeRuntimeLog(h: any, root: string, params: any, signal?: AbortSignal) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const context = h.captureProjectContext();
  const queue = await h.loadDistributedQueue(root);
  const job = queue.plans.flatMap((plan: any) => plan.jobs.map((job: any) => ({ ...job, workflowId: plan.id })))
    .find((job: any) => params.commandId ? job.commandId === params.commandId
      : job.workflowId === (params.workflowId || params.planId) && job.index === Number(params.index ?? params.jobIndex));
  const workerId = String(params.workerId || job?.workerId || ""), commandId = String(params.commandId || job?.commandId || "");
  const outputDir = String(params.outputDir || params.artifactPath || job?.outputDir || "");
  if (!commandId || !outputDir || !h.workerCodeSyncTargets().some((row: any) => row.id === workerId)) throw Error("请选择已启用 Worker 的原 commandId 和声明输出目录。");
  if (job && (job.workerId !== workerId || job.outputDir !== outputDir)) throw Error("任务目标与原执行身份不符。");
  const query = { commandId, projectId: canonicalProjectId(root), workerId, outputDir,
    collectionResultCsv: job?.collectionResultCsv, executionMode: job?.executionMode, runtimeLogAnalysisId: randomUUID() };
  let task: any;
  for (let pass = 0; pass < 32; pass++) {
    signal?.throwIfAborted();
    if (!h.projectContextIsCurrent(context)) throw Error("工作区已变化，已停止本轮日志分析。");
    const response = await h.client.getWorkerTasks(workerId, { queries: [query], signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    if (response.queryComplete !== true || response.capabilities?.runtimeDiagnostics !== 1) throw Error("请更新该 Worker 的 Agent/Scheduler：需要 runtimeDiagnostics=1；未改写历史。");
    task = response.tasks?.find((row: any) => row.commandId === commandId && row.projectId === query.projectId && row.workerId === workerId);
    if (!task || task.observation?.queryError) throw Error(task?.observation?.queryError || "未取得原任务的主动查询结果");
    const evidence = runtimeEvidence(task.runtimeDiagnostics, commandId);
    if (evidence.scanComplete || evidence.bytesRead == null || evidence.totalBytes == null || evidence.bytesRead >= evidence.totalBytes) break;
  }
  await h.readWorkerTaskSnapshot?.(workerId, { fresh: true, signal });
  h.postState?.(true);
  return { commandId, workerId, status: task.status, executionState: task.executionState, resultState: task.resultState, exitCode: task.exitCode,
    completionState: completionState(task.runtimeDiagnostics, commandId), runtimeDiagnostics: runtimeEvidence(task.runtimeDiagnostics, commandId),
    readOnly: true, historyRewritten: false };
}
