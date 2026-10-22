import { TunnelAction } from "./TunnelClient";

// Compatibility exports for old clients. Hub cannot deploy or execute any action.
export const hubControlActionEndpoints: readonly string[] = [];

export const hubControlRequiredEndpoints: readonly string[] = [];

export function isHubControlAction(action: unknown): action is TunnelAction {
  return false;
}

export function isHubOnlyApiPath(path: string): boolean {
  return path.startsWith("/api/actions/") || path.startsWith("/api/files/");
}
