export type ExperimentLifecycleState =
  | "planned" | "queued" | "dispatched" | "starting" | "running" | "testing" | "completed" | "failed" | "stopped"
  | "archiving" | "archived" | "deleting" | "deleted";

export interface ExperimentEvent {
  experimentId: string;
  seq: number;
  type: string;
  from?: ExperimentLifecycleState;
  to?: ExperimentLifecycleState;
  at: string;
  source: "scheduler" | "agent" | "user" | "sync";
  reason?: string;
  detail?: unknown;
  attemptId?: string;
}

export interface ExperimentLifecycle {
  experimentId: string;
  attemptId: string;
  state: ExperimentLifecycleState;
  events: ExperimentEvent[];
}

const terminal = new Set(["completed", "failed", "stopped", "deleted"]);

export function applyExperimentEvent(lifecycle: ExperimentLifecycle | undefined, event: ExperimentEvent): ExperimentLifecycle {
  const current = lifecycle || { experimentId: event.experimentId, attemptId: event.attemptId || "attempt-1", state: "planned" as ExperimentLifecycleState, events: [] };
  if (current.events.some((item) => item.seq >= event.seq)) return current;
  if (terminal.has(current.state) && event.to && !terminal.has(event.to) && event.attemptId === current.attemptId) {
    return { ...current, events: [...current.events, { ...event, reason: event.reason || "ignored stale transition" }] };
  }
  return { ...current, state: event.to || current.state, attemptId: event.attemptId || current.attemptId, events: [...current.events, event] };
}

export function retryExperiment(previous: ExperimentLifecycle, mode: "same_worker" | "another_worker" | "resume_checkpoint" | "test_only" = "same_worker"): ExperimentLifecycle {
  const attempt = `attempt-${previous.events.filter((item) => item.type === "retry").length + 2}`;
  const event: ExperimentEvent = {
    experimentId: previous.experimentId,
    attemptId: attempt,
    seq: Math.max(0, ...previous.events.map((item) => item.seq)) + 1,
    type: "retry",
    from: previous.state,
    to: "queued",
    at: new Date().toISOString(),
    source: "user",
    reason: mode,
  };
  return applyExperimentEvent({ ...previous, attemptId: attempt, state: "queued" }, event);
}

