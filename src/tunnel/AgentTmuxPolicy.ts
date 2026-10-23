import { assertLocalhost } from "./TunnelGateway";

// 仅当 settings 缺失时回退到 "simple"（与 tunnel.remoteTmuxSessionPrefix / XshellTunnelSetup 默认保持一致，动态解析优先）
export const simpleTmuxSessionPrefix = "simple";
export const simpleAgentTmuxCommandVersion = "SIMPLE_EXPERIMENT_AGENT_TMUX_V21=1";
export const simpleAgentRuntimeRelativePath = "simple_cluster/runtime/cluster_agent.py";
export const simpleDefaultCondaEnv = "";

export type AgentTmuxRole = "hub" | "worker";

export interface AgentTmuxStartupOptions {
  role: AgentTmuxRole;
  endpointId?: string;
  sessionPrefix?: string;
  port?: number;
  pythonCommand?: string;
  installDir?: string;
  stateDir?: string;
  workerStateDir?: string;
  workDir?: string;
  condaEnv?: string;
  /** Remote bind address selected by the user for this server's SSH forward. */
  host?: string;
}

export function normalizeRemoteTmuxSessionPrefix(value?: string): string {
  const prefix = String(value || simpleTmuxSessionPrefix)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return /^[a-z0-9]/.test(prefix) ? prefix : simpleTmuxSessionPrefix;
}

export function defaultAgentTmuxSessionName(role: AgentTmuxRole, endpointId?: string, sessionPrefix?: string): string {
  const prefix = normalizeRemoteTmuxSessionPrefix(sessionPrefix);
  if (role === "hub") throw new Error("HUB_REMOVED：请配置 Worker。");
  return `${prefix}-worker-${slug(endpointId || "worker")}-agent`;
}

export function isValidRemoteTmuxSessionName(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,31}-[a-z0-9][a-z0-9._-]*$/.test(value);
}

export function agentTmuxStartupCommand(options: AgentTmuxStartupOptions): string {
  const role = options.role;
  if (role !== "worker") throw new Error("HUB_REMOVED：请配置 Worker。");
  const mode = "worker_telemetry";
  const port = options.port || 18765;
  const host = normalizeAgentBindHost(options.host);
  const sessionPrefix = normalizeRemoteTmuxSessionPrefix(options.sessionPrefix);
  const session = defaultAgentTmuxSessionName(role, options.endpointId, sessionPrefix);
  const condaEnv = normalizeCondaEnvName(options.condaEnv);
  const requireCondaEnv = condaEnv ? "1" : "0";
  const config = JSON.stringify({projectDir: options.workDir || options.installDir || "", installDir: options.installDir || "", stateDir: options.stateDir, workerStateDir: options.workerStateDir, mode, workerId: options.endpointId || "", host, port, condaEnv, sessionPrefix, tmuxSession: session, tmuxWindow: "agent"});
  return [simpleAgentTmuxCommandVersion, "unset TMUX",
    `SESSION=${shellQuote(session)}`, `SIMPLE_EXPERIMENT_CONDA_ENV=${shellQuote(condaEnv)}`,
    `SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV=${shellQuote(requireCondaEnv)}`,
    `python3 ${shellQuote((options.installDir || "").replace(/\/+$/, "") + "/" + simpleAgentRuntimeRelativePath)} lifecycle --action ensure --config ${shellQuote(config)}`].join("; ");
}

function normalizeAgentBindHost(value?: string): string {
  const input = String(value || "127.0.0.1").trim() || "127.0.0.1";
  assertLocalhost(input);
  return input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeCondaEnvName(value: string | undefined): string {
  const normalized = String(value || simpleDefaultCondaEnv).trim();
  return normalized === "-" || normalized === "--" ? "" : normalized;
}

function slug(value: string): string {
  return String(value || "worker").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worker";
}
