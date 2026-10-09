import { normalizePort } from "./TunnelGateway";
import {
  defaultTunnelPorts,
  normalizePortRange,
  TunnelEndpointPortAssignment,
  TunnelPortRange,
} from "./TunnelPortConflict";
import { defaultMultiWorkerRealtimePolicy, MultiWorkerRealtimePolicy } from "./WorkerTelemetryApi";

export type XshellAuthMethod = "password" | "key" | "auto";
export type SavedSessionRunner = "xshell";
export type XshellLaunchMode = "open_xshell_exec" | "open_saved_session" | "generate_bat" | "generate_ps1" | "manual_guide";

export interface XshellWorkerTunnelConfig {
  id: string;
  displayName: string;
  hubHost: string;
  hubUser: string;
  hubSshPort: number;
  workerHost: string;
  workerUser: string;
  workerSshPort: number;
  transferHost?: string;
  resolvedHost?: string;
  sftpHost?: string;
  sshHost?: string;
  localForwardHost: string;
  localForwardPort: number;
  remoteAgentHost: string;
  remoteAgentPort: number;
  remoteTelemetryPort: number;
  sshConfigAlias?: string;
  privateKeyPath?: string;
  xshellSessionName?: string;
  savedSessionRunner: SavedSessionRunner;
  savedSessionPath?: string;
  savedSessionForwardIndex?: number;
  agentSessionPath?: string;
  agentProjectDir?: string;
  agentInstallDir?: string;
  condaEnv?: string;
  maxConcurrentGpus: number | string;
  /** @deprecated allowed 语义已删除，仅兼容旧配置读取，始终视为空=全部允许 */
  allowedGpuIds?: string[];
  authMethod: XshellAuthMethod;
  enabled: boolean;
  gpuIdleUtilThreshold?: number;
  gpuIdleMemThresholdMb?: number;
  sessionCheckMinSeconds?: number;
  workerStatusTtlSeconds?: number;
}

export interface XshellRealtimeTunnelConfig {
  xshellExePath: string;
  hubDisplayName?: string;
  remoteTmuxSessionPrefix: string;
  hubHost: string;
  hubUser: string;
  hubSshPort: number;
  transferHost?: string;
  resolvedHost?: string;
  sftpHost?: string;
  sshHost?: string;
  localForwardHost: string;
  localForwardPort: number;
  remoteAgentHost: string;
  remoteAgentPort: number;
  sshConfigAlias?: string;
  privateKeyPath?: string;
  xshellSessionName?: string;
  savedSessionRunner: SavedSessionRunner;
  savedSessionPath?: string;
  savedSessionForwardIndex?: number;
  agentSessionPath?: string;
  agentProjectDir?: string;
  agentInstallDir?: string;
  condaEnv: string;
  authMethod: XshellAuthMethod;
  launchMode: XshellLaunchMode;
  realtimeEnabled: boolean;
  fileTransferEnabled: boolean;
  keepWindowVisible: boolean;
  useNewTab: boolean;
  useCustomIni?: boolean;
  customIniPath?: string;
  extraSshArgs?: string[];
  autoStartTunnelOnExtensionActivation: boolean;
  autoTestTunnelAfterStart: boolean;
  workerRealtimeMode: "hub_only" | "hub_plus_workers";
  workerTelemetryMode: "hub_only" | "hub_plus_worker_telemetry";
  workerTunnels: XshellWorkerTunnelConfig[];
  ports: {
    workerLocalPortRange: TunnelPortRange;
    assignments: TunnelEndpointPortAssignment[];
    preserveExistingAssignments: boolean;
  };
  realtime: MultiWorkerRealtimePolicy;
}

export type XshellTunnelSetupConfig = XshellRealtimeTunnelConfig;

export const defaultXshellTunnelSetupConfig: XshellTunnelSetupConfig = {
  xshellExePath: "",
  remoteTmuxSessionPrefix: "simple",
  hubHost: "",
  hubUser: "",
  hubSshPort: 22,
  localForwardHost: "127.0.0.1",
  localForwardPort: 18765,
  remoteAgentHost: "127.0.0.1",
  remoteAgentPort: 18765,
  launchMode: "open_xshell_exec",
  realtimeEnabled: true,
  fileTransferEnabled: true,
  keepWindowVisible: true,
  useNewTab: true,
  autoStartTunnelOnExtensionActivation: false,
  autoTestTunnelAfterStart: true,
  savedSessionRunner: "xshell",
  authMethod: "password",
  condaEnv: "",
  workerRealtimeMode: "hub_only",
  workerTelemetryMode: "hub_only",
  workerTunnels: [],
  ports: {
    workerLocalPortRange: defaultTunnelPorts.workerLocalPortRange,
    assignments: [],
    preserveExistingAssignments: true,
  },
  realtime: defaultMultiWorkerRealtimePolicy,
};

export function normalizeXshellSetupConfig(input: Partial<XshellTunnelSetupConfig> = {}): XshellTunnelSetupConfig {
  const normalizedWorkers = Array.isArray(input.workerTunnels)
    ? input.workerTunnels.map((worker, index) => normalizeXshellWorkerTunnelConfig(worker, index, input.remoteAgentPort)).filter((worker) => worker.id)
    : [];
  const workerTunnels = dedupeWorkerTunnels(normalizedWorkers);
  const workerTelemetryMode = input.workerTelemetryMode === "hub_plus_worker_telemetry" || input.workerRealtimeMode === "hub_plus_workers"
    ? "hub_plus_worker_telemetry"
    : "hub_only";
  const xshellExePath = (input.xshellExePath || "").trim();
  const xshellSessionName = (input.xshellSessionName || "").trim() || undefined;
  return {
    ...defaultXshellTunnelSetupConfig,
    xshellExePath,
    hubDisplayName: input.hubDisplayName?.trim() || undefined,
    remoteTmuxSessionPrefix: normalizeRemoteTmuxSessionPrefix(input.remoteTmuxSessionPrefix),
    hubHost: input.hubHost || "",
    hubUser: input.hubUser || "",
    transferHost: input.transferHost?.trim() || undefined,
    resolvedHost: input.resolvedHost?.trim() || undefined,
    sftpHost: input.sftpHost?.trim() || undefined,
    sshHost: input.sshHost?.trim() || undefined,
    hubSshPort: normalizeSshPort(input.hubSshPort, defaultXshellTunnelSetupConfig.hubSshPort),
    localForwardHost: String((input as unknown as { localForwardHost?: unknown }).localForwardHost || "127.0.0.1").trim() || "127.0.0.1",
    localForwardPort: normalizePort(input.localForwardPort, defaultXshellTunnelSetupConfig.localForwardPort),
    remoteAgentHost: String((input as unknown as { remoteAgentHost?: unknown }).remoteAgentHost || "127.0.0.1").trim() || "127.0.0.1",
    remoteAgentPort: normalizePort(input.remoteAgentPort, defaultXshellTunnelSetupConfig.remoteAgentPort),
    xshellSessionName,
    savedSessionRunner: normalizeSavedSessionRunner(input.savedSessionRunner),
    savedSessionPath: input.savedSessionPath?.trim() || undefined,
    savedSessionForwardIndex: normalizeForwardIndex(input.savedSessionForwardIndex),
    agentSessionPath: input.agentSessionPath?.trim() || undefined,
    agentProjectDir: input.agentProjectDir?.trim() || undefined,
    agentInstallDir: input.agentInstallDir?.trim() || undefined,
    condaEnv: normalizeCondaEnvName(input.condaEnv),
    authMethod: normalizeAuthMethod(input.authMethod),
    launchMode: normalizeLaunchMode(input.launchMode),
    realtimeEnabled: input.realtimeEnabled !== false,
    fileTransferEnabled: input.fileTransferEnabled !== false,
    keepWindowVisible: input.keepWindowVisible !== false,
    useNewTab: input.useNewTab !== false,
    autoStartTunnelOnExtensionActivation: Boolean(input.autoStartTunnelOnExtensionActivation),
    autoTestTunnelAfterStart: input.autoTestTunnelAfterStart !== false,
    workerRealtimeMode: workerTelemetryMode === "hub_plus_worker_telemetry" ? "hub_plus_workers" : "hub_only",
    workerTelemetryMode,
    workerTunnels,
    ports: normalizePortConfig(input.ports, workerTunnels, input.localForwardPort, input.remoteAgentPort,
      input.hubDisplayName, input.localForwardHost, input.remoteAgentHost),
    realtime: { ...defaultMultiWorkerRealtimePolicy, ...(input.realtime || {}) },
  };
}

export function normalizeXshellWorkerTunnelConfig(
  input: Partial<XshellWorkerTunnelConfig> = {},
  index = 0,
  fallbackRemoteAgentPort = defaultXshellTunnelSetupConfig.remoteAgentPort,
): XshellWorkerTunnelConfig {
  const id = slug(input.id || input.sshConfigAlias || input.hubHost || `worker-${index + 1}`);
  const workerHost = input.workerHost || input.hubHost || "";
  const workerUser = input.workerUser || input.hubUser || "";
  const workerSshPort = normalizeSshPort(input.workerSshPort || input.hubSshPort, defaultXshellTunnelSetupConfig.hubSshPort);
  const remoteTelemetryPort = normalizePort(input.remoteTelemetryPort || input.remoteAgentPort, normalizePort(fallbackRemoteAgentPort, defaultTunnelPorts.defaultWorkerTelemetryPort));
  const xshellSessionName = (input.xshellSessionName || "").trim() || undefined;
  return {
    id,
    displayName: input.displayName || input.sshConfigAlias || workerHost || id,
    hubHost: workerHost,
    hubUser: workerUser,
    hubSshPort: workerSshPort,
    workerHost,
    workerUser,
    workerSshPort,
    transferHost: input.transferHost?.trim() || undefined,
    resolvedHost: input.resolvedHost?.trim() || undefined,
    sftpHost: input.sftpHost?.trim() || undefined,
    sshHost: input.sshHost?.trim() || undefined,
    localForwardHost: String((input as unknown as { localForwardHost?: unknown }).localForwardHost || "127.0.0.1").trim() || "127.0.0.1",
      localForwardPort: normalizePort(input.localForwardPort, defaultTunnelPorts.workerLocalPortRange.start + index),
    remoteAgentHost: String((input as unknown as { remoteAgentHost?: unknown }).remoteAgentHost || "127.0.0.1").trim() || "127.0.0.1",
      remoteAgentPort: remoteTelemetryPort,
    remoteTelemetryPort,
    sshConfigAlias: input.sshConfigAlias?.trim() || undefined,
    privateKeyPath: input.privateKeyPath?.trim() || undefined,
    xshellSessionName,
    savedSessionRunner: normalizeSavedSessionRunner(input.savedSessionRunner),
    savedSessionPath: input.savedSessionPath?.trim() || undefined,
    savedSessionForwardIndex: normalizeForwardIndex(input.savedSessionForwardIndex),
    agentSessionPath: input.agentSessionPath?.trim() || undefined,
    agentProjectDir: input.agentProjectDir?.trim() || undefined,
    agentInstallDir: input.agentInstallDir?.trim() || undefined,
    condaEnv: input.condaEnv === undefined ? undefined : normalizeCondaEnvName(input.condaEnv),
    maxConcurrentGpus: normalizePositiveInt(input.maxConcurrentGpus, 1) === 1 && input.maxConcurrentGpus !== 1 ? "auto" : normalizePositiveInt(input.maxConcurrentGpus, 1),
    authMethod: normalizeAuthMethod(input.authMethod),
    enabled: input.enabled !== false,
    gpuIdleUtilThreshold: normalizeIdleUtilThreshold((input as unknown as { gpuIdleUtilThreshold?: unknown }).gpuIdleUtilThreshold),
    gpuIdleMemThresholdMb: normalizeIdleMemThreshold((input as unknown as { gpuIdleMemThresholdMb?: unknown }).gpuIdleMemThresholdMb),
    sessionCheckMinSeconds: normalizeSessionCheckSeconds((input as unknown as { sessionCheckMinSeconds?: unknown }).sessionCheckMinSeconds),
    workerStatusTtlSeconds: normalizeWorkerTtlSeconds((input as unknown as { workerStatusTtlSeconds?: unknown }).workerStatusTtlSeconds),
  };
}

function normalizeAllowedGpuIds(input: unknown): string[] {
  // 兼容空壳：allowed 语义已删除，始终返回 []，保留 sanitize 校验告警
  return sanitizeAllowedGpuIdsCompat(input);
}

function sanitizeAllowedGpuIdsCompat(input: unknown): string[] {
  const raw: unknown[] = Array.isArray(input) ? input : typeof input === "string" ? String(input).split(/[,\s]+/) : [];
  const trimmed = raw.map((item) => String(item || "").trim()).filter(Boolean);
  if (!trimmed.length) return [];
  if (trimmed.length === 1 && (trimmed[0] === "-" || trimmed[0] === "--")) return [];
  if (trimmed.some((value) => value === "-" || value === "--")) {
    console.warn(`[allowedGpuIds] 非法占位 "${trimmed.join(",")}" 已置空为全部允许`);
    return [];
  }
  const invalid = trimmed.filter((value) => !/^\d+$/.test(value));
  if (invalid.length) {
    console.warn(`[allowedGpuIds] 非法 GPU ID "${invalid.join(",")}" 已置空为全部允许，仅数字 0..N 有效`);
    return [];
  }
  return Array.from(new Set(trimmed));
}

export function workerTunnelToXshellSetupConfig(base: XshellTunnelSetupConfig, worker: Partial<XshellWorkerTunnelConfig>): XshellTunnelSetupConfig {
  return normalizeXshellSetupConfig({
    ...base,
    hubHost: worker.hubHost,
    hubUser: worker.hubUser,
    hubSshPort: worker.hubSshPort,
    localForwardPort: worker.localForwardPort,
    remoteAgentPort: worker.remoteTelemetryPort || worker.remoteAgentPort,
    sshConfigAlias: worker.sshConfigAlias,
    privateKeyPath: worker.privateKeyPath,
    xshellSessionName: worker.xshellSessionName,
    savedSessionRunner: worker.savedSessionRunner || base.savedSessionRunner,
    savedSessionPath: worker.savedSessionPath,
    savedSessionForwardIndex: worker.savedSessionForwardIndex,
    agentSessionPath: worker.agentSessionPath,
    agentProjectDir: worker.agentProjectDir,
    agentInstallDir: worker.agentInstallDir,
    condaEnv: worker.condaEnv === undefined ? base.condaEnv : worker.condaEnv,
    authMethod: worker.authMethod || base.authMethod,
    workerRealtimeMode: "hub_only",
    workerTelemetryMode: "hub_only",
    workerTunnels: [],
  });
}

export function validateXshellSetupConfig(config: XshellTunnelSetupConfig): string[] {
  const errors: string[] = [];
  if (!xshellExecutablePath(config).trim()) errors.push("请选择 Xshell.exe。");
  if (config.launchMode === "open_saved_session" && !config.savedSessionPath) errors.push("Xshell 已保存会话模式需要选择 Hub 的 .xsh 会话文件。");
  if (config.launchMode !== "open_saved_session" && !config.sshConfigAlias && !config.hubHost.trim()) errors.push("请输入服务器 IP 或域名，或选择 Xshell 会话文件。");
  if (config.launchMode !== "open_saved_session" && !config.sshConfigAlias && !config.hubUser.trim()) errors.push("请输入登录用户名。");
  if (config.hubSshPort < 1 || config.hubSshPort > 65535) errors.push("服务器 SSH 登录端口必须在 1-65535 之间。");
  if (config.localForwardPort < 1024 || config.localForwardPort > 65535) errors.push("本地转发端口必须在 1024-65535 之间。");
  if (config.remoteAgentPort < 1024 || config.remoteAgentPort > 65535) errors.push("服务器上的 Agent 端口必须在 1024-65535 之间。");
  // P0 已解锁：隧道 host 按每服务器用户配置动态解析，不再强制 127.0.0.1
  if (!String(config.localForwardHost || "").trim() || !String(config.remoteAgentHost || "").trim()) errors.push("隧道两端 host 不能为空。");
  if (config.authMethod === "key" && !config.privateKeyPath) errors.push("密钥登录需要选择私钥文件。");
  if (config.workerRealtimeMode === "hub_plus_workers" && !config.workerTunnels.some((worker) => worker.enabled)) errors.push("Worker 实时模式至少需要一个已启用的 Worker 隧道。");
  for (const worker of config.workerTunnels.filter((item) => item.enabled)) {
    if (config.launchMode === "open_saved_session" && !worker.savedSessionPath) errors.push(`Worker ${worker.id} 需要选择 Xshell 会话文件。`);
    if (config.launchMode !== "open_saved_session" && !worker.sshConfigAlias && !(worker.workerHost || worker.hubHost).trim()) errors.push(`Worker ${worker.id} 需要填写服务器地址或登录别名。`);
    if (config.launchMode !== "open_saved_session" && !worker.sshConfigAlias && !(worker.workerUser || worker.hubUser).trim()) errors.push(`Worker ${worker.id} 需要填写登录用户名。`);
    if (worker.authMethod === "key" && !worker.privateKeyPath) errors.push(`Worker ${worker.id} 使用密钥登录时需要选择私钥文件。`);
  }
  return errors;
}

export function xshellExecutablePath(config: Partial<XshellTunnelSetupConfig>): string {
  return (config.xshellExePath || "").trim();
}

export function publicXshellSetupSummary(config: XshellTunnelSetupConfig): Record<string, unknown> {
  return {
    ...config,
    privateKeyPath: config.privateKeyPath ? basename(config.privateKeyPath) : undefined,
    ports: config.ports,
    realtime: config.realtime,
    workerTunnels: config.workerTunnels.map((worker) => ({
      ...worker,
      privateKeyPath: worker.privateKeyPath ? basename(worker.privateKeyPath) : undefined,
    })),
  };
}

function basename(value: string): string {
  return value.replace(/\\/g, "/").split("/").pop() || value;
}

function normalizeRemoteTmuxSessionPrefix(value: unknown): string {
  // 仅当 settings 缺失时回退到 "simple"（与 AgentTmuxPolicy.simpleTmuxSessionPrefix 同步，动态解析优先）
  const prefix = String(value ?? "simple").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(prefix) ? prefix : "simple";
}

function normalizeSshPort(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function normalizeAuthMethod(value: unknown): XshellAuthMethod {
  return value === "key" || value === "auto" ? value : "password";
}

function normalizeSavedSessionRunner(_value: unknown): SavedSessionRunner {
  return "xshell";
}

function normalizeCondaEnvName(value: unknown): string {
  const normalized = String(value || "").trim();
  return normalized === "-" || normalized === "--" ? "" : normalized;
}

function normalizeLaunchMode(value: unknown): XshellLaunchMode {
  return value === "open_saved_session" || value === "generate_bat" || value === "generate_ps1" || value === "manual_guide" ? value : "open_xshell_exec";
}

function normalizeForwardIndex(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeIdleUtilThreshold(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
}

function normalizeIdleMemThreshold(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 8192 ? n : undefined;
}

function normalizeSessionCheckSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : undefined;
}

function normalizeWorkerTtlSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 10 && n <= 7200 ? n : undefined;
}

function normalizePortConfig(
  input: Partial<XshellTunnelSetupConfig["ports"]> | undefined,
  workers: XshellWorkerTunnelConfig[],
  hubLocalPort: unknown,
  hubRemotePort: unknown,
  hubDisplayName: unknown,
  hubLocalHost: unknown,
  hubRemoteHost: unknown,
): XshellTunnelSetupConfig["ports"] {
  const range = normalizePortRange(input?.workerLocalPortRange, defaultTunnelPorts.workerLocalPortRange);
  const validIds = new Set(["hub", ...workers.map((worker) => worker.id)]);
  const assignments = Array.isArray(input?.assignments)
    ? input.assignments.filter((assignment) => validIds.has(assignment.endpointId) && String(assignment.localForwardHost || "").trim() && String(assignment.remoteBindHost || "").trim())
    : [];
  const assignedAt = new Date(0).toISOString();
  if (!assignments.some((assignment) => assignment.endpointId === "hub")) {
    assignments.push({
      endpointId: "hub",
      role: "hub_control",
      displayName: String(hubDisplayName || "").trim() || "Hub",
      remoteHostLabel: "hub",
      localForwardHost: String(hubLocalHost || "127.0.0.1").trim() || "127.0.0.1",
      localForwardPort: normalizePort(hubLocalPort, defaultTunnelPorts.hubLocalPort),
      remoteBindHost: String(hubRemoteHost || "127.0.0.1").trim() || "127.0.0.1",
      remoteServicePort: normalizePort(hubRemotePort, defaultTunnelPorts.defaultHubAgentPort),
      assignedAt,
      source: "imported",
    });
  }
  for (const worker of workers) {
    if (assignments.some((assignment) => assignment.endpointId === worker.id)) continue;
    assignments.push({
      endpointId: worker.id,
      role: "worker_telemetry",
      displayName: worker.displayName,
      remoteHostLabel: worker.workerHost || worker.hubHost || worker.id,
      sshConfigAlias: worker.sshConfigAlias,
      localForwardHost: worker.localForwardHost,
      localForwardPort: worker.localForwardPort,
      remoteBindHost: worker.remoteAgentHost,
      remoteServicePort: worker.remoteTelemetryPort || worker.remoteAgentPort || defaultTunnelPorts.defaultWorkerTelemetryPort,
      assignedAt,
      source: "imported",
    });
  }
  return { workerLocalPortRange: range, assignments, preserveExistingAssignments: input?.preserveExistingAssignments !== false };
}

function slug(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function dedupeWorkerTunnels(workers: XshellWorkerTunnelConfig[]): XshellWorkerTunnelConfig[] {
  const out: XshellWorkerTunnelConfig[] = [];
  for (const worker of workers) {
    const index = out.findIndex((item) => isDuplicateWorker(item, worker));
    if (index < 0) out.push(worker);
    else out[index] = mergeWorker(out[index], worker);
  }
  return out;
}

function isDuplicateWorker(first: XshellWorkerTunnelConfig, second: XshellWorkerTunnelConfig): boolean {
  if (first.savedSessionPath && second.savedSessionPath && pathKey(first.savedSessionPath) === pathKey(second.savedSessionPath)) return true;
  const firstHost = hostKey(first);
  const secondHost = hostKey(second);
  return Boolean(firstHost && secondHost && firstHost === secondHost);
}

function mergeWorker(first: XshellWorkerTunnelConfig, second: XshellWorkerTunnelConfig): XshellWorkerTunnelConfig {
  const preferred = workerScore(second) >= workerScore(first) ? second : first;
  const other = preferred === second ? first : second;
  return {
    ...other,
    ...preferred,
    displayName: preferred.displayName || other.displayName,
    savedSessionPath: preferred.savedSessionPath || other.savedSessionPath,
    agentSessionPath: preferred.agentSessionPath || other.agentSessionPath,
    agentProjectDir: preferred.agentProjectDir || other.agentProjectDir,
    agentInstallDir: preferred.agentInstallDir || other.agentInstallDir,
    enabled: preferred.enabled !== false || other.enabled !== false,
  };
}

function workerScore(worker: XshellWorkerTunnelConfig): number {
  return (/[a-z]/i.test(worker.id) ? 10 : 0) + (/[a-z]/i.test(worker.displayName || "") ? 5 : 0) + (worker.savedSessionPath ? 2 : 0) + (worker.agentSessionPath ? 1 : 0);
}

function hostKey(worker: XshellWorkerTunnelConfig): string {
  const host = (worker.workerHost || worker.hubHost || "").trim().toLowerCase();
  return host ? `${host}|${(worker.workerUser || worker.hubUser || "").trim().toLowerCase()}|${worker.workerSshPort || worker.hubSshPort || 22}` : "";
}

function pathKey(value: string): string {
  return value.replace(/\\/g, "/").trim().toLowerCase();
}
