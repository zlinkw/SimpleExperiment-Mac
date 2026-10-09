const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const retention = require("../../dist/features/PlanOutputRetention.js");
const queueApi = require("../../dist/features/DistributedPlanQueue.js");
const freshness = require("../../dist/results/PlanRunFreshness.js");
const required = ["best_model.pth", "test_results/formal_result_rows.csv"];
const hash = "a".repeat(64);
const root = "/srv/research";

function plan(id, time, options = {}) {
  const count = options.count ?? 6;
  return { id, planFile: "experiments/plans/model.yaml", revision: options.revision || "r1", codeFingerprint: options.codeFingerprint ?? "fp",
    enqueuedAt: new Date(time).toISOString(), planJobCount: count, fullPlanJobCount: options.fullCount ?? 6,
    jobs: Array.from({ length: count }, (_, index) => {
      const outputDir = `work_dirs/model/case-${index}/attempts/${id}`;
      return { index, case: `case-${index}`, seed: index + 1, attempt: 1, outputDir,
        workerId: "worker-a", commandId: `${id}-${index}`, status: options.status || "completed",
        mirroredWorkerIds: ["worker-a", "worker-b"], fragmentWorkerIds: ["worker-a", "worker-b"],
        artifacts: Object.fromEntries(required.map((file) => [`${outputDir}/${file}`, hash])) };
    }) };
}
const queue = (...plans) => ({ schemaVersion: 1, plans });
const ids = (plans) => plans.map((row) => row.id);
function proof(candidate, exists = true) {
  const absolutePath = `${root}/${candidate.outputDir}`;
  return { exists, safeForDeletion: true, type: "directory", remoteRoot: root, relativePath: candidate.outputDir,
    absolutePath, parent: path.posix.dirname(absolutePath), child: `./${path.posix.basename(absolutePath)}`,
    fingerprint: (exists ? "a" : "b").repeat(64), bytes: exists ? 100 : 0, fileCount: exists ? 2 : 0 };
}

test("only the latest complete run is mirrored; older same-revision artifacts never reappear", () => {
  const a = plan("run-a", 1000), b = plan("run-b", 2000);
  assert.deepEqual(ids(retention.plansForOutputSync(queue(a, b))), ["run-b"]);
  const obsolete = retention.outputRetirementCandidates(queue(a, b), [b.id], required);
  assert.equal(obsolete.length, 6);
  assert.ok(obsolete.every((row) => row.outputDir.endsWith("/run-a") && row.replacementRunId === "run-b"));
  assert.deepEqual(ids(retention.plansForOutputSync(queue(a, b))), ["run-b"]);
});

test("a failed, running, partial or unverified replacement keeps the previous complete generation", () => {
  for (const options of [{ status: "failed" }, { status: "running" }, { count: 2, fullCount: 6 }]) {
    const a = plan("run-a", 1000), b = plan("run-b", 2000, options);
    assert.deepEqual(ids(retention.plansForOutputSync(queue(a, b))), ["run-a", "run-b"]);
    assert.equal(freshness.selectLatestCompletePlanRun(queue(a, b), a.planFile).runId, "run-a");
    assert.deepEqual(retention.outputRetirementCandidates(queue(a, b), [b.id], required), []);
  }
  const a = plan("run-a", 1000), b = plan("run-b", 2000);
  b.jobs[0].artifacts = {};
  assert.deepEqual(retention.outputRetirementCandidates(queue(a, b), [b.id], required), []);
});

test("changed code or Plan config keeps its older complete results and newer staging is protected", () => {
  const a = plan("run-a", 1000), b = plan("run-b", 2000, { revision: "r2" }), c = plan("run-c", 3000, { status: "running" });
  const obsolete = retention.outputRetirementCandidates(queue(a, b, c), [b.id], required);
  assert.deepEqual(obsolete, []);
  const changed = plan("run-d", 4000, { codeFingerprint: "new-code" });
  assert.deepEqual(retention.outputRetirementCandidates(queue(a, changed), [changed.id], required), []);
  const unknown = plan("run-unknown", 5000, { codeFingerprint: "" });
  assert.deepEqual(retention.outputRetirementCandidates(queue(a, unknown), [unknown.id], required), []);
  assert.deepEqual(ids(retention.plansForOutputSync(queue(a, b, c))), ["run-b", "run-c"]);
});

test("only more than five distinct retained versions require review; same-code reruns are one version", () => {
  const versions = Array.from({ length: 6 }, (_, index) => plan(`v${index}`, 1000 + index, { codeFingerprint: `code-${index}` }));
  assert.deepEqual(retention.outputVersionReview(queue(...versions.slice(0, 5))), []);
  const repeated = plan("v5-again", 2000, { codeFingerprint: "code-5" });
  const report = retention.outputVersionReview(queue(...versions, repeated));
  assert.equal(report.length, 1);
  assert.equal(report[0].versionCount, 6);
  assert.deepEqual(report[0].olderRunIds, ["v0"]);
  const older = retention.outputRetirementCandidates(queue(...versions, repeated), [repeated.id], required);
  assert.ok(older.every(row => row.outputDir.endsWith("/v5")));
  const reviewed = retention.outputRetirementCandidates(queue(...versions, repeated), [repeated.id], required, report[0].olderRunIds);
  assert.equal(reviewed.length, 12);
  assert.ok(reviewed.every(row => ["v0", "v5"].some(id => row.outputDir.endsWith('/' + id))));
  const latest = retention.markOutputsRetired(queue(...versions, repeated), reviewed.find(row => row.outputDir.endsWith('/v0')), 'now');
  // One retired job does not make the whole version disappear while its other outputs exist.
  assert.equal(retention.outputVersionReview(latest)[0].versionCount, 6);
});

test("unknown version evidence never implies same code and active older versions cannot become deletion candidates", () => {
  const a = plan("a", 1000, { codeFingerprint: "" }), b = plan("b", 2000, { codeFingerprint: "" });
  assert.deepEqual(retention.outputRetirementCandidates(queue(a, b), [b.id], required), []);
  const active = plan("active", 500, { status: "running", codeFingerprint: "old" });
  assert.deepEqual(retention.outputRetirementCandidates(queue(active, b), [b.id], required, ['active']), []);
});

test("a version leaves the review only when all of its attempt outputs have been retired", () => {
  const versions = Array.from({ length: 6 }, (_, index) => plan(`v${index}`, 1000 + index, { codeFingerprint: `code-${index}` }));
  let state = queue(...versions);
  const oldest = retention.outputRetirementCandidates(state, ['v5'], required, ['v0']);
  for (const candidate of oldest) state = retention.markOutputsRetired(state, candidate, 'now');
  assert.deepEqual(retention.outputVersionReview(state), []);
  assert.ok(state.plans[0].jobs.every(job => job.outputRetiredAt));
  assert.ok(state.plans[1].jobs.every(job => !job.outputRetiredAt));
});

test("retiring is scoped to exact attempt leaves, including superseded job retries", () => {
  const b = plan("run-b", 2000);
  b.jobs[0].history = [{ attempt: 1, status: "failed", workerId: "worker-a", outputDir: "work_dirs/model/case-0/attempts/old-retry" }];
  const obsolete = retention.outputRetirementCandidates(queue(b), [b.id], required);
  assert.equal(obsolete.length, 1);
  for (const target of ["work_dirs", "work_dirs/model", "work_dirs/model/case", "/work_dirs/model/attempts/a", "work_dirs/model/attempts/../a", "work_dirs/model/attempts/*", "work_dirs/model/attempts/a/link", "experiments/results/attempts/a"])
    assert.equal(retention.isAttemptOutputDir(target), false, target);
  const legacy = plan("old", 1000);
  delete b.fullPlanJobCount;
  assert.deepEqual(retention.outputRetirementCandidates(queue(legacy, b), [b.id], required), []);
});

test("ambiguous cross-Plan ownership blocks cleanup", () => {
  const a = plan("run-a", 1000), b = plan("run-b", 2000), other = plan("other", 3000);
  other.planFile = "experiments/plans/other.yaml";
  other.jobs[0].outputDir = a.jobs[0].outputDir;
  assert.throws(() => retention.outputRetirementCandidates(queue(a, b, other), [b.id], required), /其他 Plan/);
});

test("legacy counts require matching config revision; a 2-job missing-only run never replaces a 6-job complete run", () => {
  const a = plan("a", 1000), b = plan("b", 2000, { count: 2 });
  delete a.fullPlanJobCount;
  delete b.fullPlanJobCount;
  const original = queue(a, b);
  const current = { planFile: a.planFile, revision: "r1", cases: ["bus", "pad"], seeds: [1, 2, 3] };
  const upgraded = retention.withValidatedPlanJobCounts(original, [current]);
  assert.equal(upgraded.plans[0].fullPlanJobCount, 6);
  assert.equal(upgraded.plans[1].fullPlanJobCount, 6);
  assert.equal(freshness.selectLatestCompletePlanRun(upgraded, a.planFile).runId, "a");
  assert.deepEqual(retention.outputRetirementCandidates(upgraded, ["b"], required), []);
  assert.equal(original.plans[0].fullPlanJobCount, undefined);
  const mismatched = retention.withValidatedPlanJobCounts(original, [{ ...current, revision: "new-revision" }]);
  assert.equal(mismatched.plans[0].fullPlanJobCount, undefined);
});

test("cold queue recovery preserves the full count and a retired output cannot be resurrected by an old snapshot", () => {
  const b = plan("b", Date.now(), { count: 2, fullCount: 6 });
  const projectId = queueApi.canonicalProjectId("C:/project");
  const now = Date.now();
  const tasks = b.jobs.map((job) => ({ ...job, projectId, workflowId: b.id, planFile: b.planFile, planRevision: b.revision,
    codeFingerprint: b.codeFingerprint, planJobCount: 2, fullPlanJobCount: 6, enqueuedAt: b.enqueuedAt, experimentIndex: job.index, runKey: job.commandId }));
  const snapshot = { workerId: "worker-a", capabilities: { durablePlanQueue: true, schemaVersion: 1 },
    generatedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(), tasks };
  const recovered = queueApi.mergeDurableWorkerSnapshots(queueApi.emptyDistributedQueue(), [snapshot], projectId, now);
  assert.equal(recovered.plans[0].planJobCount, 2);
  assert.equal(recovered.plans[0].fullPlanJobCount, 6);
  recovered.plans[0].jobs[0].outputRetiredAt = "now";
  const refreshed = queueApi.mergeDurableWorkerSnapshots(recovered, [snapshot], projectId, now);
  assert.equal(refreshed.plans[0].jobs[0].outputRetiredAt, "now");
  assert.equal(freshness.selectLatestCompletePlanRun(refreshed, b.planFile), undefined);
});

test("retirement leaves history identities and the working-copy disk baseline intact", () => {
  const original = queueApi.setDistributedQueueBaseSignature(queue(plan("a", 1000), plan("b", 2000)), "base");
  const candidate = retention.outputRetirementCandidates(original, ["b"], required)[0];
  const retired = retention.markOutputsRetired(original, candidate, "now");
  assert.equal(queueApi.distributedQueueBaseSignature(retired), "base");
  assert.equal(original.plans[0].jobs[0].outputRetiredAt, undefined);
  assert.equal(retired.plans[0].jobs[0].commandId, original.plans[0].jobs[0].commandId);
  assert.equal(retired.plans[0].jobs[0].status, "completed");
  assert.equal(retired.plans[0].jobs[0].artifacts, undefined);
  assert.equal(queueApi.completedJobOutputs(queue(retired.plans[0]), retired.plans[0].planFile, [retired.plans[0].jobs[0]]).length, 0);
  assert.deepEqual(retired.plans[1], original.plans[1]);
});

function fixture(options = {}) {
  const candidates = retention.outputRetirementCandidates(queue(plan("a", 1000), plan("b", 2000)), ["b"], required).slice(0, 2);
  const removed = new Set(), calls = [], inspections = new Map();
  const ports = { workerIds: ["worker-a", "worker-b"],
    async assertCurrent() { calls.push("assert"); if (options.stale) throw new Error("stale authority"); },
    async inspect(candidate, workerId) {
      const key = workerId + ":" + candidate.outputDir;
      const count = (inspections.get(key) || 0) + 1;
      inspections.set(key, count);
      calls.push("inspect:" + key);
      const value = proof(candidate, !removed.has(key));
      if (options.changed && count === 2) value.fingerprint = "c".repeat(64);
      return value;
    },
    async confirm(records) { calls.push("confirm"); assert.equal(records.length, 4); return !options.cancel; },
    async hold(candidate) { calls.push("hold:" + candidate.outputDir); },
    async remove(record) { calls.push("delete:" + record.outputDir); if (options.fail) throw new Error("delete failed"); removed.add(record.workerId + ":" + record.outputDir); },
    async retired(candidate) { calls.push("retired:" + candidate.outputDir); },
  };
  return { candidates, ports, calls, removed };
}

test("cancelled review and a stale authority cannot delete or create holds", async () => {
  const cancelled = fixture({ cancel: true });
  assert.equal((await retention.retirePlanOutputs(cancelled.candidates, cancelled.ports)).cancelled, true);
  assert.ok(!cancelled.calls.some((value) => /^(delete|hold|retired):/.test(value)));
  const stale = fixture({ stale: true });
  await assert.rejects(retention.retirePlanOutputs(stale.candidates, stale.ports), /stale/);
  assert.equal(stale.removed.size, 0);
});

test("every target is revalidated before any delete, and failures halt the batch", async () => {
  const changed = fixture({ changed: true });
  await assert.rejects(retention.retirePlanOutputs(changed.candidates, changed.ports), /审核期间发生变化/);
  assert.ok(!changed.calls.some((value) => /^(delete|hold):/.test(value)));
  const failed = fixture({ fail: true });
  await assert.rejects(retention.retirePlanOutputs(failed.candidates, failed.ports), /delete failed/);
  assert.equal(failed.calls.filter((value) => value.startsWith("delete:")).length, 1);
  assert.ok(!failed.calls.some((value) => value.startsWith("retired:")));
});

test("verified cleanup records all mirrors as absent before retiring each directory", async () => {
  const f = fixture();
  assert.deepEqual(await retention.retirePlanOutputs(f.candidates, f.ports), { retired: 2, copies: 4, bytes: 400, cancelled: false });
  assert.equal(f.removed.size, 4);
  assert.equal(f.calls.filter((value) => value.startsWith("retired:")).length, 2);
});

test("an inspection must bind a real configured root, exact parent and immutable directory type", () => {
  const candidate = fixture().candidates[0];
  retention.validateOutputInspection(candidate, proof(candidate), root);
  for (const change of [{ remoteRoot: "/other" }, { parent: root }, { child: candidate.outputDir }, { type: "file" }, { safeForDeletion: false }, { bytes: -1 }, { fingerprint: "" }])
    assert.throws(() => retention.validateOutputInspection(candidate, { ...proof(candidate), ...change }, root), /安全检查/);
});

test("Host uses the double-confirm review and guarded SimpleSFTP deletion; keep-history does nothing", async () => {
  const source = fs.readFileSync(require.resolve("../../dist/extension/legacy.js"), "utf8");
  const start = source.indexOf("planOutputRetentionMode(root) {");
  const end = source.indexOf("async retryDistributedJobFromUi(message)", start);
  assert.ok(start >= 0 && end > start);
  const methods = source.slice(start, end).trim();
  let state = queue(plan("a", 1000), plan("b", 2000));
  const removed = new Set(), apiCalls = [], holds = {}, errors = [];
  let mode = "latest-complete", reviews = 0, expectedCopies = 12, published = true;
  const sandbox = { PlanOutputRetention: retention, PlanRunFreshness: freshness, PlanVersionComparison: require('../../dist/results/PlanVersionComparison'),
    remoteActionPendingStatus: (status) => ["accepted", "running"].includes(status), resultStatus: (value) => value.status,
    remoteActionSucceeded: (status) => status === "completed",
    vscode: { workspace: { getConfiguration: () => ({ get: () => mode }) }, Uri: { file: (value) => value }, window: { showInformationMessage() {} } },
    workspaceRoot: () => "C:/project", compactSensitiveText: (value) => value, errorMessage: (value) => value.message,
    confirmSyncScopePaths: async (title, note, records, label) => { reviews++; assert.equal(records.length, expectedCopies); assert.match(label, /永久删除/); assert.ok(records.every((row) => row.path.startsWith(root + "/"))); return true; },
  };
  sandbox.SyncScopeConfirmation_1 = { confirmSyncScopePaths: sandbox.confirmSyncScopePaths,
    reviewPlanVersionResults: async (_runs, candidates) => candidates.filter(row => ['/v0', '/v5'].some(leaf => row.outputDir.endsWith(leaf))) };
  vm.createContext(sandbox);
  vm.runInContext(`class Subject { ${methods} }; this.methods = Object.fromEntries(Object.getOwnPropertyNames(Subject.prototype).filter(name => name !== 'constructor').map(name => [name, Subject.prototype[name]]));`, sandbox);
  const host = { ...sandbox.methods,
    client: { async postWorkerAction(id, action, payload) { assert.equal(action, "preview-cache-cleanup"); const candidate = { outputDir: payload.planOutputPaths[0] }; return { status: "completed", payload: { planOutputs: [proof(candidate, !removed.has(id + ":" + candidate.outputDir))] } }; } },
    distributedProjectContract: () => ({ requiredPaths: required }),
    workerCodeSyncTargets: () => [{ id: "worker-a" }, { id: "worker-b" }],
    sftpServerOptions: (target) => ({ id: target.id, host: target.id + ".invalid", user: "researcher", port: 22, remotePath: root }),
    lastWorkerProbes: { "worker-a": { status: "ok" }, "worker-b": { status: "ok" } },
    async loadDistributedQueue() { return queueApi.cloneDistributedQueue(state); },
    async loadProjectTableRegistry() { return { plans: published ? { [state.plans.at(-1).planFile]: { wrapperEvidence: { status: 'formal', runId: state.plans.at(-1).id } } } : {} }; },
    async saveDistributedQueue(_root, value) { state = value; },
    distributedOutputHashes: async (_source, paths) => Object.fromEntries(paths.map((file) => [file, hash])),
    async assertSshTransportIdentities() {},
    async updateSyncScopeHolds(_root, fn) { fn(holds); },
    async simpleSftpApiCall(method, params) { assert.equal(method, "sync.deletePath"); apiCalls.push(params); removed.add(params.target.id + ":" + params.relativePath); },
    recordActionError(value) { errors.push(value); }, postState() {},
  };
  await host.retainLatestDistributedPlanOutputs("C:/project", ["b"]);
  assert.deepEqual(errors, []);
  assert.equal(reviews, 1);
  assert.equal(apiCalls.length, 12);
  assert.ok(apiCalls.every((value) => value.confirm && value.pathConfirmed && value.secondConfirmation && value.confirmedAbsolutePath === root + "/" + value.relativePath));
  assert.equal(Object.keys(holds).length, 6);
  assert.ok(state.plans[0].jobs.every((job) => job.outputRetiredAt && !job.artifacts));
  assert.ok(state.plans[1].jobs.every((job) => !job.outputRetiredAt && job.artifacts));
  mode = "keep-history";
  await host.retainLatestDistributedPlanOutputs("C:/project", ["b"]);
  assert.equal(apiCalls.length, 12);
  mode = "latest-complete";
  state = queue(...Array.from({ length: 6 }, (_, index) => plan(`v${index}`, 1000 + index, { codeFingerprint: `code-${index}` })),
    plan('v5-again', 2000, { codeFingerprint: 'code-5' }));
  expectedCopies = 24;
  await host.retainLatestDistributedPlanOutputs('C:/project', ['v5-again'], ['v0'], true);
  assert.deepEqual(errors, []);
  assert.equal(apiCalls.length, 36);
  assert.ok(state.plans[0].jobs.every(job => job.outputRetiredAt));
  assert.ok(state.plans.slice(1, 5).every(plan => plan.jobs.every(job => !job.outputRetiredAt)));
  assert.ok(state.plans[5].jobs.every(job => job.outputRetiredAt));
  assert.ok(state.plans[6].jobs.every(job => !job.outputRetiredAt));
  state = queue(plan('not-yet-a', 5000), plan('not-yet-b', 6000));
  published = false;
  await host.retainLatestDistributedPlanOutputs('C:/project', ['not-yet-b']);
  assert.equal(apiCalls.length, 36, 'a completed but unpublished replacement must keep the old complete results');
  assert.match(errors.at(-1).message, /尚未正式收录/);
});

test('version notifications are read-only, deduplicated and open the existing review only on user choice', async () => {
  const source = fs.readFileSync(require.resolve('../../dist/extension/legacy.js'), 'utf8');
  const methods = source.slice(source.indexOf('planOutputRetentionMode(root) {'), source.indexOf('async retryDistributedJobFromUi(message)'));
  let currentRoot = 'C:/project', choice;
  const warnings = [], reviewed = [], errors = [];
  let state = queue(...Array.from({ length: 6 }, (_, index) => plan(`v${index}`, 1000 + index, { codeFingerprint: `code-${index}` })));
  const sandbox = { PlanOutputRetention: retention, PlanArtifactSyncStatus: require('../../dist/features/PlanArtifactSyncStatus'),
    workspaceRoot: () => currentRoot, errorMessage: error => error.message,
    vscode: { Uri: { file: value => value }, workspace: { getConfiguration: () => ({ get: () => 'latest-complete' }) },
      window: { showWarningMessage: async (message, action) => { warnings.push({ message, action }); return choice; } } } };
  vm.createContext(sandbox);
  vm.runInContext(`class Subject { ${methods} }; this.Subject = Subject;`, sandbox);
  const host = Object.assign(new sandbox.Subject(), { distributedProjectContract: () => ({ requiredPaths: required }),
    loadPlanOutputRetentionQueue: async () => state,
    retainLatestDistributedPlanOutputs: async (...args) => reviewed.push(args), recordActionError: error => errors.push(error) });
  host.notifyPlanOutputVersionReview('C:/project', queue(...state.plans.slice(0, 5)));
  assert.equal(warnings.length, 0);
  host.notifyPlanOutputVersionReview('C:/project', state);
  host.notifyPlanOutputVersionReview('C:/project', state);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /超过 5/);
  assert.equal(reviewed.length, 0);
  choice = '审核和清理历史产物';
  state = queue(...state.plans, plan('v6', 3000, { codeFingerprint: 'code-6' }));
  host.notifyPlanOutputVersionReview('C:/project', state);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reviewed.length, 1);
  assert.deepEqual(Array.from(reviewed[0][1]), ['v6']);
  assert.deepEqual(Array.from(reviewed[0][2]), ['v0', 'v1']);
  assert.equal(reviewed[0][3], true);
  host.distributedQueueStorageDiagnostics = { status: 'stale' };
  state = queue(...state.plans, plan('v7', 4000, { codeFingerprint: 'code-7' }));
  host.notifyPlanOutputVersionReview('C:/project', state);
  assert.equal(warnings.length, 2);
  assert.deepEqual(errors, []);
  assert.match(source, /this\.notifyPlanOutputVersionReview\?\.\(root, queue\)/);
  assert.match(source, /this\.notifyPlanOutputVersionReview\?\.\(root, next\)/);
  assert.match(source, /this\.notifyPlanOutputVersionReview\?\.\(root, await this\.loadPlanOutputRetentionQueue\(root\)\)/);
});

test('cache review exposes the Plan history entry independently of temporary-file deletion', async () => {
  let handler, html, reviews = 0, disposed;
  const actions = [];
  const vscode = { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => ({
    webview: { set html(value) { html = value; }, postMessage: async () => true,
      onDidReceiveMessage: callback => { handler = callback; return { dispose() {} }; } },
    onDidDispose: callback => { disposed = callback; },
  }) } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../dist/extension/CacheCleanupPanel'), 'utf8'), {
    require: id => id === 'vscode' ? vscode : require(id), module, exports: module.exports, Buffer, process, console, AbortController,
  });
  module.exports.openCacheCleanupPanel(() => ({ generation: 1, endpoints: [],
    client: { postWorkerAction: async action => actions.push(action) }, reviewPlanOutputs: async () => reviews++ }));
  assert.match(html, /Plan 历史产物审核/);
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
  await handler({ type: 'planOutputs' });
  assert.equal(reviews, 1);
  assert.deepEqual(actions, []);
  disposed();
});

test("formal publication calls replacement only after rebuilding and mirroring the latest complete run", async () => {
  const source = fs.readFileSync(require.resolve("../../dist/extension/legacy.js"), "utf8");
  const start = source.indexOf("async rebuildDistributedResults(");
  const end = source.indexOf("planOutputRetentionMode(root)", start);
  assert.ok(start >= 0 && end > start);
  const sandbox = { PlanOutputRetention: retention, PlanRunFreshness: freshness, crypto: require("node:crypto"),
    uniqueStrings: (values) => [...new Set(values)], samePlanSelection: (a, b) => a === b,
    remoteActionPendingStatus: () => false, resultStatus: (value) => value.status, errorMessage: (error) => error.message,
    makeOpId: () => "distributed-merge-fixture",
    PlanArtifactTransfer_1: { workerFpsyncTaskLabel: () => "publish" }, workspaceRoot: () => "C:/project",
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end).replace("async rebuildDistributedResults(root, queue, previewOnly, verifyAll = false)",
    "async function rebuild(root, queue, previewOnly, verifyAll = false)") + "this.rebuild = rebuild;", sandbox);
  const events = [], errors = [];
  const host = {
    distributedProjectContract: () => ({ requiredPaths: required, fragmentPaths: required, configPath: "cfg", checkpointPath: "best_model.pth", resultRowsPath: required[1], fourStatePath: "four", mergeModule: "adapter.merge" }),
    workerCodeSyncTargets: () => [{ id: "worker-a" }, { id: "worker-b" }],
    lastWorkerProbes: { "worker-a": { status: "ok" }, "worker-b": { status: "ok" } },
    sftpServerOptions: (value) => ({ id: value.id }),
    client: { async postWorkerAction(_worker, action, payload) {
      assert.equal(action, "rebuild-distributed-results");
      assert.equal(payload.publish, true);
      assert.equal(payload.manifest.plans.length, 1);
      assert.equal(payload.manifest.plans[0].runId, "b");
      events.push("publish"); return { status: "completed", outputPaths: ["experiments/results/formal/model.csv"] };
    } },
    async patchDistributedPublication() { events.push("persist"); },
    async assertSshTransportIdentities() {},
    async simpleSftpApiCall() { events.push("mirror"); },
    distributedOutputHashes: async (_source, paths) => Object.fromEntries(paths.map((file) => [file, hash])),
    async retainLatestDistributedPlanOutputs(_root, runIds) { events.push("retire:" + runIds.join(",")); },
    recordActionError(value) { errors.push(value); },
  };
  await sandbox.rebuild.call(host, "C:/project", queue(plan("a", 1000), plan("b", 2000)), false);
  assert.deepEqual(errors, []);
  assert.equal(events.at(-1), "retire:b");
  assert.ok(events.indexOf("publish") < events.indexOf("mirror"));
  assert.ok(events.indexOf("mirror") < events.indexOf("retire:b"));
});

test("the read-only Worker proof rejects links, mounts, active attempts and content mutation", () => {
  const result = spawnSync("python", ["-X", "utf8", path.join(__dirname, "../fixtures/plan-output-retention-inspection.py")], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /inspection checks passed/);
});
