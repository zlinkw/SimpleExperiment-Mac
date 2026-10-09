const assert = require("node:assert/strict");
const test = require("node:test");
const { mirrorChosenWorkerVersionToLocal } = require("../../dist/features/SyncScopeLocalMirror.js");

test("selected Worker directory replaces local files and removes stale files only after hash verification", async () => {
  const source = { "results/new.bin": { sha256: "a".repeat(64) }, "results/log.txt": { sha256: "b".repeat(64) } };
  const local = { "results/old.bin": { sha256: "c".repeat(64) } };
  const removed = [];
  const stages = [];
  const authorized = [];
  await mirrorChosenWorkerVersionToLocal("results", true, source,
    async () => Object.assign(local, source),
    async () => ({ ...local }),
    async (file) => { removed.push(file); delete local[file]; },
    (stage) => stages.push(stage), undefined,
    async (files) => { authorized.push(...files); });
  assert.deepEqual(removed, ["results/old.bin"]);
  assert.deepEqual(authorized, ["results/old.bin"]);
  assert.deepEqual(local, source);
  assert.match(stages[0], /正在清理本机旧文件 1\/1/);
});

test("hash mismatch stops local cleanup", async () => {
  const local = { "results/old.bin": { sha256: "c".repeat(64) } };
  let removed = false;
  await assert.rejects(mirrorChosenWorkerVersionToLocal("results", true, { "results/new.bin": { sha256: "a".repeat(64) } },
    async () => { local["results/new.bin"] = { sha256: "b".repeat(64) }; },
    async () => ({ ...local }),
    async () => { removed = true; }, () => {}, undefined,
    async (files) => { assert.deepEqual(files, ["results/old.bin"]); }), /SHA256 校验不一致/);
  assert.equal(removed, false);
});
