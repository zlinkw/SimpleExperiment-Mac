const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { callLocalRpc, readLocalDiscovery, requestLocalJson, validateDiscovery } = require("../../dist/cli/LocalApiClient");

async function fixture(t, handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const call = { route: req.url, method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") };
      calls.push(call);
      if (handler) handler(call, res);
      else res.end(JSON.stringify(call.method === "GET" ? { schemaVersion: 1, rpc: "json-rpc-2.0", methods: ["status", "plan.run"], name: "SimpleExperiment Mac", version: "0.5.277", instanceId } : { jsonrpc: "2.0", id: 1, result: JSON.parse(call.body).params }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "Mac CLI 中文 路径 "));
  const file = path.join(directory, "发现文件.json");
  const startedAt = new Date(Date.UTC(2026, 9, 27, 0, 0, 0)).toISOString();
  const instanceId = process.pid + ":" + startedAt;
  const discovery = { baseUrl: `http://127.0.0.1:${server.address().port}`, token: "fixture-token", name: "SimpleExperiment Mac", version: "0.5.277", pid: process.pid, startedAt, instanceId, status: "running" };
  fs.writeFileSync(file, JSON.stringify(discovery), "utf8");
  fs.writeFileSync(path.join(directory, "KEEP.txt"), "Local CLI test evidence; no cleanup performed.\n", "utf8");
  return { server, calls, file, directory, discovery, read: () => readLocalDiscovery(file) };
}

test("business RPC rereads UTF8 discovery and current capabilities for every call, retaining confirmations", async t => {
  const f = await fixture(t);
  const params = { plan: "experiments/plans/中文 A.yaml", confirm: false, pathConfirmed: false, endpointId: "worker-B" };
  assert.deepEqual((await callLocalRpc(f.read, "plan.run", params)).result, params);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.discovery, token: "new-session-token" }), "utf8");
  await callLocalRpc(f.read, "status", {});
  assert.deepEqual(f.calls.map(c => [c.method, c.route]), [["GET", "/api/v1/capabilities"], ["POST", "/api/v1/rpc"], ["GET", "/api/v1/capabilities"], ["POST", "/api/v1/rpc"]]);
  assert.equal(f.calls[2].auth, "Bearer new-session-token");
  assert.equal(f.calls[3].auth, "Bearer new-session-token");
  await requestLocalJson({ ...f.discovery, baseUrl: f.discovery.baseUrl.replace("127.0.0.1", "localhost") }, "/api/v1/capabilities");
  assert.equal(f.calls.length, 5);
});

test("discovery rejects nonlocal listeners, embedded credentials, stopped listeners and invalid UTF8 before requests", async t => {
  const f = await fixture(t);
  for (const baseUrl of ["https://127.0.0.1:1234", "http://192.0.2.1:1234", "http://127.0.0.1", "http://user:secret@127.0.0.1:1234", "http://127.0.0.1:1234/path", "http://127.0.0.1:1234/?x=1"]) assert.throws(() => validateDiscovery({ ...f.discovery, baseUrl }));
  assert.throws(() => validateDiscovery({ ...f.discovery, token: "fixture\r\ntoken" }));
  assert.throws(() => validateDiscovery({ ...f.discovery, status: "stopped" }));
  fs.writeFileSync(f.file, Buffer.from([0xff])); assert.throws(f.read);
  fs.writeFileSync(f.file, " ".repeat(65537), "utf8"); assert.throws(f.read, /size|Invalid/);
  assert.equal(f.calls.length, 0);
});

test("unknown methods, mismatched identity and malformed capabilities never send business RPC", async t => {
  let contract = { schemaVersion: 1, rpc: "json-rpc-2.0", methods: ["status"], name: "SimpleExperiment Mac", version: "0.5.277" };
  const f = await fixture(t, (_, res) => res.end(JSON.stringify(contract)));
  await assert.rejects(callLocalRpc(f.read, "plan.run", {}), /unavailable/);
  for (const bad of [{ ...contract, name: "Windows original" }, { ...contract, version: "0.0.1" }, { ...contract, methods: [null] }, { ...contract, schemaVersion: 2 }, []]) {
    contract = bad;
    await assert.rejects(callLocalRpc(f.read, "status", {}), /capabilities|JSON/);
  }
  assert.ok(f.calls.every(c => c.method === "GET"));
});

test("listener changes during preflight stop RPC without retrying a business operation", async t => {
  let f;
  f = await fixture(t, (_, res) => {
    fs.writeFileSync(f.file, JSON.stringify({ ...f.discovery, startedAt: new Date(Date.UTC(2026, 9, 27, 0, 5, 0)).toISOString(), instanceId: process.pid + ":" + new Date(Date.UTC(2026, 9, 27, 0, 5, 0)).toISOString() }), "utf8");
    res.end(JSON.stringify({ schemaVersion: 1, rpc: "json-rpc-2.0", methods: ["status"], name: f.discovery.name, version: f.discovery.version }));
  });
  await assert.rejects(callLocalRpc(f.read, "status", {}), /changed during preflight/);
  assert.equal(f.calls.length, 1);
});

test("HTTP failures, broken JSON, oversized and interrupted responses are failures, never RPC success", async t => {
  let mode = "http";
  const f = await fixture(t, (_, res) => {
    if (mode === "http") { res.writeHead(403); res.end('{"result":"wrong"}'); }
    else if (mode === "broken") res.end("{");
    else if (mode === "scalar") res.end("true");
    else if (mode === "large") res.end(" ".repeat(256));
    else { res.writeHead(200, { "content-length": 1000 }); res.end("{}"); }
  });
  for (mode of ["http", "broken", "scalar", "large", "interrupted"]) {
    await assert.rejects(requestLocalJson(f.discovery, "/api/v1/capabilities", undefined, 128, 300), /HTTP|JSON|size|interrupted|timed out/);
  }
  assert.throws(() => requestLocalJson(f.discovery, "http://192.0.2.1:1234"), /route/);
});

test("response deadline covers a listener that keeps sending bytes", async t => {
  const f = await fixture(t, (_, res) => {
    res.write("{");
    const interval = setInterval(() => res.write(" "), 10);
    res.on("close", () => clearInterval(interval));
  });
  const start = Date.now();
  await assert.rejects(requestLocalJson(f.discovery, "/api/v1/health", undefined, 65536, 100), /timed out|interrupted/);
  assert.ok(Date.now() - start < 1500);
});

test("JSON-RPC envelopes require the current request identity and preserve confirmation errors", async t => {
  let response = { jsonrpc: "2.0", id: 1, error: { code: 2001, message: "CONFIRM_REQUIRED", data: { path: "/Data/中文 A" } } };
  const f = await fixture(t, (call, res) => res.end(JSON.stringify(call.method === "GET" ? { schemaVersion: 1, rpc: "json-rpc-2.0", methods: ["status"], name: "SimpleExperiment Mac", version: "0.5.277" } : response)));
  assert.deepEqual(await callLocalRpc(f.read, "status", {}), response);
  for (const bad of [{ jsonrpc: "2.0", id: 9, result: null }, { id: 1, result: true }, { jsonrpc: "2.0", id: 1, error: "bad" }, { jsonrpc: "2.0", id: 1, result: null, error: {} }]) {
    response = bad;
    await assert.rejects(callLocalRpc(f.read, "status", {}), /JSON-RPC/);
  }
  await assert.rejects(callLocalRpc(f.read, "status", []), /object params/);
  await assert.rejects(callLocalRpc(f.read, "status", { large: "x".repeat(4 * 1024 * 1024) }), /request exceeds/);
});

test("CLI discovery uses the Mac variable, ignores the original Windows one, and the revoked api passthrough stays refused", async t => {
  const f = await fixture(t);
  // Mac 适配：只承认 Mac 发现文件；Windows 原始变量指向不存在的文件，必须被忽略而不是回退。
  const priorMac = process.env.SIMPLE_EXPERIMENT_MAC_API_FILE;
  const priorOriginal = process.env.SIMPLE_EXPERIMENT_API_FILE;
  process.env.SIMPLE_EXPERIMENT_MAC_API_FILE = f.file;
  process.env.SIMPLE_EXPERIMENT_API_FILE = path.join(f.directory, "missing-original-api.json");
  try {
    const { discoveryOrNull } = require("../../dist/cli/api.js");
    const found = discoveryOrNull();
    assert.ok(found, "Mac 发现文件必须被 CLI 读到");
    assert.equal(String(found.baseUrl), f.discovery.baseUrl);
    await callLocalRpc(() => readLocalDiscovery(f.file), "status", {});
    assert.deepEqual(f.calls.map(c => c.method), ["GET", "POST"]);
    assert.equal(f.calls.at(-1).auth, "Bearer fixture-token");
    const legacy = require("../../dist/cli.legacy");
    await legacy.apiRequest({ baseUrl: "http://192.0.2.1:1234", token: "must-not-send" }, "status", {});
    assert.equal(f.calls.at(-1).auth, "Bearer fixture-token");
  } finally {
    if (priorMac === undefined) delete process.env.SIMPLE_EXPERIMENT_MAC_API_FILE;
    else process.env.SIMPLE_EXPERIMENT_MAC_API_FILE = priorMac;
    if (priorOriginal === undefined) delete process.env.SIMPLE_EXPERIMENT_API_FILE;
    else process.env.SIMPLE_EXPERIMENT_API_FILE = priorOriginal;
  }
  // Windows 权威 2026-10-23 撤销 api 原始透传：必须显式拒绝，且不得再打到本地监听。
  const callsBefore = f.calls.length;
  const removed = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, "../../dist/cli.js"), "api", "status"], {
      cwd: f.directory, windowsHide: true,
      env: { ...process.env, SIMPLE_EXPERIMENT_MAC_API_FILE: f.file, SIMPLE_EXPERIMENT_API_FILE: "missing-original-api.json" },
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.notEqual(removed.code, 0);
  assert.match(removed.stderr + removed.stdout, /removed entry: simpleex api/);
  assert.equal(f.calls.length, callsBefore);
});
