import { optionalApi } from "../api";
import { usageError } from "../errors";
import { table, writeJson, writeText } from "../format";
import { CliFlags } from "../parse";
import { loadExperiments } from "./experiment";

export async function resourceCommand(action: string, _rest: string[], flags: CliFlags): Promise<number> {
  if (action !== "available") throw usageError(`unknown resource action: ${action || "(missing)"}`);
  const [snapshot, experiments] = await Promise.all([
    optionalApi("gpu.list"),
    loadExperiments().catch(() => []),
  ]);
  const busy = new Set(experiments.filter((row) => row.status === "running" && row.worker_id).map((row) => row.worker_id));
  const rows = availableResources(snapshot, busy);
  if (flags.json) writeJson(rows, flags.compactJson);
  else writeText(table(["server", "gpu", "available", "reason"], rows));
  return 0;
}

export function availableResources(snapshot: unknown, busyWorkers: Set<string>): Array<Record<string, unknown>> {
  const root = asRecord(asRecord(snapshot).gpu || snapshot);
  const rows: Array<Record<string, unknown>> = [];
  for (const [serverId, value] of Object.entries(root)) {
    if (["source", "gpuHistory"].includes(serverId)) continue;
    const gpus = gpuRecords(value);
    for (const gpu of gpus) {
      const id = String(gpu.index ?? gpu.gpu_index ?? gpu.id ?? "");
      const utilization = finiteNumber(gpu.utilizationPercent ?? gpu.utilization ?? gpu.gpuUtilPercent);
      const processes = Array.isArray(gpu.processes) ? gpu.processes.length : finiteNumber(gpu.processCount);
      const workerBusy = busyWorkers.has(serverId) || busyWorkers.has(String(gpu.workerId || ""));
      let available = "unknown";
      let reason = "utilization_unknown";
      if (processes !== null && processes > 0) {
        available = "false";
        reason = "process_present";
      } else if (workerBusy && id === "") {
        available = "false";
        reason = "worker_running";
      } else if (utilization !== null) {
        available = utilization < 5 && (processes === null || processes === 0) ? "true" : "false";
        reason = utilization < 5 ? "utilization_below_5" : "utilization_in_use";
      } else if (processes === 0 && !workerBusy) {
        available = "true";
        reason = "no_process";
      }
      rows.push({ server: String(gpu.workerId || serverId), gpu: id, available, reason, utilization: utilization === null ? "" : utilization });
    }
  }
  return rows;
}

function gpuRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  if (Array.isArray(record.gpus)) return record.gpus.map(asRecord);
  if (record.index !== undefined || record.gpu_index !== undefined || record.utilizationPercent !== undefined) return [record];
  return [];
}

function finiteNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : (typeof value === "string" && value.trim() ? Number(value) : NaN);
  return Number.isFinite(numeric) ? numeric : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
