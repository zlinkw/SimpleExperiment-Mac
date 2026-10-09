const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const binding = require("../../dist/mac/WorkflowBinding");
const workflow = require("../../dist/features/ApiWorkflow");
const compiled = fs.readFileSync(path.resolve(__dirname, "../../dist/extension/legacy.js"), "utf8");

function source(name) {
  const start = compiled.search(new RegExp("^    (?:async )?" + name + "\\(", "m")); assert.ok(start >= 0, name);
  const tail = compiled.slice(start), end = tail.slice(1).search(/^    (?:async )?[a-zA-Z][a-zA-Z0-9_]*\(/m) + 1;
  assert.ok(end > 0, name); return tail.slice(0, end);
}

function fixture(mode = "single_worker") {
  const initial = "/Users/test/研究 A ", other = "/Users/test/研究 B";
  let root = initial, inode = 1;
  const calls = [], state = { changeAt: "", activeAt: 0, activeChecks: 0 };
  const probe = value => ({ canonical: value, device: 10, inode: value === initial ? inode : 2 });
  const guard = { ...binding, bindWorkflowWorkspace: (requested, current) => binding.bindWorkflowWorkspace(requested, current, probe), assertWorkflowWorkspace: (snapshot, current) => binding.assertWorkflowWorkspace(snapshot, current, probe) };
  const step = name => { calls.push(name); if (state.changeAt === name) root = other; if (state.changeAt === name + ":replace") inode++; };
  const provider = {
    isMacVariant: () => true, localOperations: {}, localPlanMetadata: { plans: [{ planFile: "experiments/plans/A.yaml" }, { planFile: "experiments/plans/A.yaml " }] }, setupConfig: {}, apiFlowState: {},
    async reconcileStalePlanRunOperations() { step("reconcile"); }, async refreshLocalPlanMetadata() { step("metadata"); },
    projectTopologyAssessment: () => ({ mode }), async apiProjectPrepare() { step("prepare"); },
    async apiPlanValidate() { step("validate"); return { missing: [] }; }, apiPublicTopology: value => value,
    longRunningPlanRunOperations: () => [], buildPlanRuntimeEvidenceState: () => ({}),
    async assertPlanNotAlreadyActive() { step("active"); if (++state.activeChecks === state.activeAt) throw Error("ACTIVE_PLAN_RUN_EXISTS"); },
    markLocalOperationsDirty() { step("persist"); }, postState() { step("post"); }, async runApiWorkflowOperation() { step("operation"); },
  };
  const globals = {
    WorkflowBinding_1: guard, ApiWorkflow_1: { ...workflow, structuredMissingInventory: () => [] },
    workspaceRoot: () => root, assertSingleProjectWorkspace: () => root,
    simpleSftpIntegrationReadiness: () => ({ ready: true }), process,
    errorMessage: error => error.message, uniqueStrings: items => [...new Set(items)], stringArrayField: (params, key) => params[key] || [],
    samePlanSelection: (a, b) => a === b, operationResultPlanFile: value => value?.planFile || "", makeOpId: prefix => prefix + "-mock", LocalApiError: class extends Error {},
    isUiCommandRemotePending: () => false, isUiCommandCancelled: () => false,
  };
  for (const name of ["apiWorkflowPlan", "apiWorkflowRun", "runApiWorkflowOperation"]) provider[name] = vm.runInNewContext("({" + source(name) + "})", globals)[name];
  // Submission remains mocked unless the operation body itself is under test.
  const runOperation = provider.runApiWorkflowOperation;
  provider.runApiWorkflowOperation = async () => step("operation");
  return { provider, calls, state, globals, guard, initial, other, runOperation, step, setRoot: value => { root = value; } };
}

test("Mac workspace binding preserves POSIX spelling and rejects mismatches, invalid roots and replaced directories", () => {
  const f = fixture(); const snapshot = f.guard.bindWorkflowWorkspace(f.initial, f.initial);
  assert.equal(snapshot.root, f.initial);
  assert.throws(() => f.guard.bindWorkflowWorkspace(f.other, f.initial), /当前打开/);
  for (const root of ["/", "C:\\project", "/Users/test/../other", "//server/project", "/Users/test/A\n"]) assert.throws(() => f.guard.bindWorkflowWorkspace(root, f.initial));
  assert.throws(() => binding.assertWorkflowWorkspace(snapshot, f.initial, value => ({ canonical: value, device: 10, inode: 99 })), /身份已变化/);
  assert.throws(() => binding.assertPlanSeedContract({ seed: 42 }), /不支持 seed/);
});

test("actual workflow methods reject wrong workspace and seed before any preparation, validation or operation", async () => {
  const f = fixture();
  for (const name of ["apiWorkflowPlan", "apiWorkflowRun"]) {
    await assert.rejects(f.provider[name]({ workspace: f.other, planFile: "experiments/plans/A.yaml", autoPrepare: true, confirm: true }), /当前打开/);
    await assert.rejects(f.provider[name]({ workspace: f.initial, seed: "42", autoPrepare: true, confirm: true }), /不支持 seed/);
  }
  assert.equal(f.calls.length, 0); assert.equal(Object.keys(f.provider.localOperations).length, 0);
});

test("actual async workflow preflight stops after workspace or physical identity changes and selects exact spaced Plan", async () => {
  for (const phase of ["reconcile", "metadata", "validate", "reconcile:replace"]) {
    const f = fixture(); f.state.changeAt = phase;
    await assert.rejects(f.provider.apiWorkflowPlan({ planFile: "experiments/plans/A.yaml " }), /已变化/);
    assert.ok(!f.calls.includes("prepare")); assert.ok(!f.calls.includes("operation"));
  }
  for (const mode of ["single_worker", "worker_pool", "hub_worker"]) {
    const f = fixture(mode), result = await f.provider.apiWorkflowPlan({ planFile: "experiments/plans/A.yaml " });
    assert.equal(result.ready, true); assert.equal(result.plan.planFile, "experiments/plans/A.yaml "); assert.equal(result.calls[0].params.workspace, f.initial);
    assert.equal(result.topology.mode, mode);
  }
  const prepare = fixture(); prepare.state.changeAt = "prepare";
  prepare.globals.ApiWorkflow_1.structuredMissingInventory = () => [{ step: "prepare_agents", reason: "mock-only" }];
  await assert.rejects(prepare.provider.apiWorkflowPlan({ autoPrepare: true, confirm: true, planFile: "experiments/plans/A.yaml" }), /已变化/);
  assert.ok(!prepare.calls.includes("validate"));
  const plans = [{ planFile: "experiments/plans/A.yaml" }, { planFile: "experiments/plans/A.yaml " }];
  assert.equal(workflow.selectWorkflowPlan(plans, { planFile: "experiments/plans/A.yaml " }, "darwin").plan, plans[1]);
});

test("a changed workspace or active Plan never creates a pending operation; successful receipt preserves workspace", async () => {
  const f = fixture(); f.state.changeAt = "active";
  await assert.rejects(f.provider.apiWorkflowRun({ planFile: "experiments/plans/A.yaml" }), /已变化/);
  assert.equal(Object.keys(f.provider.localOperations).length, 0); assert.ok(!f.calls.includes("persist"));
  const active = fixture(); active.state.activeAt = 1;
  await assert.rejects(active.provider.apiWorkflowRun({ planFile: "experiments/plans/A.yaml" }), /ACTIVE/);
  assert.equal(Object.keys(active.provider.localOperations).length, 0);
  const good = fixture(), result = await good.provider.apiWorkflowRun({ planFile: "experiments/plans/A.yaml" });
  assert.equal(result.started, true); assert.equal(result.confirmation, "vscode_modal"); assert.equal(good.calls.at(-1), "operation");
});

test("late operation completion updates its original receipt without writing another workspace", async () => {
  const f = fixture(), snapshot = f.guard.bindWorkflowWorkspace(undefined, f.initial);
  const old = f.provider.localOperations; old.op = { status: "waiting_confirmation" };
  f.provider.runActionCommand = async () => { f.setRoot(f.other); f.provider.localOperations = {}; return { accepted: true }; };
  await f.runOperation.call(f.provider, "op", { calls: [{ params: { workspace: f.initial } }] }, snapshot);
  assert.equal(Object.keys(f.provider.localOperations).length, 0); assert.equal(old.op.status, "failed");
  assert.deepEqual(f.calls, ["persist", "post"]);
});

test("actual Plan core rechecks async choices and never runs the legacy automatic stop fallback on Mac", async () => {
  const f = fixture(); const core = source("runActionCommandCore");
  const globals = { ...f.globals, setTimeout, require: () => ({ assertBusinessAllowed() {} }), actionCommandMap: { runPlan: "run-plan" },
    PLAN_SUBMISSION_COMMANDS: new Set(["runPlan"]), PLAN_PREFLIGHT_COMMANDS: new Set(), directWorkerActionMap: {},
    stringField: (body, key) => body[key] || "", usableSelectionKey: value => value, pluginProjectAdapterRules: () => ({}),
    projectOutputGateReason: () => "", LENIENT_RUN: false, PlanSafeRetry_1: { preparePlanSafeRetry: async () => false },
    NO_HUB_RESULT_CONFIRM_COMMANDS: new Set(), PLAN_SCHEDULER_COMMANDS: new Set(["runPlan"]), RESULT_PARSE_COMMANDS: new Set(),
    IMMEDIATE_RESULT_SUMMARY_REFRESH_COMMANDS: new Set(), actionAffectsResultsSummary: () => false, resultStatus: result => result?.status || "",
  };
  for (const name of new Set([...core.matchAll(/this\.([a-zA-Z0-9_]+)\(/g)].map(match => match[1]))) if (!(name in f.provider)) f.provider[name] = async () => { f.calls.push(name); };
  Object.assign(f.provider, { actionBody: value => value, resolveWorkerEndpointId: value => value, localPlanForActionBody: () => ({ planFile: "experiments/plans/A.yaml" }), distributedPlanEligible: () => false,
    ensureSimpleSftpReadyForSetup: async () => true, runPlanPreflight: async () => ({ ok: true }), workerActionTargets: () => [], postNoHubResultAction: async () => { f.calls.push("remote-submit"); return { status: "accepted" }; },
    lastState: { schedulerStates: [{ plan: "A.yaml", running_experiments: ["existing"] }], operations: {} },
  });
  const method = vm.runInNewContext("({" + core + "})", globals).runActionCommandCore;
  await method.call(f.provider, "runPlan", { workspace: f.initial, planFile: "experiments/plans/A.yaml" });
  assert.ok(f.calls.includes("remote-submit")); assert.ok(!f.calls.includes("abortSchedulerFromUi")); assert.equal(f.state.activeChecks, 2);
  f.calls.length = 0; f.state.activeChecks = 0; f.state.activeAt = 2;
  await assert.rejects(method.call(f.provider, "runPlan", { workspace: f.initial, planFile: "experiments/plans/A.yaml" }), /ACTIVE/);
  assert.ok(!f.calls.includes("remote-submit")); assert.ok(!f.calls.includes("abortSchedulerFromUi"));
  f.state.activeAt = 0; f.calls.length = 0; f.provider.ensureCodeReadyForRun = async () => f.setRoot(f.other);
  await assert.rejects(method.call(f.provider, "runPlan", { workspace: f.initial, planFile: "experiments/plans/A.yaml" }), /已变化/);
  assert.ok(!f.calls.includes("remote-submit"));
});

test("actual evidence polling refuses another project's or replacement directory's late receipt in normal and pending paths", async () => {
  for (const pending of [false, true]) for (const change of ["project", "replace", "operations", "none"]) {
    const f = fixture(), snapshot = f.guard.bindWorkflowWorkspace(undefined, f.initial), old = f.provider.localOperations;
    old.op = { status: "waiting_confirmation" }; let sleeps = 0;
    f.globals.isUiCommandRemotePending = error => error.pending === true;
    f.globals.resultStatus = row => row?.status || "";
    f.globals.sleep = async () => {
      sleeps++;
      if (change === "project") f.setRoot(f.other);
      if (change === "replace") { f.state.changeAt = "evidence:replace"; f.step("evidence"); }
      if (change === "operations") f.provider.localOperations = {};
      f.provider.localOperations.remote = { operationId: "remote", type: "run-plan", status: "running" };
    };
    for (const name of ["runSubmissionEvidence", "waitForRunSubmissionEvidence"])
      f.provider[name] = vm.runInNewContext("({" + source(name) + "})", f.globals)[name];
    f.provider.runActionCommand = async () => { if (pending) throw Object.assign(Error("operationId=remote"), { pending: true }); return {}; };
    await f.runOperation.call(f.provider, "op", { calls: [{ params: {} }] }, snapshot);
    assert.equal(sleeps, 1); assert.equal(old.op.status, change === "none" ? "succeeded" : "failed");
    if (change === "none") assert.equal(old.op.submissionOperationId, "remote");
    else { assert.equal(old.op.submissionOperationId, undefined); assert.deepEqual(f.calls.filter(c => c === "persist" || c === "post"), ["persist", "post"]); }
  }
});

test("compiled manual retry rechecks reviewed workspace before queue writes, modal approval and exact mocked stop", async () => {
  const { preparePlanSafeRetry } = require("../../dist/features/PlanSafeRetry");
  for (const phase of ["reconcile", "load", "tasks", "modal", "save", "tasks:replace", "none"]) {
    const f = fixture(); f.state.changeAt = phase;
    const snapshot = f.guard.bindWorkflowWorkspace(undefined, f.initial), planFile = "experiments/plans/A.yaml";
    const job = { index: 0, case: "case-a", seed: 1, attempt: 1, status: "running", workerId: "worker-a", commandId: "command-old", outputDir: "work_dirs/A/attempts/run-old" };
    let queue = { schemaVersion: 1, plans: [{ id: "run-old", planFile, revision: "r", jobs: [job] }] }, stopped = false;
    const host = {
      captureProjectContext: () => ({ root: f.initial }), projectContextIsCurrent: () => true,
      reconcileStalePlanRunOperations: async () => f.step("reconcile"), longRunningPlanRunOperations: () => [],
      loadDistributedQueue: async () => { f.step("load"); return queue; },
      saveDistributedQueue: async (_root, _queue, options) => { f.step("save"); queue = options.mutateLatest(queue); },
      client: { getWorkerTasks: async () => { f.step("tasks"); return { tasks: [{ ...job, workflowId: "run-old", planFile, planRevision: "r", experimentIndex: 0 }] }; } },
      distributedLaunchInFlight: new Set(), distributedQueueGeneration: 1, detachStaleDistributedTick() {}, boundedPromise: work => work(), postState() {},
      stopDistributedJobForClear: async () => { f.step("stop"); stopped = true; },
    };
    const run = preparePlanSafeRetry(host, planFile, async () => { f.step("modal"); return true; }, () => Error("cancelled"), () => f.guard.assertWorkflowWorkspace(snapshot, f.globals.workspaceRoot()));
    if (phase === "none") { assert.equal(await run, true); assert.equal(stopped, true); assert.ok(f.calls.indexOf("modal") < f.calls.indexOf("stop")); }
    else { await assert.rejects(run, /已变化/); assert.equal(stopped, false); }
    assert.equal(host.distributedPlanStopEpoch || 0, 0);
  }
});

test("actual distributed submission binds code sync, preflight, output choice and enqueue to the original physical workspace", async () => {
  for (const phase of ["fingerprint", "before-sync", "deferred", "sync", "preflight", "outputs", "preflight:replace", "none"]) {
    const f = fixture(); f.state.changeAt = phase;
    let waits = 0;
    Object.assign(f.provider, {
      planSubmissionOperationId: () => "", submissionStillCurrent: () => true,
      waitForPlanSubmission: async (_message, work) => { await Promise.resolve(); if (++waits === 2 && phase === "before-sync") f.step("before-sync"); return work(); },
      distributedCodeVersionHold: async () => { f.step("fingerprint"); return undefined; }, localDistributedCodeFingerprint: async () => "fp",
      activeDeferredForSubmission: async () => { f.step("deferred"); return {}; },
      ensureCodeReadyForRun: async () => f.step("sync"), runPlanPreflight: async () => { f.step("preflight"); return { ok: true }; },
      confirmDistributedPlanExistingOutputs: async () => f.step("outputs"), assertExecutionCondaEnvReady() {}, workerActionTargets: () => [],
      recordPlanSubmissionTiming() {}, recordPlanSubmissionTimingByOperation() {}, reportPlanStage() {}, finishPlanSubmissionProgress: () => f.step("finish"),
      enqueueDistributedPlan: async (...args) => { assert.ok(args[6]?.identity); f.step("enqueue"); return { enqueued: true }; },
    });
    f.globals.DistributedPlanQueue = { distributedSubmissionProgress: () => ({ status: "succeeded", waiting: false }) };
    f.globals.stringField = (body, key) => body[key] || "";
    f.globals.resultStatus = result => result?.status || "";
    const method = vm.runInNewContext("({" + source("finishDistributedPlanSubmission") + "})", f.globals).finishDistributedPlanSubmission;
    const run = method.call(f.provider, "runPlan", phase === "deferred" ? { deferredPlanId: "old" } : {}, {}, { workspace: f.initial });
    if (phase === "none") { await run; assert.ok(f.calls.includes("enqueue")); assert.ok(f.calls.includes("finish")); }
    else { await assert.rejects(run, /已变化/); assert.ok(!f.calls.includes("enqueue")); assert.ok(!f.calls.includes("finish")); }
  }
});

test("actual distributed enqueue refuses changed identity after queue load or write without dispatching or posting into another project", async () => {
  for (const phase of ["load:replace", "save:replace"]) {
    const f = fixture(); f.state.changeAt = phase;
    Object.assign(f.provider, { schedulerSettings: () => ({}), lastCodeSyncState: { fingerprint: "code" }, loadDistributedQueue: async () => { f.step("load"); return { schemaVersion: 1, plans: [] }; },
      saveDistributedQueue: async () => f.step("save"), tickDistributedQueue: async () => f.step("dispatch"), notifyPlanOutputVersionReview: () => f.step("review") });
    Object.assign(f.globals, { planValidationFromResult: value => value, PlanExecutionMode: require("../../dist/features/PlanExecutionMode"),
      operationResultPlanFile: body => body.planFile, DistributedSchedulingPolicy: require("../../dist/features/DistributedSchedulingPolicy"), DistributedPlanQueue: require("../../dist/features/DistributedPlanQueue") });
    const method = vm.runInNewContext("({" + source("enqueueDistributedPlan") + "})", f.globals).enqueueDistributedPlan;
    await assert.rejects(method.call(f.provider, { workspace: f.initial, planFile: "experiments/plans/A.yaml", planRevision: "r" }, { execution_mode: "train", jobs: [{ index: 0, case: "case-a", seed: 1, output_dir: "work_dirs/A" }] }), /身份已变化/);
    assert.deepEqual(f.calls, phase.startsWith("load") ? ["load"] : ["load", "save"]);
  }
});
