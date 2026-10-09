const BULKY_KEYS = new Set(["raw", "recentLogs", "runtimeLog", "log", "content", "yaml", "evidence", "checks", "reproducedPlanId", "lifecycle"]);

export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function block(title: string, fields: Record<string, unknown>): string {
  const lines = [`${title}:`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`  ${key}: ${stringify(value)}`);
  }
  return lines.join("\n");
}

export function nestedBlock(root: Record<string, Record<string, unknown> | string>): string {
  const lines: string[] = [];
  for (const [title, value] of Object.entries(root)) {
    if (typeof value === "string") {
      lines.push(`${title}:`);
      lines.push(`  ${value}`);
      continue;
    }
    lines.push(block(title, value));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function table(headers: string[], rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return headers.join("  ");
  const widths = headers.map((header) => Math.max(header.length, ...rows.map((row) => stringify(row[header]).length)));
  const line = (values: string[]) => values.map((value, index) => value.padEnd(widths[index])).join("  ");
  return [line(headers), ...rows.map((row) => line(headers.map((header) => stringify(row[header]))))].join("\n");
}

export function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function writeJson(value: unknown, compact = false): void {
  process.stdout.write(toJson(compact ? compactJsonValue(value) : value));
}

export function writeText(value: string): void {
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}

const NOISY_KEYS = new Set(["raw", "logs", "recentLogs", "runtimeLog", "log", "content", "yaml", "evidence", "debug", "trace", "history", "children"]);

export function compactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => compactJsonValue(item));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  if (isExperimentLike(source)) return compactExperiment(source);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (NOISY_KEYS.has(key)) continue;
    const next = compactJsonValue(item);
    if (!isEmptyCompact(next)) out[key] = next;
  }
  return out;
}

export function isExperimentLike(source: Record<string, unknown>): boolean {
  const type = String(source.type || "");
  return type === "workflow" || type === "worker_run" || "experiment_case" in source || "parent_id" in source;
}

export function compactExperiment(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["id", "type", "status", "parent_id", "plan", "tmux", "stage", "experiment_case", "seed"]) {
    if (!isEmptyCompact(source[key])) out[key] = source[key];
  }
  const worker = pick(source.worker, ["id"]);
  const gpu = pick(source.gpu, ["id"]);
  const progress = pick(source.progress, ["epoch", "max_epoch", "percent", "loss"]);
  if (worker) out.worker = worker;
  if (gpu) out.gpu = gpu;
  if (progress) out.progress = progress;
  return out;
}

function pick(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (!isEmptyCompact(source[key])) out[key] = source[key];
  return Object.keys(out).length ? out : undefined;
}

function isEmptyCompact(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}
