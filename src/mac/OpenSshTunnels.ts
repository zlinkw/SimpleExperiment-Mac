/** macOS system-OpenSSH forwarder for the approved one-click tunnel feature.
 *
 * This is the only place on Mac that may start `ssh`, and only as a fixed
 * argument array: no shell, no scp/rsync, no remote command, no generic API.
 * ClearAllForwardings is never used: OpenSSH's config parser clears the
 * command-line -L too (verified with `ssh -G`), so instead the effective
 * config is proven before spawning whenever user configuration is in scope
 * (the paired mac-auth bridge pins `-F none` for explicit key/agent/password
 * methods). Authentication materials always come from the paired SimpleSFTP
 * Mac bridge; the nonce is released on every terminal path. Only children
 * started here are ever stopped, and unverified children are never claimed.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";

export const SYSTEM_SSH_PATH = "/usr/bin/ssh";
const FORWARD_OPTIONS = ["-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
  "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ForkAfterAuthentication=no"];

export type TunnelEndpoint = { id: string; displayName?: string; host: string; user: string; sshPort: number;
  localForwardHost: string; localForwardPort: number; remoteAgentHost: string; remoteAgentPort: number };
export type LaunchOutcome = { id: string; state: "verified" | "requested" | "existing_tunnel" | "failed" | "cancelled"; message: string; pid?: number;
  /** Only true when a child we started was proven exited after our stop signal. */ stopped?: boolean };
export type RunningTunnel = { id: string; pid: number; startedAt: number; verified: boolean };

type ChildLike = { pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null; once(event: "close" | "error", listener: (...args: any[]) => void): unknown; kill(signal?: NodeJS.Signals | number): boolean };
export type AuthAcquisition = { args: string[]; env: Record<string, string>; nonce: string };
export type TunnelHost = {
  platform?: NodeJS.Platform;
  sshPath?: string;
  sshProbe?: (file: string) => boolean;
  spawn?: (file: string, args: string[], options: { env: Record<string, string> }) => ChildLike;
  configProbe?: (args: string[]) => { status: number | null; stdout: string };
  acquireAuth?: (target: { host: string; username: string; port: number }) => Promise<AuthAcquisition>;
  releaseAuth?: (nonce: string) => Promise<unknown> | unknown;
  portAvailable?: (host: string, port: number) => Promise<boolean>;
  portListening?: (host: string, port: number) => Promise<boolean>;
  probeTunnel?: (endpoint: TunnelEndpoint) => Promise<boolean>;
  assertBusinessAllowed?: () => void;
  delay?: (ms: number) => Promise<void>;
  verifyTimeoutMs?: number;
  verifyPollMs?: number;
  killSettleMs?: number;
};

function endpointFingerprint(endpoint: TunnelEndpoint): string {
  return JSON.stringify([endpoint.id, endpoint.host, endpoint.user, endpoint.sshPort, endpoint.localForwardHost, endpoint.localForwardPort, endpoint.remoteAgentHost, endpoint.remoteAgentPort]);
}

class HeldTunnel {
  authReleased = false;
  verified = false;
  exited = false;
  startedAt = 0;
  child?: ChildLike;
  processError?: string;
  settled: Promise<void>;
  settle!: () => void;
  constructor(public endpoint: TunnelEndpoint, public nonce: string, public fingerprint: string) {
    this.settled = new Promise(resolve => { this.settle = resolve; });
  }
}

function validateEndpoint(endpoint: TunnelEndpoint): void {
  const id = String(endpoint.id || "");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error("隧道端点 ID 无效。");
  if (!/^([a-zA-Z0-9._-]+|\[[0-9a-fA-F:]+\])$/.test(endpoint.host) || !/^[a-zA-Z0-9._-]+$/.test(endpoint.user)) throw new Error(`${id}: SSH 地址或用户无效。`);
  const checks: Array<[string, number, number]> = [["SSH 端口", endpoint.sshPort, 1], ["本机端口", endpoint.localForwardPort, 1024], ["Agent 端口", endpoint.remoteAgentPort, 1024]];
  for (const [label, value, minimum] of checks) {
    if (!Number.isInteger(value) || value < minimum || value > 65535) throw new Error(`${id}: ${label} 无效。`);
  }
  if (!/^([a-zA-Z0-9.:[_-]+|\[[0-9a-fA-F:]+\])$/.test(endpoint.localForwardHost) || !/^([a-zA-Z0-9._-]+|\[[0-9a-fA-F:]+\])$/.test(endpoint.remoteAgentHost)) throw new Error(`${id}: 转发地址无效。`);
}

function bracketed(host: string): string { return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host; }

/** ssh -G prints every bind/connect host bracketed, IPv4 included. */
function displayBrackets(host: string): string { return host.startsWith("[") ? host : `[${host}]`; }

function forwardSpec(endpoint: TunnelEndpoint): string {
  return `${bracketed(endpoint.localForwardHost)}:${endpoint.localForwardPort}:${bracketed(endpoint.remoteAgentHost)}:${endpoint.remoteAgentPort}`;
}

function defaultSshProbe(file: string): boolean {
  try { const info = fs.statSync(file); return info.isFile(); } catch { return false; }
}

function defaultConfigProbe(sshPath: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(sshPath, ["-G", ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`无法解析本机 SSH 有效配置（${result.error?.message || `退出码 ${result.status}`}）；未启动转发。`);
  return { status: result.status, stdout: String(result.stdout || "") };
}

/** Proves the effective ssh config carries exactly the intended forward and no
 * local command or proxy surprises the user config could have injected. */
function assertEffectiveForward(probe: (args: string[]) => { status: number | null; stdout: string }, args: string[], endpoint: TunnelEndpoint): void {
  const result = probe(args);
  if (result.status !== 0) throw new Error(`${endpoint.id}: 无法确认 SSH 有效配置（退出码 ${result.status}），未启动。`);
  const lines = result.stdout.split("\n").map(line => line.trim()).filter(Boolean);
  const forwards = lines.filter(line => line.startsWith("localforward ")).map(line => line.slice("localforward ".length));
  const expected = `${displayBrackets(endpoint.localForwardHost)}:${endpoint.localForwardPort} ${displayBrackets(endpoint.remoteAgentHost)}:${endpoint.remoteAgentPort}`;
  if (forwards.length !== 1 || forwards[0] !== expected)
    throw new Error(`${endpoint.id}: 有效 SSH 配置不是恰好一条预期本地转发（检测到 ${forwards.length} 条）；用户配置可能带入额外转发，未启动。`);
  if (lines.some(line => /^(?:remoteforward|dynamicforward)\s/.test(line)))
    throw new Error(`${endpoint.id}: 用户 SSH 配置包含额外远程或动态转发，未启动。`);
  for (const [option, blocked] of [["permitlocalcommand", /yes/], ["localcommand", /^(?!none$)./], ["proxycommand", /^(?!none$)./], ["proxyjump", /^(?!none$)./], ["gatewayports", /yes/]] as Array<[string, RegExp]>) {
    const value = lines.filter(line => line.startsWith(`${option} `)).map(line => line.slice(option.length + 1).trim()).join(" ");
    if (value && blocked.test(value)) throw new Error(`${endpoint.id}: 用户 SSH 配置包含 ${option}；一键转发拒绝执行隐藏本地命令或代理，未启动。`);
  }
}

export class OpenSshTunnelManager {
  private held = new Map<string, HeldTunnel>();
  private inFlight?: { key: string; promise: Promise<LaunchOutcome[]> };
  private queue: Promise<unknown> = Promise.resolve();
  private abort?: AbortController;
  private disposed = false;
  private readonly platform: NodeJS.Platform;
  private readonly spawnInjected: boolean;
  private readonly sshPath: string;
  private readonly sshProbe: (file: string) => boolean;
  private readonly spawnChild: NonNullable<TunnelHost["spawn"]>;
  private readonly configProbe: (args: string[]) => { status: number | null; stdout: string };
  private readonly acquireAuth: NonNullable<TunnelHost["acquireAuth"]>;
  private readonly releaseAuth: NonNullable<TunnelHost["releaseAuth"]>;
  private readonly portAvailable?: (host: string, port: number) => Promise<boolean>;
  private readonly portListening?: (host: string, port: number) => Promise<boolean>;
  private readonly probeTunnel?: (endpoint: TunnelEndpoint) => Promise<boolean>;
  private readonly assertBusinessAllowed: () => void;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly verifyTimeoutMs: number;
  private readonly verifyPollMs: number;
  private readonly killSettleMs: number;

  constructor(host: TunnelHost = {}) {
    this.platform = host.platform || process.platform;
    this.spawnInjected = Boolean(host.spawn);
    this.sshPath = host.sshPath || SYSTEM_SSH_PATH;
    this.sshProbe = host.sshProbe || defaultSshProbe;
    this.spawnChild = host.spawn || ((file, args, options) => spawn(file, args, { ...options, stdio: "ignore" }) as ChildLike);
    this.configProbe = host.configProbe || (args => defaultConfigProbe(this.sshPath, args));
    this.acquireAuth = host.acquireAuth || (async () => { throw new Error("缺少配套 SimpleSFTP Mac 认证桥，未启动系统隧道。"); });
    this.releaseAuth = host.releaseAuth || (async () => undefined);
    this.portAvailable = host.portAvailable;
    this.portListening = host.portListening;
    this.probeTunnel = host.probeTunnel;
    this.assertBusinessAllowed = host.assertBusinessAllowed || (() => undefined);
    this.delay = host.delay || (async ms => { await new Promise<void>(resolve => setTimeout(resolve, ms)); });
    this.verifyTimeoutMs = host.verifyTimeoutMs ?? 5000;
    this.verifyPollMs = host.verifyPollMs ?? 500;
    this.killSettleMs = host.killSettleMs ?? 3000;
  }

  private get active(): boolean { return this.platform === "darwin"; }

  /** Builds the fixed forward-only argument array; it never contains a remote command
   * and never ClearAllForwardings, which would also clear this very -L. */
  buildArguments(endpoint: TunnelEndpoint, authArgs: string[]): string[] {
    validateEndpoint(endpoint);
    return ["-p", String(endpoint.sshPort), ...authArgs, ...FORWARD_OPTIONS, "-N", "-L", forwardSpec(endpoint), `${endpoint.user}@${endpoint.host}`];
  }

  running(): RunningTunnel[] {
    return [...this.held.values()].filter(entry => !entry.exited)
      .map(entry => ({ id: entry.endpoint.id, pid: entry.child?.pid || 0, startedAt: entry.startedAt, verified: entry.verified }));
  }

  /** One-click launch. Identical endpoint sets share one flight; different sets
   * queue strictly after it and never receive another set's outcomes. */
  launchAll(endpoints: TunnelEndpoint[], options: { signal?: AbortSignal; report?: (stage: string) => void } = {}): Promise<LaunchOutcome[]> {
    if (this.disposed) return Promise.reject(new Error("系统隧道管理器已停用。"));
    // The key and the queued action must refer to the same immutable settings.
    const snapshot = endpoints.map(endpoint => Object.freeze({ ...endpoint }));
    const request = { ...options };
    const key = JSON.stringify(snapshot.map(endpointFingerprint));
    if (this.inFlight) {
      if (this.inFlight.key === key) return this.inFlight.promise;
    }
    const promise = this.queue.then(() => this.runLaunch(snapshot, request), () => this.runLaunch(snapshot, request));
    this.queue = promise.then(() => undefined, () => undefined);
    this.inFlight = { key, promise };
    const clearFlight = () => { if (this.inFlight?.promise === promise) this.inFlight = undefined; };
    // Clear before callers resume after await, so the next click rechecks the
    // child rather than receiving the previous resolved "verified" outcome.
    void promise.then(clearFlight, clearFlight);
    return promise;
  }

  private async runLaunch(endpoints: TunnelEndpoint[], options: { signal?: AbortSignal; report?: (stage: string) => void }): Promise<LaunchOutcome[]> {
    // 排队期间 dispose 可能已经发生：队列授权不能跨越停用事实。
    if (this.disposed) return endpoints.map(endpoint => ({ id: endpoint.id, state: "cancelled" as const, message: `${endpoint.id}: 管理器已停用，未启动任何进程。` }));
    const report = options.report || (() => undefined);
    if (this.active) this.assertBusinessAllowed();
    if (!this.active && !this.spawnInjected) throw new Error("系统隧道启动仅支持 macOS 的系统 OpenSSH；当前平台未启动任何进程。");
    const outcomes: LaunchOutcome[] = [];
    const controller = new AbortController();
    this.abort = controller;
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const batchIds: string[] = [];
    for (const endpoint of endpoints) {
      if (this.disposed) { outcomes.push({ id: endpoint.id, state: "cancelled", message: `${endpoint.id}: 管理器已停用，未启动任何进程。` }); continue; }
      const existing = this.held.get(endpoint.id);
      if (existing && !existing.exited) {
        if (existing.fingerprint !== endpointFingerprint(endpoint)) {
          // Configuration changed: never reuse the old target; stop the one we own first,
          // and never start the new config while an unproven-exit record still holds the id.
          const stopped = await this.stop([endpoint.id]);
          if (stopped.some(item => item.state === "failed")) {
            outcomes.push({ id: endpoint.id, state: "failed", message: `${endpoint.id}: 同 ID 旧隧道未确认退出，持有记录保留；新配置未启动，避免覆盖未结算记录。` });
            continue;
          }
        } else {
          const state = await this.reverify(existing);
          if (existing.exited || this.held.get(endpoint.id) !== existing) {
            outcomes.push({ id: endpoint.id, state: "failed", message: `${endpoint.id}: 原转发在复查期间已退出，未确认隧道。` });
            continue;
          }
          outcomes.push(state === "verified"
            ? { id: endpoint.id, state: "verified", message: `${endpoint.id}: 本插件启动且已验证的转发仍在监听，未重复启动。`, pid: existing.child?.pid }
            : { id: endpoint.id, state: "requested", message: `${endpoint.id}: 本插件已有未确认的启动请求；只重新只读检测，不自动视为真实隧道。`, pid: existing.child?.pid });
          continue;
        }
      }
      if (controller.signal.aborted) { outcomes.push({ id: endpoint.id, state: "cancelled", message: `${endpoint.id}: 启动已取消，未发起新的连接。` }); continue; }
      batchIds.push(endpoint.id);
      try {
        outcomes.push(await this.launchOne(endpoint, report, controller.signal));
      } catch (error: any) {
        outcomes.push({ id: endpoint.id, state: controller.signal.aborted ? "cancelled" : "failed", message: `${endpoint.id}: ${error?.message || error}` });
      }
    }
    if (controller.signal.aborted) await this.stop(batchIds);
    this.abort = undefined;
    return outcomes;
  }

  /** Read-only re-check of a held child; never upgrades on faith alone, and a
   * previously verified tunnel must be re-read from the listener every time —
   * a dead forward must not keep claiming "verified" from memory. */
  private async reverify(entry: HeldTunnel): Promise<"verified" | "requested"> {
    const live = () => !this.disposed && !entry.exited && this.held.get(entry.endpoint.id) === entry
      && !entry.processError && entry.child?.exitCode == null && entry.child?.signalCode == null;
    if (!live()) { entry.verified = false; return "requested"; }
    const listening = await this.isListening(entry.endpoint);
    if (listening && live()) { entry.verified = true; return "verified"; }
    entry.verified = false;
    return "requested";
  }

  private async isListening(endpoint: TunnelEndpoint): Promise<boolean> {
    if (this.portListening) return this.portListening(endpoint.localForwardHost, endpoint.localForwardPort);
    if (this.portAvailable) return !(await this.portAvailable(endpoint.localForwardHost, endpoint.localForwardPort));
    return false;
  }

  private async launchOne(endpoint: TunnelEndpoint, report: (stage: string) => void, signal: AbortSignal): Promise<LaunchOutcome> {
    validateEndpoint(endpoint);
    if (this.portAvailable) {
      const free = await this.portAvailable(endpoint.localForwardHost, endpoint.localForwardPort);
      if (!free) {
        // An externally healthy tunnel is reused, never stolen from; a foreign
        // listener without a healthy Agent probe is an honest per-target failure.
        if (this.probeTunnel && await this.probeTunnel(endpoint)) {
          report(`${endpoint.id}: 本机端口已有健康隧道，复用现有转发。`);
          return { id: endpoint.id, state: "existing_tunnel", message: `${endpoint.id}: 端口已有健康隧道，未重复启动。` };
        }
        throw new Error(`本机端口 ${endpoint.localForwardHost}:${endpoint.localForwardPort} 已被其他进程占用；未启动该隧道。`);
      }
    }
    const auth = await this.acquireAuth({ host: endpoint.host, username: endpoint.user, port: endpoint.sshPort });
    const entry = new HeldTunnel(endpoint, auth.nonce, endpointFingerprint(endpoint));
    // 认证 await 之后的世界可能已经变化：最早一次 gate 授权不得跨异步边界沿用，
    // spawn 前必须重新核对停用、取消与该端点的最新持有记录。
    if (this.disposed) { await this.release(entry); throw new Error("系统隧道管理器已停用，未启动进程。"); }
    if (signal.aborted) { await this.release(entry); throw new Error("启动已取消，未发起新的连接。"); }
    const current = this.held.get(endpoint.id);
    if (current && !current.exited) { await this.release(entry); throw new Error("该端点已有更新的隧道请求或保留记录，未用过期请求覆盖。"); }
    if (this.active) {
      try { this.assertBusinessAllowed(); }
      catch (error) { await this.release(entry); throw error; }
    }
    const args = this.buildArguments(endpoint, auth.args);
    if (this.active) {
      if (!this.sshProbe(this.sshPath)) { await this.release(entry); throw new Error(`未找到 macOS 系统 OpenSSH（${this.sshPath}）。`); }
      const usesUserConfig = !(auth.args.includes("-F") && auth.args[auth.args.indexOf("-F") + 1] === "none");
      if (usesUserConfig) { try { assertEffectiveForward(this.configProbe, args, endpoint); } catch (error) { await this.release(entry); throw error; } }
    }
    report(`正在通过系统 OpenSSH 建立 ${endpoint.id} 的本地转发。`);
    let child: ChildLike;
    try { child = this.spawnChild(this.sshPath, args, { env: auth.env }); }
    catch (error) { await this.release(entry); throw error; }
    entry.child = child;
    entry.startedAt = Date.now();
    this.held.set(endpoint.id, entry);
    const settle = () => { entry.exited = true; void this.release(entry); if (this.held.get(endpoint.id) === entry) this.held.delete(endpoint.id); entry.settle(); };
    child.once("error", error => {
      entry.processError = String(error?.message || error);
      entry.verified = false;
      // A kill/send error can occur while a successfully spawned child lives.
      // Only failed spawn (no PID) or the close event proves it is gone.
      if (!Number.isInteger(child.pid) || (child.pid || 0) <= 0) settle();
    });
    child.once("close", settle);
    if (!Number.isInteger(child.pid) || (child.pid || 0) <= 0) { settle(); throw new Error(`${endpoint.id}: ssh 启动失败。`); }
    if (!entry.exited && child.exitCode !== undefined && child.exitCode !== null) { settle(); throw new Error(`${endpoint.id}: 系统隧道启动后立即退出（退出码 ${child.exitCode}）。`); }
    if (!this.active) return { id: endpoint.id, state: "requested", message: `${endpoint.id}: 隔离替身已启动（非 macOS，不宣称真实隧道）。`, pid: child.pid };
    const deadline = Date.now() + this.verifyTimeoutMs;
    for (;;) {
      if (entry.processError) throw new Error(`${endpoint.id}: 系统隧道进程错误，退出尚未确认：${entry.processError}`);
      if (entry.exited || (child.exitCode !== undefined && child.exitCode !== null)) {
        const reason = child.signalCode ? `信号 ${child.signalCode}` : `退出码 ${child.exitCode}`;
        throw new Error(`${endpoint.id}: 系统隧道在确认前退出（${reason}）。`);
      }
      if (signal.aborted) return { id: endpoint.id, state: "cancelled", message: `${endpoint.id}: 启动已取消。`, pid: child.pid };
      const listening = await this.isListening(endpoint);
      // A listener result cannot outlive the child, cancellation or disposal
      // observed while the asynchronous probe was pending.
      if (entry.exited || child.exitCode != null || child.signalCode != null)
        throw new Error(`${endpoint.id}: 系统隧道在端口复查期间退出，未确认隧道。`);
      if (entry.processError) throw new Error(`${endpoint.id}: 系统隧道进程错误，退出尚未确认：${entry.processError}`);
      if (signal.aborted || this.disposed)
        return { id: endpoint.id, state: "cancelled", message: `${endpoint.id}: 启动已取消，未确认隧道。`, pid: child.pid };
      if (listening) {
        entry.verified = true;
        return { id: endpoint.id, state: "verified", message: `${endpoint.id}: 本地转发端口已监听，隧道已建立。`, pid: child.pid };
      }
      if (Date.now() >= deadline) return { id: endpoint.id, state: "requested", message: `${endpoint.id}: 启动请求已发出，本地转发端口尚未监听；在检测确认前视为未建立。`, pid: child.pid };
      await this.delay(this.verifyPollMs);
    }
  }

  private async release(entry: HeldTunnel): Promise<void> {
    if (entry.authReleased) return;
    entry.authReleased = true;
    try { await this.releaseAuth(entry.nonce); } catch { /* the bridge releases the askpass session on its own TTL */ }
  }

  /** Stops only children this manager started; foreign listeners are never
   * touched, and an unconfirmed death keeps the record and says so. */
  async stop(ids: string[] = []): Promise<LaunchOutcome[]> {
    const targets = [...this.held.values()].filter(entry => !ids.length || ids.includes(entry.endpoint.id));
    const outcomes: LaunchOutcome[] = [];
    for (const entry of targets) {
      const child = entry.child;
      if (!child || entry.exited) {
        if (this.held.get(entry.endpoint.id) === entry) this.held.delete(entry.endpoint.id);
        await this.release(entry);
        outcomes.push({ id: entry.endpoint.id, state: "cancelled", message: `${entry.endpoint.id}: 启动的系统隧道已不在运行。` });
        continue;
      }
      const pid = child.pid || 0;
      child.kill("SIGTERM");
      await Promise.race([entry.settled, this.delay(this.killSettleMs)]);
      if (!entry.exited) {
        child.kill("SIGKILL");
        await Promise.race([entry.settled, this.delay(this.killSettleMs)]);
      }
      if (!entry.exited) {
        outcomes.push({ id: entry.endpoint.id, state: "failed", message: `${entry.endpoint.id}: 已发送终止信号但未确认进程退出（pid ${pid}）；持有记录保留，未回报已停止。`, pid });
        continue;
      }
      if (this.held.get(entry.endpoint.id) === entry) this.held.delete(entry.endpoint.id);
      await this.release(entry);
      outcomes.push({ id: entry.endpoint.id, state: "cancelled", message: `${entry.endpoint.id}: 已停止本插件启动的系统隧道（pid ${pid}）。`, pid, stopped: true });
    }
    return outcomes;
  }

  /** Cancels an in-flight launch and stops the tunnels this manager holds. */
  async stopAll(): Promise<LaunchOutcome[]> {
    this.abort?.abort();
    return this.stop();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.abort?.abort();
    for (const entry of [...this.held.values()]) {
      try { entry.child?.kill("SIGKILL"); } catch { /* the child may already be gone */ }
      // 与 stop 同一诚实标准：未证实退出前不删持有记录、不释放认证材料。
      if (entry.child && !entry.exited) await Promise.race([entry.settled, this.delay(this.killSettleMs)]);
      if (entry.exited || !entry.child) {
        if (this.held.get(entry.endpoint.id) === entry) this.held.delete(entry.endpoint.id);
        await this.release(entry);
      }
    }
  }
}
