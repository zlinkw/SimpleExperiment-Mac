import * as fs from "node:fs";
import { callApi } from "../api";
import { EXIT_BUSINESS, EXIT_OK, usageError } from "../errors";
import { writeJson } from "../format";
import { CliFlags } from "../parse";

export async function emitRpc(method: string, params: Record<string, unknown> = {}): Promise<number> {
  const result = await callApi(method, params);
  writeJson(result);
  return result && typeof result === "object" && !Array.isArray(result)
    && (result as Record<string, unknown>).ok === false ? EXIT_BUSINESS : EXIT_OK;
}

function jsonFile(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw usageError(`invalid JSON file ${file}: ${error instanceof Error ? error.message : String(error)}`); }
}
function objectFile(file: string | undefined): Record<string, unknown> {
  if (!file) throw usageError("requires --file <parameters.json>");
  const value = jsonFile(file);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("--file must contain a JSON object");
  return value as Record<string, unknown>;
}
function only(params: Record<string, unknown>, fields: string[]): void {
  const unknown = Object.keys(params).filter(key => !fields.includes(key));
  if (unknown.length) throw usageError("unsupported fields: " + unknown.join(", "));
}
function key(rest: string[], flags: CliFlags): string {
  if (rest.length > 1) throw usageError("expected one key");
  const value = rest[0] || flags.key;
  if (!value || !value.trim()) throw usageError("requires a key");
  return value;
}

/** Fixed named methods; validates local arguments before discovering either plugin. */
export async function controlCommand(domain: string, action: string, rest: string[], flags: CliFlags): Promise<number> {
  if (domain === "config" || domain === "state") {
    if (action === "snapshot" && domain === "state") {
      if (rest.length) throw usageError("state snapshot takes no arguments");
      return emitRpc("state");
    }
    if (!["list", "get", "set", "reset"].includes(action)) throw usageError(`unknown ${domain} action: ${action}`);
    if (action === "list") {
      if (rest.length) throw usageError(`${domain} list takes no arguments`);
      return emitRpc(domain + ".list");
    }
    const params: Record<string, unknown> = { key: key(rest, flags) };
    if (domain === "config" && flags.scope) {
      if (!["global", "workspace", "workspaceFolder"].includes(flags.scope)) throw usageError("--scope must be global|workspace|workspaceFolder");
      params.scope = flags.scope;
    }
    if (action === "set") {
      if (flags.file && flags.value !== undefined) throw usageError("choose --file or --value");
      if (flags.file) params.value = jsonFile(flags.file);
      else if (flags.value !== undefined) {
        try { params.value = JSON.parse(flags.value); } catch { params.value = flags.value; }
      } else throw usageError("set requires --value <JSON or text> or --file <value.json>");
    }
    if (flags.confirm === true) params.confirm = true;
    return emitRpc(domain + "." + action, params);
  }
  if (domain === "flow") {
    if (rest.length) throw usageError("flow takes no positional arguments");
    if (action === "get") return emitRpc("flow.get");
    if (action !== "update") throw usageError("flow supports get|update");
    const params = objectFile(flags.file);
    only(params, ["step", "completed", "blocked", "appliedAt"]);
    if (typeof params.step !== "string" || !params.step.trim()) throw usageError("flow update requires step");
    for (const flag of ["completed", "blocked"]) if (params[flag] !== undefined && typeof params[flag] !== "boolean") throw usageError(flag + " must be boolean");
    if (params.completed === true && params.blocked === true) throw usageError("completed and blocked are mutually exclusive");
    if (params.appliedAt !== undefined && typeof params.appliedAt !== "string") throw usageError("appliedAt must be text");
    return emitRpc("flow.update", params);
  }
  if (domain === "tmux") {
    if (!["list", "capture"].includes(action)) throw usageError("tmux supports list|capture");
    if (!flags.worker) throw usageError("tmux requires --worker <id>");
    if (rest.length > (action === "capture" ? 1 : 0)) throw usageError("unexpected tmux argument");
    const params: Record<string, unknown> = { workerId: flags.worker };
    if (action === "capture") {
      const window = rest[0] || flags["tmux-window"];
      if (!window) throw usageError("tmux capture requires an explicit window");
      params.window = window;
    }
    return emitRpc("tmux." + action, params);
  }
  if (rest.length) throw usageError("unexpected positional arguments");
  if (domain === "gpu" && action === "history") return emitRpc("gpu.history");
  if (domain === "panel" && action === "diagnostics") return emitRpc("panel.diagnostics");
  if (domain === "server" && action === "test-all") {
    const params = flags.file ? objectFile(flags.file) : {};
    only(params, ["refresh"]);
    if (params.refresh !== undefined && typeof params.refresh !== "boolean") throw usageError("refresh must be boolean");
    return emitRpc("server.testAll", params);
  }
  if (domain === "plan" && action === "filter") return emitRpc("plans.filter", objectFile(flags.file));
  throw usageError(`unknown command: ${domain} ${action}`);
}
