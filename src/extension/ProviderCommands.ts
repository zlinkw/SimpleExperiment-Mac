/**
 * ProviderCommands - 命令注册逻辑抽离 (Phase 2)
 * 搬运自 src/extension.ts 18000-20000 段 命令注册，保持原逻辑不变，委托给 CommandFactory
 */

import type { FactoryContext } from "../factories/types";
import type { CommandFactory } from "../factories/CommandFactory";

export interface ProviderCommandDeps {
  readonly factoryContext: FactoryContext;
  readonly commandFactory: CommandFactory;
  readonly provider?: Record<string, (...args: unknown[]) => unknown>;
  readonly hostOperationLease?: { withLease?: (label: string, fn: () => unknown) => unknown };
}

export function resolveCommandHandlerMap(provider: Record<string, (...args: unknown[]) => unknown> | undefined): Record<string, (...args: unknown[]) => unknown> {
  if (!provider) return {};
  // 映射与 extension.ts hostCommand 注册保持一致；注册阶段会拒绝任何漏绑项。
  const map: Record<string, (...a: unknown[]) => unknown> = {};
  const bind = (cmdId: string, method: string) => {
    const fn = (provider as any)[method];
    if (typeof fn === "function") map[cmdId] = (...args: unknown[]) => (fn as any).apply(provider, args);
  };
  bind("simpleExperimentMac.openPanel", "openPanel");
  bind("simpleExperimentMac.copyPanelDiagnostics", "copyPanelDiagnosticsFromUi");
  bind("simpleExperimentMac.restorePanel", "restorePanelFromUi");
  bind("simpleExperimentMac.quickSetup", "quickSetup");
  bind("simpleExperimentMac.configureXshellSavedSessions", "configureXshellSavedSessions");
  bind("simpleExperimentMac.configureXshellAgentSessions", "configureXshellAgentSessions");
  bind("simpleExperimentMac.writeXshellAgentStartupCommands", "writeXshellAgentStartupCommands");
  bind("simpleExperimentMac.configureWorkerTunnels", "configureWorkerTunnels");
  bind("simpleExperimentMac.configureTunnelPorts", "configureTunnelPorts");
  bind("simpleExperimentMac.configureXshellRealtimeTunnel", "configureXshellRealtimeTunnel");
  bind("simpleExperimentMac.startHubTunnel", "startHubTunnel");
  bind("simpleExperimentMac.startWorkerTunnel", "startWorkerTunnel");
  bind("simpleExperimentMac.startXshellRealtimeTunnel", "startXshellRealtimeTunnel");
  bind("simpleExperimentMac.startAllXshellRealtimeTunnels", "startAllXshellRealtimeTunnels");
  bind("simpleExperimentMac.startAllXshellAgentSessions", "startAllXshellAgentSessions");
  bind("simpleExperimentMac.startAllXshellConnections", "startAllXshellConnections");
  bind("simpleExperimentMac.testAllTunnels", "testTunnel");
  bind("simpleExperimentMac.showTunnelEndpointRegistry", "showTunnelEndpointRegistry");
  bind("simpleExperimentMac.testXshellTunnel", "testTunnel");
  bind("simpleExperimentMac.restartRealtimeStream", "restartRealtimeStream");
  bind("simpleExperimentMac.pauseRealtimeStream", "pauseRealtimeStream");
  bind("simpleExperimentMac.resumeRealtimeStream", "resumeRealtimeStream");
  bind("simpleExperimentMac.pauseAllNetworkActivity", "pauseAllNetworkActivity");
  bind("simpleExperimentMac.generateXshellTunnelScript", "generateTunnelScript");
  bind("simpleExperimentMac.openTunnelStatus", "openTunnelStatus");
  bind("simpleExperimentMac.runXshellRealIntegrationCheck", "runXshellRealIntegrationCheck");
  bind("simpleExperimentMac.manualRefresh", "manualSnapshot");
  bind("simpleExperimentMac.importOfflineBundle", "importOffline");
  bind("simpleExperimentMac.clearCache", "clearCacheFromUi");
  bind("simpleExperimentMac.bootstrapProject", "bootstrapProjectFromUi");
  bind("simpleExperimentMac.prepareAgents", "prepareAgentsForFirstRun");
  bind("simpleExperimentMac.verifyAgentVersion", "verifyAgentVersionManually");
  bind("simpleExperimentMac.openSetupGuide", "openSetupGuide");
  bind("simpleExperimentMac.openLastCheckStaticReport", "openLastCheckStaticReportFromUi");
  bind("simpleExperimentMac.copyLastCheckStaticReport", "copyLastCheckStaticReportFromUi");
  bind("simpleExperimentMac.runCheckStatic", "runCheckStaticFromUi");
  return map;
}

export function registerProviderCommands(deps: ProviderCommandDeps, vscodeContext: { subscriptions: { push(...args: unknown[]): unknown } } & Record<string, unknown>): unknown[] {
  // 委托给 CommandFactory.registerAll，保持编排与 extension.ts activate 中一致
  const handlerMap = resolveCommandHandlerMap(deps.provider);
  const factoryContext = { ...deps.factoryContext, handlerMap } as FactoryContext;
  return (deps.commandFactory.registerAll as (ctx: unknown, fc: unknown) => unknown[])(vscodeContext as unknown, factoryContext);
}

export class ProviderCommands {
  constructor(private readonly deps: ProviderCommandDeps) {}
  register(vscodeContext: { subscriptions: { push(...args: unknown[]): unknown } } & Record<string, unknown>): unknown[] {
    return registerProviderCommands(this.deps, vscodeContext);
  }
  descriptors(): unknown[] {
    return ((this.deps.commandFactory as unknown as { createDescriptors?: (ctx: unknown) => unknown[] }).createDescriptors?.(this.deps.factoryContext) || []) as unknown[];
  }
}
