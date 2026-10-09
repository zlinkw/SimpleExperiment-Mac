/**
 * RenderStateMapper - Webview 渲染状态映射层
 * 拆分自 WebviewRenderState.ts
 * 职责：GPU / Scheduler / Task 归一化
 */
import { SCHEDULER_BUCKETS, SCHEDULER_BUCKET_STATUSES, TASK_STATUS_RANKS } from "./RenderStateTypes";
import { formatDuration, normalizeArray, numberOrUndefined, percent, pick } from "./RenderStateStore";
function isNumericGpuId(v: unknown): boolean { return /^\d+$/.test(String(v ?? "").trim()); }
function extractNumericGpuId(v: unknown): string {
  const s = String(v ?? "").trim(); if (!s || s === "-") return "";
  if (/^\d+$/.test(s)) return s;
  const g = s.match(/(?:gpu|GPU)[-_]?(\d+)\b/); if (g) return g[1];
  const n = s.match(/\b(\d+)\b/); if (n && Number(n[1]) < 64) return n[1]; return "";
}
function normalizeGpuDisplayIndex(row: unknown): string {
  const raw = String(pick(row, ["index", "gpu_index"], "") ?? "").trim();
  if (raw && raw !== "-" && isNumericGpuId(raw)) return raw;
  if (raw && raw !== "-") { const e = extractNumericGpuId(raw); if (e) return e; }
  for (const c of [pick(row, ["gpuId", "gpu_id", "id"], ""), pick(row, ["uuid"], "")]) { const e = extractNumericGpuId(c); if (e) return e; }
  return raw || "-";
}
function normalizeGpuDisplayId(row: unknown): string {
  const raw = String(pick(row, ["id", "gpuId", "gpu_id", "uuid"], "-") ?? "").trim();
  if (!raw || raw === "-") return "-"; if (isNumericGpuId(raw)) return raw;
  const e = extractNumericGpuId(raw); return e || raw;
}
export function normalizeGpuRow(row: unknown): Record<string, unknown> {
  const used = numberOrUndefined(pick(row, ["memoryUsedMb", "memory_used_mb", "memoryUsed", "used"], undefined));
  const total = numberOrUndefined(pick(row, ["memoryTotalMb", "memory_total_mb", "memoryTotal", "total"], undefined));
  return {
    index: normalizeGpuDisplayIndex(row), name: pick(row, ["name", "gpu_name", "model"], "-"),
    memoryUsedMb: used, memoryTotalMb: total, memoryPercent: percent(used, total),
    utilizationPercent: numberOrUndefined(pick(row, ["utilizationPercent", "utilization", "gpu_util", "utilization_gpu"], undefined)),
    temperature: numberOrUndefined(pick(row, ["temperature", "temperatureGpu", "temperature_gpu", "temp"], undefined)),
    processCount: normalizeArray(pick(row, ["processes", "procs"], [])).length,
    runKey: pick(row, ["runKey", "run_key", "assignedRunKey", "experiment", "experimentId"], "-"),
  };
}
export function normalizeServerGpu(serverId: string, rows: unknown): Record<string, unknown> {
  const src = Array.isArray(rows) ? rows : normalizeArray(pick(rows, ["gpus", "gpu", "rows"], []));
  const gpuRows = src.map(normalizeGpuRow);
  return { serverId, workerId: pick(rows, ["workerId", "worker_id", "worker"], serverId), gpuRows, gpuCount: gpuRows.length, status: pick(rows, ["status", "state"], gpuRows.length ? "online" : "stale"), updatedAt: pick(rows, ["generatedAt", "generated_at", "updatedAt", "updated_at", "timestamp"], "-") };
}
export function normalizeSchedulerRows(rows: unknown): Array<Record<string, unknown>> {
  return normalizeArray(rows).flatMap((r) => expandSchedulerRow(r)).map((r, i) => normalizeTaskRow(r, i)).filter((r) => r.status !== "deleted").sort((a, b) => taskStatusRank(String(a.status)) - taskStatusRank(String(b.status)) || String(a.uiKey || "").localeCompare(String(b.uiKey || "")));
}
export function normalizeTaskRow(row: unknown, index = 0): Record<string, unknown> {
  const startedAt = pick(row, ["startedAt", "started_at"], ""); const updatedAt = pick(row, ["updatedAt", "updated_at", "finishedAt", "finished_at"], "");
  const status = String(pick(row, ["status", "state", "runStatus", "run_status"], "unknown")).toLowerCase();
  const experimentId = pick(row, ["experimentId", "experiment_id", "id", "jobId", "job_id", "taskId", "task_id", "global_job_id", "session"], "-");
  const archiveKey = pick(row, ["archiveKey", "archive_key", "artifactKey", "artifact_key", "global_job_id", "session", "hub_job_dir", "worker_job_dir", "native_job_dir", "artifactPath", "artifact_path"], experimentId);
  const n: Record<string, unknown> = {
    status, plan: pick(row, ["planName", "plan_name", "plan", "suite", "file"], "-"),
    experimentName: pick(row, ["experimentName", "experiment_name", "name", "case", "experiment"], "-"),
    runKey: pick(row, ["runKey", "run_key", "runId", "run_id", "jobId", "job_id", "taskId", "task_id", "id", "experimentId", "experiment_id", "global_job_id", "session", "hub_console_log", "schedulerLog", "log_path"], "-"),
    experimentId, archiveKey, serverId: pick(row, ["serverId", "workerId", "worker_id", "worker", "server"], "-"),
    gpuIds: pick(row, ["gpuIds", "gpu_ids", "gpuId", "gpu_id"], "-"), startedAt: startedAt || "-", updatedAt: updatedAt || "-",
    duration: formatDuration(startedAt, updatedAt), progress: pick(row, ["progress", "epoch", "step"], "-"), primaryMetric: pick(row, ["primaryMetric", "primary_metric", "metric", "score"], "-"),
  };
  n.uiKey = taskUiKeyFromRow(n, index); return n;
}
function taskUiKeyFromRow(row: Record<string, unknown>, index: number): string {
  const vals = [row.runKey, row.experimentId, row.archiveKey, row.plan, row.experimentName, row.serverId, row.gpuIds, row.startedAt, row.updatedAt, index].map((v) => String(v || "").trim()).filter((v) => v && v !== "-");
  return Array.from(new Set(vals)).join("|") || `task-ui-${index}`;
}
export function taskStatusRank(status: string): number { return TASK_STATUS_RANKS[String(status || "unknown").toLowerCase()] ?? 6; }
function expandSchedulerRow(row: unknown): unknown[] {
  if (!row || typeof row !== "object") return [];
  const item = row as Record<string, unknown>;
  const parentPlanFile = item.planFile || item.plan_file || item.planPath || item.plan_path || item.file || item.path || item.plan;
  const expanded = SCHEDULER_BUCKETS.flatMap((key) => normalizeArray(item[key]).map((child) => {
    const cr = child && typeof child === "object" ? (child as Record<string, unknown>) : {};
    return { ...cr, status: bucketStatus(key), plan: item.plan || item.planName || item.suite || item.file, planFile: cr.planFile || cr.plan_file || cr.file || cr.path || parentPlanFile };
  }));
  return expanded.length ? expanded : [row];
}
function bucketStatus(bucket: string): string { return SCHEDULER_BUCKET_STATUSES[bucket] ?? bucket.replace("_experiments", "").replace("pending", "queued"); }
