const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { OpenSshTunnelManager, SYSTEM_SSH_PATH } = require("../../dist/mac/OpenSshTunnels.js");

async function waitUntil(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error("waitUntil timed out");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

class FakeChild extends EventEmitter {
  constructor(pid, options = {}) { super(); this.pid = pid; this.exitCode = null; this.signalCode = null; this.signals = []; this.stubborn = options.stubbornKill === true; }
  kill(signal) {
    this.signals.push(signal);
    if (this.stubborn) return true;
    if (this.exitCode === null && this.signalCode === null) { this.exitCode = signal === "SIGKILL" ? 137 : 143; this.emit("close", this.exitCode, null); }
    return true;
  }
  die(code) { this.exitCode = code; this.emit("close", code, null); }
  dieBySignal(signal) { this.signalCode = signal; this.emit("close", null, signal); }
}

const endpoint = (id = "worker-a", localForwardPort = 29101) => ({ id, host: id + ".example.org", user: "scientist", sshPort: 2222,
  localForwardHost: "127.0.0.1", localForwardPort, remoteAgentHost: "127.0.0.1", remoteAgentPort: 29200 });
const AUTH = { args: ["-o", "BatchMode=no", "-F", "none"], env: { SIMPLE_SFTP_AUTH_NONCE: "n" } };
// The auto (system SSH config) method carries no -F none, so user config is in scope.
const AUTH_AUTO = { args: ["-o", "BatchMode=no"], env: {} };

function fixture(options = {}) {
  const spawns = [], acquired = [], released = [], gates = [], configs = [];
  const children = [];
  let pid = 4000;
  const manager = new OpenSshTunnelManager({
    platform: options.platform || "darwin",
    sshProbe: () => options.sshMissing ? false : true,
    spawn: (file, args, cfg) => {
      spawns.push({ file, args, env: cfg.env });
      const child = new FakeChild(++pid, options);
      children.push(child);
      if (options.onSpawn) options.onSpawn(child, spawns.length, args);
      return child;
    },
    configProbe: options.configProbe || (args => { configs.push(args); return { status: 0, stdout: "localforward [127.0.0.1]:29101 [127.0.0.1]:29200\nproxycommand none\npermitlocalcommand no\n" }; }),
    acquireAuth: async target => {
      if (options.authFailsFor && options.authFailsFor.includes(target.host)) throw new Error("认证被拒绝");
      acquired.push(target);
      if (options.onAcquire) await options.onAcquire(target);
      return { ...(options.autoAuth ? AUTH_AUTO : AUTH), env: { ...AUTH.env, SIMPLE_SFTP_AUTH_NONCE: "nonce-" + target.host }, nonce: "nonce-" + target.host };
    },
    releaseAuth: async nonce => { released.push(nonce); },
    portAvailable: options.portBusy ? async (_host, port) => !(options.portBusy.includes && options.portBusy.includes(port)) : async () => true,
    portListening: options.portListening || (async () => options.listeningRef ? options.listeningRef.value : !options.portsStayClosed),
    probeTunnel: options.healthyPort ? async () => true : async () => false,
    assertBusinessAllowed: () => { gates.push(1); if (options.gateBlocks) throw new Error("配套插件正在更新"); },
    delay: async ms => { await new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))); },
    verifyTimeoutMs: 40, verifyPollMs: 5, killSettleMs: 20,
  });
  return { manager, spawns, acquired, released, gates, children, configs };
}

test("forward-only argument array binds identity, ports and auth without any remote command, shell or ClearAllForwardings", async () => {
  const f = fixture();
  const outcomes = await f.manager.launchAll([endpoint()]);
  assert.equal(outcomes[0].state, "verified");
  const spawn = f.spawns[0];
  assert.equal(spawn.file, SYSTEM_SSH_PATH);
  assert.equal(spawn.args[0], "-p"); assert.equal(spawn.args[1], "2222");
  assert.deepEqual(spawn.args.slice(2, 6), AUTH.args);
  assert.ok(spawn.args.includes("-N")); assert.ok(spawn.args.includes("-L"));
  assert.ok(spawn.args.includes("127.0.0.1:29101:127.0.0.1:29200"));
  assert.equal(spawn.args[spawn.args.length - 1], "scientist@worker-a.example.org");
  assert.equal(spawn.args.filter(arg => String(arg).includes("ClearAllForwardings")).length, 0, "ClearAllForwardings would clear this very -L");
  assert.equal(spawn.args.filter(arg => ["-t", "-J", "-W", "-oRemoteCommand", "RemoteCommand=yes", "-tt", "-X"].includes(arg)).length, 0);
  assert.equal(spawn.args.filter(arg => String(arg).includes("RemoteCommand")).length, 0);
  assert.equal(spawn.args.join(" ").match(/\b(?:sh|bash|scp|rsync)\b/g), null);
  assert.equal(spawn.env.SIMPLE_SFTP_AUTH_NONCE, "nonce-worker-a.example.org");
  assert.deepEqual(f.acquired, [{ host: "worker-a.example.org", username: "scientist", port: 2222 }]);
  assert.equal(f.gates.length, 2, "business admission is rechecked after asynchronous auth");
  // With -F none pinned by mac-auth the user config is out of scope; no -G needed.
  assert.equal(f.configs.length, 0);
});

test("the real OpenSSH parser proves the produced argv keeps exactly the intended local forward", () => {
  const f = fixture();
  const args = f.manager.buildArguments(endpoint("worker-a"), ["-o", "BatchMode=no", "-F", "none", "-o", "StrictHostKeyChecking=accept-new"]);
  const nativeSsh = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "OpenSSH", "ssh.exe") : "/usr/bin/ssh";
  const result = spawnSync(nativeSsh, ["-G", ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const lines = String(result.stdout).split("\n").map(line => line.trim()).filter(Boolean);
  const forwards = lines.filter(line => line.startsWith("localforward "));
  assert.deepEqual(forwards, ["localforward [127.0.0.1]:29101 [127.0.0.1]:29200"], "exactly the intended forward survives config parsing");
  assert.equal(lines.some(line => /^proxycommand (?!none$)/.test(line)), false);
  assert.equal(lines.some(line => /^permitlocalcommand yes$/.test(line)), false);
  // The frozen regression: ClearAllForwardings wipes the command-line -L entirely.
  const poisoned = spawnSync(nativeSsh, ["-G", "-F", "none", "-o", "ClearAllForwardings=yes", "-N", "-L", "127.0.0.1:29101:127.0.0.1:29200", "scientist@worker-a.example.org"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(String(poisoned.stdout).split("\n").filter(line => line.trim().startsWith("localforward ")).length, 0);
});

test("user config in scope is verified by ssh -G and hidden forwards or local commands fail closed", async () => {
  const duplicated = fixture({ autoAuth: true, configProbe: () => ({ status: 0, stdout: "localforward [127.0.0.1]:29101 [127.0.0.1]:29200\nlocalforward [127.0.0.1]:9999 [evil]:99\nproxycommand none\n" }) });
  const outcomes = await duplicated.manager.launchAll([endpoint()]);
  assert.equal(outcomes[0].state, "failed");
  assert.match(outcomes[0].message, /恰好一条预期本地转发/);
  assert.equal(duplicated.spawns.length, 0);
  assert.deepEqual(duplicated.released, ["nonce-worker-a.example.org"]);

  const sneaky = fixture({ autoAuth: true, configProbe: () => ({ status: 0, stdout: "localforward [127.0.0.1]:29101 [127.0.0.1]:29200\npermitlocalcommand yes\nlocalcommand touch /tmp/pwn\n" }) });
  const sneakyOutcomes = await sneaky.manager.launchAll([endpoint()]);
  assert.equal(sneakyOutcomes[0].state, "failed");
  assert.match(sneakyOutcomes[0].message, /隐藏本地命令或代理/);
  assert.equal(sneaky.spawns.length, 0);

  const clean = fixture({ autoAuth: true });
  const cleanOutcomes = await clean.manager.launchAll([endpoint()]);
  assert.equal(cleanOutcomes[0].state, "verified");
  assert.equal(clean.configs.length, 1, "auto-auth launch proves the effective config once before spawning");
  assert.deepEqual(clean.configs[0], clean.spawns[0].args, "probe checks the exact argv subsequently spawned");
});

test("failed config probes and hidden remote/dynamic forwards or ProxyJump never spawn", async () => {
  const valid = "localforward [127.0.0.1]:29101 [127.0.0.1]:29200\n";
  for (const result of [{ status: 1, stdout: valid }, { status: null, stdout: valid },
    ...["remoteforward 9000 example.org:80", "dynamicforward 127.0.0.1:9000", "proxyjump jump.example.org"]
      .map(extra => ({ status: 0, stdout: valid + extra + "\n" }))]) {
    const f = fixture({ autoAuth: true, configProbe: () => result });
    const outcomes = await f.manager.launchAll([endpoint()]);
    assert.equal(outcomes[0].state, "failed");
    assert.equal(f.spawns.length, 0);
    assert.deepEqual(f.released, ["nonce-worker-a.example.org"]);
  }
});

test("queued launch is bound to the original endpoint values even when the caller mutates its objects", async () => {
  const f = fixture();
  const target = endpoint(), targets = [target];
  const result = f.manager.launchAll(targets);
  target.host = "other.example.org"; target.localForwardPort = 29999; targets.length = 0;
  assert.equal((await result)[0].state, "verified");
  assert.equal(f.acquired[0].host, "worker-a.example.org");
  assert.ok(f.spawns[0].args.includes("127.0.0.1:29101:127.0.0.1:29200"));
  for (const option of ["ControlMaster=no", "ControlPath=none", "ForkAfterAuthentication=no"])
    assert.ok(f.spawns[0].args.includes(option));
});

test("a child dying inside the listener await never becomes verified on launch or reuse", async () => {
  let f;
  f = fixture({ portListening: async () => { f.children[0].dieBySignal("SIGKILL"); return true; } });
  assert.equal((await f.manager.launchAll([endpoint()]))[0].state, "failed");
  assert.deepEqual(f.manager.running(), []);
  let die = false;
  const reused = fixture({ portListening: async () => { if (die) reused.children[0].die(255); return true; } });
  assert.equal((await reused.manager.launchAll([endpoint()]))[0].state, "verified");
  die = true;
  assert.equal((await reused.manager.launchAll([endpoint()]))[0].state, "failed");
  assert.deepEqual(reused.manager.running(), []);
});

test("cancellation landing inside the listener await stops the child and never reports verified", async () => {
  const controller = new AbortController();
  const f = fixture({ portListening: async () => { controller.abort(); return true; } });
  assert.equal((await f.manager.launchAll([endpoint()], { signal: controller.signal }))[0].state, "cancelled");
  assert.deepEqual(f.manager.running(), []);
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"]);
});

test("an update beginning during authentication blocks spawn and releases the late nonce", async () => {
  const options = { onAcquire: async () => { options.gateBlocks = true; } };
  const f = fixture(options);
  const outcomes = await f.manager.launchAll([endpoint()]);
  assert.equal(outcomes[0].state, "failed"); assert.match(outcomes[0].message, /更新/);
  assert.equal(f.gates.length, 2); assert.equal(f.spawns.length, 0);
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"]);
});

test("a child error with a live PID never proves exit or releases its authentication", async () => {
  const f = fixture({ stubbornKill: true });
  await f.manager.launchAll([endpoint()]);
  f.children[0].emit("error", new Error("EPERM from child kill"));
  assert.equal(f.manager.running().length, 1); assert.equal(f.manager.running()[0].verified, false);
  assert.deepEqual(f.released, []);
  assert.equal((await f.manager.stop())[0].state, "failed");
  assert.equal(f.manager.running().length, 1); assert.deepEqual(f.released, []);
  f.children[0].die(0);
  assert.deepEqual(f.manager.running(), []);
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"]);
});

test("IPv6 bind hosts are bracketed in the forward spec", async () => {
  const f = fixture();
  const args = f.manager.buildArguments({ ...endpoint(), localForwardHost: "::1" }, AUTH.args);
  assert.ok(args.includes("[::1]:29101:127.0.0.1:29200"), args.join(" "));
});

test("endpoint validation rejects shell-bearing users, low ports and ids before any auth or spawn", async () => {
  const f = fixture();
  const outcomes = await f.manager.launchAll([
    { ...endpoint("bad1"), user: "scientist; rm -rf /" },
    { ...endpoint("bad2"), localForwardPort: 22 },
    { ...endpoint("bad3"), sshPort: 70000 },
  ]);
  assert.deepEqual(outcomes.map(item => item.state), ["failed", "failed", "failed"]);
  assert.equal(f.spawns.length, 0); assert.equal(f.acquired.length, 0);
});

test("double click shares one flight; a verified child is reused and an unverified one is only re-checked read-only", async () => {
  const f = fixture();
  const first = f.manager.launchAll([endpoint()]);
  const second = f.manager.launchAll([endpoint()]);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, "identical endpoint sets merge");
  assert.equal(f.spawns.length, 1);
  const third = await f.manager.launchAll([endpoint()]);
  assert.equal(third[0].state, "verified", "a previously verified listening child is honestly verified");
  assert.equal(f.spawns.length, 1);

  const stalled = fixture({ portsStayClosed: true });
  const requested = await stalled.manager.launchAll([endpoint()]);
  assert.equal(requested[0].state, "requested");
  const again = await stalled.manager.launchAll([endpoint()]);
  assert.equal(again[0].state, "requested", "an unverified child never auto-upgrades without the port actually listening");
  assert.equal(stalled.spawns.length, 1);
  const upgraded = await stalled.manager.launchAll([endpoint()]);
  assert.equal(upgraded[0].state, "requested");
});

test("a different endpoint set never merges into an in-flight flight and receives its own outcomes", async () => {
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const f = fixture({ onAcquire: () => gate });
  const first = f.manager.launchAll([endpoint("worker-a")]);
  const second = f.manager.launchAll([endpoint("worker-b", 29102)]);
  assert.notEqual(first, second);
  releaseGate();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.map(item => [item.id, item.state]), [["worker-a", "verified"]]);
  assert.deepEqual(b.map(item => [item.id, item.state]), [["worker-b", "verified"]]);
  assert.equal(f.spawns.length, 2);
});

test("changed endpoint configuration for the same id stops the owned child and never reuses the old target", async () => {
  const f = fixture();
  await f.manager.launchAll([endpoint("worker-a", 29101)]);
  const outcomes = await f.manager.launchAll([endpoint("worker-a", 29399)]);
  assert.equal(outcomes[0].state, "verified");
  assert.equal(f.spawns.length, 2, "the changed target starts fresh instead of reusing the old forward");
  assert.deepEqual(f.children[0].signals, ["SIGTERM"], "the old owned child is stopped first");
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"]);
});

test("foreign port owner without a healthy tunnel fails only that target; a healthy tunnel is reused", async () => {
  const blocked = fixture({ portBusy: [29101] });
  const outcomes = await blocked.manager.launchAll([endpoint("worker-a", 29101), endpoint("worker-b", 29102)]);
  assert.equal(outcomes[0].state, "failed");
  assert.match(outcomes[0].message, /已被其他进程占用/);
  assert.equal(outcomes[1].state, "verified");
  assert.equal(blocked.spawns.length, 1);
  assert.equal(blocked.spawns[0].args.join(" ").includes("29102"), true);

  const healthy = fixture({ portBusy: [29101], healthyPort: true });
  const reused = await healthy.manager.launchAll([endpoint("worker-a", 29101)]);
  assert.equal(reused[0].state, "existing_tunnel");
  assert.equal(healthy.spawns.length, 0);
});

test("auth is bound to the exact identity, released exactly once on every terminal path", async () => {
  const f = fixture({ portsStayClosed: true, onSpawn: (child, index) => { if (index === 1) setImmediate(() => child.die(255)); } });
  const outcomes = await f.manager.launchAll([endpoint("worker-a")]);
  assert.equal(outcomes[0].state, "failed");
  assert.match(outcomes[0].message, /退出/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"]);
  assert.deepEqual(await f.manager.stop(["worker-a"]), []);
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"]);
});

test("a signal-killed child is dead: null exit code with a signal never counts as a running reuse", async () => {
  const f = fixture();
  await f.manager.launchAll([endpoint("worker-a")]);
  f.children[0].dieBySignal("SIGKILL");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.manager.running(), [], "SIGKILL exit (exitCode null) must not look alive");
  const outcomes = await f.manager.launchAll([endpoint("worker-a")]);
  assert.equal(outcomes[0].state, "verified", "the dead child is replaced by a fresh launch, not reused");
  assert.equal(f.spawns.length, 2);
});

test("a synchronously throwing spawn releases the nonce and starts nothing", async () => {
  const released = [];
  const manager = new OpenSshTunnelManager({
    platform: "darwin", sshProbe: () => true,
    spawn: () => { throw new Error("EPIPE mock"); },
    acquireAuth: async () => ({ args: AUTH.args, env: AUTH.env, nonce: "nonce-x" }),
    releaseAuth: async nonce => { released.push(nonce); },
    portAvailable: async () => true, portListening: async () => true,
    verifyTimeoutMs: 40, verifyPollMs: 5,
  });
  const outcomes = await manager.launchAll([endpoint("worker-a")]);
  assert.equal(outcomes[0].state, "failed");
  assert.match(outcomes[0].message, /EPIPE/);
  assert.deepEqual(released, ["nonce-x"]);
});

test("a cancel landing while auth is pending releases the nonce without spawning", async () => {
  const controller = new AbortController();
  const f = fixture({ onAcquire: async () => { controller.abort(); } });
  const outcomes = await f.manager.launchAll([endpoint("worker-a")], { signal: controller.signal });
  assert.equal(outcomes[0].state, "cancelled");
  assert.equal(f.spawns.length, 0);
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"]);
});

test("partial failure continues other endpoints and auth refusal never spawns", async () => {
  const f = fixture({ authFailsFor: ["worker-a.example.org"] });
  const outcomes = await f.manager.launchAll([endpoint("worker-a"), endpoint("worker-b", 29102)]);
  assert.equal(outcomes[0].state, "failed");
  assert.match(outcomes[0].message, /认证被拒绝/);
  assert.equal(outcomes[1].state, "verified");
  assert.equal(f.spawns.length, 1);
});

test("cancelling a launch stops only this batch and never touches tunnels from an earlier batch", async () => {
  const controller = new AbortController();
  const f = fixture({ onSpawn: (_child, index) => { if (index === 2) controller.abort(); } });
  await f.manager.launchAll([endpoint("worker-a")]);
  const kept = f.children[0];
  const outcomes = await f.manager.launchAll([endpoint("worker-b", 29102), endpoint("worker-c", 29103)], { signal: controller.signal });
  assert.deepEqual(outcomes.map(item => item.state), ["cancelled", "cancelled"]);
  assert.equal(f.spawns.length, 2, "the rest of the cancelled batch is never started");
  assert.deepEqual(kept.signals, [], "a tunnel from an earlier batch is never stopped by this batch's cancel");
  assert.ok(f.children[1].signals.length >= 1);
  assert.deepEqual(f.released, ["nonce-worker-b.example.org"]);
});

test("cancelling a launch mid-flight stops the spawned child of this run and never starts the rest", async () => {
  const controller = new AbortController();
  const f = fixture({ onSpawn: (child, index) => { if (index === 1) controller.abort(); } });
  const outcomes = await f.manager.launchAll([endpoint("worker-a"), endpoint("worker-b", 29102)], { signal: controller.signal });
  assert.equal(outcomes[0].state, "cancelled");
  assert.equal(outcomes[1].state, "cancelled");
  assert.equal(f.spawns.length, 1);
  assert.ok(f.children[0].signals.length >= 1);
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"]);
});

test("stop kills only the tracked pid, releases auth and is idempotent", async () => {
  const f = fixture();
  await f.manager.launchAll([endpoint("worker-a")]);
  const stopped = await f.manager.stop(["worker-a"]);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].state, "cancelled");
  assert.deepEqual(f.children[0].signals, ["SIGTERM"]);
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"]);
  assert.deepEqual(await f.manager.stop(["worker-a"]), []);
  assert.deepEqual(await f.manager.stop(["never-started"]), []);
  assert.equal(f.children[0].signals.length, 1);
  // Foreign listeners are not in the registry: stopping unknown ids spawns no signals.
});

test("an unconfirmed SIGKILL death keeps the held record and never reports the tunnel stopped", async () => {
  const f = fixture({ stubbornKill: true });
  await f.manager.launchAll([endpoint("worker-a")]);
  const first = await f.manager.stop(["worker-a"]);
  assert.equal(first[0].state, "failed");
  assert.match(first[0].message, /未确认进程退出/);
  assert.deepEqual(f.released, [], "the nonce is not released while the process may still hold the forward");
  assert.equal(f.manager.running().length, 1, "the record survives until death is confirmed");
  f.children[0].dieBySignal("SIGKILL");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"], "confirmed death releases the nonce");
  assert.equal(f.manager.running().length, 0);
  assert.deepEqual(await f.manager.stop(["worker-a"]), [], "the record only clears once the exit is confirmed");
});

test("the paired update gate blocks every launch while an update is running", async () => {
  const f = fixture({ gateBlocks: true });
  await assert.rejects(f.manager.launchAll([endpoint()]), /更新/);
  assert.equal(f.spawns.length, 0);
});

test("a missing system OpenSSH binary fails closed and releases the acquired nonce", async () => {
  const f = fixture({ sshMissing: true });
  const outcomes = await f.manager.launchAll([endpoint()]);
  assert.equal(outcomes[0].state, "failed");
  assert.match(outcomes[0].message, /OpenSSH/);
  assert.equal(f.spawns.length, 0);
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"]);
});

test("off macOS an injected test harness never claims verified, and the production default refuses to spawn at all", async () => {
  const f = fixture({ platform: "linux" });
  const outcomes = await f.manager.launchAll([endpoint()]);
  assert.equal(outcomes[0].state, "requested");
  assert.match(outcomes[0].message, /隔离替身/);
  assert.doesNotMatch(outcomes[0].message, /隧道已建立/);
  const production = new OpenSshTunnelManager({ platform: "linux", acquireAuth: async () => ({ args: [], env: {}, nonce: "x" }) });
  await assert.rejects(production.launchAll([endpoint()]), /仅支持 macOS/);
});

test("a tunnel that exits after spawn but before port confirmation is never reported as verified", async () => {
  let child;
  const f = fixture({ portsStayClosed: true, onSpawn: spawned => { child = spawned; setImmediate(() => spawned.die(255)); } });
  const outcomes = await f.manager.launchAll([endpoint()]);
  assert.equal(outcomes[0].state, "failed");
  assert.match(outcomes[0].message, /退出/);
  assert.equal(child.signals.length, 0);
});

// ---- 079r lifecycle review regressions: queued dispose, honest dispose, real-state reverify, ----
// ---- unproven stop blocks restart, and the post-auth spawn gate. One gate decision must not ----
// ---- authorize a spawn across later async updates, stops, or disposal. ----

test("a launch queued behind another never spawns after dispose", async () => {
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const f = fixture({ portsStayClosed: true, onAcquire: target => target.host === "worker-b.example.org" ? gate : undefined });
  const first = f.manager.launchAll([endpoint("worker-a", 29101), endpoint("worker-b", 29102)]);
  // worker-a 已完成 spawn；worker-b 停在异步认证中，同时 worker-c 在队列里等待。
  await waitUntil(() => f.spawns.length === 1 && f.acquired.length === 2);
  const second = f.manager.launchAll([endpoint("worker-c", 29103)]);
  await f.manager.dispose();
  releaseGate();
  const firstOutcomes = await first;
  const secondOutcomes = await second;
  assert.equal(f.spawns.length, 1, "only the pre-dispose spawn exists; nothing starts after disposal");
  assert.match(firstOutcomes[1].message, /管理器已停用/, "auth-pending endpoint must not spawn after disposal");
  for (const item of secondOutcomes) {
    assert.equal(item.state, "cancelled");
    assert.match(item.message, /管理器已停用/);
  }
  const child = f.children[0];
  assert.ok(child.signals.includes("SIGKILL"), "dispose still kills the child it already owns");
});

test("dispose keeps the record and the nonce while a kill is unproven", async () => {
  const f = fixture({ stubbornKill: true });
  await f.manager.launchAll([endpoint()]);
  await f.manager.dispose();
  assert.equal(f.manager.running().length, 1, "an unproven death keeps the held record");
  assert.equal(f.manager.running()[0].verified, true);
  assert.deepEqual(f.released, [], "auth material is not released while the child's death is unproven");
  await assert.rejects(f.manager.launchAll([endpoint("worker-b", 29102)]), /已停用/);
});

test("a previously verified tunnel is re-read from the listener and downgraded when silent", async () => {
  const listeningRef = { value: true };
  const f = fixture({ listeningRef });
  const first = await f.manager.launchAll([endpoint()]);
  assert.equal(first[0].state, "verified");
  await new Promise(resolve => setImmediate(resolve)); // 让 inFlight 清理完成，第二次是新的 flight 而非复用同一 promise。
  listeningRef.value = false;
  const second = await f.manager.launchAll([endpoint()]);
  assert.equal(second[0].state, "requested", "verified status must come from a fresh listener read, not memory");
  assert.match(second[0].message, /未确认/);
  assert.equal(f.manager.running()[0].verified, false, "the downgrade is visible in the running inventory");
  assert.equal(f.spawns.length, 1, "re-checking never double-spawns");
});

test("changed configuration waits when the old tunnel's death is unproven instead of overwriting the record", async () => {
  const f = fixture({ stubbornKill: true });
  await f.manager.launchAll([endpoint("worker-a", 29101)]);
  const changed = { ...endpoint("worker-a", 29101), remoteAgentPort: 29300 };
  const outcomes = await f.manager.launchAll([changed]);
  assert.equal(outcomes[0].state, "failed");
  assert.match(outcomes[0].message, /未确认退出/);
  assert.equal(f.spawns.length, 1, "no new-configuration child may cover the unsettled record");
  assert.equal(f.manager.running()[0].remoteAgentPort === undefined, true);
  assert.ok(f.children[0].signals.includes("SIGTERM") && f.children[0].signals.includes("SIGKILL"));
});

test("disposal during auth never spawns and releases the late nonce", async () => {
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const f = fixture({ onAcquire: () => gate });
  const pending = f.manager.launchAll([endpoint()]);
  await waitUntil(() => f.acquired.length === 1);
  await f.manager.dispose();
  releaseGate();
  const outcomes = await pending;
  assert.equal(outcomes[0].state, "cancelled", "dispose aborts the in-flight launch; the outcome stays honest as cancelled");
  assert.match(outcomes[0].message, /已停用/);
  assert.equal(f.spawns.length, 0, "the gate after async auth refuses spawn after disposal");
  assert.deepEqual(f.released, ["nonce-worker-a.example.org"], "the late auth acquisition is released exactly once");
});

test("stop UI counts only proven stops, routes the full stop through stopAll, and an empty live set never claims Agent confirmation", async () => {
  const adapterFile = path.resolve(__dirname, "../../dist/platform/MacHostAdapter.js");
  const localRequire = require("node:module").createRequire(adapterFile);
  const shown = [];
  const warned = [];
  const vscodeStub = {
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback, inspect: () => undefined }) },
    extensions: { getExtension: () => undefined },
    window: {
      showInformationMessage: async message => { shown.push(message); },
      showWarningMessage: async message => { warned.push(message); },
      withProgress: async (_options, work) => work({ report() {} }),
    },
    commands: { executeCommand: async () => undefined },
    ProgressLocation: { Notification: 1 },
  };
  const sharedExports = {};
  const sandbox = { require: name => name === "vscode" ? vscodeStub : localRequire(name), exports: sharedExports, module: { exports: sharedExports }, console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, TextDecoder };
  vm.runInNewContext(fs.readFileSync(adapterFile, "utf8"), sandbox);
  class BaseProvider {
    constructor() {
      this.context = { globalState: { get: () => undefined }, extension: { packageJSON: { version: "0.5.315" } } };
      this.setupConfig = { workerTunnels: [], condaEnv: "", remoteTmuxSessionPrefix: "simple" };
    }
    loadSetupConfig() { return this.setupConfig; }
    async refreshLocalSshConfig() {}
    async assertSshTransportIdentities() {}
    sftpSharedTargets() { return []; }
    currentTunnelLaunchBlockers() { return []; }
    tunnelLaunchItems() {
      return [{ id: "worker-a", config: { hubHost: "worker-a.example.org", hubUser: "scientist", hubSshPort: 2222,
        localForwardHost: "127.0.0.1", localForwardPort: 29101, remoteAgentHost: "127.0.0.1", remoteAgentPort: 29200 } }];
    }
  }
  sandbox.module.exports.installMacHostAdapter(BaseProvider);

  const stopper = new BaseProvider();
  const stopCalls = [];
  stopper.__macTunnelManager = {
    stopAll: async () => { stopCalls.push("all"); return [
      { id: "worker-a", state: "cancelled", message: "worker-a: 已停止本插件启动的系统隧道（pid 4101）。", pid: 4101, stopped: true },
      { id: "worker-b", state: "failed", message: "worker-b: 已发送终止信号但未确认进程退出（pid 4102）；持有记录保留，未回报已停止。", pid: 4102 },
    ]; },
    stop: async ids => { stopCalls.push(ids.join(",")); return []; },
  };
  const outcomes = await stopper.stopMacSystemTunnels();
  assert.deepEqual(stopCalls, ["all"], "the full-stop UI must abort in-flight launches via stopAll");
  assert.equal(outcomes.length, 2);
  assert.equal(shown.length, 0, "an unproven stop is not an informational success");
  assert.equal(warned.length, 1);
  assert.match(warned[0], /已停止 1 个/);
  assert.match(warned[0], /1 个未确认退出，未回报已停止/);
  assert.doesNotMatch(warned[0], /已停止 2 个/);

  const idStop = new BaseProvider();
  const idCalls = [];
  idStop.__macTunnelManager = { stopAll: async () => { throw new Error("must not full-stop for an id-scoped stop"); },
    stop: async ids => { idCalls.push(ids.slice()); return [{ id: ids[0], state: "cancelled", message: "done", stopped: true }]; } };
  await idStop.stopMacSystemTunnels(["worker-a"]);
  assert.deepEqual(idCalls, [["worker-a"]]);

  const starter = new BaseProvider();
  starter.__macTunnelManager = { launchAll: async () => [{ id: "worker-a", state: "requested", message: "worker-a: 启动请求已发出，本地转发端口尚未监听；在检测确认前视为未建立。" }] };
  const result = await starter.startMacSystemTunnels(false);
  assert.equal(result.agentFailures.length, 0);
  const summary = shown.at(-1) || warned.at(-1);
  assert.match(summary, /待确认 1 个/);
  assert.match(summary, /未尝试 Agent 启动/, "with no live tunnel the summary must not claim Agent confirmation");
  assert.doesNotMatch(summary, /Agent 启动已通过共同受管生命周期协议确认/);
});
