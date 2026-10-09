/**
 * Activation - 新的 activate 入口，使用 ServiceFactory 组装，<150 行
 * 搬运自 src/extension.ts activate / activateExtension / deactivate，保持兼容门面可运行
 */

import type { FactoryContext } from "../factories/types";
import { DefaultServiceFactory } from "../factories/ServiceFactory";
import { toFactoryContext } from "./ExtensionContext";
import { registerProviderCommands } from "./ProviderCommands";
import { maybeAutoInstallGitBackup, registerGitBackupCommands, registerGitHubSyncCommands } from "./GitBackupSetup";

let _provider: unknown | undefined;
let _activationDisposables: Array<{ dispose(): unknown }> = [];
let _deactivationPromise: Promise<void> | undefined;
let _activationGeneration = 0;
let _reportedActivationFailures = new Set<string>();

function ownTimeout(context: { subscriptions: { push(...args: unknown[]): unknown } }, delayMs: number, callback: () => unknown): void {
  const generation = _activationGeneration;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    if (generation !== _activationGeneration) return;
    void Promise.resolve().then(callback).catch((error) => {
      reportActivationFailure("deferred startup task", error);
    });
  }, delayMs);
  const disposable = { dispose: () => { if (timer) clearTimeout(timer); timer = undefined; } };
  _activationDisposables.push(disposable);
  context.subscriptions.push(disposable);
}

function reportActivationFailure(stage: string, error: unknown): void {
  const message = String((error as any)?.message || error || "未知错误").slice(0, 600);
  const key = `${stage}:${message.slice(0, 180)}`;
  if (_reportedActivationFailures.has(key)) return;
  _reportedActivationFailures.add(key);
  while (_reportedActivationFailures.size > 16) {
    const oldest = _reportedActivationFailures.values().next().value;
    if (oldest === undefined) break;
    _reportedActivationFailures.delete(oldest);
  }
  console.error(`[Activation] ${stage} failed`, error);
  const vscode = tryRequire<any>("vscode");
  void Promise.resolve(vscode?.window?.showErrorMessage?.(`SimpleExperiment 启动失败（${stage}）：${message}`)).catch(() => undefined);
}

function tryRequire<T>(id: string): T | undefined {
  try { return (require as unknown as (x: string) => T)(id); } catch { return undefined; }
}

export async function activate(context: unknown): Promise<void> {
  console.log("[Activation] enter", new Date().toISOString(), "process.env.FEATURE_FACTORY_PANEL", process.env.FEATURE_FACTORY_PANEL);
  return activateExtension(context as unknown as Record<string, unknown> & { subscriptions: { push(...args: unknown[]): unknown } });
}

export async function activateExtension(context: Record<string, unknown> & { subscriptions: { push(...args: unknown[]): unknown } }): Promise<void> {
  _activationGeneration += 1;
  _activationDisposables = [];
  _deactivationPromise = undefined;
  _reportedActivationFailures = new Set<string>();
  console.log("[Activation] enter", new Date().toISOString(), "process.env.FEATURE_FACTORY_PANEL", process.env.FEATURE_FACTORY_PANEL);
  const mod = tryRequire<{ migrateRenamedExtensionState: (c: unknown) => Promise<void> }>("../config/RenamedExtensionStateMigration");
  await mod?.migrateRenamedExtensionState(context).catch(() => undefined);

  const factoryContext: FactoryContext = toFactoryContext(context as unknown as import("./ExtensionContext").ExtensionContextFacade);
  const services = new DefaultServiceFactory();

  // 单一工厂路径：优先经 ServiceFactory 创建，可回退到 legacy 直连
  // FIX: 传入原始 vscode.ExtensionContext 而非简化的 factoryContext，确保 this.context.extension.packageJSON 可用
  let provider: any;
  try {
    console.log("[Activation] try factory");
    provider = services.createPanelProvider(context as any);
    if (provider && typeof (provider as any).resolveWebviewView !== "function") throw new Error("not real provider");
  } catch (e) {
    console.error("[Activation] factory failed", e);
    provider = undefined;
  }
  if (!provider || typeof (provider as any).resolveWebviewView !== "function") {
    try {
      const legacy = tryRequire<{ RealtimeTunnelPanelProvider: new (c: unknown) => unknown }>("./legacy");
      const RealtimeTunnelPanelProvider = legacy?.RealtimeTunnelPanelProvider;
      provider = RealtimeTunnelPanelProvider ? new RealtimeTunnelPanelProvider(context) : undefined;
    } catch (error) {
      reportActivationFailure("legacy provider creation", error);
      provider = undefined;
    }
  }
  _provider = provider;
  console.log("[Activation] provider", !!provider, typeof (provider as any)?.resolveWebviewView);

  if (provider && typeof (provider as any).resolveWebviewView === "function") {
    try {
      const vscode = tryRequire<any>("vscode");
      if (vscode && vscode.window && typeof vscode.window.registerWebviewViewProvider === "function") {
        console.log("[Activation] registerWebviewViewProvider", "simpleExperimentMac.panel");
        const retainContextWhenHidden = (provider as any).retainPanelContextWhenHidden === true;
        context.subscriptions.push(
          vscode.window.registerWebviewViewProvider("simpleExperimentMac.panel", provider as any, { webviewOptions: { retainContextWhenHidden } })
        );
      } else {
        reportActivationFailure("webview registration", new Error("VS Code Webview API is unavailable."));
      }
    } catch (error) { reportActivationFailure("webview registration", error); }
  } else {
    // provider 无 resolveWebviewView，说明拿到桩，回退 legacy
    try {
      const legacy = tryRequire<any>("./legacy");
      if (legacy && typeof legacy.activate === "function") {
        return legacy.activate(context);
      }
    } catch (error) { reportActivationFailure("legacy activation fallback", error); }
    reportActivationFailure("provider creation", new Error("No usable panel provider could be created."));
    return;
  }
  // 注册命令（委托给 CommandFactory）
  try {
    registerProviderCommands({ factoryContext, commandFactory: services.commands as any, provider }, context);
  } catch (error) { reportActivationFailure("command registration", error); }

  // 注册 git 提交备份命令（独立注册，不耦合 legacy provider）
  try {
    registerGitBackupCommands(context as unknown as Parameters<typeof registerGitBackupCommands>[0]);
  } catch (error) { reportActivationFailure("Git backup command registration", error); }

  // 把既有的面板式 GitHub 同步方法补上命令面板入口（仅转发 provider 方法）
  try {
    registerGitHubSyncCommands(
      context as unknown as Parameters<typeof registerGitHubSyncCommands>[0],
      provider as Record<string, unknown> | undefined
    );
  } catch (error) { reportActivationFailure("GitHub command registration", error); }

  // 复刻原 activate 的后置启动逻辑（简化版，保持可运行）
  void Promise.resolve().then(() => provider?.startLocalApiServer?.())
    .catch((error) => reportActivationFailure("local API startup", error));
  void Promise.resolve().then(() => provider?.reconcileStalePlanRunOperations?.({ reason: "activation" }))
    .catch((error) => reportActivationFailure("stale operation reconciliation", error));
  void Promise.resolve().then(() => provider?.runActivationOnboarding?.())
    .catch((error) => reportActivationFailure("onboarding", error));
  ownTimeout(context, 8000, () => provider?.checkRemoteAgentVersionAndNotify?.(false));

  // 自动配置 git 提交备份：条件不满足只提示、不写入 hook
  ownTimeout(context, 3000, () => maybeAutoInstallGitBackup(context as unknown as Parameters<typeof maybeAutoInstallGitBackup>[0]));

  // 配置变更监听（与原逻辑一致）
  try {
    const vscode = tryRequire<typeof import("vscode")>("vscode");
    if (vscode) {
      context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e: unknown) => {
        void Promise.resolve().then(() => (provider as { handleConfigurationChanged?: (e: unknown) => unknown })?.handleConfigurationChanged?.(e))
          .catch((error) => reportActivationFailure("configuration change", error));
      }));
      context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void Promise.resolve().then(() => (provider as { handleWorkspaceFoldersChanged?: () => unknown })?.handleWorkspaceFoldersChanged?.())
          .catch((error) => reportActivationFailure("workspace change", error));
      }));
    }
  } catch (error) { reportActivationFailure("lifecycle listener registration", error); }
}

export function deactivate(): Promise<void> {
  if (_deactivationPromise) return _deactivationPromise;
  _activationGeneration += 1;
  const provider = _provider as { dispose?: () => unknown } | undefined;
  _provider = undefined;
  for (const disposable of _activationDisposables.splice(0)) {
    try { disposable.dispose(); } catch (error) { console.error("[Activation] timer cleanup failed", error); }
  }
  _deactivationPromise = (async () => {
    if (!provider?.dispose) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const disposal = Promise.resolve().then(() => provider.dispose?.()).then(() => undefined).catch((error) => {
      console.error("[Activation] provider disposal failed", error);
    });
    await Promise.race([
      disposal,
      new Promise<void>((resolve) => { timeout = setTimeout(() => {
        console.error("[Activation] provider disposal exceeded 5 seconds; VS Code shutdown will continue.");
        resolve();
      }, 5000); }),
    ]);
    if (timeout) clearTimeout(timeout);
  })();
  return _deactivationPromise;
}

export function getProvider(): unknown { return _provider; }
