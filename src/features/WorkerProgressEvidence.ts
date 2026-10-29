import { taskLifecycle, type TaskObservation } from "./TaskLifecycle";

export type ObservationTiming = { requestedAt?: string; networkStartedAt?: string; receivedAt: string; publishedAt?: string; failed?: boolean; requestBytes?: number; responseBytes?: number; wireResponseBytes?: number; contentEncoding?: string };
export type EvidenceTimes = Partial<Record<"execution" | "artifacts" | "logs", ObservationTiming>>;
export function observationTiming(value: any, startedAt: string, receivedAt = new Date().toISOString()): ObservationTiming {
  return value?.localQueryTiming || { requestedAt: startedAt, networkStartedAt: startedAt, receivedAt };
}
export function evidenceFresh(timing: ObservationTiming | undefined, fallback: string | undefined, now: number, maxAgeMs: number) {
  if (timing && (timing.failed || !timing.networkStartedAt)) return false;
  const at = Date.parse(String(timing?.networkStartedAt || fallback || ""));
  return Number.isFinite(at) && now - at <= maxAgeMs && at <= now + 30_000;
}
export function freshTaskObservation(snapshot: any, task: any, fallback: TaskObservation, now: number, maxAgeMs: number): TaskObservation {
  const value: TaskObservation = { ...(task?.observation || fallback) };
  const times = value.evidence;
  const fetchedAt = snapshot.fetchedAt;
  if (snapshot.error || !evidenceFresh(times?.execution, fetchedAt, now, maxAgeMs))
    value.executionQueryError = snapshot.error || "状态查询已过期";
  if (times && !times.artifacts || (!times?.artifacts && snapshot.error) || !evidenceFresh(times?.artifacts, fetchedAt, now, maxAgeMs)) {
    value.result = undefined;
    value.resultQueryError = snapshot.error || value.resultQueryError || (times && !times.artifacts ? "本轮尚未取得产物观察" : "产物查询已过期");
  }
  if (!evidenceFresh(times?.logs, fetchedAt, now, maxAgeMs)) {
    value.runtimeQueryError = "日志查询已过期";
    const prior = value.runtimeDiagnostics;
    value.runtimeDiagnostics = prior && prior.count > 0
      ? { ...prior, scanComplete: false } : undefined;
  }
  return value;
}

/** Merge each locally timed evidence lane. A late log response cannot roll back
 * execution, metadata, another run, or a newer round's failure. */
export function mergeProgressSnapshot(current: any, incoming: any): any {
  if (!current || current.workerId !== incoming.workerId || current.capabilities?.taskLifecycle !== 2) return incoming;
  const key = (task: any) => JSON.stringify([task.projectId, task.commandId]);
  const next = new Map((incoming.tasks || []).map((task: any) => [key(task), task]));
  const tasks = (current.tasks || []).map((prior: any) => {
    const task: any = next.get(key(prior));
    if (!task) return prior;
    next.delete(key(prior));
    const observation = { ...task.observation, evidence: { ...task.observation?.evidence } };
    for (const [lane, fields] of Object.entries({ execution: ["tmux", "cancelled", "schedulerPhase", "executionQueryError"],
      artifacts: ["result", "resultQueryError", "artifactIssue"], logs: ["runtimeDiagnostics", "runtimeQueryError"] })) {
      const before = prior.observation?.evidence?.[lane], after = task.observation?.evidence?.[lane];
      const order = (timing: ObservationTiming) => Date.parse(String(timing.failed ? timing.requestedAt : timing.networkStartedAt));
      if (before && (!after || order(before) > order(after))) {
        observation.evidence[lane] = before;
        for (const field of fields) observation[field] = prior.observation[field];
      }
    }
    const state = taskLifecycle(observation);
    return { ...prior, ...task, observation, status: state.status, executionState: state.execution, resultState: state.result,
      completionState: state.completionState, runtimeDiagnostics: state.runtimeDiagnostics, exitCode: state.exitCode,
      successful: state.status === "completed" && state.completionState === "verified" };
  });
  const base = Date.parse(incoming.progressRequestStartedAt || incoming.fetchedAt)
    < Date.parse(current.progressRequestStartedAt || current.fetchedAt) ? current : incoming;
  return { ...current, ...base, error: base.error, tasks: [...tasks, ...next.values()] };
}
