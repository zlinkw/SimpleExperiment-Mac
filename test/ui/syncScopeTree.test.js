const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const vm = require("node:vm");
let handler;
const sent = [];
const panel = { webview: { html: "", postMessage: async (message) => { sent.push(message); }, onDidReceiveMessage: (fn) => { handler = fn; } } };
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "vscode") return { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } };
  return original.call(this, name, ...args);
};
const { openSyncScopeTree } = require("../../dist/features/SyncScopeTree.js");
Module._load = original;

test("scope Webview renders collapsible checkboxes, status colors and refresh", async () => {
  let saved;
  let refreshed;
  openSyncScopeTree("范围", [{ id: "workers", label: "Workers", detail: "完整项目", selected: ["."], list: async () => [{ name: "data", path: "data", directory: true }], refresh: async (relative) => { refreshed = relative; return { data: { state: "same", detail: "一致" } }; }, save: async (paths) => { saved = paths; } }]);
  assert.match(panel.webview.html, /type='checkbox'/);
  assert.match(panel.webview.html, /paddingLeft=\(depth\*18\)/);
  assert.match(panel.webview.html, /刷新同步状态/);
  assert.doesNotMatch(panel.webview.html, /setInterval/);
  assert.match(panel.webview.html, /单击展开/);
  assert.match(panel.webview.html, /\.different\{/);
  assert.match(panel.webview.html, /\.remote-only\{/);
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(script);
  new vm.Script(script[1]);
  await handler({ type: "ready" });
  assert.equal(sent.at(-1).refreshIntervalMs, undefined);
  await handler({ type: "list", id: "1", rootId: "workers", path: "." });
  assert.equal(sent.at(-1).entries[0].path, "data");
  await handler({ type: "refresh", id: "2", rootId: "workers", path: "data" });
  assert.equal(refreshed, "data");
  assert.equal(sent.at(-1).path, "data");
  assert.equal(sent.at(-1).statuses.data.state, "same");
  await handler({ type: "save", id: "3", rootId: "workers", paths: ["data"] });
  assert.deepEqual(saved, ["data"]);
  let removed;
  openSyncScopeTree("范围", [{ id: "workers", label: "Workers", detail: "项目", selected: ["."], list: async () => [], refresh: async () => ({}), save: async () => {}, removeAllWorkers: async (path, directory) => { removed = { path, directory }; return true; } }]);
  await handler({ type: "removeAllWorkers", id: "4", rootId: "workers", path: "old.bin", directory: false });
  assert.deepEqual(removed, { path: "old.bin", directory: false });
  assert.equal(sent.at(-1).type, "actionDone");
});

test("scope Webview requests visible-file status and replaces waiting badges", () => {
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(script);
  class Element {
    constructor() { this.children = []; this.style = {}; this.textContent = ""; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    click() { this.onclick?.(); }
  }
  const elements = new Map();
  const document = {
    hidden: false,
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); },
  };
  const messages = [];
  let onMessage;
  vm.runInNewContext(script[1], {
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    document,
    window: { addEventListener: (_type, callback) => { onMessage = callback; } },
  });
  assert.equal(messages.at(-1).type, "ready");
  onMessage({ data: { type: "init", roots: [{ id: "workers", label: "Workers", detail: "完整项目", selected: ["."], rootSelectable: true }, { id: "local", label: "Local", detail: "本机同步", selected: [], rootSelectable: false }] } });
  assert.equal(messages.at(-1).type, "list");
  onMessage({ data: { type: "children", rootId: "workers", path: ".", entries: [{ name: "data", path: "data", directory: true, locations: ["w1"] }, { name: "README.md", path: "README.md", directory: false }] } });
  assert.equal(messages.at(-1).type, "list");
  assert.equal(typeof elements.get("tree").children[1].children.find((child) => child.textContent === "📁 data").onclick, "function");
  elements.get("refresh").onclick();
  assert.equal(messages.at(-1).type, "refresh");
  assert.equal(messages.at(-1).path, ".");
  const hash = "a".repeat(64);
  onMessage({ data: { type: "status", rootId: "workers", path: ".", statuses: { ".": { state: "same", detail: "共 2 个文件 · 2 一致" }, "data": { state: "same", detail: "共 1 个文件 · 1 一致" }, "README.md": { state: "same", detail: "本机 同版 · w1 最新版", versions: { w1: { sha256: hash, modifiedAtMs: 1000, latest: "candidate" } } } }, refreshedAt: "now" } });
  assert.match(elements.get("status").textContent, /已校验/);
  const folderBadge = elements.get("tree").children[1].children.find((child) => child.className === "badge same");
  assert.equal(folderBadge?.textContent, "");
  assert.equal(elements.get("tree").children[1].children.find((child) => child.textContent === "📁 data")?.className, "name same");
  assert.equal(elements.get("tree").children[2].children.find((child) => child.className === "badge same")?.textContent, "");
  assert.equal(elements.get("tree").children[2].children.find((child) => child.textContent === "📄 README.md")?.className, "name same");
  elements.get("tree").children[1].children.find((child) => child.textContent === "版本与操作").onclick();
  assert.equal(elements.get("tree").children[2].children[0].children[0].disabled, false);
  elements.get("tree").children[3].children.find((child) => child.textContent === "版本与操作").onclick();
  const version = elements.get("tree").children[3].children[0];
  assert.doesNotMatch(version.textContent, new RegExp(hash));
  assert.match(version.textContent, /1970-01-01 [0-9]{2}:[0-9]{2}:[0-9]{2}/);
  assert.equal(version.children[0].textContent, "以此版同步到其他位置");
  assert.equal(version.children[1].textContent, "删除");
  version.children[1].onclick();
  assert.deepEqual({ type: messages.at(-1).type, path: messages.at(-1).path, endpointId: messages.at(-1).endpointId }, { type: "remove", path: "README.md", endpointId: "w1" });
  assert.equal(elements.get("status").className, "busy");
  const actionId = messages.at(-1).id;
  onMessage({ data: { type: "actionProgress", id: actionId, sequence: 1, rootId: "workers", path: "README.md", stage: "正在删除 w1" } });
  assert.match(elements.get("status").textContent, /正在删除 w1/);
  onMessage({ data: { type: "actionProgress", id: actionId, sequence: 0, rootId: "workers", path: "README.md", stage: "旧进度" } });
  assert.doesNotMatch(elements.get("status").textContent, /旧进度/);
  onMessage({ data: { type: "actionCancelled", rootId: "workers", path: "README.md" } });
  assert.equal(elements.get("status").className, "");
  onMessage({ data: { type: "status", rootId: "workers", path: ".", statuses: { "data": { state: "remote-only", detail: "同步范围内 2 个文件 · 1 一致 · 0 待更新或冲突 · 1 仅 Worker 一致 · 0 未确认", copies: { local: { modifiedAtMs: 0, missing: 1, needsSync: 0, conflict: 0, unverified: 0 }, w1: { modifiedAtMs: 2000, missing: 0, needsSync: 0, conflict: 0, unverified: 0 } } }, "README.md": { state: "different", detail: "Plan 归属：w1 · 本机 缺失 · w1 最新版 · w2 待更新", versions: { w1: { sha256: hash, modifiedAtMs: 2000, latest: "plan" }, w2: { sha256: "b".repeat(64), modifiedAtMs: 1000 } } } }, refreshedAt: "now" } });
  assert.equal(elements.get("tree").children[1].children.find((child) => child.textContent === "📁 data")?.className, "name remote-only");
  assert.match(elements.get("tree").children[1].children.find((child) => child.className === "badge remote-only")?.textContent, /本机 全部缺失\nw1 1970-01-01 [0-9]{2}:[0-9]{2}:[0-9]{2}/);
  assert.equal(elements.get("tree").children[2].children.find((child) => child.textContent === "📄 README.md")?.className, "name different");
  const copies = elements.get("tree").children[2].children.find((child) => child.className === "badge different")?.children.map((child) => child.textContent).join(" · ");
  assert.match(copies, /w1 .*1970.*Plan 最新运行/);
  assert.match(copies, /w2 .*1970.*需同步/);
  assert.doesNotMatch(copies, new RegExp(hash));
  elements.get("tree").children[1].children.find((child) => child.textContent === "版本与操作").onclick();
  assert.equal(elements.get("tree").children[2].children.find((child) => child.textContent === "删除所有 Worker 副本")?.textContent, "删除所有 Worker 副本");
  assert.equal(elements.get("tree").children[2].children.find((child) => child.textContent === "本机 · 全部缺失")?.children.length, 0);
  elements.get("tree").children[1].children.find((child) => child.textContent === "收起").onclick();
  onMessage({ data: { type: "status", rootId: "workers", path: ".", statuses: { "data": { state: "unknown", detail: "1 未确认", unverified: true } }, refreshedAt: "now" } });
  onMessage({ data: { type: "children", rootId: "workers", path: ".", entries: [{ name: "data", path: "data", directory: true, locations: ["w1"] }, { name: "README.md", path: "README.md", directory: false }, { name: "giml", path: "giml", directory: true, locations: ["local", "w1"] }] } });
  const emptyFolder = elements.get("tree").children.find((row) => row.children.some((child) => child.textContent === "📁 giml"));
  assert.equal(emptyFolder?.children.find((child) => child.className === "badge unknown")?.textContent, "目录内无可校验文件");
  elements.get("tree").children[1].children.find((child) => child.textContent === "版本与操作").onclick();
  const folderVersions = elements.get("tree").children[2];
  assert.equal(folderVersions.children[0].children[0].disabled, true);
  elements.get("tabs").children[1].onclick();
  assert.deepEqual({ type: messages.at(-1).type, rootId: messages.at(-1).rootId, path: messages.at(-1).path }, { type: "list", rootId: "local", path: "." });
});

test("deleting one nested file keeps folders expanded and refreshes only its parent", () => {
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(script);
  class Element {
    constructor() { this.children = []; this.style = {}; this.textContent = ""; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    click() { this.onclick?.(); }
  }
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); },
  };
  const messages = [];
  let onMessage;
  vm.runInNewContext(script[1], {
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    document,
    window: { addEventListener: (_type, callback) => { onMessage = callback; } },
  });
  onMessage({ data: { type: "init", roots: [{ id: "workers", label: "Workers", detail: "项目", selected: ["."], rootSelectable: true }] } });
  const folder = { name: "results", path: "results", directory: true, locations: ["w1"] };
  onMessage({ data: { type: "children", rootId: "workers", path: ".", entries: [folder] } });
  const label = elements.get("tree").children[1].children.find((child) => child.textContent === "📁 results");
  assert.equal(typeof label.onclick, "function");
  label.onclick();
  assert.equal(elements.get("tree").children[1].children[0].textContent, "▾");
  assert.equal(elements.get("tree").children[2].textContent, "读取中…");
  assert.deepEqual({ type: messages.at(-1).type, path: messages.at(-1).path }, { type: "list", path: "results" });
  onMessage({ data: { type: "children", rootId: "workers", path: "results", entries: [{ name: "old.bin", path: "results/old.bin", directory: false, locations: ["w1", "w2"] }] } });
  assert.equal(messages.at(-1).type, "list");
  elements.get("tree").children[2].children.find((child) => child.textContent === "版本与操作").onclick();
  const removeAll = elements.get("tree").children[3].children.find((child) => child.textContent === "删除所有 Worker 副本");
  assert.equal(typeof removeAll.onclick, "function");
  removeAll.onclick();
  assert.deepEqual({ type: messages.at(-1).type, path: messages.at(-1).path }, { type: "removeAllWorkers", path: "results/old.bin" });
  onMessage({ data: { type: "actionDone", rootId: "workers", path: "results/old.bin", action: "remove", directory: false } });
  assert.deepEqual({ type: messages.at(-1).type, path: messages.at(-1).path }, { type: "list", path: "results" });
  onMessage({ data: { type: "children", rootId: "workers", path: "results", entries: [] } });
  assert.deepEqual({ type: messages.at(-1).type, path: messages.at(-1).path }, { type: "refresh", path: "results" });
  const expanded = elements.get("tree").children[1].children[0];
  assert.equal(expanded.textContent, "▾");
  onMessage({ data: { type: "status", rootId: "workers", path: "results", statuses: { results: { state: "same", detail: "目录为空" } }, refreshedAt: "now" } });
  assert.equal(messages.at(-1).path, "results");
  assert.equal(elements.get("tree").children[1].children[0].textContent, "▾");
});

test("next conflict expands ancestors and scrolls to the conflicting file", () => {
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  let scrollCalls = 0;
  class Element {
    constructor() { this.children = []; this.style = {}; this.textContent = ""; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; this.scrollTop = 0; }
    scrollIntoView() { this.scrolled = true; scrollCalls++; }
  }
  const elements = new Map();
  const messages = [];
  let onMessage;
  vm.runInNewContext(script[1], {
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement() { return new Element(); } },
    window: { addEventListener: (_type, callback) => { onMessage = callback; } },
  });
  onMessage({ data: { type: "init", roots: [{ id: "workers", label: "Workers", detail: "项目", selected: ["."] }] } });
  onMessage({ data: { type: "children", rootId: "workers", path: ".", entries: [{ name: "results", path: "results", directory: true }] } });
  onMessage({ data: { type: "status", rootId: "workers", path: ".", statuses: { results: { state: "different", detail: "1 冲突" }, "results/a.bin": { state: "different", detail: "冲突" } }, refreshedAt: "now" } });
  elements.get("nextConflict").onclick();
  assert.deepEqual({ type: messages.at(-1).type, path: messages.at(-1).path }, { type: "list", path: "results" });
  onMessage({ data: { type: "children", rootId: "workers", path: "results", entries: [{ name: "a.bin", path: "results/a.bin", directory: false }] } });
  assert.equal(elements.get("tree").children[1].children[0].textContent, "▾");
  assert.equal(elements.get("tree").children[2].scrolled, true);
  assert.match(elements.get("tree").children[2].className, /focus-conflict/);
  assert.equal(messages.at(-1).type, "list");
  assert.equal(scrollCalls, 1);
  elements.get("tree").scrollTop = 250;
  const unrelatedBox = elements.get("tree").children[1].children[1];
  unrelatedBox.checked = true;
  unrelatedBox.onchange();
  assert.equal(scrollCalls, 1);
  assert.equal(elements.get("tree").scrollTop, 250);
  assert.match(elements.get("tree").children[2].className, /focus-conflict/);
  elements.get("nextConflict").onclick();
  assert.equal(scrollCalls, 2);
});

test("local root select all allows excluding a nested artifact directory", () => {
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  class Element {
    constructor() { this.children = []; this.style = {}; this.textContent = ""; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    click() { this.onclick?.(); }
  }
  const elements = new Map();
  const messages = [];
  let onMessage;
  vm.runInNewContext(script[1], {
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement() { return new Element(); } },
    window: { addEventListener: (_type, callback) => { onMessage = callback; } },
  });
  onMessage({ data: { type: "init", roots: [{ id: "local", label: "本机", detail: "", selected: [], rootSelectable: true, excludable: true }] } });
  onMessage({ data: { type: "children", rootId: "local", path: ".", entries: [{ name: "configs", path: "configs", directory: true, selectable: true }, { name: "artifacts", path: "artifacts", directory: true, selectable: true }] } });
  const rootBox = elements.get("tree").children[0].children[1];
  rootBox.checked = true;
  rootBox.onchange();
  assert.equal(elements.get("tree").children[0].children[1].checked, true);
  assert.match(elements.get("tree").children[1].className, /transfer-scope/);
  assert.match(elements.get("tree").children[2].className, /transfer-scope/);
  elements.get("tree").children[2].children[2].onclick();
  onMessage({ data: { type: "children", rootId: "local", path: "artifacts", entries: [{ name: "model_cache", path: "artifacts/model_cache", directory: true, selectable: true }] } });
  const artifactBox = elements.get("tree").children[3].children[1];
  artifactBox.checked = false;
  artifactBox.onchange();
  assert.equal(elements.get("tree").children[0].children[1].indeterminate, true);
  assert.doesNotMatch(elements.get("tree").children[3].className, /transfer-scope/);
  elements.get("save").onclick();
  assert.deepEqual([...messages.at(-1).paths], ["artifacts", "configs"]);
  assert.deepEqual([...messages.at(-1).excluded], ["artifacts/model_cache"]);
});
