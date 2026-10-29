const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { jobArtifactRetentionKey, jobArtifactRunGeneration, syncScopeStagingIdentity } = require("../../src/features/JobArtifactSyncIdentity.ts");
test('merged artifact transport has an explicit identity for every real member, independent of member ordering',()=>{
 const {jobArtifactBatchIdentity}=require('../../src/features/JobArtifactSyncIdentity.ts');
 const a={retentionKey:jobArtifactRetentionKey('plans/a.yaml',0,'a',42),planId:'run-a',commandId:'command-a',files:{'work/a/model':'a'.repeat(64)}},
  b={retentionKey:jobArtifactRetentionKey('plans/b.yaml',1,'b',43),planId:'run-b',commandId:'command-b',files:{'work/b/model':'b'.repeat(64)}};
 assert.deepEqual(jobArtifactBatchIdentity([a]),{retentionKey:a.retentionKey,generation:jobArtifactRunGeneration(a.planId,a.commandId,a.files)});
 const shared=jobArtifactBatchIdentity([a,b]);assert.deepEqual(shared,jobArtifactBatchIdentity([b,a]));
 assert.notEqual(shared.retentionKey,a.retentionKey);assert.notEqual(shared.retentionKey,b.retentionKey);
 for(const changed of [{...b,commandId:'new-command'},{...b,planId:'new-run'},{...b,files:{'work/b/model':'c'.repeat(64)}},{...b,files:{'work/b/other':'b'.repeat(64)}}])
  assert.notEqual(shared.generation,jobArtifactBatchIdentity([a,changed]).generation);
 assert.throws(()=>jobArtifactBatchIdentity([a,{...b,files:{'work/a/model':'b'.repeat(64)}}]),/CONFLICT/);
 assert.throws(()=>jobArtifactBatchIdentity([{...a,files:{'work/a/model':''}}]),/HASH/);
});

test("the completed-job retentionKey is the exact five-tuple the dedicated plan chain already uses", () => {
  const planFile = "experiments/plans/comparison/qmf.yaml", index = 2, caseName = "qmf_bus_p100", seed = 43;
  // Byte-for-byte equal to the dedicated chain's literal construction (legacy.ts syncDistributedJobArtifacts).
  assert.equal(jobArtifactRetentionKey(planFile, index, caseName, seed),
    JSON.stringify(["job-artifacts", planFile, index, caseName, seed]));
  assert.equal(jobArtifactRetentionKey("plans/p.yaml", 0, "case0", 42),
    JSON.stringify(["job-artifacts", "plans/p.yaml", 0, "case0", 42]));
  assert.notEqual(jobArtifactRetentionKey("plans/p.yaml", 0, "case0", 42),
    jobArtifactRetentionKey("plans/p.yaml", 1, "case0", 42), "different jobs never share a staging identity");
});

test("the run generation is a 64-hex value that retries of the same source manifest reuse", () => {
  const files = { "work_dirs/p/job0/model.pth": "A".repeat(64), "work_dirs/p/job0/summary.json": "b".repeat(64) };
  const first = jobArtifactRunGeneration("plan", "command0", files);
  assert.match(first, /^[0-9a-f]{64}$/, "hex passes the receiver transferScope64 unchanged");
  assert.equal(jobArtifactRunGeneration("plan", "command0", { ...files }), first, "same input retries and reloads reuse one generation");
  assert.equal(jobArtifactRunGeneration("plan", "command0", Object.fromEntries(Object.entries(files).reverse())), first,
    "inventory key order cannot change the generation");
  assert.equal(jobArtifactRunGeneration("plan", "command0", { "work_dirs/p/job0/model.pth": "a".repeat(64), "work_dirs/p/job0/summary.json": "b".repeat(64) }), first,
    "SHA case is normalized before hashing");
});

test("a new command, run or content hash always opens a new generation while missing destination progress never does", () => {
  const files = { "work_dirs/p/job0/model.pth": "a".repeat(64) };
  const base = jobArtifactRunGeneration("plan", "command0", files);
  assert.notEqual(jobArtifactRunGeneration("plan", "command1", files), base, "a new dispatch/attempt never reuses the old run generation");
  assert.notEqual(jobArtifactRunGeneration("plan-2", "command0", files), base, "a new plan run opens its own generation");
  assert.notEqual(jobArtifactRunGeneration("plan", "command0", { "work_dirs/p/job0/model.pth": "c".repeat(64) }), base,
    "a changed source SHA opens a new generation even under the same command");
  assert.notEqual(jobArtifactRunGeneration("plan", "command0", { ...files, "work_dirs/p/job0/extra.bin": "d".repeat(64) }), base,
    "a changed source file set opens a new generation");
  assert.notEqual(jobArtifactRunGeneration("plan", "command0", {}), base);
});

// r112：共享保留/合并链的暂存身份（现场依据：nwpu3 共享 project-files 双槽 d-47be3d71…/d-008f3730…
// 被同一逻辑源自家 committed 代占满，之前这些链每发都是随机新代，重试必撞 TRANSFER_STAGE_PENDING）。
test("the shared retain-lane identity is the sorted batch path scope plus frozen SHAs, reused verbatim by retries", () => {
  const files = { "work_dirs/p/model.pth": "A".repeat(64), "tmp/a.json": "b".repeat(64) };
  const first = syncScopeStagingIdentity(["tmp/a.json", "work_dirs/p/model.pth", "tmp/a.json"], files);
  assert.equal(first.retentionKey, 'sync-scope-retain:["tmp/a.json","work_dirs/p/model.pth"]', "排序去重的路径清单即身份，且不含任何来源/节点字段");
  assert.match(first.generation, /^[0-9a-f]{64}$/, "64 位小写 hex 原样通过 receiver transferScope64");
  assert.deepEqual(syncScopeStagingIdentity(["work_dirs/p/model.pth", "tmp/a.json"], { ...files }), first,
    "同一批、同一冻结清单：顺序与重复不构成新身份，重试逐字复用自己的代");
  const literal = crypto.createHash("sha256").update(JSON.stringify(["sync-scope-retain",
    ["tmp/a.json", "work_dirs/p/model.pth"], [["tmp/a.json", "b".repeat(64)], ["work_dirs/p/model.pth", "a".repeat(64)]]])).digest("hex");
  assert.equal(first.generation, literal, "盐、scope 数组与排序 path+sha 清单就是上线格式（SHA 大小写归一）");
});

test("a changed path set or SHA opens a new retain-lane generation while the same path stays one logical source", () => {
  const files = { "work_dirs/p/model.pth": "a".repeat(64) };
  const base = syncScopeStagingIdentity(["work_dirs/p/model.pth"], files);
  assert.notEqual(syncScopeStagingIdentity(["work_dirs/p/model.pth"], { "work_dirs/p/model.pth": "c".repeat(64) }).generation, base.generation,
    "单文件 SHA 变化必须开新代，不与旧代混淆");
  assert.notEqual(syncScopeStagingIdentity(["work_dirs/p/model.pth", "extra.bin"], { ...files, "extra.bin": "d".repeat(64) }).generation, base.generation,
    "路径集变化必须开新代");
  assert.notEqual(syncScopeStagingIdentity(["work_dirs/p/other.pth"], { "work_dirs/p/other.pth": "a".repeat(64) }).retentionKey, base.retentionKey,
    "不同 relative 是不同逻辑源，互不挤占槽位");
  assert.notEqual(syncScopeStagingIdentity(["work_dirs/p/model.pth"], {}).generation, base.generation,
    "缺失来源 SHA 不静默等同旧代");
});

// r117（Q5）：目录 scope 的身份必须覆盖完整冻结子文件清单。oracle 是测试内手写的上线格式
// （盐＋排序 scope＋排序 path+sha 清单），不是再调用一次被测函数——旧实现只看 sourceFiles[目录]
// 永远算出 [["dir",""]]，用同一个函数算 expected 就永远看不见这个缺陷。
const dirLiteral = (pairs) => crypto.createHash("sha256").update(JSON.stringify(["sync-scope-retain",
  ["work_dirs/keep"], [...pairs].sort((l, r) => (l[0] === r[0] ? 0 : l[0] < r[0] ? -1 : 1))])).digest("hex");
test("a directory scope hashes its complete frozen descendant manifest, verified against a hand-written oracle", () => {
  const inventory = { "work_dirs/keep/m.pth": { sha256: "A".repeat(64), size: 3 }, "work_dirs/keep/sub/n.bin": { sha256: "b".repeat(64), size: 2 }, "other/x.bin": { sha256: "d".repeat(64) } };
  const first = syncScopeStagingIdentity(["work_dirs/keep"], inventory);
  assert.equal(first.retentionKey, 'sync-scope-retain:["work_dirs/keep"]', "目录即逻辑源，key 只含 scope 清单");
  assert.equal(first.generation, dirLiteral([["work_dirs/keep/m.pth", "a".repeat(64)], ["work_dirs/keep/sub/n.bin", "b".repeat(64)]]),
    "generation 恰为目录内全部子文件（排序、SHA 小写）的上线格式哈希，scope 外 other/x.bin 不入哈希");
  const reordered = { "other/x.bin": inventory["other/x.bin"], "work_dirs/keep/sub/n.bin": inventory["work_dirs/keep/sub/n.bin"], "work_dirs/keep/m.pth": inventory["work_dirs/keep/m.pth"] };
  assert.deepEqual(syncScopeStagingIdentity(["work_dirs/keep"], reordered), first, "库存键序不构成新代");
  assert.notEqual(syncScopeStagingIdentity(["work_dirs/keep"], { ...inventory, "work_dirs/keep/m.pth": { sha256: "c".repeat(64) } }).generation, first.generation,
    "目录内子文件 SHA 变化必须开新代（旧实现在这里恒得同代，即现场缺陷）");
  assert.notEqual(syncScopeStagingIdentity(["work_dirs/keep"], { ...inventory, "work_dirs/keep/extra.bin": { sha256: "e".repeat(64) } }).generation, first.generation,
    "目录内新增子文件必须开新代");
  const { ...withoutN } = inventory; delete withoutN["work_dirs/keep/sub/n.bin"];
  assert.notEqual(syncScopeStagingIdentity(["work_dirs/keep"], withoutN).generation, first.generation,
    "目录内删除子文件必须开新代");
  assert.equal(syncScopeStagingIdentity(["work_dirs/keep"], { ...inventory, "other/y.bin": { sha256: "f".repeat(64) } }).generation, first.generation,
    "scope 外无关库存不得制造新代");
  assert.equal(syncScopeStagingIdentity(["work_dirs/keep"], { ...inventory, "work_dirs/keeper/m.pth": { sha256: "f".repeat(64) } }).generation, first.generation,
    "斜杠边界钉死：前缀相近的兄弟目录条目不得混入本目录清单");
});
