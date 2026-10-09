const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const candidate = { path: "simple_cluster/tmp/old.log", fullPath: "/project/simple_cluster/tmp/old.log", type: "file", bytes: 12, modifiedAt: 1, purpose: "运行日志", token: "stable" };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function loadPanel(context) {
  let handler, dispose, contextChanged, html = "";
  const messages = [], actions = [];
  const webview = { set html(value) { html = value; }, postMessage(value) { messages.push(value); return Promise.resolve(true); },
    onDidReceiveMessage(value) { handler = value; return { dispose() {} }; } };
  const vscode = { window: { createWebviewPanel: () => ({ webview, onDidDispose(callback) { dispose = callback; } }) }, ViewColumn: { Active: 1 } };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, "../../src/extension/CacheCleanupPanel.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, { require: id => id === "vscode" ? vscode : require(id), module, exports: module.exports, Buffer, process, console, AbortController });
  module.exports.openCacheCleanupPanel(() => context, callback => { contextChanged = callback; return { dispose() { contextChanged = undefined; } }; });
  return { messages, actions, source, get html() { return html; }, message: m => handler(m), change: () => contextChanged?.(), close: () => dispose?.() };
}

test("cache review requires two path confirmations before sending a delete action", async () => {
  const actions = [];
  const client = { async postWorkerAction(workerId, action) { actions.push(action); return action === "preview-cache-cleanup" ? { status: "completed", candidates: [candidate] } : { status: "completed", deletedCount: 1 }; } };
  const panel = loadPanel({ client, endpoints: [{ id: "worker-a", role: "worker" }], generation: 1 });
  const { source, messages } = panel;
  const handler = panel.message;
  const ownerStart = source.indexOf("function schedulerStateCleanupOwnerMatches(");
  const ownerEnd = source.indexOf("\nfunction realPathSync(", ownerStart);
  const owner = source.slice(ownerStart, ownerEnd);
  assert.match(owner, /owner\.statePath/);
  assert.match(owner, /owner\.projectRoot/);
  assert.match(owner, /owner\.planFile/);
  assert.match(owner, /schedulerTerminal === true/);
  assert.match(source, /schedulerStateCleanupOwnerMatches\(realRoot, full, state\)/);
  assert.match(source, /stat\.size > 2n \* 1024n \* 1024n/);
  const script = panel.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script[1]));
  await handler({ type: "refresh" });
  assert.equal(messages.filter(item => item.type === "data").at(-1).rows.length, 1);
  const keys = ["worker-a|simple_cluster/tmp/old.log"];
  await handler({ type: "confirmSecond", keys });
  await handler({ type: "review", keys });
  await handler({ type: "confirmSecond", keys });
  assert.equal(actions.filter(item => item === "delete-cache-candidates").length, 0);
  await handler({ type: "confirmFirst", keys });
  await handler({ type: "confirmSecond", keys });
  assert.equal(actions.filter(item => item === "delete-cache-candidates").length, 1);
  panel.close();
});

test("refresh uses the current client after Agent preparation replaces the tunnel client", async () => {
  const context = { generation: 1, endpoints: [{ id: "worker-a", role: "worker" }], client: {
    async postWorkerAction() { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }
  } };
  const panel = loadPanel(context);
  await panel.message({ type: "refresh" });
  const failed = panel.messages.filter(m => m.type === "data").at(-1);
  assert.equal(failed.scans[0].status, "unavailable");
  assert.match(failed.scans[0].error, /ECONNREFUSED/);
  context.client = { async postWorkerAction() { return { status: "completed", candidates: [candidate] }; } };
  await panel.message({ type: "refresh" });
  const ready = panel.messages.filter(m => m.type === "data").at(-1);
  assert.equal(ready.scans[0].status, "ready");
  assert.equal(ready.rows.length, 1);
  panel.close();
});

test("connection context changes discard in-flight old scans and reread the latest context once", async () => {
  const pending = deferred();
  let calls = 0;
  const context = { generation: 1, endpoints: [{ id: "worker-a", role: "worker" }], client: {
    async postWorkerAction() { return pending.promise; }
  } };
  const panel = loadPanel(context);
  const first = panel.message({ type: "refresh" });
  context.client = { async postWorkerAction() { calls++; return { status: "completed", candidates: [{ ...candidate, path: "tmp/new.log", fullPath: "/project/tmp/new.log" }] }; } };
  panel.change();
  pending.resolve({ status: "completed", candidates: [candidate] });
  await first;
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const loaded = panel.messages.filter(m => m.type === "data" && m.rows.length);
  assert.equal(calls, 1);
  assert.ok(loaded.length);
  assert.ok(loaded.every(m => m.rows.every(row => row.path === "tmp/new.log")));
  panel.close();
});

test("pending and malformed previews cannot masquerade as an empty completed scan", async () => {
  const context = { generation: 1, endpoints: [{ id: "pending", role: "worker" }, { id: "malformed", role: "worker" }, { id: "empty", role: "worker" }], client: {
    async postWorkerAction(id) { return id === "pending" ? { status: "pending" } : id === "empty" ? { status: "completed", candidates: [] } : { status: "completed" }; }
  } };
  const panel = loadPanel(context);
  await panel.message({ type: "refresh" });
  const result = panel.messages.filter(m => m.type === "data").at(-1);
  assert.equal(result.scans.find(s => s.id === "empty").status, "ready");
  for (const id of ["pending", "malformed"]) assert.notEqual(result.scans.find(s => s.id === id).status, "ready");
  assert.match(result.note, /未完整/);
  assert.equal(result.rows.length, 0);
  panel.close();
});

test("completed Workers are visible while another Worker is still being read", async () => {
  const pending = deferred();
  const context = { generation: 1, endpoints: [{ id: "ready", role: "worker" }, { id: "waiting", role: "worker" }], client: {
    async postWorkerAction(id) { return id === "ready" ? { status: "completed", candidates: [candidate] } : pending.promise; }
  } };
  const panel = loadPanel(context);
  const refresh = panel.message({ type: "refresh" });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.ok(panel.messages.some(m => m.type === "data" && m.rows.length === 1 && m.scans.some(s => s.status === "loading")));
  pending.resolve({ status: "completed", candidates: [] });
  await refresh;
  panel.close();
});

test("project changes invalidate approved paths and closing the panel cancels preview reads", async () => {
  let deletes = 0, signal;
  const pending = deferred();
  const context = { generation: 1, endpoints: [{ id: "worker-a", role: "worker" }], client: {
    async postWorkerAction(_id, action, _body, options) {
      if (action === "delete-cache-candidates") { deletes++; return { status: "completed" }; }
      signal = options?.signal;
      return { status: "completed", candidates: [candidate] };
    }
  } };
  const panel = loadPanel(context);
  await panel.message({ type: "refresh" });
  const keys = ["worker-a|simple_cluster/tmp/old.log"];
  await panel.message({ type: "review", keys });
  await panel.message({ type: "confirmFirst", keys });
  context.generation++;
  await panel.message({ type: "confirmSecond", keys });
  assert.equal(deletes, 0);
  context.client = { async postWorkerAction(_id, _action, _body, options) { signal = options?.signal; return pending.promise; } };
  const refresh = panel.message({ type: "refresh" });
  panel.close();
  assert.equal(signal.aborted, true);
  const count = panel.messages.length;
  pending.resolve({ status: "completed", candidates: [candidate] });
  await refresh;
  assert.equal(panel.messages.length, count);
});

test("invalid candidate paths and interrupted deletions never become successful empty cleanup", async () => {
  let deletes = 0;
  let invalid = true;
  const panel = loadPanel({ generation: 1, endpoints: [{ id: "worker-a", role: "worker" }], client: {
    async postWorkerAction(_id, action) {
      if (action === "delete-cache-candidates") { deletes++; return { status: "pending" }; }
      return { status: "completed", candidates: [{ ...candidate, path: invalid ? "tmp/../protected.log" : candidate.path }] };
    }
  } });
  await panel.message({ type: "refresh" });
  const invalidResult = panel.messages.filter(m => m.type === "data").at(-1);
  assert.equal(invalidResult.rows.length, 0);
  assert.equal(invalidResult.scans[0].status, "unavailable");
  invalid = false;
  await panel.message({ type: "refresh" });
  const keys = ["worker-a|simple_cluster/tmp/old.log"];
  await panel.message({ type: "review", keys });
  await panel.message({ type: "confirmFirst", keys });
  await panel.message({ type: "confirmSecond", keys });
  assert.equal(deletes, 1);
  assert.ok(panel.messages.some(m => m.type === "error" && /尚未确认完成/.test(m.message)));
  await panel.message({ type: "confirmSecond", keys });
  assert.equal(deletes, 1);
  panel.close();
});
