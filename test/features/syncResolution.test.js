const assert = require("node:assert/strict");
const test = require("node:test");
const { chosenSyncHash, filterHeldFiles, isSyncHeld, localDeleteScript, safeSyncPath } = require("../../dist/features/SyncResolution.js");

test("deleted copy pauses automatic sync for an exact file or held directory", () => {
  const holds = { "results/a.bin": { endpointId: "w2", directory: false }, "work_dirs/run": { endpointId: "w3", directory: true } };
  assert.equal(isSyncHeld("results/a.bin", holds), true);
  assert.equal(isSyncHeld("results/a.bin.extra", holds), false);
  assert.equal(isSyncHeld("work_dirs/run/weight.bin", holds), true);
  assert.deepEqual(filterHeldFiles({ "results/a.bin": 1, "results/a.bin.extra": 2, "work_dirs/run/weight.bin": 3 }, holds), { "results/a.bin.extra": 2 });
});

test("resolved choice persists SHA without blocking future reconciliation", () => {
  const hash = "a".repeat(64);
  const choices = { "results/a.bin": { endpointId: "w1", directory: false, status: "resolved", sha256: hash } };
  assert.equal(isSyncHeld("results/a.bin", choices), false);
  assert.equal(chosenSyncHash("results/a.bin", choices), hash);
});

test("local deletion script enters exact parent before shortest literal child deletion", () => {
  const script = localDeleteScript("D:\\project", "results/a.bin");
  assert.match(script, /Set-Location -LiteralPath 'D:\\project\\results'/);
  assert.match(script, /PARENT_CD_FAILED/);
  assert.ok(script.includes("Remove-Item -LiteralPath './a.bin'"));
  assert.doesNotMatch(script, /Remove-Item -LiteralPath 'D:\\project/);
  assert.throws(() => safeSyncPath("../escape"), /不安全/);
});
