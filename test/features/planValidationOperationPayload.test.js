const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const DistributedPlanQueue = require("../../dist/features/DistributedPlanQueue.js");
const { ProgressInactivity } = require("../../dist/core/ProgressInactivity.js");

const source = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const parsed = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
const methods = new Map();
const functions = new Map();
function collect(node) {
  if (ts.isMethodDeclaration(node)) methods.set(node.name.getText(parsed), node.getText(parsed));
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(parsed));
  ts.forEachChild(node, collect);
}
collect(parsed);

const planFile = "experiments/plans/comparison/ebmc.yaml";
const revision = "52e776e5f9f455939795596b803a86e33e71333b55355b793c4d64accd946580";
const operationId = "validate-plan-1790619402512-cc0n8y";
// The affected NWPU3 operation returned these six jobs inside payload.validation.
const jobs = ["ebmc_bus_p100", "ebmc_pad_p100"].flatMap((caseName, caseIndex) =>
  [42, 43, 44].map((seed, seedIndex) => {
    const index = caseIndex * 3 + seedIndex;
    return { index, case: caseName, seed, output_dir: `work_dirs/ebmc/${index}_${caseName}_seed${seed}` };
  }));

function completedOperation(shape = "payload", validationOverrides = {}) {
  const validation = { ok: true, job_count: 6, jobs, existing: [], ...validationOverrides };
  const payload = { status: "completed", workerId: "nwpu3", planFile, planRevision: revision, validation };
  const operation = { operationId, type: "validate-plan", status: "completed", workerId: "nwpu3", planFile, planRevision: revision };
  if (shape === "direct") return { ...operation, validation };
  if (shape === "result") return { ...operation, result: { validation } };
  if (shape === "latestEvent") return { ...operation, latestEvent: { type: "operation_completed", payload } };
  return { ...operation, payload, latestEvent: { type: "operation_completed", payload } };
}

function hostFor(operation, accepted = true, outputChoice) {
  const notices = [];
  const dialogs = [];
  const context = {
    DistributedPlanQueue, DistributedSchedulingPolicy: { schedulingMode: (value) => value || "all" }, ProgressInactivity, Date, Set, Map,
    OPERATION_TERMINAL_STATUSES: new Set(["completed", "operation_completed", "completed_with_errors", "failed", "operation_failed", "cancelled", "canceled", "stalled", "unsupported", "error"]),
    REMOTE_ACTION_PENDING_STATUSES: new Set(["accepted", "submitted", "queued", "pending", "running", "progress", "in_progress", "operation_started"]),
    LONG_RUNNING_OPERATION_ACTIONS: new Set(["run-plan", "reproduce-plan"]),
    workspaceRoot: () => "D:/preflight-fixture",
    makeOpId: (prefix) => `${prefix}-fixture`,
    sleep: async () => {},
    actionErrorSuggestion: (message) => message,
    errorMessage: (error) => String(error.message || error),
    UiCommandCancelled: class UiCommandCancelled extends Error { constructor(message) { super(message); this.name = "UiCommandCancelled"; } },
    isUiCommandCancelled: (error) => error.name === "UiCommandCancelled",
    isUiCommandRemotePending: () => false,
    actionAffectsResultsSummary: () => false,
    vscode: { window: {
      showWarningMessage: async (message, _options, ...choices) => { notices.push(message); dialogs.push(choices); return outputChoice === null ? undefined : choices.includes(outputChoice) ? outputChoice : choices[0]; },
      showInformationMessage: async (message) => { notices.push(message); },
    } },
    uniqueStrings: (values) => [...new Set(values)],
  };
  const helperNames = ["stringFromRecord", "resultStatus", "operationStatusToken", "remoteActionPendingStatus", "remoteActionSucceeded", "operationStatusOf", "operationTerminal", "operationTerminalStatus", "operationLongRunningAction", "operationSubmissionAccepted", "operationResultPlanFile", "usableSelectionKey", "planCheckAccepted"];
  if (functions.has("planValidationFromResult")) helperNames.push("planValidationFromResult");
  helperNames.push("remoteOperationDurationMs");
  const methodNames = ["runPlanPreflight", "waitForOperationTerminalResult", "refreshOperationStatus", "confirmPlanExistingOutputs", "confirmPlanExistingOutputsFromValidation", "confirmDistributedPlanExistingOutputs", "enqueueDistributedPlan"];
  const emitted = ts.transpileModule(
    helperNames.map((name) => functions.get(name)).join("\n") + "\nthis.production = {\n" + methodNames.map((name) => methods.get(name)).join(",\n") + "\n}; this.accepted = planCheckAccepted;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  vm.createContext(context);
  new vm.Script(emitted).runInContext(context);
  const host = Object.create(context.production);
  Object.assign(host, {
    localOperations: {}, queue: DistributedPlanQueue.emptyDistributedQueue(),
    lastWorkerProbes: { nwpu3: { status: "ok" } },
    lastCodeSyncState: { fingerprint: "verified-code", workerVersions: { nwpu3: { fingerprint: "verified-code" } } },
    projectContextGeneration: 1, errors: [], reads: [], actions: [], authorityValid: true,
    client: {
      getWorkerOperation: async (workerId, opId) => { host.reads.push([workerId, opId]); return operation; },
      getGpu: async () => ({ workers: [] }),
    },
    assertActionAuthorityCurrent: () => { if (!host.authorityValid) { const error = new Error("工作区已切换"); error.name = "UiCommandCancelled"; throw error; } },
    planSchedulerWorkerId: () => "nwpu3",
    enabledWorkerConfigs: () => [{ id: "nwpu3", displayName: "NWPU3" }],
    postPlanSchedulerAction: async (action) => { host.actions.push(action); return accepted ? { operationId, status: "accepted", planFile, planRevision: revision } : operation; },
    operationManualWaitDelayMs: () => 0,
    throwIfTerminalActionFailure: (_title, _action, status) => { if (["failed", "cancelled", "completed_with_errors"].includes(status)) throw new Error(status); },
    clearOperationStatusProbe: () => {}, clearOperationWatchdog: () => {}, markLocalOperationsDirty: () => {}, postState: () => {},
    distributedPlanEligible: () => true,
    planValidationCacheKey: () => "",
    cachedPlanValidation: () => undefined,
    rememberPlanValidation: () => {},
    loadDistributedQueue: async () => host.queue,
    saveDistributedQueue: async (_root, queue) => { host.queue = queue; },
    availabilityPushTtlSeconds: () => 60, schedulerSettings: () => ({}),
    localWorkerAvailabilityRows: () => [{ workerId: "nwpu3", availableGpuIds: [0, 1, 2, 3, 4, 5], capacityLimit: 6 }],
    recordActionError: (error) => host.errors.push(error),
  });
  return { host, notices, dialogs, accepted: context.accepted };
}

for (const shape of ["payload", "latestEvent", "direct", "result"]) {
  test(`${shape} validation survives accepted operation polling, preview, output confirmation and enqueue`, async () => {
    const operation = shape === "payload" && process.env.SIMPLEEX_PREFLIGHT_REPLAY
      ? JSON.parse(fs.readFileSync(process.env.SIMPLEEX_PREFLIGHT_REPLAY, "utf8")) : completedOperation(shape);
    const { host, notices } = hostFor(operation);
    const body = { planFile, planRevision: revision, options: {} };
    const checked = await host.runPlanPreflight(body, "当前计划");
    assert.ok(checked);
    assert.equal(checked.operationId, operationId);
    assert.equal(checked.workerId, "nwpu3");
    assert.equal(checked.planRevision, revision);
    assert.equal(checked.distributedPreview.totalJobs, 6);
    assert.equal(checked.distributedPreview.dispatchableCount, 6);
    await host.confirmDistributedPlanExistingOutputs({}, body, checked);
    assert.equal((await host.enqueueDistributedPlan(body, checked, true)).enqueued, true);
    assert.equal(host.queue.plans.length, 1);
    assert.deepEqual(Array.from(host.queue.plans[0].jobs, (job) => [job.index, job.case, job.seed]), jobs.map((job) => [job.index, job.case, job.seed]));
    assert.ok(host.queue.plans[0].jobs.every((job) => job.outputDir.endsWith("/attempts/distributed-plan-fixture")));
    assert.deepEqual(host.reads, [["nwpu3", operationId]]);
    assert.deepEqual(host.actions, ["validate-plan"]);
    assert.equal(host.errors.length, 0);
    assert.equal(notices.length, 0);
  });
}

test("a synchronous wrapped completion is also usable without polling", async () => {
  const { host } = hostFor(completedOperation(), false);
  const checked = await host.runPlanPreflight({ planFile, planRevision: revision }, "当前计划");
  assert.equal(checked.distributedPreview.totalJobs, 6);
  assert.equal(host.reads.length, 0);
});

test("partial historical outputs let the user enqueue only missing jobs", async () => {
  const existing = jobs.slice(0, 4).map(({ index, output_dir }) => ({ index, output_dir }));
  const { host, notices, dialogs } = hostFor(completedOperation("latestEvent", { existing }), true, "仅补跑缺失任务（2）");
  const body = { planFile, planRevision: revision, options: {} };
  const checked = await host.runPlanPreflight(body, "当前计划");
  await host.confirmDistributedPlanExistingOutputs({}, body, checked);
  assert.deepEqual(Array.from(body.distributedSkipJobIndices), [0, 1, 2, 3]);
  assert.equal(body.overwriteExisting, false);
  assert.match(notices[0], /总 job 数：6/);
  assert.match(notices[0], /已有产物：4/);
  assert.match(notices[0], /缺失 job：2/);
  assert.deepEqual(Array.from(dialogs[0]), ["仅补跑缺失任务（2）", "重跑全部（6）", "取消"]);
  await host.enqueueDistributedPlan(body, checked, true);
  assert.deepEqual(Array.from(host.queue.plans[0].jobs, (job) => job.index), [4, 5]);
  assert.equal(host.queue.plans[0].planJobCount, 2);
  assert.equal(host.queue.plans[0].fullPlanJobCount, 6);
  assert.ok(host.queue.plans[0].jobs.every((job) => job.outputDir.endsWith("/attempts/distributed-plan-fixture")));
});

test("partial historical outputs let the user force all jobs into new attempts", async () => {
  const existing = jobs.slice(0, 4).map(({ index, output_dir }) => ({ index, output_dir }));
  const { host } = hostFor(completedOperation("latestEvent", { existing }), true, "重跑全部（6）");
  const body = { planFile, planRevision: revision, options: {} };
  const checked = await host.runPlanPreflight(body, "当前计划");
  await host.confirmDistributedPlanExistingOutputs({}, body, checked);
  assert.equal(body.overwriteExisting, true);
  assert.deepEqual(Array.from(body.distributedSkipJobIndices), []);
  await host.enqueueDistributedPlan(body, checked, true);
  assert.deepEqual(Array.from(host.queue.plans[0].jobs, (job) => job.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(host.queue.plans[0].overwriteExisting, true);
  assert.equal(host.queue.plans[0].fullPlanJobCount, 6);
  assert.ok(host.queue.plans[0].jobs.every((job) => job.outputDir.endsWith("/attempts/distributed-plan-fixture")));
});

test("complete historical outputs still offer explicit rerun and preserve history", async () => {
  const prior = (id, selectedJobs) => ({ id, planFile, revision: `old-${id}`, codeFingerprint: "old", enqueuedAt: "2026-01-01", jobs: selectedJobs.map((job) => ({
    index: job.index, case: job.case, seed: job.seed, outputDir: `${job.output_dir}/attempts/${id}`, attempt: 1, status: "completed",
  })) });
  const { host, notices, dialogs } = hostFor(completedOperation("latestEvent", { existing: [] }), true, "强制重跑全部（6）");
  host.queue.plans.push(prior("old-a", jobs.slice(0, 2)), prior("old-b", jobs.slice(2)));
  const body = { planFile, planRevision: revision, options: {} };
  const checked = await host.runPlanPreflight(body, "当前计划");
  await host.confirmDistributedPlanExistingOutputs({}, body, checked);
  assert.equal(body.existingOutputCount, 6);
  assert.equal(body.existingOutputChoice, "rerun_all");
  assert.match(notices[0], /已有产物 6\/6，当前 Plan 已完整完成/);
  assert.deepEqual(Array.from(dialogs[0]), ["强制重跑全部（6）", "保留现有结果，不运行"]);
  assert.equal(body.overwriteExisting, true);
  assert.deepEqual(Array.from(body.distributedSkipJobIndices), []);
  assert.equal(dialogs.length, 1);
  await host.enqueueDistributedPlan(body, checked, true);
  assert.equal(host.queue.plans.length, 3);
  assert.deepEqual(host.queue.plans.slice(0, 2).map((item) => item.id), ["old-a", "old-b"]);
  assert.deepEqual(Array.from(host.queue.plans[2].jobs, (job) => job.index), [0, 1, 2, 3, 4, 5]);
  assert.ok(host.queue.plans[2].jobs.every((job) => /\/attempts\/distributed-plan-fixture$/.test(job.outputDir)));
  assert.ok(host.queue.plans[2].jobs.every((job) => !["old-a", "old-b"].includes(job.outputDir.split("/attempts/")[1])));
});

test("complete historical outputs can be retained without submitting jobs", async () => {
  const prior = { id: "prior", planFile, revision, codeFingerprint: "old", enqueuedAt: "2026-01-01", jobs: jobs.map((job) => ({
    index: job.index, case: job.case, seed: job.seed, outputDir: `${job.output_dir}/attempts/prior`, attempt: 1, status: "completed",
  })) };
  const { host, dialogs } = hostFor(completedOperation("latestEvent", { existing: [] }), true, "保留现有结果，不运行");
  host.queue.plans.push(prior);
  const body = { planFile, planRevision: revision, options: {} };
  const checked = await host.runPlanPreflight(body, "当前计划");
  await host.confirmDistributedPlanExistingOutputs({}, body, checked);
  assert.deepEqual(Array.from(dialogs[0]), ["强制重跑全部（6）", "保留现有结果，不运行"]);
  assert.equal(body.existingOutputChoice, "keep_existing");
  assert.equal(host.queue.plans.length, 1);
  const retained = await host.enqueueDistributedPlan(body, checked, true);
  assert.equal(retained.enqueued, false);
  assert.equal(retained.keptExisting, true);
  assert.equal(host.queue.plans.length, 1);
});

test("wrapped remote empty validation merges two completed queue plans before the modal", async () => {
  const { host, notices, dialogs } = hostFor(completedOperation("latestEvent", { existing: [] }), true, "强制重跑全部（6）");
  const historical = (id, selectedJobs) => ({ id, planFile, revision: `old-${id}`, codeFingerprint: "old", enqueuedAt: "2026-01-01", jobs: selectedJobs.map((job) => ({
    index: job.index, case: job.case, seed: job.seed, outputDir: `${job.output_dir}/attempts/${id}`, attempt: 1, status: "completed",
  })) });
  host.queue.plans.push(historical("history-01", jobs.slice(0, 2)), historical("history-02", jobs.slice(2)));
  const body = { planFile, planRevision: revision, options: {} };
  const wrapped = completedOperation("latestEvent", { existing: [] });
  wrapped.payload = wrapped.latestEvent.payload;
  assert.deepEqual(wrapped.latestEvent.payload.validation.existing, []);
  assert.deepEqual(wrapped.payload.validation.existing, []);
  const checked = await host.runPlanPreflight(body, "当前计划");
  await host.confirmDistributedPlanExistingOutputs({}, body, checked);
  assert.equal(body.existingOutputCount, 6);
  assert.equal(body.existingOutputChoice, "rerun_all");
  assert.equal(notices.length, 1);
  assert.deepEqual(Array.from(dialogs[0]), ["强制重跑全部（6）", "保留现有结果，不运行"]);
  const submission = await host.enqueueDistributedPlan(body, checked, true);
  assert.equal(submission.enqueued, true);
  assert.equal(host.queue.plans.length, 3);
  assert.equal(host.queue.plans[2].jobs.length, 6);
});

test("partial historical queue plus empty remote validation offers missing-only and enqueues two", async () => {
  const { host, notices, dialogs } = hostFor(completedOperation("latestEvent", { existing: [] }), true, "仅补跑缺失任务（2）");
  const prior = { id: "history-04", planFile, revision: "old", codeFingerprint: "old", enqueuedAt: "2026-01-01", jobs: jobs.slice(0, 4).map((job) => ({
    index: job.index, case: job.case, seed: job.seed, outputDir: `${job.output_dir}/attempts/history-04`, attempt: 1, status: "completed",
  })) };
  host.queue.plans.push(prior);
  const body = { planFile, planRevision: revision, options: {} };
  const checked = await host.runPlanPreflight(body, "当前计划");
  await host.confirmDistributedPlanExistingOutputs({}, body, checked);
  assert.equal(body.existingOutputCount, 4);
  assert.equal(body.existingOutputChoice, "rerun_missing");
  assert.deepEqual(Array.from(body.distributedSkipJobIndices), [0, 1, 2, 3]);
  assert.match(notices[0], /已有产物：4/);
  assert.deepEqual(Array.from(dialogs[0]), ["仅补跑缺失任务（2）", "重跑全部（6）", "取消"]);
  const submission = await host.enqueueDistributedPlan(body, checked, true);
  assert.equal(submission.enqueued, true);
  assert.deepEqual(Array.from(host.queue.plans[1].jobs, (job) => job.index), [4, 5]);
});

test("missing modal choice fails closed and never silently skips all historical jobs", async () => {
  const { host, dialogs } = hostFor(completedOperation("latestEvent", { existing: [] }), true, null);
  host.queue.plans.push({ id: "history-all", planFile, revision: "old", codeFingerprint: "old", enqueuedAt: "2026-01-01", jobs: jobs.map((job) => ({
    index: job.index, case: job.case, seed: job.seed, outputDir: `${job.output_dir}/attempts/history-all`, attempt: 1, status: "completed",
  })) });
  const body = { planFile, planRevision: revision, options: {} };
  const checked = await host.runPlanPreflight(body, "当前计划");
  await assert.rejects(() => host.confirmDistributedPlanExistingOutputs({}, body, checked), /未选择当前 Plan 历史产物处理方式/);
  assert.equal(dialogs.length, 1);
  assert.equal(body.existingOutputChoice, undefined);
  assert.equal(body.distributedSkipJobIndices, undefined);
  assert.equal(host.queue.plans.length, 1);
  await assert.rejects(() => host.enqueueDistributedPlan(body, checked, true), /历史产物处理方式未确认/);
  assert.equal(host.queue.plans.length, 1);
});

test("single-worker partial and complete outputs use the same explicit choice model", async () => {
  const partial = jobs.slice(0, 4).map(({ index, output_dir }) => ({ index, output_dir }));
  const { host, dialogs } = hostFor(completedOperation("payload", { existing: partial }), true, "重跑全部（6）");
  const body = { planFile, options: {} };
  await host.confirmPlanExistingOutputs({}, body, completedOperation("payload", { existing: partial }));
  assert.equal(body.overwriteExisting, true);
  assert.deepEqual(Array.from(dialogs[0]), ["仅补跑缺失任务（2）", "重跑全部（6）", "取消"]);
});

test("wrapped historical outputs preserve the user's skip choice through enqueue", async () => {
  const existing = [{ index: 0, output_dir: jobs[0].output_dir }];
  const { host, notices } = hostFor(completedOperation("latestEvent", { existing }));
  const body = { planFile, planRevision: revision, options: {} };
  const checked = await host.runPlanPreflight(body, "当前计划");
  await host.confirmDistributedPlanExistingOutputs({}, body, checked);
  assert.deepEqual(Array.from(body.distributedSkipJobIndices), [0]);
  assert.equal(body.overwriteExisting, false);
  await host.enqueueDistributedPlan(body, checked, true);
  assert.deepEqual(Array.from(host.queue.plans[0].jobs, (job) => job.index), [1, 2, 3, 4, 5]);
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes(jobs[0].output_dir));
});

test("single-worker output confirmation reads wrapped history too", async () => {
  const { host, notices } = hostFor(completedOperation("payload", { existing: [{ index: 0, output_dir: jobs[0].output_dir }] }));
  const body = { planFile, options: {} };
  await host.confirmPlanExistingOutputs({}, body, completedOperation("payload", { existing: [{ index: 0, output_dir: jobs[0].output_dir }] }));
  assert.equal(body.overwriteExisting, false);
  assert.equal(notices.length, 1);
});

test("missing jobs still block preview and never create a queue entry", async () => {
  const { host } = hostFor(completedOperation("payload", { jobs: [] }));
  await assert.rejects(() => host.runPlanPreflight({ planFile, planRevision: revision }, "当前计划"), /Agent 校验未返回逐 job 清单/);
  assert.equal(host.queue.plans.length, 0);
});

test("terminal failure and wrapped validation rejection cannot be accepted", async () => {
  const { accepted } = hostFor(completedOperation());
  assert.equal(accepted({ ...completedOperation(), status: "failed" }), false);
  assert.equal(accepted({ ...completedOperation(), status: "completed_with_errors" }), false);
  assert.equal(accepted(completedOperation("payload", { ok: false })), false);
  assert.equal(accepted(completedOperation("latestEvent", { ok: false })), false);
  const { host } = hostFor(completedOperation("payload", { ok: false }));
  await assert.rejects(() => host.runPlanPreflight({ planFile }, "当前计划"), /计划校验.*失败|计划校验失败/);
  assert.equal(host.queue.plans.length, 0);
});

test("latest validation evidence overrides a stale root or payload validation", async () => {
  const operation = completedOperation("latestEvent", { jobs: [] });
  operation.validation = { ok: true, jobs, existing: [] };
  operation.payload = { validation: operation.validation };
  const { host } = hostFor(operation);
  await assert.rejects(() => host.runPlanPreflight({ planFile, planRevision: revision }, "当前计划"), /Agent 校验未返回逐 job 清单/);
});

test("switching workspace while waiting cancels before local preview or enqueue", async () => {
  const { host } = hostFor(completedOperation());
  const read = host.client.getWorkerOperation;
  host.client.getWorkerOperation = async (...args) => { const result = await read(...args); host.authorityValid = false; return result; };
  await assert.rejects(() => host.runPlanPreflight({ planFile }, "当前计划"), /工作区已切换/);
  assert.equal(host.queue.plans.length, 0);
  assert.equal(host.errors.length, 0);
});
