const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function compile(source, globals = {}) {
  const loaded = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: loaded, exports: loaded.exports, require, ...globals });
  return loaded.exports;
}
const source = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const feature = compile(fs.readFileSync(path.join(__dirname, "../../src/features/PlanArtifactSyncStatus.ts"), "utf8"));
const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const workers = ["worker-a", "worker-b", "worker-c"];
const required = ["best_model.pth", "test_results/formal_result_rows.csv"];
function plan(id = "B", enqueuedAt = "2026-10-07T10:00:00Z") {
  return { id, planFile: "experiments/plans/comparison/ebmc.yaml", revision: "r1", enqueuedAt, fullPlanJobCount: 6,
    jobs: Array.from({ length: 6 }, (_, index) => ({ index, case: index < 3 ? "bus" : "pad", seed: 42 + index % 3,
      attempt: 1, status: "completed", workerId: workers[index % 3], commandId: `${id}-${index}`,
      outputDir: `work_dirs/ebmc/${index}/attempts/${id}` })) };
}
function inventory(run) {
  return Object.fromEntries(run.jobs.flatMap(job => [...required, "stdout.log"].map(file => [`${job.outputDir}/${file}`, hash])));
}
const metadata = [{ file: plan().planFile, revision: "r1", cases: ["bus", "pad"], seeds: [42, 43, 44] }];

test("latest full current-revision rerun supersedes old sync receipts even without artifact ledger hashes", () => {
  const a = plan("A", "2026-10-06T10:00:00Z");
  const b = plan();
  a.jobs.forEach(job => { job.artifacts = { [`${job.outputDir}/best_model.pth`]: hash }; job.mirroredWorkerIds = workers; });
  const selected = feature.latestCompletePlansForSyncCheck({ plans: [b, a] }, metadata);
  assert.deepEqual(Array.from(selected, row => row.id), ["B"]);
  assert.notEqual(feature.planArtifactSyncCheckKey([a], workers, workers), feature.planArtifactSyncCheckKey([b], workers, workers));
  assert.equal(feature.latestCompletePlansForSyncCheck({ plans: [a, b] }, [{ ...metadata[0], revision: "r2" }]).length, 0);
  const partial = { ...b, jobs: b.jobs.slice(0, 3) };
  assert.equal(feature.latestCompletePlansForSyncCheck({ plans: [partial] }, metadata).length, 0);
  const conflict = { ...b, jobs: b.jobs.map((job, index) => ({ ...job, recoveryConflict: index === 0 })) };
  assert.equal(feature.latestCompletePlansForSyncCheck({ plans: [conflict] }, metadata).length, 0);
});

test("complete directory equality includes weights and logs; old run or metrics-only mirrors stay partial", () => {
  const run = plan();
  const complete = inventory(run);
  const all = new Map(workers.map(id => [id, { ...complete }]));
  assert.equal(feature.assessPlanArtifactSync(run, workers, all, required).status, "synced");
  const resultOnly = { ...complete };
  for (const job of run.jobs.filter(job => job.workerId !== "worker-c")) delete resultOnly[`${job.outputDir}/best_model.pth`];
  all.set("worker-c", resultOnly);
  const missingWeight = feature.assessPlanArtifactSync(run, workers, all, required);
  assert.equal(missingWeight.status, "partial");
  assert.equal(missingWeight.syncedCount, 2);
  assert.deepEqual(Array.from(missingWeight.pendingWorkerIds), ["worker-c"]);
  all.set("worker-c", { ...complete, [run.jobs[0].outputDir + "/stdout.log"]: otherHash });
  assert.equal(feature.assessPlanArtifactSync(run, workers, all, required).status, "partial");
  all.set("worker-c", { ...inventory(plan("A")), ...Object.fromEntries(Object.entries(complete).filter(([file]) => run.jobs.some(job => job.workerId === "worker-c" && file.startsWith(job.outputDir + "/")))) });
  assert.equal(feature.assessPlanArtifactSync(run, workers, all, required).status, "partial");
});

test("offline or missing sources and stale hashes never become globally synced, and status stays lightweight", () => {
  const run = plan();
  const all = new Map(workers.map(id => [id, inventory(run)]));
  all.delete("worker-a");
  const offline = feature.assessPlanArtifactSync(run, workers, all, required);
  assert.equal(offline.status, "unknown");
  assert.equal(offline.syncedCount, 0);
  all.set("worker-a", {});
  assert.equal(feature.assessPlanArtifactSync(run, workers, all, required).status, "unknown");
  all.set("worker-a", inventory(run));
  run.jobs[0].artifacts = { [`${run.jobs[0].outputDir}/best_model.pth`]: otherHash };
  assert.equal(feature.assessPlanArtifactSync(run, workers, all, required).status, "unknown");
  assert.doesNotMatch(JSON.stringify(offline), /work_dirs|jobs|artifacts|outputDir/);
  assert.ok(Buffer.byteLength(JSON.stringify(offline)) < 1000);
});

test("legacy reused directories need run-bound artifact evidence instead of treating old identical files as a new run", () => {
  const run = plan();
  run.jobs.forEach(job => { job.outputDir = `work_dirs/ebmc/${job.index}`; });
  const all = new Map(workers.map(id => [id, inventory(run)]));
  assert.equal(feature.assessPlanArtifactSync(run, workers, all, required).status, "unknown");
  run.jobs.forEach(job => { job.artifacts = Object.fromEntries(required.map(file => [`${job.outputDir}/${file}`, hash])); });
  assert.equal(feature.assessPlanArtifactSync(run, workers, all, required).status, "synced");
});

function hostFixture() {
  const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
  const provider = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === "RealtimeTunnelPanelProvider");
  const methods = new Set(["queuePlanArtifactSyncStatusCheck", "refreshPlanArtifactSyncStatus", "withManualResultSync"]);
  const members = provider.members.filter(node => methods.has(node.name?.getText(ast))
    || node.name?.getText(ast).startsWith("planArtifactSyncStatus"));
  const clock = { now: Date.now() };
  const scope = { root: "D:/MultiModal", reads: [], posts: 0, active: 0, peak: 0 };
  const Host = compile(`export class Host { ${members.map(node => node.getText(ast)).join("\n")} }`, {
    PlanArtifactSyncStatus: feature, workspaceRoot: () => scope.root,
    Date: class extends Date { static now() { return clock.now; } },
    errorMessage: error => String(error.message || error), console,
    mapLimited: async (items, limit, work) => {
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) await work(items[index++]);
      }));
    },
  }).Host;
  const host = new Host();
  Object.assign(host, {
    distributedQueueRoot: scope.root, distributedQueueCache: { plans: [plan()] }, projectContextGeneration: 1, client: {},
    localPlanMetadata: { plans: metadata }, manualResultSyncCounts: new Map(), cacheCleanupConnectionKey: "connected",
    lastWorkerProbes: Object.fromEntries(workers.map(id => [id, { status: "ok" }])),
    isRealtimeMode: () => true, workerCodeSyncTargets: () => workers.map(id => ({ id, remotePath: "/project" })),
    distributedProjectContract: () => ({ requiredPaths: required }), sftpServerOptions: target => target,
    postState: () => scope.posts++, distributedOutputHashes: async (target, paths, _report, includeContents) => {
      scope.reads.push({ id: target.id, paths: [...paths], includeContents });
      scope.peak = Math.max(scope.peak, ++scope.active);
      await Promise.resolve(); scope.active--;
      return Object.fromEntries(host.distributedQueueCache.plans.flatMap(run => Object.entries(inventory(run))));
    },
  });
  return { host, scope, clock };
}

test("startup reads once per Worker, progress ticks reuse it, rerun completion and revision/config changes refresh it", async () => {
  const { host, scope } = hostFixture();
  await host.refreshPlanArtifactSyncStatus();
  assert.equal(scope.reads.length, 3);
  assert.ok(scope.peak <= 2);
  assert.ok(scope.reads.every(row => row.paths.length === 6 && row.includeContents));
  assert.equal(host.planArtifactSyncStatuses.B.status, "synced");
  for (let index = 0; index < 20; index++) {
    host.distributedQueueCache = { plans: host.distributedQueueCache.plans.map(run => ({ ...run, lastProgress: index })) };
    await host.refreshPlanArtifactSyncStatus();
  }
  assert.equal(scope.reads.length, 3, "500ms queue ticks must not hash stable history again");
  host.distributedQueueCache = { plans: [plan(), plan("C", "2026-10-07T11:00:00Z")] };
  await host.refreshPlanArtifactSyncStatus();
  assert.equal(scope.reads.length, 6);
  assert.equal(host.planArtifactSyncStatuses.C.status, "synced");
  assert.equal(host.planArtifactSyncStatuses.B, undefined);
  host.localPlanMetadata = { plans: [{ ...metadata[0], revision: "r2" }] };
  await host.refreshPlanArtifactSyncStatus();
  assert.equal(Object.keys(host.planArtifactSyncStatuses).length, 0);
  host.localPlanMetadata = { plans: metadata };
  await host.refreshPlanArtifactSyncStatus();
  host.localPlanMetadata = { ...host.localPlanMetadata, detectedProject: { changed: true } };
  host.distributedProjectContract = () => ({ requiredPaths: [...required, "required-new-file"] });
  await host.refreshPlanArtifactSyncStatus();
  assert.equal(host.planArtifactSyncStatuses.C.status, "unknown");
});

test("a forced refresh during a read or manual sync is retained and deferred until that work ends", async () => {
  const { host, scope } = hostFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = host.distributedOutputHashes;
  host.distributedOutputHashes = async (...args) => { await gate; return original(...args); };
  const first = host.refreshPlanArtifactSyncStatus();
  await host.refreshPlanArtifactSyncStatus(true);
  release(); await first;
  await host.planArtifactSyncStatusPromise;
  assert.equal(scope.reads.length, 6, "one forced follow-up after the first check");
  await host.withManualResultSync(async () => {
    await host.refreshPlanArtifactSyncStatus(true);
    assert.equal(scope.reads.length, 6, "no competing scan while transfer is active");
  });
  await host.planArtifactSyncStatusPromise;
  assert.equal(scope.reads.length, 9);
});

test("transient inventory failures use bounded backoff; stale project reads cannot publish", async () => {
  const { host, scope, clock } = hostFixture();
  const original = host.distributedOutputHashes;
  host.distributedOutputHashes = async () => { throw new Error("temporarily unavailable"); };
  await host.refreshPlanArtifactSyncStatus();
  assert.equal(host.planArtifactSyncStatuses.B.status, "unknown");
  const retryAt = host.planArtifactSyncStatusRetryAt;
  assert.equal(retryAt, clock.now + 60000);
  host.distributedOutputHashes = original;
  await host.refreshPlanArtifactSyncStatus();
  assert.equal(scope.reads.length, 0);
  clock.now = retryAt;
  await host.refreshPlanArtifactSyncStatus();
  assert.equal(host.planArtifactSyncStatuses.B.status, "synced");
  host.distributedOutputHashes = async () => { scope.root = "D:/Other"; host.projectContextGeneration++; return {}; };
  const before = scope.posts;
  await host.refreshPlanArtifactSyncStatus(true);
  assert.equal(scope.posts, before + 1, "only initial checking post, no obsolete final result");
  assert.notEqual(host.planArtifactSyncStatuses.B.status, "synced");
});

test("an unreadable queue cannot prove the latest run from a last-known-good display snapshot", async () => {
  const { host, scope } = hostFixture();
  await host.refreshPlanArtifactSyncStatus();
  assert.equal(host.planArtifactSyncStatuses.B.status, "synced");
  host.distributedQueueStorageDiagnostics = { status: "stale" };
  await host.refreshPlanArtifactSyncStatus();
  assert.equal(scope.reads.length, 3, "do not hash a snapshot whose latest-run identity is uncertain");
  assert.equal(host.planArtifactSyncStatuses.B.status, "unknown");
  host.distributedQueueStorageDiagnostics = { status: "ready" };
  await host.refreshPlanArtifactSyncStatus();
  assert.equal(scope.reads.length, 6);
  assert.equal(host.planArtifactSyncStatuses.B.status, "synced");
});
