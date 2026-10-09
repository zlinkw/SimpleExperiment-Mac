import { usageError } from "../errors";
import { block, writeJson, writeText } from "../format";
import { CliFlags, requirePositional } from "../parse";
import { loadResults } from "./result";
import { metricNumber } from "./metric";

const LOWER_IS_BETTER = /(?:^|_)(loss|error|mse|mae|perplexity)(?:_|$)/i;

export async function compareCommand(rest: string[], flags: CliFlags): Promise<number> {
  const leftId = requirePositional(rest, 0, "first experiment id");
  const rightId = requirePositional(rest, 1, "second experiment id");
  const rows = await loadResults();
  const left = metricsFor(rows, leftId);
  const right = metricsFor(rows, rightId);
  const difference: Record<string, { left: number; right: number; delta: number }> = {};
  const improvement: string[] = [];
  const regression: string[] = [];
  const reason = !Object.keys(left).length && !Object.keys(right).length
    ? "no results recorded for either experiment"
    : !Object.keys(left).length
      ? `no results recorded for ${leftId}`
      : !Object.keys(right).length
        ? `no results recorded for ${rightId}`
        : "";
  for (const key of Object.keys(left)) {
    if (!(key in right)) continue;
    const delta = Math.round((right[key] - left[key]) * 1e12) / 1e12;
    difference[key] = { left: left[key], right: right[key], delta };
    const improved = LOWER_IS_BETTER.test(key) ? delta < 0 : delta > 0;
    if (delta === 0) continue;
    (improved ? improvement : regression).push(key);
  }
  const payload = { left: leftId, right: rightId, metric_difference: difference, improvement, regression, reason };
  if (flags.json) writeJson(payload, flags.compactJson);
  else writeText(block("Compare", payload as unknown as Record<string, unknown>));
  return 0;
}

export async function compareEntry(rest: string[], flags: CliFlags): Promise<number> {
  if (!rest[0]) throw usageError("missing first experiment id");
  return compareCommand(rest, flags);
}

function metricsFor(rows: Awaited<ReturnType<typeof loadResults>>, id: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.id !== id && row.experimentId !== id && row.runKey !== id) continue;
    for (const [key, value] of Object.entries(row.metrics || {})) {
      const numeric = metricNumber(value);
      if (numeric !== null) out[key] = numeric;
    }
  }
  return out;
}
