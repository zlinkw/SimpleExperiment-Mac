/** Assemble realtime endpoints from the resolved per-server tunnel configuration. */

import { buildTunnelEndpointRegistry } from "../tunnel/TunnelEndpointRegistry";
import {
  normalizeXshellSetupConfig,
  workerTunnelToXshellSetupConfig,
  XshellRealtimeTunnelConfig,
} from "../tunnel/XshellTunnelSetup";

export interface RealtimeEndpoint {
  readonly id: string;
  readonly role: "hub" | "worker";
  readonly displayName: string;
  readonly localHost: string;
  readonly localPort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
  readonly token: string;
  readonly timeoutMs: number;
  readonly capabilities: unknown;
}

export interface TunnelLaunchItem {
  readonly id: string;
  readonly role: "hub" | "worker";
  readonly config: XshellRealtimeTunnelConfig;
}

export interface RealtimeDeps {
  readonly setupConfig: XshellRealtimeTunnelConfig;
  readonly tunnelConfig: { token?: unknown };
  readonly lastProbe?: unknown;
  readonly lastWorkerProbes: Record<string, unknown>;
  readonly topology: { hubAllowed: boolean; mode: string };
}

function endpointCapabilitiesFromProbe(probe: unknown): unknown {
  if (!probe || typeof probe !== "object") return [];
  const capabilities = (probe as Record<string, unknown>).capabilities;
  return Array.isArray(capabilities) ? capabilities : capabilities && typeof capabilities === "object" ? capabilities : [];
}

export function buildRealtimeEndpoints(deps: RealtimeDeps): RealtimeEndpoint[] {
  const registry = buildTunnelEndpointRegistry(deps.setupConfig, {
    hub: deps.lastProbe,
    ...(deps.lastWorkerProbes || {}),
  });
  const token = String(deps.tunnelConfig?.token || "");
  return registry.endpoints
    .filter((endpoint) => endpoint.enabled && (deps.topology.hubAllowed || endpoint.role !== "hub_control"))
    .map((endpoint) => {
      const localHost = String(endpoint.tunnel.localHost || "").trim();
      const remoteHost = String(endpoint.tunnel.remoteHost || "").trim();
      const localPort = Number(endpoint.tunnel.localPort);
      const remotePort = Number(endpoint.tunnel.remotePort);
      if (!endpoint.id || !localHost || !remoteHost || !Number.isInteger(localPort) || localPort <= 0
        || !Number.isInteger(remotePort) || remotePort <= 0) {
        throw new Error(`隧道端点 ${endpoint.id || "unknown"} 配置不完整，拒绝创建实时客户端。`);
      }
      return {
        id: endpoint.id,
        role: endpoint.role === "hub_control" ? "hub" : "worker",
        displayName: endpoint.displayName,
        localHost,
        localPort,
        remoteHost,
        remotePort,
        token,
        timeoutMs: 8000,
        capabilities: endpointCapabilitiesFromProbe(endpoint.lastProbe),
      };
    });
}

export function buildTunnelLaunchItems(deps: RealtimeDeps): TunnelLaunchItem[] {
  const base = normalizeXshellSetupConfig(deps.setupConfig);
  const items: TunnelLaunchItem[] = [];
  if (deps.topology.hubAllowed) {
    items.push({
      id: "hub",
      role: "hub",
      config: normalizeXshellSetupConfig({
        ...base,
        workerRealtimeMode: "hub_only",
        workerTelemetryMode: "hub_only",
        workerTunnels: [],
      }),
    });
  }
  for (const worker of base.workerTunnels) {
    if (worker.enabled === false) continue;
    items.push({
      id: worker.id,
      role: "worker",
      config: workerTunnelToXshellSetupConfig(base, worker),
    });
  }
  return items;
}

export function buildAgentLaunchItems(deps: RealtimeDeps): Array<{ id: string; role: "hub" | "worker"; displayName: string; sessionPath: string }> {
  return buildTunnelLaunchItems(deps)
    .filter((item) => Boolean(item.config.savedSessionPath))
    .map((item) => ({
      id: `${item.id}-agent`,
      role: item.role,
      displayName: `${item.id} Agent`,
      sessionPath: String(item.config.savedSessionPath || ""),
    }));
}

export function buildRealtimeStateSnapshot(deps: RealtimeDeps): Record<string, unknown> {
  return {
    endpoints: buildRealtimeEndpoints(deps),
    launchItems: buildTunnelLaunchItems(deps),
    agentLaunchItems: buildAgentLaunchItems(deps),
    hubAllowed: deps.topology.hubAllowed === true,
    topologyMode: String(deps.topology.mode || ""),
  };
}

export class ProviderRealtime {
  constructor(private readonly deps: RealtimeDeps) {}
  realtimeEndpoints(): RealtimeEndpoint[] { return buildRealtimeEndpoints(this.deps); }
  tunnelLaunchItems(): TunnelLaunchItem[] { return buildTunnelLaunchItems(this.deps); }
  agentLaunchItems() { return buildAgentLaunchItems(this.deps); }
  snapshot() { return buildRealtimeStateSnapshot(this.deps); }
}
