import * as vscode from "vscode";
import * as Manual from "../mac/ManualTunnel";
import { manualTerminalSetup } from "./Terminal";
import { selectAgentRuntimeTargets } from "../features/AgentRuntimeScope";
import { OpenSshTunnelManager, LaunchOutcome } from "../mac/OpenSshTunnels";
import { macAgentRuntimeManifest, tunnelEndpointFromLaunchItem } from "../mac/MacAgentStartup";
import { agentTmuxStartupCommand, defaultAgentTmuxSessionName } from "../tunnel/AgentTmuxPolicy";
import { effectiveMacCondaEnv } from "../mac/MacAgentStartup";
import { configureMacSyncDeleteHost } from "../features/SyncResolution";
import { isLocalPortAvailable } from "../tunnel/XshellTunnelLauncher";
import { probeWorkerTelemetryTunnel } from "../tunnel/XshellTunnelPortProbe";

// "requested" is deliberately absent: an unconfirmed process is never a live tunnel.
const TUNNEL_LIVE_STATES = new Set(["verified", "existing_tunnel"]);

/** Replace the Windows session-file/terminal adapter, never PLAN or task methods. */
export function installMacHostAdapter(Provider: any): void {
  const p = Provider.prototype;
  if (p.__macHostAdapterInstalled) return;
  Object.defineProperty(p, "__macHostAdapterInstalled", { value: true });
  // Sync-scope direct local delete reuses the shared companion handle proof entry.
  configureMacSyncDeleteHost({
    handleProbe: () => require("node:path").join(vscode.extensions.getExtension("simple-local.simple-sftp-mac")?.extensionPath || "", "mac_cleanup_handles.py"),
  });
  const load = p.loadSetupConfig, apply = p.applySetupDraft, changed = p.handleConfigurationChanged;
  p.loadSetupConfig = function () {
    const setup = load.call(this), config = vscode.workspace.getConfiguration("simpleExperimentMac");
    const inspect = config.inspect(Manual.MANUAL_ENDPOINT_SETTING);
    const explicit = inspect && [inspect.globalValue, inspect.workspaceValue, inspect.workspaceFolderValue].some(value => value !== undefined);
    const saved = this.context.globalState.get("simpleExperimentMac.xshellRealtimeTunnelConfig");
    if (!explicit || saved && Object.hasOwn(saved, "workerTunnels")) return Manual.enforceManualSetup(setup);
    try { return manualTerminalSetup(Manual.setupFromManualEndpoints(config.get(Manual.MANUAL_ENDPOINT_SETTING, []), setup)); }
    catch (error: any) { return { ...Manual.setupFromManualEndpoints([], setup), manualEndpointError: error.message }; }
  };
  p.applySetupDraft = async function (patch: any, options: any = {}) {
    return apply.call(this, manualTerminalSetup({ ...this.setupConfig, ...patch }), options);
  };
  p.handleConfigurationChanged = async function (event: any) {
    if (event.affectsConfiguration("simpleExperimentMac.tunnel.manualEndpoints")) {
      const value = vscode.workspace.getConfiguration("simpleExperimentMac").get(Manual.MANUAL_ENDPOINT_SETTING, []);
      await this.applySetupDraft(Manual.setupFromManualEndpoints(value, this.setupConfig));
    }
    return changed.call(this, event);
  };
  p.refreshXshellSessionLibrary = async function () { this.xshellLibrary = { sessions: [], searchedDirs: [], existingDirs: [] }; };
  p.syncConfiguredXshellSessions = async function () { /* No .xsh files on macOS; endpoint fields are authoritative. */ };
  p.withXshellDerivedFields = function (setup: any) { return manualTerminalSetup(setup); };
  p.syncXshellConfigBeforeNetwork = async function () {
    if (this.setupConfig.manualEndpointError) throw new Error(this.setupConfig.manualEndpointError);
    await this.refreshLocalSshConfig();
    await this.assertSshTransportIdentities(this.sftpSharedTargets());
  };

  /** Lazily built system-OpenSSH forwarder; authentication stays inside SimpleSFTP Mac. */
  function manager(this: any): OpenSshTunnelManager {
    if (!this.__macTunnelManager) this.__macTunnelManager = new OpenSshTunnelManager({
      acquireAuth: async target => {
        const result: any = await vscode.commands.executeCommand("simpleSftpMac.acquireTunnelAuthentication", { host: target.host, username: target.username, port: target.port });
        if (!result || result.ok !== true || !Array.isArray(result.args) || typeof result.nonce !== "string"
          || !result.env || typeof result.env !== "object" || typeof result.env.SIMPLE_SFTP_AUTH_NONCE !== "string")
          throw new Error("配套 SimpleSFTP Mac 未返回有效的隧道认证会话。");
        return { args: result.args, env: result.env, nonce: result.nonce };
      },
      releaseAuth: nonce => Promise.resolve(vscode.commands.executeCommand("simpleSftpMac.releaseTunnelAuthentication", nonce)).catch(() => undefined),
      portAvailable: async (host, port) => isLocalPortAvailable(port, host),
      probeTunnel: async endpoint => {
        const item = this.tunnelLaunchItems().find((row: any) => row.id === endpoint.id);
        if (!item) return false;
        try {
          const probe = await probeWorkerTelemetryTunnel({ ...item.config, token: this.tunnelConfig.token }, { timeoutMs: 1500 });
          return probe.status === "ok";
        } catch { return false; }
      },
      assertBusinessAllowed: () => (require("../updates/Bootstrap") as any).assertBusinessAllowed(),
    });
    return this.__macTunnelManager;
  }

  /** Ensures Agents through the shared managed lifecycle bridge after tunnels are live. */
  async function ensureMacAgents(this: any, ids: string[]): Promise<string[]> {
    const failures: string[] = [];
    if (!ids.length) return failures;
    const manifest = await macAgentRuntimeManifest(String(this.context?.extension?.packageJSON?.version || ""));
    for (const id of ids) {
      try { await this.agentLifecycleForTarget({ id }, "ensure", manifest, true); }
      catch (error: any) { failures.push(`${id}: ${error?.message || error}`); }
    }
    return failures;
  }

  function summarize(outcomes: LaunchOutcome[], agentFailures: string[], agentAttempted: number): string {
    const live = outcomes.filter(item => TUNNEL_LIVE_STATES.has(item.state));
    const pending = outcomes.filter(item => item.state === "requested");
    const failed = outcomes.filter(item => item.state === "failed" || item.state === "cancelled");
    const parts = [`启动请求 ${outcomes.length} 个：真实隧道 ${live.length} 个，待确认 ${pending.length} 个，失败/取消 ${failed.length} 个`];
    if (failed.length) parts.push("失败明细：" + failed.map(item => item.message).join("；"));
    parts.push(agentFailures.length
      ? `Agent 就绪未确认 ${agentFailures.length} 个（隧道状态不受影响）：${agentFailures.join("；")}`
      // 没有真实隧道时根本没有尝试 Agent，不能宣称协议确认。
      : agentAttempted > 0
      ? "Agent 启动已通过共同受管生命周期协议确认；就绪与否以实际检测结果为准。"
      : "本轮没有可运行隧道，未尝试 Agent 启动；隧道确认监听后将重新触发 Agent。");
    return parts.join("。") + "。";
  }

  /** One-click system OpenSSH launch of every explicitly enabled Worker forward. */
  p.startMacSystemTunnels = async function (requireConfirm = true, ids: string[] = [], confirmLabel = "启动全部隧道") {
    if (this.setupConfig.manualEndpointError) throw new Error(this.setupConfig.manualEndpointError);
    await this.syncXshellConfigBeforeNetwork("mac system tunnels");
    const blockers = this.currentTunnelLaunchBlockers();
    if (blockers.length) throw new Error(blockers.join("；"));
    const items = selectAgentRuntimeTargets(this.tunnelLaunchItems(), ids);
    const endpoints = items.map(tunnelEndpointFromLaunchItem);
    if (!endpoints.length) throw new Error("没有明确启用的 Worker 转发端点。");
    if (requireConfirm) {
      const choice = await vscode.window.showWarningMessage(
        `将通过 macOS 系统 OpenSSH 启动 ${endpoints.length} 个 Worker 本地转发，随后由共同受管生命周期协议保障 Agent 启动。仅使用已配置的 SSH 身份与 SimpleSFTP 独立认证；不读取 Termius 私有会话，不执行任意远端命令，不启动其它调度服务。\n\n`
        + endpoints.map(item => `${item.id}: ${item.user}@${item.host}:${item.sshPort} 转发 ${item.localForwardHost}:${item.localForwardPort} → ${item.remoteAgentHost}:${item.remoteAgentPort}`).join("\n"),
        { modal: true }, confirmLabel);
      if (choice !== confirmLabel) return { declined: true, outcomes: [] as LaunchOutcome[], agentFailures: [] as string[] };
    }
    const outcomes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "启动系统隧道", cancellable: false },
      progress => manager.call(this).launchAll(endpoints, { report: message => progress.report({ message }) }));
    const liveIds = outcomes.filter(item => TUNNEL_LIVE_STATES.has(item.state)).map(item => item.id);
    const agentFailures = await ensureMacAgents.call(this, liveIds);
    const summary = summarize(outcomes, agentFailures, liveIds.length);
    if (outcomes.some(item => item.state === "failed" || item.state === "cancelled") || agentFailures.length) void vscode.window.showWarningMessage(summary);
    else void vscode.window.showInformationMessage(summary);
    return { declined: false, outcomes, agentFailures };
  };

  p.stopMacSystemTunnels = async function (ids: string[] = []) {
    const mgr = manager.call(this);
    // 全量停止必须 abort 进行中的启动（stop 不中断认证 await 后仍会 spawn 的窗口）。
    const outcomes = ids.length ? await mgr.stop(ids) : await mgr.stopAll();
    const stopped = outcomes.filter(item => item.stopped === true);
    const unproven = outcomes.filter(item => item.state === "failed");
    const absentCount = outcomes.length - stopped.length - unproven.length;
    const segments: string[] = [];
    if (stopped.length) segments.push(`已停止 ${stopped.length} 个由本插件启动的系统隧道：${stopped.map(item => item.message).join("；")}`);
    if (absentCount) segments.push(`${absentCount} 个记录已不在运行（未宣称停止动作）`);
    if (unproven.length) segments.push(`${unproven.length} 个未确认退出，未回报已停止：${unproven.map(item => item.message).join("；")}`);
    const message = segments.join("；") || "没有由本插件启动的系统隧道在运行；不会触碰其它进程。";
    if (unproven.length) void vscode.window.showWarningMessage(message);
    else void vscode.window.showInformationMessage(message);
    return outcomes;
  };

  p.startAllXshellConnections = async function (requireConfirm = true, scheduleAutoTest = true, ids: string[] = []) {
    const result = await this.startMacSystemTunnels(requireConfirm, ids, "确认启动连接");
    if (result.declined) return false;
    if (scheduleAutoTest && this.setupConfig.autoTestTunnelAfterStart) this.schedulePostLaunchAutoTest();
    else void this.ensureRealtimeConnected("mac system tunnels launched");
    return result.outcomes.some((item: LaunchOutcome) => TUNNEL_LIVE_STATES.has(item.state));
  };
  p.startAllXshellRealtimeTunnels = async function (requireConfirm = true) {
    const result = await this.startMacSystemTunnels(requireConfirm, [], "启动全部隧道");
    return !result.declined && result.outcomes.some((item: LaunchOutcome) => TUNNEL_LIVE_STATES.has(item.state));
  };
  p.launchTunnelItem = async function (item: any) {
    const result = await this.startMacSystemTunnels(true, [item.id], "启动该隧道");
    return result.outcomes.some((row: LaunchOutcome) => TUNNEL_LIVE_STATES.has(row.state));
  };
  p.startXshellRealtimeTunnel = function () { return this.startAllXshellRealtimeTunnels(); };
  p.launchUniqueXshellSessions = async function (items: any[] = []) {
    const ids = items.map(item => String(item.id || "").replace(/-(?:tunnel|agent)$/, "")).filter(Boolean);
    const result = await this.startMacSystemTunnels(false, ids, "启动该隧道");
    return result.outcomes.map((item: LaunchOutcome) => item.message);
  };

  /** Mac has no editable session file; startup is owned by the managed lifecycle protocol. */
  p.agentStartupTargets = function () {
    const targets: any[] = [];
    for (const worker of this.enabledWorkerConfigs()) {
      const dirs = this.agentRuntimeDirs(worker.agentProjectDir, worker.agentInstallDir);
      const sessionPrefix = (this.setupConfig as any).sessionPrefix || this.setupConfig.remoteTmuxSessionPrefix;
      const workerCommand = agentTmuxStartupCommand({ role: "worker", endpointId: worker.id, host: worker.remoteAgentHost,
        port: worker.remoteTelemetryPort || worker.remoteAgentPort, installDir: dirs.installDir, workDir: dirs.workDir,
        condaEnv: effectiveMacCondaEnv(worker, this.setupConfig.condaEnv), sessionPrefix });
      targets.push({ id: worker.id, filePath: "", tmuxSessionName: defaultAgentTmuxSessionName("worker", worker.id, sessionPrefix),
        command: `unset SIMPLE_EXPERIMENT_HUB_UPLINK_URL; ${workerCommand}` });
    }
    return targets;
  };
  p.writeXshellAgentStartupCommands = async function (showMessage = true, requireConfirm = true, serverIds: string[] = []) {
    void requireConfirm;
    const targets = selectAgentRuntimeTargets(this.agentStartupTargets(), serverIds);
    if (!targets.length) {
      void vscode.window.showWarningMessage("没有可管理的 Worker Agent 启动目标。请先配置并启用 Worker 端点。");
      return [];
    }
    const results = targets.map((target: any) => ({ id: target.id, changed: false, skippedReason: "mac_openssh_managed_lifecycle",
      summary: `${target.id}: Mac 无可编辑的会话文件；Agent 启动由共同受管生命周期协议保障，隧道由系统 OpenSSH 一键启动` }));
    if (showMessage) void vscode.window.showInformationMessage(`Agent 启动接管确认：${results.map((item: any) => item.summary).join("；")}`);
    this.postState();
    return results;
  };

  /** Termius remains the supported manual fallback; this entry never launches tunnels.
   * The released Mac contract renders the full Agent/tmux guide text (ports, quoted
   * paths, session-preserving tmux commands) and treats opening it as no receipt. */
  p.generateTunnelScript = function () { return this.showManualAgentGuide(); };
  // Retired Hub branches remain the Windows no-op/retired entry; never override them.
  p.integration = function () {
    const provider = this;
    return { probeLocalTunnel: (setup: any) => require("../tunnel/XshellTunnelPortProbe").probeLocalTunnel({ ...setup, token: provider.tunnelConfig.token }),
      launchTunnel: async (config: any) => {
        const item = provider.tunnelLaunchItems().find((row: any) => row.config.localForwardPort === config.localForwardPort);
        if (!item) return { launched: false, message: "没有匹配的 Worker 转发端点。" };
        const result = await provider.startMacSystemTunnels(false, [item.id], "启动该隧道");
        const outcome = result.outcomes[0];
        return { launched: Boolean(outcome && TUNNEL_LIVE_STATES.has(outcome.state)), message: outcome ? outcome.message : "启动请求未发出。" };
      } };
  };
  const originalDispose = p.dispose;
  p.dispose = async function () {
    try { return await originalDispose?.call(this); }
    finally { const held = this.__macTunnelManager; this.__macTunnelManager = undefined; await held?.dispose?.(); }
  };
}
