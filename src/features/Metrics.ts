export interface ExperimentMetrics {
  experimentId: string;
  runKey: string;
  metrics: Record<string, number>;
  primaryMetric?: string;
  higherIsBetter?: boolean;
  sourceFile: string;
  parsedAt: string;
}

export interface LeaderboardRow {
  groupKey: string;
  count: number;
  mean: Record<string, number>;
  std: Record<string, number>;
  bestExperimentId?: string;
}

export function parseMetricsFile(text: string, sourceFile: string, runKey = sourceFile): ExperimentMetrics[] {
  const parsedAt = new Date().toISOString();
  if (sourceFile.endsWith(".json")) {
    const json = JSON.parse(text);
    const metrics = numericEntries(json.metrics || json);
    return [{ experimentId: String(json.experimentId || runKey), runKey, metrics, sourceFile, parsedAt }];
  }
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsv(lines[0]);
  return lines.slice(1).map((line, index) => {
    const cols = splitCsv(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => row[h] = cols[i] || "");
    return {
      experimentId: row.experimentId || row.runKey || `${runKey}-${index}`,
      runKey: row.runKey || runKey,
      metrics: numericEntries(row),
      sourceFile,
      parsedAt,
    };
  });
}

export function buildLeaderboard(rows: ExperimentMetrics[], groupBy: (row: ExperimentMetrics) => string, primaryMetric?: string, higherIsBetter = true): LeaderboardRow[] {
  const groups = new Map<string, ExperimentMetrics[]>();
  for (const row of rows) groups.set(groupBy(row), [...(groups.get(groupBy(row)) || []), row]);
  return Array.from(groups.entries()).map(([groupKey, items]) => {
    const keys = Array.from(new Set(items.flatMap((item) => Object.keys(item.metrics))));
    const mean: Record<string, number> = {};
    const std: Record<string, number> = {};
    for (const key of keys) {
      const values = items.map((item) => item.metrics[key]).filter((value) => Number.isFinite(value));
      mean[key] = avg(values);
      std[key] = Math.sqrt(avg(values.map((value) => (value - mean[key]) ** 2)));
    }
    const best = primaryMetric
      ? [...items].filter((item) => Number.isFinite(item.metrics[primaryMetric])).sort((a, b) => higherIsBetter ? b.metrics[primaryMetric] - a.metrics[primaryMetric] : a.metrics[primaryMetric] - b.metrics[primaryMetric])[0]
      : undefined;
    return { groupKey, count: items.length, mean, std, bestExperimentId: best?.experimentId };
  });
}

export function leaderboardToMarkdown(rows: LeaderboardRow[], metrics: string[]): string {
  const header = ["Group", "N", ...metrics, "Best"].join(" | ");
  const sep = ["---", "---", ...metrics.map(() => "---:"), "---"].join(" | ");
  const body = rows.map((row) => [row.groupKey, row.count, ...metrics.map((metric) => `${fmt(row.mean[metric])} +/- ${fmt(row.std[metric])}`), row.bestExperimentId || ""].join(" | "));
  return [header, sep, ...body].join("\n");
}

function numericEntries(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, raw]) => {
    if (typeof raw === "number") return Number.isFinite(raw) ? [[key, raw]] : [];
    if (typeof raw !== "string" || !raw.trim()) return [];
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? [[key, parsed]] : [];
  }));
}

function splitCsv(line = ""): string[] {
  return line.split(",").map((item) => item.trim());
}

function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : "";
}
