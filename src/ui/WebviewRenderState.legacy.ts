const TASK_STATUS_RANKS: Readonly<Record<string, number>> = Object.freeze({
  running: 0,
  testing: 1,
  queued: 2,
  pending: 2,
  failed: 3,
  completed: 4,
  done: 4,
  stopped: 5,
  unknown: 6,
});

const SCHEDULER_BUCKET_STATUSES: Readonly<Record<string, string>> = Object.freeze({
  queued_experiments: "queued",
  pending_experiments: "queued",
  running_experiments: "running",
  testing_experiments: "testing",
  completed_experiments: "completed",
  failed_experiments: "failed",
  stopped_experiments: "stopped",
});

const SCHEDULER_BUCKETS: readonly string[] = Object.freeze(Object.keys(SCHEDULER_BUCKET_STATUSES));

export function pick<T = unknown>(obj: unknown, keys: string[], fallback: T): T {
  if (!obj || typeof obj !== "object") return fallback;
  const item = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = item[key];
    if (value !== undefined && value !== null && value !== "") return value as T;
  }
  return fallback;
}

export function selectWebviewStateFields(sources: unknown): Record<string, unknown> {
  const input = objectRecord(sources);
  const realtime = objectRecord(input.realtimeState);
  const snapshot = objectRecord(input.lastSnapshot);
  const offline = objectRecord(input.offlineSnapshot);
  return {
    gpu: firstNonEmptyRecord(realtime.gpu, snapshot.gpu, offline.gpu),
    schedulerStates: firstNonEmptyArray(realtime.schedulerStates, snapshot.schedulerStates, offline.schedulerStates),
    experimentTraces: firstNonEmptyArray(realtime.experimentTraces, snapshot.experimentTraces, offline.experimentTraces),
    logs: firstNonEmptyRecord(realtime.logs, snapshot.logs, offline.logs),
    operations: firstNonEmptyRecord(realtime.operations, snapshot.operations, offline.operations),
    fileTransfers: firstNonEmptyRecord(realtime.fileTransfers, snapshot.fileTransfers, offline.fileTransfers),
  };
}

function isNumericGpuId(value: unknown): boolean {
  return /^\d+$/.test(String(value ?? "").trim());
}
function extractNumericGpuId(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!s || s === "-") return "";
  if (/^\d+$/.test(s)) return s;
  const gpuPrefixed = s.match(/(?:gpu|GPU)[-_]?(\d+)\b/);
  if (gpuPrefixed) return gpuPrefixed[1];
  const anyNum = s.match(/\b(\d+)\b/);
  if (anyNum && Number(anyNum[1]) < 64) return anyNum[1];
  return "";
}
function normalizeGpuDisplayIndex(row: unknown): string {
  const rawIndex = pick(row, ["index", "gpu_index"], "");
  const rawIndexStr = String(rawIndex ?? "").trim();
  if (rawIndexStr && rawIndexStr !== "-" && isNumericGpuId(rawIndexStr)) return rawIndexStr;
  if (rawIndexStr && rawIndexStr !== "-") {
    const extracted = extractNumericGpuId(rawIndexStr);
    if (extracted) return extracted;
  }
  const fallbackCandidates = [pick(row, ["gpuId", "gpu_id", "id"], ""), pick(row, ["uuid"], "")];
  for (const cand of fallbackCandidates) {
    const extracted = extractNumericGpuId(cand);
    if (extracted) return extracted;
  }
  return rawIndexStr || "-";
}
function normalizeGpuDisplayId(row: unknown): string {
  const rawId = pick(row, ["id", "gpuId", "gpu_id", "uuid"], "-");
  const s = String(rawId ?? "").trim();
  if (!s || s === "-") return "-";
  if (isNumericGpuId(s)) return s;
  const extracted = extractNumericGpuId(s);
  if (extracted) return extracted;
  return s;
}
export function normalizeGpuRow(row: unknown): Record<string, unknown> {
  const memoryUsedMb = numberOrUndefined(pick(row, ["memoryUsedMb", "memory_used_mb", "memoryUsed", "used"], undefined));
  const memoryTotalMb = numberOrUndefined(pick(row, ["memoryTotalMb", "memory_total_mb", "memoryTotal", "total"], undefined));
  return {
    index: normalizeGpuDisplayIndex(row),
    name: pick(row, ["name", "gpu_name", "model"], "-"),
    memoryUsedMb,
    memoryTotalMb,
    memoryPercent: percent(memoryUsedMb, memoryTotalMb),
    utilizationPercent: numberOrUndefined(pick(row, ["utilizationPercent", "utilization", "gpu_util", "utilization_gpu"], undefined)),
    temperature: numberOrUndefined(pick(row, ["temperature", "temperatureGpu", "temperature_gpu", "temp"], undefined)),
    processCount: normalizeArray(pick(row, ["processes", "procs"], [])).length,
    runKey: pick(row, ["runKey", "run_key", "assignedRunKey", "experiment", "experimentId"], "-"),
  };
}

export function normalizeServerGpu(serverId: string, rows: unknown): Record<string, unknown> {
  const sourceRows = Array.isArray(rows) ? rows : normalizeArray(pick(rows, ["gpus", "gpu", "rows"], []));
  const gpuRows = sourceRows.map(normalizeGpuRow);
  return {
    serverId,
    workerId: pick(rows, ["workerId", "worker_id", "worker"], serverId),
    gpuRows,
    gpuCount: gpuRows.length,
    status: pick(rows, ["status", "state"], gpuRows.length ? "online" : "stale"),
    updatedAt: pick(rows, ["generatedAt", "generated_at", "updatedAt", "updated_at", "timestamp"], "-"),
  };
}

export function normalizeSchedulerRows(rows: unknown): Array<Record<string, unknown>> {
  return normalizeArray(rows)
    .flatMap((row) => expandSchedulerRow(row))
    .map((row, index) => normalizeTaskRow(row, index))
    .filter((row) => row.status !== "deleted")
    .sort((a, b) => taskStatusRank(String(a.status)) - taskStatusRank(String(b.status)) || String(a.uiKey || "").localeCompare(String(b.uiKey || "")));
}

export function normalizeTaskRow(row: unknown, index = 0): Record<string, unknown> {
  const startedAt = pick(row, ["startedAt", "started_at"], "");
  const updatedAt = pick(row, ["updatedAt", "updated_at", "finishedAt", "finished_at"], "");
  const status = String(pick(row, ["status", "state", "runStatus", "run_status"], "unknown")).toLowerCase();
  const experimentId = pick(row, ["experimentId", "experiment_id", "id", "jobId", "job_id", "taskId", "task_id", "global_job_id", "session"], "-");
  const archiveKey = pick(row, ["archiveKey", "archive_key", "artifactKey", "artifact_key", "global_job_id", "session", "hub_job_dir", "worker_job_dir", "native_job_dir", "artifactPath", "artifact_path"], experimentId);
  const normalized: Record<string, unknown> = {
    status,
    plan: pick(row, ["planName", "plan_name", "plan", "suite", "file"], "-"),
    experimentName: pick(row, ["experimentName", "experiment_name", "name", "case", "experiment"], "-"),
    runKey: pick(row, ["runKey", "run_key", "runId", "run_id", "jobId", "job_id", "taskId", "task_id", "id", "experimentId", "experiment_id", "global_job_id", "session", "hub_console_log", "schedulerLog", "log_path"], "-"),
    experimentId,
    archiveKey,
    serverId: pick(row, ["serverId", "workerId", "worker_id", "worker", "server"], "-"),
    gpuIds: pick(row, ["gpuIds", "gpu_ids", "gpuId", "gpu_id"], "-"),
    startedAt: startedAt || "-",
    updatedAt: updatedAt || "-",
    duration: formatDuration(startedAt, updatedAt),
    progress: pick(row, ["progress", "epoch", "step"], "-"),
    primaryMetric: pick(row, ["primaryMetric", "primary_metric", "metric", "score"], "-"),
  };
  normalized.uiKey = taskUiKeyFromRow(normalized, index);
  return normalized;
}

function taskUiKeyFromRow(row: Record<string, unknown>, index: number): string {
  const values = [row.runKey, row.experimentId, row.archiveKey, row.plan, row.experimentName, row.serverId, row.gpuIds, row.startedAt, row.updatedAt, index]
    .map((value) => String(value || "").trim())
    .filter((value) => value && value !== "-");
  return Array.from(new Set(values)).join("|") || `task-ui-${index}`;
}

export function taskStatusRank(status: string): number {
  return TASK_STATUS_RANKS[String(status || "unknown").toLowerCase()] ?? 6;
}

export function normalizeExperimentTraceRows(rows: unknown): Array<Record<string, unknown>> {
  return normalizeArray(rows).map((row) => ({
    id: pick(row, ["id", "experimentId", "experiment_id", "runKey", "run_key"], "-"),
    status: pick(row, ["status", "state", "archiveStatus", "archive_status"], "-"),
    resultStatus: pick(row, ["resultStatus", "result_status", "parseStatus", "parse_status"], "-"),
    deleteStatus: pick(row, ["deleteStatus", "delete_status", "deleted", "residue"], "-"),
    tags: normalizeArray(pick(row, ["tags"], [])).join(", "),
    updatedAt: pick(row, ["updatedAt", "updated_at", "synced_at"], "-"),
    artifactPath: pick(row, ["artifactPath", "artifact_path", "hub_job_dir", "worker_job_dir"], "-"),
    resultPath: pick(row, ["resultPath", "result_path", "results_csv"], "-"),
  }));
}

export function normalizeOperationRows(operations: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(operations) ? operations : Object.entries((operations || {}) as Record<string, unknown>).map(([id, value]) => ({ id, ...(value as object) }));
  return rows.map((row) => {
    const payload = operationPayload(row);
    const manifest = operationPayload((row as Record<string, unknown>).archiveManifest || (row as Record<string, unknown>).syncManifest || payload.archiveManifest || payload.syncManifest);
    const threeWay = operationPayload((row as Record<string, unknown>).threeWay || payload.threeWay);
    const type = pick(row, ["type", "action"], pick(payload, ["type", "action"], "-"));
    return {
      operationId: pick(row, ["operationId", "operation_id", "opId", "id"], pick(payload, ["operationId", "operation_id", "opId", "id"], "-")),
      type,
      status: pick(row, ["status", "state"], pick(payload, ["status", "state"], operationStatusFromType(type))),
      progress: pick(row, ["progress", "percent"], "-"),
      message: pick(row, ["message", "detail"], pick(payload, ["message", "error"], "-")),
      startedAt: pick(row, ["startedAt", "started_at"], pick(payload, ["startedAt", "started_at"], "-")),
      terminalAt: pick(row, ["completedAt", "completed_at", "finishedAt", "finished_at", "cancelledAt", "cancelled_at", "failedAt", "failed_at"], pick(payload, ["completedAt", "completed_at", "finishedAt", "finished_at", "cancelledAt", "cancelled_at", "failedAt", "failed_at"], "-")),
      updatedAt: pick(row, ["updatedAt", "updated_at", "completedAt", "completed_at", "finishedAt", "finished_at", "generatedAt"], pick(payload, ["updatedAt", "updated_at", "completedAt", "completed_at", "finishedAt", "finished_at", "generatedAt"], "-")),
      error: pick(row, ["error", "lastError"], pick(payload, ["error"], "-")),
      seq: Number(pick(row, ["seq"], 0)),
      targetCount: pick(row, ["targetCount", "target_count"], pick(payload, ["targetCount", "target_count"], pick(manifest, ["targetCount", "target_count"], pick(threeWay, ["targetCount", "target_count"], "-")))),
      fileCount: pick(row, ["fileCount", "file_count"], pick(payload, ["fileCount", "file_count"], pick(manifest, ["fileCount", "file_count"], "-"))),
      deletedCount: pick(row, ["deletedCount", "deleted_count"], pick(payload, ["deletedCount", "deleted_count"], "-")),
      skippedCount: pick(row, ["skippedCount", "skipped_count"], pick(payload, ["skippedCount", "skipped_count"], "-")),
      residueCount: pick(row, ["residueCount", "residue_count"], pick(payload, ["residueCount", "residue_count"], "-")),
      missingCount: pick(row, ["missingCount", "missing_count"], pick(payload, ["missingCount", "missing_count"], pick(manifest, ["missingCount", "missing_count"], pick(threeWay, ["missingCount", "missing_count"], "-")))),
      unarchivedCount: pick(row, ["unarchivedCount", "unarchived_count"], pick(payload, ["unarchivedCount", "unarchived_count"], pick(threeWay, ["unarchivedCount", "unarchived_count"], "-"))),
      workerId: pick(row, ["workerId", "worker_id"], pick(payload, ["workerId", "worker_id"], "-")),
      manifestPath: pick(row, ["manifestPath", "archiveManifestPath", "syncManifestPath", "threeWayPath", "path"], pick(payload, ["manifestPath", "archiveManifestPath", "syncManifestPath", "threeWayPath", "path"], "-")),
    };
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || Number(b.seq) - Number(a.seq)).slice(0, 20);
}

function operationPayload(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object") return {};
  const item = row as Record<string, unknown>;
  if (item.payload && typeof item.payload === "object") return item.payload as Record<string, unknown>;
  const latest = item.latestEvent as Record<string, unknown> | undefined;
  if (latest && typeof latest === "object" && latest.payload && typeof latest.payload === "object") return latest.payload as Record<string, unknown>;
  return item;
}

export function normalizeFileTransferRows(fileTransfers: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(fileTransfers) ? fileTransfers : Object.entries((fileTransfers || {}) as Record<string, unknown>).map(([id, value]) => ({ id, ...(value as object) }));
  return rows.map((row) => {
    const transferredBytes = pick(row, ["transferredBytes", "transferred_bytes", "receivedBytes", "sentBytes", "doneBytes"], 0);
    // expectedSize is what the upload handshake reports; without it an upload has no total at all.
    const totalBytes = pick(row, ["totalBytes", "total_bytes", "expectedSize", "expected_size", "size", "bytes"], 0);
    const startedAt = pick(row, ["startedAt", "started_at"], "");
    const updatedAt = pick(row, ["updatedAt", "updated_at", "finishedAt", "finished_at"], "");
    const bytesPerSecond = transferRateBytesPerSecond(transferredBytes, startedAt, updatedAt);
    return {
      transferId: pick(row, ["transferId", "transfer_id", "id"], "-"),
      direction: pick(row, ["direction", "type"], "-"),
      remotePath: pick(row, ["remotePath", "remote_path", "path"], "-"),
      localPath: pick(row, ["localPath", "local_path"], "-"),
      status: pick(row, ["status", "state"], "-"),
      transferredBytes,
      totalBytes,
      percent: pick(row, ["percent"], percent(transferredBytes, totalBytes)),
      speed: pick(row, ["speed", "speedBytesPerSecond", "speed_bytes_per_second", "bytesPerSecond"], bytesPerSecond ?? "-"),
      eta: pick(row, ["eta", "etaSeconds", "eta_seconds"], transferEtaSeconds(transferredBytes, totalBytes, bytesPerSecond) ?? "-"),
      stalled: pick(row, ["stalled"], false),
      error: pick(row, ["error", "lastError"], "-"),
    };
  });
}

export function transferRateBytesPerSecond(transferredBytes: unknown, startedAt: unknown, updatedAt: unknown): number | undefined {
  const bytes = numberOrUndefined(transferredBytes);
  const start = Date.parse(String(startedAt || ""));
  if (bytes === undefined || bytes <= 0 || !Number.isFinite(start)) return undefined;
  const end = Date.parse(String(updatedAt || "")) || Date.now();
  const seconds = (end - start) / 1000;
  return seconds > 0 ? Math.round(bytes / seconds) : undefined;
}

export function transferEtaSeconds(transferredBytes: unknown, totalBytes: unknown, bytesPerSecond: unknown): number | undefined {
  const done = numberOrUndefined(transferredBytes);
  const total = numberOrUndefined(totalBytes);
  const rate = numberOrUndefined(bytesPerSecond);
  if (done === undefined || total === undefined || rate === undefined || rate <= 0 || total <= done) return undefined;
  return Math.max(0, Math.round((total - done) / rate));
}

export function percent(used: unknown, total: unknown): number | undefined {
  const usedNumber = numberOrUndefined(used);
  const totalNumber = numberOrUndefined(total);
  if (usedNumber === undefined || !totalNumber) return undefined;
  return Math.round((usedNumber / totalNumber) * 1000) / 10;
}

export function formatDuration(startedAt: unknown, updatedAt: unknown): string {
  const start = Date.parse(String(startedAt || ""));
  const end = Date.parse(String(updatedAt || "")) || Date.now();
  if (!Number.isFinite(start)) return "-";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

function expandSchedulerRow(row: unknown): unknown[] {
  if (!row || typeof row !== "object") return [];
  const item = row as Record<string, unknown>;
  const parentPlanFile = item.planFile || item.plan_file || item.planPath || item.plan_path || item.file || item.path || item.plan;
  const expanded = SCHEDULER_BUCKETS.flatMap((key) => normalizeArray(item[key]).map((child) => {
    const childRecord = child && typeof child === "object" ? child as Record<string, unknown> : {};
    return { ...childRecord, status: bucketStatus(key), plan: item.plan || item.planName || item.suite || item.file, planFile: childRecord.planFile || childRecord.plan_file || childRecord.file || childRecord.path || parentPlanFile };
  }));
  return expanded.length ? expanded : [row];
}

function bucketStatus(bucket: string): string {
  return SCHEDULER_BUCKET_STATUSES[bucket] ?? bucket.replace("_experiments", "").replace("pending", "queued");
}

function operationStatusFromType(type: unknown): string {
  const value = String(type || "");
  if (value.includes("completed")) return "completed";
  if (value.includes("failed")) return "failed";
  if (value.includes("cancelled") || value.includes("canceled")) return "cancelled";
  if (value.includes("stalled")) return "stalled";
  if (value.includes("started") || value.includes("progress")) return "running";
  return "-";
}

function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>);
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstNonEmptyRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const record = objectRecord(value);
    if (Object.keys(record).length) return record;
  }
  return {};
}

function firstNonEmptyArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}
