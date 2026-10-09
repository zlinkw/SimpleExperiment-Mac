/**
 * ExtensionContext - 扩展上下文封装 (Phase 2 模块化)
 * 搬运自 src/extension.ts 的上下文访问逻辑，不改原逻辑，仅通过 FactoryContext 注入。
 * 职责：封装 vscode.ExtensionContext 的工厂化访问，供 ServiceFactory / Activation 统一组装。
 */

import type { FactoryContext } from "../factories/types";

export interface ExtensionContextFacade {
  readonly extensionUri: unknown;
  readonly globalState: {
    get<T>(key: string, defaultValue?: T): T;
    update(key: string, value: unknown): Thenable<void>;
    setKeysForSync(keys: string[]): void;
  };
  readonly workspaceState: {
    get<T>(key: string, defaultValue?: T): T;
    update(key: string, value: unknown): Thenable<void>;
  };
  readonly secrets?: {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
  };
  readonly subscriptions: { push(...args: unknown[]): unknown };
  readonly extensionPath?: string;
  readonly asAbsolutePath?: (relativePath: string) => string;
}

export interface ExtensionContextOptions {
  readonly context: ExtensionContextFacade;
  readonly factoryContextOverrides?: Record<string, unknown>;
}

/**
 * 将 vscode.ExtensionContext 适配为 FactoryContext
 * 原逻辑搬运自 extension.ts 中多处对 context.globalState / workspaceState 的直接访问
 */
export function toFactoryContext(
  vscodeContext: ExtensionContextFacade,
  overrides: Record<string, unknown> = {},
): FactoryContext {
  const raw = vscodeContext as unknown as Record<string, unknown>;
  return {
    extensionUri: (raw["extensionUri"] ?? raw["extensionPath"]) as FactoryContext["extensionUri"],
    globalState: vscodeContext.globalState as unknown as FactoryContext["globalState"],
    workspaceState: vscodeContext.workspaceState as unknown as FactoryContext["workspaceState"],
    secrets: raw["secrets"] as FactoryContext["secrets"],
    // 透传常见扩展字段，保持渐进兼容
    extensionPath: raw["extensionPath"] as string | undefined,
    subscriptions: raw["subscriptions"] as unknown,
    ...overrides,
  } as unknown as FactoryContext;
}

export function createExtensionContextFacade(vscodeContext: unknown): ExtensionContextFacade {
  return vscodeContext as ExtensionContextFacade;
}

export function getGlobalStateValue<T>(ctx: ExtensionContextFacade, key: string, defaultValue?: T): T | undefined {
  try {
    return ctx.globalState.get<T>(key, defaultValue as T);
  } catch {
    return defaultValue;
  }
}

export async function updateGlobalState(ctx: ExtensionContextFacade, key: string, value: unknown): Promise<void> {
  try {
    await ctx.globalState.update(key, value);
  } catch {}
}

export function getWorkspaceStateValue<T>(ctx: ExtensionContextFacade, key: string, defaultValue?: T): T | undefined {
  try {
    return ctx.workspaceState.get<T>(key, defaultValue as T);
  } catch {
    return defaultValue;
  }
}

export async function updateWorkspaceState(ctx: ExtensionContextFacade, key: string, value: unknown): Promise<void> {
  try {
    await ctx.workspaceState.update(key, value);
  } catch {}
}

export function extensionContextKeys(): Record<string, string> {
  // 搬运自 extension.ts 顶部 keys 常量的子集，保持兼容门面可运行
  return {
    setupConfig: "simpleExperiment.setupConfig",
    tunnelConfig: "simpleExperiment.tunnelConfig",
    projectOnboardingPrompt: "simpleExperiment.projectOnboardingPrompt",
    projectOnboardingCompleted: "simpleExperiment.projectOnboardingCompleted",
  };
}
