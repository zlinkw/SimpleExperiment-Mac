import { NamedTunnelEndpointConfig } from "./MultiEndpointRealtimeClient";
import { compactRealtimeLogs, compactRealtimeState, RealtimeState, createRealtimeState } from "./RealtimeEventReducer";
import { WorkerTaskTelemetry } from "./WorkerTelemetryApi";

export interface AuthorityMergePolicy {
  gpu: "worker_direct";
  workerHealth: "worker_direct";
  workerTasks: "worker_direct_enrichment";
  scheduler: "worker_direct";
  experimentTraces: "worker_direct";
  operations: "worker_direct";
  fileTransfers: "worker_direct";
  files: "worker_direct";
  results: "worker_direct";
  logs: "selected_worker";
}

export const defaultAuthorityMergePolicy: AuthorityMergePolicy = {
  gpu: "worker_direct",
  workerHealth: "worker_direct",
  workerTasks: "worker_direct_enrichment",
  scheduler: "worker_direct",
  experimentTraces: "worker_direct",
  operations: "worker_direct",
  fileTransfers: "worker_direct",
  files: "worker_direct",
  results: "worker_direct",
  logs: "selected_worker",
};

export interface AuthorityMergeOptions {
  staleWorkerTelemetrySeconds?: number;
  now?: string;
  selectedLogRunKey?: string;
  protectedLogKeys?: string[];
}

export interface AuthorityStateEntry {
  endpoint: NamedTunnelEndpointConfig;
  state: RealtimeState;
}

const terminalStatuses = new Set(["completed", "failed", "deleted", "archived", "stopped"]);

export function mergeAuthorityRealtimeStates(
  entries: AuthorityStateEntry[],
  options: AuthorityMergeOptions = {},
): RealtimeState {
  const staleSeconds = options.staleWorkerTelemetrySeconds ?? 180;
  const nowMs = Date.parse(options.now || new Date().toISOString());
  const protectedKeys = protectedLogKeys(options);
  const workerEntries: AuthorityStateEntry[] = [];
  const merged = createRealtimeState();
  const warnings: string[] = [];

  for (const entry of entries.filter(row => row.endpoint.role === "worker")) {
    workerEntries.push(entry);
    merged.lastSeq = Math.max(merged.lastSeq, entry.state.lastSeq);
    merged.lastHeartbeatAt = latestTimestamp(merged.lastHeartbeatAt, entry.state.lastHeartbeatAt);
    if (newerResultSummaryDirty(entry.state, merged)) {
      merged.resultSummaryDirtySeq = entry.state.resultSummaryDirtySeq;
      merged.resultSummaryDirtyAt = entry.state.resultSummaryDirtyAt;
      merged.resultSummaryDirtyType = entry.state.resultSummaryDirtyType;
      merged.resultSummaryDirtyKey = entry.state.resultSummaryDirtyKey;
      merged.resultSummaryDirtyPlanFile = entry.state.resultSummaryDirtyPlanFile;
    }
  }


  const workerTasks: WorkerTaskTelemetry[] = [];
  for (const entry of workerEntries) {
    const fresh = isFresh(entry.state.lastHeartbeatAt, nowMs, staleSeconds);
    if (fresh) Object.assign(merged.gpu, markGpuSource(remapWorkerGpu(entry.state.gpu, entry.endpoint.id), entry.endpoint.id, true));
    else if (Object.keys(entry.state.gpu).length) warnings.push(`Worker ${entry.endpoint.id} 状态已过期，请主动刷新。`);
    for (const row of Object.values(entry.state.workerTasks || {}).flat()) {
      workerTasks.push(normalizeWorkerTask(row, entry.endpoint.id));
    }
    Object.assign(merged.workerHealth ||= {}, entry.state.workerHealth || {});
    merged.logs = mergeLogs(merged.logs, entry.state.logs, protectedKeys);
    if (entry.state.diagnostics) mergeEndpointDiagnostics(merged, entry.endpoint.id, entry.state.diagnostics);
    merged.schedulerStates = mergeRows(merged.schedulerStates, entry.state.schedulerStates.map(row => ({ ...(row as object), workerId: entry.endpoint.id })));
    merged.experimentTraces = mergeRows(merged.experimentTraces, entry.state.experimentTraces.map(row => ({ ...(row as object), workerId: entry.endpoint.id })));
    for (const [key, row] of Object.entries(entry.state.operations)) merged.operations[entry.endpoint.id + ":" + key] = { ...(row as object), workerId: entry.endpoint.id };
    for (const [key, row] of Object.entries(entry.state.fileTransfers)) merged.fileTransfers[entry.endpoint.id + ":" + key] = { ...(row as object), workerId: entry.endpoint.id };
    warnings.push(...entry.state.warnings.map((warning) => `${entry.endpoint.id}: ${warning}`));
  }

  const workerTasksByRunKey = indexWorkerTasks(workerTasks);
  merged.schedulerStates = enrichSchedulerRows(merged.schedulerStates, workerTasks, warnings, workerTasksByRunKey);
  merged.experimentTraces = enrichTraceRows(merged.experimentTraces, workerTasksByRunKey);
  merged.workerTasks = groupWorkerTasks(workerTasks);
  merged.warnings = warnings.slice(-50);
  merged.lastKnownGood = {
    gpu: merged.gpu,
    schedulerStates: merged.schedulerStates,
    experimentTraces: merged.experimentTraces,
    diagnostics: merged.diagnostics as Record<string, unknown>,
  };
  return compactRealtimeState(merged, { protectedLogKeys: protectedKeys });
}

export function enrichSchedulerRows(
  rows: unknown[],
  workerTasks: WorkerTaskTelemetry[],
  warnings: string[] = [],
  byRunKey: ReadonlyMap<string, WorkerTaskTelemetry> = indexWorkerTasks(workerTasks),
): unknown[] {
  return (rows || []).map((row) => {
    const item = { ...(row as object) } as Record<string, unknown>;
    const runKey = String(item.runKey || item.run_key || "");
    const task = byRunKey.get(runKey);
    if (!task) return item;
    const status = String(item.status || item.state || item.runStatus || "").toLowerCase();
    const warning = liveStatusWarning(status, task.localStatus);
    if (warning) warnings.push(`${runKey}: ${warning}`);
    return Object.assign(item, {
      workerLiveStatus: task.localStatus,
      workerPid: task.pid,
      workerGpuIds: task.gpuIds,
      workerLastSeenAt: task.lastSeenAt,
      workerTelemetryWarning: warning,
    });
  });
}

export function workerTelemetryCannotOverrideTerminal(hubRow: unknown, workerTask: WorkerTaskTelemetry): unknown {
  const row = hubRow as Record<string, unknown>;
  const status = String(row.status || row.state || "").toLowerCase();
  if (!terminalStatuses.has(status)) return { ...row, workerLiveStatus: workerTask.localStatus };
  return {
    ...row,
    workerLiveStatus: workerTask.localStatus,
    workerTelemetryWarning: liveStatusWarning(status, workerTask.localStatus),
  };
}

function enrichTraceRows(rows: unknown[], byRunKey: ReadonlyMap<string, WorkerTaskTelemetry>): unknown[] {
  return (rows || []).map((row) => {
    const item = { ...(row as object) } as Record<string, unknown>;
    const runKey = String(item.runKey || item.run_key || item.id || "");
    const task = byRunKey.get(runKey);
    return task ? Object.assign(item, { localPid: task.pid, gpuIds: task.gpuIds || item.gpuIds, liveStatus: task.localStatus, lastSeenAt: task.lastSeenAt }) : item;
  });
}

function indexWorkerTasks(tasks: WorkerTaskTelemetry[]): ReadonlyMap<string, WorkerTaskTelemetry> {
  const byRunKey = new Map<string, WorkerTaskTelemetry>();
  for (const task of tasks) if (task.runKey) byRunKey.set(task.runKey, task);
  return byRunKey;
}

function liveStatusWarning(hubStatus: string, workerStatus: WorkerTaskTelemetry["localStatus"]): string | undefined {
  if (terminalStatuses.has(hubStatus) && workerStatus === "pid_alive") return "Scheduler completed, but Worker still detects a process; run self-check.";
  if ((hubStatus === "running" || hubStatus === "testing") && workerStatus === "process_gone") return "Scheduler running, but Worker does not detect the process.";
  return undefined;
}

function normalizeWorkerTask(value: unknown, fallbackWorkerId: string): WorkerTaskTelemetry {
  const item = value as Partial<WorkerTaskTelemetry> & Record<string, unknown>;
  return {
    schemaVersion: 1,
    workerId: String(item.workerId || item.worker_id || fallbackWorkerId),
    runKey: stringValue(item.runKey || item.run_key),
    experimentId: stringValue(item.experimentId || item.experiment_id),
    localStatus: normalizeLocalStatus(item.localStatus || item.local_status),
    pid: numberValue(item.pid),
    gpuIds: Array.isArray(item.gpuIds) ? item.gpuIds.map(String) : Array.isArray(item.gpu_ids) ? item.gpu_ids.map(String) : undefined,
    gpuProcessInfo: Array.isArray(item.gpuProcessInfo) ? item.gpuProcessInfo as WorkerTaskTelemetry["gpuProcessInfo"] : undefined,
    logPath: stringValue(item.logPath || item.log_path),
    logOffset: numberValue(item.logOffset || item.log_offset),
    lastSeenAt: stringValue(item.lastSeenAt || item.last_seen_at) || new Date(0).toISOString(),
  };
}

function normalizeLocalStatus(value: unknown): WorkerTaskTelemetry["localStatus"] {
  const text = String(value || "unknown");
  return text === "pid_alive" || text === "process_gone" || text === "gpu_process_alive" || text === "log_updating" ? text : "unknown";
}

function groupWorkerTasks(tasks: WorkerTaskTelemetry[]): Record<string, WorkerTaskTelemetry[]> {
  const out: Record<string, WorkerTaskTelemetry[]> = {};
  for (const task of tasks) (out[task.workerId] ||= []).push(task);
  return out;
}

function remapWorkerGpu(gpu: Record<string, unknown[]>, workerId: string): Record<string, unknown[]> {
  if (Array.isArray(gpu)) return { [workerId]: gpu };
  const out: Record<string, unknown[]> = {};
  for (const [key, rows] of Object.entries(gpu || {})) {
    out[key === "hub" ? workerId : key] = Array.isArray(rows) ? rows : [];
  }
  return out;
}

function markGpuSource(gpu: Record<string, unknown[]>, source: string, direct: boolean): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [serverId, rows] of Object.entries(gpu || {})) {
    out[serverId] = (rows || []).map((row) => row && typeof row === "object" ? { ...(row as object), telemetrySource: source, workerDirect: direct } : row);
  }
  return out;
}

function mergeRows(previous: unknown[], incoming: unknown[]): unknown[] {
  const map = new Map<string, unknown>();
  for (const row of previous || []) map.set(rowKey(row), row);
  for (const row of incoming || []) {
    const key = rowKey(row);
    map.set(key, { ...(map.get(key) as object || {}), ...(row as object) });
  }
  return [...map.values()];
}

function mergeLogs(base: RealtimeState["logs"], incoming: RealtimeState["logs"], protectedKeys: string[] = []): RealtimeState["logs"] {
  if (!protectedKeys.length) return compactRealtimeLogs({ ...base, ...incoming });
  const selectedIncoming = Object.fromEntries(protectedKeys.filter((key) => incoming[key]).map((key) => [key, incoming[key]]));
  return compactRealtimeLogs({ ...base, ...selectedIncoming }, undefined, undefined, protectedKeys);
}

function mergeEndpointDiagnostics(state: RealtimeState, endpointId: string, diagnostics: unknown): void {
  const merged = state.diagnostics && typeof state.diagnostics === "object" ? state.diagnostics as Record<string, unknown> : {};
  merged[endpointId] = diagnostics;
  state.diagnostics = merged;
}

function protectedLogKeys(options: AuthorityMergeOptions): string[] {
  return [...new Set([options.selectedLogRunKey, ...(options.protectedLogKeys || [])].map((value) => String(value || "").trim()).filter(Boolean))];
}

function rowKey(row: unknown): string {
  const item = row as Record<string, unknown>;
  return String(item.workerId || "") + ":" + String(item.runKey || item.run_key || item.experimentId || item.experiment_id || item.id || item.key || JSON.stringify(row));
}

function latestTimestamp(current: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming) return current;
  return !current || incoming > current ? incoming : current;
}

function isFresh(timestamp: string | undefined, nowMs: number, staleSeconds: number): boolean {
  if (!timestamp) return false;
  const then = Date.parse(timestamp);
  return Number.isFinite(then) && nowMs >= then && nowMs - then <= staleSeconds * 1000;
}

function newerResultSummaryDirty(incoming: RealtimeState, current: RealtimeState): boolean {
  if (!incoming.resultSummaryDirtyKey && !incoming.resultSummaryDirtySeq) return false;
  if (incoming.resultSummaryDirtyKey && incoming.resultSummaryDirtyKey === current.resultSummaryDirtyKey) return false;
  const incomingAt = Date.parse(incoming.resultSummaryDirtyAt || "");
  const currentAt = Date.parse(current.resultSummaryDirtyAt || "");
  if (Number.isFinite(incomingAt) && Number.isFinite(currentAt)) return incomingAt >= currentAt;
  if (Number.isFinite(incomingAt)) return true;
  return (incoming.resultSummaryDirtySeq || 0) > (current.resultSummaryDirtySeq || 0);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
