/** Equivalent of a saved Windows connection: explicit native forwarding fields. */
export function configuredWorkerTransport(worker: any): boolean {
  return Boolean(String(worker.workerHost || worker.hubHost || "").trim()
    && String(worker.workerUser || worker.hubUser || "").trim()
    && Number.isInteger(worker.localForwardPort) && worker.localForwardPort >= 1024 && worker.localForwardPort <= 65535
    && Number.isInteger(worker.remoteTelemetryPort || worker.remoteAgentPort)
    && (worker.remoteTelemetryPort || worker.remoteAgentPort) >= 1024 && (worker.remoteTelemetryPort || worker.remoteAgentPort) <= 65535);
}
export function configuredTerminal(setup: any): boolean {
  return (setup.workerTunnels || []).some((worker: any) => worker.enabled !== false && configuredWorkerTransport(worker));
}
/** Only the desktop terminal launch capability differs. Keep all saved server fields. */
export function manualTerminalSetup(setup: any): any {
  // Mac has no editable saved session files; the shared managed lifecycle owns Agent startup.
  return { ...setup, launchMode: "manual_guide", autoStartTunnelOnExtensionActivation: false, manualProvider: "termius", macManagedSessions: true };
}
export function termiusInstructions(items: any[]): string {
  return "# Termius 手动转发\n\n此页只提供平台入口，不表示隧道或 Agent 已经启动；完成后回插件检测。项目准备、Agent 与独立 Scheduler 更新、确认和失败恢复使用共同的 Windows 实现。\n\n"
    + items.map(item => { const c = item.config; return `## ${item.displayName || item.id}\n\nSSH：${c.hubUser}@${c.hubHost}:${c.hubSshPort}。手动建立 ${c.localForwardHost}:${c.localForwardPort} → ${c.remoteAgentHost}:${c.remoteAgentPort}。\n\n终端日志使用面板的实际任务绑定，不按会话前缀关闭或迁移。分离 tmux 可按 Ctrl+B 后按 D。\n`; }).join("\n");
}
