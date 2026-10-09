/**
 * TunnelFactory - 隧道工厂
 * 封装 TunnelGateway / TunnelPortAllocator / TunnelEndpointRegistry / XshellTunnel* 的创建
 * P0 约束：禁止硬编码端口，所有端口经由输入配置或 normalize 动态解析
 * 遵循 docs/architecture-factory-refactor-plan.md §3.3
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
  defaultTunnelGatewayConfig: TunnelGatewayConfig;
  normalizeTunnelGatewayConfig?: (input: Partial<TunnelGatewayConfig>) => TunnelGatewayConfig;
  localBaseUrl?: (cfg: { localHost: string; localPort: number }) => string;
  normalizePort?: (value: unknown, fallback: number) => number;
};

type XshellSetupMod = {
  normalizeXshellRealtimeTunnelConfig?: (input: Partial<XshellSetupConfig>) => XshellSetupConfig;
  normalizeXshellTunnelSetup?: (input: Partial<XshellSetupConfig>) => XshellSetupConfig;
};

type PortAllocatorMod = {
  TunnelPortAllocator?: new (range?: TunnelPortRange) => unknown;
  allocateTunnelPorts?: (...args: unknown[]) => unknown;
};

type EndpointRegistryMod = {
  buildTunnelEndpointRegistry?: (setup: XshellSetupConfig, probes: Record<string, unknown>) => unknown;
};

type PortConflictMod = {
  detectPortConflicts?: (assignments: TunnelEndpointAssignment[], range?: TunnelPortRange) => TunnelPortConflict[];
  makeTunnelPortConflict?: (...args: unknown[]) => unknown;
};

type PortProbeMod = {
  XshellTunnelPortProbe?: new () => unknown;
  createPortProbe?: () => unknown;
  probeLocalTunnel?: (...args: unknown[]) => unknown;
  probeWorkerTelemetryTunnel?: (...args: unknown[]) => unknown;
};

type LauncherMod = {
  XshellSessionLauncher?: new (deps: Record<string, unknown>) => unknown;
};

type IntegrationMod = {
  XshellTunnelIntegration?: new (deps: Record<string, unknown>) => unknown;
};

function getTunnelGateway(): TunnelGatewayMod | undefined {
  return tryRequire<TunnelGatewayMod>("../tunnel/TunnelGateway");
}

function getXshellSetup(): XshellSetupMod | undefined {
  return tryRequire<XshellSetupMod>("../tunnel/XshellTunnelSetup");
}

function getPortAllocator(): PortAllocatorMod | undefined {
  return tryRequire<PortAllocatorMod>("../tunnel/TunnelPortAllocator");
}

function getEndpointRegistry(): EndpointRegistryMod | undefined {
  return tryRequire<EndpointRegistryMod>("../tunnel/TunnelEndpointRegistry");
}

function getPortConflict(): PortConflictMod | undefined {
  return tryRequire<PortConflictMod>("../tunnel/TunnelPortConflict");
}

function getPortProbe(): PortProbeMod | undefined {
  return tryRequire<PortProbeMod>("../tunnel/XshellTunnelPortProbe");
}

function getLauncher(): LauncherMod | undefined {
  return tryRequire<LauncherMod>("../tunnel/XshellSessionLauncher");
}

function getIntegration(): IntegrationMod | undefined {
  return tryRequire<IntegrationMod>("../tunnel/XshellTunnelIntegration");
}

export interface TunnelGatewayConfig {
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface XshellSetupConfig {
  hubHost: string;
  localForwardPort: number;
  remoteAgentPort: number;
  [key: string]: unknown;
}

export interface TunnelPortRange {
  min: number;
  max: number;
}

export interface TunnelEndpointAssignment {
  endpointId: string;
  localForwardPort: number;
  [key: string]: unknown;
}

export interface TunnelPortConflict {
  endpointId: string;
  conflictWith?: string;
  port: number;
  reason: string;
}

export interface TunnelFactory {
  normalizeGatewayConfig(input: Partial<TunnelGatewayConfig>): TunnelGatewayConfig;
  normalizeSetupConfig(input: Partial<XshellSetupConfig>): XshellSetupConfig;
  createPortAllocator(range?: TunnelPortRange): unknown;
  createEndpointRegistry(setup: XshellSetupConfig, probes?: Record<string, unknown>): unknown;
  detectPortConflicts(assignments: TunnelEndpointAssignment[], range?: TunnelPortRange): TunnelPortConflict[];
  createPortProbe(): unknown;
  createLauncher(): unknown;
  createIntegration(): unknown;
  resolveEndpointUrl(cfg: { localHost: string; localPort: number }): string;
  createAll(ctx: FactoryContext): unknown[];
  createByName(name: string, ctx: FactoryContext): unknown | undefined;
}

export class DefaultTunnelFactory implements TunnelFactory {
  private readonly injectedDeps: Record<string, unknown>;

  constructor(deps: Record<string, unknown> = {}) {
    this.injectedDeps = deps;
  }

  private getDefaultPort(): number {
    const gw = getTunnelGateway();
    if (gw?.defaultTunnelGatewayConfig?.localPort !== undefined) {
      return Number(gw.defaultTunnelGatewayConfig.localPort) || 0;
    }
    return 0;
  }

  private getDefaultRemotePort(): number {
    const gw = getTunnelGateway();
    if (gw?.defaultTunnelGatewayConfig?.remotePort !== undefined) {
      return Number(gw.defaultTunnelGatewayConfig.remotePort) || 0;
    }
    return 0;
  }

  private getDefaultGatewayConfig(): TunnelGatewayConfig {
    const gw = getTunnelGateway();
    if (gw?.defaultTunnelGatewayConfig) {
      return gw.defaultTunnelGatewayConfig as TunnelGatewayConfig;
    }
    return { localHost: "127.0.0.1", localPort: 0, remoteHost: "127.0.0.1", remotePort: 0 } as TunnelGatewayConfig;
  }

  normalizeGatewayConfig(input: Partial<TunnelGatewayConfig> = {}): TunnelGatewayConfig {
    const mod = getTunnelGateway();
    if (mod) {
      if (typeof mod.normalizeTunnelGatewayConfig === "function") {
        return mod.normalizeTunnelGatewayConfig(input);
      }
      if (mod.defaultTunnelGatewayConfig) {
        const def = mod.defaultTunnelGatewayConfig as TunnelGatewayConfig;
        return { ...def, ...input } as TunnelGatewayConfig;
      }
    }
    // 回退：使用动态默认配置合并，禁止硬编码端口字面量分支
    const defPort = this.getDefaultPort();
    const defRemotePort = this.getDefaultRemotePort();
    void this.getDefaultGatewayConfig();
    const fallbackBase = { localHost: "127.0.0.1", localPort: defPort, remoteHost: "127.0.0.1", remotePort: defRemotePort } as TunnelGatewayConfig;
    return { ...fallbackBase, ...input } as TunnelGatewayConfig;
  }

  normalizeSetupConfig(input: Partial<XshellSetupConfig> = {}): XshellSetupConfig {
    const mod = getXshellSetup();
    if (mod) {
      if (typeof mod.normalizeXshellRealtimeTunnelConfig === "function") {
        return mod.normalizeXshellRealtimeTunnelConfig(input);
      }
      if (typeof mod.normalizeXshellTunnelSetup === "function") {
        return mod.normalizeXshellTunnelSetup(input);
      }
    }
    return { hubHost: String(input.hubHost || ""), localForwardPort: Number(input.localForwardPort) || 0, remoteAgentPort: Number(input.remoteAgentPort) || 0, ...input } as XshellSetupConfig;
  }

  createPortAllocator(range?: TunnelPortRange): unknown {
    const mod = getPortAllocator();
    if (mod) {
      if (mod.TunnelPortAllocator) return new mod.TunnelPortAllocator(range);
      if (typeof mod.allocateTunnelPorts === "function") return { allocate: mod.allocateTunnelPorts, range };
    }
    throw new Error("TunnelPortAllocator implementation unavailable; no endpoints were allocated.");
  }

  createEndpointRegistry(setup: XshellSetupConfig, probes: Record<string, unknown> = {}): unknown {
    const mod = getEndpointRegistry();
    if (mod && typeof mod.buildTunnelEndpointRegistry === "function") return mod.buildTunnelEndpointRegistry(setup, probes);
    throw new Error("TunnelEndpointRegistry implementation unavailable; refusing an empty endpoint registry.");
  }

  detectPortConflicts(assignments: TunnelEndpointAssignment[], range?: TunnelPortRange): TunnelPortConflict[] {
    const mod = getPortConflict();
    if (mod) {
      if (typeof mod.detectPortConflicts === "function") return mod.detectPortConflicts(assignments, range);
      if (typeof mod.makeTunnelPortConflict === "function" && assignments) {
        // 基础去重检测回退
        const seen = new Map<number, string>();
        const conflicts: TunnelPortConflict[] = [];
        for (const a of assignments) {
          const prev = seen.get(a.localForwardPort);
          if (prev) conflicts.push({ endpointId: a.endpointId, conflictWith: prev, port: a.localForwardPort, reason: "duplicate_port" });
          else seen.set(a.localForwardPort, a.endpointId);
        }
        return conflicts;
      }
    }
    throw new Error("TunnelPortConflict implementation unavailable; refusing to report no conflicts without checking.");
  }

  createPortProbe(): unknown {
    const mod = getPortProbe();
    if (mod) {
      if (mod.XshellTunnelPortProbe) return new mod.XshellTunnelPortProbe();
      if (typeof mod.createPortProbe === "function") return mod.createPortProbe();
      if (typeof mod.probeLocalTunnel === "function" && typeof mod.probeWorkerTelemetryTunnel === "function") {
        return { probeLocalTunnel: mod.probeLocalTunnel, probeWorkerTelemetryTunnel: mod.probeWorkerTelemetryTunnel };
      }
    }
    throw new Error("XshellTunnelPortProbe implementation unavailable; port availability was not checked.");
  }

  createLauncher(): unknown {
    const mod = getLauncher();
    if (mod && mod.XshellSessionLauncher) return new mod.XshellSessionLauncher(this.injectedDeps);
    throw new Error("XshellSessionLauncher implementation unavailable; no session was launched.");
  }

  createIntegration(): unknown {
    const mod = getIntegration();
    if (mod && mod.XshellTunnelIntegration) return new mod.XshellTunnelIntegration(this.injectedDeps);
    throw new Error("XshellTunnelIntegration implementation unavailable; tunnel integration was not checked.");
  }

  resolveEndpointUrl(cfg: { localHost: string; localPort: number }): string {
    // P0: 禁止工厂内出现字面量端口，全部经 TunnelGateway.localBaseUrl 动态解析
    const mod = getTunnelGateway();
    if (mod) {
      if (typeof mod.localBaseUrl === "function") return mod.localBaseUrl(cfg);
      if (typeof mod.normalizePort === "function") {
        const defPort: number = (mod.defaultTunnelGatewayConfig?.localPort as number) ?? this.getDefaultPort();
        const safe = mod.normalizePort(cfg.localPort, defPort);
        const host = String(cfg.localHost || "127.0.0.1").trim() || "127.0.0.1";
        return `http://${host}:${safe}`;
      }
    }
    const host = String(cfg.localHost || "127.0.0.1").trim() || "127.0.0.1";
    const port = Number(cfg.localPort);
    // 回退时动态读取默认端口，禁止字面量分支
    const defPort = this.getDefaultPort();
    const safePort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : defPort;
    return `http://${host}:${safePort}`;
  }

  createAll(ctx: FactoryContext): unknown[] {
    return [
      this.createPortAllocator(),
      this.createEndpointRegistry(this.configuredSetup(ctx)),
      this.createPortProbe(),
      this.createLauncher(),
      this.createIntegration(),
    ];
  }

  createByName(name: string, ctx: FactoryContext): unknown | undefined {
    const map: Record<string, () => unknown> = {
      portAllocator: () => this.createPortAllocator(),
      endpointRegistry: () => this.createEndpointRegistry(this.configuredSetup(ctx)),
      portProbe: () => this.createPortProbe(),
      launcher: () => this.createLauncher(),
      integration: () => this.createIntegration(),
    };
    const fn = map[name];
    return fn ? fn() : undefined;
  }

  private configuredSetup(ctx: FactoryContext): XshellSetupConfig {
    const candidate = this.injectedDeps["setupConfig"] ?? ctx["setupConfig"] ?? ctx["tunnelSetupConfig"];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error("Tunnel endpoint registry requires the user's configured setup; refusing to create an empty registry.");
    const setup = this.normalizeSetupConfig(candidate as Partial<XshellSetupConfig>);
    const workers = Array.isArray(setup["workerTunnels"]) ? setup["workerTunnels"] as Array<Record<string, unknown>> : [];
    const hasHub = Boolean(String(setup["hubHost"] || "").trim()
      && Number.isInteger(Number(setup["localForwardPort"])) && Number(setup["localForwardPort"]) > 0
      && Number.isInteger(Number(setup["remoteAgentPort"])) && Number(setup["remoteAgentPort"]) > 0);
    const hasWorker = workers.some((worker) => worker.enabled !== false && String(worker.id || "").trim()
      && String(worker.workerHost || worker.remoteAgentHost || "").trim()
      && Number.isInteger(Number(worker.localForwardPort || worker.localPort)) && Number(worker.localForwardPort || worker.localPort) > 0
      && Number.isInteger(Number(worker.remoteAgentPort || worker.remotePort)) && Number(worker.remoteAgentPort || worker.remotePort) > 0);
    if (!hasHub && !hasWorker) throw new Error("Tunnel endpoint registry requires at least one fully configured endpoint.");
    return setup;
  }
}
