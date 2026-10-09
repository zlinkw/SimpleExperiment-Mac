export const AGENT_SCHEMA_VERSION = 1;
export const AGENT_PROTOCOL_VERSION = "0.2.0";

export type AgentEventType =
  | "agent_heartbeat"
  | "gpu_snapshot"
  | "scheduler_snapshot"
  | "experiment_traces"
  | "log_tail"
  | "worker_health"
  | "worker_error"
  | "sync_status"
  | "agent_warning"
  | "agent_error";

export interface AgentEventError {
  serverId?: string;
  code: string;
  message: string;
  retryable?: boolean;
}

export interface AgentEvent<T = unknown> {
  schemaVersion: 1;
  seq: number;
  type: AgentEventType;
  generatedAt: string;
  source: "hub_agent";
  hubId: string;
  workerId?: string;
  runKey?: string;
  payload: T;
  partialFailure?: boolean;
  errors?: AgentEventError[];
}

export type AgentEventValidation =
  | { ok: true; event: AgentEvent }
  | { ok: false; code: "bad_json" | "bad_schema" | "incompatible_schema" | "unknown_type"; message: string; event?: any };

const knownTypes = new Set<AgentEventType>([
  "agent_heartbeat",
  "gpu_snapshot",
  "scheduler_snapshot",
  "experiment_traces",
  "log_tail",
  "worker_health",
  "worker_error",
  "sync_status",
  "agent_warning",
  "agent_error",
]);

export function validateAgentEvent(value: unknown): AgentEventValidation {
  const event = typeof value === "string" ? parseJson(value) : value;
  if (!event || typeof event !== "object") return { ok: false, code: "bad_json", message: "event is not json object" };
  const item = event as any;
  if (Number(item.schemaVersion) !== AGENT_SCHEMA_VERSION) {
    return { ok: false, code: "incompatible_schema", message: `unsupported schemaVersion=${item.schemaVersion}`, event: item };
  }
  if (!Number.isFinite(Number(item.seq)) || !item.type || !item.generatedAt || item.source !== "hub_agent") {
    return { ok: false, code: "bad_schema", message: "missing required event fields", event: item };
  }
  if (!knownTypes.has(item.type)) return { ok: false, code: "unknown_type", message: `unknown event type=${item.type}`, event: item };
  return { ok: true, event: item as AgentEvent };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

