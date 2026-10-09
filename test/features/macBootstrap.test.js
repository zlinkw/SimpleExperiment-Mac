const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { registerPreviewUpdater, getUpdateStatus, CHECK_COMMAND, INSTALL_COMMAND } = require("../../dist/mac/Bootstrap");

function fixture(client) {
  const state = new Map(), calls = [], commands = new Map(), subscriptions = [];
  const context = { subscriptions, globalStorageUri: { fsPath: "/unused" }, globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => state.set(key, value) } };
  const vscode = { version: "1.100.0", StatusBarAlignment: { Right: 1 }, extensions: { getExtension: () => ({ packageJSON: { version: "0.1.1" } }) }, commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } }, window: { createStatusBarItem: () => ({ show() {}, dispose() {} }), showInformationMessage: async message => { calls.push(message); }, showErrorMessage: async message => { calls.push(message); } } };
  const updater = registerPreviewUpdater(context, vscode, client);
  return { updater, state, calls, commands, dispose: () => subscriptions.forEach(item => item.dispose()) };
}
test("preview commands exist without business panel, server config or Termius", async () => {
  const f = fixture({ check: async () => { throw Error("offline"); } });
  try { assert.ok(f.commands.has(CHECK_COMMAND)); assert.ok(f.commands.has(INSTALL_COMMAND)); await assert.rejects(f.updater.check(true)); assert.equal(getUpdateStatus().status, "error"); assert.match(getUpdateStatus().message, /检查失败/); assert.ok(f.calls.every(message => !message.includes("已是最新"))); }
  finally { f.dispose(); }
});
test("same preview prompts once across repeated checks and persists that receipt", async () => {
  const manifest = { releaseTag: "preview-v0.1.2", components: [{ extensionId: "simple-local.simple-sftp-mac", version: "0.1.2" }, { extensionId: "simple-local.simple-experiment-mac", version: "0.1.2" }] };
  const f = fixture({ check: async () => ({ manifest, pending: manifest.components }) });
  try { await Promise.all([f.updater.check(), f.updater.check()]); await f.updater.check(); assert.equal(f.calls.length, 1); assert.equal(f.state.get("simpleExperimentMac.preview.notified.preview-v0.1.2"), true); }
  finally { f.dispose(); }
});
test("bootstrap registers updates before loading business code and polls every thirty minutes", () => {
  const source = fs.readFileSync(require("node:path").join(__dirname, "../../src/mac/Bootstrap.ts"), "utf8");
  assert.ok(source.indexOf("updater = registerPreviewUpdater(context, vscode)") < source.indexOf('business = require("../extension")'));
  assert.match(source, /30 \* 60 \* 1000/); assert.match(source, /void updater\.resume\(\)/);
  assert.equal(require("../../package.json").main, "./dist/mac/Bootstrap.js");
});
