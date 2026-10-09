import { tunnelActions, TunnelAction } from "./TunnelClient";

export const hubControlActionEndpoints = tunnelActions.map((action) => `/api/actions/${action}` as const);

export const hubControlRequiredEndpoints = [
  "/api/health",
  "/api/capabilities",
  "/api/snapshot",
  "/api/gpu",
  "/api/scheduler",
  "/api/traces",
  "/api/results/summary",
  "/api/diagnostics",
  "/api/audit/tail",
  "WS /api/events?since=<seq>",
  "GET /api/events/sse?since=<seq>",
  "GET /api/files/list?path=<path>",
  "GET /api/files/download?path=<path>",
  "POST /api/files/upload/init",
  "POST /api/files/upload/chunk",
  "POST /api/files/upload/complete",
  ...hubControlActionEndpoints,
] as const;

export function isHubControlAction(action: unknown): action is TunnelAction {
  return tunnelActions.includes(action as TunnelAction);
}

export function isHubOnlyApiPath(path: string): boolean {
  return path.startsWith("/api/actions/") || path.startsWith("/api/files/");
}