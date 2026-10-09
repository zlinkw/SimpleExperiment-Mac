import { apiRequest, readApiDiscovery } from "../cli.legacy";
import { asCliError, envError, networkError } from "./errors";

export function hasApiDiscovery(): boolean {
  try {
    readApiDiscovery();
    return true;
  } catch {
    return false;
  }
}

export function discoveryOrNull(): Record<string, unknown> | null {
  try {
    return readApiDiscovery();
  } catch {
    return null;
  }
}

export async function callApi(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  let discovery: Record<string, unknown>;
  try {
    discovery = readApiDiscovery();
  } catch (error) {
    throw asCliError(error, 2);
  }
  try {
    const result = await apiRequest(discovery, method, params) as { error?: { code?: unknown; message?: unknown; data?: unknown }; result?: unknown };
    if (result.error) {
      const message = String(result.error.message || "API error");
      const detail = JSON.stringify(result.error.data ?? result.error);
      if (Number(result.error.code) === 2001) throw envError(message, detail);
      throw asCliError(new Error(message), 3);
    }
    return result.result;
  } catch (error) {
    if ((error as { exitCode?: number }).exitCode) throw error;
    throw asCliError(error, 4);
  }
}

export async function optionalApi(method: string, params: Record<string, unknown> = {}): Promise<unknown | null> {
  if (!hasApiDiscovery()) return null;
  try {
    return await callApi(method, params);
  } catch (error) {
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
