import { usageError } from "./errors";

export interface CliFlags {
  json: boolean;
  compactJson: boolean;
  full: boolean;
  help: boolean;
  dryRun: boolean;
  check: boolean;
  watch: boolean;
  workflow?: string;
  operation?: string;
  jobs?: string;
  worker?: string;
  index?: string;
  command?: string;
  gpu?: string;
  confirm?: boolean;
  remaining?: boolean;
  all?: boolean;
  "stop-running"?: boolean;
  "path-confirmed"?: boolean;
  "set-active"?: boolean;
  "second-confirmation"?: boolean;
  "metadata-only"?: boolean;
  "no-recursive"?: boolean;
  instance?: string;
  plugin?: string;
  "instance-experiment"?: string;
  "instance-sftp"?: string;
  destination?: string;
  entries?: string;
  files?: string;
  manifest?: string;
  extensions?: string;
  "max-file-bytes"?: string;
  "max-batch-bytes"?: string;
  "max-file-size-mb"?: string;
  "memory-only"?: boolean;
  "metrics-only"?: boolean;
  overwrite?: boolean;
  directory?: boolean;
  "manual-retain"?: boolean;
  "delete-only"?: boolean;
  compression?: string;
  "single-stream"?: boolean;
  action?: string;
  token?: string;
  digest?: string;
  "consumer-root"?: string;
  target?: string;
  targets?: string;
  phase?: string;
  "observation-id"?: string;
  "read-concurrency"?: string;
  "tmux-session-prefix"?: string;
  "observation-mode"?: string;
  "root-identity"?: string;
  "confirmed-paths"?: boolean;
  force?: boolean;
  "environment-only"?: boolean;
  "completed-output-verify"?: boolean;
  "verified-only"?: boolean;
  "continuation-of"?: string;
  "reuse-token"?: string;
  job?: string;
  "exact-paths"?: string;
  "node-id"?: string;
  workspace?: string;
  mode?: string;
  hub?: string;
  workers?: string;
  "plan-id"?: string;
  "server-ids"?: string;
  "legacy-migration-digests"?: string;
  "migration-digests"?: string;
  "no-apply-topology"?: boolean;
  "start-sessions"?: boolean;
  "no-start-sessions"?: boolean;
  "auto-test"?: boolean;
  "no-auto-test"?: boolean;
  "skip-xshell"?: boolean;
  "skip-runtime"?: boolean;
  "reviewed-by"?: string;
  "confirmed-paths-file"?: string;
  "manifest-only"?: boolean;
  "presence-only"?: boolean;
  "allow-missing"?: boolean;
  "observe-executors"?: boolean;
  "project-dir"?: string;
  "install-dir"?: string;
  "state-dir"?: string;
  "worker-state-dir"?: string;
  "worker-id"?: string;
  host?: string;
  port?: string;
  "conda-env"?: string;
  "expected-version"?: string;
  "session-prefix"?: string;
  "tmux-session"?: string;
  "tmux-window"?: string;
  "migration-digest"?: string;
  "agent-token"?: string;
  paths?: string;
  "state-path"?: string;
  "plan-file"?: string;
  "confirmed-absolute"?: string;
  "remote-path"?: string;
  "transfer-id"?: string;
  "operation-id"?: string;
  "operation-instance-id"?: string;
  "retry-method"?: string;
  "retry-params"?: string;
  "request-key"?: string;
  reason?: string;
  status?: string;
  limit?: number;
  lines?: number;
  experiment?: string;
  format?: string;
  seed?: string;
  from?: string;
  out?: string;
  file?: string;
  type?: string;
  scope?: string;
  key?: string;
  value?: string;
  path?: string;
  suite?: string;
  base?: string;
  seeds?: string;
  primary?: string;
  preset?: string;
  metrics?: string;
}

export interface ParsedCli {
  positionals: string[];
  flags: CliFlags;
}

const VALUE_FLAGS = new Set(["--scope", "--status", "--limit", "--lines", "--experiment", "--format", "--seed", "--from", "--out", "--output", "--file", "--type", "--workflow", "--jobs", "--worker", "--gpu", "--operation", "--index", "--command", "--key", "--value", "--path", "--suite", "--base", "--seeds", "--primary", "--preset", "--metrics", "--instance", "--paths", "--state-path", "--plan-file", "--confirmed-absolute", "--remote-path", "--transfer-id", "--operation-id", "--operation-instance-id", "--retry-method", "--retry-params", "--request-key", "--reason", "--plugin", "--instance-experiment", "--instance-sftp", "--destination", "--entries", "--files", "--manifest", "--extensions", "--max-file-bytes", "--max-batch-bytes", "--max-file-size-mb", "--compression", "--action", "--token", "--digest", "--consumer-root", "--target", "--targets", "--phase", "--observation-id", "--read-concurrency", "--tmux-session-prefix", "--observation-mode", "--root-identity", "--project-dir", "--install-dir", "--state-dir", "--worker-state-dir", "--worker-id", "--host", "--port", "--conda-env", "--expected-version", "--session-prefix", "--tmux-session", "--tmux-window", "--migration-digest", "--agent-token", "--reviewed-by", "--confirmed-paths-file", "--continuation-of", "--reuse-token", "--job", "--exact-paths", "--node-id", "--workspace", "--mode", "--hub", "--workers", "--plan-id", "--server-ids", "--legacy-migration-digests", "--migration-digests"]);

export function parseArgv(argv: string[]): ParsedCli {
  const positionals: string[] = [];
  const flags: CliFlags = { json: false, compactJson: false, full: false, help: false, dryRun: false, check: false, watch: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--confirm") { flags.confirm = true; continue; }
    if (token === "--remaining") { flags.remaining = true; continue; }
    if (token === "--all") { flags.all = true; continue; }
    if (token === "--stop-running") { flags["stop-running"] = true; continue; }
    if (token === "--path-confirmed") { flags["path-confirmed"] = true; continue; }
    if (token === "--set-active") { flags["set-active"] = true; continue; }
    if (token === "--second-confirmation") { flags["second-confirmation"] = true; continue; }
    if (token === "--metadata-only") { flags["metadata-only"] = true; continue; }
    if (token === "--no-recursive") { flags["no-recursive"] = true; continue; }
    if (token === "--memory-only") { flags["memory-only"] = true; continue; }
    if (token === "--metrics-only") { flags["metrics-only"] = true; continue; }
    if (token === "--overwrite") { flags.overwrite = true; continue; }
    if (token === "--directory") { flags.directory = true; continue; }
    if (token === "--manual-retain") { flags["manual-retain"] = true; continue; }
    if (token === "--delete-only") { flags["delete-only"] = true; continue; }
    if (token === "--single-stream") { flags["single-stream"] = true; continue; }
    if (token === "--confirmed-paths") { flags["confirmed-paths"] = true; continue; }
    if (token === "--manifest-only") { flags["manifest-only"] = true; continue; }
    if (token === "--presence-only") { flags["presence-only"] = true; continue; }
    if (token === "--allow-missing") { flags["allow-missing"] = true; continue; }
    if (token === "--observe-executors") { flags["observe-executors"] = true; continue; }
    if (token === "--force") { flags.force = true; continue; }
    if (token === "--environment-only") { flags["environment-only"] = true; continue; }
    if (token === "--completed-output-verify") { flags["completed-output-verify"] = true; continue; }
    if (token === "--verified-only") { flags["verified-only"] = true; continue; }
    if (token === "--no-apply-topology") { flags["no-apply-topology"] = true; continue; }
    if (token === "--start-sessions") { flags["start-sessions"] = true; continue; }
    if (token === "--no-start-sessions") { flags["no-start-sessions"] = true; continue; }
    if (token === "--auto-test") { flags["auto-test"] = true; continue; }
    if (token === "--no-auto-test") { flags["no-auto-test"] = true; continue; }
    if (token === "--skip-xshell") { flags["skip-xshell"] = true; continue; }
    if (token === "--skip-runtime") { flags["skip-runtime"] = true; continue; }
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--compact-json") {
      flags.json = true;
      flags.compactJson = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      flags.help = true;
      continue;
    }
    if (token === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (token === "--check") {
      flags.check = true;
      continue;
    }
    if (token === "--watch") {
      flags.watch = true;
      continue;
    }
    if (token === "--full") {
      flags.full = true;
      continue;
    }
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq > 2) {
      applyFlag(flags, token.slice(0, eq), token.slice(eq + 1));
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw usageError(`missing value for ${token}`);
      applyFlag(flags, token, value);
      i += 1;
      continue;
    }
    if (token.startsWith("-")) throw usageError(`unknown option: ${token}`);
    positionals.push(token);
  }
  return { positionals, flags };
}

function applyFlag(flags: CliFlags, name: string, value: string): void {
  if (name === "--index") { flags.index = value; return; }
  if (name === "--command") { flags.command = value; return; }
  if (name === "--operation") { flags.operation = value; return; }
  if (["--workflow", "--jobs", "--worker", "--gpu"].includes(name)) { flags[name.slice(2) as "workflow" | "jobs" | "worker" | "gpu"] = value; return; }
  if (name === "--status") flags.status = value;
  else if (name === "--limit" || name === "--lines") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw usageError(`invalid ${name}: ${value}`);
    if (name === "--limit") flags.limit = parsed;
    else flags.lines = parsed;
  } else if (name === "--experiment") flags.experiment = value;
  else if (name === "--format") flags.format = value;
  else if (name === "--seed") flags.seed = value;
  else if (name === "--from") flags.from = value;
  else if (name === "--out" || name === "--output") flags.out = value;
  else if (name === "--file") flags.file = value;
  else if (name === "--suite") flags.suite = value;
  else if (name === "--base") flags.base = value;
  else if (name === "--seeds") flags.seeds = value;
  else if (name === "--primary") flags.primary = value;
  else if (name === "--preset") flags.preset = value;
  else if (name === "--metrics") flags.metrics = value;
  else if (name === "--key") flags.key = value;
  else if (name === "--value") flags.value = value;
  else if (name === "--scope") flags.scope = value;
  else if (name === "--path") flags.path = value;
  else if (name === "--instance") flags.instance = value;
  else if (name === "--plugin") flags.plugin = value;
  else if (name === "--instance-experiment") flags["instance-experiment"] = value;
  else if (name === "--instance-sftp") flags["instance-sftp"] = value;
  else if (name === "--destination") flags.destination = value;
  else if (name === "--entries") flags.entries = value;
  else if (name === "--files") flags.files = value;
  else if (name === "--manifest") flags.manifest = value;
  else if (name === "--extensions") flags.extensions = value;
  else if (name === "--max-file-bytes") flags["max-file-bytes"] = value;
  else if (name === "--max-batch-bytes") flags["max-batch-bytes"] = value;
  else if (name === "--max-file-size-mb") flags["max-file-size-mb"] = value;
  else if (name === "--compression") flags.compression = value;
  else if (name === "--action") flags.action = value;
  else if (name === "--token") flags.token = value;
  else if (name === "--digest") flags.digest = value;
  else if (name === "--consumer-root") flags["consumer-root"] = value;
  else if (name === "--target") flags.target = value;
  else if (name === "--targets") flags.targets = value;
  else if (name === "--phase") flags.phase = value;
  else if (name === "--observation-id") flags["observation-id"] = value;
  else if (name === "--read-concurrency") flags["read-concurrency"] = value;
  else if (name === "--tmux-session-prefix") flags["tmux-session-prefix"] = value;
  else if (name === "--observation-mode") flags["observation-mode"] = value;
  else if (name === "--root-identity") flags["root-identity"] = value;
  else if (name === "--project-dir") flags["project-dir"] = value;
  else if (name === "--install-dir") flags["install-dir"] = value;
  else if (name === "--state-dir") flags["state-dir"] = value;
  else if (name === "--worker-state-dir") flags["worker-state-dir"] = value;
  else if (name === "--worker-id") flags["worker-id"] = value;
  else if (name === "--host") flags.host = value;
  else if (name === "--port") flags.port = value;
  else if (name === "--conda-env") flags["conda-env"] = value;
  else if (name === "--expected-version") flags["expected-version"] = value;
  else if (name === "--session-prefix") flags["session-prefix"] = value;
  else if (name === "--tmux-session") flags["tmux-session"] = value;
  else if (name === "--tmux-window") flags["tmux-window"] = value;
  else if (name === "--migration-digest") flags["migration-digest"] = value;
  else if (name === "--agent-token") flags["agent-token"] = value;
  else if (name === "--reviewed-by") flags["reviewed-by"] = value;
  else if (name === "--confirmed-paths-file") flags["confirmed-paths-file"] = value;
  else if (name === "--continuation-of") flags["continuation-of"] = value;
  else if (name === "--reuse-token") flags["reuse-token"] = value;
  else if (name === "--job") flags.job = value;
  else if (name === "--exact-paths") flags["exact-paths"] = value;
  else if (name === "--node-id") flags["node-id"] = value;
  else if (name === "--workspace") flags.workspace = value;
  else if (name === "--mode") flags.mode = value;
  else if (name === "--hub") flags.hub = value;
  else if (name === "--workers") flags.workers = value;
  else if (name === "--plan-id") flags["plan-id"] = value;
  else if (name === "--server-ids") flags["server-ids"] = value;
  else if (name === "--legacy-migration-digests") flags["legacy-migration-digests"] = value;
  else if (name === "--migration-digests") flags["migration-digests"] = value;
  else if (name === "--paths") flags.paths = value;
  else if (name === "--state-path") flags["state-path"] = value;
  else if (name === "--plan-file") flags["plan-file"] = value;
  else if (name === "--confirmed-absolute") flags["confirmed-absolute"] = value;
  else if (name === "--remote-path") flags["remote-path"] = value;
  else if (name === "--transfer-id") flags["transfer-id"] = value;
  else if (name === "--operation-id") flags["operation-id"] = value;
  else if (name === "--operation-instance-id") flags["operation-instance-id"] = value;
  else if (name === "--retry-method") flags["retry-method"] = value;
  else if (name === "--retry-params") flags["retry-params"] = value;
  else if (name === "--request-key") flags["request-key"] = value;
  else if (name === "--reason") flags.reason = value;
  else if (name === "--type") {
    if (!["workflow", "worker_run"].includes(value)) throw usageError(`invalid --type: ${value}`);
    flags.type = value;
  }
  else throw usageError(`unknown option: ${name}`);
}

export function requirePositional(positionals: string[], index: number, name: string): string {
  const raw = String(positionals[index] || "");
  const value = process.platform === "win32" ? raw.trim() : raw;
  if (!value) throw usageError(`missing ${name}`);
  return value;
}
