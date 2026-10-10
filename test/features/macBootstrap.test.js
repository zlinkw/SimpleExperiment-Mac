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
  try { await Promise.all([f.updater.check(), f.updater.check()]); await f.updater.check(); assert.equal(f.calls.length, 1); assert.equal(f.state.get("simpleExperimentMac.preview.notified.preview-v0.1.2"), true);
    const status = getUpdateStatus(); assert.equal(status.sftp.updateAvailable, true); assert.equal(status.experiment.currentVersion, "0.1.1"); assert.equal(status.experiment.latestVersion, "0.1.2"); assert.ok(Number.isFinite(Date.parse(status.checkedAt)));
  }
  finally { f.dispose(); }
});
test("bootstrap registers updates before loading business code and polls every thirty minutes", () => {
  const source = fs.readFileSync(require("node:path").join(__dirname, "../../src/mac/Bootstrap.ts"), "utf8");
  assert.ok(source.indexOf("updater = registerPreviewUpdater(context, vscode)") < source.indexOf('business = require("../extension")'));
  assert.match(source, /30 \* 60 \* 1000/); assert.match(source, /void updater\.resume\(\)/);
  assert.equal(require("../../package.json").main, "./dist/mac/Bootstrap.js");
});
test("real client through update button retains failure state and retries a non-rate 403", async () => {
  const { PreviewReleaseClient, COMPONENT_IDS } = require("../../dist/mac/PreviewRelease");
  let requests = 0;
  const tag = "preview-v0.1.2", prefix = `https://github.com/zlinkw/SimpleExperiment-Mac/releases/download/${tag}/`;
  const manifest = { protocolVersion: 1, channel: "preview", releaseTag: tag, publishedAt: "2026-10-10T00:00:00Z",
    components: COMPONENT_IDS.map(extensionId => ({ extensionId, version: "0.1.2", sourceCommit: "a".repeat(40), targetPlatform: "darwin-arm64",
      vscodeEngine: "^1.100.0", downloadUrl: prefix + extensionId.split(".")[1] + "-0.1.2-darwin-arm64.vsix", size: 100, sha256: "b".repeat(64) })) };
  const info = { prerelease: true, draft: false, tag_name: tag, assets: [{ name: "release.json", browser_download_url: prefix + "release.json" },
    ...manifest.components.map(c => ({ name: c.downloadUrl.split("/").at(-1), browser_download_url: c.downloadUrl, size: c.size }))] };
  const client = new PreviewReleaseClient(async url => {
    requests++; if (requests === 1) return new Response("Forbidden", { status: 403, headers: { "x-ratelimit-remaining": "59", "x-ratelimit-reset": "3600" } });
    return Response.json(url.includes("?per_page") ? [info] : manifest);
  }, () => 0);
  const f = fixture(client);
  try {
    await assert.rejects(f.commands.get(CHECK_COMMAND)(), /HTTP 403/);
    assert.equal(getUpdateStatus().status, "error"); assert.match(getUpdateStatus().message, /检查失败/);
    assert.equal(f.calls.some(s => s.includes("已是最新")), false);
    await f.commands.get(CHECK_COMMAND)(); assert.equal(getUpdateStatus().status, "update_available"); assert.equal(requests, 3);
  } finally { f.dispose(); }
});
