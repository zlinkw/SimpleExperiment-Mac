const { assert, test, vm, fs, path, Module, ts, readSource, methodAt, source, compiledSource, loadSourceModule, start, end, method, sandbox, loadTickQueue } = require("./distributedQueueStartup.support.cjs");

test("a failed job retains its Agent error in the durable Plan queue", async () => {
  const compiled = compiledSource;
  const start = compiled.indexOf("async tickDistributedQueueCore(");
  const end = compiled.indexOf("async syncDistributedJobArtifacts(", start);
  const queueMethod = methodAt(compiled, start).replace(/async tickDistributedQueueCore\(([^)]*)\) \{/, "async function tickQueue($1) { this.readWorkerTaskSnapshotBatch ||= async ids => Promise.all(ids.map(id => this.readWorkerTaskSnapshot(id))); this.queuePlanArtifactSyncStatusCheck ||= () => undefined;");
  const DistributedPlanQueue = loadSourceModule("src/features/DistributedPlanQueue.ts");
  const context = { ...require('../_helpers/nativeHostScope'), workspaceRoot: () => "C:/project", DistributedPlanQueue,
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
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
  const context = { ...require('../_helpers/nativeHostScope'), workspaceRoot: () => "C:/project", DistributedPlanQueue: loadSourceModule("src/features/DistributedPlanQueue.ts"),
    mapLimited: async (items, _limit, fn) => Promise.all(items.map(fn)), Object, Set, Date, setInterval, clearInterval };
  vm.createContext(context);
  vm.runInContext(methodAt(compiled, start).replace(/async tickDistributedQueueCore\(([^)]*)\) \{/, "async function tickQueue($1) { this.readWorkerTaskSnapshotBatch ||= async ids => Promise.all(ids.map(id => this.readWorkerTaskSnapshot(id))); this.queuePlanArtifactSyncStatusCheck ||= () => undefined;")
    + "\nthis.tickQueue = tickQueue;", context);
  let queue = { schemaVersion: 1, plans: [{ id: "plan-1", planFile: "plans/p.yaml", revision: "rev-1",
    jobs: [{ index: 0, case: "case-a", seed: 1, attempt: 1, status: "completed", workerId: "worker-a", gpuId: "0",
      commandId: "command-1", outputDir: "runs/a", mirroredWorkerIds: ["worker-a"] }] }], deferred: [] };
  let remoteStatus = "completed";
  const scheduled = [];
  const provider = {
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
    distributedQueueGeneration: 0, distributedPlanStopEpoch: 0, distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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

test("verified idle Workers cannot resume old execution-policy records on either code fingerprint", async () => {
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
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
  assert.deepEqual(sent.map((row) => row.planId), []);
  assert.equal(queue.plans.find((plan) => plan.id === "edrl").jobs[0].status, "pending");
  const stale = queue.plans.find((plan) => plan.id === "ebmc").jobs[0];
  assert.equal(stale.status, "pending");
  assert.equal(stale.commandId, undefined);
  assert.equal(stale.workerId, undefined);
});

test("a persisted deferred Plan is retired without resuming a pending legacy job", async () => {
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
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
  assert.deepEqual(sent, []);
  assert.equal(queue.deferred.find((row) => row.id === "deferred-edrl").status, "superseded");
  assert.equal(queue.deferred.find((row) => row.id === "deferred-edrl").supersededBy, "manual-rerun-policy");
  assert.match(errors.join("\n"), /不会自动接续/);
  assert.equal(queue.plans.find((plan) => plan.id === "ebmc").jobs[0].status, "pending");
});

// r82（0.5.414）：真实 tick 派发候选必须排除隔离未完成 job（现场 03:25:27Z 阻断 job 照常派发→FORMAL_JOB_CONFLICT）。
// 走 loadTickQueue 既有生产 tick 提取链：候选筛选→allocateAvailable→save→sendDistributedJob，不测纯函数替身。
// r83 红基线返修（宿主实测 413 上 sent=[] 而非预测的 [0]）：红因确证为本夹具环境前置不足——413 下 Worker 行
// online=false（快照缺 fetchedAt/capabilities.idleGpuAdmission、getGpu 返回空行 → allocateAvailable slots 为空），
// 连干净 sibling 都到不了发送口，"缺过滤"根本不可观测。本返修只补齐派发环境前置（对齐 idleGpuDispatchLifecycle
// 已验证夹具：fresh snapshot+idleGpuAdmission、真实 GPU 行、probes endpoints、local_idle、codeFingerprint 匹配），
// 断言逐字不变。修复后判据：413 必红且红因=阻断 job 未被过滤（单卡下 pad 先占卡，sent=[0]）；
// 修复后同一夹具 sent=[1]——红绿差异有且仅有 allocateAvailable 对 outputIsolationBlocked 的过滤这一点。
test("a job with an unresolved isolation block never enters the real tick dispatch; its sibling dispatches normally", async () => {
  const context = loadTickQueue();
  const projectId = context.DistributedPlanQueue.canonicalProjectId("C:/project");
  let queue = { schemaVersion: 1, plans: [
    { id: "mixed", projectId, planFile: "plans/mixed.yaml", revision: "rev-m", codeFingerprint: "ec594411",
      planJobCount: 2, enqueuedAt: new Date().toISOString(), resultPathPolicy: "declared", schedulingMode: "local_idle",
      jobs: [
        { index: 0, case: "pad", seed: 42, attempt: 0, outputDir: "work_dirs/pad_42", status: "pending",
          lifecycleProtocol: 2, resultPathPolicy: "declared", globalJobId: "mixed:0",
          outputIsolationBlocked: { reason: "nwpu3：ACTIVE_TRANSFER SimpleSFTP files.cleanup.execute：[ACTIVE_TRANSFER]", stage: "execute", code: "ACTIVE_TRANSFER", declarationKey: "work_dirs/pad_42", observedAt: new Date().toISOString() } },
        { index: 1, case: "bus", seed: 7, attempt: 0, outputDir: "work_dirs/bus_7", status: "pending",
          lifecycleProtocol: 2, resultPathPolicy: "declared", globalJobId: "mixed:1" }] }],
    deferred: [] };
  const sent = [];
  const provider = {
    distributedQueueGeneration: 0, distributedPlanStopEpoch: 0, taskLifecycleProtocol: 2,
    distributedLaunchInFlight: new Set(), recordActionError: () => {},
    lastWorkerProbes: { nwpu3: { status: "ok", capabilities: { endpoints: { declaredJobPaths: true, formalJobIdentityEnv: 1, taskShellEnvironment: 1, projectManagedValidation: 1, gpuQuotaScheduling: 1 } } } },
    lastCodeSyncState: { fingerprint: "ec594411", workerVersions: { nwpu3: { fingerprint: "ec594411" } } },
    workerCodeSyncTargets: () => [], isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    loadDistributedQueue: async () => queue, saveDistributedQueue: async (_root, next) => { queue = next; },
    workerActionTargets: () => [{ id: "nwpu3" }], enabledWorkerConfigs: () => [{ id: "nwpu3" }],
    buildDistributedJobCodeManifest: async () => ({}),
    readWorkerTaskSnapshotBatch: async ids => ids.map(workerId => ({ workerId, queryComplete: true,
      fetchedAt: new Date().toISOString(), generatedAt: new Date().toISOString(),
      capabilities: { taskLifecycle: 2, durablePlanQueue: true, idleGpuAdmission: true, schemaVersion: 1 }, tasks: [] })),
    sendDistributedJob: async (plan, job, workerId, gpuId, commandId) => {
      sent.push({ planId: plan.id, jobIndex: job.index, workerId, gpuId, commandId });
      return { lifecycleProtocol: 2, status: "unknown", commandId, workerId, gpuId };
    },
    client: { getGpu: async () => ({ nwpu3: [{ index: "0", memoryTotalMb: 32768, memoryFreeMb: 24576, memoryUsedMb: 8192, utilizationPercent: 0, processes: [] }] }) },
    localWorkerAvailabilityRows: () => [{ workerId: "nwpu3", availableGpuIds: ["0"] }],
    availabilityPushTtlSeconds: () => 45, schedulerSettings: () => ({}),
    scheduleDistributedPostprocess: () => undefined, postState: () => undefined,
    refreshSelectedDistributedLog: () => undefined,
  };
  await context.tickQueue.call(provider);
  assert.deepEqual(sent.map((row) => row.jobIndex), [1], "隔离未完成 job 在真实 tick 候选筛选就被排除；同 PLAN 干净 job 正常派发");
  const blocked = queue.plans[0].jobs.find((job) => job.index === 0);
  assert.equal(blocked.status, "pending"); assert.equal(blocked.commandId, undefined);
  assert.ok(blocked.outputIsolationBlocked, "tick 轮次不得清除阻断标记");
  const sent0 = queue.plans[0].jobs.find((job) => job.index === 1);
  assert.equal(sent0.commandId, sent[0].commandId, "干净 job 走的是既有持久化→发送链");
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
    distributedLaunchInFlight: new Set(), recordActionError:()=>{},
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
