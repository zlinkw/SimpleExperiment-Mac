const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const candidate = { path: "simple_cluster/tmp/tmux_logs/old.log", fullPath: "/project/simple_cluster/tmp/tmux_logs/old.log", type: "file", bytes: 12, modifiedAt: 1, purpose: "运行日志", token: "stable" };
const retentionModule = require("../../dist/features/PluginLogRetention.js");
// The production panel context always carries the recomputable two-generation manifest plus the
// live admission holds/blocked rows; without them every managed row is fail-closed preview-only.
const staleIndexFor = logPath => retentionModule.retentionIndex({ schemaVersion: 1, plans: [
  { id: "r1", planFile: "p.yaml", enqueuedAt: "2026-10-01T10:00:00Z", jobs: [{ index: 0, case: "c", seed: 1, attempt: 0, status: "completed", logPath }] },
  { id: "r2", planFile: "p.yaml", enqueuedAt: "2026-10-02T10:00:00Z", jobs: [{ index: 0, case: "c", seed: 1, attempt: 0, status: "completed", logPath: "simple_cluster/tmp/kept-mid.log" }] },
  { id: "r3", planFile: "p.yaml", enqueuedAt: "2026-10-03T10:00:00Z", jobs: [{ index: 0, case: "c", seed: 1, attempt: 0, status: "completed", logPath: "simple_cluster/tmp/kept-new.log" }] },
] }, { caseInsensitive: true });
const openAdmission = { retentionHolds: async () => [], retentionBlocked: async () => [],
  withRetentionLease: async work => work({ assertHeld: async () => undefined }) };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// Mac 适配：面板把每个已确认目标单独交给隔离删除子进程：
//   spawn(process.execPath, [require.resolve("../mac/CacheDelete"), JSON.stringify(approval)], { cwd: 已核验父目录 })。
// 真实执行器要求 darwin/arm64 与 libproc 句柄证明，本单元夹具按同一协议替换子进程：校验两次确认字段、
// 目标绝对路径与 cwd 必须是已核验父目录，然后只删除这一个目标并以退出码 0 结束；绝不合并成整批删除。
// 真实执行器本身由 test/features/macCacheCleanup.test.js 与 macOS 真机验收覆盖。
function macIsolatedDeleteDouble() {
  const state = { spawns: 0, deletions: [], approvals: [] };
  state.stub = { spawn(command, args, options) {
    state.spawns += 1;
    const handlers = {};
    const child = {
      stderr: { on(event, callback) { if (event === "data") handlers.stderrData = callback; } },
      stdout: { on() {} },
      stdin: { on() {}, end() {} },
      unref() {}, ref() {}, kill() {},
      on(event, callback) { handlers[event] = callback; },
    };
    setImmediate(() => {
      let code = 0;
      try {
        assert.equal(String(command), process.execPath, "隔离删除必须用同一 Node 运行时启动子进程");
        assert.match(String(args[0]), /[\\/]CacheDelete\.js$/, "隔离删除子进程必须是 Mac CacheDelete");
        const approval = JSON.parse(String(args[1]));
        assert.equal(approval.confirm, true, "第一次绝对路径确认必须传递到执行器");
        assert.equal(approval.secondConfirmation, true, "第二次绝对路径确认必须传递到执行器");
        assert.equal(approval.confirmedAbsolutePath, approval.fullPath, "两次确认的绝对路径必须与目标一致");
        assert.equal(options && options.cwd, path.dirname(approval.fullPath), "子进程 cwd 必须是已核验的目标父目录");
        state.approvals.push(approval);
        fs.unlinkSync(approval.fullPath);
        state.deletions.push(approval.fullPath);
      } catch (error) {
        code = 1;
        if (handlers.stderrData) handlers.stderrData(String((error && error.stack) || error));
      }
      if (handlers.close) handlers.close(code);
    });
    return child;
  } };
  return state;
}

function loadPanel(context) {
  let handler, dispose, contextChanged, html = "";
  const messages = [], actions = [];
  const webview = { set html(value) { html = value; }, postMessage(value) { messages.push(value); return Promise.resolve(true); },
    onDidReceiveMessage(value) { handler = value; return { dispose() {} }; } };
  const vscode = { window: { createWebviewPanel: () => ({ webview, onDidDispose(callback) { dispose = callback; } }) }, ViewColumn: { Active: 1 },
    // Mac 适配夹具：面板用它定位 Mac 句柄探测脚本，与删除判定无关。
    extensions: { getExtension: () => ({ extensionPath: path.join(__dirname, "..") }) } };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, "../../src/extension/CacheCleanupPanel.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const shim = (id) => id === "vscode" ? vscode
    : id === "../mac/CacheDelete" ? require("../../dist/mac/CacheDelete.js")
    : id === "../features/PluginLogRetention" ? require("../../dist/features/PluginLogRetention.js")
    : id === "node:child_process" && context.childProcessStub ? context.childProcessStub
    : require(id);
  // Mac 适配夹具：补齐沙箱可用的宿主能力（隔离删除子进程的解析路径）。
  shim.resolve = (id) => { try { return require.resolve(id); } catch (error) { return path.join(__dirname, "..", id + ".js"); } };
  vm.runInNewContext(compiled, { require: shim, module, exports: module.exports, Buffer, process, console, AbortController });
  module.exports.openCacheCleanupPanel(() => context, callback => { contextChanged = callback; return { dispose() { contextChanged = undefined; } }; });
  return { messages, actions, source, get html() { return html; }, message: m => handler(m), change: () => contextChanged?.(), close: () => dispose?.() };
}

test("cache review requires two path confirmations before sending a delete action", async () => {
  const actions = [];
  const client = { async postWorkerAction(workerId, action) { actions.push(action); return action === "preview-cache-cleanup" ? { status: "completed", candidates: [candidate] } : { status: "completed", deletedCount: 1 }; } };
  const panel = loadPanel({ client, endpoints: [{ id: "worker-a", role: "worker" }], generation: 1,
    retentionIndex: async () => staleIndexFor(candidate.path), ...openAdmission });
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
  const keys = ["worker-a|simple_cluster/tmp/tmux_logs/old.log"];
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
  const keys = ["worker-a|simple_cluster/tmp/tmux_logs/old.log"];
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
  const panel = loadPanel({ generation: 1, endpoints: [{ id: "worker-a", role: "worker" }],
    retentionIndex: async () => staleIndexFor(candidate.path), ...openAdmission, client: {
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
  const keys = ["worker-a|simple_cluster/tmp/tmux_logs/old.log"];
  await panel.message({ type: "review", keys });
  await panel.message({ type: "confirmFirst", keys });
  await panel.message({ type: "confirmSecond", keys });
  assert.equal(deletes, 1);
  assert.ok(panel.messages.some(m => m.type === "error" && /尚未确认完成/.test(m.message)));
  await panel.message({ type: "confirmSecond", keys });
  assert.equal(deletes, 1);
  panel.close();
});

test("unowned managed files stay preview-only and protection is recomputed before deletion", async () => {
  const os = require("node:os");
  const retention = require("../../dist/features/PluginLogRetention.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "se-panel-protect-"));
  const logDir = path.join(root, "simple_cluster", "tmp", "tmux_logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "stale.log"), "stale");
  fs.writeFileSync(path.join(logDir, "orphan.log"), "unowned managed file");
  fs.writeFileSync(path.join(logDir, "kept.log"), "retained");
  const job = (logPath) => ({ index: 0, case: "c", seed: 1, attempt: 0, logPath });
  const queueStale = { schemaVersion: 1, plans: [
    { ...{ id: "g1", planFile: "p.yaml" }, enqueuedAt: "2026-10-01T10:00:00Z", jobs: [{ ...job("simple_cluster/tmp/tmux_logs/stale.log"), status: "failed" }] },
    { ...{ id: "g2", planFile: "p.yaml" }, enqueuedAt: "2026-10-02T10:00:00Z", jobs: [{ ...job("simple_cluster/tmp/tmux_logs/mid.log"), status: "completed" }] },
    { ...{ id: "g3", planFile: "p.yaml" }, enqueuedAt: "2026-10-03T10:00:00Z", jobs: [{ ...job("simple_cluster/tmp/tmux_logs/kept.log"), status: "completed" }] },
  ] };
  // Same facts, but the stale generation is now the NEWEST run: it becomes protected.
  const queueNewest = { schemaVersion: 1, plans: [
    { ...queueStale.plans[0], enqueuedAt: "2026-10-05T10:00:00Z" }, queueStale.plans[1], queueStale.plans[2],
  ] };
  let currentIndex = retention.retentionIndex(queueStale, { caseInsensitive: true });
  // Mac 适配：确认后的每个目标由面板交给隔离删除子进程（一个目标一次子进程，cwd 为已核验父目录，删除前复核指纹与两次绝对路径确认）。
  // 夹具按同一协议替换子进程并真实删除该目标；子进程内的 darwin/arm64 与 libproc 句柄证明由 Mac 契约测试与真机验收覆盖。
  const macDelete = macIsolatedDeleteDouble();
  const context = { generation: 1, endpoints: [], client: {}, localRoot: root, retentionIndex: async () => currentIndex,
    ...openAdmission, childProcessStub: macDelete.stub };
  const panel = loadPanel(context);
  await panel.message({ type: "refresh" });
  const data = panel.messages.filter(m => m.type === "data").at(-1);
  const byPath = new Map(data.rows.map(row => [String(row.path), row]));
  assert.equal(byPath.get("simple_cluster/tmp/tmux_logs/stale.log")?.previewOnly, undefined);
  assert.equal(byPath.get("simple_cluster/tmp/tmux_logs/orphan.log")?.previewOnly, true);
  assert.match(String(byPath.get("simple_cluster/tmp/tmux_logs/orphan.log")?.purpose || ""), /仅预览|不会删除/);
  // Protected generations are never listed, and a read-only scan never writes.
  assert.equal(byPath.has("simple_cluster/tmp/tmux_logs/kept.log"), false);
  assert.equal(fs.readFileSync(path.join(logDir, "orphan.log"), "utf8"), "unowned managed file");
  // The delete guard refuses an unowned preview-only row on all three stages.
  const orphanKeys = ["local|simple_cluster/tmp/tmux_logs/orphan.log"];
  await panel.message({ type: "review", keys: orphanKeys });
  await panel.message({ type: "confirmFirst", keys: orphanKeys });
  await panel.message({ type: "confirmSecond", keys: orphanKeys });
  assert.equal(fs.existsSync(path.join(logDir, "orphan.log")), true);
  assert.ok(panel.messages.some(m => m.type === "error" && /已跳过/.test(m.message) && /仅预览归属/.test(m.message)));
  // New reference AFTER the preview: recomputed protection skips the row at execution time.
  currentIndex = retention.retentionIndex(queueNewest, { caseInsensitive: true });
  const staleKeys = ["local|simple_cluster/tmp/tmux_logs/stale.log"];
  await panel.message({ type: "review", keys: staleKeys });
  await panel.message({ type: "confirmFirst", keys: staleKeys });
  await panel.message({ type: "confirmSecond", keys: staleKeys });
  assert.equal(fs.existsSync(path.join(logDir, "stale.log")), true);
  assert.ok(panel.messages.some(m => m.type === "error" && /已跳过/.test(m.message)));
  // Genuinely stale rows still delete through the confirmed two-step flow.
  currentIndex = retention.retentionIndex(queueStale, { caseInsensitive: true });
  await panel.message({ type: "refresh" });
  await panel.message({ type: "review", keys: staleKeys });
  await panel.message({ type: "confirmFirst", keys: staleKeys });
  await panel.message({ type: "confirmSecond", keys: staleKeys });
  assert.equal(fs.existsSync(path.join(logDir, "stale.log")), false);
  assert.deepEqual(macDelete.deletions, [path.join(logDir, "stale.log")]);
  // 每个已确认目标一次隔离子进程；本轮只有一个确认目标，因此恰好一次，且绝不整批合并删除。
  assert.equal(macDelete.spawns, 1);
  assert.equal(fs.existsSync(path.join(logDir, "kept.log")), true);
  assert.equal(fs.existsSync(path.join(logDir, "orphan.log")), true);
  panel.close();
});

test("local scan deletes only exact-path facts and previews ambiguous console names regardless of age", async () => {
  const os = require("node:os");
  const retention = require("../../dist/features/PluginLogRetention.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "se-panel-retention-"));
  const logDir = path.join(root, "simple_cluster", "tmp", "tmux_logs");
  const consoleDir = path.join(root, "simple_cluster", "console_logs", "p");
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(consoleDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "command-old1.log"), "oldest generation");
  fs.writeFileSync(path.join(logDir, "command-new.log"), "current generation");
  fs.writeFileSync(path.join(consoleDir, "exp-0__case-c__seed-1__worker-w__gpu-0__status-done__session-sess-old.log"), "old console");
  fs.writeFileSync(path.join(consoleDir, "exp-0__case-c__seed-1__worker-w__gpu-0__status-done__session-sess-c.log"), "retained console");
  // Everything is 30 days old: the removed 7-day cutoff must not hide stale rows, and retained
  // generations must stay protected by ownership, not by age.
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  for (const file of [path.join(logDir, "command-old1.log"), path.join(logDir, "command-new.log"),
    path.join(consoleDir, "exp-0__case-c__seed-1__worker-w__gpu-0__status-done__session-sess-old.log"),
    path.join(consoleDir, "exp-0__case-c__seed-1__worker-w__gpu-0__status-done__session-sess-c.log")])
    fs.utimesSync(file, old, old);
  const queue = { schemaVersion: 1, plans: [
    { id: "c1", planFile: "p.yaml", enqueuedAt: "2026-10-01T10:00:00Z", jobs: [{ index: 0, case: "c", seed: 1, attempt: 0, status: "completed", logPath: "simple_cluster/tmp/tmux_logs/command-old1.log", tmuxSession: "sess-old" }] },
    { id: "c2", planFile: "p.yaml", enqueuedAt: "2026-10-02T10:00:00Z", jobs: [{ index: 0, case: "c", seed: 1, attempt: 0, status: "completed", logPath: "simple_cluster/tmp/tmux_logs/command-b.log", tmuxSession: "sess-b" }] },
    { id: "c3", planFile: "p.yaml", enqueuedAt: "2026-10-03T10:00:00Z", jobs: [{ index: 0, case: "c", seed: 1, attempt: 0, status: "completed", logPath: "simple_cluster/tmp/tmux_logs/command-c.log", tmuxSession: "sess-c" }] },
    { id: "c4", planFile: "p.yaml", enqueuedAt: "2026-10-04T10:00:00Z", jobs: [{ index: 0, case: "c", seed: 1, attempt: 0, status: "completed", logPath: "simple_cluster/tmp/tmux_logs/command-new.log", tmuxSession: "sess-live" }] },
  ] };
  const index = retention.retentionIndex(queue, { caseInsensitive: true });
  const context = { generation: 1, endpoints: [], client: {}, localRoot: root, retentionIndex: async () => index, ...openAdmission };
  const panel = loadPanel(context);
  await panel.message({ type: "refresh" });
  const data = panel.messages.filter(m => m.type === "data").at(-1);
  const paths = data.rows.map(row => String(row.path)).sort().join(",");
  // The shared per-plan scheduler log stays reference-counted (c3/c4 are retained), so only the two
  // owned stale files surface from this fixture.
  assert.equal(paths, "simple_cluster/console_logs/p/exp-0__case-c__seed-1__worker-w__gpu-0__status-done__session-sess-old.log,simple_cluster/tmp/tmux_logs/command-old1.log");
  const exact = data.rows.find(row => row.path.endsWith("command-old1.log"));
  const ambiguous = data.rows.find(row => row.path.includes("console_logs/"));
  assert.equal(exact.retentionStale, true);
  assert.equal(ambiguous.previewOnly, true);
  assert.match(exact.purpose, /两代保留窗口/);
  assert.match(ambiguous.purpose, /仅预览|不会删除/);
  panel.close();
});

test("production blocked provider exposes local-only leaving logs and releases admission after two confirmations", async () => {
  const fsp = require("node:fs/promises"), crypto = require("node:crypto"), os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "se-local-retention-admission-"));
  const oldPath = "simple_cluster/console_logs/old.log", newPath = "simple_cluster/console_logs/new.log";
  const shared = "simple_cluster/tmp/cluster_scheduler/p_yaml.log";
  for (const name of [oldPath, newPath, shared]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), name);
  }
  const queue = { schemaVersion: 1, plans: [oldPath, newPath].map((logPath, index) => ({
    id: "run-" + index, planFile: "p.yaml", enqueuedAt: `2026-10-0${index + 1}T10:00:00Z`,
    jobs: [{ index: 0, case: "c", seed: 1, attempt: 0, status: "completed", workerId: "w1", logPath }],
  })) };
  // Extract the actual production provider and admission methods, not a hand-written blocked list.
  const legacy = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
  const helpers = legacy.slice(legacy.indexOf("const RETENTION_ADMISSION_LEAF"), legacy.indexOf("function workspaceWriteStatusText"));
  const methods = legacy.slice(legacy.indexOf("async evaluateRetentionWindow(planKey)"), legacy.indexOf("async runActionCommandCore("));
  const provider = legacy.slice(legacy.indexOf("async clearCacheFromUi()"), legacy.indexOf("async observeRetentionPaths(workerId, paths)"));
  let context;
  const realm = { fs: fsp, path, crypto, process, PluginLogRetention: retentionModule,
    workspaceRoot: () => root, uniqueStrings: rows => [...new Set(rows)], pluginCopyBlockedSlots: new Set(),
    openCacheCleanupPanel: getContext => { context = getContext(); } };
  vm.createContext(realm);
  vm.runInContext(ts.transpileModule(helpers + "\nclass Host {\n" + methods + provider + "\n}\nthis.Host=Host;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, realm);
  const host = new realm.Host();
  host.retentionBlockedWindows = new Map([["p.yaml", []]]);
  host.loadPlanOutputRetentionQueue = async () => queue;
  host.enabledWorkerConfigs = () => [{ id: "w1" }];
  host.projectContextGeneration = 1;
  host.cacheCleanupContextChanged = { event() {} };
  host.hostOperationLease = { acquire: async () => ({ assertHeld: async () => {}, release: async () => {} }) };
  host.client = { postWorkerAction: async () => ({ status: "completed", candidates: [] }) };
  let remoteFailed = false;
  host.observeRetentionPaths = async (_worker, paths) => {
    if (remoteFailed) throw new Error("Worker disconnected");
    return { status: "completed", observations: paths.map(p => ({ path: p, state: "absent" })) };
  };
  await host.clearCacheFromUi();
  const decision = await host.evaluateRetentionWindow("p.yaml");
  assert.equal(decision.allowed, false);
  assert.deepEqual(Array.from(decision.pending[0].paths), [oldPath]);
  const blocked = await context.retentionBlocked();
  assert.deepEqual(Array.from(blocked[0].workers), ["w1", "local"]);
  assert.equal(blocked.some(row => row.path === shared), false, "retained shared references never exit");
  remoteFailed = true;
  assert.equal((await context.retentionBlocked()).length, 0, "unknown Worker state cannot authorize local cleanup");
  remoteFailed = false;
  queue.plans[0].jobs[0].status = "running";
  assert.equal((await context.retentionBlocked()).length, 0, "active leaving generation stays protected");
  queue.plans[0].jobs[0].status = "completed";
  // Mac 适配：同 case A，按 Mac 隔离子进程协议替换执行器（真实删除单个目标，一次一个）。
  const macDeleteB = macIsolatedDeleteDouble();
  context.childProcessStub = macDeleteB.stub;
  const panel = loadPanel(context), keys = ["local|" + oldPath];
  try {
    const claims = path.join(root, "simple_cluster/.simple-retention-admission.json");
    fs.writeFileSync(claims, JSON.stringify({ claims: [{ planFile: "p.yaml", incomingRun: "held",
      taskKeys: [decision.pending[0].taskKey], pid: process.pid, hostNonce: "foreign-window" }] }));
    await panel.message({ type: "refresh" });
    const heldRows = panel.messages.filter(m => m.type === "data").at(-1).rows;
    assert.equal(heldRows.some(row => row.path === oldPath && !row.previewOnly), false, "live claims prevent selection");
    fs.writeFileSync(claims, JSON.stringify({ claims: [] }));
    await panel.message({ type: "refresh" });
    const rows = panel.messages.filter(m => m.type === "data").at(-1).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, oldPath);
    assert.equal(rows[0].workerId, "local");
    assert.equal(rows[0].previewOnly, undefined);
    await panel.message({ type: "review", keys });
    await panel.message({ type: "confirmFirst", keys });
    assert.equal(fs.existsSync(path.join(root, oldPath)), true);
    assert.equal(macDeleteB.spawns, 0);
    await panel.message({ type: "confirmSecond", keys });
    assert.equal(fs.existsSync(path.join(root, oldPath)), false);
    assert.equal(macDeleteB.spawns, 1);
    assert.equal((await host.evaluateRetentionWindow("p.yaml")).allowed, true);
    for (const name of [newPath, shared]) assert.equal(fs.readFileSync(path.join(root, name), "utf8"), name);
  } finally { panel.close(); }
});
