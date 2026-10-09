import { RequestBudgetConfig, defaultRequestBudgetConfig } from "./RequestBudget";

export const xshellTunnelConnectionMode = "xshell_tunnel_realtime" as const;

export type ClusterConnectionMode = typeof xshellTunnelConnectionMode | "offline_import";

export type RefreshProfile = "realtime" | "balanced" | "manual_only";

export interface TunnelGatewayConfig {
  enabled: boolean;
  connectionMode: ClusterConnectionMode;
  provider: "xshell";
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  hubServerId: string;
  tunnelStartMode: "manual" | "launch_external_app" | "generate_script";
  xshellExePath?: string;
  healthCheckIntervalSeconds: number;
  snapshotPollIntervalSeconds: number;
  maxRequestsPerMinute: number;
  allowStreaming: boolean;
  streamingRequiresExplicitConfirm: boolean;
  pauseWhenWebviewHidden: boolean;
  pauseAllBackgroundTraffic: boolean;
  refreshProfile: RefreshProfile;
  token?: string;
}

export interface RefreshProfileConfig {
  health: number;
  snapshot: number;
  stream: boolean;
}

export const refreshProfiles: Record<RefreshProfile, RefreshProfileConfig> = {
  realtime: { health: 5, snapshot: 30, stream: true },
  balanced: { health: 10, snapshot: 60, stream: true },
  manual_only: { health: 0, snapshot: 0, stream: false },
};

export const defaultTunnelGatewayConfig: TunnelGatewayConfig = {
  enabled: true,
  connectionMode: xshellTunnelConnectionMode,
  provider: "xshell",
  localHost: "127.0.0.1",
  localPort: 18765,
  remoteHost: "127.0.0.1",
  remotePort: 18765,
  hubServerId: "",
  tunnelStartMode: "manual",
  healthCheckIntervalSeconds: 30,
  snapshotPollIntervalSeconds: 30,
  maxRequestsPerMinute: 0,
  allowStreaming: true,
  streamingRequiresExplicitConfirm: false,
  pauseWhenWebviewHidden: true,
  pauseAllBackgroundTraffic: false,
  refreshProfile: "realtime",
};

function normalizeHost(value: unknown, fallback: string): string {
  const text = String(value || "").trim();
  if (!text) return fallback;
  assertLocalhost(text);
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
}
export function normalizeTunnelGatewayConfig(input: Partial<TunnelGatewayConfig> = {}): TunnelGatewayConfig {
  const localPort = normalizePort(input.localPort, defaultTunnelGatewayConfig.localPort);
  const remotePort = normalizePort(input.remotePort, defaultTunnelGatewayConfig.remotePort);
  return {
    ...defaultTunnelGatewayConfig,
    ...input,
    connectionMode: normalizeConnectionMode(input.connectionMode),
    provider: normalizeProvider(input.provider),
    localHost: normalizeHost((input as unknown as { localHost?: unknown }).localHost, defaultTunnelGatewayConfig.localHost),
    localPort,
    remoteHost: normalizeHost((input as unknown as { remoteHost?: unknown }).remoteHost, defaultTunnelGatewayConfig.remoteHost),
    remotePort,
    refreshProfile: input.refreshProfile && refreshProfiles[input.refreshProfile] ? input.refreshProfile : defaultTunnelGatewayConfig.refreshProfile,
    allowStreaming: input.refreshProfile === "manual_only" ? false : input.allowStreaming !== false,
  };
}

export function isRealtimeConnectionMode(mode: unknown): boolean {
  return mode === xshellTunnelConnectionMode;
}

export function normalizeConnectionMode(mode: unknown): ClusterConnectionMode {
  return mode === "offline_import" ? "offline_import" : xshellTunnelConnectionMode;
}

function normalizeProvider(provider: unknown): TunnelGatewayConfig["provider"] {
  return "xshell";
}

export function requestBudgetConfigFromTunnel(config: TunnelGatewayConfig): RequestBudgetConfig {
  return {
    ...defaultRequestBudgetConfig,
    maxRequestsPerMinute: 0,
    pauseWhenHidden: config.pauseWhenWebviewHidden,
  };
}

export function localBaseUrl(config: Pick<TunnelGatewayConfig, "localHost" | "localPort">): string {
  const host = normalizeHost((config as unknown as { localHost?: unknown }).localHost, "127.0.0.1");
  assertLocalhost(host);
  const authorityHost = host.includes(":") ? `[${host}]` : host;
  return `http://${authorityHost}:${normalizePort(config.localPort, defaultTunnelGatewayConfig.localPort)}`;
}

export function assertLocalhost(host: string): void {
  const text = String(host || "").trim();
  if (!text) throw new Error("Local endpoint host is required.");
  if (/[\s/\\?#@]/.test(text)) throw new Error("Local endpoint host contains invalid URL characters.");
  const bracketed = text.startsWith("[") || text.endsWith("]");
  if (bracketed && !(text.startsWith("[") && text.endsWith("]"))) throw new Error("IPv6 endpoint host brackets are incomplete.");
  const address = bracketed ? text.slice(1, -1) : text;
  const probe = address.includes(":") ? `[${address}]` : address;
  let parsed: URL;
  try { parsed = new URL(`http://${probe}/`); } catch { throw new Error("Local endpoint host is not a valid hostname or IP address."); }
  if (!parsed.hostname || parsed.port || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash)
    throw new Error("Local endpoint host must contain only a hostname or IP address.");
  if (bracketed && !address.includes(":")) throw new Error("Bracketed endpoint host must be IPv6.");
}

export function normalizePort(value: unknown, fallback: number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return fallback;
  return port;
}
