import * as fs from "fs/promises";
import * as path from "path";
import { XshellLaunchResult, launchXshellTunnelProcess } from "./XshellProcessLauncher";
import { buildXshellTunnelCommand, XshellCommandPreview } from "./XshellTunnelCommandBuilder";
import { isLocalPortAvailable, recommendAvailableLocalPort } from "./XshellTunnelLauncher";
import { probeLocalTunnel, TunnelProbeResult } from "./XshellTunnelPortProbe";
import { XshellRealtimeTunnelConfig } from "./XshellTunnelSetup";

export interface XshellExecutableResult {
  found: boolean;
  path?: string;
  source: "configured" | "common_install_path" | "path_env" | "portable_candidate" | "user_selected" | "not_found";
  message?: string;
}

export interface XshellExecutableValidation {
  ok: boolean;
  path: string;
  exists: boolean;
  isFile: boolean;
  extensionOk: boolean;
  launchable?: boolean;
  versionText?: string;
  message?: string;
}

export interface XshellRealIntegrationReport {
  schemaVersion: 1;
  generatedAt: string;
  xshell: {
    exePath: string;
    found: boolean;
    launchAttempted: boolean;
    launchSucceeded?: boolean;
  };
  tunnel: {
    localForwardPort: number;
    remoteAgentPort: number;
    localPortOpen: boolean;
    healthOk: boolean;
    latencyMs?: number;
  };
  agent: {
    reachable: boolean;
    agentVersion?: string;
    apiVersion?: string;
    capabilitiesOk: boolean;
    missingCapabilities: string[];
  };
  realtime: {
    websocketOk: boolean;
    sseOk: boolean;
    fallbackMode?: "websocket" | "sse" | "snapshot";
  };
  fileTransfer: {
    listOk: boolean;
    downloadOk: boolean;
    uploadOk: boolean;
    sha256Ok: boolean;
    message?: string;
  };
  overall: "ok" | "warning" | "failed";
  suggestions: string[];
}

export interface XshellIntegrationCheckResult {
  executable: XshellExecutableResult;
  validation?: XshellExecutableValidation;
  command?: XshellCommandPreview;
  launch?: XshellLaunchResult;
  probe: TunnelProbeResult;
  report: XshellRealIntegrationReport;
}

export class XshellIntegration {
  constructor(private readonly options: { configuredPath?: string; workspaceRoot?: string; userSelectedPath?: string; token?: string } = {}) {}

  async findExecutable(): Promise<XshellExecutableResult> {
    const configured = this.options.configuredPath ? [{ path: this.options.configuredPath, source: "configured" as const }] : [];
    const common = commonInstallPaths().map((item) => ({ path: item, source: "common_install_path" as const }));
    const pathEnv = pathCandidates().map((item) => ({ path: item, source: "path_env" as const }));
    const portable = this.options.workspaceRoot ? portableCandidates(this.options.workspaceRoot).map((item) => ({ path: item, source: "portable_candidate" as const })) : [];
    const selected = this.options.userSelectedPath ? [{ path: this.options.userSelectedPath, source: "user_selected" as const }] : [];
    for (const candidate of [...configured, ...common, ...pathEnv, ...portable, ...selected]) {
      const validation = await this.validateExecutable(candidate.path);
      if (validation.ok) return { found: true, path: candidate.path, source: candidate.source };
    }
    return { found: false, source: "not_found", message: "未找到 Xshell.exe，请手动选择。" };
  }

  async validateExecutable(file: string): Promise<XshellExecutableValidation> {
    const extensionOk = path.basename(file).toLowerCase() === "xshell.exe";
    try {
      const stat = await fs.stat(file);
      const isFile = stat.isFile();
      return {
        ok: extensionOk && isFile,
        path: file,
        exists: true,
        isFile,
        extensionOk,
        launchable: extensionOk && isFile,
        message: extensionOk && isFile ? "Xshell.exe 有效。" : "该路径不是 Xshell.exe。",
      };
    } catch {
      return { ok: false, path: file, exists: false, isFile: false, extensionOk, launchable: false, message: "Xshell.exe 不存在。" };
    }
  }

  buildTunnelCommand(config: XshellRealtimeTunnelConfig): XshellCommandPreview {
    return buildXshellTunnelCommand(config);
  }

  async launchTunnel(config: XshellRealtimeTunnelConfig): Promise<XshellLaunchResult> {
    return launchXshellTunnelProcess(config);
  }

  async probeLocalTunnel(config: XshellRealtimeTunnelConfig): Promise<TunnelProbeResult> {
    return probeLocalTunnel({ ...config, token: this.options.token });
  }

  async runIntegrationCheck(config: XshellRealtimeTunnelConfig): Promise<XshellIntegrationCheckResult> {
    const executable = await this.findExecutable();
    const validation = executable.path ? await this.validateExecutable(executable.path) : undefined;
    const command = validation?.ok ? this.buildTunnelCommand({ ...config, xshellExePath: executable.path || config.xshellExePath }) : undefined;
    const probe = await this.probeLocalTunnel(config);
    const report = buildIntegrationReport(config, executable, probe);
    return { executable, validation, command, probe, report };
  }
}

export function buildIntegrationReport(
  config: XshellRealtimeTunnelConfig,
  executable: XshellExecutableResult,
  probe: TunnelProbeResult,
  launch?: XshellLaunchResult,
): XshellRealIntegrationReport {
  const missing = probe.missingCapabilities || [];
  const suggestions = [probe.suggestion, executable.message].filter(Boolean) as string[];
  const fileOk = probe.fileApiOk && probe.fileCapabilities?.supportsList && probe.fileCapabilities?.supportsDownload && probe.fileCapabilities?.supportsUploadChunk;
  const realtimeOk = probe.streamApiOk;
  const overall = probe.status === "ok" ? "ok" : (probe.healthOk || probe.capabilitiesOk ? "warning" : "failed");
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    xshell: {
      exePath: executable.path || config.xshellExePath,
      found: executable.found,
      launchAttempted: Boolean(launch?.attempted),
      launchSucceeded: launch?.launched,
    },
    tunnel: {
      localForwardPort: config.localForwardPort,
      remoteAgentPort: config.remoteAgentPort,
      localPortOpen: probe.tcpOpen,
      healthOk: probe.healthOk,
      latencyMs: probe.latencyMs,
    },
    agent: {
      reachable: probe.healthOk,
      agentVersion: probe.agentVersion,
      apiVersion: probe.apiVersion,
      capabilitiesOk: probe.capabilitiesOk,
      missingCapabilities: missing,
    },
    realtime: {
      websocketOk: Boolean(probe.capabilities?.endpoints.websocketEvents),
      sseOk: Boolean(probe.capabilities?.endpoints.sseEvents),
      fallbackMode: realtimeOk ? (probe.capabilities?.endpoints.websocketEvents ? "websocket" : "sse") : (probe.healthOk ? "snapshot" : undefined),
    },
    fileTransfer: {
      listOk: Boolean(probe.fileCapabilities?.supportsList),
      downloadOk: Boolean(probe.fileCapabilities?.supportsDownload),
      uploadOk: Boolean(probe.fileCapabilities?.supportsUploadChunk),
      sha256Ok: Boolean(probe.fileCapabilities?.supportsSha256),
      message: fileOk ? "文件 API 可用。" : "文件 API 不可用或能力不完整。",
    },
    overall,
    suggestions,
  };
}

export { isLocalPortAvailable, recommendAvailableLocalPort };

function commonInstallPaths(): string[] {
  return [
    "C:\\Program Files\\NetSarang\\Xshell 8\\Xshell.exe",
    "C:\\Program Files (x86)\\NetSarang\\Xshell 8\\Xshell.exe",
    "C:\\Program Files\\NetSarang\\Xshell 7\\Xshell.exe",
    "C:\\Program Files (x86)\\NetSarang\\Xshell 7\\Xshell.exe",
  ];
}

function portableCandidates(root: string): string[] {
  return [
    path.join(root, "Xshell.exe"),
    path.join(root, "tools", "Xshell.exe"),
    path.join(root, "bin", "Xshell.exe"),
  ];
}

function pathCandidates(): string[] {
  return (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "Xshell.exe"));
}
