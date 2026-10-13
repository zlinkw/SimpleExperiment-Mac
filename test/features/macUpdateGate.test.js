const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { HostOperationLeaseManager, defaultHostOperationLeasePath } = require("../../dist/core/HostOperationLease");
const { beginUpdateGate, endUpdateGate, assertBusinessAllowed, waitForLocalOperations, assertCompatibleSftpForUpdate } = require("../../dist/mac/UpdateGate");

test("shared update gate blocks new resource work while existing local operations drain", async () => {
  const old = process.env.APPDATA, root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-update-gate-"));
  process.env.APPDATA = root;
  let lease;
  try {
    const manager = new HostOperationLeaseManager({ leasePath: defaultHostOperationLeasePath(), windowId: "business-test" });
    const input = { pluginId: "simple-local.simple-sftp-mac", workspaceUri: "file://" + root, hostProjectPath: root, actionType: "upload", actionLabel: "existing transfer", resources: [{ server: "local", project: root, target: root }] };
    lease = await manager.acquire(input);
    await beginUpdateGate(root);
    await lease.assertHeld(); // Existing transfer retains ownership after admission closes.
    assert.throws(assertBusinessAllowed, /正在更新|更新尚未完成/);
    await assert.rejects(new HostOperationLeaseManager({ leasePath: defaultHostOperationLeasePath(), windowId: "new-test" }).acquire(input));
    let finished = false; const drain = waitForLocalOperations().then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false);
    await lease.release(); lease = undefined;
    await drain; assert.equal(finished, true);
    await endUpdateGate(); assert.doesNotThrow(assertBusinessAllowed);
  } finally { await lease?.release(); await endUpdateGate(); if (old === undefined) delete process.env.APPDATA; else process.env.APPDATA = old; }
});

test("cancellable wait protects a live admission ticket and never rewrites its registry", async () => {
  const old = process.env.APPDATA, root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-update-admission-"));
  process.env.APPDATA = root;
  try {
    const directory = defaultHostOperationLeasePath() + ".resources-v2";
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "c".repeat(64) + ".json");
    const bytes = JSON.stringify({ schemaVersion: 2, windowId: "fixture", processId: process.pid, leases: [], choosing: true, ticket: 1 });
    fs.writeFileSync(file, bytes, "utf8");
    const controller = new AbortController(); let finished = false;
    const waiting = waitForLocalOperations(controller.signal).then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false);
    controller.abort(Error("cancel only update wait")); await assert.rejects(waiting, /cancel only update wait/);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, processId: 0, leases: [], choosing: true }), "utf8");
    await assert.rejects(waitForLocalOperations(), /租约损坏/);
  } finally { if (old === undefined) delete process.env.APPDATA; else process.env.APPDATA = old; }
});

test("Mac updater rejects old or unknown SFTP drain protocol before closing admission", () => {
  for (const version of ["", "0.0.0", "0.2.100", "invalid"])
    assert.throws(() => assertCompatibleSftpForUpdate(version), /SimpleSFTP Mac 0.2.101/);
  for (const version of ["0.2.101", "0.2.102", "1.0.0"]) assert.doesNotThrow(() => assertCompatibleSftpForUpdate(version));
});
