import { asCliError, businessError, envError, networkError } from "./errors";
import { callPluginRpc, pluginDiscoveryPath } from "./LocalApiClient";
import * as fs from "node:fs";

// CLI --instance wins over SIMPLE_CLI_INSTANCE_ID; set once by runSimpleCli before any dispatch.
let cliInstancePin = "";
let cliWorkspace = "";
export function setApiWorkspace(value: string): void { cliWorkspace = String(value || "").trim(); }
export function setInstancePin(value: string): void {
  cliInstancePin = String(value || "").trim();
}

export function hasApiDiscovery(): boolean {
  try {
    return fs.existsSync(pluginDiscoveryPath("experiment"));
  } catch {
    return false;
  }
}

export function discoveryOrNull(): Record<string, unknown> | null {
  try {
    const file = pluginDiscoveryPath("experiment");
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Every SimpleExperiment-domain call runs through the unified transport: plugin-slot binding,
 * live instance handshake, retired/undeclared method refusal, and bounded or proven-unbounded
 * timeouts. No A-domain path bypasses it any more.
 */
export async function callApi(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  try {
    return await callPluginRpc("experiment", method, params, cliInstancePin || undefined, cliWorkspace ? { workspace: cliWorkspace } : undefined);
  } catch (error) {
    const rpc = error as { apiCode?: number; apiData?: unknown; message?: string };
    if (Number(rpc.apiCode) === 2001) throw envError(String(rpc.message || "CONFIRM_REQUIRED"), JSON.stringify(rpc.apiData ?? {}));
    if (Number(rpc.apiCode) === -32001 || Number(rpc.apiCode) === -32601) {
      // Keep the JSON-RPC code attached so optional callers can tell "not declared here" (-32601)
      // from a retired refusal (-32001, always fatal); the public exit stays BUSINESS(3).
      const refusal = businessError(String(rpc.message || "API refusal"), rpc.apiData === null || rpc.apiData === undefined ? "" : JSON.stringify(rpc.apiData));
      (refusal as { apiCode?: number }).apiCode = Number(rpc.apiCode);
      throw refusal;
    }
    if ((error as { exitCode?: number }).exitCode) throw error;
    if (Number.isFinite(Number(rpc.apiCode))) throw businessError(String(rpc.message || "API error"), rpc.apiData === null || rpc.apiData === undefined ? "" : JSON.stringify(rpc.apiData));
    throw asCliError(error, 4);
  }
}

export async function optionalApi(method: string, params: Record<string, unknown> = {}): Promise<unknown | null> {
  if (!hasApiDiscovery()) return null;
  try {
    return await callApi(method, params);
  } catch (error) {
    // A method this live instance never declared is an absent optional enrichment, like being
    // offline: the merged local view stands. Retired methods and business refusals still throw.
    if (Number((error as { apiCode?: number }).apiCode) === -32601) return null;
    const mapped = asCliError(error, 4);
    if (mapped.exitCode === 4) return null;
    if (mapped.exitCode === 2) return null;
    throw mapped;
  }
}

export function tunnelEndpointFromConfig(config: Record<string, unknown> | null | undefined): { localHost: string; localPort: number } | null {
  if (!config) return null;
  const host = firstString(config, ["localForwardHost", "localHost", "host"]);
  const port = Number(config.localForwardPort ?? config.localPort ?? config.port);
  if (!host || !Number.isInteger(port) || port <= 0) return null;
  return { localHost: host, localPort: port };
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function classifyApiFailure(error: unknown): never {
  const mapped = asCliError(error, 4);
  if (mapped.exitCode === 4) throw networkError(mapped.message, mapped.detail);
  throw mapped;
}
