const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");
const compiledSource = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
function loadSourceModule(relativePath) {
  const filename = path.resolve(__dirname, "../..", relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(output, filename);
  return loaded.exports;
}
const start = source.indexOf("async resumePersistedDistributedQueue() {");
const end = source.indexOf("async deferDistributedPlan(", start);
assert.ok(start >= 0 && end > start);
const method = source.slice(start, end).replace("async resumePersistedDistributedQueue()", "async function resumePersistedDistributedQueue()");
const sandbox = { workspaceRoot: () => "C:/project", Object };
vm.createContext(sandbox);
vm.runInContext(method + "\nthis.resume = resumePersistedDistributedQueue;", sandbox);

test("activation reconnects and ticks a persisted Plan queue without opening the panel", async () => {
  const events = [];
  const provider = {
    distributedLaunchInFlight: new Set(),
    lastWorkerProbes: {},
    isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    loadDistributedQueue: async () => ({ plans: [{ jobs: [{ status: "pending" }] }] }),
    tickDistributedQueue: async () => { events.push("tick"); provider.lastWorkerProbes = { workerA: { status: "ok" } }; },
    startAvailabilityPushLoop: () => events.push("availability"),
    ensureRealtimeConnected: async () => events.push("connected"),
  };
  await sandbox.resume.call(provider);
  assert.deepEqual(events, ["tick", "availability", "connected"]);
  const activation = source.slice(source.indexOf("async runActivationOnboarding()"), source.indexOf("async recordOnboardingBackgroundError"));
  assert.ok(activation.indexOf("projectStateBootstrap") < activation.indexOf("distributedQueueContinuation"));
  assert.match(activation, /distributedQueueContinuation.*resumePersistedDistributedQueue/);
});

test("activation retires a queue that only has legacy deferred rows", async () => {
  const events = [];
  const provider = {
    distributedLaunchInFlight: new Set(),
    lastWorkerProbes: {},
    isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    workerCodeSyncTargets: () => [{ id: "worker-a" }],
    loadDistributedQueue: async () => ({ plans: [], deferred: [
      { id: "old", status: "pending", confirmedOutputChoice: true },
      { id: "held", status: "blocked" },
    ] }),
    tickDistributedQueue: async () => events.push("tick"),
    startAvailabilityPushLoop: () => events.push("availability"),
    ensureRealtimeConnected: async () => events.push("connected"),
  };
  await sandbox.resume.call(provider);
  assert.deepEqual(events, ["tick"]);
});

test("activation does not start Worker communication for a fully mirrored completed queue", async () => {
  const provider = {
    distributedLaunchInFlight: new Set(),
    lastWorkerProbes: {},
    isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    workerCodeSyncTargets: () => [{ id: "worker-a" }],
    loadDistributedQueue: async () => ({ plans: [{ jobs: [{ status: "completed", mirroredWorkerIds: ["worker-a"] }] }] }),
    tickDistributedQueue: async () => { throw new Error("unexpected dispatch"); },
  };
  await sandbox.resume.call(provider);
});

test("activation retries completed jobs whose mirrors were not verified", async () => {
  let ticks = 0;
  const provider = {
    distributedLaunchInFlight: new Set(),
    lastWorkerProbes: {}, isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    workerCodeSyncTargets: () => [{ id: "worker-a" }, { id: "worker-b" }],
    loadDistributedQueue: async () => ({ plans: [{ jobs: [{ status: "completed", mirroredWorkerIds: ["worker-a"], artifactError: "offline" }] }] }),
    tickDistributedQueue: async () => { ticks += 1; },
  };
  await sandbox.resume.call(provider);
  assert.equal(ticks, 1);
});

test("an outstanding queue retries an unavailable tunnel probe without a panel", async () => {
  const tickStart = compiledSource.indexOf("async tickDistributedQueueCore(");
  const tickEnd = compiledSource.indexOf("const assigned = queue.plans.flatMap", tickStart);
  assert.ok(tickStart >= 0 && tickEnd > tickStart);
  const prefix = compiledSource.slice(tickStart, tickEnd).replace(/async tickDistributedQueueCore\(([^)]*)\) \{/, "async function probeQueue($1) { this.readWorkerTaskSnapshotBatch ||= async ids => Promise.all(ids.map(id => this.readWorkerTaskSnapshot(id))); this.queuePlanArtifactSyncStatusCheck ||= () => undefined;");
  const clock = { now: 100_000 };
  const probeSandbox = { workspaceRoot: () => "C:/project", Object, Date: { now: () => clock.now },
    mapLimited: async (items, _limit, fn) => Promise.all(items.map((item) => fn(item))), setInterval, clearInterval };
  vm.createContext(probeSandbox);
  vm.runInContext(prefix + "return true; }\nthis.probeQueue = probeQueue;", probeSandbox);
  let probes = 0;
  const provider = {
    distributedLaunchInFlight: new Set(),
    lastWorkerProbes: {}, distributedNextProbeAt: 0,
    isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    workerCodeSyncTargets: () => [], workerActionTargets: () => [],
    distributedQueueGeneration: 0, distributedQueueTickPromise: undefined, distributedPlanStopEpoch: 0,
    detachStaleDistributedTick: () => undefined,
    loadDistributedQueue: async () => ({ plans: [{ jobs: [{ status: "pending" }] }] }),
    testTunnel: async () => { probes += 1; if (probes === 2) provider.lastWorkerProbes = { workerA: { status: "ok" } }; },
    readWorkerTaskSnapshot: async () => ({ tasks: [] }),
  };
  assert.equal(await probeSandbox.probeQueue.call(provider), undefined);
  assert.equal(await probeSandbox.probeQueue.call(provider), undefined);
  assert.equal(probes, 1);
  clock.now += 30_000;
  assert.equal(await probeSandbox.probeQueue.call(provider), true);
  assert.equal(probes, 2);
});

test("completed job retries a stale source probe even while another Worker is online", async () => {
  const tickStart = compiledSource.indexOf("async tickDistributedQueueCore(");
  const tickEnd = compiledSource.indexOf("const assigned = queue.plans.flatMap", tickStart);
  const prefix = compiledSource.slice(tickStart, tickEnd).replace(/async tickDistributedQueueCore\(([^)]*)\) \{/, "async function probeQueue($1) { this.readWorkerTaskSnapshotBatch ||= async ids => Promise.all(ids.map(id => this.readWorkerTaskSnapshot(id))); this.queuePlanArtifactSyncStatusCheck ||= () => undefined;");
  const probeSandbox = { workspaceRoot: () => "C:/project", Object, Date: { now: () => 100_000 },
    mapLimited: async (items, _limit, fn) => Promise.all(items.map((item) => fn(item))), setInterval, clearInterval };
  vm.createContext(probeSandbox);
  vm.runInContext(prefix + "return true; }\nthis.probeQueue = probeQueue;", probeSandbox);
  let probes = 0;
  const provider = {
    distributedLaunchInFlight: new Set(),
    lastWorkerProbes: { "worker-a": { status: "ok" }, "worker-b": { status: "timeout" } },
    distributedNextProbeAt: 0, isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    workerCodeSyncTargets: () => [{ id: "worker-a" }], workerActionTargets: () => [{ id: "worker-a" }, { id: "worker-b" }],
    distributedQueueGeneration: 0, distributedQueueTickPromise: undefined, distributedPlanStopEpoch: 0,
    detachStaleDistributedTick: () => undefined,
    loadDistributedQueue: async () => ({ plans: [{ jobs: [{ status: "completed", workerId: "worker-b", artifactError: "source offline", mirroredWorkerIds: [] }] }] }),
    testTunnel: async () => { probes += 1; provider.lastWorkerProbes["worker-b"] = { status: "ok" }; },
    readWorkerTaskSnapshot: async () => ({ tasks: [] }),
  };
  assert.equal(await probeSandbox.probeQueue.call(provider), true);
  assert.equal(probes, 1);
});

test("manual refresh re-probes Workers and retries artifact sync without waiting for backoff", async () => {
  const compiled = compiledSource;
  const first = compiled.indexOf("async manualSnapshot() {");
  const last = compiled.indexOf("async manualGpuSnapshot() {", first);
  assert.ok(first >= 0 && last > first);
  const context = { workspaceRoot: () => "C:/project", errorMessage: String,
    vscode: { window: { showInformationMessage: () => undefined } } };
  vm.createContext(context);
  vm.runInContext(compiled.slice(first, last).replace("async manualSnapshot()", "async function manualSnapshot()")
    + "\nthis.refresh = manualSnapshot;", context);
  const events = [];
  const client = { getSnapshot: async () => { events.push("snapshot"); return {}; },
    getGpu: async () => ({}), getScheduler: async () => [], getTraces: async () => [] };
  const provider = {
    distributedLaunchInFlight: new Set(),
    projectContextGeneration: 0, client: {}, localPlanMetadata: {},
    refreshLocalPlanMetadata: async () => undefined,
    effectiveConnectionMode: () => "realtime",
    testTunnel: async () => { events.push("probe"); provider.client = client; },
    pushLocalWorkerAvailability: async () => undefined,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    loadDistributedQueue: async () => ({ plans: [{ id: "plan-1", jobs: [{ index: 0, attempt: 1, status: "completed", artifactRetryAfter: "tomorrow" }] }] }),
    patchDistributedJob: async (_root, _plan, _index, _attempt, fields) => { events.push(fields.artifactRetryAfter === undefined ? "retry-now" : "wrong-retry"); },
    tickDistributedQueue: async () => { events.push("tick"); },
    postState: () => undefined,
  };
  await context.refresh.call(provider);
  assert.ok(events.indexOf("probe") < events.indexOf("snapshot"));
  assert.ok(events.indexOf("retry-now") < events.indexOf("tick"));
});

test("successful artifact pass clears an old disconnected warning", async () => {
  const compiled = compiledSource;
  const first = compiled.indexOf("async syncDistributedJobArtifacts(");
  const last = compiled.indexOf("async distributedOutputHashes(", first);
  assert.ok(first >= 0 && last > first);
  const context = { workspaceRoot: () => "C:/project", Date, Set, Map, Object, errorMessage: String,
    PlanOutputRetention: require("../../dist/features/PlanOutputRetention.js") };
  vm.createContext(context);
  vm.runInContext(compiled.slice(first, last).replace("async syncDistributedJobArtifacts(root, queue, phase, verifyAll = false, report)", "async function syncJobArtifacts(root, queue, phase, verifyAll = false, report)")
    + "\nthis.sync = syncJobArtifacts;", context);
  const job = { index: 0, attempt: 1, status: "completed", workerId: "worker-b", outputDir: "runs/a",
    artifacts: {}, fragmentWorkerIds: ["worker-a"], mirroredWorkerIds: ["worker-a"], artifactError: "old disconnect" };
  const patched = [];
  const provider = {
    distributedLaunchInFlight: new Set(),
    distributedProjectContract: () => ({ fragmentPaths: [], requiredPaths: [] }),
    planOutputRetentionMode: () => "latest-complete",
    workerCodeSyncTargets: () => [{ id: "worker-a" }],
    lastWorkerProbes: { "worker-a": { status: "ok" } },
    sftpServerOptions: () => ({}),
    patchDistributedJob: async (_root, _plan, _index, _attempt, fields) => patched.push(fields),
  };
  await context.sync.call(provider, "C:/project", { plans: [{ id: "plan-1", planFile: "plans/p.yaml", jobs: [job] }] }, "bulk");
  assert.equal(job.artifactError, undefined);
  assert.ok(patched.some((row) => Object.hasOwn(row, "artifactError") && row.artifactError === undefined));
});

test("automatic completion does not rebuild previews or mirror completed job artifacts", async () => {
  const compiled = compiledSource;
  const first = compiled.indexOf("scheduleDistributedPostprocess(root, rerunIfBusy = false) {");
  const last = compiled.indexOf("queuePlanArtifactSyncStatusCheck(", first);
  assert.ok(first >= 0 && last > first);
  const context = { workspaceRoot: () => "C:/project", errorMessage: String };
  vm.createContext(context);
  vm.runInContext(compiled.slice(first, last).replace("scheduleDistributedPostprocess(root, rerunIfBusy = false)",
    "function scheduleDistributedPostprocess(root, rerunIfBusy = false)")
    + "\nthis.schedule = scheduleDistributedPostprocess;", context);
  const calls = [];
  const provider = {
    distributedLaunchInFlight: new Set(),
    loadDistributedQueue: async () => ({ plans: [{ planFile: "plans/p.yaml", jobs: [] }] }),
    syncDistributedJobArtifacts: async (_root, _queue, phase) => calls.push(phase),
    rebuildDistributedResults: async (_root, _queue, preview) => {
      calls.push(preview ? "preview" : "final");
      if (preview) throw new Error("preview failed");
    },
    recordActionError: ({ command }) => calls.push(command),
    postState: () => calls.push("state"),
  };
  context.schedule.call(provider, "C:/project");
  await provider.distributedPostprocessPromise;
  assert.deepEqual(calls, []);
});

test("every newly completed job rechecks all recorded job mirrors and repairs drift", async () => {
  const compiled = compiledSource;
  const first = compiled.indexOf("async syncDistributedJobArtifacts(");
  const last = compiled.indexOf("async distributedOutputHashes(", first);
  const context = { workspaceRoot: () => "C:/project", Date, Set, Map, Object, errorMessage: String,
    PlanOutputRetention: require("../../dist/features/PlanOutputRetention.js"),
    mapLimited: async (items, _limit, fn) => Promise.all(items.map((item) => fn(item))),
    DistributedJobArtifacts_1: { collectDistributedJobArtifacts: (_dir, inventory) => Object.fromEntries(Object.entries(inventory || {}).map(([name, row]) => [name, row.sha256])) },
    PlanArtifactTransfer_1: { workerFpsyncTaskLabel: (input) => [input.action, input.sourceId, input.destinationId].filter(Boolean).join(" ") } };
  vm.createContext(context);
  vm.runInContext(compiled.slice(first, last).replace("async syncDistributedJobArtifacts(root, queue, phase, verifyAll = false, report)",
    "async function syncJobArtifacts(root, queue, phase, verifyAll = false, report)")
    + "\nthis.sync = syncJobArtifacts;", context);
  const file = "runs/a/result.csv";
  const job = { index: 0, attempt: 1, status: "completed", workerId: "w2", outputDir: "runs/a",
    artifacts: { [file]: "new" }, fragmentWorkerIds: ["w2", "w3"], mirroredWorkerIds: ["w2", "w3"] };
  let copied = false;
  const patches = [];
  const provider = {
    distributedLaunchInFlight: new Set(),
    distributedProjectContract: () => ({ fragmentPaths: [], requiredPaths: [] }),
    planOutputRetentionMode: () => "latest-complete",
    workerCodeSyncTargets: () => [{ id: "w2" }, { id: "w3" }],
    lastWorkerProbes: { w2: { status: "ok" }, w3: { status: "ok" } },
    sftpServerOptions: (target) => ({ id: target.id }),
    verifiedSftpProjectInventory: async ({ source }) => ({ files: { [file]: { sha256: source.id === "w2" || copied ? "new" : "old" } } }),
    distributedOutputHashes: async (source) => ({ [file]: source.id === "w2" || copied ? "new" : "old" }),
    assertSshTransportIdentities: async () => undefined,
    simpleSftpApiCall: async () => { copied = true; },
    patchDistributedJob: async (_root, _plan, _index, _attempt, fields) => patches.push(fields),
    recordActionError: () => undefined,
  };
  await context.sync.call(provider, "C:/project", { plans: [{ id: "p", planFile: "p.yaml", jobs: [job] }] }, "bulk", true);
  assert.equal(copied, true);
  assert.ok(patches.some((fields) => fields.replaceMirroredWorkerIds && !fields.mirroredWorkerIds.includes("w3")));
  assert.deepEqual(Array.from(job.mirroredWorkerIds), ["w2", "w3"]);
});

test("legacy explicit rebuilding can repair a stale shared preview without automatic invocation", async () => {
  const compiled = compiledSource;
  const first = compiled.indexOf("async rebuildDistributedResults(");
  const last = compiled.indexOf("planOutputRetentionMode(root)", first);
  const context = {
    PlanOutputRetention: require("../../dist/features/PlanOutputRetention.js"),
    workspaceRoot: () => "C:/project", Map, Set, Object, errorMessage: String,
    uniqueStrings: (values) => [...new Set(values)],
    PlanRunFreshness: { selectLatestCompletePlanRun(queue, planFile) {
      const plan = (queue.plans || []).find((row) => row.planFile === planFile && row.jobs.every((job) => job.status === "completed"));
      return plan ? { plan } : undefined;
    } },
    crypto: { createHash: () => ({ update: () => ({ digest: () => "signature" }) }) },
    PlanArtifactTransfer_1: { workerFpsyncTaskLabel: (input) => [input.action, input.sourceId, input.destinationId].filter(Boolean).join(" ") },
  };
  vm.createContext(context);
  vm.runInContext(compiled.slice(first, last).replace("async rebuildDistributedResults(root, queue, previewOnly, verifyAll = false)",
    "async function rebuildDistributedResults(root, queue, previewOnly, verifyAll = false)")
    + "\nthis.rebuild = rebuildDistributedResults;", context);
  const file = "simple_cluster/results/distributed_preview.json";
  const queue = { plans: [{ planFile: "p.yaml", revision: "r", jobs: [{
    case: "a", seed: 1, attempt: 1, status: "completed", workerId: "w3", outputDir: "runs/a",
    artifacts: {}, fragmentWorkerIds: ["w3", "w2"], mirroredWorkerIds: ["w3", "w2"],
  }] }], previewSignature: "signature", previewWorkerId: "w3", previewWorkerIds: ["w3", "w2"], previewPaths: [file] };
  let copied = false;
  const patches = [];
  const provider = {
    distributedLaunchInFlight: new Set(),
    distributedProjectContract: () => ({ fragmentPaths: [], requiredPaths: [], configPath: "cfg", checkpointPath: "chk",
      resultRowsPath: "rows", fourStatePath: "four" }),
    workerCodeSyncTargets: () => [{ id: "w3" }, { id: "w2" }],
    lastWorkerProbes: { w3: { status: "ok" }, w2: { status: "ok" } },
    sftpServerOptions: (row) => ({ id: row.id }),
    distributedOutputHashes: async (source) => ({ [file]: source.id === "w3" || copied ? "good" : "old" }),
    patchDistributedPublication: async (_root, fields) => patches.push(fields),
    assertSshTransportIdentities: async () => undefined,
    simpleSftpApiCall: async () => { copied = true; },
    recordActionError: (error) => { throw new Error(error.message); },
  };
  await context.rebuild.call(provider, "C:/project", queue, true, true);
  assert.equal(copied, true);
  assert.ok(patches.some((fields) => fields.previewWorkerIds && !fields.previewWorkerIds.includes("w2")));
  assert.deepEqual(Array.from(queue.previewWorkerIds), ["w3", "w2"]);
});

test("legacy rebuild retries use fresh operation identities and cache only successful manifests", async () => {
  const first = compiledSource.indexOf("async rebuildDistributedResults(");
  const last = compiledSource.indexOf("planOutputRetentionMode(root)", first);
  let sequence = 0;
  const context = { PlanOutputRetention: require("../../dist/features/PlanOutputRetention.js"),
    PlanRunFreshness: { selectLatestCompletePlanRun: queue => ({ plan: queue.plans[0] }) },
    crypto: require("node:crypto"), workspaceRoot: () => "C:/project",
    uniqueStrings: values => [...new Set(values)], makeOpId: prefix => `${prefix}-new-${++sequence}`,
    resultStatus: value => value.status, remoteActionPendingStatus: () => false };
  vm.createContext(context);
  vm.runInContext(compiledSource.slice(first, last).replace("async rebuildDistributedResults(root, queue, previewOnly, verifyAll = false)",
    "async function rebuildDistributedResults(root, queue, previewOnly, verifyAll = false)") + "\nthis.rebuild = rebuildDistributedResults;", context);
  const queue = { plans: [{ id: "run-b", planFile: "p.yaml", revision: "r", jobs: [{ status: "completed", case: "a", seed: 1,
    outputDir: "work_dirs/a/attempts/run-b", artifacts: {}, fragmentWorkerIds: ["w1"] }] }] };
  const submitted = [];
  const host = { lastWorkerProbes: { w1: { status: "ok" } }, workerCodeSyncTargets: () => [{ id: "w1" }],
    sftpServerOptions: target => target,
    distributedProjectContract: () => ({ fragmentPaths: [], requiredPaths: [] }),
    patchDistributedPublication: async (_root, fields) => Object.assign(queue, fields), client: { postWorkerAction: async (_worker, _action, body) => {
      submitted.push(body); return submitted.length === 1 ? { status: "failed", message: "old failure" } : { status: "completed", outputPaths: ["result.csv"] };
    } } };
  await assert.rejects(context.rebuild.call(host, "C:/project", queue, true), /old failure/);
  assert.equal(queue.previewSignature, undefined);
  await context.rebuild.call(host, "C:/project", queue, true);
  await context.rebuild.call(host, "C:/project", queue, true);
  assert.equal(submitted.length, 2); assert.notEqual(submitted[0].operationId, submitted[1].operationId);
  assert.equal(submitted[1].operationId, submitted[1].opId);
  assert.equal(submitted[1].manifest.plans[0].runId, "run-b");
  assert.ok(queue.previewSignature);
});

test("durable local admission requires a fresh capable ledger and an explicit idle GPU", () => {
  const start = source.indexOf("const durableQueue = queue.plans.some");
  const end = source.indexOf("const retiredDeferred =", start);
  assert.ok(start >= 0 && end > start);
  const admission = source.slice(start, end);
  assert.match(admission, /DistributedPlanQueue\.hasFreshDurableSnapshot\(snapshot\)/);
  assert.match(admission, /snapshot\?\.capabilities\?\.idleGpuAdmission === true/);
  assert.match(admission, /codeFingerprint: workerFingerprint/);
  assert.match(admission, /sendDistributedJob\(plan, job, dispatch\.workerId, gpuId, dispatch\.commandId, sharedManifest\)/);
  assert.match(admission, /allocateAvailable\(queue, workers, \{ requireIdleGpuAdmission: true, localIdleOnly: true \}\)/);
  assert.doesNotMatch(source.slice(source.indexOf("async tickDistributedQueueCore("), source.indexOf("async syncDistributedJobArtifacts(")),
    /catch\s*\{\s*snapshot\s*=\s*this\.lastRealtimeState\?\.gpu/);
});

test("restart fences an unacknowledged legacy dispatch with its original command identity", async () => {
  const compiled = compiledSource;
  const start = compiled.indexOf("async tickDistributedQueueCore(");
  const end = compiled.indexOf("async syncDistributedJobArtifacts(", start);
  assert.ok(start >= 0 && end > start);
  const queueMethod = compiled.slice(start, end).replace(/async tickDistributedQueueCore\(([^)]*)\) \{/, "async function tickQueue($1) { this.readWorkerTaskSnapshotBatch ||= async ids => Promise.all(ids.map(id => this.readWorkerTaskSnapshot(id))); this.queuePlanArtifactSyncStatusCheck ||= () => undefined;");
  const DistributedPlanQueue = loadSourceModule("src/features/DistributedPlanQueue.ts");
  const context = {
    workspaceRoot: () => "C:/project", DistributedPlanQueue,
    mapLimited: async (items, _limit, fn) => Promise.all(items.map(fn)),
    Object, Set, Date, setInterval, clearInterval, errorMessage: String,
  };
  vm.createContext(context);
  vm.runInContext(queueMethod + "\nthis.tickQueue = tickQueue;", context);
  let queue = { schemaVersion: 1, plans: [{
    id: "plan-1", planFile: "plans/p.yaml", revision: "rev-1", codeFingerprint: "code-1",
    jobs: [{ index: 0, case: "case-a", seed: 1, attempt: 1, outputDir: "runs/a",
      status: "dispatching", workerId: "worker-a", gpuId: "0", commandId: "command-1" }],
  }], deferred: [] };
  const sent = [];
  const provider = {
    distributedLaunchInFlight: new Set(),
    lastWorkerProbes: { "worker-a": { status: "ok" } }, lastCodeSyncState: { workerVersions: {} },
    workerCodeSyncTargets: () => [],
    isRealtimeMode: () => true, projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    loadDistributedQueue: async () => queue,
    saveDistributedQueue: async (_root, next) => { queue = next; },
    workerActionTargets: () => [{ id: "worker-a" }],
    readWorkerTaskSnapshot: async () => ({ tasks: [] }),
    sendDistributedJob: async (_plan, _job, workerId, gpuId, commandId) => {
      sent.push({ workerId, gpuId, commandId });
      return { status: "completed" };
    },
    client: { getGpu: async () => ({}) },
    localWorkerAvailabilityRows: () => [], availabilityPushTtlSeconds: () => 45,
    schedulerSettings: () => ({}), scheduleDistributedPostprocess: () => undefined,
    postState: () => undefined, refreshSelectedDistributedLog: () => undefined,
  };
  await context.tickQueue.call(provider);
  assert.deepEqual(sent, [], "a missing legacy receipt cannot authorize replay after restart");
  assert.equal(queue.plans[0].jobs[0].status, "unknown");
  assert.equal(queue.plans[0].jobs[0].commandId, "command-1");
  assert.equal(queue.plans[0].jobs[0].workerId, "worker-a");
  assert.match(queue.plans[0].jobs[0].blockReason, /不会自动补发任务/);
});

test("a failed job retains its Agent error in the durable Plan queue", async () => {
  const compiled = compiledSource;
  const start = compiled.indexOf("async tickDistributedQueueCore(");
  const end = compiled.indexOf("async syncDistributedJobArtifacts(", start);
  const queueMethod = compiled.slice(start, end).replace(/async tickDistributedQueueCore\(([^)]*)\) \{/, "async function tickQueue($1) { this.readWorkerTaskSnapshotBatch ||= async ids => Promise.all(ids.map(id => this.readWorkerTaskSnapshot(id))); this.queuePlanArtifactSyncStatusCheck ||= () => undefined;");
  const DistributedPlanQueue = loadSourceModule("src/features/DistributedPlanQueue.ts");
  const context = { workspaceRoot: () => "C:/project", DistributedPlanQueue,
    mapLimited: async (items, _limit, fn) => Promise.all(items.map(fn)),
    compactSensitiveText: String, Object, Set, Date, setInterval, clearInterval };
  vm.createContext(context);
  vm.runInContext(queueMethod + "\nthis.tickQueue = tickQueue;", context);
  let queue = { schemaVersion: 1, plans: [{ id: "plan-1", planFile: "plans/p.yaml", revision: "rev-1", codeFingerprint: "code-1",
    jobs: [{ index: 0, case: "case-a", seed: 1, attempt: 1, outputDir: "runs/a",
      status: "failed", workerId: "worker-a", gpuId: "0", commandId: "command-1" }] }], deferred: [] };
  const task = { commandId: "command-1", workflowId: "plan-1", planRevision: "rev-1", case: "case-a",
    seed: 1, attempt: 1, outputDir: "runs/a", workerId: "worker-a", gpuId: "0", status: "failed",
    error: "FileNotFoundError: missing label_schema.json" };
  const provider = {
    distributedLaunchInFlight: new Set(),
    lastWorkerProbes: { "worker-a": { status: "ok" } }, distributedNextFailureDetailAt: 0,
    workerCodeSyncTargets: () => [],
    lastCodeSyncState: { workerVersions: {} },
    isRealtimeMode: () => true, projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    loadDistributedQueue: async () => queue, saveDistributedQueue: async (_root, next) => { queue = next; },
    workerActionTargets: () => [{ id: "worker-a" }], readWorkerTaskSnapshot: async () => ({ tasks: [task] }),
    client: { getGpu: async () => ({}) }, localWorkerAvailabilityRows: () => [],
    availabilityPushTtlSeconds: () => 45, schedulerSettings: () => ({}),
    scheduleDistributedPostprocess: () => undefined, postState: () => undefined,
    refreshSelectedDistributedLog: () => undefined,
  };
  await context.tickQueue.call(provider);
  assert.equal(queue.plans[0].jobs[0].status, "failed");
  assert.equal(queue.plans[0].jobs[0].error, task.error);
});

test("idle queue recovery checks are spaced while a newly completed job still checks immediately", async () => {
  const compiled = compiledSource;
  const start = compiled.indexOf("async tickDistributedQueueCore(");
  const end = compiled.indexOf("async syncDistributedJobArtifacts(", start);
  const context = { workspaceRoot: () => "C:/project", DistributedPlanQueue: loadSourceModule("src/features/DistributedPlanQueue.ts"),
    mapLimited: async (items, _limit, fn) => Promise.all(items.map(fn)), Object, Set, Date, setInterval, clearInterval };
  vm.createContext(context);
  vm.runInContext(compiled.slice(start, end).replace(/async tickDistributedQueueCore\(([^)]*)\) \{/, "async function tickQueue($1) { this.readWorkerTaskSnapshotBatch ||= async ids => Promise.all(ids.map(id => this.readWorkerTaskSnapshot(id))); this.queuePlanArtifactSyncStatusCheck ||= () => undefined;")
    + "\nthis.tickQueue = tickQueue;", context);
  let queue = { schemaVersion: 1, plans: [{ id: "plan-1", planFile: "plans/p.yaml", revision: "rev-1",
    jobs: [{ index: 0, case: "case-a", seed: 1, attempt: 1, status: "completed", workerId: "worker-a", gpuId: "0",
      commandId: "command-1", outputDir: "runs/a", mirroredWorkerIds: ["worker-a"] }] }], deferred: [] };
  let remoteStatus = "completed";
  const scheduled = [];
  const provider = {
    distributedLaunchInFlight: new Set(),
    distributedNextPostprocessAt: 0, lastWorkerProbes: { "worker-a": { status: "ok" } },
    workerCodeSyncTargets: () => [], isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    loadDistributedQueue: async () => queue, saveDistributedQueue: async (_root, next) => { queue = next; },
    workerActionTargets: () => [], client: { getGpu: async () => ({}) },
    localWorkerAvailabilityRows: () => [], availabilityPushTtlSeconds: () => 45,
    schedulerSettings: () => ({}), scheduleDistributedPostprocess: (_root, terminal) => scheduled.push(terminal),
    postState: () => undefined, refreshSelectedDistributedLog: () => undefined,
  };
  await context.tickQueue.call(provider);
  await context.tickQueue.call(provider);
  assert.deepEqual(scheduled, [false]);
  queue.plans[0].jobs[0].status = "running";
  provider.workerActionTargets = () => [{ id: "worker-a" }];
  provider.readWorkerTaskSnapshot = async () => ({ tasks: [{ commandId: "command-1", workflowId: "plan-1",
    planRevision: "rev-1", case: "case-a", seed: 1, attempt: 1, outputDir: "runs/a",
    workerId: "worker-a", gpuId: "0", status: remoteStatus }] });
  await context.tickQueue.call(provider);
  assert.deepEqual(scheduled, [false, true]);
});

function loadTickQueue() {
  const compiled = compiledSource;
  const start = compiled.indexOf("async tickDistributedQueueCore(");
  const end = compiled.indexOf("async syncDistributedJobArtifacts(", start);
  assert.ok(start >= 0 && end > start);
  const context = {
    workspaceRoot: () => "C:/project", DistributedPlanQueue: loadSourceModule("src/features/DistributedPlanQueue.ts"),
    DistributedSchedulingPolicy: require("../../dist/features/DistributedSchedulingPolicy.js"),
    mapLimited: async (items, _limit, fn) => Promise.all(items.map(fn)),
    Object, Set, Map, Date, JSON, setInterval, clearInterval, errorMessage: String,
    actionErrorSuggestion: (message) => String(message || ""),
  };
  vm.createContext(context);
  vm.runInContext(compiled.slice(start, end).replace(/async tickDistributedQueueCore\(([^)]*)\) \{/, "async function tickQueue($1) { this.readWorkerTaskSnapshotBatch ||= async ids => Promise.all(ids.map(id => this.readWorkerTaskSnapshot(id))); this.queuePlanArtifactSyncStatusCheck ||= () => undefined;")
    + "\nthis.tickQueue = tickQueue;", context);
  return context;
}

test("mixed durable and legacy queues reconcile old completion and fence missing receipts without replay", async () => {
  const context = loadTickQueue();
  const projectId = context.DistributedPlanQueue.canonicalProjectId("C:/project");
  const legacyJob = { index: 0, case: "alpha", seed: 42, attempt: 1, outputDir: "runs/old/attempts/one",
    status: "running", workerId: "worker-a", gpuId: "0", commandId: "old-command" };
  const durableJob = { index: 0, case: "alpha", seed: 43, attempt: 1, outputDir: "runs/new/attempts/one",
    status: "queued", workerId: "worker-a", commandId: "new-command", runKey: "new-command", projectId };
  let queue = { schemaVersion: 1, plans: [
    { id: "old-plan", planFile: "plans/old.yaml", revision: "old-rev", codeFingerprint: "code", jobs: [{ ...legacyJob }] },
    { id: "new-plan", projectId, planFile: "plans/new.yaml", revision: "new-rev", codeFingerprint: "code",
      planJobCount: 1, enqueuedAt: new Date().toISOString(), jobs: [{ ...durableJob }] },
  ] };
  let legacyVisible = true;
  let sends = 0;
  const provider = {
    distributedQueueGeneration: 0, distributedPlanStopEpoch: 0, distributedLaunchInFlight: new Set(),
    lastWorkerProbes: { "worker-a": { status: "ok" } },
    lastCodeSyncState: { workerVersions: { "worker-a": { fingerprint: "code" } } },
    isRealtimeMode: () => true, projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    workerCodeSyncTargets: () => [], workerActionTargets: () => [{ id: "worker-a" }],
    enabledWorkerConfigs: () => [], schedulerSettings: () => ({}), gpuOwnerConfig: () => ({}),
    loadDistributedQueue: async () => queue, saveDistributedQueue: async (_root, next) => { queue = next; },
    readWorkerTaskSnapshot: async () => ({ workerId: "worker-a", capabilities: { durablePlanQueue: true, schemaVersion: 1 },
      generatedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), tasks: [
        ...(legacyVisible ? [{ ...legacyJob, workflowId: "old-plan", planRevision: "old-rev", status: "completed" }] : []),
        { ...durableJob, experimentIndex: 0, workflowId: "new-plan", planFile: "plans/new.yaml",
          planRevision: "new-rev", codeFingerprint: "code", planJobCount: 1, enqueuedAt: queue.plans[1].enqueuedAt },
      ] }),
    sendDistributedJob: async () => { sends += 1; throw new Error("reconciliation must not submit a new job"); },
    scheduleDistributedPostprocess: () => undefined, recordActionError: () => undefined, postState: () => undefined,
  };
  await context.tickQueue.call(provider);
  assert.equal(queue.plans[0].jobs[0].status, "completed", "a durable Plan must not suppress an older exact completion receipt");
  assert.equal(queue.plans[1].jobs[0].status, "queued");
  queue.plans[0].jobs[0] = { ...legacyJob };
  legacyVisible = false;
  await context.tickQueue.call(provider);
  assert.equal(queue.plans[0].jobs[0].status, "unknown");
  assert.equal(queue.plans[0].jobs[0].commandId, "old-command");
  assert.equal(queue.plans[0].jobs[0].workerId, "worker-a");
  assert.match(queue.plans[0].jobs[0].blockReason, /不会自动补发任务/);
  assert.equal(sends, 0, "missing legacy receipts cannot authorize replay or duplicate work");
});

test("verified idle Workers on the new fingerprint dispatch edrl and block stale ebmc pending", async () => {
  const context = loadTickQueue();
  const oldFingerprint = "a84a822d";
  const newFingerprint = "ec594411";
  let queue = { schemaVersion: 1, plans: [
    { id: "ebmc", planFile: "experiments/plans/comparison/ebmc.yaml", revision: "rev-ebmc", codeFingerprint: oldFingerprint,
      jobs: [{ index: 0, case: "bus", seed: 1, attempt: 1, outputDir: "work_dirs/ebmc/bus_1", status: "pending" }] },
    { id: "edrl", planFile: "experiments/plans/comparison/edrl.yaml", revision: "rev-edrl", codeFingerprint: newFingerprint,
      jobs: [{ index: 0, case: "pad", seed: 2, attempt: 1, outputDir: "work_dirs/edrl/pad_2", status: "pending" }] },
  ], deferred: [] };
  const sent = [];
  const provider = {
    distributedLaunchInFlight: new Set(),
    lastWorkerProbes: { nwpu3: { status: "ok" }, nwpu5: { status: "ok" } },
    lastCodeSyncState: { workerVersions: { nwpu3: { fingerprint: newFingerprint }, nwpu5: { fingerprint: newFingerprint } } },
    workerCodeSyncTargets: () => [], isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    loadDistributedQueue: async () => queue,
    saveDistributedQueue: async (_root, next) => { queue = next; },
    workerActionTargets: () => [{ id: "nwpu3" }, { id: "nwpu5" }],
    readWorkerTaskSnapshot: async () => ({ tasks: [] }),
    sendDistributedJob: async (plan, _job, workerId, gpuId, commandId) => {
      sent.push({ planId: plan.id, planFile: plan.planFile, workerId, gpuId, commandId });
      return { status: "completed" };
    },
    client: { getGpu: async () => ({ nwpu3: [], nwpu5: [] }) },
    localWorkerAvailabilityRows: () => [
      { workerId: "nwpu3", availableGpuIds: ["0", "1", "2", "3"] },
      { workerId: "nwpu5", availableGpuIds: ["0", "1"] },
    ],
    availabilityPushTtlSeconds: () => 45, schedulerSettings: () => ({}),
    scheduleDistributedPostprocess: () => undefined, postState: () => undefined,
    refreshSelectedDistributedLog: () => undefined, recordActionError: () => undefined,
  };
  await context.tickQueue.call(provider);
  assert.deepEqual(sent.map((row) => row.planId), ["edrl"]);
  assert.equal(queue.plans.find((plan) => plan.id === "edrl").jobs[0].status, "running");
  const stale = queue.plans.find((plan) => plan.id === "ebmc").jobs[0];
  assert.equal(stale.status, "pending");
  assert.equal(stale.commandId, undefined);
  assert.match(stale.blockReason, /代码指纹不匹配/);
  assert.match(stale.blockReason, /重新提交/);
});

test("a persisted deferred Plan is retired while an already submitted job still dispatches", async () => {
  const context = loadTickQueue();
  const body = { planFile: "experiments/plans/comparison/edrl.yaml", planRevision: "rev-edrl", options: {} };
  let queue = { schemaVersion: 1, plans: [
    { id: "ebmc", planFile: "experiments/plans/comparison/ebmc.yaml", revision: "rev-ebmc", codeFingerprint: "ec594411",
      jobs: [{ index: 0, case: "bus", seed: 1, attempt: 1, outputDir: "work_dirs/ebmc/bus_1", status: "pending" }] },
  ], deferred: [{ id: "deferred-edrl", planFile: body.planFile, revision: "rev-edrl", codeFingerprint: "ec594411",
    body, enqueuedAt: "2026-09-26T00:00:00Z", status: "pending", confirmedOutputChoice: true }] };
  const sent = [];
  const errors = [];
  const provider = {
    distributedLaunchInFlight: new Set(),
    lastWorkerProbes: { nwpu3: { status: "ok" } },
    lastCodeSyncState: { fingerprint: "ec594411", workerVersions: { nwpu3: { fingerprint: "ec594411" } } },
    workerCodeSyncTargets: () => [], isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    distributedPostprocessPromise: undefined,
    loadDistributedQueue: async () => queue,
    saveDistributedQueue: async (_root, next) => { queue = next; },
    localDistributedCodeFingerprint: async () => { throw new Error("deferred must not read a new fingerprint"); },
    selectDistributedPlanPrimary: async () => { throw new Error("deferred must not select a worker"); },
    ensureCodeReadyForRun: async () => { throw new Error("deferred must not sync"); },
    runPlanPreflight: async () => { throw new Error("deferred must not validate"); },
    enqueueDistributedPlan: async () => { throw new Error("deferred must not enqueue"); },
    workerActionTargets: () => [{ id: "nwpu3" }],
    readWorkerTaskSnapshot: async () => ({ tasks: [] }),
    sendDistributedJob: async (plan) => { sent.push(plan.id); return { status: "completed" }; },
    client: { getGpu: async () => ({}) },
    localWorkerAvailabilityRows: () => [{ workerId: "nwpu3", availableGpuIds: ["0"] }],
    availabilityPushTtlSeconds: () => 45, schedulerSettings: () => ({}),
    scheduleDistributedPostprocess: () => undefined, postState: () => undefined,
    refreshSelectedDistributedLog: () => undefined, recordActionError: (error) => errors.push(error.message),
  };
  await context.tickQueue.call(provider);
  assert.deepEqual(sent, ["ebmc"]);
  assert.equal(queue.deferred.find((row) => row.id === "deferred-edrl").status, "superseded");
  assert.equal(queue.deferred.find((row) => row.id === "deferred-edrl").supersededBy, "manual-rerun-policy");
  assert.match(errors.join("\n"), /不会自动接续/);
  assert.equal(queue.plans.find((plan) => plan.id === "ebmc").jobs[0].status, "running");
});

test("running work and missing Worker version evidence still hold a deferred Plan", async () => {
  const context = loadTickQueue();
  const running = { schemaVersion: 1, plans: [
    { id: "live", planFile: "plans/live.yaml", revision: "rev-live", codeFingerprint: "code-live",
      jobs: [{ index: 0, case: "bus", seed: 1, attempt: 1, outputDir: "runs/live", status: "running",
        workerId: "nwpu3", gpuId: "0", commandId: "command-live" }] },
  ], deferred: [{ id: "later", planFile: "plans/later.yaml", revision: "rev-later", codeFingerprint: "code-later",
    body: {}, status: "pending" }] };
  let queue = JSON.parse(JSON.stringify(running));
  const provider = {
    distributedLaunchInFlight: new Set(),
    lastWorkerProbes: { nwpu3: { status: "ok" } },
    lastCodeSyncState: { workerVersions: { nwpu3: { fingerprint: "code-later" } } },
    workerCodeSyncTargets: () => [], isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    loadDistributedQueue: async () => queue,
    saveDistributedQueue: async (_root, next) => { queue = next; },
    enqueueDistributedPlan: async () => { throw new Error("deferred must stay queued"); },
    localDistributedCodeFingerprint: async () => { throw new Error("deferred must not fingerprint"); },
    selectDistributedPlanPrimary: async () => { throw new Error("deferred must not select"); },
    ensureCodeReadyForRun: async () => { throw new Error("deferred must not sync"); },
    runPlanPreflight: async () => { throw new Error("deferred must not validate"); },
    workerActionTargets: () => [{ id: "nwpu3" }],
    readWorkerTaskSnapshot: async () => ({ tasks: [{ commandId: "command-live", workflowId: "live",
      planRevision: "rev-live", case: "bus", seed: 1, attempt: 1, outputDir: "runs/live",
      workerId: "nwpu3", gpuId: "0", status: "running" }] }),
    client: { getGpu: async () => ({}) },
    localWorkerAvailabilityRows: () => [], availabilityPushTtlSeconds: () => 45,
    schedulerSettings: () => ({}), scheduleDistributedPostprocess: () => undefined,
    postState: () => undefined, refreshSelectedDistributedLog: () => undefined,
    recordActionError: () => undefined,
  };
  await context.tickQueue.call(provider);
  assert.equal(queue.deferred[0].status, "superseded");
  assert.equal(queue.deferred[0].supersededBy, "manual-rerun-policy");
  assert.equal(queue.plans[0].jobs[0].status, "running");
  queue = { schemaVersion: 1, plans: [
    { id: "unknown-code", planFile: "plans/old.yaml", revision: "rev-old", codeFingerprint: "code-old",
      jobs: [{ index: 0, case: "bus", seed: 1, attempt: 1, outputDir: "runs/old", status: "pending" }] },
  ], deferred: [{ id: "later", status: "pending", codeFingerprint: "code-later", body: {}, planFile: "plans/later.yaml", revision: "rev-later" }] };
  provider.lastCodeSyncState = { workerVersions: {} };
  provider.readWorkerTaskSnapshot = async () => ({ tasks: [] });
  await context.tickQueue.call(provider);
  assert.equal(queue.deferred[0].status, "superseded");
  assert.equal(queue.plans.find((plan) => plan.id === "unknown-code").jobs[0].status, "pending");
});
