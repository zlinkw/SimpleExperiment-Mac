const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
// Mac paired-update bootstrap, aligned to the Windows-authoritative updates/Bootstrap chain
// (frozen pairedUpdateBootstrap call chain): the updater registers before business code, journals
// are reconciled without ever auto-installing, and the SFTP wait-protocol floor blocks the gate.
const { registerUpdater, activateWithBusiness, deactivate, getUpdateStatus, CHECK_COMMAND, INSTALL_COMMAND } = require("../../dist/updates/Bootstrap");
const { getPreviewUpdater } = require("../../dist/mac/Bootstrap");
const { TRANSACTION_KEY } = require("../../dist/updates/UpdateTransaction");
const { SFTP_EXTENSION_ID, EXPERIMENT_EXTENSION_ID, SFTP_UPDATE_REPO, EXPERIMENT_UPDATE_REPO } = require("../../dist/features/ExtensionUpdates");
const { assetRepository } = require("../../dist/platform/UpdateDistribution");

function fixture(client, options = {}) {
  const state = new Map(options.state || []), calls = [], commands = new Map(), subscriptions = [];
  const versions = { [SFTP_EXTENSION_ID]: "1.0.0", [EXPERIMENT_EXTENSION_ID]: "1.0.0", ...options.versions };
  const context = { subscriptions, globalStorageUri: { fsPath: "unused" },
    globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => { value === undefined ? state.delete(key) : state.set(key, structuredClone(value)); } } };
  const vscode = { version: "1.100.0", StatusBarAlignment: { Right: 1 }, ProgressLocation: { Notification: 1 }, Uri: { file: fsPath => ({ fsPath }) },
    extensions: { getExtension: id => ({ packageJSON: { version: versions[id] || "0.0.0" } }) },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() { } }; },
      executeCommand: async (id, uri) => { calls.push(id); if (id === "workbench.extensions.installExtension") { if (options.installFail === uri.fsPath) throw Error("install failed"); versions[uri.fsPath] = "1.1.0"; } } },
    window: { createStatusBarItem: () => ({ show() { }, dispose() { } }), showInformationMessage: async message => { calls.push("notice:" + message); },
      showWarningMessage: async () => { calls.push("confirm"); return options.deny ? "取消" : "安装并重载"; }, showErrorMessage: async message => { calls.push("error:" + message); },
      withProgress: options.cancelWait === undefined ? undefined : async (_options, work) => work({}, { onCancellationRequested: listener => { if (options.cancelWait) listener(); return { dispose() { } }; } }) } };
  // Mac distribution: SFTP assets are published in the Experiment preview repository (assetRepository maps them).
  const components = [[SFTP_EXTENSION_ID, SFTP_UPDATE_REPO], [EXPERIMENT_EXTENSION_ID, EXPERIMENT_UPDATE_REPO]]
    .map(([id, repo]) => ({ id, repo, label: id, currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true,
      vsix: { size: 100, url: `https://github.com/${assetRepository(repo)}/releases/download/v1.1.0/update-${id}.vsix`, digest: "sha256:" + "a".repeat(64) } }));
  const plan = { status: "update_available", checkedAt: "", message: "update", sftp: components[0], experiment: components[1] };
  const local = {
    gate: { begin: async () => calls.push("gate"), end: async () => calls.push("ungate"), wait: async () => calls.push("wait") },
    store: { prepare: async component => { calls.push("prepare:" + component.id); return component.id; }, verify: async file => { calls.push("verify:" + file); } },
  };
  const updater = options.noRegister ? undefined : registerUpdater(context, vscode, client || { check: async () => plan }, local);
  return { updater, context, vscode, state, calls, commands, local, plan, versions, components, dispose: () => subscriptions.forEach(s => s.dispose()) };
}

test("update commands register without business panel; checks share one pass and one notice per pair", async () => {
  const f = fixture({ check: async () => { throw Error("offline"); } });
  try {
    assert.ok(f.commands.has(CHECK_COMMAND)); assert.ok(f.commands.has(INSTALL_COMMAND));
    await assert.rejects(f.updater.check(true));
    assert.equal(getUpdateStatus().status, "error"); assert.match(getUpdateStatus().message, /检查失败/);
    assert.ok(f.calls.some(call => call.startsWith("error:")));
  } finally { f.dispose(); }
  const shared = fixture();
  try {
    const a = shared.updater.check(), b = shared.updater.check(); assert.equal(a, b);
    await a; await shared.updater.check();
    assert.equal(shared.calls.filter(call => call.startsWith("notice:")).length, 1);
    assert.equal(shared.state.get(`simpleExperimentMac.update.notified.1.1.0:1.1.0`), true);
  } finally { shared.dispose(); }
});

test("business loading failure retains working update commands and clear failure status", async () => {
  const client = { check: async () => { throw Error("offline"); } }, f = fixture(client, { noRegister: true });
  try {
    await activateWithBusiness(f.context, f.vscode, () => { assert.ok(f.commands.has(CHECK_COMMAND)); throw Error("broken panel"); }, client, f.local);
    await assert.rejects(f.commands.get(CHECK_COMMAND)(), /offline/); assert.equal(getUpdateStatus().status, "error");
    assert.ok(f.calls.some(call => call.includes("独立更新命令仍可用")));
  } finally { f.dispose(); await deactivate(); }
});

test("confirmation precedes side effects; packages prepare together and partial success remains reviewable", async () => {
  const denied = fixture(undefined, { deny: true });
  try {
    await denied.updater.check(); await denied.updater.install();
    assert.ok(!denied.calls.includes("gate")); assert.ok(!denied.state.has(TRANSACTION_KEY)); assert.ok(!denied.calls.some(c => c.startsWith("prepare:")));
  } finally { denied.dispose(); }
  const f = fixture(undefined, { installFail: EXPERIMENT_EXTENSION_ID });
  try {
    await f.updater.check(); await assert.rejects(f.updater.install(), /install failed/);
    assert.ok(f.calls.indexOf("confirm") < f.calls.indexOf("gate"));
    assert.ok(f.calls.indexOf("prepare:" + EXPERIMENT_EXTENSION_ID) < f.calls.indexOf("workbench.extensions.installExtension"));
    assert.equal(f.updater.blocked, true); assert.deepEqual(f.state.get(TRANSACTION_KEY).completed, [SFTP_EXTENSION_ID]);
    const installs = f.calls.filter(c => c === "workbench.extensions.installExtension").length; assert.equal(installs, 2); // SFTP installed; Experiment failed at its own step.
    await f.updater.check(); assert.equal(getUpdateStatus().status, "update_available"); assert.match(getUpdateStatus().message, /上次/);
    assert.equal(f.calls.filter(c => c === "workbench.extensions.installExtension").length, installs); // the re-check never auto-installs
  } finally { f.dispose(); await f.updater.dispose(); }
});

test("reload settles an installed batch; incomplete original batch is reconciled without installing", async () => {
  const f = fixture();
  try {
    await f.updater.check(); await f.updater.install(); const journal = f.state.get(TRANSACTION_KEY);
    assert.equal(journal.status, "reload_required");
    const restart = fixture(undefined, { state: [[TRANSACTION_KEY, journal]], versions: { [SFTP_EXTENSION_ID]: "1.1.0", [EXPERIMENT_EXTENSION_ID]: "1.1.0" } });
    try {
      await restart.updater.check();
      assert.equal(restart.updater.blocked, false); assert.equal(restart.state.get(TRANSACTION_KEY), undefined);
      assert.ok(!restart.calls.includes("workbench.extensions.installExtension")); assert.equal(getUpdateStatus().status, "update_available");
    } finally { restart.dispose(); }
    const incomplete = fixture(undefined, { state: [[TRANSACTION_KEY, { ...journal, status: "failed", completed: [SFTP_EXTENSION_ID] }]], versions: { [SFTP_EXTENSION_ID]: "1.1.0" } });
    try {
      await incomplete.updater.check();
      assert.equal(incomplete.updater.blocked, true); assert.match(getUpdateStatus().message, /原批次/);
      assert.equal(incomplete.state.get(TRANSACTION_KEY).status, "failed");
      assert.ok(!incomplete.calls.includes("workbench.extensions.installExtension")); assert.ok(!incomplete.calls.some(c => c.startsWith("prepare:")));
    } finally { incomplete.dispose(); await incomplete.updater.dispose(); }
  } finally { f.dispose(); await f.updater.dispose(); }
});

test("cancelling the shared update wait releases admission before any package is prepared", async () => {
  const f = fixture(undefined, { cancelWait: true });
  try {
    await f.updater.check();
    const first = f.updater.install(), second = f.updater.install(); assert.equal(first, second);
    await assert.rejects(first, /用户取消更新/);
    assert.ok(!f.calls.includes("gate")); assert.ok(!f.calls.some(c => c.startsWith("prepare:"))); assert.ok(!f.calls.includes("workbench.extensions.installExtension"));
    assert.equal(f.updater.blocked, false); assert.equal(f.state.get(TRANSACTION_KEY).installationRequested, false);
  } finally { f.dispose(); }
});

test("old SFTP without the shared wait protocol cannot enter an update gate that would abort its transfers", async () => {
  const f = fixture(undefined, { versions: { [SFTP_EXTENSION_ID]: "0.2.101" } });
  try {
    await f.updater.check(); await assert.rejects(f.updater.install(), /0\.2\.102/);
    assert.ok(!f.calls.includes("gate")); assert.ok(!f.calls.includes("wait")); assert.ok(!f.calls.includes("workbench.extensions.installExtension"));
  } finally { f.dispose(); }
});

test("Mac entry registers updates before business, polls every thirty minutes, and keeps the OS shim", () => {
  const mac = fs.readFileSync(require("node:path").join(__dirname, "../../src/mac/Bootstrap.ts"), "utf8");
  assert.ok(mac.indexOf("shared.activateWithBusiness") < mac.indexOf('return require("../extension")'));
  assert.match(mac, /export const registerPreviewUpdater = shared\.registerUpdater/);
  assert.match(mac, /context\.subscriptions\.push\(\s*vscode\.commands\.registerCommand\(CHECK_COMMAND/);
  const shared = fs.readFileSync(require("node:path").join(__dirname, "../../src/updates/Bootstrap.ts"), "utf8");
  assert.match(shared, /30 \* 60 \* 1000/);
  assert.ok(shared.indexOf("service = registerUpdater") < shared.indexOf("business = loadBusiness"));
  const provider = fs.readFileSync(require("node:path").join(__dirname, "../../src/extension/legacy.ts"), "utf8");
  assert.match(provider, /if \(updater\) return updater\.check\(manual\)/); assert.match(provider, /if \(updater\) return updater\.install\(\)/);
  assert.match(provider, /getUpdater\(\)\?\.blocked\) return/);
  assert.equal(require("../../package.json").main, "./dist/mac/Bootstrap.js");
});
