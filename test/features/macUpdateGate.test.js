const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { HostOperationLeaseManager, defaultHostOperationLeasePath } = require("../../dist/core/HostOperationLease");
const { beginUpdateGate, endUpdateGate, assertBusinessAllowed, waitForLocalOperations } = require("../../dist/mac/UpdateGate");

test("shared update gate blocks new resource work while existing local operations drain", async () => {
  const old = process.env.APPDATA, root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-update-gate-"));
  process.env.APPDATA = root;
  let lease;
  try {
    const manager = new HostOperationLeaseManager({ leasePath: defaultHostOperationLeasePath(), windowId: "business-test" });
    const input = { pluginId: "simple-local.simple-sftp-mac", workspaceUri: "file://" + root, hostProjectPath: root, actionType: "upload", actionLabel: "existing transfer", resources: [{ server: "local", project: root, target: root }] };
    lease = await manager.acquire(input);
    await beginUpdateGate(root);
    assert.throws(assertBusinessAllowed, /正在更新/);
    await assert.rejects(new HostOperationLeaseManager({ leasePath: defaultHostOperationLeasePath(), windowId: "new-test" }).acquire(input));
    let finished = false; const drain = waitForLocalOperations().then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false);
    await lease.release(); lease = undefined;
    await drain; assert.equal(finished, true);
    await endUpdateGate(); assert.doesNotThrow(assertBusinessAllowed);
  } finally { await lease?.release(); await endUpdateGate(); if (old === undefined) delete process.env.APPDATA; else process.env.APPDATA = old; }
});
