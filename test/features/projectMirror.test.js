const assert = require("node:assert/strict");
const test = require("node:test");
const { planProjectMirror, normalizeMirrorScopePaths, filterInventoryByScope } = require("../../dist/features/ProjectMirror.js");
const { emptyPlanSyncLedger, queuePlanSync } = require("../../dist/features/PlanArtifactSync.js");

test("remote-only files are copied by content and conflicting files are held", () => {
  const ledger = queuePlanSync(emptyPlanSyncLedger(), "plans/a.yaml", "r1", "nwpu2", ["work_dirs/a"], ["nwpu2", "nwpu3"], ["work_dirs/a"], "run-1");
  const inventories = {
    nwpu2: { "datasets/a.bin": { sha256: "aa", size: 1 }, "datasets/conflict.bin": { sha256: "11", size: 1 }, "work_dirs/a/model.pt": { sha256: "cc", size: 1 }, "train.py": { sha256: "dd", size: 1 } },
    nwpu3: { "datasets/conflict.bin": { sha256: "22", size: 1 }, "work_dirs/a/model.pt": { sha256: "ee", size: 1 }, "train.py": { sha256: "ff", size: 1 } },
  };
  const plan = planProjectMirror(inventories, { "train.py": { sha256: "dd" } }, ledger);
  assert.deepEqual(plan.copies, [{ sourceWorkerId: "nwpu2", destinationWorkerId: "nwpu3", path: "datasets/a.bin" }]);
  assert.deepEqual(plan.conflicts, [{ path: "datasets/conflict.bin", workers: ["nwpu2", "nwpu3"] }]);
  assert.deepEqual(plan.protectedPaths, ["train.py", "work_dirs/a/model.pt"]);
  assert.deepEqual(plan.protectedDifferences, ["train.py", "work_dirs/a/model.pt"]);
  const held = planProjectMirror(inventories, { "train.py": { sha256: "dd" } }, ledger,
    { "datasets/a.bin": { endpointId: "nwpu3", directory: false }, "work_dirs/a": { endpointId: "nwpu3", directory: true } });
  assert.deepEqual(held.copies, []);
  assert.equal(held.protectedDifferences.includes("work_dirs/a/model.pt"), false);
});

test("server scope defaults to all files and can select directories without type limits", () => {
  const files = { "data/x.bin": { sha256: "a" }, "work_dirs/p/weight.pt": { sha256: "b" } };
  assert.deepEqual(normalizeMirrorScopePaths([".", "data"]), ["."]);
  assert.deepEqual(filterInventoryByScope(files, ["."]), files);
  assert.deepEqual(Object.keys(filterInventoryByScope(files, ["work_dirs"])), ["work_dirs/p/weight.pt"]);
  assert.throws(() => normalizeMirrorScopePaths(["../outside"]), /不安全/);
  assert.throws(() => normalizeMirrorScopePaths([".git/config"]), /机器状态/);
  assert.throws(() => normalizeMirrorScopePaths(["experiments/results/formal/final.csv.lock"]), /机器状态/);
  assert.throws(() => normalizeMirrorScopePaths(["work_dirs/corim/.tb_mean.lock"]), /机器状态/);
  assert.deepEqual(normalizeMirrorScopePaths(["poetry.lock"]), ["poetry.lock"]);
});

test("manually retained SHA wins on a Worker that reconnects with an older copy", () => {
  const hash = "a".repeat(64);
  const old = "b".repeat(64);
  const inventories = { w1: { "results/a.bin": { sha256: hash, size: 1 } }, w2: { "results/a.bin": { sha256: old, size: 1 } } };
  const holds = { "results/a.bin": { endpointId: "w1", deletedAt: "now", directory: false, status: "resolved", sha256: hash } };
  const plan = planProjectMirror(inventories, {}, emptyPlanSyncLedger(), holds);
  assert.deepEqual(plan.copies, [{ sourceWorkerId: "w1", destinationWorkerId: "w2", path: "results/a.bin" }]);
  assert.deepEqual(plan.conflicts, []);
});
