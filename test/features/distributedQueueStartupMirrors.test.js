const { assert, test, vm, fs, path, Module, ts, readSource, methodAt, source, compiledSource, loadSourceModule, start, end, method, sandbox, loadTickQueue } = require("./distributedQueueStartup.support.cjs");

test("automatic completion invokes only the Worker mirror, never preview or final rebuilding", async () => {
  const compiled = compiledSource;
  const first = compiled.indexOf("scheduleDistributedPostprocess(root, rerunIfBusy = false) {");
  const last = compiled.indexOf("async syncCompletedPlanArtifacts(", first);
  assert.ok(first >= 0 && last > first);
  const context = { ...require('../_helpers/nativeHostScope'), workspaceRoot: () => "C:/project", errorMessage: String };
  vm.createContext(context);
  vm.runInContext(methodAt(compiled, first).replace("scheduleDistributedPostprocess(root, rerunIfBusy = false)",
    "function scheduleDistributedPostprocess(root, rerunIfBusy = false)")
    + "\nthis.schedule = scheduleDistributedPostprocess;", context);
  const calls = [];
  const provider = {
    isRealtimeMode: () => true, projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    captureProjectContext: () => ({ root: "C:/project" }), projectContextIsCurrent: () => true,
    syncCompletedPlanArtifacts: async () => calls.push("worker-mirror"), queuePlanArtifactSyncStatusCheck: () => {},
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["worker-mirror", "state"]);
});

test("formal mirror drift remains blocked rather than overwriting a conflicting destination", async () => {
  const compiled = compiledSource;
  const first = compiled.indexOf("async syncDistributedJobArtifacts(");
  const last = compiled.indexOf("async distributedOutputHashes(", first);
  const context = { ...require('../_helpers/nativeHostScope'), workspaceRoot: () => "C:/project", Date, Set, Map, Object, errorMessage: String,
    PlanOutputRetention: require("../../dist/features/PlanOutputRetention.js"),
    mapLimited: async (items, _limit, fn) => Promise.all(items.map((item) => fn(item))),
    DistributedJobArtifacts_1: { collectDistributedJobArtifacts: (_dir, inventory) => Object.fromEntries(Object.entries(inventory || {}).map(([name, row]) => [name, row.sha256])) },
    PlanArtifactTransfer_1: { workerFpsyncTaskLabel: (input) => [input.action, input.sourceId, input.destinationId].filter(Boolean).join(" ") } };
  vm.createContext(context);
  vm.runInContext(methodAt(compiled, first).replace("async syncDistributedJobArtifacts(",
    "async function syncJobArtifacts(")
    + "\nthis.sync = syncJobArtifacts;", context);
  const file = "runs/a/result.csv";
  const digest = "a".repeat(64), changed = "b".repeat(64), owner = "runs/a/formal_job_owner.json";
  const job = { index: 0, attempt: 1, status: "completed", workerId: "w2", outputDir: "runs/a",
    artifacts: { [file]: digest, [owner]: digest }, fragmentWorkerIds: ["w2", "w3"], mirroredWorkerIds: ["w2", "w3"] };
  let copied = false;
  const patches = [];
  const provider = {
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
    distributedProjectContract: () => ({ fragmentPaths: [], requiredPaths: [] }),
    planOutputRetentionMode: () => "latest-complete",
    workerCodeSyncTargets: () => [{ id: "w2" }, { id: "w3" }],
    lastWorkerProbes: { w2: { status: "ok" }, w3: { status: "ok" } },
    sftpServerOptions: (target) => ({ id: target.id }),
    verifiedSftpProjectInventory: async ({ source }) => ({ files: { [file]: { sha256: source.id === "w2" ? digest : changed }, [owner]: { sha256: digest } } }),
    distributedOutputHashes: async (source) => ({ [file]: source.id === "w2" ? digest : changed, [owner]: digest }),
    assertSshTransportIdentities: async () => undefined,
    simpleSftpApiCall: async () => { copied = true; },
    patchDistributedJob: async (_root, _plan, _index, _attempt, fields) => patches.push(fields),
    recordActionError: () => undefined,
  };
  await assert.rejects(context.sync.call(provider, "C:/project", { plans: [{ id: "p",planJobCount:1, resultPathPolicy: "declared", planFile: "p.yaml", jobs: [job] }] }, "bulk", true), /FORMAL_JOB_MIRROR_CONFLICT/);
  assert.equal(copied, false);
  assert.ok(patches.some(fields => /MIRROR_CONFLICT/.test(fields.artifactError)));
  assert.deepEqual(Array.from(job.mirroredWorkerIds), ["w2", "w3"]);
});

test("retired shared-preview rebuilding cannot publish or overwrite historical result files", async () => {
  const compiled = compiledSource;
  const first = compiled.indexOf("async rebuildDistributedResults(");
  const last = compiled.indexOf("planOutputRetentionMode(root)", first);
  const context = { ...require('../_helpers/nativeHostScope'),
    PlanOutputRetention: require("../../dist/features/PlanOutputRetention.js"),
    DistributedPlanQueue: require("../../dist/features/DistributedPlanQueue.js"),
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
  vm.runInContext(methodAt(compiled, first).replace("async rebuildDistributedResults(root, queue, previewOnly, verifyAll = false)",
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
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
  assert.equal(copied, false);
  assert.equal(patches.length,0);
  assert.deepEqual(Array.from(queue.previewWorkerIds), ["w3", "w2"]);
});

test("repeated historical rebuild requests do not submit actions or create a publication cache", async () => {
  const first = compiledSource.indexOf("async rebuildDistributedResults(");
  const last = compiledSource.indexOf("planOutputRetentionMode(root)", first);
  let sequence = 0;
  const context = { ...require('../_helpers/nativeHostScope'), PlanOutputRetention: require("../../dist/features/PlanOutputRetention.js"),
    DistributedPlanQueue: require("../../dist/features/DistributedPlanQueue.js"),
    PlanRunFreshness: { selectLatestCompletePlanRun: queue => ({ plan: queue.plans[0] }) },
    crypto: require("node:crypto"), workspaceRoot: () => "C:/project",
    uniqueStrings: values => [...new Set(values)], makeOpId: prefix => `${prefix}-new-${++sequence}`,
    resultStatus: value => value.status, remoteActionPendingStatus: () => false };
  vm.createContext(context);
  vm.runInContext(methodAt(compiledSource, first).replace("async rebuildDistributedResults(root, queue, previewOnly, verifyAll = false)",
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
  await context.rebuild.call(host, "C:/project", queue, true);
  assert.equal(queue.previewSignature, undefined);
  await context.rebuild.call(host, "C:/project", queue, true);
  await context.rebuild.call(host, "C:/project", queue, true);
  assert.equal(submitted.length,0);assert.equal(sequence,0);
  assert.equal(queue.plans[0].id,'run-b');assert.equal(queue.plans[0].jobs[0].outputDir,'work_dirs/a/attempts/run-b');
  assert.equal(queue.previewSignature,undefined);
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
  // 0.5.419：准入仍要求空闲 GPU + 仅本机空闲，且只在交接门放行的 Worker 上分配。
  assert.match(admission, /allocateAvailable\(queue, dispatchableWorkers, \{ requireIdleGpuAdmission: true, localIdleOnly: true,\s*memoryBudget: GpuMemoryBudget\.memoryBudgetAdmission\(queue, dispatchableWorkers\) \}\)/);
  assert.match(admission, /const dispatchableWorkers = workers\.filter\(\(worker: any\) => this\.dispatchHandoffAllowsWorkerLocal\?\.\(root, String\(worker\?\.workerId \|\| ""\)\) !== false\)/);
  assert.doesNotMatch(source.slice(source.indexOf("async tickDistributedQueueCore("), source.indexOf("async syncDistributedJobArtifacts(")),
    /catch\s*\{\s*snapshot\s*=\s*this\.lastRealtimeState\?\.gpu/);
});

test("restart fences an unacknowledged legacy dispatch with its original command identity", async () => {
  const compiled = compiledSource;
  const start = compiled.indexOf("async tickDistributedQueueCore(");
  const end = compiled.indexOf("async syncDistributedJobArtifacts(", start);
  assert.ok(start >= 0 && end > start);
  const queueMethod = methodAt(compiled, start).replace(/async tickDistributedQueueCore\(([^)]*)\) \{/, "async function tickQueue($1) { this.readWorkerTaskSnapshotBatch ||= async ids => Promise.all(ids.map(id => this.readWorkerTaskSnapshot(id))); this.queuePlanArtifactSyncStatusCheck ||= () => undefined;");
  const DistributedPlanQueue = loadSourceModule("src/features/DistributedPlanQueue.ts");
  const context = { ...require('../_helpers/nativeHostScope'),
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
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
