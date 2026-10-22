const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Mac companion-update gate (current lease-protocol chain, aligned to the frozen Windows
// pairedUpdateGate contract): transfers run on the resource lease manager while the UpdateGate
// closes admission through the shared host-operation lease file; existing Mac transfers keep
// ownership via the legacyGuard exemption and drain. The SFTP floor lives in updates/Bootstrap.
const { HostOperationLeaseManager } = require("../../dist/core/HostOperationLease");
const { UpdateGate } = require("../../dist/updates/UpdateGate");

test("update closes admission while existing Mac transfers retain ownership and drain", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-update-gate-")), leasePath = path.join(root, "lease.json");
  const manager = new HostOperationLeaseManager({ leasePath, windowId: os.hostname() + ":" + process.pid + ":business-test", ownerAlive: () => true });
  const input = { pluginId: "simple-local.simple-sftp-mac", workspaceUri: "file://" + root, hostProjectPath: root, actionType: "upload", actionLabel: "existing transfer", resources: [{ server: "local", project: root, target: root }] };
  const existing = await manager.acquire(input), gate = new UpdateGate(leasePath, () => true);
  try {
    await gate.begin(root);
    await existing.assertHeld(); // Existing transfer retains ownership after admission closes.
    await assert.rejects(new HostOperationLeaseManager({ leasePath, windowId: "new-test", ownerAlive: () => true }).acquire(input), /全局锁/);
    let drained = false;
    const drain = gate.wait().then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(drained, false);
    await existing.release();
    await drain;
    assert.equal(drained, true);
    await gate.end();
    const next = await new HostOperationLeaseManager({ leasePath, windowId: "after-update", ownerAlive: () => true }).acquire(input);
    await next.release();
  } finally { await existing.release(); await gate.end(); }
});

test("cancelling update wait leaves transfers untouched and corrupt or live receipts block", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-update-wait-")), leasePath = path.join(root, "lease.json"), directory = leasePath + ".resources-v2";
  fs.mkdirSync(directory);
  const file = path.join(directory, "c".repeat(64) + ".json");
  const live = JSON.stringify({ schemaVersion: 2, processId: process.pid, leases: [], choosing: true, ticket: 1 });
  fs.writeFileSync(file, live, "utf8");
  const gate = new UpdateGate(leasePath, () => true), cancel = new AbortController();
  await gate.begin(root);
  try {
    let finished = false;
    const waiting = gate.wait(cancel.signal).then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(finished, false);
    cancel.abort(Error("cancel only update wait"));
    await assert.rejects(waiting, /cancel only update wait/);
    // The wait never rewrites another window's registry file.
    assert.equal(fs.readFileSync(file, "utf8"), live);
    // A corrupt registry blocks installation instead of silently draining.
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, processId: 0, leases: [], choosing: true }), "utf8");
    await assert.rejects(gate.wait(), /租约损坏/);
  } finally { await gate.end(); }
});

test("Mac updater requires the shared-wait-protocol SFTP before closing admission", () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, "../../src/updates/Bootstrap.ts"), "utf8");
  // Released floor: acquiring the gate first requires SimpleSFTP Mac 0.2.102 or newer.
  assert.match(bootstrap, /compareSemanticVersions\(current\(SFTP_EXTENSION_ID\), "0\.2\.102"\) < 0/);
  assert.match(bootstrap, /SimpleSFTP Mac 0\.2\.102 或以上/);
});
