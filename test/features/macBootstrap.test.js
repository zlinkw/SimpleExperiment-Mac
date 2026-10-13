const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { registerPreviewUpdater, getUpdateStatus, CHECK_COMMAND, INSTALL_COMMAND } = require("../../dist/mac/Bootstrap");

function recoveryFixture({ installed = false, cancellation = false } = {}) {
  const vm = require("node:vm"), path = require("node:path");
  const file = require.resolve("../../dist/mac/Bootstrap"), from = require("node:module").createRequire(file), exports = {};
  const tag = "preview-v0.5.314", prefix = "https://github.com/zlinkw/SimpleExperiment-Mac/releases/download/" + tag + "/";
  const rawManifest = { protocolVersion: 1, channel: "preview", releaseTag: tag, publishedAt: "2026-10-13T00:00:00Z", minimumMacOS: "26.0",
    components: [["sftp", "0.2.101", "SimpleSFTP"], ["experiment", "0.5.314", "SimpleExperiment"]].map(([name, version, repository]) => ({
      extensionId: "simple-local.simple-" + name + "-mac", version, sourceCommit: "a".repeat(40), sourceRepository: "zlinkw/" + repository + "-Mac",
      targetPlatform: "darwin-arm64", vscodeEngine: "^1.100.0", size: 128, sha256: "b".repeat(64), downloadUrl: prefix + "simple-" + name + "-mac-" + version + "-darwin-arm64.vsix" })) };
  const manifest = from("./PreviewRelease").parseManifest(rawManifest, { tag_name: tag, assets: rawManifest.components.map(item => ({ name: item.downloadUrl.split("/").at(-1), browser_download_url: item.downloadUrl, size: item.size })) }, "1.100.0");
  const key = "simpleExperimentMac.preview.transaction.v1", journal = { manifest, completed: [], status: "failed", installationRequested: true };
  const state = new Map(cancellation ? [] : [[key, journal]]), subscriptions = [], commands = new Map();
  let blocked = false, held = false, checks = 0, downloads = 0, installs = 0, cancel;
  const gate = { setLocalUpdateBlocked: value => { blocked = value; }, updateGateHeld: () => held,
    assertCompatibleSftpForUpdate: from("./UpdateGate").assertCompatibleSftpForUpdate,
    beginUpdateGate: async () => { held = true; blocked = true; }, endUpdateGate: async () => { held = false; blocked = false; }, waitForLocalOperations: async () => {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { exports, require: name => name === "./UpdateGate" ? gate : from(name),
    process: { ...process, platform: "darwin", arch: "arm64" }, AbortController, structuredClone, setInterval, clearInterval });
  const context = { subscriptions, globalStorageUri: { fsPath: path.join(require("node:os").tmpdir(), "unused-bootstrap-recovery") },
    globalState: { get: (name, fallback) => state.has(name) ? state.get(name) : fallback, update: async (name, value) => state.set(name, value) } };
  const peer = { setUpdateGate() {}, waitForUpdateIdle: async ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }); queueMicrotask(() => cancel());
  }) };
  const vscode = { version: "1.100.0", StatusBarAlignment: { Right: 1 }, ProgressLocation: { Notification: 1 }, Uri: { file: value => value },
    extensions: { getExtension: id => ({ packageJSON: { version: id.endsWith("sftp-mac") ? "0.2.101" : installed ? "0.5.314" : "0.5.313" }, exports: peer }) },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} }; }, executeCommand: async () => { installs++; } },
    window: { createStatusBarItem: () => ({ show() {}, dispose() {} }), showInformationMessage: async () => undefined, showErrorMessage: async () => undefined,
      withProgress: async (_options, work) => work({}, { onCancellationRequested: listener => { cancel = listener; return { dispose() {} }; } }) } };
  const updater = exports.registerPreviewUpdater(context, vscode, { check: async () => { checks++; return { manifest, pending: installed ? [] : [manifest.components[1]] }; }, download: async () => { downloads++; throw Error("must never download during recovery or cancelled wait"); } });
  return { updater, state, key, manifest, journal, commands, get blocked() { return blocked; }, get checks() { return checks; }, get downloads() { return downloads; }, get installs() { return installs; },
    status: () => exports.getUpdateStatus(), dispose: () => subscriptions.forEach(item => item.dispose()) };
}

test("uncertain first install restores its original batch before business startup without automatically installing", async () => {
  const f = recoveryFixture();
  try {
    assert.equal(f.blocked, true); await f.updater.resume(); await f.updater.check(true);
    assert.equal(f.status().plan.manifest.releaseTag, f.manifest.releaseTag); assert.match(f.status().message, /原批次/);
    assert.equal(f.checks, 0); assert.equal(f.downloads, 0); assert.equal(f.installs, 0);
    assert.equal(f.state.get(f.key), f.journal); assert.equal(f.blocked, true);
  } finally { f.dispose(); }
});
test("a fresh reloaded host reconciles both installed versions and clears recovery without reinstalling", async () => {
  const f = recoveryFixture({ installed: true });
  try {
    await f.updater.resume(); assert.equal(f.blocked, false); assert.equal(f.state.get(f.key), undefined);
    assert.equal(f.downloads, 0); assert.equal(f.installs, 0); assert.equal(f.status().status, "up_to_date");
  } finally { f.dispose(); }
});
test("cancellable update progress shares duplicate clicks and stops waiting before downloads", async () => {
  const f = recoveryFixture({ cancellation: true });
  try {
    const first = f.updater.install(), second = f.updater.install(); assert.equal(first, second);
    await assert.rejects(first, /取消配套更新等待/); assert.equal(f.downloads, 0); assert.equal(f.installs, 0);
    assert.equal(f.blocked, false); assert.equal(f.state.get(f.key).installationRequested, false);
  } finally { f.dispose(); }
});

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
  const { PreviewReleaseClient, PREVIEW_INDEX_URL, COMPONENT_IDS } = require("../../dist/mac/PreviewRelease");
  let requests = 0;
  const tag = "preview-v0.1.2", prefix = `https://github.com/zlinkw/SimpleExperiment-Mac/releases/download/${tag}/`;
  const manifest = { protocolVersion: 1, channel: "preview", releaseTag: tag, publishedAt: "2026-10-10T00:00:00Z",
    components: COMPONENT_IDS.map(extensionId => ({ extensionId, version: "0.1.2", sourceCommit: "a".repeat(40), targetPlatform: "darwin-arm64",
      vscodeEngine: "^1.100.0", downloadUrl: prefix + extensionId.split(".")[1] + "-0.1.2-darwin-arm64.vsix", size: 100, sha256: "b".repeat(64) })) };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const info = { prerelease: true, draft: false, tag_name: tag, published_at: manifest.publishedAt, assets: [{ name: "release.json", browser_download_url: prefix + "release.json", size: bytes.length, digest: "sha256:" + require("node:crypto").createHash("sha256").update(bytes).digest("hex") },
    ...manifest.components.map(c => ({ name: c.downloadUrl.split("/").at(-1), browser_download_url: c.downloadUrl, size: c.size, digest: "sha256:" + c.sha256 }))] };
  const client = new PreviewReleaseClient(async url => {
    requests++; if (requests === 1) return new Response("Forbidden", { status: 403, headers: { "x-ratelimit-remaining": "59", "x-ratelimit-reset": "3600" } });
    assert.notEqual(new URL(url).hostname, "api.github.com");
    return Response.json(url === PREVIEW_INDEX_URL ? { protocolVersion: 1, channel: "preview", updatedAt: manifest.publishedAt, releases: [info] } : manifest);
  }, () => 0);
  const f = fixture(client);
  try {
    await assert.rejects(f.commands.get(CHECK_COMMAND)(), /HTTP 403/);
    assert.equal(getUpdateStatus().status, "error"); assert.match(getUpdateStatus().message, /检查失败/);
    assert.equal(f.calls.some(s => s.includes("已是最新")), false);
    await f.commands.get(CHECK_COMMAND)(); assert.equal(getUpdateStatus().status, "update_available"); assert.equal(requests, 3);
  } finally { f.dispose(); }
});
