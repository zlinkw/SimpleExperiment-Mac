/**
 * EndpointRegistry — 端点注册表工厂
 * 封装 TunnelEndpointRegistry 的注册/发现/持久化，支持依赖注入与多端点拓扑
 */

import { assertLocalhost, localBaseUrl } from "../TunnelGateway";

function tryRequire<T>(id: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return undefined;
  }
}

type TunnelEndpointRegistryMod = {
  TunnelEndpointRegistry?: new (initial: EndpointDescriptor[]) => {
    register?(ep: EndpointDescriptor): void;
    set?(k: string, v: EndpointDescriptor): void;
    unregister?(id: string): boolean;
    delete?(k: string): boolean;
    get?(id: string): EndpointDescriptor | undefined;
    find?(id: string): EndpointDescriptor | undefined;
    list?(role?: string): EndpointDescriptor[];
    values?(): Iterable<EndpointDescriptor>;
    listEnabled?(): EndpointDescriptor[];
    has?(id: string): boolean;
    clear?(): void;
    toNamedConfigs?(): unknown[];
  };
};

export interface EndpointDescriptor {
  id: string;
  role: "hub" | "worker";
  displayName?: string;
  localHost: string;
  localPort: number;
  remoteHost?: string;
  remotePort?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface EndpointRegistry {
  register(endpoint: EndpointDescriptor): void;
  unregister(id: string): boolean;
  get(id: string): EndpointDescriptor | undefined;
  list(role?: "hub" | "worker"): EndpointDescriptor[];
  listEnabled(): EndpointDescriptor[];
  has(id: string): boolean;
  clear(): void;
  toNamedConfigs(): unknown[];
}

export interface EndpointRegistryFactory {
  create(initial?: EndpointDescriptor[]): EndpointRegistry;
  fromWorkspace(initial?: EndpointDescriptor[]): EndpointRegistry;
}

class DefaultEndpointRegistry implements EndpointRegistry {
  private readonly map = new Map<string, EndpointDescriptor>();
  constructor(initial: EndpointDescriptor[] = []) {
    if (!Array.isArray(initial)) throw new Error("Tunnel endpoint initial value must be an array.");
    for (const ep of initial) this.register(ep);
  }
  register(endpoint: EndpointDescriptor): void {
    if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) throw new Error("Tunnel endpoint must be an object.");
    const id = String(endpoint.id || "").trim();
    if (!id) throw new Error("Endpoint id is required");
    if (endpoint.role !== "hub" && endpoint.role !== "worker") throw new Error(`Endpoint ${id} has an unsupported role.`);
    const localHost = String(endpoint.localHost || "").trim();
    const localPort = Number(endpoint.localPort);
    const remoteHost = String(endpoint.remoteHost || "").trim();
    const remotePort = Number(endpoint.remotePort);
    if (!localHost || !Number.isInteger(localPort) || localPort < 1024 || localPort > 65535
      || !remoteHost || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)
      throw new Error(`Endpoint ${id} requires configured local and remote hosts and ports.`);
    assertLocalhost(localHost);
    assertLocalhost(remoteHost);
    localBaseUrl({ localHost, localPort });
    this.map.set(id, { ...endpoint, id, localHost, localPort, remoteHost, remotePort, enabled: endpoint.enabled !== false });
  }
  unregister(id: string): boolean { return this.map.delete(String(id)); }
  get(id: string): EndpointDescriptor | undefined { return this.map.get(String(id)); }
  list(role?: "hub" | "worker"): EndpointDescriptor[] {
    const all = [...this.map.values()];
    return role ? all.filter((e) => e.role === role) : all;
  }
  listEnabled(): EndpointDescriptor[] { return [...this.map.values()].filter((e) => e.enabled !== false); }
  has(id: string): boolean { return this.map.has(String(id)); }
  clear(): void { this.map.clear(); }
  toNamedConfigs(): unknown[] {
    return this.list().map((e) => ({
      id: e.id,
      role: e.role,
      displayName: e.displayName,
      localHost: e.localHost,
      localPort: e.localPort,
      remoteHost: e.remoteHost,
      remotePort: e.remotePort,
      token: (e as Record<string, unknown>)["token"],
      capabilities: (e as Record<string, unknown>)["capabilities"],
    }));
  }
}

export class DefaultEndpointRegistryFactory implements EndpointRegistryFactory {
  private readonly deps: Record<string, unknown>;
  constructor(deps: Record<string, unknown> = {}) { this.deps = deps; }
  create(initial: EndpointDescriptor[] = []): EndpointRegistry {
    const mod = tryRequire<TunnelEndpointRegistryMod>("../TunnelEndpointRegistry");
    if (mod?.TunnelEndpointRegistry) {
      const inst = new mod.TunnelEndpointRegistry(initial);
      const register = inst.register ? (ep: EndpointDescriptor) => inst.register!(ep) : inst.set ? (ep: EndpointDescriptor) => inst.set!(ep.id, ep) : undefined;
      const unregister = inst.unregister ? (id: string) => Boolean(inst.unregister!(id)) : inst.delete ? (id: string) => Boolean(inst.delete!(id)) : undefined;
      const get = inst.get ? (id: string) => inst.get!(id) : inst.find ? (id: string) => inst.find!(id) : undefined;
      const list = inst.list ? (role?: string) => inst.list!(role) : inst.values ? () => [...inst.values!()] : undefined;
      if (!register || !unregister || !get || !list) throw new Error("TunnelEndpointRegistry implementation is missing required registry operations.");
      return {
        register,
        unregister,
        get,
        list: (role?: "hub" | "worker") => list(role),
        listEnabled: () => inst.listEnabled ? inst.listEnabled() : list().filter((e) => e.enabled !== false),
        has: (id: string) => inst.has ? Boolean(inst.has(id)) : Boolean(get(id)),
        clear: () => {
          if (inst.clear) { inst.clear(); return; }
          for (const endpoint of list()) unregister(endpoint.id);
        },
        toNamedConfigs: () => inst.toNamedConfigs ? inst.toNamedConfigs() : [...list()],
      } as EndpointRegistry;
    }
    return new DefaultEndpointRegistry(initial);
  }
  fromWorkspace(initial: EndpointDescriptor[] = []): EndpointRegistry {
    if (!Array.isArray(initial)) throw new Error("Tunnel endpoint initial value must be an array.");
    let persisted: EndpointDescriptor[] = [...initial];
    const store = (this.deps["workspaceState"] as { get?: (k: string) => unknown } | undefined) ?? (this.deps["globalState"] as { get?: (k: string) => unknown } | undefined);
    if (store && typeof store.get === "function") {
      let saved: unknown;
      try { saved = store.get("tunnelEndpoints"); }
      catch (error) { throw new Error(`Tunnel endpoint settings could not be read: ${String((error as Error)?.message || error).slice(0, 240)}`); }
      if (saved !== undefined && !Array.isArray(saved)) throw new Error("Saved tunnel endpoint settings are malformed; refusing to use an empty registry.");
      if (Array.isArray(saved)) persisted = [...persisted, ...(saved as EndpointDescriptor[])];
    }
    return this.create(persisted);
  }
}

export function createEndpointRegistry(initial?: EndpointDescriptor[]): EndpointRegistry {
  return new DefaultEndpointRegistry(initial);
}
export function createEndpointRegistryFactory(deps?: Record<string, unknown>): EndpointRegistryFactory {
  return new DefaultEndpointRegistryFactory(deps);
}
