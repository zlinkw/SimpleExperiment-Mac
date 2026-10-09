import * as path from "node:path";
import { assertLocalhost } from "../tunnel/TunnelGateway";
import { normalizeXshellSetupConfig, normalizeXshellWorkerTunnelConfig, XshellRealtimeTunnelConfig } from "../tunnel/XshellTunnelSetup";
import { defaultAgentTmuxSessionName, simpleAgentRuntimeRelativePath } from "../tunnel/AgentTmuxPolicy";

export const MANUAL_ENDPOINT_SETTING = "tunnel.manualEndpoints";
export interface ManualEndpoint {
  id: string;
  role: "hub" | "worker";
  displayName?: string;
  host: string;
  user: string;
  sshPort: number;
  localForwardHost: string;
  localForwardPort: number;
  remoteAgentHost: string;
  remoteAgentPort: number;
  projectParentDir: string;
  agentInstallDir?: string;
  condaEnv?: string;
  enabled?: boolean;
  maxConcurrentGpus?: number | string;
}
export type ManualSetup = XshellRealtimeTunnelConfig & { manualProvider: "termius"; manualEndpointError?: string; manualDisabledHub?: ManualEndpoint };

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} 必须填写有效文本。`);
  return value.trim();
}
function port(value: unknown, label: string, minimum = 1024): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > 65535) throw new Error(`${label} 必须是 ${minimum}-65535 的整数。`);
  return value;
}
function host(value: unknown, label: string): string {
  const result = text(value, label); assertLocalhost(result);
  return result.startsWith("[") ? result.slice(1, -1) : result;
}
function directory(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(value) || value.split("/").some(part => part === "." || part === "..")) throw new Error(`${label} 必须是无 . 或 .. 的绝对 POSIX 路径。`);
  const normalized = path.posix.normalize(value);
  if (["/", "/root", "/tmp"].includes(normalized)) throw new Error(`${label} 不能使用根目录、/root 或 /tmp。`);
  return normalized;
}

export function validateManualEndpoints(value: unknown): ManualEndpoint[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Termius 手动端点必须是最多 128 项的数组。");
  const ids = new Set<string>(), ports = new Set<number>(); let hubCount = 0;
  return value.map((raw: any) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("端点必须是对象。");
    const id = text(raw.id, "端点 ID");
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || ids.has(id)) throw new Error("端点 ID 必须唯一且只含小写字母、数字、点、下划线或连字符。");
    ids.add(id);
    if (raw.role !== "hub" && raw.role !== "worker" || (raw.role === "hub") !== (id === "hub")) throw new Error("Hub ID 固定为 hub；Worker 使用独立 ID 和 worker 角色。");
    if (raw.role === "hub" && ++hubCount > 1) throw new Error("只能配置一个 Hub。");
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("enabled 必须是布尔值。");
    const localForwardPort = port(raw.localForwardPort, `${id} 本机端口`);
    if (raw.enabled !== false && ports.has(localForwardPort)) throw new Error("启用端点的本机监听端口必须唯一。");
    if (raw.enabled !== false) ports.add(localForwardPort);
    const maxConcurrentGpus = raw.maxConcurrentGpus === undefined ? "auto" : raw.maxConcurrentGpus;
    if (maxConcurrentGpus !== "auto" && (typeof maxConcurrentGpus !== "number" || !Number.isInteger(maxConcurrentGpus) || maxConcurrentGpus < 1 || maxConcurrentGpus > 64)) throw new Error("maxConcurrentGpus 必须为 auto 或 1-64 整数。");
    const condaEnv = raw.condaEnv ? directory(raw.condaEnv, `${id} Conda 环境`) : raw.condaEnv === undefined ? undefined : "";
    return { id, role: raw.role, displayName: raw.displayName ? text(raw.displayName, "显示名") : id,
      host: host(raw.host, `${id} SSH 地址`), user: text(raw.user, `${id} SSH 用户`), sshPort: port(raw.sshPort, `${id} SSH 端口`, 1),
      localForwardHost: host(raw.localForwardHost, `${id} 本机监听地址`), localForwardPort,
      remoteAgentHost: host(raw.remoteAgentHost, `${id} 远端 Agent 地址`), remoteAgentPort: port(raw.remoteAgentPort, `${id} Agent 端口`),
      projectParentDir: directory(raw.projectParentDir, `${id} 项目父目录`),
      ...(raw.agentInstallDir ? { agentInstallDir: directory(raw.agentInstallDir, `${id} runtime 目录`) } : {}), condaEnv, enabled: raw.enabled !== false, maxConcurrentGpus };
  });
}

export function enforceManualSetup(value: XshellRealtimeTunnelConfig): ManualSetup {
  const clean = (item: any) => ({ ...item, xshellExePath: "", xshellSessionName: undefined, savedSessionPath: undefined,
    savedSessionForwardIndex: undefined, agentSessionPath: undefined, privateKeyPath: undefined, authMethod: "auto" as const,
    transferHost: undefined, resolvedHost: undefined, sftpHost: undefined, sshHost: undefined, sshConfigAlias: undefined });
  return { ...clean(value), launchMode: "manual_guide", autoStartTunnelOnExtensionActivation: false,
    workerTunnels: value.workerTunnels.map(clean), manualProvider: "termius" };
}

export function setupFromManualEndpoints(value: unknown, saved: Partial<XshellRealtimeTunnelConfig> = {}): ManualSetup {
  const endpoints = validateManualEndpoints(value), hub = endpoints.find(endpoint => endpoint.role === "hub");
  const fields = (endpoint: ManualEndpoint) => ({ localForwardHost: endpoint.localForwardHost, localForwardPort: endpoint.localForwardPort,
    remoteAgentHost: endpoint.remoteAgentHost, remoteAgentPort: endpoint.remoteAgentPort, agentProjectDir: endpoint.projectParentDir,
    agentInstallDir: endpoint.agentInstallDir, condaEnv: endpoint.condaEnv ?? saved.condaEnv ?? "", hubHost: endpoint.host, hubUser: endpoint.user, hubSshPort: endpoint.sshPort });
  const workers = endpoints.filter(endpoint => endpoint.role === "worker").map(endpoint => ({
    ...(saved.workerTunnels || []).find(worker => worker.id === endpoint.id), ...fields(endpoint), id: endpoint.id,
    displayName: endpoint.displayName || endpoint.id, workerHost: endpoint.host, workerUser: endpoint.user, workerSshPort: endpoint.sshPort,
    savedSessionRunner: "xshell" as const, authMethod: "auto" as const,
    remoteTelemetryPort: endpoint.remoteAgentPort, enabled: endpoint.enabled !== false, maxConcurrentGpus: endpoint.maxConcurrentGpus || "auto",
  }));
  const result = enforceManualSetup(normalizeXshellSetupConfig({ ...saved, ...(hub && hub.enabled !== false ? fields(hub) : { hubHost: "", hubUser: "", agentProjectDir: "", agentInstallDir: undefined }),
    hubDisplayName: hub?.displayName, workerTunnels: workers, ports: { ...normalizeXshellSetupConfig().ports, assignments: [] },
    workerRealtimeMode: workers.some(worker => worker.enabled) ? "hub_plus_workers" : "hub_only" }));
  // The legacy normalizer trims directory strings; Mac preserves POSIX leaves.
  if (hub && hub.enabled !== false) { result.agentProjectDir = hub.projectParentDir; result.agentInstallDir = hub.agentInstallDir; }
  if (hub?.enabled === false) result.manualDisabledHub = hub;
  // Explicit endpoint IDs own the inventory, including multiple forwards to one host.
  result.workerTunnels = workers.map((worker, index) => ({ ...normalizeXshellWorkerTunnelConfig(worker, index), id: worker.id,
    agentProjectDir: worker.agentProjectDir, agentInstallDir: worker.agentInstallDir, condaEnv: worker.condaEnv }));
  return enforceManualSetup(result);
}

export function endpointsFromSetup(setup: XshellRealtimeTunnelConfig): ManualEndpoint[] {
  const endpoints: ManualEndpoint[] = [];
  const fields = (item: any) => ({ host: item.workerHost || item.hubHost, user: item.workerUser || item.hubUser,
    sshPort: item.workerSshPort || item.hubSshPort, localForwardHost: item.localForwardHost, localForwardPort: item.localForwardPort,
    remoteAgentHost: item.remoteAgentHost, remoteAgentPort: item.remoteTelemetryPort || item.remoteAgentPort,
    projectParentDir: item.agentProjectDir, agentInstallDir: item.agentInstallDir, condaEnv: item.condaEnv || "", enabled: item.enabled !== false });
  if (setup.hubHost && setup.agentProjectDir) endpoints.push({ id: "hub", role: "hub", displayName: setup.hubDisplayName, ...fields(setup) });
  else if ((setup as ManualSetup).manualDisabledHub) endpoints.push((setup as ManualSetup).manualDisabledHub!);
  for (const worker of setup.workerTunnels) endpoints.push({ id: worker.id, role: "worker", displayName: worker.displayName, ...fields(worker), maxConcurrentGpus: worker.maxConcurrentGpus });
  return validateManualEndpoints(endpoints);
}

export function setupFromPreparationApi(setup: XshellRealtimeTunnelConfig, params: any): ManualSetup {
  if (params.manualEndpoints !== undefined) {
    if (params.workerTunnels !== undefined || params.hub !== undefined || params.hubConfig !== undefined) throw new Error("manualEndpoints 与旧服务器参数不能同时传入。");
    return setupFromManualEndpoints(params.manualEndpoints, setup);
  }
  if ((setup as ManualSetup).manualEndpointError) throw new Error((setup as ManualSetup).manualEndpointError);
  const saved = endpointsFromSetup(setup);
  const merge = (row: any, existing: ManualEndpoint | undefined, role: "hub" | "worker"): ManualEndpoint => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("项目准备服务器参数必须为对象。");
    return { ...existing, id: role === "hub" ? "hub" : row.id ?? row.serverId ?? existing?.id, role,
      displayName: row.displayName ?? row.label ?? existing?.displayName,
      host: row.host ?? row.workerHost ?? row.hubHost ?? existing?.host,
      user: row.user ?? row.username ?? row.workerUser ?? row.hubUser ?? existing?.user,
      sshPort: row.sshPort ?? row.port ?? row.workerSshPort ?? row.hubSshPort ?? existing?.sshPort,
      localForwardHost: row.localForwardHost ?? existing?.localForwardHost, localForwardPort: row.localForwardPort ?? existing?.localForwardPort,
      remoteAgentHost: row.remoteAgentHost ?? existing?.remoteAgentHost,
      remoteAgentPort: row.remoteAgentPort ?? row.remoteTelemetryPort ?? existing?.remoteAgentPort,
      projectParentDir: row.projectParentDir ?? row.agentProjectDir ?? row.remoteRoot ?? row.remotePath ?? existing?.projectParentDir,
      agentInstallDir: row.agentInstallDir ?? existing?.agentInstallDir, condaEnv: row.condaEnv ?? existing?.condaEnv,
      enabled: row.enabled ?? existing?.enabled, maxConcurrentGpus: row.maxConcurrentGpus ?? existing?.maxConcurrentGpus };
  };
  const hub = params.hub ?? params.hubConfig;
  const nextHub = hub === undefined ? saved.filter(endpoint => endpoint.role === "hub") : [merge(hub, saved.find(endpoint => endpoint.role === "hub"), "hub")];
  if (params.workerTunnels !== undefined && !Array.isArray(params.workerTunnels)) throw new Error("workerTunnels 必须是数组。");
  const workers = params.workerTunnels === undefined ? saved.filter(endpoint => endpoint.role === "worker")
    : params.workerTunnels.map((row: any) => merge(row, saved.find(endpoint => endpoint.role === "worker" && endpoint.id === (row?.id ?? row?.serverId)), "worker"));
  return setupFromManualEndpoints([...nextHub, ...workers], setup);
}

export function manualAgentGuide(setup: XshellRealtimeTunnelConfig, topology: string, projectName: string, tokenRequired = false, serverIds: string[] = []): string {
  if (!projectName || /[\x00-\x1f\x7f/\\]/.test(projectName) || [".", ".."].includes(projectName)) throw new Error("先打开一个本机项目文件夹，再生成 Agent 指引。");
  const endpoints = endpointsFromSetup(setup).filter(endpoint => endpoint.enabled && (topology === "hub_worker" || endpoint.role !== "hub") && (!serverIds.length || serverIds.includes(endpoint.id)));
  if (!endpoints.length) throw new Error("先配置并启用 Termius 转发端点。");
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const sections = endpoints.map(endpoint => {
    const workDir = path.posix.join(endpoint.projectParentDir, projectName), installDir = endpoint.agentInstallDir || path.posix.join(endpoint.projectParentDir, "simple_agent");
    const session = defaultAgentTmuxSessionName(endpoint.role, endpoint.id, setup.remoteTmuxSessionPrefix);
    const python = endpoint.condaEnv ? endpoint.condaEnv.endsWith("/bin/python") ? endpoint.condaEnv : path.posix.join(endpoint.condaEnv, "bin/python") : "python3";
    const command = `cd ${quote(workDir)} && env ${quote("SIMPLE_EXPERIMENT_AGENT_INSTALL_DIR=" + installDir)} ${quote("PYTHONPATH=" + installDir)} ${quote("SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX=" + setup.remoteTmuxSessionPrefix)} ${quote("SIMPLE_EXPERIMENT_CONDA_ENV=" + (endpoint.condaEnv || ""))} ${quote(python)} ${quote(path.posix.join(installDir, simpleAgentRuntimeRelativePath))} serve --project-dir ${quote(workDir)} --host ${quote(endpoint.remoteAgentHost)} --port ${endpoint.remoteAgentPort} --mode ${endpoint.role === "hub" ? "hub_control" : "worker_telemetry"}${endpoint.role === "worker" ? ` --worker-id ${quote(endpoint.id)}` : ""}${tokenRequired ? ' --token "$SIMPLE_EXPERIMENT_AGENT_TOKEN"' : ""}`;
    return `## ${endpoint.displayName || endpoint.id}\n\nSSH：${endpoint.user}@${endpoint.host}:${endpoint.sshPort}。Termius 手动开启 ${endpoint.localForwardHost}:${endpoint.localForwardPort} → ${endpoint.remoteAgentHost}:${endpoint.remoteAgentPort}。\n\n先通过 SimpleSFTP 部署 runtime 到 ${installDir}，同步项目到 ${workDir}。在该服务器的 Termius 终端运行：\n\n\`\`\`sh\nif tmux has-session -t ${quote(session)} 2>/dev/null; then tmux attach-session -t ${quote(session)}; else tmux new-session -s ${quote(session)}; fi\n\`\`\`\n\n已有 Agent 在运行时只检查并分离会话，不重复启动。仅在新会话或确认 Agent 尚未启动的会话中执行：\n\n\`\`\`sh\n${tokenRequired ? "read -r -s -p 'Agent token: ' SIMPLE_EXPERIMENT_AGENT_TOKEN; printf '\\n'\n" : ""}${command}\n\`\`\`\n\n按 Ctrl+B，再按 D 分离 tmux，保留 Agent 与实验。然后回插件“检测全部”。\n`;
  });
  return "# Mac Termius / Agent / tmux 操作指引\n\n本指引只生成操作文本，不连接 Termius、不读取会话或凭据、不启动或停止远端进程。已存在的会话保持运行；连接恢复后先检查，配置改动不自动重启。\n\n" + sections.join("\n");
}
