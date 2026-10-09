const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { buildScopeStatuses, collectLocalScopeInventory, scopeInventoryPathAllowed, requireCompleteScopeInventory } = require("../../dist/features/SyncScopeStatus.js");

const file = (hash) => ({ sha256: hash, size: 1 });
const ledger = { schemaVersion: 2, entries: {
  run: { planFile: "experiments/plans/p.yaml", revision: "1", runId: "run", sourceWorkerId: "w2", artifactPaths: ["work_dirs/p"], directoryPaths: ["work_dirs/p"], destinations: {} },
} };

test("local scope treats local content as latest and aggregates directory state", () => {
  const inventory = { local: { "configs/a.weird": file("a") }, workers: { w1: { "configs/a.weird": file("a") }, w2: { "configs/a.weird": file("b") } } };
  const status = buildScopeStatuses(inventory, "local-server", [], new Set(["configs/a.weird"]), ledger);
  assert.equal(status["configs/a.weird"].state, "different");
  assert.match(status["configs/a.weird"].detail, /本机 最新.*w1 最新.*w2 待更新/);
  assert.equal(status.configs.state, "different");
  assert.match(status.configs.detail, /同步范围内 1 个文件 · 0 一致 · 1 待更新或冲突/);
});

test("folder copy time is the newest file time on each location", () => {
  const inventory = { local: {
    "results/a.bin": { sha256: "a", size: 1, modifiedAtMs: 1000 },
    "results/b.bin": { sha256: "b", size: 1, modifiedAtMs: 3000 },
  }, workers: {
    w1: { "results/a.bin": { sha256: "a", size: 1, modifiedAtMs: 2000 }, "results/b.bin": { sha256: "old", size: 1, modifiedAtMs: 1500 } },
    w2: { "results/a.bin": { sha256: "a", size: 1, modifiedAtMs: 4000 } },
  } };
  const status = buildScopeStatuses(inventory, "local-server", ["results"], new Set(), ledger);
  assert.equal(status.results.state, "different");
  assert.equal(status.results.copies.local.modifiedAtMs, 3000);
  assert.equal(status.results.copies.w1.modifiedAtMs, 2000);
  assert.equal(status.results.copies.w1.needsSync, 1);
  assert.equal(status.results.copies.w2.modifiedAtMs, 4000);
  assert.equal(status.results.copies.w2.missing, 1);
});

test("server scope uses Plan owner, reports unrelated conflicts, and defaults to whole project", () => {
  const inventory = {
    local: {},
    workers: {
      w1: { "work_dirs/p/weight.bin": file("old"), "datasets/data.bin": file("x") },
      w2: { "work_dirs/p/weight.bin": file("new"), "datasets/data.bin": file("y") },
    },
  };
  const status = buildScopeStatuses(inventory, "server-server", ["."], new Set(), ledger);
  assert.match(status["work_dirs/p/weight.bin"].detail, /Plan 归属：w2.*w1 待更新.*w2 最新版/);
  assert.match(status["datasets/data.bin"].detail, /无法判定最新版/);
  assert.equal(status["datasets/data.bin"].state, "different");
});

test("distributed result publication identifies the source even when Worker timestamps tie", () => {
  const name = "simple_cluster/results/distributed_preview.json";
  const inventory = { local: {}, workers: {
    w2: { [name]: { ...file("older"), modifiedAtMs: 100 } },
    w3: { [name]: { ...file("published"), modifiedAtMs: 100 } },
    w5: { [name]: { ...file("other"), modifiedAtMs: 100 } },
  } };
  const unresolved = buildScopeStatuses(inventory, "server-server", ["."], new Set(), ledger);
  assert.match(unresolved[name].detail, /无法判定最新版/);
  const status = buildScopeStatuses(inventory, "server-server", ["."], new Set(), ledger,
    new Set(), {}, { [name]: "w3" });
  assert.equal(status[name].versions.w3.latest, "plan");
  assert.match(status[name].detail, /Plan 归属：w3/);
});

test("Worker scope ignores local inventory, versions, and folder copies", () => {
  const inventory = { local: {}, workers: { w1: { "datasets/data.bin": file("same") }, w2: { "datasets/data.bin": file("same") } } };
  const status = buildScopeStatuses(inventory, "server-server", ["."], new Set(), ledger);
  assert.equal(status["datasets/data.bin"].state, "same");
  assert.equal(status.datasets.state, "same");
  assert.equal(status["datasets/data.bin"].versions.local, undefined);
  assert.equal(status.datasets.copies.local, undefined);
  assert.doesNotMatch(status["datasets/data.bin"].detail, /本机/);
  inventory.local["datasets/data.bin"] = file("different");
  inventory.local["local-only.bin"] = file("local");
  const withLocal = buildScopeStatuses(inventory, "server-server", ["."], new Set(), ledger);
  assert.equal(withLocal["datasets/data.bin"].state, "same");
  assert.equal(withLocal["local-only.bin"], undefined);
});

test("an offline Worker stays unverified instead of showing green", () => {
  const inventory = { local: { "train.py": file("a") }, workers: { w1: { "train.py": file("a") }, w2: {} } };
  const status = buildScopeStatuses(inventory, "local-server", [], new Set(["train.py"]), ledger, new Set(["w2"]));
  assert.equal(status["train.py"].state, "unknown");
  assert.match(status["train.py"].detail, /w2 未校验，待核对/);
});

test("version metadata shows Plan owner and timestamp candidate without resolving conflict", () => {
  const inventory = { local: {}, workers: {
    w1: { "work_dirs/p/weight.bin": { sha256: "old", size: 1, modifiedAtMs: 300 }, "results/conflict.bin": { sha256: "a", size: 1, modifiedAtMs: 200 } },
    w2: { "work_dirs/p/weight.bin": { sha256: "new", size: 1, modifiedAtMs: 100 }, "results/conflict.bin": { sha256: "b", size: 1, modifiedAtMs: 300 } },
  } };
  const holds = { "results/conflict.bin": { endpointId: "w1", directory: false } };
  const status = buildScopeStatuses(inventory, "server-server", ["."], new Set(), ledger, new Set(), holds);
  assert.equal(status["work_dirs/p/weight.bin"].versions.w2.latest, "plan");
  assert.equal(status["results/conflict.bin"].versions.w2.latest, "candidate");
  assert.equal(status["results/conflict.bin"].state, "different");
  assert.equal(status["results/conflict.bin"].held, true);
  const manual = buildScopeStatuses(inventory, "server-server", ["."], new Set(), ledger, new Set(),
    { "results/conflict.bin": { endpointId: "w2", directory: false, status: "resolved", sha256: "b" } });
  assert.equal(manual["results/conflict.bin"].versions.w2.latest, "manual");
  assert.match(manual["results/conflict.bin"].detail, /手动保留版本/);
});

test("folder status hashes direct files without scanning large descendant directories", async () => {
  const root = path.join(__dirname, "..", "fixtures", "syncScopeStatus");
  const inventory = await collectLocalScopeInventory(root, "data", false);
  assert.deepEqual(Object.keys(inventory), ["data/visible.bin"]);
  assert.equal(inventory["data/visible.bin"].sha256.length, 64);
});

test("inventory excludes runtime locks but retains project lockfiles", () => {
  assert.equal(scopeInventoryPathAllowed("experiments/results/formal/final.csv.lock"), false);
  assert.equal(scopeInventoryPathAllowed("work_dirs/corim/.tb_mean.lock"), false);
  assert.equal(scopeInventoryPathAllowed("poetry.lock"), true);
});

test("a changing Worker file leaves stable scoped files verified", () => {
  const inventories = {
    local: { "code.py": file("code"), "results/weight.bin": file("weight") },
    workers: { w1: { "code.py": file("code") }, w2: { "code.py": file("code"), "results/weight.bin": file("weight") } },
    unverified: { w1: { "results/weight.bin": "文件校验期间发生变化" } },
  };
  const localStatus = buildScopeStatuses(inventories, "local-server", ["code.py"], new Set(), ledger);
  assert.equal(localStatus["code.py"].state, "same");
  assert.equal(localStatus["results/weight.bin"].detail, "当前同步范围外");
  assert.match(localStatus["."].detail, /同步范围内 1 个文件 · 1 一致.*1 范围外/);
  const workerStatus = buildScopeStatuses(inventories, "server-server", ["."], new Set(), ledger);
  assert.equal(workerStatus["code.py"].state, "same");
  assert.equal(workerStatus["results/weight.bin"].state, "unknown");
  assert.match(workerStatus["results/weight.bin"].detail, /w1 文件校验期间发生变化，待重试/);
  assert.equal(workerStatus["results"].unverified, true);
  assert.match(workerStatus["."].detail, /1 未确认/);
});

test("automatic synchronization refuses incomplete content inventories", () => {
  const complete = { files: { "code.py": file("a") }, unverifiedFiles: {} };
  assert.equal(requireCompleteScopeInventory(complete), complete);
  assert.throws(() => requireCompleteScopeInventory({ files: {}, unverifiedFiles: { "model.bin": "文件校验期间发生变化" } }), /model\.bin/);
  assert.throws(() => requireCompleteScopeInventory({ files: {}, unverifiedFiles: { "code": "不是普通文件" } }, "Worker nwpu2"), /Worker nwpu2.*code：不是普通文件/);
});
