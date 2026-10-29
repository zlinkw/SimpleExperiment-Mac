import { completionState, runtimeEvidence, type RuntimeDiagnostics, type CompletionState } from "./RuntimeDiagnostics";
import type { EvidenceTimes } from "./WorkerProgressEvidence";
/** Runtime truth comes from a bounded pull, never an event or a stored status. */
export type TaskExecution = "queued" | "starting" | "running" | "exited" | "failed" | "missing" | "unknown";
export type TaskResult = "complete" | "incomplete" | "unverified" | "conflict";
export type TaskObservation = {
  commandId: string; projectId: string; workerId: string; lifecycleProtocol: 2;
  observedAt: string; queryError?: string; schedulerPhase?: string;
  resultQueryError?: string;
  executionQueryError?: string; runtimeQueryError?: string; evidence?: EvidenceTimes;
  artifactIssue?: string;
  runtimeDiagnostics?: RuntimeDiagnostics;
  cancelled?: boolean;
  tmux?: { windowId: string; paneId: string; dead: boolean; exitCode?: number | null; phase?: string };
  result?: { runId: string; status: string; present: boolean; verified: boolean; identityMatches?: boolean; artifactsComplete?: boolean; exitCode?: number | null } | null;
};
export function taskLifecycle(value: TaskObservation): { execution: TaskExecution; result: TaskResult;
  status: "unknown" | "queued" | "running" | "failed" | "completed" | "cancelled";
  completionState?: CompletionState; runtimeDiagnostics?: RuntimeDiagnostics; exitCode?: number | null; message?: string } {
  let execution: TaskExecution = "missing", result: TaskResult = value.result === null ? "incomplete" : "unverified";
  if (value.queryError) return { execution: "unknown" as TaskExecution, result: "unverified", status: "unknown" as const, message: value.queryError };
  const pane = value.executionQueryError ? undefined : value.tmux;
  if (value.executionQueryError) execution = "unknown";
  if (pane) {
    // An absent native exit code is not evidence of failure. The current
    // command's verified manifest still decides whether an ended run completed.
    if (pane.dead) execution = Number.isInteger(pane.exitCode) && pane.exitCode !== 0 ? "failed" : "exited";
    else if (["queued", "bound"].includes(pane.phase || "")) execution = "queued";
    else if (["admitted", "starting"].includes(pane.phase || "")) execution = "starting";
    else if (pane.phase === "running") execution = "running";
    else execution = "unknown";
  }
  if (value.result) {
    result = value.result.runId !== value.commandId || value.result.identityMatches === false ? "conflict"
      : (value.result.artifactsComplete === true || value.result.status === "completed") && value.result.present && value.result.verified ? "complete" : "incomplete";
  }
  if (value.resultQueryError) result = "unverified";
  const exitCode = pane?.exitCode ?? (value.result?.runId === value.commandId && value.result.identityMatches !== false ? value.result?.exitCode : undefined) ?? pane?.exitCode;
  if ((!pane || pane.dead) && Number.isInteger(exitCode) && !value.resultQueryError && !value.executionQueryError) execution = exitCode !== 0 ? "failed" : "exited";
  let status: "unknown" | "queued" | "running" | "failed" | "completed" | "cancelled" = ["queued", "starting"].includes(execution) ? "queued" : execution === "running" ? "running"
    : execution === "failed" ? "failed" : execution === "unknown" ? "unknown" : result === "complete" ? "completed" : value.cancelled && !pane ? "cancelled"
    : execution === "missing" ? "unknown" : "unknown";
  const message = value.executionQueryError || (value.resultQueryError ? "产物核实失败：" + value.resultQueryError : execution === "starting" ? "任务窗口已建立，正在启动命令"
    : execution === "unknown" ? "窗口执行阶段尚未核实" : execution === "missing" && result !== "complete" ? "远端未发现该任务；未自动重新派发"
    : result === "conflict" ? "产物清单与本次任务不符"
    : execution === "exited" && result === "incomplete" ? "执行已结束，结果不完整"
    : execution === "exited" && result !== "complete" ? "执行已结束，产物尚未确认" : undefined);
  const evidence = runtimeEvidence(value.runtimeDiagnostics, value.commandId);
  let completion = completionState(evidence, value.commandId);
  if (completion === "verified" && exitCode == null && value.result?.status === "failed") completion = "unverified";
  if (completion === "review_required" && (execution === "exited" || execution === "failed"
    || execution === "missing" && result === "complete")) status = "failed";
  return { execution, result, status, message, exitCode,
    runtimeDiagnostics: evidence, completionState: completion };
}

/** Only stable control ownership is required for a live observation. */
export function observationMatches(value: TaskObservation, expected: { commandId?: string; projectId?: string; workerId?: string }) {
  return value.lifecycleProtocol === 2 && Boolean(expected.commandId && expected.projectId && expected.workerId)
    && value.commandId === expected.commandId && value.projectId === expected.projectId && value.workerId === expected.workerId;
}
