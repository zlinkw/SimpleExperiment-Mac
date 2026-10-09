import { usageError } from "../errors";
import { writeJson, writeText } from "../format";
import { CliFlags, requirePositional } from "../parse";
import { loadResults, ResultRow } from "./result";

export async function metricCommand(action: string, rest: string[], flags: CliFlags): Promise<number> {
  if (action === "list") return metricList(flags);
  if (action === "show") return metricShow(requirePositional(rest, 0, "experiment id"), flags);
  throw usageError(`unknown metric action: ${action || "(missing)"}`);
}

export async function metricList(flags: CliFlags): Promise<number> {
  const names = new Set<string>();
  for (const row of await loadResults()) {
    for (const key of Object.keys(numericMetrics(row))) names.add(key);
  }
  const payload = { metrics: Array.from(names).sort() };
  if (flags.json) writeJson(payload, flags.compactJson);
  else writeText(payload.metrics.join("\n") || "(no metrics)");
  return 0;
}

export async function metricShow(id: string, flags: CliFlags): Promise<number> {
  const rows = (await loadResults()).filter((row) => matchesResult(row, id));
  const metrics: Record<string, unknown> = {};
  for (const row of rows) Object.assign(metrics, numericMetrics(row));
  if (flags.json) writeJson(metrics, flags.compactJson);
  else writeText(Object.entries(metrics).map(([key, value]) => `${key}: ${String(value)}`).join("\n") || "(no metrics)");
  return 0;
}

export function numericMetrics(row: Pick<ResultRow, "metrics">): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(row.metrics || {})) {
    const numeric = metricNumber(value);
    if (numeric !== null) out[key] = numeric;
  }
  return out;
}

export function metricNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function matchesResult(row: ResultRow, id: string): boolean {
  return row.id === id || row.experimentId === id || row.runKey === id;
}
