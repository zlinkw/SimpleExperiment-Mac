const test = require("node:test");
const assert = require("node:assert/strict");
require("../_helpers/registerTsRequire");
const Q = require("../../src/features/DistributedPlanQueue.ts");
const { summarizePlanStatuses } = require("../../src/features/PanelPlanStatusSummary.ts");
const { changeJobAvailabilityFromUi } = require("../../src/features/JobAvailability.ts");
const { selectLatestCompletePlanRun } = require("../../src/results/PlanRunFreshness.ts");
const { serverAuthoritativeProgress, allocateServerPrequeue } = require("../../src/features/DistributedSchedulingPolicy.ts");

function fixture(status = "failed") {
  const plan = { id: "workflow-unavailable", projectId: Q.canonicalProjectId("D:/project"),
    planFile: "experiments/plans/tuning/method.yaml", revision: "rev", codeFingerprint: "code",
    executionMode: "train", enqueuedAt: "2026-10-10T00:00:00Z", planJobCount: 3,
    jobs: [42, 43, 44].map((seed, index) => ({ index, case: "case", seed, attempt: 1,
      status: index ? "completed" : status, workerId: "worker", commandId: "command-" + index,
      runKey: "command-" + index, gpuId: "0", outputDir: `work_dirs/case/${index}/attempts/workflow-unavailable`,
      finishedAt: "2026-10-10T00:01:00Z", error: index ? undefined : "ValueError: invalid parameter" })) };
  const queue = { schemaVersion: 1, plans: [plan] }, job = plan.jobs[0];
  const receipt = { ...job, workflowId: plan.id, projectId: plan.projectId, planFile: plan.planFile,
    planRevision: plan.revision, codeFingerprint: plan.codeFingerprint, planJobCount: 3,
    experimentIndex: 0, executionMode: "train", enqueuedAt: plan.enqueuedAt };
  return { queue, plan, job, receipt };
}
function mark(f) {
  return Q.markJobUnavailable(f.queue, f.plan.id, 0, Q.jobAvailabilityIdentity(f.plan, f.job),
    "这组参数不适用", "2026-10-10T00:02:00Z", f.receipt);
}
function snapshot(tasks) {
  return { workerId: "worker", capabilities: { durablePlanQueue: true, schemaVersion: 1 },
    generatedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), tasks };
}

test("unavailable decision survives queue restoration and matching failed Worker refresh without retries", () => {
  const f = fixture(), before = structuredClone(f.queue), marked = mark(f);
  assert.deepEqual(f.queue, before);
  let restored = JSON.parse(JSON.stringify(marked));
  restored = Q.mergeDurableWorkerSnapshots(restored, [snapshot(
    f.plan.jobs.map((job, i) => ({ ...f.receipt, ...job, experimentIndex: i })))], f.plan.projectId);
  const job = restored.plans[0].jobs[0];
  assert.equal(job.status, "cancelled");
  assert.equal(job.unavailable.reason, "这组参数不适用");
  assert.equal(job.error, f.job.error); assert.equal(job.outputDir, f.job.outputDir);
  assert.deepEqual(restored.plans[0].jobs.slice(1).map(j => [j.status, j.commandId, j.outputDir]),
    marked.plans[0].jobs.slice(1).map(j => [j.status, j.commandId, j.outputDir]));
  assert.equal(Q.unfinishedJobs(restored.plans[0]), false);
  assert.equal(Q.hasUnresolvedPlanRecovery(restored.plans[0]), false);
  assert.equal(serverAuthoritativeProgress(restored, [snapshot([f.receipt])], f.plan.projectId)[0].jobs[0].status, "cancelled");
  const retried = Q.scheduleAutomaticJobRetries(restored, [snapshot([f.receipt])], f.plan.projectId,
    { selectedPlanFile: f.plan.planFile, makeAttemptId: () => { throw Error("must not retry"); } });
  assert.equal(retried.plans[0].jobs[0].attempt, 1);
  assert.throws(() => Q.retryVerifiedJob(restored, f.plan.id, 0, "retry-attempt-123"));
  assert.equal(restored.plans[0].jobs.filter(j => j.status === "completed").length, 2);
  assert.equal(restored.plans[0].jobs.every(j => j.status === "completed"), false);
  assert.equal(selectLatestCompletePlanRun(restored, f.plan.planFile), undefined);
  const [summary] = summarizePlanStatuses({ plans: [{ file: f.plan.planFile, revision: "rev", jobCount: 3 }],
    distributedPlans: restored.plans });
  assert.equal(summary.status, "partial"); assert.equal(summary.activeCount, 0);
  assert.equal(summary.completedCount, 2); assert.equal(summary.failedCount, 0);
  assert.equal(summary.unavailableCount, 1);
});

test("unassigned pending and never-sent automatic attempts can be excluded without any remote action", () => {
  const f = fixture("pending"); Object.assign(f.job, { workerId: undefined, commandId: undefined, gpuId: undefined,
    finishedAt: undefined, automaticRetry: { failureCount: 1, failedAttempt: 0, retryAt: "2026-10-11" } });
  f.plan.recoveryMissingCount = 1;
  const next = Q.markJobUnavailable(f.queue, f.plan.id, 0, Q.jobAvailabilityIdentity(f.plan, f.job), "参数不支持", "2026-10-10T00:02:00Z");
  assert.equal(next.plans[0].jobs[0].automaticRetry, undefined);
  assert.equal(Q.distributedPlanRecoveryMissingCount(next.plans[0]), 0);
  assert.equal(next.plans[0].recoveryMissingCount, 0);
  assert.equal(Q.allocateAvailable(next, [{ workerId: "worker", online: true, codeFingerprint: "code", idleGpuIds: ["0"] }]).dispatches.length, 0);
  next.plans[0].schedulingMode = "server_prequeue";
  assert.equal(allocateServerPrequeue(next, [{ workerId: "worker", online: true, codeFingerprint: "code", weight: 1 }]).dispatches.length, 0);
});

test("active, uncertain, mismatched, stale and blank-reason decisions are rejected", () => {
  for (const status of ["running", "queued", "dispatching", "unknown", "completed"]) {
    const f = fixture(status); assert.throws(() => mark(f));
  }
  const f = fixture();
  for (const key of ["workerId", "workflowId", "attempt", "outputDir", "commandId", "seed"]) {
    const broken = { ...f.receipt, [key]: key === "seed" || key === "attempt" ? 999 : "foreign" };
    assert.throws(() => Q.markJobUnavailable(f.queue, f.plan.id, 0, Q.jobAvailabilityIdentity(f.plan, f.job), "参数不适用", "2026-10-10T00:02:00Z", broken));
  }
  assert.throws(() => Q.markJobUnavailable(f.queue, f.plan.id, 0, "stale", "参数不适用", "2026-10-10T00:02:00Z", f.receipt));
  assert.throws(() => Q.markJobUnavailable(f.queue, f.plan.id, 0, Q.jobAvailabilityIdentity(f.plan, f.job), " ", "2026-10-10T00:02:00Z", f.receipt));
});

test("late active remote evidence fails closed instead of silently hiding a real running job", () => {
  const f = fixture(), next = mark(f);
  const merged = Q.mergeDurableWorkerSnapshots(next, [snapshot([{ ...f.receipt, status: "running", finishedAt: undefined }])], f.plan.projectId);
  assert.equal(merged.plans[0].jobs[0].status, "unknown");
  assert.equal(merged.plans[0].jobs[0].recoveryConflict, true);
});

function hostFixture(status = "failed") {
  const f = fixture(status); let queue = f.queue, active = true, reads = 0, writes = 0, posts = 0, ticks = 0;
  const context = { root: "D:/project" };
  const host = { client: { getWorkerTasks: async () => { reads++; return { tasks: [f.receipt] }; },
      postWorkerAction: () => { throw Error("no remote mutations permitted"); } },
    captureProjectContext: () => context, projectContextIsCurrent: ctx => active && ctx === context,
    loadDistributedQueue: async () => structuredClone(queue),
    saveDistributedQueue: async (_, unused, options) => { assert.equal(unused, undefined);
      assert.equal(options.queueGeneration, host.distributedQueueGeneration);
      queue = options.mutateLatest(structuredClone(queue)); writes++; },
    detachStaleDistributedTick() {}, postState() { posts++; }, tickDistributedQueue: async () => { ticks++; }, recordActionError() {},
  };
  const message = { command: "markJobUnavailable", planId: f.plan.id, planFile: f.plan.planFile,
    jobIndex: 0, attempt: 1, commandId: "command-0" };
  return { ...f, host, message, get queue() { return queue; }, get reads() { return reads; },
    get writes() { return writes; }, get posts() { return posts; }, get ticks() { return ticks; },
    changeJob: patch => Object.assign(queue.plans[0].jobs[0], patch), switchProject: () => active = false };
}

test("real UI action verifies twice, records a reason, preserves siblings and can undo without retraining", async () => {
  const f = hostFixture(), siblings = structuredClone(f.queue.plans[0].jobs.slice(1)); let detail;
  const result = await changeJobAvailabilityFromUi(f.host, f.message, async () => "参数不支持", async text => (detail = text, true));
  assert.equal(result.status, "completed"); assert.equal(f.reads, 2); assert.equal(f.writes, 1); assert.equal(f.posts, 1);
  assert.ok(detail.includes(f.job.outputDir)); assert.ok(detail.includes(f.plan.id));
  assert.deepEqual(f.queue.plans[0].jobs.slice(1), siblings); assert.equal(f.ticks, 0);
  assert.equal(f.queue.plans[0].jobs[0].unavailable.reason, "参数不支持");
  await changeJobAvailabilityFromUi(f.host, { ...f.message, command: "restoreJobAvailability" },
    () => { throw Error("no new reason on undo"); }, async () => true);
  const restored = f.queue.plans[0].jobs[0];
  assert.equal(restored.status, "failed"); assert.equal(restored.attempt, 1); assert.equal(restored.unavailable, undefined);
  const retried = Q.scheduleAutomaticJobRetries(f.queue, [snapshot([f.receipt])], f.plan.projectId,
    { selectedPlanFile: f.plan.planFile, makeAttemptId: () => { throw Error("undo must not auto retrain"); } });
  assert.equal(retried.plans[0].jobs[0].status, "failed");
});

test("cancel, project switch, stale attempt and refreshed active receipt cannot mutate the queue", async () => {
  for (const scenario of ["cancel", "switch", "attempt", "running"]) {
    const f = hostFixture(), before = structuredClone(f.queue);
    const run = () => changeJobAvailabilityFromUi(f.host, f.message, async () => "参数不支持", async () => {
      if (scenario === "switch") f.switchProject();
      if (scenario === "attempt") f.changeJob({ attempt: 2 });
      if (scenario === "running") f.receipt.status = "running";
      return scenario !== "cancel";
    });
    if (["attempt", "running"].includes(scenario)) await assert.rejects(run);
    else assert.equal((await run()).status, "cancelled");
    assert.equal(f.writes, 0); assert.equal(f.posts, 0);
    assert.equal(f.queue.plans[0].jobs[0].unavailable, undefined);
    assert.deepEqual(f.queue.plans[0].jobs.slice(1), before.plans[0].jobs.slice(1));
  }
});

test("marking a local pending job needs no Worker and undo reopens just that local slot", async () => {
  const f = hostFixture("pending"); f.changeJob({ workerId: undefined, commandId: undefined, gpuId: undefined });
  f.message.commandId = "";
  await changeJobAvailabilityFromUi(f.host, f.message, async () => "不适用", async () => true);
  assert.equal(f.reads, 0); assert.equal(f.queue.plans[0].jobs[0].status, "cancelled");
  await changeJobAvailabilityFromUi(f.host, { ...f.message, command: "restoreJobAvailability" }, async () => "", async () => true);
  assert.equal(f.reads, 0); assert.equal(f.queue.plans[0].jobs[0].status, "pending"); assert.equal(f.ticks, 1);
});

test("an older complete run remains the formal result; excluded seed cannot backfill a newer run", () => {
  const f = fixture(), old = structuredClone(f.plan); old.id = "old-workflow";
  old.enqueuedAt = "2026-10-09T00:00:00Z"; old.jobs.forEach(job => {
    job.status = "completed"; job.artifacts = { [job.outputDir + "/metrics_summary.csv"]: "a".repeat(64) };
  });
  const marked = mark(f); marked.plans.unshift(old);
  assert.equal(selectLatestCompletePlanRun(marked, f.plan.planFile).plan.id, old.id);
  assert.equal(marked.plans[1].jobs[0].seed, 42);
  assert.equal(marked.plans[1].jobs.filter(job => job.status === "completed").length, 2);
});

test("real Host dispatch reports completion, cancellation and rejected ownership to the clicked job", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), ts = require("typescript");
  const source = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
  const coreStart = source.indexOf("    async handleMessageCore("), statusStart = source.indexOf("    private async withUiCommandStatus(");
  const end = source.indexOf("    uiCommandWatchdogMs(", statusStart);
  assert.ok(coreStart > 0 && statusStart > coreStart && end > statusStart);
  const code = ts.transpileModule("const subject = {" + source.slice(coreStart, end).replace("private async", "async") + "};", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  for (const scenario of ["complete", "cancel", "reject"]) {
    const f = hostFixture(), statuses = [], errors = [];
    const scope = { JobAvailability: { changeJobAvailabilityFromUi }, booleanField: () => false,
      localCommandReleasesAfterTrigger: () => false, PLAN_SUBMISSION_COMMANDS: new Set(),
      isUiCommandRemotePending: () => false, isUiCommandCancelled: () => false, errorMessage: error => error.message,
      actionErrorSuggestion: () => "", compactSensitiveText: text => text, hostOperationLeaseActionLabel: () => "标记 job 不可用",
      OperationOutcome_1: require("../../src/core/OperationOutcome.ts"), vscode: { window: {
        showInputBox: async () => "参数不适用", showWarningMessage: async (_, __, label) => scenario === "cancel" ? undefined : label,
        showInformationMessage: async () => {}, showErrorMessage: async (_, options) => errors.push(options.detail),
      } } };
    Object.assign(f.host, vm.runInNewContext(code + "\nsubject;", scope), {
      extensionRuntimeVersionState: () => ({ reloadRequired: false }), panelLifecycleState: "ready",
      postUiCommandStatus: (id, status, command, message) => statuses.push({ id, status, command, message }), finishPlanSubmissionProgress() {},
    });
    if (scenario === "reject") f.receipt.workerId = "foreign";
    f.message.clientActionId = "unavailable-click-0";
    await f.host.withUiCommandStatus(f.message.clientActionId, f.message.command, f.message,
      () => f.host.handleMessageCore(f.message, f.message.command));
    assert.equal(statuses.at(-1).id, f.message.clientActionId);
    assert.equal(statuses.at(-1).status, scenario === "complete" ? "completed" : scenario === "cancel" ? "cancelled" : "failed");
    assert.equal(f.writes, scenario === "complete" ? 1 : 0); assert.equal(errors.length, scenario === "reject" ? 1 : 0);
    if (scenario === "complete") assert.match(statuses.at(-1).message, /已标记此 job 不可用/);
  }
});
