const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
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
  // 生产按宿主口径解析父目录，期望值必须用同一口径生成，不能硬编码 POSIX 写法。
  const parent = path.resolve("/data/project", "results");
  const script = localDeleteScript("/data/project", "results/a.bin");
  assert.ok(script.includes("Set-Location -LiteralPath '" + parent + "'"), "必须先精确进入已核验父目录: " + script);
  assert.match(script, /PARENT_CD_FAILED/);
  assert.ok(script.includes("Remove-Item -LiteralPath './a.bin'"));
  // 任何删除都必须走当前目录下的最短字面量子路径，不得出现绝对路径删除。
  assert.ok(!/Remove-Item -LiteralPath '(?!.\/)/.test(script), "删除只能使用最短子路径: " + script);
  const guarded = localDeleteScript("/data/project", "results/a.bin", { type: "file", size: "7", modifiedTicks: "631234567890000000" });
  assert.match(guarded, /TARGET_CHANGED/);
  assert.match(guarded, /\$item\.Length -ne '7'/);
  assert.match(guarded, /LastWriteTimeUtc\.Ticks -ne '631234567890000000'/);
  assert.throws(() => localDeleteScript("/data/project", ".git/config"), /PROTECTED_PATH/);
  assert.throws(() => safeSyncPath("../escape"), /不安全/);
});
