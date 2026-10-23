const { assert, test, vm, fs, path, Module, ts, readSource, methodAt, source, compiledSource, loadSourceModule, start, end, method, sandbox, loadTickQueue } = require("./distributedQueueStartup.support.cjs");

test("activation reconnects and ticks a persisted Plan queue without opening the panel", async () => {
  const events = [];
  const provider = {
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
  const probeSandbox = { ...require('../_helpers/nativeHostScope'), workspaceRoot: () => "C:/project", Object, Date: { now: () => clock.now },
    mapLimited: async (items, _limit, fn) => Promise.all(items.map((item) => fn(item))), setInterval, clearInterval };
  vm.createContext(probeSandbox);
  vm.runInContext(prefix + "return true; }\nthis.probeQueue = probeQueue;", probeSandbox);
  let probes = 0;
  const provider = {
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
  const probeSandbox = { ...require('../_helpers/nativeHostScope'), workspaceRoot: () => "C:/project", Object, Date: { now: () => 100_000 },
    mapLimited: async (items, _limit, fn) => Promise.all(items.map((item) => fn(item))), setInterval, clearInterval };
  vm.createContext(probeSandbox);
  vm.runInContext(prefix + "return true; }\nthis.probeQueue = probeQueue;", probeSandbox);
  let probes = 0;
  const provider = {
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
  const context = { ...require('../_helpers/nativeHostScope'), workspaceRoot: () => "C:/project", errorMessage: String,
    vscode: { window: { showInformationMessage: () => undefined } } };
  context.NativeResultManifest_1=require("../../dist/results/NativeResultManifest");
  vm.createContext(context);
  vm.runInContext(methodAt(compiled, first).replace("async manualSnapshot()", "async function manualSnapshot()")
    + "\nthis.refresh = manualSnapshot;", context);
  const events = [];
  const client = { getSnapshot: async () => { events.push("snapshot"); return {}; },
    getGpu: async () => ({}), getScheduler: async () => [], getTraces: async () => [] };
  const provider = {
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
  const context = { ...require('../_helpers/nativeHostScope'), workspaceRoot: () => "C:/project", Date, Set, Map, Object, errorMessage: String,
    PlanOutputRetention: require("../../dist/features/PlanOutputRetention.js") };
  context.NativeResultManifest_1=require("../../dist/results/NativeResultManifest");
  vm.createContext(context);
  vm.runInContext(methodAt(compiled, first).replace("async syncDistributedJobArtifacts(", "async function syncJobArtifacts(")
    + "\nthis.sync = syncJobArtifacts;", context);
  const job = { index: 0, attempt: 0, lifecycleProtocol: 2, status: "completed", workerId: "worker-b", outputDir: "runs/a",
    artifacts: { "runs/a/artifact_manifest.json": "a".repeat(64) }, fragmentWorkerIds: ["worker-a"], mirroredWorkerIds: ["worker-a"], artifactError: "old disconnect" };
  const patched = [];
  const provider = {
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
    distributedProjectContract: () => ({ fragmentPaths: [], requiredPaths: [] }),
    planOutputRetentionMode: () => "latest-complete",
    workerCodeSyncTargets: () => [{ id: "worker-a" }],
    lastWorkerProbes: { "worker-a": { status: "ok" } },
    sftpServerOptions: () => ({}),
    distributedOutputHashes:async()=>({...job.artifacts}),
    patchDistributedJob: async (_root, _plan, _index, _attempt, fields) => {patched.push(fields);Object.assign(job,fields);},
  };
  await context.sync.call(provider, "C:/project", { plans: [{ id: "plan-1",planJobCount:1, resultPathPolicy: "declared", planFile: "plans/p.yaml", jobs: [job] }] }, "bulk");
  assert.equal(job.artifactError, undefined);
  assert.ok(patched.some((row) => Object.hasOwn(row, "artifactError") && row.artifactError === undefined));
});
