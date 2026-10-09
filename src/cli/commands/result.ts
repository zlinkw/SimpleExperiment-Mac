import * as fs from "fs";
import * as path from "path";
import { optionalApi } from "../api";
import { RESULT_REGISTRY_LOCAL_REL, RESULT_REGISTRY_REL, readJsonFile, resolveProjectPath } from "../data";
import { isDiagnosticWorkerResult, readWorkerResultRecords } from "../runtime";
import { businessError, usageError } from "../errors";
import { block, table, writeJson, writeText } from "../format";
import { CliFlags, requirePositional } from "../parse";
import { checkpointRecordsFromManifest } from "../../features/Checkpoint";
import {
  ExperimentResultRecord,
  buildResultLeaderboard,
  builtInResultPresets,
  exportPaperTable,
  leaderboardToCsv,
  parseResultFile,
} from "../../features/Results";

export async function resultCommand(action: string, rest: string[], flags: CliFlags): Promise<number> {
  if (action === "list") return resultList(flags);
  if (action === "show") return resultShow(requirePositional(rest, 0, "result id"), flags);
  if (action === "export") return resultExport(requirePositional(rest, 0, "result id"), flags);
  throw usageError(`unknown result action: ${action || "(missing)"}`);
}

export async function resultList(flags: CliFlags): Promise<number> {
  const rows = await loadResults();
  const experiment = String(flags.experiment || "").trim();
  const filtered = experiment ? rows.filter((row) => row.experimentId === experiment || row.id === experiment || row.runKey === experiment) : rows;
  const view = filtered.map((row) => ({
    id: row.id,
    experimentId: row.experimentId,
    status: row.status,
    metric: row.primaryMetric,
    value: row.primaryValue,
    updated: row.updated,
  }));
  if (flags.json) {
    writeJson(view, flags.compactJson);
    return 0;
  }
  writeText(table(["id", "experimentId", "status", "metric", "value", "updated"], view));
  return 0;
}

export async function resultShow(id: string, flags: CliFlags): Promise<number> {
  const match = (await loadResults()).find((row) => row.id === id || row.experimentId === id || row.runKey === id);
  if (!match) throw businessError(`result not found: ${id}`);
  const payload = {
    id: match.id,
    experimentId: match.experimentId,
    status: match.status,
    metrics: match.metrics,
    time: match.updated || match.created || null,
    config: match.config || null,
    seed: match.seed || null,
    checkpoint: match.checkpoint || null,
    outputFiles: match.outputFiles,
  };
  if (flags.json) writeJson(payload, flags.compactJson);
  else writeText(block("Result", payload as unknown as Record<string, unknown>));
  return 0;
}

export async function resultExport(id: string, flags: CliFlags): Promise<number> {
  const match = (await loadResults()).find((row) => row.id === id || row.experimentId === id || row.runKey === id);
  if (!match) throw businessError(`result not found: ${id}`);
  const format = String(flags.format || "json").toLowerCase();
  if (!["csv", "json"].includes(format)) throw usageError(`unsupported --format ${flags.format}. Use csv or json.`);
  const records = [match.record];
  const metricKeys = Object.keys(match.metrics);
  const config = {
    id: "cli",
    name: "CLI",
    filter: { includeWarnings: true },
    groupBy: ["suite"],
    metrics: metricKeys.map((key) => ({ key, higherIsBetter: true, decimals: 4 })),
    aggregate: "raw" as const,
    primarySortMetric: metricKeys[0],
  };
  const rows = buildResultLeaderboard(records, config, []);
  const body = format === "csv"
    ? leaderboardToCsv(rows, config)
    : exportPaperTable(rows, config, {
      id: "cli",
      title: "Results",
      leaderboardId: "cli",
      rowDimension: "suite",
      metrics: metricKeys,
      boldBest: false,
      showMeanStd: false,
      decimals: {},
      metricDisplayNames: {},
    }, "markdown");
  const output = format === "json" ? JSON.stringify({ id: match.id, metrics: match.metrics, rows }, null, 2) : body;
  if (flags.out) {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
    fs.writeFileSync(path.resolve(flags.out), output.endsWith("\n") ? output : `${output}\n`, "utf8");
  }
  if (flags.json) writeJson({ id: match.id, format, path: flags.out || "", content: flags.compactJson ? undefined : output }, flags.compactJson);
  else process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  return 0;
}

export interface ResultRow {
  id: string;
  experimentId: string;
  runKey: string;
  status: string;
  created: string;
  updated: string;
  primaryMetric: string;
  primaryValue: unknown;
  metrics: Record<string, unknown>;
  config: unknown;
  seed: unknown;
  checkpoint: unknown;
  outputFiles: string[];
  record: ExperimentResultRecord;
}

export async function loadResults(): Promise<ResultRow[]> {
  const records: ExperimentResultRecord[] = [];
  for (const rel of [RESULT_REGISTRY_REL, RESULT_REGISTRY_LOCAL_REL]) {
    const parsed = readJsonFile<unknown>(resolveProjectPath(rel), null);
    records.push(...extractRecords(parsed));
  }
  records.push(...parseLocalResultFiles());
  records.push(...await readWorkerResultRecords() as unknown as ExperimentResultRecord[]);
  const remote = await optionalApi("results.list", {});
  records.push(...extractRecords(remote));
  const byId = new Map<string, ResultRow>();
  for (const record of records) {
    if (isDiagnosticWorkerResult(record as unknown as Record<string, unknown>)) continue;
    const metrics = Object.fromEntries(Object.entries(record.metrics || {}).map(([key, value]) => [key, value && typeof value === "object" ? (value as { value?: unknown }).value : value]));
    const primaryMetric = record.primaryMetric || Object.keys(metrics)[0] || "";
    const outputFiles = (record.sourceFiles || []).map((item) => item.path).filter(Boolean);
    const checkpoints = checkpointRecordsFromManifest(record);
    byId.set(record.resultId || record.experimentId, {
      id: record.resultId || record.experimentId,
      experimentId: record.experimentId,
      runKey: record.runKey,
      status: record.status,
      created: record.createdAt,
      updated: record.updatedAt,
      primaryMetric,
      primaryValue: metrics[primaryMetric],
      metrics,
      config: record.provenance?.configPath || record.dimensions || null,
      seed: record.dimensions?.seed ?? null,
      checkpoint: checkpoints[0]?.path || record.provenance?.artifactKey || null,
      outputFiles,
      record,
    });
  }
  return Array.from(byId.values());
}

function extractRecords(value: unknown): ExperimentResultRecord[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as ExperimentResultRecord[];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.records)) return record.records as ExperimentResultRecord[];
  if (Array.isArray(record.results)) return record.results as ExperimentResultRecord[];
  if (Array.isArray(record.finalResults)) return record.finalResults as ExperimentResultRecord[];
  return [];
}

function parseLocalResultFiles(): ExperimentResultRecord[] {
  const files = [
    resolveProjectPath("experiments", "results"),
    resolveProjectPath("simple_cluster", "results"),
  ].flatMap((dir) => {
    try {
      return fs.readdirSync(dir).filter((name) => /\.(csv|json)$/i.test(name) && !/result_registry/i.test(name)).map((name) => path.join(dir, name));
    } catch {
      return [] as string[];
    }
  });
  const preset = builtInResultPresets[0];
  const out: ExperimentResultRecord[] = [];
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, "utf8");
      out.push(...parseResultFile(text, { path: file, type: file.endsWith(".json") ? "json" : "csv", endpoint: "local" }, preset));
    } catch {
      /* skip unreadable result files */
    }
  }
  return out;
}
