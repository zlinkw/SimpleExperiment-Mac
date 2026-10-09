import { optionalApi } from "../api";
import { usageError } from "../errors";
import { table, writeJson, writeText } from "../format";
import { CliFlags } from "../parse";
import { ExperimentRow, loadExperiments } from "./experiment";

export async function gpuCommand(action: string, _rest: string[], flags: CliFlags): Promise<number> {
  if (action !== "status") throw usageError(`unknown gpu action: ${action || "(missing)"}`);
  const [snapshot, experiments] = await Promise.all([
    optionalApi("gpu.list"),
    loadExperiments().catch(() => []),
  ]);
  const rows = flattenGpus(snapshot, experiments);
  if (flags.json) {
    writeJson(rows, flags.compactJson);
    return 0;
  }
  writeText(table(["server", "gpu", "utilization", "memory", "process", "idle"], rows));
  return 0;
}

export function flattenGpus(snapshot: unknown, experiments: ExperimentRow[]): Array<Record<string, unknown>> {
  const record = asRecord(snapshot);
  const gpuRoot = record.gpu && typeof record.gpu === "object" ? record.gpu as Record<string, unknown> : record;
  const rows: Array<Record<string, unknown>> = [];
  for (const [serverId, serverValue] of Object.entries(gpuRoot)) {
    if (["source", "gpuHistory"].includes(serverId)) continue;
    const gpus = extractGpuList(serverValue);
    if (!gpus.length) {
      rows.push({ server: serverId, gpu: "", utilization: "", memory: "", process: "", idle: "" });
      continue;
    }
    for (const gpu of gpus) {
      const index = gpu.index ?? gpu.gpu_index ?? gpu.id ?? "";
      const used = gpu.memoryUsedMb ?? gpu.memory_used_mb ?? gpu.memoryUsed;
      const total = gpu.memoryTotalMb ?? gpu.memory_total_mb ?? gpu.memoryTotal;
      const utilization = gpu.utilizationPercent ?? gpu.utilization ?? gpu.gpuUtilPercent;
      const processes = Array.isArray(gpu.processes) ? gpu.processes : [];
      const processText = processes.map((proc) => {
        const item = asRecord(proc);
        return [item.pid, item.name || item.processName, item.user || item.username].filter(Boolean).join(":");
      }).join("; ");
      const server = String(gpu.workerId || gpu.server || serverId);
      const running = experiments.filter((row) => row.type === "worker_run"
        && row.status === "running"
        && row.worker_id === server
        && String(row.gpu?.id || "") === String(index)
        && Boolean(row.worker_id) && Boolean(String(row.gpu?.id || "")));
      rows.push({
        server,
        gpu: String(index),
        utilization: utilization === undefined || utilization === null ? "" : String(utilization),
        memory: used !== undefined || total !== undefined ? `${used ?? "?"}/${total ?? "?"}MB` : "",
        process: processText || String(gpu.processCount ?? gpu.processesTotalCount ?? ""),
        task: running.map((row) => row.id).join(","),
        idle: idleSince(gpu, running),
      });
    }
  }
  return rows;
}

function idleSince(gpu: Record<string, unknown>, running: ExperimentRow[]): string {
  const explicit = gpu.idleSeconds ?? gpu.idle_seconds ?? gpu.idleTime ?? gpu.idle_for;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) return String(explicit);
  if (running.length) return "";
  const seen = Date.parse(String(gpu.updatedAt || gpu.timestamp || ""));
  if (!Number.isFinite(seen)) return "";
  return String(Math.max(0, Math.round((Date.now() - seen) / 1000)));
}

function extractGpuList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  if (Array.isArray(record.gpus)) return record.gpus.map(asRecord);
  if (record.index !== undefined || record.gpu_index !== undefined) return [record];
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
