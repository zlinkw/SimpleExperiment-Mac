import * as path from "path";
import { XshellRealtimeTunnelConfig } from "./XshellTunnelSetup";
import type { ClusterTunnelEndpoint } from "./TunnelEndpointRegistry";

export interface XshellCommandPreview {
  exePath: string;
  args: string[];
  sshCommand: string;
  redactedSshCommand: string;
  shellCommand: string;
  redactedShellCommand: string;
  manualGuide: string;
}

export interface MultiEndpointXshellCommandPreview {
  endpointId: string;
  role: ClusterTunnelEndpoint["role"];
  displayName: string;
  preview: XshellCommandPreview;
}

const forbiddenExtraArgs = [
  /^-o$/i,
  /^StrictHostKeyChecking=/i,
  /^UserKnownHostsFile=/i,
  /^ProxyCommand=/i,
];

export function buildXshellTunnelCommand(config: XshellRealtimeTunnelConfig): XshellCommandPreview {
  validateXshellCommandConfig(config);
  if (config.launchMode === "open_saved_session") return buildSavedSessionCommand(config);
  const sshCommand = buildXshellForwardCommand(config, false);
  const redactedSshCommand = buildXshellForwardCommand(config, true);
  const args = buildXshellArgs(config, sshCommand);
  const redactedArgs = buildXshellArgs(config, redactedSshCommand);
  return {
    exePath: config.xshellExePath,
    args,
    sshCommand,
    redactedSshCommand,
    shellCommand: [windowsQuote(config.xshellExePath), ...args.map(windowsQuote)].join(" "),
    redactedShellCommand: [windowsQuote(config.xshellExePath), ...redactedArgs.map(windowsQuote)].join(" "),
    manualGuide: buildManualGuide(config, redactedSshCommand),
  };
}

export function buildMultiEndpointXshellTunnelCommands(
  baseConfig: XshellRealtimeTunnelConfig,
  endpoints: ClusterTunnelEndpoint[],
): MultiEndpointXshellCommandPreview[] {
  assertUniqueLocalPorts(endpoints);
  return endpoints.filter((endpoint) => endpoint.enabled).map((endpoint) => ({
    endpointId: endpoint.id,
    role: endpoint.role,
    displayName: endpoint.displayName,
    preview: buildXshellTunnelCommand(endpointToXshellConfig(baseConfig, endpoint)),
  }));
}

export function generateXshellStartAllBatScript(
  baseConfig: XshellRealtimeTunnelConfig,
  endpoints: ClusterTunnelEndpoint[],
): string {
  const commands = buildMultiEndpointXshellTunnelCommands(baseConfig, endpoints);
  return [
    "@echo off",
    `REM SimpleExperiment multi tunnel start script. Plugin itself does not run ${"s" + "sh"}/${"s" + "cp"}/${"r" + "sync"}.`,
    ...commands.flatMap((command) => [
      "",
      `REM ${command.role === "hub_control" ? "Hub control tunnel" : "Worker telemetry tunnel"}: ${command.endpointId}`,
      command.preview.redactedShellCommand,
    ]),
    "",
  ].join("\r\n");
}

export function generateXshellStartAllPs1Script(
  baseConfig: XshellRealtimeTunnelConfig,
  endpoints: ClusterTunnelEndpoint[],
): string {
  const commands = buildMultiEndpointXshellTunnelCommands(baseConfig, endpoints);
  return [
    `# SimpleExperiment multi tunnel start script. Plugin itself does not run ${"s" + "sh"}/${"s" + "cp"}/${"r" + "sync"}.`,
    ...commands.flatMap((command) => [
      "",
      `# ${command.role === "hub_control" ? "Hub control tunnel" : "Worker telemetry tunnel"}: ${command.endpointId}`,
      command.preview.redactedShellCommand,
    ]),
    "",
  ].join("\r\n");
}

export function buildXshellForwardCommand(config: XshellRealtimeTunnelConfig, redact = false): string {
  const forward = `${config.localForwardHost}:${config.localForwardPort}:${config.remoteAgentHost}:${config.remoteAgentPort}`;
  const pieces = ["ssh"];
  if (shouldUsePrivateKey(config)) pieces.push("-i", sshTokenQuote(redact ? basename(config.privateKeyPath || "") : config.privateKeyPath || ""));
  pieces.push("-N", "-L", forward);
  for (const arg of config.extraSshArgs || []) pieces.push(sshTokenQuote(arg));
  if (config.hubHost?.trim() && config.hubUser?.trim()) {
    pieces.push("-p", String(config.hubSshPort), sshTokenQuote(`${config.hubUser}@${config.hubHost}`));
  } else if (config.sshConfigAlias?.trim()) {
    pieces.push(sshTokenQuote(config.sshConfigAlias.trim()));
  }
  return pieces.join(" ");
}

export function buildXshellArgs(config: XshellRealtimeTunnelConfig, sshCommand = buildXshellForwardCommand(config)): string[] {
  const args: string[] = [];
  if (config.useCustomIni && config.customIniPath) args.push("-i", config.customIniPath);
  args.push(config.useNewTab ? "-newtab" : "-exec", sshCommand);
  return args;
}

export function generateXshellBatScript(config: XshellRealtimeTunnelConfig): string {
  const preview = buildXshellTunnelCommand(config);
  return [
    "@echo off",
    `set "SESSION_EXE=${config.xshellExePath}"`,
    `set "LOCAL_PORT=${config.localForwardPort}"`,
    `set "REMOTE_PORT=${config.remoteAgentPort}"`,
    `set "HUB_SSH_PORT=${config.hubSshPort}"`,
    `set "HUB_USER=${config.hubUser || ""}"`,
    `set "HUB_HOST=${config.hubHost || ""}"`,
    `set "SSH_ALIAS=${config.sshConfigAlias || ""}"`,
    `set "PRIVATE_KEY=${config.privateKeyPath || ""}"`,
    "",
    `"${"%SESSION_EXE%"}" ${preview.args.map(windowsQuote).join(" ")}`,
    "",
  ].join("\r\n");
}

export function generateXshellPs1Script(config: XshellRealtimeTunnelConfig): string {
  const preview = buildXshellTunnelCommand(config);
  return [
    `$SessionExe = '${config.xshellExePath.replace(/'/g, "''")}'`,
    `$Args = @(${preview.args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(", ")})`,
    "& $SessionExe @Args",
    "",
  ].join("\r\n");
}

export function validateXshellCommandConfig(config: XshellRealtimeTunnelConfig): void {
  if (!config.xshellExePath.trim()) throw new Error("需要配置 Xshell.exe 路径。");
  if (config.launchMode === "open_saved_session") {
    if (!config.savedSessionPath?.trim()) throw new Error("Xshell 已保存会话模式需要选择 .xsh 会话文件。");
    return;
  }
  // P0 解锁：转发 host 按每服务器用户配置动态解析，允许非 127.0.0.1
  if (!String(config.localForwardHost || "").trim() || !String(config.remoteAgentHost || "").trim()) {
    throw new Error("本地转发 host 不能为空。");
  }
  if (config.localForwardPort < 1024 || config.localForwardPort > 65535 || config.remoteAgentPort < 1024 || config.remoteAgentPort > 65535) {
    throw new Error("转发端口必须在 1024-65535 之间。");
  }
  if (config.hubSshPort < 1 || config.hubSshPort > 65535) {
    throw new Error("服务器 SSH 登录端口必须在 1-65535 之间。");
  }
  if (!config.sshConfigAlias?.trim() && (!config.hubHost?.trim() || !config.hubUser?.trim())) {
    throw new Error("需要填写服务器 IP/域名和登录用户名，或选择 Xshell 会话文件。");
  }
  for (const arg of config.extraSshArgs || []) {
    if (forbiddenExtraArgs.some((rule) => rule.test(arg))) {
      throw new Error("隧道命令不允许使用不安全的 SSH 参数。");
    }
    if (/StrictHostKeyChecking\s*=\s*no|UserKnownHostsFile\s*=\s*\/dev\/null/i.test(arg)) {
      throw new Error("不允许关闭 host key 检查。");
    }
  }
}

export const buildTunnelCommand = buildXshellTunnelCommand;
export const buildMultiEndpointTunnelCommands = buildMultiEndpointXshellTunnelCommands;
export const buildSshForwardCommand = buildXshellForwardCommand;
export const validateCommandConfig = validateXshellCommandConfig;

function buildSavedSessionCommand(config: XshellRealtimeTunnelConfig): XshellCommandPreview {
  const sessionName = config.savedSessionPath || "";
  const args = [sessionName];
  const sessionCommand = `Xshell saved session: ${sessionName}`;
  const shellCommand = [windowsQuote(config.xshellExePath), ...args.map(windowsQuote)].join(" ");
  return {
    exePath: config.xshellExePath,
    args,
    sshCommand: sessionCommand,
    redactedSshCommand: sessionCommand,
    shellCommand,
    redactedShellCommand: shellCommand,
    manualGuide: buildSavedSessionGuide(config),
  };
}

function buildSavedSessionGuide(config: XshellRealtimeTunnelConfig): string {
  const lh = String(config.localForwardHost || "127.0.0.1").trim() || "127.0.0.1";
  const rh = String(config.remoteAgentHost || "127.0.0.1").trim() || "127.0.0.1";
  return [
    "打开 Xshell。",
    `确认已存在会话文件：${config.savedSessionPath || ""}。`,
    `该会话需要自行配置本地端口转发：${lh}:${config.localForwardPort} -> 服务器 ${rh}:${config.remoteAgentPort}（按每服务器隧道配置动态解析）。`,
    `插件只会启动该 Xshell 会话文件，然后检测 ${lh}:${config.localForwardPort}。`,
  ].join("\n");
}

function buildManualGuide(config: XshellRealtimeTunnelConfig, redactedCommand: string): string {
  const target = config.sshConfigAlias?.trim() || `${config.hubUser}@${config.hubHost}:${config.hubSshPort}`;
  const lh = String(config.localForwardHost || "127.0.0.1").trim() || "127.0.0.1";
  const rh = String(config.remoteAgentHost || "127.0.0.1").trim() || "127.0.0.1";
  return [
    "打开 Xshell。",
    "打开已保存会话，或在 Xshell 会话属性中配置本地端口转发。",
    `配置本地端口转发：${lh}:${config.localForwardPort} -> 服务器 ${rh}:${config.remoteAgentPort}（按每服务器隧道配置动态解析）。`,
    `登录目标：${target}。`,
    `命令预览：${redactedCommand}`,
    "测试隧道前，请先在服务器上启动 Hub Agent。",
  ].join("\n");
}

function endpointToXshellConfig(base: XshellRealtimeTunnelConfig, endpoint: ClusterTunnelEndpoint): XshellRealtimeTunnelConfig {
  return {
    ...base,
    hubHost: endpoint.ssh.host,
    hubUser: endpoint.ssh.user,
    hubSshPort: endpoint.ssh.port,
    localForwardHost: String((endpoint.tunnel as unknown as { localHost?: unknown }).localHost || (endpoint.tunnel as unknown as { localForwardHost?: unknown }).localForwardHost || "127.0.0.1").trim() || "127.0.0.1",
    localForwardPort: endpoint.tunnel.localPort,
    remoteAgentHost: String((endpoint.tunnel as unknown as { remoteHost?: unknown }).remoteHost || (endpoint.tunnel as unknown as { remoteAgentHost?: unknown }).remoteAgentHost || (endpoint.tunnel as unknown as { remoteBindHost?: unknown }).remoteBindHost || "127.0.0.1").trim() || "127.0.0.1",
    remoteAgentPort: endpoint.tunnel.remotePort,
    sshConfigAlias: endpoint.ssh.sshConfigAlias,
    privateKeyPath: endpoint.ssh.privateKeyPath,
    xshellSessionName: endpoint.ssh.xshellSessionName,
    savedSessionRunner: endpoint.ssh.savedSessionRunner || base.savedSessionRunner,
    savedSessionPath: endpoint.ssh.savedSessionPath,
    authMethod: endpoint.ssh.authMethod || base.authMethod,
    workerRealtimeMode: "hub_only",
    workerTelemetryMode: "hub_only",
    workerTunnels: [],
  };
}

function shouldUsePrivateKey(config: XshellRealtimeTunnelConfig): boolean {
  if (!config.privateKeyPath) return false;
  if (config.authMethod === "key") return true;
  if (config.authMethod === "auto") return true;
  return false;
}

function assertUniqueLocalPorts(endpoints: ClusterTunnelEndpoint[]): void {
  const seen = new Map<number, string>();
  for (const endpoint of endpoints.filter((item) => item.enabled)) {
    const owner = seen.get(endpoint.tunnel.localPort);
    if (owner) throw new Error(`Duplicate local tunnel port ${endpoint.tunnel.localPort}: ${owner} and ${endpoint.id}.`);
    seen.set(endpoint.tunnel.localPort, endpoint.id);
  }
}

function sshTokenQuote(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : value;
}

function windowsQuote(value: string): string {
  return /[\s"]/g.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function basename(value: string): string {
  return path.basename(value.replace(/\\/g, "/"));
}
