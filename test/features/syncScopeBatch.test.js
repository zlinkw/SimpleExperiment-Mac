const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const vm = require("node:vm");
const { expandSyncScopeBatchSelection, runSyncScopeBatch, syncScopeIssueSignature } = require("../../dist/features/SyncScopeBatch.js");

test("issue signature groups equal-content layouts without comparing unrelated file hashes", () => {
  const ids = ["local", "worker-a", "worker-b"];
  const issue = (local, a, b) => ({ state: "different", versions: Object.fromEntries(
    [["local", local], ["worker-a", a], ["worker-b", b]].filter(([, hash]) => hash).map(([id, sha256]) => [id, { sha256 }])) });
  assert.equal(syncScopeIssueSignature(issue("a", "b", "b"), ids), syncScopeIssueSignature(issue("x", "y", "y"), ids));
  assert.notEqual(syncScopeIssueSignature(issue("a", "b", "b"), ids), syncScopeIssueSignature(issue("a", "a", "b"), ids));
  assert.equal(syncScopeIssueSignature(issue(null, "a", "a"), ids), "missing|1|1;-|-|-");
  const planOnA = issue("a", "b", "b");
  const planOnB = issue("a", "b", "b");
  planOnA.versions["worker-a"].latest = "plan";
  planOnB.versions["worker-b"].latest = "plan";
  assert.notEqual(syncScopeIssueSignature(planOnA, ids), syncScopeIssueSignature(planOnB, ids));
  assert.equal(syncScopeIssueSignature({ ...issue("a", "b", "b"), unverified: true }, ids), undefined);
  assert.equal(syncScopeIssueSignature({ ...issue("a", "b", "b"), copies: {} }, ids), undefined);
});

test("batch selection expands only branches containing exclusions", async () => {
  const calls = [];
  const tree = {
    ".": [{ path: "code", name: "code", directory: true }, { path: "artifacts", name: "artifacts", directory: true }],
    code: [{ path: "code/a.py", name: "a.py", directory: false }, { path: "code/b.py", name: "b.py", directory: false }],
    artifacts: [{ path: "artifacts/keep", name: "keep", directory: true }, { path: "artifacts/drop", name: "drop", directory: true }],
  };
  const selected = await expandSyncScopeBatchSelection(["."], ["artifacts/drop", "code/b.py"], async (parent) => {
    calls.push(parent);
    return tree[parent] || [];
  });
  assert.deepEqual(selected.map((item) => item.path), ["artifacts/keep", "code/a.py"]);
  assert.deepEqual(calls.sort(), [".", "artifacts", "code"]);
});

test("visible selected files reach batch review without repeating remote directory reads", async () => {
  const visible = Array.from({ length: 500 }, (_, index) => ({ path: `results/${index}.csv`, name: `${index}.csv`, directory: false, locations: ["w2", "w3"] }));
  const result = await expandSyncScopeBatchSelection(visible.map((entry) => entry.path), [], async () => {
    throw new Error("unexpected remote directory read");
  }, () => {}, visible);
  assert.equal(result.length, 500);
});

test("batch runner keeps at most two paths in flight and reports failures", async () => {
  let active = 0;
  let maxActive = 0;
  const release = [];
  const done = runSyncScopeBatch([1, 2, 3], async (item) => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise((resolve) => release.push(resolve));
    active--;
    if (item === 2) throw new Error("worker failed");
  }, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 2);
  release.splice(0).forEach((resolve) => resolve());
  await new Promise((resolve) => setImmediate(resolve));
  release.splice(0).forEach((resolve) => resolve());
  const result = await done;
  assert.deepEqual(result.map((row) => row.error || "ok"), ["ok", "worker failed", "ok"]);
});

test("batch runner stops scheduling deletions after a path safety failure", async () => {
  const attempted = [];
  const result = await runSyncScopeBatch(["a", "b", "c", "d"], async (item) => {
    attempted.push(item);
    if (item === "a") throw new Error("PARENT_CD_FAILED");
  }, () => {}, 1, (message) => message.includes("PARENT_CD_FAILED"));
  assert.deepEqual(attempted, ["a"]);
  assert.match(result[1].error, /未执行/);
});

test("sync scope webview batch controls parse as JavaScript", () => {
  const panel = { webview: { html: "", onDidReceiveMessage() {} } };
  const original = Module._load;
  Module._load = function (request, ...args) {
    return request === "vscode" ? { window: { createWebviewPanel: () => panel }, ViewColumn: { Active: 1 } } : original.call(this, request, ...args);
  };
  let openSyncScopeTree;
  try { ({ openSyncScopeTree } = require("../../dist/features/SyncScopeTree.js")); }
  finally { Module._load = original; }
  openSyncScopeTree("test", []);
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new vm.Script(script);
  assert.match(panel.webview.html, /批量同步勾选项/);
  assert.match(panel.webview.html, /批量删除勾选项/);
  assert.match(panel.webview.html, /仅显示异常/);
  assert.match(panel.webview.html, /筛选同类/);
});

test("anomaly filter selects one uniform folder for batch operation", () => {
  const panel = { webview: { html: "", onDidReceiveMessage() {} } };
  const original = Module._load;
  Module._load = function (request, ...args) {
    return request === "vscode" ? { window: { createWebviewPanel: () => panel }, ViewColumn: { Active: 1 } } : original.call(this, request, ...args);
  };
  delete require.cache[require.resolve("../../dist/features/SyncScopeTree.js")];
  try { require("../../dist/features/SyncScopeTree.js").openSyncScopeTree("test", []); }
  finally { Module._load = original; }
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const element = () => ({ style: {}, scrollTop: 0, children: [], appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; }, scrollIntoView() {} });
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  const sent = [];
  let onMessage;
  vm.runInNewContext(script, { document, window: { addEventListener(_type, callback) { onMessage = callback; } },
    acquireVsCodeApi: () => ({ postMessage(message) { sent.push(message); } }) });
  const send = (message) => onMessage({ data: message });
  send({ type: "init", roots: [{ id: "local", label: "本机 ↔ Worker", detail: "", selected: [], rootSelectable: true, excludable: true }] });
  const copy = { modifiedAtMs: 1, present: 2, missing: 0, needsSync: 2, conflict: 0, unverified: 0 };
  const folder = { state: "different", detail: "同步范围内 2 个文件 · 0 一致 · 2 待更新或冲突 · 0 仅 Worker 一致 · 0 未确认", copies: { local: copy, worker: copy } };
  const file = (local, worker) => ({ state: "different", detail: "本机 最新版 · worker 待更新", issueSignature: "1|2",
    versions: { local: { sha256: local, modifiedAtMs: 1 }, worker: { sha256: worker, modifiedAtMs: 2 } } });
  send({ type: "status", rootId: "local", path: ".", refreshedAt: "now", statuses: { ".": folder, configs: folder,
    "configs/a.yaml": file("a", "b"), "configs/b.yaml": file("c", "d") } });
  elements.get("filterIssues").onclick();
  elements.get("selectFiltered").onclick();
  elements.get("batchSync").onclick();
  const request = sent.findLast((message) => message.type === "batchSync");
  assert.deepEqual(Array.from(request.paths), ["configs"]);
  assert.deepEqual(Array.from(request.excluded), []);
});
