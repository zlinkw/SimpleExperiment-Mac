/**
 * RealtimeClientFactory - 实时客户端工厂
 * 封装 RequestBudget / RealtimeTunnelClient / MultiEndpointRealtimeClient 的创建
 * P0：endpoints 的 localPort 必须来自 TunnelFactory 分配结果，不得在工厂内 default 赋字面量
 * 遵循 docs/architecture-factory-refactor-plan.md §3.4
 */

import type { FactoryContext } from "./types";

// ---------- 强类型动态 require 访问器 ----------
function tryRequire<T>(id: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return undefined;
  }
}

type TunnelGatewayMod = {
  refreshProfiles?: Record<string, RefreshProfileConfig>;
  localBaseUrl?: (cfg: { localHost: string; localPort: number }) => string;
};

type RequestBudgetMod = {
  RequestBudget?: new (cfg: unknown) => unknown;
  defaultRequestBudgetConfig?: unknown;
};

type RealtimeTunnelClientMod = {
  RealtimeTunnelClient?: new (
    endpoint: { localHost: string; localPort: number; [key: string]: unknown },
    budget: unknown,
    policy: RealtimeRefreshPolicy,
    onState: (s: unknown) => void,
  ) => unknown;
};

type MultiEndpointRealtimeClientMod = {
  MultiEndpointRealtimeClient?: new (
    endpoints: NamedTunnelEndpointConfig[],
    budgetFactory: (e: NamedTunnelEndpointConfig) => unknown,
    policy: RealtimeRefreshPolicy,
    onState: (s: unknown) => void,
  ) => unknown;
};

function getTunnelGateway(): TunnelGatewayMod | undefined {
  return tryRequire<TunnelGatewayMod>("../tunnel/TunnelGateway");
}

function getRequestBudgetMod(): RequestBudgetMod | undefined {
  return tryRequire<RequestBudgetMod>("../tunnel/RequestBudget");
}

function getSingleClientMod(): RealtimeTunnelClientMod | undefined {
  return tryRequire<RealtimeTunnelClientMod>("../tunnel/RealtimeTunnelClient");
}

function getMultiClientMod(): MultiEndpointRealtimeClientMod | undefined {
  return tryRequire<MultiEndpointRealtimeClientMod>("../tunnel/MultiEndpointRealtimeClient");
}

export interface NamedTunnelEndpointConfig {
  id: string;
  role: "hub" | "worker";
  displayName?: string;
  localHost: string;
  localPort: number;
  remoteHost?: string;
  remotePort?: number;
  [key: string]: unknown;
}

export interface RefreshProfileConfig {
  health: number;
  snapshot: number;
  stream: boolean;
}

export interface RealtimeRefreshPolicy {
  mode: "realtime" | "balanced" | "manual_only";
  [key: string]: unknown;
}

export interface RealtimeClientFactory {
  createBudget(endpoint: NamedTunnelEndpointConfig): unknown;
  createSingleClient(
    endpoint: { localHost: string; localPort: number; [key: string]: unknown },
    budget: unknown,
    policy: RealtimeRefreshPolicy,
    onState: (s: unknown) => void,
  ): unknown;
  createMultiClient(
    endpoints: NamedTunnelEndpointConfig[],
    budgetFactory: (e: NamedTunnelEndpointConfig) => unknown,
    policy?: RealtimeRefreshPolicy,
    onState?: (s: unknown) => void,
  ): unknown;
  policyForProfile(profile: string): RealtimeRefreshPolicy;
  createAll(ctx: FactoryContext): unknown[];
  createByName(name: string, ctx: FactoryContext): unknown | undefined;
}

function resolvePolicyForProfile(profile: string): RealtimeRefreshPolicy {
  const gw = getTunnelGateway();
  if (gw?.refreshProfiles) {
    const cfg = gw.refreshProfiles[profile] as RefreshProfileConfig | undefined;
    if (cfg) {
      return {
        mode: profile as RealtimeRefreshPolicy["mode"],
        preferWebSocket: cfg.stream,
        fallbackToSse: cfg.stream,
        fallbackToPolling: true,
        heartbeatIntervalSeconds: cfg.health,
        snapshotFallbackIntervalSeconds: cfg.snapshot,
        pauseWhenWebviewHidden: false,
      } as RealtimeRefreshPolicy;
    }
  }
  const isManual = profile === "manual_only";
  const isBalanced = profile === "balanced";
  return {
    mode: (isManual ? "manual_only" : isBalanced ? "balanced" : "realtime") as RealtimeRefreshPolicy["mode"],
    preferWebSocket: !isManual,
    fallbackToSse: !isManual,
    fallbackToPolling: true,
    heartbeatIntervalSeconds: isManual ? 0 : isBalanced ? 10 : 5,
    snapshotFallbackIntervalSeconds: isManual ? 0 : isBalanced ? 60 : 30,
    pauseWhenWebviewHidden: false,
  } as RealtimeRefreshPolicy;
}

export class DefaultRealtimeClientFactory implements RealtimeClientFactory {
  private readonly deps: Record<string, unknown>;
  constructor(deps: Record<string, unknown> = {}) {
    this.deps = deps;
  }

  createBudget(endpoint: NamedTunnelEndpointConfig): unknown {
    if (!String(endpoint?.id || "").trim()) throw new Error("RequestBudget requires a configured endpoint id.");
    const mod = getRequestBudgetMod();
    if (mod?.RequestBudget) {
      const cfg = (this.deps["requestBudgetConfig"] as unknown) ?? mod.defaultRequestBudgetConfig;
      return new mod.RequestBudget(cfg);
    }
    throw new Error(`RequestBudget implementation unavailable for endpoint ${endpoint.id}; refusing an unbounded fallback.`);
  }

  createSingleClient(
    endpoint: { localHost: string; localPort: number; [key: string]: unknown },
    budget: unknown,
    policy: RealtimeRefreshPolicy,
    onState: (s: unknown) => void,
  ): unknown {
    this.assertEndpoint(endpoint as NamedTunnelEndpointConfig);
    const mod = getSingleClientMod();
    if (mod?.RealtimeTunnelClient) {
      return new mod.RealtimeTunnelClient(endpoint, budget, policy, onState);
    }
    throw new Error(`RealtimeTunnelClient implementation unavailable for endpoint ${String(endpoint.id || "unknown")}.`);
  }

  createMultiClient(
    endpoints: NamedTunnelEndpointConfig[],
    budgetFactory: (e: NamedTunnelEndpointConfig) => unknown,
    policy?: RealtimeRefreshPolicy,
    onState?: (s: unknown) => void,
  ): unknown {
    if (!Array.isArray(endpoints) || !endpoints.length) throw new Error("MultiEndpointRealtimeClient requires at least one configured endpoint.");
    for (const endpoint of endpoints) this.assertEndpoint(endpoint);
    const mod = getMultiClientMod();
    if (mod?.MultiEndpointRealtimeClient) {
      const effPolicy = policy ?? resolvePolicyForProfile("realtime");
      const handler: (s: unknown) => void = onState ?? (() => undefined);
      return new mod.MultiEndpointRealtimeClient(endpoints, budgetFactory, effPolicy, handler);
    }
    throw new Error(`MultiEndpointRealtimeClient implementation unavailable for ${endpoints.length} configured endpoint(s).`);
  }

  policyForProfile(profile: string): RealtimeRefreshPolicy {
    return resolvePolicyForProfile(profile);
  }

  createAll(ctx: FactoryContext): unknown[] {
    const endpoints = this.configuredEndpoints(ctx);
    const policy = this.policyForProfile(String(ctx["refreshProfile"] || this.deps["refreshProfile"] || "realtime"));
    const onState = (ctx["onRealtimeState"] || this.deps["onState"] || (() => undefined)) as (state: unknown) => void;
    return [this.createMultiClient(endpoints, (endpoint) => this.createBudget(endpoint), policy, onState)];
  }

  createByName(name: string, ctx: FactoryContext): unknown | undefined {
    const policy = this.policyForProfile(String(ctx["refreshProfile"] || this.deps["refreshProfile"] || "realtime"));
    const map: Record<string, () => unknown> = {
      budget: () => this.createBudget(this.configuredEndpoint(ctx)),
      singleClient: () => {
        const endpoint = this.configuredEndpoint(ctx);
        return this.createSingleClient(endpoint, this.createBudget(endpoint), policy, this.stateHandler(ctx));
      },
      multiClient: () => this.createMultiClient(this.configuredEndpoints(ctx), (e) => this.createBudget(e), policy, this.stateHandler(ctx)),
      policyRealtime: () => this.policyForProfile("realtime"),
      policyBalanced: () => this.policyForProfile("balanced"),
      policyManual: () => this.policyForProfile("manual_only"),
    };
    const fn = map[name];
    return fn ? fn() : undefined;
  }

  private configuredEndpoints(ctx: FactoryContext): NamedTunnelEndpointConfig[] {
    const candidate = this.deps["endpoints"] ?? ctx["realtimeEndpoints"] ?? ctx["endpoints"];
    if (!Array.isArray(candidate) || !candidate.length) throw new Error("RealtimeClientFactory needs endpoints resolved from the user's tunnel configuration.");
    const endpoints = candidate.map((value) => this.assertEndpoint(value as NamedTunnelEndpointConfig));
    if (new Set(endpoints.map((endpoint) => endpoint.id)).size !== endpoints.length) throw new Error("Realtime endpoint ids must be unique.");
    return endpoints;
  }

  private configuredEndpoint(ctx: FactoryContext): NamedTunnelEndpointConfig {
    const explicit = this.deps["endpoint"] ?? ctx["realtimeEndpoint"] ?? ctx["endpoint"];
    if (explicit) return this.assertEndpoint(explicit as NamedTunnelEndpointConfig);
    const endpoints = this.configuredEndpoints(ctx);
    const id = String(ctx["endpointId"] ?? this.deps["endpointId"] ?? "");
    const selected = id ? endpoints.find((row) => row.id === id) : endpoints.length === 1 ? endpoints[0] : undefined;
    if (!selected) throw new Error("A specific configured endpoint is required when creating a single tunnel client or budget.");
    return selected;
  }

  private stateHandler(ctx: FactoryContext): (state: unknown) => void {
    const handler = ctx["onRealtimeState"] ?? this.deps["onState"];
    return typeof handler === "function" ? handler as (state: unknown) => void : () => undefined;
  }

  private assertEndpoint(value: NamedTunnelEndpointConfig): NamedTunnelEndpointConfig {
    if (!value || typeof value !== "object" || !String(value.id || "").trim() || !["hub", "worker"].includes(value.role))
      throw new Error("Tunnel endpoint requires a stable id and supported role.");
    const localHost = String(value.localHost || "").trim();
    const localPort = Number(value.localPort);
    const remoteHost = String(value.remoteHost || "").trim();
    const remotePort = Number(value.remotePort);
    if (!localHost || !Number.isInteger(localPort) || localPort < 1 || localPort > 65535
      || !remoteHost || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)
      throw new Error(`Tunnel endpoint ${value.id} is missing its configured local/remote host or port.`);
    const gateway = getTunnelGateway();
    if (gateway?.localBaseUrl) gateway.localBaseUrl({ localHost, localPort });
    return { ...value, localHost, localPort, remoteHost, remotePort };
  }
}
