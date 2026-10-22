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
}

export interface ParsedCli {
  positionals: string[];
  flags: CliFlags;
}

const VALUE_FLAGS = new Set(["--status", "--limit", "--lines", "--experiment", "--format", "--seed", "--from", "--out", "--output", "--file", "--type", "--workflow", "--jobs", "--worker", "--gpu", "--operation", "--index", "--command"]);

export function parseArgv(argv: string[]): ParsedCli {
  const positionals: string[] = [];
  const flags: CliFlags = { json: false, compactJson: false, full: false, help: false, dryRun: false, check: false, watch: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--confirm") { flags.confirm = true; continue; }
    if (token === "--remaining") { flags.remaining = true; continue; }
    if (token === "--all") { flags.all = true; continue; }
    if (token === "--stop-running") { flags["stop-running"] = true; continue; }
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
