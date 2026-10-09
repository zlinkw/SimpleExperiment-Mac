import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { previewTextMetricParse } from "./Results";

export interface SimpleRunOptions {
  name: string;
  seed?: string;
  config?: string;
  suite?: string;
  method?: string;
  dataset?: string;
  split?: string;
  cwd?: string;
  command: string[];
}

export interface SimpleRunResult {
  runId: string;
  runDir: string;
  exitCode: number;
  files: string[];
  metricsRows: number;
}

interface ArtifactManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface ArtifactManifest {
  schemaVersion: 1;
  runId: string;
  name: string;
  seed: string;
  config: string;
  exitCode: number;
  metricsRows: number;
  files: ArtifactManifestFile[];
  generatedAt: string;
}

export function parseSimpleRunArgs(argv: string[]): SimpleRunOptions {
  const sep = argv.indexOf("--");
  const head = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  const opt = (name: string, fallback = "") => {
    const index = head.indexOf(name);
    return index >= 0 ? head[index + 1] || fallback : fallback;
  };
  if (!command.length) throw new Error("simpleex run 缺少 -- 后的真实命令。");
  return {
    name: opt("--name", "manual"),
    seed: opt("--seed"),
    config: opt("--config"),
    suite: opt("--suite", "manual"),
    method: opt("--method", opt("--name", "manual")),
    dataset: opt("--dataset", "unknown"),
    split: opt("--split", "test"),
    cwd: opt("--cwd", process.cwd()),
    command,
  };
}

export function runRecordedExperiment(options: SimpleRunOptions): SimpleRunResult {
  const cwd = path.resolve(options.cwd || process.cwd());
  const runId = buildRunId(options);
  const runDir = path.join(cwd, "experiments", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const commandLine = shellLine(options.command);
  fs.writeFileSync(path.join(runDir, "command.txt"), commandLine + "\n", "utf8");
  const startedAt = new Date().toISOString();
  const result = spawnSync(options.command[0], options.command.slice(1), { cwd, encoding: "utf8", shell: false });
  fs.writeFileSync(path.join(runDir, "stdout.log"), result.stdout || "", "utf8");
  fs.writeFileSync(path.join(runDir, "stderr.log"), result.stderr || "", "utf8");
  fs.writeFileSync(path.join(runDir, "env_snapshot.json"), JSON.stringify(envSnapshot(options, commandLine, startedAt), null, 2), "utf8");
  fs.writeFileSync(path.join(runDir, "config_snapshot.yaml"), configSnapshot(cwd, options), "utf8");
  const metricsRows = writeMetricsSummary(runDir, options, result.stdout || "", result.stderr || "");
  const manifest = buildArtifactManifest(runDir, options, result.status ?? 1, metricsRows);
  fs.writeFileSync(path.join(runDir, "artifact_manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { runId, runDir, exitCode: result.status ?? 1, files: manifest.files.map((item) => item.path), metricsRows };
}

function buildRunId(options: SimpleRunOptions): string {
  const seed = options.seed ? `_seed${safeToken(options.seed)}` : "";
  const digest = createHash("sha1").update(JSON.stringify({ name: options.name, seed: options.seed, config: options.config, command: options.command, at: Date.now() })).digest("hex").slice(0, 8);
  return `${safeToken(options.name || "manual")}${seed}_${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}_${digest}`;
}

function writeMetricsSummary(runDir: string, options: SimpleRunOptions, stdout: string, stderr: string): number {
  const parsed = previewTextMetricParse([stdout, stderr].join("\n"), "stdout.log");
  if (!parsed.records) return 0;
  const headers = ["experiment_id", "attempt_id", "suite", "method", "dataset", "split", "fold", "seed", "metric", "value", "unit", "higher_is_better", "epoch", "step", "timestamp"];
  const rows: Array<Record<string, string>> = parsed.samples.map((sample) => ({
    experiment_id: path.basename(runDir),
    attempt_id: "manual-1",
    suite: options.suite || "manual",
    method: options.method || options.name,
    dataset: options.dataset || "unknown",
    split: options.split || "test",
    fold: "",
    seed: options.seed || "",
    metric: sample.metric,
    value: String(sample.value),
    unit: "",
    higher_is_better: String(sample.higherIsBetter),
    epoch: "",
    step: "final",
    timestamp: new Date().toISOString(),
  }));
  fs.writeFileSync(path.join(runDir, "metrics_summary.csv"), [headers.join(","), ...rows.map((row) => headers.map((key) => csvEscape((row as Record<string, string>)[key])).join(","))].join("\n") + "\n", "utf8");
  return rows.length;
}

function envSnapshot(options: SimpleRunOptions, commandLine: string, startedAt: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    hostname: os.hostname(),
    cwd: path.resolve(options.cwd || process.cwd()),
    command: commandLine,
    seed: options.seed || "",
    config: options.config || "",
    git_commit: commandOutput("git", ["rev-parse", "HEAD"], options.cwd),
    git_dirty: Boolean(commandOutput("git", ["status", "--porcelain"], options.cwd)),
  };
}

function configSnapshot(cwd: string, options: SimpleRunOptions): string {
  if (options.config) {
    const target = path.resolve(cwd, options.config);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return fs.readFileSync(target, "utf8");
  }
  return [`name: ${JSON.stringify(options.name)}`, `seed: ${JSON.stringify(options.seed || "")}`, `config: ${JSON.stringify(options.config || "")}`].join("\n") + "\n";
}

function buildArtifactManifest(runDir: string, options: SimpleRunOptions, exitCode: number, metricsRows: number): ArtifactManifest {
  const files = fs.readdirSync(runDir).filter((name) => fs.statSync(path.join(runDir, name)).isFile()).map((name) => {
    const full = path.join(runDir, name);
    return { path: name, size: fs.statSync(full).size, sha256: createHash("sha256").update(fs.readFileSync(full)).digest("hex") };
  });
  return { schemaVersion: 1, runId: path.basename(runDir), name: options.name, seed: options.seed || "", config: options.config || "", exitCode, metricsRows, files, generatedAt: new Date().toISOString() };
}

function commandOutput(cmd: string, args: string[], cwd = process.cwd()): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function safeToken(value: string): string {
  return String(value || "run").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "run";
}

function shellLine(command: string[]): string {
  return command.map((item) => /[\s"']/.test(item) ? JSON.stringify(item) : item).join(" ");
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
