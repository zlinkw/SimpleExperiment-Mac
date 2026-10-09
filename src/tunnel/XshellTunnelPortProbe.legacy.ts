import * as net from "net";
import {
  AgentCapabilitiesResponse,
  checkAgentApiCompatibility,
  expectedAgentApiVersion,
  FileCapabilitiesResponse,
  validateAgentCapabilities,
  validateAgentHealth,
  validateFileCapabilities,
} from "./AgentCapabilities";
import { XshellRealtimeTunnelConfig } from "./XshellTunnelSetup";
import { validateWorkerTelemetryCapabilities } from "./WorkerTelemetryApi";

export type TunnelProbeStatus =
  | "ok"
  | "local_port_closed"
  | "local_port_occupied_by_unknown"
  | "agent_unreachable"
  | "agent_version_mismatch"
  | "agent_token_invalid"
  | "file_api_unavailable"
  | "stream_api_unavailable"
  | "timeout";

export interface TunnelProbeResult {
  status: TunnelProbeStatus;
  localForwardPort: number;
  remoteAgentPort: number;
  tcpOpen: boolean;
  healthOk: boolean;
  capabilitiesOk: boolean;
  fileApiOk: boolean;
  streamApiOk: boolean;
  latencyMs?: number;
  agentVersion?: string;
  apiVersion?: string;
  expectedAgentVersion?: string;
  projectRoot?: string;
  agentInstallDir?: string;
  schedulerDependencies?: unknown;
  capabilities?: AgentCapabilitiesResponse;
  fileCapabilities?: FileCapabilitiesResponse;
  missingCapabilities?: string[];
  message: string;
  suggestion?: string;
}

export interface WorkerTelemetryProbeResult {
  status: "ok" | "local_port_closed" | "agent_unreachable" | "agent_token_invalid" | "worker_api_invalid" | "timeout";
  localForwardPort: number;
  remoteTelemetryPort: number;
  tcpOpen: boolean;
  healthOk: boolean;
  capabilitiesOk: boolean;
  streamApiOk: boolean;
  gpuApiOk: boolean;
  workerTasksApiOk: boolean;
  latencyMs?: number;
  projectRoot?: string;
  agentInstallDir?: string;
  schedulerDependencies?: unknown;
  capabilities?: unknown;
  warnings: string[];
  message: string;
  suggestion?: string;
}

type HubProbeConfig = Pick<XshellRealtimeTunnelConfig, "localForwardHost" | "localForwardPort" | "remoteAgentHost" | "remoteAgentPort" | "realtimeEnabled" | "fileTransferEnabled"> & { token?: string };
type WorkerProbeConfig = Pick<XshellRealtimeTunnelConfig, "localForwardHost" | "localForwardPort" | "remoteAgentHost" | "remoteAgentPort" | "realtimeEnabled"> & { token?: string };
function resolveProbeHost(config: { localForwardHost?: unknown }, fallback = "127.0.0.1"): string {
  const text = String((config as unknown as { localForwardHost?: unknown }).localForwardHost || "").trim();
  return text || fallback;
}
function resolveProbeBase(config: { localForwardHost?: unknown; localForwardPort: number }): string {
  return `http://${resolveProbeHost(config)}:${config.localForwardPort}`;
}
async function fetchHealthWithFallback(base: string, headers: Record<string, string> | undefined, timeoutMs: number): Promise<Response> {
  const primary = await timedFetch(`${base}/api/health`, { headers }, timeoutMs);
  if (primary.ok) return primary;
  // 兼容降级：worker_telemetry 旧路径 /health 或 /api/version
  try {
    const fallback = await timedFetch(`${base}/health`, { headers }, timeoutMs);
    if (fallback.ok) return fallback;
  } catch {}
  // 如仍不可达，尝试 /api/version 作最后降级（版本比对路径）
  return primary;
}

async function readProbeHealth(response: Response, base: string, headers: Record<string, string> | undefined, deadline: number): Promise<any> {
  let health = await response.json();
  // Agent health responds immediately while one shared dependency check runs.
  // Only wait for an explicitly pending check, within this probe's existing budget.
  while (health?.schedulerDependencies?.pending === true && Date.now() + 200 < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const next = await fetchHealthWithFallback(base, headers, Math.max(1, deadline - Date.now()));
    if (!next.ok) throw new Error(`Agent 依赖检查返回 HTTP ${next.status}。`);
    health = await next.json();
  }
  return health;
}

export async function probeLocalTunnel(
  config: HubProbeConfig,
  options: { timeoutMs?: number; expectedApiVersion?: string } = {},
): Promise<TunnelProbeResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const host = resolveProbeHost(config);
  const base = resolveProbeBase(config);
  const baseResult = {
    localForwardPort: config.localForwardPort,
    remoteAgentPort: config.remoteAgentPort,
    tcpOpen: false,
    healthOk: false,
    capabilitiesOk: false,
    fileApiOk: false,
    streamApiOk: false,
  };

  if (!(await tcpOpen(config.localForwardPort, timeoutMs, host))) {
    return {
      ...baseResult,
      status: "local_port_closed",
      message: `${host}:${config.localForwardPort} 未打开。`,
      suggestion: `请启动 Xshell 隧道会话，并确认 Hub Agent 已在 ${host} 上运行（端口按每服务器隧道配置动态解析）。`,
    };
  }

  const headers = config.token ? { "X-Simple-Agent-Token": config.token } : undefined;
  try {
    const healthResponse = await fetchHealthWithFallback(base, headers as unknown as Record<string, string> | undefined, timeoutMs);
    if (healthResponse.status === 401 || healthResponse.status === 403) return tokenInvalid(baseResult, config);
    if (!healthResponse.ok) {
      return {
        ...baseResult,
        tcpOpen: true,
        status: "local_port_occupied_by_unknown",
        latencyMs: Date.now() - started,
        message: `/api/health 返回 HTTP ${healthResponse.status}。`,
        suggestion: "请检查该本地端口是否真的转发到了 Hub Agent。",
      };
    }
    const health = await readProbeHealth(healthResponse, base, headers, started + timeoutMs);
    if (!validateAgentHealth(health)) {
      return {
        ...baseResult,
        tcpOpen: true,
        status: "local_port_occupied_by_unknown",
        latencyMs: Date.now() - started,
        message: "/api/health 返回格式不兼容 SimpleExperiment Hub Agent。",
        suggestion: "请确认本地端口目标正确，并升级 Hub Agent runtime。",
      };
    }
    const projectRoot = String(health.projectRoot || "").trim();
    const agentInstallDir = String(health.agentInstallDir || "").trim();
    const schedulerDependencies = health.schedulerDependencies;

    const capsResponse = await timedFetch(`${base}/api/capabilities`, { headers }, timeoutMs);
    if (capsResponse.status === 401 || capsResponse.status === 403) return tokenInvalid(baseResult, config);
    if (!capsResponse.ok) {
      return {
        ...baseResult,
        tcpOpen: true,
        healthOk: true,
        status: "agent_version_mismatch",
        latencyMs: Date.now() - started,
        agentVersion: health.agentVersion,
        apiVersion: health.apiVersion,
        projectRoot,
        schedulerDependencies,
        message: "/api/capabilities 不可用。",
        suggestion: "请在发布与代码同步卡片点击“部署最新版 Agent 到全部服务器”，然后重启 Hub/Worker Agent 会话。",
      };
    }
    const capabilities = await capsResponse.json();
    if (!validateAgentCapabilities(capabilities)) {
      return {
        ...baseResult,
        tcpOpen: true,
        healthOk: true,
        status: "agent_version_mismatch",
        latencyMs: Date.now() - started,
        agentVersion: health.agentVersion,
        apiVersion: health.apiVersion,
        projectRoot,
        message: "/api/capabilities 返回格式无效。",
        suggestion: "请在发布与代码同步卡片点击“部署最新版 Agent 到全部服务器”，然后重启 Hub/Worker Agent 会话。",
      };
    }
    const compatibility = checkAgentApiCompatibility(capabilities, options.expectedApiVersion ?? expectedAgentApiVersion);
    if (!compatibility.compatible) {
      return {
        ...baseResult,
        tcpOpen: true,
        healthOk: true,
        capabilitiesOk: false,
        status: "agent_version_mismatch",
        latencyMs: Date.now() - started,
        agentVersion: health.agentVersion,
        apiVersion: capabilities.apiVersion,
        projectRoot,
        agentInstallDir,
        schedulerDependencies,
        capabilities,
        missingCapabilities: compatibility.missingEndpoints,
        message: `Hub Agent API ${capabilities.apiVersion} 与插件不兼容。`,
        suggestion: "请部署最新版 Agent 并重启 Agent 会话；如果暂不升级，请禁用不支持的功能。",
      };
    }

    let fileCapabilities: FileCapabilitiesResponse | undefined;
    let fileApiOk = !config.fileTransferEnabled;
    if (config.fileTransferEnabled) {
      const fileCapsResponse = await timedFetch(`${base}/api/files/capabilities`, { headers }, timeoutMs);
      if (fileCapsResponse.status === 401 || fileCapsResponse.status === 403) return tokenInvalid(baseResult, config);
      if (!fileCapsResponse.ok) {
        return {
          ...baseResult,
          tcpOpen: true,
          healthOk: true,
          capabilitiesOk: true,
          status: "file_api_unavailable",
          latencyMs: Date.now() - started,
          agentVersion: health.agentVersion,
          apiVersion: capabilities.apiVersion,
          projectRoot,
          schedulerDependencies,
          capabilities,
          message: "/api/files/capabilities 不可用。",
          suggestion: "请启动较新的 Hub Agent，并确认文件网关已启用。",
        };
      }
      const fileCaps = await fileCapsResponse.json();
      if (!validateFileCapabilities(fileCaps) || !fileCaps.supportsList || !fileCaps.supportsDownload || !fileCaps.supportsUploadChunk) {
        return {
          ...baseResult,
          tcpOpen: true,
          healthOk: true,
          capabilitiesOk: true,
          status: "file_api_unavailable",
          latencyMs: Date.now() - started,
          agentVersion: health.agentVersion,
          apiVersion: capabilities.apiVersion,
          projectRoot,
          schedulerDependencies,
          capabilities,
          message: "文件 API 能力不完整。",
          suggestion: "请升级 Hub Agent，或改用 offline_import 导入文件。",
        };
      }
      fileCapabilities = fileCaps;
      fileApiOk = true;
    }

    const streamApiOk = !config.realtimeEnabled || capabilities.endpoints.sseEvents || capabilities.endpoints.websocketEvents;
    if (!streamApiOk) {
      return {
        ...baseResult,
        tcpOpen: true,
        healthOk: true,
        capabilitiesOk: true,
        fileApiOk,
        status: "stream_api_unavailable",
        latencyMs: Date.now() - started,
        agentVersion: health.agentVersion,
        apiVersion: capabilities.apiVersion,
        projectRoot,
        schedulerDependencies,
        capabilities,
        fileCapabilities,
        message: "实时流 API 不可用。",
        suggestion: "请升级 Hub Agent，或使用快照备用刷新。",
      };
    }

    return {
      ...baseResult,
      tcpOpen: true,
      healthOk: true,
      capabilitiesOk: true,
      fileApiOk,
      streamApiOk,
      status: "ok",
      latencyMs: Date.now() - started,
      agentVersion: health.agentVersion,
      apiVersion: capabilities.apiVersion,
      projectRoot,
      agentInstallDir,
      schedulerDependencies: health.schedulerDependencies,
      capabilities,
      fileCapabilities,
      message: "Xshell 隧道和 Hub Agent API 可用。",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...baseResult,
      tcpOpen: true,
      status: /AbortError|timeout/i.test(message) ? "timeout" : "agent_unreachable",
      latencyMs: Date.now() - started,
      message,
      suggestion: "请检查 Hub Agent 进程、token、远端端口和 Xshell 转发目标。",
    };
  }
}

export async function probeWorkerTelemetryTunnel(
  config: WorkerProbeConfig,
  options: { timeoutMs?: number } = {},
): Promise<WorkerTelemetryProbeResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const host = resolveProbeHost(config);
  const base = resolveProbeBase(config);
  const baseResult = {
    localForwardPort: config.localForwardPort,
    remoteTelemetryPort: config.remoteAgentPort,
    tcpOpen: false,
    healthOk: false,
    capabilitiesOk: false,
    streamApiOk: false,
    gpuApiOk: false,
    workerTasksApiOk: false,
    warnings: [] as string[],
  };
  if (!(await tcpOpen(config.localForwardPort, timeoutMs, host))) {
    return {
      ...baseResult,
      status: "local_port_closed",
      message: `${host}:${config.localForwardPort} 未打开。`,
      suggestion: `请启动该 Worker 的 Xshell 实时观测隧道（${host}:${config.localForwardPort} 按每服务器隧道配置动态解析），并确认 Worker Telemetry Agent 已启动。`,
    };
  }
  const headers = config.token ? { "X-Simple-Agent-Token": config.token } : undefined;
  try {
    const healthResponse = await fetchHealthWithFallback(base, headers as unknown as Record<string, string> | undefined, timeoutMs);
    if (healthResponse.status === 401 || healthResponse.status === 403) {
      return { ...baseResult, tcpOpen: true, status: "agent_token_invalid", message: "Worker Telemetry token 被拒绝。" };
    }
    if (!healthResponse.ok) {
      return { ...baseResult, tcpOpen: true, status: "agent_unreachable", message: `/api/health 返回 HTTP ${healthResponse.status}。` };
    }
    const health = await readProbeHealth(healthResponse, base, headers, started + timeoutMs);
    const projectRoot = String(health.projectRoot || "").trim();
    const agentInstallDir = String(health.agentInstallDir || "").trim();
    const capsResponse = await timedFetch(`${base}/api/capabilities`, { headers }, timeoutMs);
    if (capsResponse.status === 401 || capsResponse.status === 403) {
      return { ...baseResult, tcpOpen: true, healthOk: true, projectRoot, status: "agent_token_invalid", message: "Worker Telemetry token 被拒绝。" };
    }
    if (!capsResponse.ok) {
      return { ...baseResult, tcpOpen: true, healthOk: true, projectRoot, status: "worker_api_invalid", message: "/api/capabilities 不可用。" };
    }
    const capabilities = await capsResponse.json();
    const validation = validateWorkerTelemetryCapabilities(capabilities);
    const endpoints = (capabilities as { endpoints?: Record<string, unknown> }).endpoints || {};
    const mode = String((capabilities as { mode?: unknown }).mode || "");
    const streamApiOk = Boolean(endpoints.websocketEvents || endpoints.sseEvents);
    const gpuApiOk = Boolean(endpoints.gpu);
    const workerTasksApiOk = Boolean(endpoints.workerTasks);
    const ok = validation.ok && streamApiOk && gpuApiOk && workerTasksApiOk;
    const modeSuggestion = mode && mode !== "worker_telemetry"
      ? `${host}:${config.localForwardPort} 返回的是 ${mode} Agent，不是 Worker Telemetry。请重新写入 Agent 自动启动命令并重启该 Worker tmux。`
      : validation.ok
        ? "Worker Telemetry 缺少 GPU、任务或实时事件接口，请检查 Agent 日志。"
        : `Worker Telemetry 能力不匹配：${validation.warnings.join("；")}`;
    return {
      ...baseResult,
      tcpOpen: true,
      healthOk: true,
      capabilitiesOk: validation.ok,
      streamApiOk,
      gpuApiOk,
      workerTasksApiOk,
      status: ok ? "ok" : "worker_api_invalid",
      latencyMs: Date.now() - started,
      projectRoot,
      agentInstallDir,
      schedulerDependencies: health.schedulerDependencies,
      capabilities,
      warnings: validation.warnings,
      message: ok ? "Worker Telemetry API 可用。" : "Worker Telemetry API 不完整。",
      suggestion: ok ? undefined : modeSuggestion,
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return {
      ...baseResult,
      tcpOpen: true,
      status: /AbortError|timeout/i.test(text) ? "timeout" : "agent_unreachable",
      latencyMs: Date.now() - started,
      message: text,
      suggestion: "请检查 Worker Telemetry 进程，以及 Xshell 本地转发目标。",
    };
  }
}

async function tcpOpen(port: number, timeoutMs: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const resolvedHost = String(host || "127.0.0.1").trim() || "127.0.0.1";
    const socket = net.createConnection({ host: resolvedHost, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function tokenInvalid(
  base: Omit<TunnelProbeResult, "status" | "message">,
  config: Pick<XshellRealtimeTunnelConfig, "localForwardPort" | "remoteAgentPort">,
): TunnelProbeResult {
  return {
    ...base,
    localForwardPort: config.localForwardPort,
    remoteAgentPort: config.remoteAgentPort,
    tcpOpen: true,
    status: "agent_token_invalid",
    message: "Hub Agent 拒绝了 token/session。",
    suggestion: "请检查 simpleExperiment.tunnel.agentToken，或用匹配 token 重启 Hub Agent。",
  };
}
