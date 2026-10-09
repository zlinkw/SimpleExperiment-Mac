const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const sync = require("../../dist/features/PlanArtifactSync.js");
const transfer = require("../../dist/features/PlanArtifactTransfer.js");

test("Plan sync ledger lives in plugin storage and is keyed by project root", () => {
  const storage = path.resolve("plugin-storage");
  const a = sync.planSyncLedgerStoragePath(storage, path.resolve("project-a"));
  const b = sync.planSyncLedgerStoragePath(storage, path.resolve("project-b"));
  assert.equal(path.dirname(a), path.join(storage, "plan-sync-ledgers"));
  assert.notEqual(a, b);
  assert.equal(a, sync.planSyncLedgerStoragePath(storage, path.resolve("project-a", ".")));
  assert.equal(path.dirname(sync.projectMirrorStateStoragePath(storage, path.resolve("project-a"))), path.dirname(a));
});

test("Plan artifact scope includes its output directory and declared result files only", () => {
  const paths = sync.planArtifactPaths({
    outputSignals: ["结果目录: work_dirs/corim", "结果目录: ../unsafe"],
    outputCandidates: ["experiments/results/formal/corim.csv", "*/metrics.csv", "experiments/results/other?.csv"],
  }, { workerResultTables: [
    { workerId: "nwpu2", rawResultCsvPath: "experiments/results/corim.csv" },
    { workerId: "nwpu3", rawResultCsvPath: "experiments/results/other.csv" },
  ] }, "nwpu2");
  assert.deepEqual(paths, ["experiments/results/corim.csv", "experiments/results/formal/corim.csv", "work_dirs/corim"]);
});

test("sync ledger retains disabled destinations until transfer succeeds", () => {
  let ledger = sync.queuePlanSync(sync.emptyPlanSyncLedger(), "plans/corim.yaml", "rev1", "nwpu2", ["work_dirs/corim"], ["nwpu2", "nwpu3", "nwpu5"]);
  const pending = sync.pendingPlanSyncs(ledger);
  assert.deepEqual(pending.map((item) => item.destinationWorkerId), ["nwpu3", "nwpu5"]);
  ledger = sync.markPlanSyncComplete(ledger, pending[0].key, "nwpu3", "2026-09-25T00:00:00Z");
  assert.deepEqual(sync.pendingPlanSyncs(ledger).map((item) => item.destinationWorkerId), ["nwpu5"]);
  ledger = sync.queuePlanSync(ledger, "plans/corim.yaml", "rev1", "nwpu2", ["experiments/results/corim.csv"], ["nwpu3", "nwpu5"]);
  assert.deepEqual(ledger.entries[pending[0].key].artifactPaths, ["experiments/results/corim.csv", "work_dirs/corim"]);
  assert.equal(ledger.entries[pending[0].key].destinations.nwpu3.status, "pending");
  ledger = sync.queuePlanSync(ledger, "plans/corim.yaml", "rev1", "nwpu2", ["work_dirs/corim"], ["nwpu3", "nwpu5"], ["work_dirs/corim"], "operation-2");
  assert.deepEqual(sync.pendingPlanSyncs(ledger).map((item) => item.entry.runId), ["operation-2", "operation-2"]);
});

test("old mirror sync records become pending for direct-path migration", () => {
  const old = { schemaVersion: 1, entries: { sample: {
    planFile: "plans/corim.yaml", revision: "rev1", runId: "old-run", sourceWorkerId: "nwpu2",
    artifactPaths: ["work_dirs/corim"], directoryPaths: ["work_dirs/corim"],
    destinations: { nwpu3: { status: "synced", syncedAt: "2026-09-25T00:00:00Z" } },
  } } };
  const migrated = sync.migratePlanSyncLedger(old);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.entries.sample.destinations.nwpu3.status, "pending");
});

test("new run records removed Plan paths for exact cleanup", () => {
  let ledger = sync.queuePlanSync(sync.emptyPlanSyncLedger(), "plans/corim.yaml", "rev1", "nwpu2", ["work_dirs/corim", "experiments/results/old.csv"], ["nwpu3"], ["work_dirs/corim"], "run-1");
  ledger = sync.queuePlanSync(ledger, "plans/corim.yaml", "rev2", "nwpu2", ["work_dirs/corim", "experiments/results/new.csv"], ["nwpu3"], ["work_dirs/corim"], "run-2");
  const latest = sync.pendingPlanSyncs(ledger)[0].entry;
  assert.deepEqual(latest.stalePaths, [{ path: "experiments/results/old.csv", directory: false }]);
  ledger = sync.queuePlanSync(ledger, "plans/corim.yaml", "rev3", "nwpu2", ["work_dirs/corim", "experiments/results/newer.csv"], ["nwpu3"], ["work_dirs/corim"], "run-3");
  assert.deepEqual(sync.pendingPlanSyncs(ledger)[0].entry.stalePaths, [
    { path: "experiments/results/old.csv", directory: false },
    { path: "experiments/results/new.csv", directory: false },
  ]);
});

test("older run logs remain available for project-wide content reconciliation", () => {
  let ledger = sync.queuePlanSync(sync.emptyPlanSyncLedger(), "plans/a.yaml", "r1", "nwpu2", ["work_dirs/a", "simple_cluster/tmp/cluster_scheduler/run-1.log"], ["nwpu3"], ["work_dirs/a"], "run-1");
  ledger = sync.queuePlanSync(ledger, "plans/a.yaml", "r2", "nwpu3", ["work_dirs/a", "simple_cluster/tmp/cluster_scheduler/run-2.log"], ["nwpu2"], ["work_dirs/a"], "run-2");
  assert.deepEqual(sync.pendingPlanSyncs(ledger)[0].entry.stalePaths, []);
});

test("a completed cross-Worker rerun supersedes older source transfers", () => {
  let ledger = sync.queuePlanSync(sync.emptyPlanSyncLedger(), "plans/corim.yaml", "rev1", "nwpu2", ["work_dirs/corim", "experiments/results/old.csv"], ["nwpu2", "nwpu3", "nwpu5"], ["work_dirs/corim"], "run-old");
  ledger = sync.queuePlanSync(ledger, "plans/corim.yaml", "rev2", "nwpu3", ["work_dirs/corim", "experiments/results/new.csv"], ["nwpu2", "nwpu3", "nwpu5"], ["work_dirs/corim"], "run-new");
  const pending = sync.pendingPlanSyncs(ledger);
  assert.deepEqual(pending.map((item) => item.destinationWorkerId), ["nwpu2", "nwpu5"]);
  assert.ok(pending.every((item) => item.entry.sourceWorkerId === "nwpu3"));
  assert.deepEqual(pending[0].entry.stalePaths, [{ path: "experiments/results/old.csv", directory: false }]);
});

test("SFTP transfers Plan outputs and weights directly to their original paths", async () => {
  const entry = {
    planFile: "plans/corim.yaml", revision: "rev1", runId: "operation-2", sourceWorkerId: "nwpu2",
    artifactPaths: ["work_dirs/corim", "experiments/results/corim.csv"],
    directoryPaths: ["work_dirs/corim"], destinations: { nwpu3: { status: "pending" } },
  };
  const source = { id: "nwpu2", host: "server2", user: "research", port: 22, remotePath: "/srv/nwpu2/project" };
  const destination = { id: "nwpu3", host: "server3", user: "research", port: 22, remotePath: "/srv/nwpu3/project" };
  const calls = [];
  const result = await transfer.transferPlanArtifacts(entry, source, destination, async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  });
  assert.equal(result.paths, 2);
  assert.deepEqual(calls.map((call) => call.method), ["sync.serverToServerFpsync", "sync.serverToServerFpsync"]);
  assert.equal(calls[0].params.relativePath, "work_dirs/corim");
  assert.equal(calls[0].params.directory, true);
  assert.match(calls[0].params.taskLabel, /Plan 完成产物同步/);
  assert.match(calls[0].params.taskLabel, /plans\/corim\.yaml/);
  assert.match(calls[0].params.taskLabel, /nwpu2 → nwpu3/);
  assert.match(calls[0].params.taskLabel, /work_dirs\/corim/);
  assert.equal(calls[0].params.taskLabel.includes("批次"), false);
  assert.deepEqual(calls[1].params.relativePaths, ["experiments/results/corim.csv"]);
  assert.equal(calls[1].params.directory, undefined);
  assert.match(calls[1].params.taskLabel, /experiments\/results\/corim\.csv/);
  assert.match(calls[1].params.taskLabel, /nwpu2 → nwpu3/);
  assert.deepEqual(transfer.directPlanSyncPreview(entry, source, destination), [
    "/srv/nwpu2/project/work_dirs/corim → /srv/nwpu3/project/work_dirs/corim",
    "/srv/nwpu2/project/experiments/results/corim.csv → /srv/nwpu3/project/experiments/results/corim.csv",
  ]);
  assert.ok(calls.every((call) => call.params.confirm && call.params.pathConfirmed));
});

test("file artifacts share one batch and stale deletes stay one confirmed call each", async () => {
  const entry = {
    planFile: "plans/corim.yaml", revision: "rev2", runId: "operation-3", sourceWorkerId: "nwpu2",
    artifactPaths: ["experiments/results/new.csv", "experiments/results/metrics.json", "work_dirs/corim"],
    directoryPaths: ["work_dirs/corim"],
    stalePaths: [
      { path: "experiments/results/old.csv", directory: false },
      { path: "work_dirs/retired", directory: true },
    ],
    destinations: { nwpu3: { status: "pending" } },
  };
  const source = { id: "nwpu2", host: "server2", user: "research", port: 22, remotePath: "/srv/nwpu2/project" };
  const destination = { id: "nwpu3", host: "tunnel", user: "research", port: 22, remotePath: "/srv/nwpu3/project", networkHost: "10.0.0.3" };
  const calls = [];
  const result = await transfer.transferPlanArtifacts(entry, source, destination, async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  });
  assert.equal(result.paths, 5);
  assert.deepEqual(calls.map((call) => call.method), [
    "sync.serverToServer", "sync.serverToServer", "sync.serverToServerFpsync", "sync.serverToServerFpsync",
  ]);
  assert.equal(calls[0].params.deleteOnly, true);
  assert.equal(calls[0].params.relativePath, "experiments/results/old.csv");
  assert.equal(calls[1].params.deleteOnly, true);
  assert.equal(calls[1].params.directory, true);
  assert.equal(calls[1].params.relativePath, "work_dirs/retired");
  assert.equal(calls[2].params.relativePath, "work_dirs/corim");
  assert.equal(calls[2].params.directory, true);
  assert.equal(calls[2].params.deleteOnly, undefined);
  assert.deepEqual(calls[3].params.relativePaths, ["experiments/results/metrics.json", "experiments/results/new.csv"]);
  assert.equal(calls[3].params.destination.host, "10.0.0.3");
  assert.ok(calls.every((call) => call.params.confirm && call.params.pathConfirmed));
});

test("fpsync task labels name the action and workers without credentials", () => {
  const label = transfer.workerFpsyncTaskLabel({
    action: "手动保留文件版本",
    sourceId: "nwpu2",
    destinationId: "nwpu5",
    detail: "experiments/results/corim.csv",
  });
  assert.match(label, /手动保留文件版本/);
  assert.match(label, /experiments\/results\/corim\.csv/);
  assert.match(label, /nwpu2 → nwpu5/);
  const secret = transfer.workerFpsyncTaskLabel({
    action: "项目文件补齐",
    sourceId: "nwpu2",
    destinationId: "nwpu3",
    detail: "password=hunter2 token=abc Bearer secret-value",
  });
  assert.equal(secret.length <= 180, true);
  assert.equal(/\r|\n/.test(secret), false);
  assert.match(secret, /password=<已遮蔽>/);
  assert.match(secret, /token=<已遮蔽>/);
  assert.match(secret, /Bearer <已遮蔽>/);
  assert.equal(/hunter2|token=abc|secret-value/.test(secret), false);
});

test("long fpsync labels keep the batch while dropping only free text", () => {
  const planFile = `plans/${"very-long-plan-directory/".repeat(8)}experiment.yaml`;
  const detail = `password=hunter2 token=abc Bearer raw-secret ${"experiments/results/nested-output/".repeat(6)}weights`;
  const label = transfer.workerFpsyncTaskLabel({
    action: "Plan 完成产物同步",
    planFile,
    job: "job 12 / seed 3",
    detail,
    sourceId: "nwpu2",
    destinationId: "nwpu3",
    batch: 2,
    batchCount: 4,
  });
  assert.equal(label.length <= 180, true);
  assert.match(label, /^Plan 完成产物同步/);
  assert.match(label, /nwpu2 → nwpu3/);
  assert.match(label, /批次 2\/4$/);
  assert.equal(/hunter2|token=abc|raw-secret/.test(label), false);
  assert.match(label, /password=<已遮蔽>/);
});

test("more than 5000 file artifacts stay inside the batch path limit", async () => {
  const artifactPaths = Array.from({ length: 5001 }, (_, index) => `experiments/results/file-${String(index).padStart(4, "0")}.csv`);
  const entry = {
    planFile: "plans/corim.yaml", revision: "rev3", runId: "operation-4", sourceWorkerId: "nwpu2",
    artifactPaths, directoryPaths: [], destinations: { nwpu3: { status: "pending" } },
  };
  const source = { id: "nwpu2", host: "server2", user: "research", port: 22, remotePath: "/srv/nwpu2/project" };
  const destination = { id: "nwpu3", host: "server3", user: "research", port: 22, remotePath: "/srv/nwpu3/project" };
  const calls = [];
  const result = await transfer.transferPlanArtifacts(entry, source, destination, async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  });
  assert.equal(result.paths, 5001);
  assert.deepEqual(calls.map((call) => call.method), ["sync.serverToServerFpsync", "sync.serverToServerFpsync"]);
  assert.equal(calls[0].params.relativePaths.length, 5000);
  assert.equal(calls[1].params.relativePaths.length, 1);
  assert.match(calls[0].params.taskLabel, /批次 1\/2/);
  assert.match(calls[0].params.taskLabel, /plans\/corim\.yaml/);
  assert.match(calls[0].params.taskLabel, /nwpu2 → nwpu3/);
  assert.match(calls[0].params.taskLabel, /file-0000\.csv/);
  assert.match(calls[1].params.taskLabel, /批次 2\/2/);
  assert.match(calls[1].params.taskLabel, /file-5000\.csv/);
  assert.equal(/password|token|Bearer|PRIVATE KEY/i.test(calls.map((call) => call.params.taskLabel).join(" ")), false);
});
