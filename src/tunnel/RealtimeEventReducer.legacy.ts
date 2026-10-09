// @ts-nocheck
import { ClusterSnapshot } from "./TunnelClient";

export type RealtimeEventType =
  | "agent_heartbeat"
  | "gpu_snapshot"
  | "scheduler_snapshot"
  | "experiment_lifecycle"
  | "experiment_trace"
  | "log_tail"
  | "result_parsed"
  | "quality_gate_updated"
  | "statistics_updated"
  | "paper_table_updated"
  | "file_transfer_progress"
  | "file_changed"
  | "diagnostics_updated"
  | "worker_health"
  | "worker_task_snapshot"
  | "worker_task_completed"
  | "worker_task_failed"
  | "worker_task_stopped"
  | "agent_warning"
  | "operation_started"
  | "operation_progress"
  | "operation_completed"
  | "operation_failed";

export interface RealtimeEventError {
  code: string;
  message: string;
  serverId?: string;
  retryable?: boolean;
}

export interface RealtimeEvent {
  schemaVersion: 1;
  seq: number;
  type: RealtimeEventType;
  generatedAt: string;
  source: "hub_agent" | "worker_telemetry";
  serverId?: string;
  workerId?: string;
  runKey?: string;
  experimentId?: string;
  operationId?: string;
  transferId?: string;
  payload: unknown;
  partialFailure?: boolean;
  errors?: RealtimeEventError[];
}

export interface FileChangedEvent {
  type: "file_changed";
  path: string;
  changeType: "created" | "modified" | "deleted";
  size?: number;
  mtime?: string;
  relatedExperimentId?: string;
  relatedRunKey?: string;
}

export interface RealtimeState {
  lastSeq: number;
  lastHeartbeatAt?: string;
  gpu: Record<string, unknown[]>;
  schedulerStates: unknown[];
  experimentTraces: unknown[];
  logs: Record<string, { offset?: number; text: string; seq: number; updatedAt?: string; [key: string]: unknown }>;
  operations: Record<string, unknown>;
  diagnostics?: unknown;
  fileTransfers: Record<string, unknown>;
  warnings: string[];
  lastKnownGood?: ClusterSnapshot;
  resultSummaryDirtySeq?: number;
  resultSummaryDirtyAt?: string;
  resultSummaryDirtyType?: string;
  resultSummaryDirtyKey?: string;
  resultSummaryDirtyPlanFile?: string;
  workerTasks?: Record<string, unknown[]>;
  workerHealth?: Record<string, unknown>;
}

export const REALTIME_LOG_RECORD_LIMIT = 40;
export const REALTIME_LOG_TEXT_LIMIT = 8000;
export const REALTIME_SCHEDULER_RECORD_LIMIT = 240;
export const REALTIME_TRACE_RECORD_LIMIT = 240;
export const REALTIME_OPERATION_RECORD_LIMIT = 160;
export const REALTIME_FILE_TRANSFER_RECORD_LIMIT = 80;
export const REALTIME_WORKER_TASK_RECORD_LIMIT = 160;

const realtimeRecordStatusRanks = new Map<string, number>([
  ["running", 0], ["queued", 0], ["pending", 0], ["progress", 0], ["accepted", 0],
  ["failed", 1], ["stalled", 1], ["cancelled", 1], ["canceled", 1], ["error", 1],
  ["completed", 3], ["done", 3], ["archived", 3], ["deleted", 3],
]);

const genericRowStatusRanks = new Map<string, number>([
  ["running", 0], ["testing", 0], ["queued", 0], ["pending", 0], ["progress", 0],
  ["failed", 1], ["stalled", 1], ["stopped", 1], ["cancelled", 1], ["canceled", 1], ["error", 1], ["missing", 1], ["residue", 1],
  ["completed", 3], ["done", 3], ["archived", 3], ["deleted", 3],
]);

const knownTypes = new Set<RealtimeEventType>([
  "agent_heartbeat",
  "gpu_snapshot",
  "scheduler_snapshot",
  "experiment_lifecycle",
  "experiment_trace",
  "log_tail",
  "result_parsed",
  "quality_gate_updated",
  "statistics_updated",
  "paper_table_updated",
  "file_transfer_progress",
  "file_changed",
  "diagnostics_updated",
  "worker_health",
  "worker_task_snapshot",
  "worker_task_completed",
  "worker_task_failed",
  "worker_task_stopped",
  "agent_warning",
  "operation_started",
  "operation_progress",
  "operation_completed",
  "operation_failed",
]);

const resultSummaryDirtyTypes = new Set<RealtimeEventType>([
  "result_parsed",
  "quality_gate_updated",
  "statistics_updated",
  "paper_table_updated",
]);

const resultFileNames = new Set([
  "metrics_summary.csv", "metrics_case.csv", "results.csv", "result.csv", "metrics.csv", "summary.csv", "scores.csv", "score.csv",
  "classification_report.csv", "detailed_metrics.csv", "test_metrics.csv", "metrics.json", "summary.json", "result.json", "results.json",
  "classification_report.json",
]);

const resultTextNames = new Set([
  "summary.txt", "result.txt", "results.txt", "classification_report.txt", "stdout.log", "stderr.log", "train.log", "test.log", "console.log", "output.out",
]);

const resultRootPrefixes = [
  "experiments/results/", "results/", "outputs/", "runs/", "logs/", "test_results/", "lightning_logs/", "custom_results/",
  "reports/", "artifacts/", "simple_cluster/results/", "paper/tables/",
];

const resultDirectorySegments = resultRootPrefixes.map((prefix) => `/${prefix}`);

export function createRealtimeState(snapshot?: ClusterSnapshot): RealtimeState {
  const compactSnapshot = compactClusterSnapshot(snapshot);
  return {
    lastSeq: 0,
    gpu: compactSnapshot?.gpu || {},
    schedulerStates: compactSnapshot?.schedulerStates || [],
    experimentTraces: compactSnapshot?.experimentTraces || [],
    logs: {},
    operations: operationsRecord(compactSnapshot?.operations) || {},
    fileTransfers: {},
    workerHealth: {},
    workerTasks: {},
    warnings: [],
    lastKnownGood: compactSnapshot,
  };
}

export function validateRealtimeEvent(input: unknown): { ok: true; event: RealtimeEvent } | { ok: false; warning: string; event?: unknown } {
  const item = typeof input === "string" ? safeJson(input) : input;
  if (!item || typeof item !== "object") return { ok: false, warning: "malformed event" };
  const event = item as Partial<RealtimeEvent>;
  if (Number(event.schemaVersion) !== 1 || !Number.isFinite(Number(event.seq)) || !event.generatedAt || (event.source !== "hub_agent" && event.source !== "worker_telemetry")) {
    return { ok: false, warning: "bad event schema", event: item };
  }
  if (!knownTypes.has(event.type as RealtimeEventType)) return { ok: false, warning: `unknown event type=${String(event.type)}`, event: item };
  return { ok: true, event: event as RealtimeEvent };
}

export function applyRealtimeEvent(state: RealtimeState, input: unknown, options: { protectedLogKeys?: string[] } = {}): RealtimeState {
  const valid = validateRealtimeEvent(input);
  if (valid.ok === false) return { ...state, warnings: [...state.warnings.slice(-20), valid.warning] };
  const event = valid.event;
  if (event.seq <= state.lastSeq) {
    if (isResultSummaryDirtyEvent(event) && shouldAcceptDirtyEvent(state, event)) return markResultsSummaryDirty(state, event);
    return state;
  }

  const next: RealtimeState = { ...state, lastSeq: event.seq };
  const payload = objectRecord(event.payload);
  if (event.type === "agent_heartbeat") next.lastHeartbeatAt = event.generatedAt;
  if (event.type === "gpu_snapshot") {
    const serverId = event.workerId || event.serverId || "hub";
    const rows = Array.isArray(event.payload)
      ? event.payload
      : Array.isArray(payload.gpus) ? payload.gpus : Array.isArray(payload.rows) ? payload.rows : Array.isArray(payload.gpu) ? payload.gpu : [];
    next.gpu = { ...state.gpu, [serverId]: rows };
  }
  if (event.type === "scheduler_snapshot") {
    next.schedulerStates = Array.isArray(event.payload)
      ? event.payload
      : payload.schedulerStates || payload.scheduler_states || payload.scheduler || payload.rows || [];
  }
  if (event.type === "experiment_lifecycle" || event.type === "experiment_trace") {
    const incoming = Array.isArray(event.payload) ? event.payload : [event.payload];
    next.experimentTraces = mergeByKey(state.experimentTraces, incoming, event.seq);
  }
  if (event.type === "log_tail") {
    const runKey = event.runKey || payload.runKey || payload.run_key || payload.key;
    if (runKey) next.logs = compactRealtimeLogs({ ...state.logs, [String(runKey)]: { text: String(payload.text || ""), offset: payload.offset, seq: event.seq } });
  }
  if (event.type.startsWith("operation_")) {
    const operationId = event.operationId || payload.operationId || payload.operation_id || payload.opId || payload.id;
    if (operationId) {
      const previous = state.operations[String(operationId)];
      next.operations = isTerminalOperation(previous) && !isTerminalOperationType(event.type)
        ? state.operations
        : { ...state.operations, [String(operationId)]: { ...payload, type: event.type, seq: event.seq } };
    }
  }
  if (event.type === "diagnostics_updated") next.diagnostics = event.payload;
  if (event.type === "worker_health") {
    const workerId = event.workerId || event.serverId || String(payload.workerId || payload.worker_id || "worker");
    next.workerHealth = { ...(state.workerHealth || {}), [workerId]: { ...payload, updatedAt: event.generatedAt } };
  }
  if (event.type === "worker_task_snapshot") {
    const workerId = event.workerId || event.serverId || String(payload.workerId || payload.worker_id || "worker");
    const rows = Array.isArray(event.payload)
      ? event.payload
      : payload.tasks || payload.workerTasks || payload.worker_tasks || payload.rows || [];
    next.workerTasks = { ...(state.workerTasks || {}), [workerId]: rows };
  }
  if (["worker_task_completed", "worker_task_failed", "worker_task_stopped"].includes(event.type)) {
    const workerId = event.workerId || event.serverId || String(payload.workerId || payload.worker_id || "worker");
    const commandId = String(payload.commandId || event.operationId || "");
    if (commandId) {
      const oldRows = Array.isArray(state.workerTasks?.[workerId]) ? state.workerTasks[workerId] : [];
      const rows = oldRows.filter((row) => String(row?.commandId || "") !== commandId);
      rows.push({ ...payload, commandId,
        status: event.type === "worker_task_completed" ? "completed" : event.type === "worker_task_stopped" ? "stopped" : "failed" });
      next.workerTasks = { ...(state.workerTasks || {}), [workerId]: rows };
    }
  }
  if (event.type === "file_transfer_progress") {
    const transferId = event.transferId || payload.transferId || payload.transfer_id || payload.id;
    if (transferId) next.fileTransfers = { ...state.fileTransfers, [String(transferId)]: { ...payload, seq: event.seq } };
  }
  if (isResultSummaryDirtyEvent(event)) return markResultsSummaryDirty(next, event);

  next.lastKnownGood = compactClusterSnapshot({
    gpu: next.gpu,
    schedulerStates: next.schedulerStates,
    experimentTraces: next.experimentTraces,
    diagnostics: next.diagnostics as Record<string, unknown>,
  });
  return compactRealtimeState(next, options);
}

export function compactRealtimeLogs(
  logs: RealtimeState["logs"],
  limit = REALTIME_LOG_RECORD_LIMIT,
  textLimit = REALTIME_LOG_TEXT_LIMIT,
  protectedKeys: string[] = [],
): RealtimeState["logs"] {
  const entries = Object.entries(logs || {})
    .map(([key, value]) => [key, compactRealtimeLogValue(value, textLimit)])
    .sort((a, b) => logRecordTime(b[1]) - logRecordTime(a[1]) || String(a[0]).localeCompare(String(b[0])));
  const protectedSet = new Set((protectedKeys || []).map((key) => String(key || "").trim()).filter(Boolean));
  if (!protectedSet.size) return Object.fromEntries(entries.slice(0, limit));
  const protectedEntries = entries.filter(([key]) => protectedSet.has(key)).slice(0, limit);
  const selectedKeys = new Set(protectedEntries.map(([key]) => key));
  for (const [key] of entries) {
    if (selectedKeys.size >= limit) break;
    selectedKeys.add(key);
  }
  return Object.fromEntries(entries.filter(([key]) => selectedKeys.has(key)));
}

function compactRealtimeLogValue(value: unknown, textLimit: number): Record<string, unknown> {
  if (typeof value === "string") return { text: clipLogText(value, textLimit), seq: 0 };
  const item = objectRecord(value);
  const offset = numberFromUnknown(item.offset);
  const updatedAt = stringValue(item.updatedAt) || stringValue(item.updated_at) || stringValue(item.generatedAt) || stringValue(item.generated_at);
  return {
    ...item,
    text: clipLogText(firstLogText(item), textLimit),
    ...(offset === undefined ? {} : { offset }),
    seq: numberFromUnknown(item.seq) || 0,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function firstLogText(item: Record<string, unknown>): string {
  for (const key of ["text", "output", "tail", "log", "stdout", "stderr"]) {
    const value = item[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function clipLogText(text: string, limit: number): string {
  if (!text || text.length <= limit) return text || "";
  return `[已截断较早日志 ${text.length - limit} 字符]\n${text.slice(-limit)}`;
}

function logRecordTime(item: Record<string, unknown>): number {
  const parsed = Date.parse(String(item.updatedAt || ""));
  return Number.isFinite(parsed) ? parsed : Number(item.seq || item.offset || 0);
}

function markResultsSummaryDirty(state: RealtimeState, event: RealtimeEvent): RealtimeState {
  const next: RealtimeState = {
    ...state,
    resultSummaryDirtySeq: event.seq,
    resultSummaryDirtyAt: event.generatedAt,
    resultSummaryDirtyType: event.type,
    resultSummaryDirtyKey: resultSummaryDirtyKey(event),
    resultSummaryDirtyPlanFile: resultSummaryDirtyPlanFile(event),
  };
  next.lastKnownGood = compactClusterSnapshot({
    gpu: next.gpu,
    schedulerStates: next.schedulerStates,
    experimentTraces: next.experimentTraces,
    diagnostics: next.diagnostics as Record<string, unknown>,
  });
  return compactRealtimeState(next);
}

function shouldAcceptDirtyEvent(state: RealtimeState, event: RealtimeEvent): boolean {
  if (resultSummaryDirtyKey(event) === state.resultSummaryDirtyKey) return false;
  const incomingAt = Date.parse(event.generatedAt || "");
  const currentAt = Date.parse(state.resultSummaryDirtyAt || "");
  if (!Number.isFinite(currentAt)) return true;
  return Number.isFinite(incomingAt) && incomingAt >= currentAt;
}

function resultSummaryDirtyKey(event: RealtimeEvent): string {
  return `${event.source}:${event.type}:${event.seq}:${event.generatedAt}:${resultSummaryDirtyPlanFile(event) || ""}`;
}

function resultSummaryDirtyPlanFile(event: RealtimeEvent): string {
  const payload = objectRecord(event.payload);
  const direct = stringValue(payload.planFile || payload.plan || payload.selectedPlanId || payload.plan_file || "");
  if (direct) return normalizePlanPath(direct);
  if (event.type === "file_changed") {
    return planFileFromResultPath(String(payload.path || payload.file || payload.relativePath || payload.relPath || payload.remotePath || ""));
  }
  if (event.type === "scheduler_snapshot") {
    const states = Array.isArray(event.payload) ? event.payload : payload.schedulerStates || payload.scheduler_states || payload.scheduler || payload.rows || [];
    const plans = states.flatMap((state: unknown) => {
      const plan = stringValue(objectRecord(state).planFile || objectRecord(state).plan || objectRecord(state).plan_file || "");
      return plan ? [normalizePlanPath(plan)] : [];
    });
    const unique = Array.from(new Set(plans.filter(Boolean)));
    return unique.length === 1 ? unique[0] : "";
  }
  return "";
}

function planFileFromResultPath(value: string): string {
  const normalized = normalizePlanPath(value);
  const marker = "simple_cluster/results/by_plan/";
  const index = normalized.toLowerCase().indexOf(marker);
  if (index < 0) return "";
  const slug = (normalized.slice(index + marker.length).split("/")[0] || "").trim();
  const candidate = slug.replace(/___/g, "/").replace(/__/g, "/").replace(/_/g, "/");
  return /\.(ya?ml|json)$/i.test(candidate) ? normalizePlanPath(candidate) : "";
}

function normalizePlanPath(value: string): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function isResultSummaryDirtyEvent(event: RealtimeEvent): boolean {
  if (resultSummaryDirtyTypes.has(event.type)) return true;
  if (event.type !== "file_changed") return false;
  const payload = objectRecord(event.payload);
  return isResultFilePath(String(payload.path || payload.file || payload.relativePath || ""));
}

function isResultFilePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (!normalized) return false;
  const name = normalized.split("/").pop() || normalized;
  if (resultFileNames.has(name) || resultTextNames.has(name) || name.endsWith(".metrics.json")) return true;
  if (resultRootPrefixes.some((prefix) => normalized.startsWith(prefix))) return /\.(csv|json|txt|log|out)$/.test(normalized);
  if (resultDirectorySegments.some((segment) => normalized.includes(segment))) return /\.(csv|json|txt|log|out)$/.test(normalized);
  return false;
}

function isTerminalOperation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const status = String(item.status || item.state || item.type || "").toLowerCase();
  return ["completed", "failed", "cancelled", "canceled"].some((terminal) => status.includes(terminal));
}

function isTerminalOperationType(type: RealtimeEventType): boolean {
  return type === "operation_completed" || type === "operation_failed";
}

// 定案：取消 stale 终态。超 grace 的 running 操作不再提升为 terminal stale，保持 running + staleReason 提示，
// 由用户自行判断、手动中止/清理；STALE 阈值仅作提示。终态操作永不触碰。
export function isStaleRunningOperation(operation: unknown, options: { startedAtMs?: number; staleAfterMs?: number; nowMs?: number } = {}): boolean {
  if (isTerminalOperation(operation)) return false;
  const item = (operation && typeof operation === "object" ? operation : {}) as Record<string, unknown>;
  const status = String(item.status || item.state || "").trim().toLowerCase();
  if (status && status !== "running" && status !== "accepted" && status !== "queued" && status !== "submitted") return false;
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? 15 * 60 * 1000;
  const startedAtMs = options.startedAtMs ?? Date.parse(String(item.startedAt || item.createdAt || item.updatedAt || ""));
  if (!Number.isFinite(startedAtMs)) return false;
  return nowMs - startedAtMs > staleAfterMs;
}

// Apply the stale-running watchdog to a map of operations, preserving terminal
// states. `snapshotSchedulerPlanFiles` lets callers additionally flag operations
// whose plan has no scheduler state in the latest snapshot.
export function reconcileStaleRunningOperations(
  operations: Record<string, unknown>,
  options: { snapshotSchedulerPlanFiles?: Set<string>; staleAfterMs?: number; nowMs?: number } = {},
): Record<string, unknown> {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? 15 * 60 * 1000;
  const planFiles = options.snapshotSchedulerPlanFiles;
  const out: Record<string, unknown> = {};
  for (const [id, op] of Object.entries(operations || {})) {
    if (isTerminalOperation(op) || !isStaleRunningOperation(op, { staleAfterMs, nowMs })) {
      out[id] = op;
      continue;
    }
    const item = (op && typeof op === "object" ? op : {}) as Record<string, unknown>;
    const planFile = String(item.planFile || item.plan || "");
    const noSchedulerState = !!planFiles && planFiles.size > 0 && !!planFile && !planFiles.has(planFile);
    out[id] = {
      ...item,
      status: "running",
      staleReason: noSchedulerState ? "no_scheduler_state_in_snapshot" : "running_exceeded_grace",
      staleHint: "长时间无进展，未自动终结；请用户自行判断，必要时手动中止/清理。",
      reconciledAt: new Date(nowMs).toISOString(),
    };
  }
  return out;
}

export function compactRealtimeState(state: RealtimeState, options: { protectedLogKeys?: string[] } = {}): RealtimeState {
  return {
    ...state,
    schedulerStates: compactSchedulerRows(state.schedulerStates),
    experimentTraces: compactRows(state.experimentTraces, REALTIME_TRACE_RECORD_LIMIT, genericRowKey, genericRowRank, genericRowTime),
    logs: compactRealtimeLogs(state.logs, REALTIME_LOG_RECORD_LIMIT, REALTIME_LOG_TEXT_LIMIT, options.protectedLogKeys || []),
    operations: compactRecord(state.operations, REALTIME_OPERATION_RECORD_LIMIT, realtimeRecordRank, realtimeRecordTime),
    fileTransfers: compactRecord(state.fileTransfers, REALTIME_FILE_TRANSFER_RECORD_LIMIT, realtimeRecordRank, realtimeRecordTime),
    workerTasks: compactWorkerTasks(state.workerTasks),
    warnings: state.warnings.slice(-50),
    lastKnownGood: compactClusterSnapshot(state.lastKnownGood),
  };
}

export function compactClusterSnapshot(snapshot?: ClusterSnapshot): ClusterSnapshot | undefined {
  if (!snapshot) return undefined;
  const schedulerStates = compactSchedulerRows(snapshot.schedulerStates || []);
  const experimentTraces = compactRows(snapshot.experimentTraces || [], REALTIME_TRACE_RECORD_LIMIT, genericRowKey, genericRowRank, genericRowTime);
  const operations = compactRecord(operationsRecord(snapshot.operations), REALTIME_OPERATION_RECORD_LIMIT, realtimeRecordRank, realtimeRecordTime);
  if (schedulerStates === snapshot.schedulerStates && experimentTraces === snapshot.experimentTraces && snapshot.operations === undefined) return snapshot;
  return {
    ...snapshot,
    schedulerStates,
    experimentTraces,
    ...(Object.keys(operations).length ? { operations: Object.values(operations) } : {}),
  };
}

const schedulerBucketKeys = [
  "running_experiments", "testing_experiments", "queued_experiments", "pending_experiments", "failed_experiments", "stopped_experiments", "completed_experiments",
];

function compactSchedulerRows(rows: unknown[]): unknown[] {
  const input = Array.isArray(rows) ? rows : [];
  if (!input.length) return [];
  const hasBuckets = input.some((row) => row && typeof row === "object" && schedulerBucketKeys.some((key) => Array.isArray((row as Record<string, unknown>)[key])));
  if (!hasBuckets) return compactRows(input, REALTIME_SCHEDULER_RECORD_LIMIT, genericRowKey, genericRowRank, genericRowTime);
  const needsCompaction = input.length > 16 || input.some((row) => row && typeof row === "object" && schedulerBucketKeys.some((key) => {
    const bucket = (row as Record<string, unknown>)[key];
    const limit = key === "completed_experiments" ? 80 : 160;
    return Array.isArray(bucket) && bucket.length > limit;
  }));
  if (!needsCompaction) return input;
  return input.slice(-16).map((row) => {
    if (!row || typeof row !== "object") return row;
    const item = row as Record<string, unknown>;
    const out = { ...item };
    for (const key of schedulerBucketKeys) {
      if (!Array.isArray(item[key])) continue;
      const limit = key === "completed_experiments" ? 80 : 160;
      const compacted = compactRows(item[key], limit, genericRowKey, genericRowRank, genericRowTime);
      out[key] = compacted;
      if (item[key].length > compacted.length) out[`${key}_omitted`] = item[key].length - compacted.length;
    }
    return out;
  });
}

function compactWorkerTasks(tasks?: Record<string, unknown[]>): Record<string, unknown[]> {
  const source = tasks || {};
  if (Object.values(source).every((rows) => Array.isArray(rows) && rows.length <= REALTIME_WORKER_TASK_RECORD_LIMIT)) return source;
  const out: Record<string, unknown[]> = {};
  for (const [workerId, rows] of Object.entries(source)) {
    out[workerId] = compactRows(rows, REALTIME_WORKER_TASK_RECORD_LIMIT, genericRowKey, genericRowRank, genericRowTime);
  }
  return out;
}

function compactRows(rows: unknown[], limit: number, keyOf: (row: unknown) => string, rankOf: (row: unknown) => number, timeOf: (row: unknown) => number): unknown[] {
  const input = Array.isArray(rows) ? rows : [];
  if (input.length <= limit) return input;
  const map = new Map<string, unknown>();
  input.forEach((row, index) => {
    const key = keyOf(row) || `row-${index}`;
    map.set(key, { ...(map.get(key) as object || {}), ...(row as object) });
  });
  return [...map.values()].sort((a, b) => rankOf(a) - rankOf(b) || timeOf(b) - timeOf(a)).slice(0, limit);
}

function compactRecord(record: Record<string, unknown> | undefined, limit: number, rankOf: (row: unknown) => number, timeOf: (row: unknown) => number): Record<string, unknown> {
  const entries = Object.entries(record || {});
  if (entries.length <= limit) return record || {};
  return Object.fromEntries([...entries].sort((a, b) => rankOf(a[1]) - rankOf(b[1]) || timeOf(b[1]) - timeOf(a[1])).slice(0, limit));
}

function operationsRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (!Array.isArray(value)) return value as Record<string, unknown>;
  return Object.fromEntries(value.map((item, index) => {
    const row = objectRecord(item);
    return [String(row.operationId || row.operation_id || row.opId || row.id || `operation-${index}`), item];
  }));
}

function mergeSnapshotOperations(current: Record<string, unknown>, incoming?: Record<string, unknown>): Record<string, unknown> {
  if (!incoming) return current || {};
  const merged = { ...(current || {}) };
  for (const [operationId, operation] of Object.entries(incoming)) {
    if (isTerminalOperation(merged[operationId]) && !isTerminalOperation(operation)) continue;
    merged[operationId] = operation;
  }
  return merged;
}

function realtimeRecordRank(row: unknown): number {
  return realtimeRecordStatusRanks.get(genericStatus(row)) ?? 2;
}

function genericRowRank(row: unknown): number {
  return genericRowStatusRanks.get(genericStatus(row)) ?? 2;
}

function genericStatus(row: unknown): string {
  if (!row || typeof row !== "object") return "";
  return stringFromRecord(row as Record<string, unknown>, ["status", "state", "type", "runStatus", "run_status", "archiveStatus", "archive_status", "deleteStatus", "delete_status"]).toLowerCase();
}

function genericRowKey(row: unknown): string {
  if (!row || typeof row !== "object") return "";
  return stringFromRecord(row as Record<string, unknown>, [
    "runKey", "run_key", "experimentId", "experiment_id", "archiveKey", "archive_key", "operationId", "operation_id", "opId", "jobId", "job_id",
    "taskId", "task_id", "session", "id", "key",
  ]);
}

function realtimeRecordTime(row: unknown): number {
  return genericRowTime(row);
}

function genericRowTime(row: unknown): number {
  if (!row || typeof row !== "object") return 0;
  const item = row as Record<string, unknown>;
  const raw = stringFromRecord(item, ["updatedAt", "updated_at", "generatedAt", "generated_at", "finishedAt", "finished_at", "startedAt", "started_at", "createdAt", "created_at", "lastSeenAt", "last_seen_at"]);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number(item.seq || item.index || 0);
}

function stringFromRecord(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

export function applySnapshot(state: RealtimeState, snapshot: ClusterSnapshot, options: { protectedLogKeys?: string[] } = {}): RealtimeState {
  const compactSnapshot = compactClusterSnapshot(snapshot);
  return compactRealtimeState({
    ...state,
    gpu: compactSnapshot?.gpu || state.gpu,
    schedulerStates: compactSnapshot?.schedulerStates || state.schedulerStates,
    experimentTraces: compactSnapshot?.experimentTraces || state.experimentTraces,
    operations: mergeSnapshotOperations(state.operations, operationsRecord(compactSnapshot?.operations)),
    diagnostics: compactSnapshot?.diagnostics || state.diagnostics,
    lastKnownGood: compactSnapshot,
  }, options);
}

function mergeByKey(previous: unknown[], incoming: unknown[], seq: number): unknown[] {
  const map = new Map<string, unknown>();
  for (const row of previous || []) map.set(rowKey(row), row);
  for (const row of incoming || []) {
    const item = { ...(row as object), seq };
    map.set(rowKey(item), { ...(map.get(rowKey(item)) as object || {}), ...item });
  }
  return [...map.values()];
}

function rowKey(row: unknown): string {
  const item = row as Record<string, unknown>;
  return String(item.runKey || item.run_key || item.experimentId || item.experiment_id || item.id || JSON.stringify(row));
}

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function numberFromUnknown(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
