/**
 * TunnelClientPool — 多端点客户端池工厂
 * 从 MultiEndpointRealtimeClient 提取池化逻辑，统一管理 RealtimeTunnelClient 实例
 */

import { defaultRequestBudgetConfig } from "../RequestBudget";
import { defaultRealtimeRefreshPolicy } from "../RealtimeTunnelClient";

function tryRequire<T>(id: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return undefined;
  }
}

type MultiEndpointRealtimeClientMod = {
  MultiEndpointRealtimeClient?: new (endpoints: unknown[], budgetFactory: (e: unknown) => unknown, policy: unknown, onState: (s: unknown) => void) => {
    clients?: Map<string, unknown>;
    connect(sinceSeq?: number): Promise<void>;
    disconnect(reason?: string): Promise<void>;
    reconnect(reason?: string): Promise<void>;
  };
};

type RealtimeTunnelClientMod = {
  RealtimeTunnelClient?: new (endpoint: unknown, budget: unknown, policy: unknown, onState: (s: unknown) => void) => unknown;
  defaultRealtimeRefreshPolicy?: unknown;
};

type RequestBudgetMod = {
  RequestBudget?: new (cfg: unknown) => unknown;
  defaultRequestBudgetConfig?: unknown;
};

export interface TunnelClientPoolOptions {
  policy?: unknown;
  budgetFactory?: (endpoint: unknown) => unknown;
  onState?: (state: unknown) => void;
}

export interface TunnelClientPool {
  readonly size: number;
  get(id: string): unknown | undefined;
  getAll(): Map<string, unknown>;
  connect(sinceSeq?: number): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  reconnect(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface TunnelClientPoolFactory {
  create(endpoints: unknown[], opts?: TunnelClientPoolOptions): TunnelClientPool;
  createWithBudgets(endpoints: unknown[], budgetFactory: (e: unknown) => unknown, policy?: unknown, onState?: (s: unknown) => void): TunnelClientPool;
}

class DefaultTunnelClientPool implements TunnelClientPool {
  private readonly pool = new Map<string, unknown>();
  private multi: { clients?: Map<string, unknown>; connect(sinceSeq?: number): Promise<void>; disconnect(reason?: string): Promise<void>; reconnect(reason?: string): Promise<void> } | undefined;

  constructor(endpoints: unknown[], private opts: TunnelClientPoolOptions = {}) {
    const budgetFactory = opts.budgetFactory ?? this.defaultBudgetFactory.bind(this);
    const policy = opts.policy ?? this.resolveDefaultPolicy();
    const onState = opts.onState ?? (() => undefined);
    const mod = tryRequire<MultiEndpointRealtimeClientMod>("../MultiEndpointRealtimeClient");
    if (mod && typeof mod.MultiEndpointRealtimeClient === "function") {
      try {
        this.multi = new mod.MultiEndpointRealtimeClient(endpoints, budgetFactory, policy, onState);
        const internal = this.multi.clients;
        if (!internal) throw new Error("MultiEndpointRealtimeClient did not expose its endpoint clients.");
        for (const [k, v] of internal.entries()) this.pool.set(k, v);
        return;
      } catch (error) {
        throw new Error(`Multi-endpoint tunnel client initialization failed: ${String((error as Error)?.message || error).slice(0, 300)}`);
      }
    }
    const clientModule = tryRequire<RealtimeTunnelClientMod>("../RealtimeTunnelClient");
    if (typeof clientModule?.RealtimeTunnelClient !== "function")
      throw new Error("RealtimeTunnelClient implementation is unavailable.");
    for (const ep of endpoints) {
      const rec = ep as Record<string, unknown>;
      const key = String(rec["id"] ?? "").trim();
      if (!key) throw new Error("Tunnel endpoint is missing its stable id.");
      if (this.pool.has(key)) throw new Error(`Duplicate tunnel endpoint id: ${key}`);
      try {
        const b = budgetFactory(ep);
        if (!b) throw new Error("RequestBudget factory returned no budget.");
        const client = new clientModule.RealtimeTunnelClient(ep, b, policy, onState) as Record<string, unknown>;
        if (typeof client.connect !== "function" || typeof client.disconnect !== "function" || typeof client.reconnect !== "function")
          throw new Error("RealtimeTunnelClient is missing a lifecycle method.");
        this.pool.set(key, client);
      } catch (error) {
        throw new Error(`Tunnel endpoint ${key} initialization failed: ${String((error as Error)?.message || error).slice(0, 240)}`);
      }
    }
  }

  get size(): number { return this.pool.size; }
  get(id: string): unknown | undefined { return this.pool.get(id) ?? (this.multi?.clients?.get?.(id)); }
  getAll(): Map<string, unknown> { return new Map(this.pool); }

  async connect(sinceSeq?: number): Promise<void> {
    if (this.multi) return this.multi.connect(sinceSeq);
    await this.invokeAll("connect", sinceSeq);
  }
  async disconnect(reason = "manual"): Promise<void> {
    if (this.multi) return this.multi.disconnect(reason);
    await this.invokeAll("disconnect", reason);
  }
  async reconnect(reason = "reconnect"): Promise<void> {
    if (this.multi) return this.multi.reconnect(reason);
    await this.invokeAll("reconnect", reason);
  }
  async dispose(): Promise<void> { await this.disconnect("dispose"); this.pool.clear(); }

  private async invokeAll(method: "connect" | "disconnect" | "reconnect", argument: unknown): Promise<void> {
    const entries = [...this.pool.entries()];
    const outcomes = await Promise.all(entries.map(async ([id, client]) => {
      const fn = (client as Record<string, unknown>)[method];
      if (typeof fn !== "function") return `${id}: lifecycle method ${method} is unavailable`;
      try { await (fn as (value?: unknown) => Promise<void>).call(client, argument); return ""; }
      catch (error) { return `${id}: ${String((error as Error)?.message || error).slice(0, 240)}`; }
    }));
    const failures = outcomes.filter(Boolean);
    if (failures.length) throw new Error(`${method} failed for ${failures.length}/${entries.length} tunnel endpoints: ${failures.slice(0, 8).join("; ")}`);
  }

  private defaultBudgetFactory(endpoint: unknown): unknown {
    const mod = tryRequire<RequestBudgetMod>("../RequestBudget");
    if (mod?.RequestBudget) {
      const cfg = mod.defaultRequestBudgetConfig ?? defaultRequestBudgetConfig;
      return new mod.RequestBudget(cfg);
    }
    throw new Error(`RequestBudget implementation is unavailable for endpoint ${String((endpoint as Record<string, unknown>)?.["id"] || "unknown")}.`);
  }
  private resolveDefaultPolicy(): unknown {
    const m = tryRequire<RealtimeTunnelClientMod>("../RealtimeTunnelClient");
    if (m?.defaultRealtimeRefreshPolicy) return m.defaultRealtimeRefreshPolicy;
    return defaultRealtimeRefreshPolicy;
  }
}

export class DefaultTunnelClientPoolFactory implements TunnelClientPoolFactory {
  private readonly deps: Record<string, unknown>;
  constructor(deps: Record<string, unknown> = {}) { this.deps = deps; }
  create(endpoints: unknown[], opts: TunnelClientPoolOptions = {}): TunnelClientPool {
    const merged: TunnelClientPoolOptions = { ...opts };
    if (!merged.budgetFactory && this.deps["budgetFactory"]) merged.budgetFactory = this.deps["budgetFactory"] as TunnelClientPoolOptions["budgetFactory"];
    if (!merged.policy && this.deps["policy"]) merged.policy = this.deps["policy"];
    if (!merged.onState && this.deps["onState"]) merged.onState = this.deps["onState"] as TunnelClientPoolOptions["onState"];
    return new DefaultTunnelClientPool(endpoints, merged);
  }
  createWithBudgets(endpoints: unknown[], budgetFactory: (e: unknown) => unknown, policy?: unknown, onState?: (s: unknown) => void): TunnelClientPool {
    return new DefaultTunnelClientPool(endpoints, { budgetFactory, policy, onState });
  }
}

export function createTunnelClientPool(endpoints: unknown[], opts?: TunnelClientPoolOptions): TunnelClientPool {
  return new DefaultTunnelClientPool(endpoints, opts);
}
export function createTunnelClientPoolFactory(deps?: Record<string, unknown>): TunnelClientPoolFactory {
  return new DefaultTunnelClientPoolFactory(deps);
}
