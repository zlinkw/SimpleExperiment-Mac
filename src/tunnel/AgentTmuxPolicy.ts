import { assertLocalhost } from "./TunnelGateway";

// 仅当 settings 缺失时回退到 "simple"（与 tunnel.remoteTmuxSessionPrefix / XshellTunnelSetup 默认保持一致，动态解析优先）
export const simpleTmuxSessionPrefix = "simple";
export const simpleAgentTmuxCommandVersion = "SIMPLE_EXPERIMENT_AGENT_TMUX_V20=1";
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
  if (role === "hub") return `${prefix}-hub-agent`;
  return `${prefix}-worker-${slug(endpointId || "worker")}-agent`;
}

export function isValidRemoteTmuxSessionName(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,31}-[a-z0-9][a-z0-9._-]*$/.test(value);
}

export function agentTmuxStartupCommand(options: AgentTmuxStartupOptions): string {
  const role = options.role;
  const mode = role === "hub" ? "hub_control" : "worker_telemetry";
  const port = options.port || 18765;
  const host = normalizeAgentBindHost(options.host);
  const sessionPrefix = normalizeRemoteTmuxSessionPrefix(options.sessionPrefix);
  const session = defaultAgentTmuxSessionName(role, options.endpointId, sessionPrefix);
  const condaEnv = normalizeCondaEnvName(options.condaEnv);
  const requireCondaEnv = condaEnv ? "1" : "0";
  const command = agentRuntimeCommand({ session, mode, port, host, installDir: options.installDir, workDir: options.workDir, pythonCommand: options.pythonCommand, endpointId: options.endpointId, condaEnv, sessionPrefix });
  const agentPids = `AGENT_PIDS=$(ps -eo pid=,comm=,args= | awk -v host="$HOST" -v port="$PORT" -v mode="$MODE" '$2 ~ /python/ && index($0,"cluster_agent.py") && index($0,"--host " host " ") && (index($0,"--port " port " ") || index($0,"--port=" port)) && (index($0,"--mode " mode " ") || index($0,"--mode=" mode)) { print $1 }')`;
  const mergePids = `PIDS=$(printf "%s\\n" "$AGENT_PIDS" | awk -v self="$$" 'NF && $1 != self { print $1 }' | sort -u)`;
  const stopSession = `if tmux has-session -t "$SESSION" 2>/dev/null; then tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true; sleep 1; fi`;
  const stopPids = `if [ -n "$PIDS" ]; then kill $PIDS >/dev/null 2>&1 || true; sleep 1; for pid in $PIDS; do kill -0 "$pid" 2>/dev/null && kill -9 "$pid" >/dev/null 2>&1 || true; done; fi`;
  const startTmux = `tmux new-session -d -s "$SESSION" "$CMD" >/dev/null 2>&1 || true`;
  const openWorkShell = [
    `export WORK_DIR SIMPLE_EXPERIMENT_CONDA_ENV SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX CONDA_CHANGEPS1=true`,
    `sleep 0.1`,
    foregroundBashShellCommand(condaEnv),
    `if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then cd "$WORK_DIR"; fi`,
    `sleep 0.1`,
    simpleCondaActivationShell(false, { quietActivate: false, reportOptionalFailure: true, reportOptionalMissing: true }),
    `exec "\${SHELL:-/bin/sh}" -i`,
  ].join("; ");
  return [
    simpleAgentTmuxCommandVersion,
    "unset TMUX",
    `SESSION=${shellQuote(session)}`,
    `PORT=${shellQuote(String(port))}`,
    `HOST=${shellQuote(host)}`,
    `MODE=${shellQuote(mode)}`,
    `SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX=${shellQuote(sessionPrefix)}`,
    `SIMPLE_EXPERIMENT_CONDA_ENV=${shellQuote(condaEnv)}`,
    `SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV=${shellQuote(requireCondaEnv)}`,
    `INSTALL_DIR=${shellQuote(options.installDir || "")}`,
    `WORK_DIR=${shellQuote((options.workDir || options.installDir || "").trim())}`,
    `CMD=${shellQuote(command)}`,
    `${stopSession}; ${agentPids}; ${mergePids}; ${stopPids}; ${startTmux}; ${openWorkShell}`,
  ].join("; ");
}

function agentRuntimeCommand(options: {
  session: string;
  mode: string;
  sessionPrefix?: string;
  port: number;
  host: string;
  installDir?: string;
  workDir?: string;
  pythonCommand?: string;
  endpointId?: string;
  condaEnv?: string;
}): string {
  const workerIdArg = options.mode === "worker_telemetry" && options.endpointId ? ` --worker-id ${shellQuote(options.endpointId)}` : "";
  if (options.pythonCommand) return `${options.pythonCommand} --host ${shellQuote(options.host)} --port ${options.port} --mode ${options.mode}${workerIdArg}`;
  const installDir = options.installDir?.trim() || "";
  const workDir = options.workDir?.trim() || installDir;
  const condaEnv = normalizeCondaEnvName(options.condaEnv);
  const requireCondaEnv = condaEnv ? "1" : "0";
  return [
    `INSTALL_DIR=${shellQuote(installDir)}`,
    `WORK_DIR=${shellQuote(workDir)}`,
    `PORT=${shellQuote(String(options.port))}`,
    `HOST=${shellQuote(options.host)}`,
    `MODE=${shellQuote(options.mode)}`,
    `if [ -z "$INSTALL_DIR" ]; then exit 127; fi`,
    `if [ -z "$WORK_DIR" ]; then exit 127; fi`,
    `LOG="$INSTALL_DIR/logs/${options.session}.log"`,
    `mkdir -p "$INSTALL_DIR/logs" "$INSTALL_DIR/simple_cluster/runtime" "$WORK_DIR"`,
    `exec > >(tee -a "$LOG") 2>&1`,
    `echo "[$(date -Is)] Starting ${options.session} mode=${options.mode} port=${options.port}"`,
    `echo "Install dir: $INSTALL_DIR"`,
    `echo "Work dir: $WORK_DIR"`,
    `echo "State dir: runtime namespaces state by work dir under $INSTALL_DIR/state/projects/<project-namespace>"`,
    `AGENT_SCRIPT="$INSTALL_DIR/${simpleAgentRuntimeRelativePath}"`,
    `if [ ! -f "$AGENT_SCRIPT" ]; then echo "Runtime missing: $AGENT_SCRIPT"; echo "Deploy latest runtime from VS Code panel, then restart the Xshell tunnel session."; exit 127; fi`,
    `chmod +x "$AGENT_SCRIPT" 2>/dev/null || true`,
    `cd "$WORK_DIR" || exit 127`,
    `export SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX="\${SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX:-${normalizeRemoteTmuxSessionPrefix(options.sessionPrefix)}}"`,
    `export SIMPLE_EXPERIMENT_CONDA_ENV="\${SIMPLE_EXPERIMENT_CONDA_ENV:-${condaEnv}}"`,
    `export SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV="\${SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV:-${requireCondaEnv}}"`,
    simpleCondaActivationShell(false),
    `export SIMPLE_EXPERIMENT_AGENT_INSTALL_DIR="$INSTALL_DIR"`,
    `export PYTHONPATH="$INSTALL_DIR\${PYTHONPATH:+:$PYTHONPATH}"`,
    `if command -v python3 >/dev/null 2>&1; then SIMPLE_EXPERIMENT_PY=python3; elif command -v python >/dev/null 2>&1; then SIMPLE_EXPERIMENT_PY=python; else echo "python3 or python is required."; exit 127; fi`,
    `echo "Runtime script: $AGENT_SCRIPT"`,
    `exec "$SIMPLE_EXPERIMENT_PY" "$AGENT_SCRIPT" serve --project-dir "$WORK_DIR" --host "$HOST" --port "$PORT" --mode "$MODE"${workerIdArg}`,
  ].join("; ");
}

function normalizeAgentBindHost(value?: string): string {
  const input = String(value || "127.0.0.1").trim() || "127.0.0.1";
  assertLocalhost(input);
  return input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type SimpleCondaHookShell = "posix" | "bash";

interface SimpleCondaActivationOptions {
  quietActivate?: boolean;
  reportOptionalFailure?: boolean;
  reportOptionalMissing?: boolean;
  hookShell?: SimpleCondaHookShell;
}

function foregroundBashShellCommand(condaEnv = simpleDefaultCondaEnv): string {
  const envName = normalizeCondaEnvName(condaEnv);
  const bashRcLines = [
    `for __SIMPLE_EXPERIMENT_PROFILE in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do if [ -f "$__SIMPLE_EXPERIMENT_PROFILE" ]; then . "$__SIMPLE_EXPERIMENT_PROFILE"; fi; done`,
    `if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi`,
    `for __SIMPLE_EXPERIMENT_CONDA_WAIT in 1 2 3 4 5 6 7 8 9 10; do command -v conda >/dev/null 2>&1 && break; sleep 0.2; done`,
    `export SIMPLE_EXPERIMENT_CONDA_ENV="\${SIMPLE_EXPERIMENT_CONDA_ENV:-${envName}}"`,
    `export SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV="\${SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV:-0}"`,
    `export CONDA_CHANGEPS1=true`,
    `sleep 0.1`,
    simpleCondaActivationShell(false, { quietActivate: false, reportOptionalFailure: true, reportOptionalMissing: true, hookShell: "bash" }),
    `sleep 0.1`,
    `if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then cd "$WORK_DIR"; fi`,
    `rm -f "$__SIMPLE_EXPERIMENT_BASHRC" >/dev/null 2>&1 || true`,
  ];
  return `if command -v bash >/dev/null 2>&1; then __SIMPLE_EXPERIMENT_BASHRC="\${TMPDIR:-/tmp}/simple-agent-shell-$$.bashrc"; export __SIMPLE_EXPERIMENT_BASHRC WORK_DIR SIMPLE_EXPERIMENT_CONDA_ENV SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV CONDA_CHANGEPS1; if printf "%s\\n" ${bashRcLines.map(shellQuote).join(" ")} > "$__SIMPLE_EXPERIMENT_BASHRC"; then exec bash --rcfile "$__SIMPLE_EXPERIMENT_BASHRC" -i; fi; fi`;
}

function simpleCondaActivationShell(required: boolean, options: SimpleCondaActivationOptions = {}): string {
  const missing = required
    ? `echo "Conda env $SIMPLE_EXPERIMENT_CONDA_ENV is required."; exit 127`
    : (options.reportOptionalMissing ? `echo "SimpleExperiment conda activation failed: conda command not found."; true` : "true");
  const failed = required
    ? `{ echo "Conda env $SIMPLE_EXPERIMENT_CONDA_ENV is required."; exit 127; }`
    : (options.reportOptionalFailure ? `{ __SIMPLE_EXPERIMENT_CONDA_RC=$?; echo "SimpleExperiment conda activation failed: conda activate $SIMPLE_EXPERIMENT_CONDA_ENV exited $__SIMPLE_EXPERIMENT_CONDA_RC."; true; }` : "true");
  const missingGuard = required ? `"\${SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV:-1}" = "1"` : (options.reportOptionalMissing ? `"1" = "1"` : `"0" = "1"`);
  const activateRedirect = options.quietActivate === false ? "" : " >/dev/null 2>&1";
  const hookShell = options.hookShell || "posix";
  return [
    `if [ -n "$SIMPLE_EXPERIMENT_CONDA_ENV" ]; then :`,
    `for __SIMPLE_EXPERIMENT_CONDA_SH in "$HOME/miniconda3/etc/profile.d/conda.sh" "$HOME/anaconda3/etc/profile.d/conda.sh" "$HOME/miniforge3/etc/profile.d/conda.sh" "$HOME/mambaforge/etc/profile.d/conda.sh" "/opt/conda/etc/profile.d/conda.sh" "/opt/anaconda3/etc/profile.d/conda.sh" "/usr/local/anaconda3/etc/profile.d/conda.sh"; do if ! command -v conda >/dev/null 2>&1 && [ -f "$__SIMPLE_EXPERIMENT_CONDA_SH" ]; then . "$__SIMPLE_EXPERIMENT_CONDA_SH"; fi; done`,
    `if command -v conda >/dev/null 2>&1; then __SIMPLE_EXPERIMENT_CONDA_SETUP="$(conda shell.${hookShell} hook 2>/dev/null)" && eval "$__SIMPLE_EXPERIMENT_CONDA_SETUP" || true; fi`,
    `if command -v conda >/dev/null 2>&1; then conda activate "$SIMPLE_EXPERIMENT_CONDA_ENV"${activateRedirect} || ${failed}; elif [ ${missingGuard} ]; then ${missing}; fi`,
    `fi`,
  ].join("; ");
}

function normalizeCondaEnvName(value: string | undefined): string {
  const normalized = String(value || simpleDefaultCondaEnv).trim();
  return normalized === "-" || normalized === "--" ? "" : normalized;
}

function slug(value: string): string {
  return String(value || "worker").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worker";
}
