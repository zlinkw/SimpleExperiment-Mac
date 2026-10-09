#!/usr/bin/env node
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { buildExperimentMatrix } from "./features/PlanBuilder";
import { buildLeaderboard, leaderboardToMarkdown, parseMetricsFile } from "./features/Metrics";
import {
  buildResultLeaderboard,
  builtInResultPresets,
  ExperimentResultRecord,
  exportPaperTable,
  filterByInclusionPolicy,
  finalResultInclusionPolicy,
  leaderboardToCsv,
  parseResultFile,
} from "./features/Results";
import { parseSimpleRunArgs, runRecordedExperiment } from "./features/ExperimentRunner";

const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const API_DISCOVERY_PATH = () => process.env.SIMPLE_EXPERIMENT_API_FILE || path.join(APPDATA, "SimpleExperiment", "api.json");

export async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  if (cmd === "run") return runRecordedCli([sub, ...rest].filter((item): item is string => item !== undefined));
  if (cmd === "api") return runApiCommand([sub, ...rest].filter((item): item is string => item !== undefined));
  if (cmd === "status") {
    console.log(JSON.stringify({ ok: true, cwd: process.cwd(), command: "status" }, null, 2));
    return 0;
  }
  if (cmd === "agent" && sub === "health") {
    console.log(JSON.stringify({ status: "unknown", hint: "Use VS Code command for live Hub Agent status." }, null, 2));
    return 0;
  }
  if (cmd === "self-check") return runSelfCheck();
  if (cmd === "experiments" && sub === "list") {
    const file = option(rest, "--file") || path.join(process.cwd(), "simple_cluster", "experiment_index.json");
    const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (cmd === "metrics" && sub === "leaderboard") {
    const file = option(rest, "--file");
    if (!file) throw new Error("--file required");
    const metrics = parseMetricsFile(fs.readFileSync(file, "utf8"), file);
    const board = buildLeaderboard(metrics, (row) => row.runKey, option(rest, "--primary") || undefined);
    console.log(leaderboardToMarkdown(board, Object.keys(metrics[0]?.metrics || {})));
    return 0;
  }
  if (cmd === "results" && sub === "parse") {
    const file = option(rest, "--file");
    if (!file) throw new Error("--file required");
    const preset = builtInResultPresets.find((item) => item.id === option(rest, "--preset")) || builtInResultPresets[0];
    const records = parseResultFile(fs.readFileSync(file, "utf8"), { path: file, type: file.endsWith(".json") ? "json" : "csv", endpoint: "local" }, preset);
    console.log(JSON.stringify(records, null, 2));
    return 0;
  }
  if (cmd === "results" && sub === "paper-table") {
    const file = option(rest, "--file");
    if (!file) throw new Error("--file required");
    const records = finalPaperTableRecords(JSON.parse(fs.readFileSync(file, "utf8")));
    const metrics = (option(rest, "--metrics") || "AUC,accuracy,F1,AUPRC").split(",").filter(Boolean);
    const config = {
      id: "cli",
      name: "CLI",
      filter: { includeWarnings: true },
      groupBy: ["suite", "dataset"],
      metrics: metrics.map((key) => ({ key, higherIsBetter: !["ASD", "HD95", "loss"].includes(key), decimals: 4 })),
      aggregate: "mean_std" as const,
      primarySortMetric: metrics[0],
    };
    const rows = buildResultLeaderboard(records, config, []);
    if (option(rest, "--format") === "csv") console.log(leaderboardToCsv(rows, config));
    else console.log(exportPaperTable(rows, config, { id: "cli", title: "Results", leaderboardId: "cli", rowDimension: "suite", metrics, boldBest: true, showMeanStd: true, decimals: {}, metricDisplayNames: {} }, option(rest, "--format") === "latex" ? "latex_booktabs" : "markdown"));
    return 0;
  }
  if (cmd === "plan" && sub === "build") {
    const suite = option(rest, "--suite") || "suite";
    const baseConfig = option(rest, "--base") || "config.yaml";
    const seeds = (option(rest, "--seeds") || "1").split(",");
    const result = buildExperimentMatrix({ suite, baseConfig, seeds, variables: [] });
    console.log(result.yaml);
    return 0;
  }
  console.error("Usage: simpleex status | agent health | self-check | experiments list --file x | metrics leaderboard --file x | results parse --file x | results paper-table --file registry.json | plan build | run --name x -- command");
  return 2;
}

async function runApiCommand(argv: string[]): Promise<number> {
  const [method, ...rest] = argv;
  if (!method || method.startsWith("-")) {
    console.error("Usage: simpleex api <method> --json <params.json>");
    return 2;
  }
  const paramsFile = option(rest, "--json") || option(rest, "--params");
  let params: Record<string, unknown> = {};
  if (paramsFile) {
    if (!fs.existsSync(paramsFile)) throw new Error(`params file not found: ${paramsFile}`);
    params = JSON.parse(fs.readFileSync(paramsFile, "utf8"));
  }
  const discovery = readApiDiscovery();
  const result = await apiRequest(discovery, method, params);
  if (result.error) {
    console.log(JSON.stringify({
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        data: result.error.data || {},
      },
    }, null, 2));
    return 1;
  }
  console.log(JSON.stringify({ ok: true, result: result.result === undefined ? null : result.result }, null, 2));
  return 0;
}

interface SelfCheckItem {
  name: string;
  ok: boolean;
  detail?: string;
}

async function runSelfCheck(): Promise<number> {
  const checks: SelfCheckItem[] = [
    { name: "cli", ok: true, detail: process.execPath },
  ];
  const file = API_DISCOVERY_PATH();
  if (!fs.existsSync(file)) {
    checks.push({ name: "discovery", ok: false, detail: `missing discovery: ${file}` });
    checks.push({ name: "listener", ok: false, detail: "missing listener: discovery file absent" });
  } else {
    let discovery: Record<string, unknown> | undefined;
    try {
      discovery = readApiDiscovery();
      checks.push({ name: "discovery", ok: true, detail: file });
    } catch (error) {
      checks.push({
        name: "discovery",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (discovery) {
      checks.push(await checkListener(discovery));
    } else {
      checks.push({ name: "listener", ok: false, detail: "missing listener: discovery invalid" });
    }
  }
  const ok = checks.every((item) => item.ok);
  console.log(JSON.stringify({ ok, status: ok ? "ok" : "missing", checks }, null, 2));
  return ok ? 0 : 1;
}

function checkListener(discovery: Record<string, unknown>): Promise<SelfCheckItem> {
  const url = new URL("/api/v1/health", String(discovery.baseUrl));
  return new Promise((resolve) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: "GET",
      headers: {
        Authorization: `Bearer ${String(discovery.token)}`,
      },
      timeout: 3_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok?: unknown; name?: unknown; version?: unknown };
          if (res.statusCode === 200 && body.ok === true) {
            resolve({ name: "listener", ok: true, detail: `${String(body.name || discovery.name)} ${String(body.version || discovery.version)}` });
          } else {
            resolve({ name: "listener", ok: false, detail: `missing listener: HTTP ${res.statusCode}` });
          }
        } catch {
          resolve({ name: "listener", ok: false, detail: `missing listener: invalid health response (HTTP ${res.statusCode})` });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("health request timed out")));
    req.on("error", (error) => resolve({ name: "listener", ok: false, detail: `missing listener: ${error.message}` }));
    req.end();
  });
}

export function readApiDiscovery(): Record<string, unknown> {
  const file = API_DISCOVERY_PATH();
  if (!fs.existsSync(file)) {
    throw new Error(`SimpleExperiment API discovery not found: ${file}. Open VS Code once to start the extension host.`);
  }
  const discovery = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (!discovery.baseUrl || !discovery.token) {
    throw new Error(`SimpleExperiment API discovery is invalid: ${file}`);
  }
  return discovery;
}

export function apiRequest(discovery: Record<string, unknown>, method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const url = new URL("/api/v1/rpc", String(discovery.baseUrl));
  const body = Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  }), "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        Authorization: `Bearer ${String(discovery.token)}`,
      },
      timeout: 15_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(new Error(`invalid API response: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("SimpleExperiment API request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

export function runRecordedCli(argv: string[]): number {
  const result = runRecordedExperiment(parseSimpleRunArgs(argv));
  console.log(JSON.stringify(result, null, 2));
  return result.exitCode;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function finalPaperTableRecords(input: unknown): ExperimentResultRecord[] {
  if (Array.isArray(input)) return filterByInclusionPolicy(input as ExperimentResultRecord[], [], finalResultInclusionPolicy);
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (Array.isArray(record.finalResults)) return filterByInclusionPolicy(record.finalResults as ExperimentResultRecord[], [], finalResultInclusionPolicy);
  if (Array.isArray(record.records)) {
    const rows = record.records as ExperimentResultRecord[];
    if (String(record.inclusionPolicy || "").includes("archived") || String(record.path || "").includes("result_registry")) {
      const archivedRows = rows.map((row) => ({ ...row, finalEvidenceState: row.finalEvidenceState || "archived", eligibleForFinalAnalysis: row.eligibleForFinalAnalysis ?? true }));
      return filterByInclusionPolicy(archivedRows, [], finalResultInclusionPolicy);
    }
    return filterByInclusionPolicy(rows, [], finalResultInclusionPolicy);
  }
  return [];
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
