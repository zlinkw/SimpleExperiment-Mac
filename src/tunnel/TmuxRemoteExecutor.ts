/**
 * TmuxRemoteExecutor — 远端指令唯一入口
 * 所有远端命令必须经此封装走 tmux load-buffer/paste-buffer 围栏，禁止直接 ssh "command" 在宿主 shell 执行
 * 约束来源：docs/troubleshooting.md#tmux-围栏 与 zlk-server-tmux Skill
 */

import * as child_process from "child_process";

export interface TmuxRemoteOptions {
  host?: string; // 需由调用方按拓扑配置传入，无默认值
  target?: string; // 默认 zlk1:0.0
  timeoutMs?: number;
}

const DEFAULT_HOST = "";
const DEFAULT_TARGET = "zlk1:0.0";

// 围栏：禁止重型调度/agent 指令落入主 shell zlk1:0.0（仅允许 zlk-sch-*/zlk-gpu-*/zlk-worker-*-agent 等子窗口）
function isMainShellTarget(target: string): boolean {
  const s = String(target || "").trim();
  if (!s) return true;
  if (s === "zlk1:0.0" || s === "zlk1:0" || s === "0.0") return true;
  if (s.startsWith("zlk1") && !s.includes("-sch-") && !s.includes("-gpu-") && !s.includes("-agent")) return true;
  if (s.endsWith(":0.0") && !s.includes("-sch-") && !s.includes("-gpu-") && !s.includes("-agent")) return true;
  return false;
}
function isHeavySchedulerCommand(command: string): boolean {
  const c = String(command || "");
  if (c.includes("cluster_scheduler.py") || c.includes("cluster_scheduler") || c.includes("SIMPLE_TMUX_READY") || c.includes("SIMPLE_EXPERIMENT_TMUX") || c.includes("SIMPLE_EXPERIMENT_EXIT_CODE")) return true;
  if (c.includes("conda activate")) return true;
  if (/^\s*cd\s+/.test(c) && c.includes("/data")) return true;
  if (c.includes("printf") && c.includes("exit_code")) return true;
  return false;
}

function buildTmuxRemoteCommand(target: string): string {
  return `tmux load-buffer -; tmux paste-buffer -t ${target}; tmux send-keys -t ${target} Enter`;
}

export function tmuxExecViaBuffer(command: string, options: TmuxRemoteOptions = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const host = String(options.host || DEFAULT_HOST).trim();
  if (!host) throw new Error("tmux host 未配置：请按拓扑传入 worker/host 配置");
  const target = options.target || DEFAULT_TARGET;
  if (isMainShellTarget(target) && isHeavySchedulerCommand(command)) {
    throw new Error(`refusing heavy scheduler command on main shell target ${target}: ${String(command).slice(0, 120)}`);
  }
  const remote = buildTmuxRemoteCommand(target);
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn("ssh.exe", [host, remote], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += String(d)));
    proc.stderr?.on("data", (d) => (stderr += String(d)));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    proc.stdin?.write(command, "utf8");
    proc.stdin?.end();
  });
}

export function tmuxCapturePane(host: string, target: string = DEFAULT_TARGET, lines: number = 80): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn("ssh.exe", [host, `tmux capture-pane -pt ${target} -S -${lines}`], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d) => (out += String(d)));
    proc.stderr?.on("data", (d) => (err += String(d)));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `capture failed ${code}`))));
  });
}

// 兼容旧调用：提供同步校验 pane 存在的 helper
export async function assertTmuxPaneAlive(host: string, target: string = DEFAULT_TARGET): Promise<void> {
  const inspect = `tmux display-message -p -t ${target} '#{session_name}:#{window_index}.#{pane_index} #{pane_current_path}'`;
  await new Promise<void>((resolve, reject) => {
    child_process.exec(`ssh.exe ${host} "${inspect}"`, (err, stdout) => {
      if (err || !String(stdout).includes(target.split(":")[0])) reject(new Error(`pane ${target} not alive on ${host}`));
      else resolve();
    });
  });
}
