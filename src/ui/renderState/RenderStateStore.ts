/**
 * RenderStateStore - Webview 渲染状态通用存储/工具
 * 拆分自 WebviewRenderState.ts
 * 职责：通用取值、空值收敛、数值/时长/传输速率 + 实验/操作/传输映射
 */
export function pick<T = unknown>(obj: unknown, keys: string[], fallback: T): T {
  if (!obj || typeof obj !== "object") return fallback;
  const item = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = item[key];
    if (value !== undefined && value !== null && value !== "") return value as T;
  }
  return fallback;
}
export function objectRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
export function firstNonEmptyRecord(...values: unknown[]): Record<string, unknown> {
  for (const v of values) { const r = objectRecord(v); if (Object.keys(r).length) return r; }
  return {};
}
export function firstNonEmptyArray(...values: unknown[]): unknown[] {
  for (const v of values) if (Array.isArray(v) && v.length) return v;
  return [];
}
export function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>);
}
export function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value); return Number.isFinite(n) ? n : undefined;
}
export function percent(used: unknown, total: unknown): number | undefined {
  const u = numberOrUndefined(used); const t = numberOrUndefined(total);
  if (u === undefined || !t) return undefined;
  return Math.round((u / t) * 1000) / 10;
}
export function formatDuration(startedAt: unknown, updatedAt: unknown): string {
  const s = Date.parse(String(startedAt || "")); const e = Date.parse(String(updatedAt || "")) || Date.now();
  if (!Number.isFinite(s)) return "-";
  const sec = Math.max(0, Math.round((e - s) / 1000)); const m = Math.floor(sec / 60); const r = sec % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
}
export function transferRateBytesPerSecond(t: unknown, s: unknown, u: unknown): number | undefined {
  const b = numberOrUndefined(t); const start = Date.parse(String(s || ""));
  if (b === undefined || b <= 0 || !Number.isFinite(start)) return undefined;
  const end = Date.parse(String(u || "")) || Date.now(); const sec = (end - start) / 1000;
  return sec > 0 ? Math.round(b / sec) : undefined;
}
export function transferEtaSeconds(done: unknown, total: unknown, rate: unknown): number | undefined {
  const d = numberOrUndefined(done); const t = numberOrUndefined(total); const r = numberOrUndefined(rate);
  if (d === undefined || t === undefined || r === undefined || r <= 0 || t <= d) return undefined;
  return Math.max(0, Math.round((t - d) / r));
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
function operationPayload(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object") return {};
  const item = row as Record<string, unknown>;
  if (item.payload && typeof item.payload === "object") return item.payload as Record<string, unknown>;
  const latest = item.latestEvent as Record<string, unknown> | undefined;
  if (latest && typeof latest === "object" && latest.payload && typeof latest.payload === "object") return latest.payload as Record<string, unknown>;
  return item;
}
function operationStatusFromType(type: unknown): string {
  const v = String(type || "");
  if (v.includes("completed")) return "completed";
  if (v.includes("failed")) return "failed";
  if (v.includes("cancelled") || v.includes("canceled")) return "cancelled";
  if (v.includes("stalled")) return "stalled";
  if (v.includes("started") || v.includes("progress")) return "running";
  return "-";
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
      type, status: pick(row, ["status", "state"], pick(payload, ["status", "state"], operationStatusFromType(type))),
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
export function normalizeFileTransferRows(fileTransfers: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(fileTransfers) ? fileTransfers : Object.entries((fileTransfers || {}) as Record<string, unknown>).map(([id, value]) => ({ id, ...(value as object) }));
  return rows.map((row) => {
    const tb = pick(row, ["transferredBytes", "transferred_bytes", "receivedBytes", "sentBytes", "doneBytes"], 0);
    const tot = pick(row, ["totalBytes", "total_bytes", "expectedSize", "expected_size", "size", "bytes"], 0);
    const sAt = pick(row, ["startedAt", "started_at"], ""); const uAt = pick(row, ["updatedAt", "updated_at", "finishedAt", "finished_at"], "");
    const bps = transferRateBytesPerSecond(tb, sAt, uAt);
    return {
      transferId: pick(row, ["transferId", "transfer_id", "id"], "-"),
      direction: pick(row, ["direction", "type"], "-"),
      remotePath: pick(row, ["remotePath", "remote_path", "path"], "-"),
      localPath: pick(row, ["localPath", "local_path"], "-"),
      status: pick(row, ["status", "state"], "-"),
      transferredBytes: tb, totalBytes: tot,
      percent: pick(row, ["percent"], percent(tb, tot)),
      speed: pick(row, ["speed", "speedBytesPerSecond", "speed_bytes_per_second", "bytesPerSecond"], bps ?? "-"),
      eta: pick(row, ["eta", "etaSeconds", "eta_seconds"], transferEtaSeconds(tb, tot, bps) ?? "-"),
      stalled: pick(row, ["stalled"], false),
      error: pick(row, ["error", "lastError"], "-"),
    };
  });
}
