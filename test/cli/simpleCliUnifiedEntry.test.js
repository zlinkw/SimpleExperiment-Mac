const { assert, fs, http, os, path, test, runCli } = require("./simpleCli.support.cjs");

// Fake SimpleSFTP extension-host API used only by this file; nothing here touches real servers.
// FIXTURE POLICY: zero cleanup. Every fixture lives under a unique retained run directory below.
const TOKEN = "unified-cli-test-token";
const PID = 4321;
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `unified-cli-fixtures-${Date.now()}-${process.pid}-`));
console.log(`[fixtures retained, no cleanup] ${FIXTURE_ROOT}`);

function fixtureDir(name) {
  const dir = path.join(FIXTURE_ROOT, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDiscovery(dir, overrides = {}) {
  const file = path.join(dir, "sftp-api.json");
  const body = {
    schemaVersion: 1, name: "SimpleSFTP", version: "0.2.107",
    baseUrl: "http://127.0.0.1:1", host: "127.0.0.1", port: 1, token: TOKEN,
    pid: PID, startedAt: STARTED_AT,
    ...overrides,
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return { file, body };
}

function startFakeApi(options) {
  const token = options.token || TOKEN;
  const pid = options.pid || PID;
  const state = { capabilitiesCalls: 0, rpcCalls: 0, lastRpc: null };
  const capabilities = {
    schemaVersion: 1, name: options.name, version: options.version,
    instanceId: options.instanceId === undefined ? `${pid}:${STARTED_AT}` : options.instanceId,
    transport: ["http", "cli"], rpc: "json-rpc-2.0",
    features: { probe: 1 }, confirmation: { required: true, categories: ["confirm", "pathConfirmed"] },
    methods: ["status", "servers.list", "servers.delete", "servers.save", "config.list", "target.update"],
    ...(options.capabilities || {}),
  };
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end("{}"); return; }
    if (req.method === "GET" && req.url === "/api/v1/capabilities") {
      state.capabilitiesCalls += 1;
      if (options.onCapabilities) options.onCapabilities(state);
      res.end(JSON.stringify(capabilities));
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/rpc") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        state.rpcCalls += 1;
        state.lastRpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const reply = options.rpc ? options.rpc(state.lastRpc, state) : { result: { ok: true } };
        res.end(JSON.stringify({ jsonrpc: "2.0", id: state.lastRpc.id, ...reply }));
      });
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server, state, port: server.address().port,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
      });
    });
  });
}

function startFakeSftp(options = {}) {
  return startFakeApi({ name: "SimpleSFTP", version: "0.2.107", ...options });
}

function sftpEnv(file) {
  return { SIMPLE_SFTP_MAC_API_FILE: file };
}

function discoverable(fake, options = {}) {
  const { dir: dirName, ...overrides } = options;
  const dir = fixtureDir(dirName || "disc");
  return writeDiscovery(dir, { baseUrl: `http://127.0.0.1:${fake.port}`, port: fake.port, ...overrides });
}

test("doctor reports missing discovery without claiming success", async () => {
  const dir = fixtureDir("doctor-missing");
  const result = await runCli(["doctor", "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: path.join(dir, "absent-sftp.json"), SIMPLE_EXPERIMENT_MAC_API_FILE: path.join(dir, "absent-exp.json") } });
  assert.equal(result.code, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  for (const plugin of payload.plugins) {
    assert.equal(plugin.ok, false);
    assert.equal(plugin.instanceId, null);
    assert.match(plugin.checks[0].detail, /discovery not found/i);
  }
});

test("sftp capabilities and server list pass through the live API", async () => {
  const fake = await startFakeSftp({ rpc: (rpc) => (rpc.method === "servers.list" ? { result: { ok: true, activeServerId: "s1", servers: [{ id: "s1", label: "gpu1" }] } } : { result: { ok: true, status: "running" } }) });
  const { file } = discoverable(fake, { dir: "list" });
  try {
    const caps = await runCli(["sftp", "capabilities", "--json"], { env: sftpEnv(file) });
    assert.equal(caps.code, 0, caps.stderr);
    const capsBody = JSON.parse(caps.stdout);
    assert.equal(capsBody.version, "0.2.107");
    assert.equal(capsBody.instanceId, `${PID}:${STARTED_AT}`);
    assert.ok(capsBody.methods.includes("servers.list"));

    const list = await runCli(["sftp", "server", "list", "--json"], { env: sftpEnv(file) });
    assert.equal(list.code, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout).activeServerId, "s1");
    assert.ok(!list.stdout.includes(TOKEN) && !list.stderr.includes(TOKEN), "credentials must never appear in output");
  } finally { await fake.close(); }
});

test("instance identity mismatch is refused before any RPC is sent", async () => {
  const fake = await startFakeSftp({ capabilities: { instanceId: "9999:2026-01-01T00:00:00.000Z" } });
  const { file } = discoverable(fake, { dir: "id-mismatch" });
  try {
    const result = await runCli(["sftp", "server", "list", "--json"], { env: sftpEnv(file) });
    assert.equal(result.code, 2, result.stdout);
    assert.match(JSON.stringify(JSON.parse(result.stdout)), /Instance identity mismatch/);
    assert.equal(fake.state.rpcCalls, 0, "no RPC may reach a listener whose identity does not match discovery");
    assert.ok(!result.stdout.includes(TOKEN));
  } finally { await fake.close(); }
});

test("capabilities without instanceId are refused as an old extension", async () => {
  const fake = await startFakeSftp({ capabilities: { instanceId: undefined } });
  const { file } = discoverable(fake, { dir: "old-ext" });
  try {
    const result = await runCli(["sftp", "status", "--json"], { env: sftpEnv(file) });
    assert.equal(result.code, 2);
    assert.match(JSON.stringify(JSON.parse(result.stdout)), /instanceId/);
    assert.equal(fake.state.rpcCalls, 0);
  } finally { await fake.close(); }
});

test("wrong-plugin discovery in the sftp slot is refused with zero RPC", async () => {
  const fake = await startFakeApi({ name: "SimpleExperiment", version: "0.5.403" });
  const { file } = discoverable(fake, { dir: "wrong-plugin", name: "SimpleExperiment", version: "0.5.403" });
  try {
    // The fake and its discovery are fully self-consistent; only the SLOT binding may catch this.
    const result = await runCli(["sftp", "status", "--json"], { env: sftpEnv(file) });
    assert.equal(result.code, 2);
    assert.match(JSON.stringify(JSON.parse(result.stdout)), /Plugin slot mismatch/);
    assert.equal(fake.state.rpcCalls, 0);
  } finally { await fake.close(); }
});

test("discovery without name or with invalid pid is refused", async () => {
  const dir = fixtureDir("bad-identity");
  const noName = path.join(dir, "noname.json");
  fs.writeFileSync(noName, JSON.stringify({ baseUrl: "http://127.0.0.1:19766", token: "t", version: "0.2.107", pid: 1, startedAt: STARTED_AT }), "utf8");
  const missing = await runCli(["sftp", "status", "--json"], { env: sftpEnv(noName) });
  assert.equal(missing.code, 2);
  assert.match(JSON.stringify(JSON.parse(missing.stdout)), /plugin name/);

  const badPid = path.join(dir, "badpid.json");
  fs.writeFileSync(badPid, JSON.stringify({ baseUrl: "http://127.0.0.1:19766", token: "t", name: "SimpleSFTP", version: "0.2.107", pid: 0, startedAt: STARTED_AT }), "utf8");
  const refused = await runCli(["sftp", "status", "--json"], { env: sftpEnv(badPid) });
  assert.equal(refused.code, 2);
  assert.match(JSON.stringify(JSON.parse(refused.stdout)), /pid/);
});

test("discovery rewritten between capabilities and RPC aborts with zero RPC (double-read guard)", async () => {
  let file;
  const fake = await startFakeSftp({
    onCapabilities: () => {
      const body = JSON.parse(fs.readFileSync(file, "utf8"));
      body.token = "rotated-after-capabilities";
      fs.writeFileSync(file, JSON.stringify(body), "utf8");
    },
  });
  const found = discoverable(fake, { dir: "double-read" });
  file = found.file;
  try {
    const result = await runCli(["sftp", "server", "list", "--json"], { env: sftpEnv(file) });
    assert.equal(result.code, 2);
    assert.match(JSON.stringify(JSON.parse(result.stdout)), /discovery changed during preflight/);
    assert.equal(fake.state.rpcCalls, 0);
  } finally { await fake.close(); }
});

test("stopped discovery is refused and shown by doctor", async () => {
  const { file } = discoverable(await startFakeSftp({}), { name: "ignored" }); // reserved dir; below uses a standalone file
  const dir = fixtureDir("stopped");
  const stopped = path.join(dir, "api.json");
  fs.writeFileSync(stopped, JSON.stringify({ baseUrl: "http://127.0.0.1:19766", token: "", name: "SimpleSFTP", version: "0.2.107", pid: 1, startedAt: STARTED_AT, status: "stopped" }), "utf8");
  const doctor = await runCli(["doctor", "--json"], { env: sftpEnv(stopped) });
  assert.equal(doctor.code, 2);
  const body = JSON.parse(doctor.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.plugins.find((row) => row.discoveryPath === stopped).ok, false);
});

test("confirmation required keeps the full preview as ENV refusal and never claims success", async () => {
  const fake = await startFakeSftp({
    rpc: (rpc) => (rpc.params.confirm === true
      ? { result: { ok: true, deleted: rpc.params.id } }
      : { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { method: "servers.delete", requires: ["confirm"], operation: "删除 SimpleSFTP 服务器配置" } } }),
  });
  const { file } = discoverable(fake, { dir: "confirm" });
  try {
    const denied = await runCli(["sftp", "server", "delete", "s9", "--json"], { env: sftpEnv(file) });
    assert.equal(denied.code, 2);
    const body = JSON.parse(denied.stdout);
    assert.equal(body.success, false);
    assert.equal(body.error.code, "ENV");
    assert.match(body.error.message, /CONFIRM_REQUIRED: servers.delete/);
    assert.deepEqual(body.error.detail.requires, ["confirm"]);
    assert.equal(body.error.detail.method, "servers.delete");
    assert.equal(fake.state.lastRpc.params.confirm, false, "CLI must forward confirm=false so the server decides");
    assert.ok(!denied.stdout.includes(TOKEN) && !denied.stderr.includes(TOKEN));

    const accepted = await runCli(["sftp", "server", "delete", "s9", "--confirm", "--json"], { env: sftpEnv(file) });
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout), { ok: true, deleted: "s9" });
  } finally { await fake.close(); }
});

test("undeclared methods are refused client-side without an RPC round trip", async () => {
  const fake = await startFakeSftp({ capabilities: { methods: ["status"] } });
  const { file } = discoverable(fake, { dir: "undeclared" });
  try {
    const result = await runCli(["sftp", "server", "list", "--json"], { env: sftpEnv(file) });
    assert.equal(result.code, 3);
    assert.match(JSON.stringify(JSON.parse(result.stdout)), /Method unavailable/);
    assert.equal(fake.state.rpcCalls, 0);
  } finally { await fake.close(); }
});

test("transport failure keeps ENV/NETWORK exit codes and ok:false payloads are business failures", async () => {
  const fake = await startFakeSftp({});
  const { file } = discoverable(fake, { dir: "net" });
  const port = fake.port;
  await fake.close();
  const refused = await runCli(["sftp", "status", "--json"], { env: sftpEnv(file) });
  assert.equal(refused.code, 4, `closed listener on port ${port} must map NETWORK`);
  assert.equal(JSON.parse(refused.stdout).error.code, "NETWORK");

  const badJson = await startFakeSftp({ rpc: () => "not-used" });
  badJson.server.removeAllListeners("request");
  badJson.server.on("request", (req, res) => {
    if (req.method === "GET") { res.end(JSON.stringify({ schemaVersion: 1, rpc: "json-rpc-2.0", name: "SimpleSFTP", version: "0.2.107", instanceId: `${PID}:${STARTED_AT}`, methods: ["status"] })); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res.end("this-is-not-json"));
  });
  const bad = discoverable(badJson, { dir: "badjson" });
  try {
    const result = await runCli(["sftp", "status", "--json"], { env: sftpEnv(bad.file) });
    assert.equal(result.code, 3, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(JSON.stringify(JSON.parse(result.stdout)), /Invalid local API JSON-RPC response|Invalid local API JSON response/);
  } finally { await badJson.close(); }

  const failed = await startFakeSftp({ rpc: () => ({ result: { ok: false, error: "busy" } }) });
  const okFile = discoverable(failed, { dir: "okfalse" });
  try {
    const result = await runCli(["sftp", "status", "--json"], { env: sftpEnv(okFile.file) });
    assert.equal(result.code, 3, "a payload reporting ok:false is never a successful exit");
    assert.equal(JSON.parse(result.stdout).ok, false);
  } finally { await failed.close(); }
});

test("doctor reports discovery/capabilities version mismatch as failure", async () => {
  const fake = await startFakeSftp({ capabilities: { version: "0.2.99" } });
  const { file } = discoverable(fake, { dir: "ver-mismatch" });
  try {
    const result = await runCli(["doctor", "--json"], { env: sftpEnv(file) });
    assert.equal(result.code, 2);
    const sftpRow = JSON.parse(result.stdout).plugins.find((row) => row.discoveryPath === file);
    assert.equal(sftpRow.ok, false);
    assert.match(sftpRow.checks[0].detail, /version mismatch/);
  } finally { await fake.close(); }
});

test("help surfaces list the unified sftp and doctor entries", async () => {
  const top = await runCli(["--help"]);
  assert.equal(top.code, 0);
  assert.match(top.stdout, /sftp/);
  assert.match(top.stdout, /simpleex doctor/);
  const sftpHelp = await runCli(["sftp", "--help"]);
  assert.equal(sftpHelp.code, 0);
  assert.match(sftpHelp.stdout, /simpleex sftp status/);
  const doctorHelp = await runCli(["doctor", "--help"]);
  assert.equal(doctorHelp.code, 0);
  assert.match(doctorHelp.stdout, /pid:startedAt/);
});

// ---- unified transport classification, exercised through callPluginRpc itself ----
test("callPluginRpc bounds control calls and keeps proven long file operations unbounded, never auto-retrying", async () => {
  const { EventEmitter } = require("node:events");
  const httpModule = require("node:http");
  const transport = require("../../dist/cli/LocalApiClient.js");
  const dir = fixtureDir("timers");
  const file = path.join(dir, "api.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "SimpleSFTP", version: "0.2.107", baseUrl: "http://127.0.0.1:19766", host: "127.0.0.1", port: 19766, token: TOKEN, pid: PID, startedAt: STARTED_AT }), "utf8");
  process.env.SIMPLE_SFTP_MAC_API_FILE = file;
  const caps = { schemaVersion: 1, name: "SimpleSFTP", version: "0.2.107", instanceId: `${PID}:${STARTED_AT}`, rpc: "json-rpc-2.0", methods: ["status", "sync.projectInventory"] };
  const seen = [];
  const timers = [];
  const originalRequest = httpModule.request;
  const originalSetTimeout = global.setTimeout;
  let hangRpc = false;
  httpModule.request = (options, receive) => {
    seen.push(options.path);
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      if (options.path === "/api/v1/capabilities") {
        const res = new EventEmitter();
        res.statusCode = 200; res.destroy = () => {};
        receive(res);
        process.nextTick(() => { res.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, ...caps }))); res.emit("end"); });
        return;
      }
      const res = new EventEmitter();
      res.statusCode = 200; res.destroy = () => {};
      receive(res);
      if (!hangRpc) process.nextTick(() => { res.emit("data", Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')); res.emit("end"); });
    };
    return req;
  };
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return originalSetTimeout(() => {}, 0); };
  try {
    await transport.callPluginRpc("sftp", "status", {});
    assert.deepEqual(timers.map((t) => t.ms), [10000, 15000], "capabilities 10s + bounded control RPC 15s");

    timers.length = 0;
    await transport.callPluginRpc("sftp", "sync.projectInventory", {});
    assert.deepEqual(timers.map((t) => t.ms), [10000], "proven long file operation runs with no RPC timer");

    timers.length = 0; seen.length = 0; hangRpc = true;
    let message = "";
    // The hung RPC must not be awaited before firing its timer: start it, wait until the
    // 15s timer is scheduled, fire it manually, then settle.
    const pending = transport.callPluginRpc("sftp", "status", {}).catch((error) => { message = error.message; });
    for (let i = 0; i < 400 && !timers.some((t) => t.ms === 15000); i += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 5));
    }
    const rpcTimer = timers.find((t) => t.ms === 15000);
    assert.ok(rpcTimer, "bounded control call must schedule a timer");
    rpcTimer.fn(); // fire the timeout exactly once
    await pending;
    await new Promise((resolve) => originalSetTimeout(resolve, 30)); // let any (forbidden) resend settle
    assert.match(message, /timed out/);
    assert.match(message, /outcome is unknown/);
    assert.equal(seen.filter((p) => p === "/api/v1/rpc").length, 1, "a timed-out write must never be auto-resent");
  } finally {
    httpModule.request = originalRequest;
    global.setTimeout = originalSetTimeout;
    delete process.env.SIMPLE_SFTP_MAC_API_FILE;
  }
});

test("plugin discovery path honors the test env override and defaults to the canonical plugin directory", () => {
  const transport = require("../../dist/cli/LocalApiClient.js");
  const original = process.env.SIMPLE_SFTP_MAC_API_FILE;
  process.env.SIMPLE_SFTP_MAC_API_FILE = "/tmp/port-check-sftp-api.json";
  try {
    assert.equal(transport.pluginDiscoveryPath("sftp"), "/tmp/port-check-sftp-api.json");
  } finally {
    if (original === undefined) delete process.env.SIMPLE_SFTP_MAC_API_FILE;
    else process.env.SIMPLE_SFTP_MAC_API_FILE = original;
  }
  // Mac 适配：Mac 版 SimpleSFTP 的发现文件默认落在自己的配置目录 SimpleSFTPMac（Windows 是 SimpleSFTP）；
  // 仍断言默认路径位于规范目录内，且上面的环境变量覆盖优先生效。
  assert.match(transport.pluginDiscoveryPath("sftp"), new RegExp(`SimpleSFTPMac${process.platform === "win32" ? "\\\\" : "/"}api\\.json$`));
});

test("doctor reports ok when both plugins handshake cleanly", async () => {
  const sftp = await startFakeSftp({});
  const expToken = "experiment-test-token";
  const exp = await startFakeApi({ name: "SimpleExperiment", version: "0.5.403", token: expToken, capabilities: { methods: ["status"] } });
  const dir = fixtureDir("doctor-ok");
  const sftpFile = path.join(dir, "sftp.json");
  const expFile = path.join(dir, "exp.json");
  fs.writeFileSync(sftpFile, `${JSON.stringify({ schemaVersion: 1, name: "SimpleSFTP", version: "0.2.107", baseUrl: `http://127.0.0.1:${sftp.port}`, host: "127.0.0.1", port: sftp.port, token: TOKEN, pid: PID, startedAt: STARTED_AT })}\n`, "utf8");
  fs.writeFileSync(expFile, `${JSON.stringify({ schemaVersion: 1, name: "SimpleExperiment", version: "0.5.403", baseUrl: `http://127.0.0.1:${exp.port}`, host: "127.0.0.1", port: exp.port, token: expToken, pid: PID, startedAt: STARTED_AT })}\n`, "utf8");
  try {
    const result = await runCli(["doctor", "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: sftpFile, SIMPLE_EXPERIMENT_MAC_API_FILE: expFile } });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.deepEqual(body.plugins.map((row) => row.plugin).sort(), ["SimpleExperiment", "SimpleSFTP"]);
    assert.ok(body.plugins.every((row) => row.ok && row.instanceId === `${PID}:${STARTED_AT}`));
  } finally { await sftp.close(); await exp.close(); }
});

// ---- parameter closure against the real backend contract ----
test("server config-path prints backend metadata and refuses to guess when absent", async () => {
  const withMeta = await startFakeSftp({ rpc: (rpc) => (rpc.method === "status" ? { result: { ok: true, serverConfigFile: "C:\\AppData\\fixture\\server-profiles\\servers.json" } } : { result: {} }) });
  const foundA = discoverable(withMeta, { dir: "cfgpath" });
  try {
    const result = await runCli(["sftp", "server", "config-path", "--json"], { env: sftpEnv(foundA.file) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).serverFile, "C:\\AppData\\fixture\\server-profiles\\servers.json");
  } finally { await withMeta.close(); }
  const noMeta = await startFakeSftp({ rpc: () => ({ result: { ok: true } }) });
  const foundB = discoverable(noMeta, { dir: "cfgpath-missing" });
  try {
    const result = await runCli(["sftp", "server", "config-path", "--json"], { env: sftpEnv(foundB.file) });
    assert.equal(result.code, 3);
    assert.match(JSON.stringify(JSON.parse(result.stdout)), /does not expose serverConfigFile/);
  } finally { await noMeta.close(); }
});

test("target update closes the confirmation/patch contract on both sides", async () => {
  const dir = fixtureDir("target");
  const badPatch = path.join(dir, "bad-patch.json");
  fs.writeFileSync(badPatch, "{ not json", "utf8");
  const emptyPatch = path.join(dir, "empty-patch.json");
  fs.writeFileSync(emptyPatch, "{}", "utf8");
  const goodPatch = path.join(dir, "patch.json");
  fs.writeFileSync(goodPatch, JSON.stringify({ host: "gpu1" }), "utf8");

  const fake = await startFakeSftp({
    rpc: (rpc) => (rpc.params.confirm === true && rpc.params.pathConfirmed === true
      ? { result: { ok: true, target: rpc.params.patch } }
      : { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { method: "target.update", requires: ["confirm", "pathConfirmed"] } } }),
  });
  const { file } = discoverable(fake, { dir: "target" });
  try {
    const usagePath = await runCli(["sftp", "target", "update", "--json"], { env: sftpEnv(file) });
    assert.equal(usagePath.code, 1);

    const bad = await runCli(["sftp", "target", "update", "--path", "/tmp/ws", "--file", badPatch, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(file) });
    assert.equal(bad.code, 1);
    assert.match(JSON.stringify(JSON.parse(bad.stdout)), /must be valid JSON/);
    assert.equal(fake.state.capabilitiesCalls, 0, "parameter errors must not open an API session");

    const empty = await runCli(["sftp", "target", "update", "--path", "/tmp/ws", "--file", emptyPatch, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(file) });
    assert.equal(empty.code, 1);
    assert.match(JSON.stringify(JSON.parse(empty.stdout)), /at least one field/);

    const denied = await runCli(["sftp", "target", "update", "--path", "/tmp/ws", "--file", goodPatch, "--json"], { env: sftpEnv(file) });
    assert.equal(denied.code, 2);
    const deniedBody = JSON.parse(denied.stdout);
    assert.deepEqual(deniedBody.error.detail.requires, ["confirm", "pathConfirmed"]);

    const ok = await runCli(["sftp", "target", "update", "--path", "/tmp/ws", "--file", goodPatch, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(file) });
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(fake.state.lastRpc.params, { localPath: "/tmp/ws", patch: { host: "gpu1" }, confirm: true, pathConfirmed: true });
  } finally { await fake.close(); }
});

test("server save forwards setActive and strict server JSON", async () => {
  const dir = fixtureDir("save");
  const serverFile = path.join(dir, "server.json");
  fs.writeFileSync(serverFile, JSON.stringify({ label: "gpu9", host: "gpu9", port: 22, username: "u", remotePath: "/srv/app" }), "utf8");
  const fake = await startFakeSftp({ rpc: (rpc) => ({ result: { ok: true, echo: rpc.params } }) });
  const { file } = discoverable(fake, { dir: "save" });
  try {
    const activated = await runCli(["sftp", "server", "save", "--file", serverFile, "--set-active", "--confirm", "--json"], { env: sftpEnv(file) });
    assert.equal(activated.code, 0, activated.stderr);
    assert.equal(fake.state.lastRpc.params.setActive, true);
    assert.equal(fake.state.lastRpc.params.confirm, true);

    const bad = await runCli(["sftp", "server", "save", "--json"], { env: sftpEnv(file) });
    assert.equal(bad.code, 1);
    assert.equal(fake.state.capabilitiesCalls, 1, "the one earlier session only; the usage error itself must not open another");
  } finally { await fake.close(); }
});

// 087 审核补修：统一命令行必须把 macOS 安装名写进帮助，避免用户按 Windows 名字操作。
test("unified CLI help states the macOS install name simpleex-mac", () => {
  const help = fs.readFileSync(path.join(__dirname, "../../src/cli/help.ts"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  assert.ok(Object.prototype.hasOwnProperty.call(pkg.bin || {}, "simpleex-mac"),
    "Mac 包必须把 CLI 安装名注册为 simpleex-mac");
  assert.match(help, /simpleex-mac/, "帮助文本必须给出 macOS 安装名");
  assert.match(help, /simple-local\.simple-experiment-mac/, "帮助文本必须说明 macOS 扩展标识");
  assert.match(help, /SIMPLE_EXPERIMENT_MAC_API_FILE/, "帮助文本必须说明 macOS 服务发现变量");
});

