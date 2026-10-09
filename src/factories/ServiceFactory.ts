/**
 * ServiceFactory - 根抽象工厂 (Abstract Factory)
 * 聚合 TunnelFactory / RealtimeClientFactory / FeatureFactory / CommandFactory / PanelSectionFactory
 * 遵循 docs/architecture-factory-refactor-plan.md §3.2
 * Composition Root 唯一持有具体工厂，其他模块只依赖抽象。
 */

import type { FactoryContext } from "./types";
import type { TunnelFactory } from "./TunnelFactory";
import type { RealtimeClientFactory } from "./RealtimeClientFactory";
import type { FeatureFactory } from "./FeatureFactory";
import type { CommandFactory } from "./CommandFactory";
import type { PanelSectionFactory } from "./PanelSectionFactory";
import { DefaultTunnelFactory } from "./TunnelFactory";
import { DefaultRealtimeClientFactory } from "./RealtimeClientFactory";
import { DefaultFeatureFactory } from "./FeatureFactory";
import { DefaultCommandFactory } from "./CommandFactory";
import { DefaultPanelSectionFactory } from "./PanelSectionFactory";

// ---------- 强类型动态 require 访问器 ----------
function tryRequire<T>(id: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return undefined;
  }
}

type ExtensionMod = {
  RealtimeTunnelPanelProvider?: new (ctx: FactoryContext) => unknown;
  default?: {
    RealtimeTunnelPanelProvider?: new (ctx: FactoryContext) => unknown;
  };
};

type LocalApiServerMod = {
  LocalApiServer?: new (opts: unknown) => unknown;
  LocalApiServerClass?: new (opts: unknown) => unknown;
  default?: {
    LocalApiServer?: new (opts: unknown) => unknown;
    LocalApiServerClass?: new (opts: unknown) => unknown;
  };
};

function getExtensionMod(): ExtensionMod | undefined {
  return tryRequire<ExtensionMod>("../extension");
}

function getLocalApiServerMod(): LocalApiServerMod | undefined {
  return tryRequire<LocalApiServerMod>("../api/LocalApiServer");
}

export interface ServiceFactory {
  readonly tunnel: TunnelFactory;
  readonly realtime: RealtimeClientFactory;
  readonly features: FeatureFactory;
  readonly commands: CommandFactory;
  readonly panels: PanelSectionFactory;
  createPanelProvider(ctx: FactoryContext): unknown;
  createLocalApiServer(ctx: FactoryContext, options: Record<string, unknown>): unknown;
}

export class DefaultServiceFactory implements ServiceFactory {
  public readonly tunnel: TunnelFactory;
  public readonly realtime: RealtimeClientFactory;
  public readonly features: FeatureFactory;
  public readonly commands: CommandFactory;
  public readonly panels: PanelSectionFactory;

  constructor(
    tunnel?: TunnelFactory,
    realtime?: RealtimeClientFactory,
    features?: FeatureFactory,
    commands?: CommandFactory,
    panels?: PanelSectionFactory,
  ) {
    this.tunnel = tunnel ?? new DefaultTunnelFactory();
    this.realtime = realtime ?? new DefaultRealtimeClientFactory();
    this.features = features ?? new DefaultFeatureFactory();
    this.commands = commands ?? new DefaultCommandFactory();
    this.panels = panels ?? new DefaultPanelSectionFactory();
  }

  createPanelProvider(ctx: FactoryContext): unknown {
    const mod = getExtensionMod();
    if (mod) {
      const Cls = mod.RealtimeTunnelPanelProvider ?? mod.default?.RealtimeTunnelPanelProvider;
      if (typeof Cls === "function") {
        return new Cls(ctx);
      }
    }
    throw new Error("[ServiceFactory] RealtimeTunnelPanelProvider implementation unavailable; caller must explicitly select its legacy activation path.");
  }

  createLocalApiServer(ctx: FactoryContext, options: Record<string, unknown>): unknown {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("LocalApiServer requires explicit runtime options.");
    const name = String(options["name"] || "").trim();
    const discoveryPath = String(options["discoveryPath"] || "").trim();
    const methods = options["methods"];
    const methodEntries = methods && typeof methods === "object" && !Array.isArray(methods) ? Object.entries(methods) : [];
    if (!name || !discoveryPath || !methodEntries.length)
      throw new Error("LocalApiServer requires a name, discovery path, and at least one registered API method.");
    const invalidMethods = methodEntries.filter(([method, handler]) => !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(method) || typeof handler !== "function").map(([method]) => method);
    if (invalidMethods.length) throw new Error(`LocalApiServer methods must be callable and have valid names: ${invalidMethods.slice(0, 12).join(", ")}${invalidMethods.length > 12 ? "…" : ""}`);
    const mod = getLocalApiServerMod();
    if (mod) {
      const Cls =
        mod.LocalApiServer ?? mod.default?.LocalApiServer ?? mod.LocalApiServerClass ?? mod.default?.LocalApiServerClass;
      if (typeof Cls === "function") {
        const ctxRecord = ctx as unknown as Record<string, unknown>;
        const version = String(options["version"] ?? ctxRecord["extensionVersion"] ?? ctxRecord["version"] ?? "");
        return new Cls({ ...options, name, version, discoveryPath, methods });
      }
    }
    throw new Error("LocalApiServer implementation unavailable; refusing to create an unregistered or no-op API server.");
  }

  createAllFactories(): Record<string, unknown> {
    return {
      tunnel: this.tunnel,
      realtime: this.realtime,
      features: this.features,
      commands: this.commands,
      panels: this.panels,
    };
  }

  createByName(name: string): unknown {
    const map: Record<string, unknown> = this.createAllFactories();
    return map[name];
  }
}
