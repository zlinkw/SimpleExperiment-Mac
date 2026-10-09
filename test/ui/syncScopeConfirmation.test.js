const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const vm = require("node:vm");

let panel;
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "vscode") return { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } };
  return original.call(this, name, ...args);
};
const { confirmSyncScopePaths } = require("../../dist/features/SyncScopeConfirmation.js");
Module._load = original;

function createPanel() {
  const messages = [];
  panel = {
    webview: { html: "", postMessage: async (message) => { messages.push(message); }, onDidReceiveMessage: (callback) => { panel.receive = callback; } },
    onDidDispose: (callback) => { panel.onDispose = callback; },
    dispose: () => { panel.onDispose(); },
  };
  return messages;
}

test("long paths are fully visible and require two distinct confirmations", async () => {
  const messages = createPanel();
  const longPath = "/data/" + "very-long-directory/".repeat(20) + "checkpoint<final>.bin";
  const decision = confirmSyncScopePaths("删除全部", "永久删除", [{ label: "nwpu5", path: longPath }], "永久删除全部");
  assert.match(panel.webview.html, /overflow-wrap:anywhere/);
  assert.match(panel.webview.html, /max-height:55vh;overflow:auto/);
  assert.ok(panel.webview.html.includes(longPath.replace("<", "&lt;").replace(">", "&gt;")));
  assert.doesNotMatch(panel.webview.html, /checkpoint<final>/);
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(script);
  new vm.Script(script[1]);
  panel.receive({ type: "confirm" });
  assert.deepEqual(messages, []);
  panel.receive({ type: "reviewed" });
  assert.equal(messages.at(-1).type, "secondStage");
  panel.receive({ type: "confirm" });
  assert.equal(await decision, true);
});

test("closing path preview cancels the operation", async () => {
  createPanel();
  const decision = confirmSyncScopePaths("删除", "核对路径", [{ label: "nwpu2", path: "/data/project/file" }], "永久删除");
  panel.dispose();
  assert.equal(await decision, false);
});
