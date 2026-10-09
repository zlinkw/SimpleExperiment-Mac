const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const planner = require("../../dist/features/PlanStopClear.js");
const OperationOutcome = require("../../dist/core/OperationOutcome.js");
const extension = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");

function panelScriptContaining(html, marker) {
  const scripts = [...String(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  const script = scripts.find((item) => item.includes(marker));
  assert.ok(script, `panel script containing ${marker} missing`);
  return script;
}

test("cleanup targets include failed and finished plan rows and keep unrelated plans", () => {
  const targets = planner.planCleanupTargets({
    running: { type: "run-plan", operationId: "op-run", planFile: "plans/dpl.yaml", status: "running", schedulerOwnerWorkerId: "w1", tmuxSession: "zlk-sch-op-run" },
    failed: { type: "run-plan", operationId: "op-fail", planFile: "./plans/dpl.yaml", status: "failed", tmuxSession: "zlk-sch-op-fail", tmuxTarget: "zlk-sch-op-fail:3" },
    other: { type: "run-plan", operationId: "op-other", planFile: "plans/other.yaml", status: "failed" },
    sameName: { type: "run-plan", operationId: "op-same", planFile: "other/dpl.yaml", status: "failed" },
    parse: { type: "parse-results", operationId: "op-parse", planFile: "plans/dpl.yaml", status: "failed" },
  }, "plans/dpl.yaml", (row) => ["failed", "completed", "cancelled"].includes(String(row.status)));
  assert.deepEqual(targets.map((item) => item.operationId), ["op-run", "op-fail"]);
  assert.equal(targets[0].active, true);
  assert.equal(targets[1].active, false);
  assert.equal(targets[0].tmuxTarget, "");
  assert.equal(targets[1].tmuxTarget, "zlk-sch-op-fail:3");
  assert.match(planner.planStopClearPreview("plans/dpl.yaml", targets), /两次|再次/);
  assert.doesNotMatch(planner.planStopClearPreview("plans/dpl.yaml", targets), /op-same/);
});

test("missing local progress can be recovered from one trusted worker task", () => {
  const plan = "experiments/plans/comparison/drf.yaml";
  const recovered = planner.trustedRemotePlanOperations({
    tasks: [
      { kind: "scheduler", action: "run-plan", operationId: "op-drf", planFile: plan, status: "running", workerId: "nwpu3", pid: 42, tmuxSession: "zlk-sch-op-drf", startedAt: "2026-09-26T01:00:00Z" },
      { kind: "scheduler", action: "run-plan", operationId: "op-other", planFile: "experiments/plans/other.yaml", status: "running", workerId: "nwpu3" },
      { kind: "worker-task", action: "run-plan", operationId: "op-child", planFile: plan, status: "running", workerId: "nwpu3" },
      { kind: "scheduler", action: "run-plan", operationId: "op-foreign", planFile: plan, status: "running", workerId: "other-worker" },
    ],
  }, "nwpu3", plan);
  assert.deepEqual(recovered.map((item) => item.operationId), ["op-drf"]);
  const merged = planner.mergeTrustedPlanOperations({}, recovered);
  const targets = planner.planCleanupTargets(merged, plan, () => false);
  assert.deepEqual(targets.map((item) => item.operationId), ["op-drf"]);
  assert.equal(targets[0].workerId, "nwpu3");
  assert.equal(targets[0].active, true);
  assert.match(planner.planStopClearPreview(plan, targets), /op-drf/);
  assert.doesNotMatch(planner.planStopClearPreview(plan, targets), /op-other|op-foreign/);
  const missing = planner.planStopMissingEvidenceMessage(plan, { realtime: true, workersChecked: 1, failures: [] });
  assert.match(missing, /没有找到 experiments\/plans\/comparison\/drf\.yaml 的本机运行进度条目/);
  assert.match(missing, /未发送停止命令/);
  assert.match(missing, /刷新状态/);
});

test("scheduler identity conflicts are rejected without changing the trusted record", () => {
  const plan = "experiments/plans/comparison/drf.yaml";
  const missingKind = planner.trustedRemotePlanOperations({
    tasks: [{ action: "run-plan", operationId: "op-drf", planFile: plan, status: "failed", workerId: "nwpu3" }],
  }, "nwpu3", plan);
  assert.deepEqual(missingKind, []);
  const existing = {
    "op-drf": { operationId: "op-drf", type: "run-plan", status: "running", planFile: plan, schedulerOwnerWorkerId: "nwpu3", message: "keep" },
  };
  const remote = [{ operationId: "op-drf", planFile: plan, type: "run-plan", status: "failed", workerId: "other-worker", source: "worker-task" }];
  assert.equal(planner.planRecoveryConflicts(existing, remote)[0].reason, "worker");
  const merged = planner.mergeTrustedPlanOperations(existing, remote);
  assert.equal(merged["op-drf"].status, "running");
  assert.equal(merged["op-drf"].schedulerOwnerWorkerId, "nwpu3");
  assert.equal(merged["op-drf"].message, "keep");
  const otherPlan = [{ operationId: "op-drf", planFile: "experiments/plans/other.yaml", type: "run-plan", status: "cancelled", workerId: "nwpu3", source: "worker-task" }];
  assert.equal(planner.planRecoveryConflicts(existing, otherPlan)[0].reason, "plan");
  assert.equal(planner.mergeTrustedPlanOperations(existing, otherPlan)["op-drf"].status, "running");
  assert.match(planner.planStopIdentityConflictMessage(plan, [{ operationId: "op-drf", reason: "worker" }]), /未发送停止命令/);
});

test("one-click stop and clear keeps the hide-only control and requires two confirms", () => {
  assert.match(panel, /data-command="stopAndClearPlan"/);
  assert.match(panel, /一键中止并清除 Plan/);
  assert.match(panel, /清理选中记录/);
  assert.match(panel, /data-command="' \+ topStopCommand \+ '"/);
  const handler = extension.slice(extension.indexOf("workerSupportsExactPaneStop("), extension.indexOf("async downloadDebugBundle("));
  assert.match(handler, /planCleanupTargets/);
  assert.match(handler, /继续中止并清除/);
  assert.match(handler, /确认中止并清除/);
  const first = handler.indexOf("继续中止并清除");
  const second = handler.indexOf("确认中止并清除");
  const stop = handler.indexOf("stopExperimentRouted");
  const hide = handler.indexOf("executionHistoryHiddenOperationIds");
  assert.ok(first > 0 && second > first && stop > second && hide > stop);
  assert.match(handler, /recoverPlanOperationsForStopClear/);
  assert.match(handler, /planStopIdentityConflictMessage/);
  assert.match(handler, /planStopMissingEvidenceMessage/);
  const recover = extension.slice(extension.indexOf("async recoverPlanOperationsForStopClear("), extension.indexOf("async restoreRemotePlanOperations("));
  assert.match(recover, /planRecoveryConflicts/);
  assert.doesNotMatch(recover, /restorePlanOperationsFromWorkerTasks/);
  assert.match(handler, /buildPlanRuntimeEvidenceState/);
  assert.match(handler, /distributedStopTargets/);
  assert.match(handler, /removeConfirmedDistributedPlan/);
  assert.match(handler, /stopDistributedJobForClear/);
  assert.match(handler, /targetCommandId/);
  assert.match(handler, /distributedPlanStopEpoch/);
  assert.match(panel, /代码版本不匹配/);
  assert.match(panel, /空闲 GPU 不能运行这份旧代码/);
  assert.match(handler, /performKillTmuxWindow/);
  assert.ok(handler.indexOf("performKillTmuxWindow") < handler.indexOf("executionHistoryHiddenOperationIds"));
  assert.match(handler, /tmux 仅有会话名/);
  assert.doesNotMatch(handler, /enabledWorkerConfigs\(\)\[0\]/);
  const kill = extension.slice(extension.indexOf("async killTmuxWindowFromUi("), extension.indexOf("async openTensorBoardUrlFromUi("));
  assert.doesNotMatch(kill, /message\?\.confirmed === true/);
  assert.match(kill, /非 Agent session:index，拒绝只用会话名定位/);
  const stopper = extension.slice(extension.indexOf("async stopDistributedJobForClear("), extension.indexOf("async stopAndClearPlanFromUi("));
  assert.equal((stopper.match(/makeOpId\("stop-distributed-job"\)/g) || []).length, 1);
  assert.doesNotMatch(stopper, /commandId: job\.commandId/);
  assert.match(stopper, /stopIdentityMatchesJob/);
  assert.match(stopper, /paneClosed !== true/);
  assert.match(stopper, /快照不含该 job/);
});

test("queued-only plan clears without a worker stop and a mixed failure keeps the unconfirmed job", async () => {
  const queue = require("../../dist/features/DistributedPlanQueue.js");
  const dist = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const marker = dist.indexOf("clearable = stoppedOrEnded.filter((target)");
  const start = dist.indexOf("const latest = await this.loadDistributedQueue(root);", marker);
  const end = dist.indexOf("if (confirmedJobs.size || confirmedDeferred.size)", start);
  const body = dist.slice(start, end)
    .replaceAll("this.loadDistributedQueue(root)", "loadDistributedQueue()")
    .replaceAll("this.client.getWorkerTasks", "getWorkerTasks")
    .replaceAll("this.boundedPromise", "boundedPromise")
    .replaceAll("this.stopDistributedJobForClear", "stopDistributedJobForClear")
    .replaceAll("this.refreshExactPaneStopCapability", "refreshExactPaneStopCapability")
    .replaceAll("DistributedPlanQueue.", "queueApi.")
    .replaceAll("this.planStopClearWaitMs()", "30");
  let saved = null;
  const calls = [];
  const queued = queue.enqueuePlan(queue.enqueuePlan(queue.emptyDistributedQueue(), {
    planFile: "plans/ebmc.yaml", revision: "rev-ebmc", codeFingerprint: "old",
    jobs: [0, 1, 2].map((index) => ({ index, case: "bus", seed: index, outputDir: `work/ebmc/${index}` })),
  }, "plan-ebmc"), {
    planFile: "plans/keep.yaml", revision: "rev-keep", codeFingerprint: "new",
    jobs: [{ index: 0, case: "pad", seed: 9, outputDir: "work/keep/0" }],
  }, "plan-keep");
  queued.deferred = [{ id: "defer-ebmc", planFile: "plans/ebmc.yaml", revision: "rev-ebmc", codeFingerprint: "old", body: {}, enqueuedAt: "t", status: "processing" }];
  const allocated = queue.allocateAvailable(queue.enqueuePlan(queue.emptyDistributedQueue(), {
    planFile: "plans/mix.yaml", revision: "rev-mix", codeFingerprint: "new",
    jobs: [0, 1].map((index) => ({ index, case: "bus", seed: index, outputDir: `work/mix/${index}` })),
  }, "plan-mix"), [{ workerId: "w1", idleGpuIds: ["0"], online: true }]);
  const running = allocated.queue.plans[0].jobs.find((job) => job.status === "dispatching");
  running.status = "running";
  const sandbox = {
    planFile: "plans/ebmc.yaml",
    failures: [],
    confirmedJobs: new Set(),
    confirmedDeferred: new Set(),
    distributedLaunchInFlight: new Set(),
    loadDistributedQueue: () => saved || queued,
    getWorkerTasks: async () => { throw new Error("queued plan must not query a worker"); },
    refreshExactPaneStopCapability: async () => { throw new Error("queued plan must not probe a worker"); },
    stopDistributedJobForClear: async () => { throw new Error("queued plan must not stop a worker"); },
    saveDistributedQueue: async (_root, next) => { saved = next; },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("queueApi", "root", `const { failures, confirmedJobs, confirmedDeferred, loadDistributedQueue, getWorkerTasks, stopDistributedJobForClear, saveDistributedQueue, planFile } = this;\nconst errorMessage = (error) => String(error && error.message || error);\nconst clearStillHere = () => true;\nconst boundedPromise = async (work, timeoutMs, timeoutError) => {\n  let timer;\n  const timed = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError), timeoutMs || 8000); });\n  try { return await Promise.race([Promise.resolve().then(work), timed]); }\n  finally { clearTimeout(timer); }\n};\n${body}\nif (clearStillHere() && (confirmedJobs.size || confirmedDeferred.size)) {\n  const current = await loadDistributedQueue();\n  const next = queueApi.removeConfirmedDistributedPlan(current, planFile, { jobKeys: confirmedJobs, deferredIds: confirmedDeferred });\n  await saveDistributedQueue(root, next);\n}`);
  await run.call(sandbox, queue, "root");
  assert.equal(sandbox.failures.length, 0, sandbox.failures.join(";"));
  assert.equal(saved.plans.some((plan) => plan.id === "plan-ebmc"), false);
  assert.equal(saved.plans.find((plan) => plan.id === "plan-keep").jobs.length, 1);
  assert.deepEqual(saved.deferred, []);
  sandbox.planFile = "plans/mix.yaml";
  sandbox.failures = [];
  sandbox.confirmedJobs = new Set();
  saved = allocated.queue;
  sandbox.loadDistributedQueue = () => saved;
  sandbox.getWorkerTasks = async (workerId) => { calls.push(["tasks", workerId]); return { tasks: [{ commandId: running.commandId, status: "running", tmuxPane: "%9", workflowId: "plan-mix", planRevision: "rev-mix", planFile: "plans/mix.yaml", case: running.case, seed: running.seed, attempt: running.attempt, outputDir: running.outputDir, workerId: "w1", gpuId: "0" }] }; };
  sandbox.refreshExactPaneStopCapability = async () => false;
  sandbox.stopDistributedJobForClear = async () => { calls.push("stop"); throw new Error("旧 Agent 无精确 pane 能力"); };
  await run.call(sandbox, queue, "root");
  assert.equal(calls.includes("stop"), true);
  assert.equal(saved.plans[0].jobs.length, 1);
  assert.equal(saved.plans[0].jobs.some((job) => job.status === "running"), true);
  assert.match(sandbox.failures.join("\n"), /旧 Agent/);
  const finished = queue.enqueuePlan(queue.emptyDistributedQueue(), {
    planFile: "plans/done.yaml", revision: "rev-done", codeFingerprint: "new",
    jobs: [
      { index: 0, case: "bus", seed: 1, outputDir: "work/done/session" },
      { index: 1, case: "pad", seed: 2, outputDir: "work/done/clear" },
    ],
  }, "plan-done");
  const sessionJob = finished.plans[0].jobs[0];
  const clearJob = finished.plans[0].jobs[1];
  for (const job of [sessionJob, clearJob]) Object.assign(job, { status: "completed", workerId: "w1", gpuId: "0", commandId: "cmd-" + job.index, attempt: 1 });
  sandbox.planFile = "plans/done.yaml";
  sandbox.failures = [];
  sandbox.confirmedJobs = new Set();
  saved = finished;
  calls.length = 0;
  sandbox.getWorkerTasks = async () => ({ tasks: [
    { commandId: sessionJob.commandId, status: "completed", tmuxSession: "simple-gpu-0", workflowId: "plan-done", planRevision: "rev-done", planFile: "plans/done.yaml", case: sessionJob.case, seed: sessionJob.seed, attempt: 1, outputDir: sessionJob.outputDir, workerId: "w1", gpuId: "0" },
    { commandId: clearJob.commandId, status: "completed", workflowId: "plan-done", planRevision: "rev-done", planFile: "plans/done.yaml", case: clearJob.case, seed: clearJob.seed, attempt: 1, outputDir: clearJob.outputDir, workerId: "w1", gpuId: "0" },
  ] });
  sandbox.stopDistributedJobForClear = async () => { calls.push("stop-session"); };
  await run.call(sandbox, queue, "root");
  assert.equal(calls.includes("stop-session"), false);
  assert.deepEqual(saved.plans[0].jobs.map((job) => job.index), [0]);
  assert.match(sandbox.failures.join("\n"), /只有 tmux 会话名 simple-gpu-0/);
});

test("each execution plan row can stop and clear its own plan file", () => {
  const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");
  const htmlSource = renderPanelHtml();
  const script = panelScriptContaining(htmlSource, "function executionPlanGroupKey(");
  const start = script.indexOf("function executionPlanGroupKey(");
  const end = script.indexOf("function renderOperationSection(state)", start);
  assert.ok(start >= 0 && end > start);
  const source = script.slice(start, end);
  let html = "";
  const sandbox = {
    Map, Set,
    operationRowsForState: () => [],
    taskSectionViewModelForState: () => ({ allRows: [] }),
    taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}),
    normalizePlanSelectionKey: String,
    samePlanSelection: (left, right) => left === right,
    selectedExecutionPlanFile: "",
    collapsedExecutionPlanKeys: new Set(),
    persistWebviewState: () => undefined,
    taskStatusToken: String,
    TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]),
    TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: () => false,
    operationIsFailureLike: () => false,
    operationHasDeadEvidence: () => false,
    taskFailureLikeStatus: () => false,
    planBaseName: (value) => String(value).split("/").pop(),
    esc: String,
    escAttr: String,
    detailsOpenAttr: () => "",
    statusClass: String,
    loadingPrefix: () => "",
    renderOperationItem: () => "",
    renderTaskCards: () => "",
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(script.slice(script.indexOf("function distributedPlanRecoveryView("), script.indexOf("function executionCurrentDistributedJobs(")) + source + "\nthis.render = renderExecutionPlanList;", sandbox);
  sandbox.render({
    planFileInput: "plans/editing.yaml",
    distributedPlans: [
      { planFile: "plans/ebmc.yaml", jobs: [{ status: "pending", blockReason: "代码指纹不匹配：旧代码", case: "bus", seed: 1 }] },
      { planFile: "plans/edrl.yaml", jobs: [{ status: "pending", case: "pad", seed: 2 }] },
    ],
  });
  assert.match(html, /data-command="stopAndClearPlan" data-plan-file="plans\/ebmc.yaml"/);
  assert.match(html, /data-command="stopAndClearPlan" data-plan-file="plans\/edrl.yaml"/);
  assert.doesNotMatch(html, /data-plan-file="plans\/editing.yaml"/);
  assert.equal((html.match(/终止并清理/g) || []).length, 2);
  const head = html.slice(0, html.indexOf("详情与日志"));
  assert.match(head, /stopAndClearPlan/);
  assert.doesNotMatch(head, /clearOperations|选中 Plan/);
  sandbox.operationRowsForState = (state) => Object.values(state.operations || {});
  sandbox.operationIsActive = (status) => status === "queued";
  sandbox.loadingPrefix = (active) => active ? "[spinner]" : "";
  sandbox.render({ operations: { wait: { operationId: "plan-submit-wait", type: "run-plan", planFile: "plans/wait.yaml", status: "queued", localSubmissionProgress: true, reconcileEvidenceActive: false, startedAt: "2026-09-27T01:00:00Z" } } });
  assert.match(html, /等待继续提交/);
  assert.match(html, /data-command="runPlan" data-plan-file="plans\/wait.yaml"[^>]*>继续提交/);
  assert.match(html.slice(0, html.indexOf("详情与日志")), /stopAndClearPlan/);
  assert.doesNotMatch(html.slice(0, html.indexOf("详情与日志")), /\[spinner\]/);
  const controlsStart = script.indexOf("function renderOperationSection(state)");
  const controlsEnd = script.indexOf("function renderFileTransferProgress(", controlsStart);
  const controls = script.slice(controlsStart, controlsEnd);
  let controlsHtml = "";
  const controlSandbox = {
    distributedPlanRecoveryView: sandbox.distributedPlanRecoveryView,
    operationViewModelForState: () => ({ rows: [], visibleRows: [], hiddenCount: 0, statusCounts: {} }),
    operationIsActive: () => false,
    operationIsFailureLike: () => false,
    operationIsCancelled: () => false,
    operationIsCompleted: () => false,
    selectedOperationHistoryIds: new Set(),
    selectedExecutionPlanFile: "",
    renderOperationStatusSummary: () => "",
    renderOperationHiddenSummary: () => "",
    renderFileTransferProgress: () => "",
    escAttr: String,
    setHtmlIfChanged: (id, value) => { if (id === "executionControls") controlsHtml = value; },
  };
  vm.createContext(controlSandbox);
  vm.runInContext(controls + "\nthis.render = renderOperationSection;", controlSandbox);
  controlSandbox.render({
    planFileInput: "plans/editing.yaml",
    operations: {},
    distributedPlans: [
      { planFile: "plans/ebmc.yaml", jobs: [{ status: "pending" }] },
      { planFile: "plans/edrl.yaml", jobs: [{ status: "pending" }] },
    ],
  });
  assert.match(controlsHtml, /data-command="stopAndClearPlan" data-plan-file=""[^>]*disabled/);
  assert.doesNotMatch(controlsHtml, /plans\/editing.yaml/);
  controlSandbox.selectedExecutionPlanFile = "plans/ebmc.yaml";
  controlSandbox.render({
    planFileInput: "plans/editing.yaml",
    operations: {},
    distributedPlans: [
      { planFile: "plans/ebmc.yaml", jobs: [{ status: "pending" }] },
      { planFile: "plans/edrl.yaml", jobs: [{ status: "pending" }] },
    ],
  });
  assert.match(controlsHtml, /data-command="stopAndClearPlan" data-plan-file="plans\/ebmc.yaml"/);
  assert.doesNotMatch(controlsHtml, /plans\/editing.yaml/);
});

function loadExtensionHandler(name, nextName) {
  const dist = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const start = dist.indexOf(name);
  const end = dist.indexOf(nextName, start + name.length);
  assert.ok(start >= 0 && end > start, name);
  return dist.slice(start, end);
}

function installStopClearHost(sandbox) {
  const notices = [];
  const context = {
    queueApi: require("../../dist/features/DistributedPlanQueue.js"),
    planner: require("../../dist/features/PlanStopClear.js"),
    PlanStopClear_1: require("../../dist/features/PlanStopClear.js"),
    DistributedPlanQueue: require("../../dist/features/DistributedPlanQueue.js"),
    DistributedSchedulingPolicy: require("../../dist/features/DistributedSchedulingPolicy.js"),
    vscode: { window: {
      showWarningMessage: async (text, _options, action) => { notices.push(text); return sandbox.answers.shift() ?? action; },
      showInformationMessage: (text) => { notices.push(text); },
      setStatusBarMessage: () => undefined,
    } },
    operationResultPlanFile: (body) => String(body?.planFile || body?.options?.planFile || ""),
    makeOpId: (prefix) => `${prefix}-test-${require("node:crypto").randomUUID()}`,
    workspaceRoot: () => sandbox.root,
    stringField: (message, key) => String(message?.[key] || ""),
    normalizePlanSelectionKey: (value) => String(value || "").replaceAll("\\", "/").replace(/^\.\//, ""),
    operationTerminal: (row) => ["failed", "completed", "cancelled"].includes(String(row?.status || "")),
    Promise,
    setTimeout,
    clearTimeout,
    AbortController,
    errorMessage: (error) => String(error?.message || error),
    isUiCommandCancelled: (error) => error?.name === "UiCommandCancelled",
    uniqueStrings: (values) => [...new Set((values || []).filter(Boolean))],
    keys: { executionHistoryHiddenOperationIds: "hidden", executionHistoryCutoffs: "cutoffs" },
    notices,
  };
  vm.createContext(context);
  const submission = loadExtensionHandler("planSubmissionOperationId(message) {", "async recoverPlanOperationsForStopClear(planFile");
  const helpers = loadExtensionHandler("detachStaleDistributedTick(task) {", "async recoverPlanOperationsForStopClear(planFile");
  const recover = loadExtensionHandler("async recoverPlanOperationsForStopClear(planFile", "async restoreRemotePlanOperations(");
  const clear = loadExtensionHandler("async stopAndClearPlanFromUi(message) {", "async downloadDebugBundle(");
  const tickWrapperStart = loadExtensionHandler("async tickDistributedQueue() {", "refreshSelectedDistributedLog(queue");
  const enqueue = loadExtensionHandler("async enqueueDistributedPlan(body", "detachStaleDistributedTick(task)");
  const finish = loadExtensionHandler("async finishDistributedPlanSubmission(command", "async activeDeferredForSubmission(");
  const validation = loadExtensionHandler("function planValidationFromResult(", "function planCheckAccepted(");
  vm.runInContext(`${validation}\nclass Host { ${submission}\n${helpers}\n${recover}\n${clear}\n${tickWrapperStart}\n${enqueue}\n${finish} }\nthis.Host = Host;`, context);
  const provider = new context.Host();
  const sourceTick = provider.tickDistributedQueue;
  const sourceDetach = provider.detachStaleDistributedTick;
  Object.assign(provider, sandbox);
  if (!provider.schedulerSettings) provider.schedulerSettings = () => ({ dispatchMode: "local_idle" });
  if (!provider.distributedSubmissionTimings) provider.distributedSubmissionTimings = new Map();
  if (sandbox.tickDistributedQueue) provider.tickDistributedQueue = sourceTick;
  provider.detachStaleDistributedTick = sourceDetach;
  if (typeof provider.markLocalOperationsDirty !== "function") provider.markLocalOperationsDirty = () => undefined;
  if (!provider.localOperations) provider.localOperations = {};
  if (!provider.distributedSubmissionEpochs) provider.distributedSubmissionEpochs = new Map();
  context.provider = provider;
  return context;
}

test("production stop-clear removes a queue-only blocked plan without waiting on unrelated workers", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const queued = queueApi.enqueuePlan(queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/stuck.yaml", revision: "rev-stuck", codeFingerprint: "old",
    jobs: [{ index: 0, case: "bus", seed: 1, outputDir: "work/stuck/0" }, { index: 1, case: "pad", seed: 2, outputDir: "work/stuck/1" }],
  }, "plan-stuck"), {
    planFile: "plans/keep.yaml", revision: "rev-keep", codeFingerprint: "new",
    jobs: [{ index: 0, case: "pad", seed: 9, outputDir: "work/keep/0" }],
  }, "plan-keep");
  queued.plans[0].jobs[0].status = "blocked";
  queued.deferred = [{ id: "defer-stuck", planFile: "plans/stuck.yaml", revision: "rev-stuck", codeFingerprint: "old", body: {}, enqueuedAt: "t", status: "blocked" }];
  let saved = queued;
  let workerCalls = 0;
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除"],
    distributedQueueTickPromise: undefined,
    distributedPlanStopEpoch: 0,
    planStopClearByFile: {},
    client: { getWorkerTasks: async () => { workerCalls += 1; await new Promise(() => {}); } },
    isRealtimeMode: () => true,
    enabledWorkerConfigs: () => [{ id: "slow-worker" }],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => saved,
    saveDistributedQueue: async (_root, next) => { saved = next; },
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async () => undefined } },
  };
  const host = installStopClearHost(sandbox);
  const started = Date.now();
  const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/stuck.yaml", command: "stopAndClearPlan" });
  assert.ok(Date.now() - started < 3000);
  assert.equal(workerCalls, 0);
  assert.equal(result.status, "completed", result && result.message);
  assert.match(result.message, /已清除/);
  assert.equal(saved.plans.some((plan) => plan.id === "plan-stuck"), false);
  assert.equal(saved.plans.find((plan) => plan.id === "plan-keep").jobs.length, 1);
  assert.equal(saved.deferred.length, 0);
  assert.equal(host.provider.planStopClearByFile["plans/stuck.yaml"].outcome, "completed");
  assert.match(host.provider.planStopClearByFile["plans/stuck.yaml"].message, /分布式 job/);
});

test("an unconfirmed active job stays queued and the plan card records the reason", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const allocated = queueApi.allocateAvailable(queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/live.yaml", revision: "rev-live", codeFingerprint: "new",
    jobs: [{ index: 0, case: "bus", seed: 3, outputDir: "work/live/0" }],
  }, "plan-live"), [{ workerId: "w1", idleGpuIds: ["0"], online: true }]);
  const running = allocated.queue.plans[0].jobs[0];
  running.status = "running";
  let saved = allocated.queue;
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除"],
    distributedQueueTickPromise: undefined,
    distributedPlanStopEpoch: 0,
    planStopClearByFile: {},
    client: { getWorkerTasks: async () => ({ tasks: [] }) },
    isRealtimeMode: () => true,
    enabledWorkerConfigs: () => [{ id: "w1" }],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    runOperationWorkerId: () => "",
    loadDistributedQueue: async () => saved,
    saveDistributedQueue: async (_root, next) => { saved = next; },
    stopDistributedJobForClear: async () => { throw new Error("Worker w1 不可达，未确认该 job 已停止"); },
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async () => undefined } },
  };
  const host = installStopClearHost(sandbox);
  const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/live.yaml" });
  assert.equal(result.status, "failed");
  assert.match(result.message, /未完成清除/);
  assert.match(result.message, /下一步/);
  assert.equal(saved.plans[0].jobs.length, 1);
  assert.equal(saved.plans[0].jobs[0].status, "running");
  assert.ok(saved.plans[0].automaticRetry.disabledAt, "partial remote stop still disables automatic retries");
  const card = host.provider.planStopClearByFile["plans/live.yaml"];
  assert.equal(card.outcome, "failed");
  assert.match(card.failures.join("\n"), /不可达/);
  assert.match(card.nextStep, /终止并清理/);
});

test("a hung worker stop returns a bounded plan failure and a late receipt cannot clear the job", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const allocated = queueApi.allocateAvailable(queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/hang.yaml", revision: "rev-hang", codeFingerprint: "new",
    jobs: [{ index: 0, case: "bus", seed: 6, outputDir: "work/hang/0" }],
  }, "plan-hang"), [{ workerId: "w-hang", idleGpuIds: ["0"], online: true }]);
  const running = allocated.queue.plans[0].jobs[0];
  running.status = "running";
  let saved = allocated.queue;
  let late = false;
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除"],
    distributedQueueTickPromise: undefined,
    distributedQueueWritePromise: Promise.resolve(),
    distributedPlanStopEpoch: 0,
    planStopClearByFile: {},
    client: { getWorkerTasks: () => new Promise(() => {}) },
    isRealtimeMode: () => false,
    enabledWorkerConfigs: () => [{ id: "w-hang" }],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => saved,
    saveDistributedQueue: async (_root, next) => { saved = next; if (late) throw new Error("late receipt saved"); },
    planStopClearTimeoutMs: 30,
    stopDistributedJobForClear: () => new Promise((resolve) => setTimeout(() => { late = true; resolve({ status: "completed" }); }, 12000)),
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async () => undefined } },
  };
  const host = installStopClearHost(sandbox);
  const started = Date.now();
  const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/hang.yaml" });
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.status, "failed");
  assert.match(result.message, /w-hang/);
  assert.match(result.message, /30 秒无有效响应/);
  assert.match(result.planStopClear.failures.join("\n"), /重试/);
  assert.equal(saved.plans[0].jobs.length, 1);
  assert.equal(host.provider.planStopClearByFile["plans/hang.yaml"].outcome, "failed");
});

test("an error before confirmation is stored on the plan card", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const sandbox = {
    root: "D:/project",
    answers: [],
    distributedQueueTickPromise: undefined,
    distributedPlanStopEpoch: 0,
    distributedQueueGeneration: 0,
    planStopClearByFile: {},
    isRealtimeMode: () => true,
    enabledWorkerConfigs: () => [],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => { throw new Error("本机运行进度读取失败"); },
    loadDistributedQueue: async () => queueApi.emptyDistributedQueue(),
    saveDistributedQueue: async () => { throw new Error("must not save"); },
    postState: () => undefined,
  };
  const host = installStopClearHost(sandbox);
  const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/broken.yaml" });
  assert.equal(result.status, "failed");
  assert.match(result.message, /准备清理失败/);
  assert.match(result.message, /本机运行进度读取失败/);
  const card = host.provider.planStopClearByFile["plans/broken.yaml"];
  assert.equal(card.phase, "prepare-clear");
  assert.match(card.nextStep, /终止并清理/);
});

test("queue-only clear proceeds while a scheduler tick is still querying a worker", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const queued = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/local.yaml", revision: "rev-local", codeFingerprint: "old",
    jobs: [{ index: 0, case: "bus", seed: 7, outputDir: "work/local/0" }],
  }, "plan-local");
  let saved = queued;
  let releaseTick;
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除"],
    distributedQueueTickPromise: new Promise((resolve) => { releaseTick = resolve; }),
    distributedQueueWritePromise: Promise.resolve(),
    distributedPlanStopEpoch: 0,
    planStopClearByFile: {},
    isRealtimeMode: () => false,
    enabledWorkerConfigs: () => [],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => saved,
    saveDistributedQueue: async (_root, next) => { saved = next; },
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async () => undefined } },
  };
  const host = installStopClearHost(sandbox);
  const started = Date.now();
  const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/local.yaml" });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.status, "completed", result.message);
  assert.match(result.message, /未核查远端|已清除/);
  assert.equal(saved.plans.length, 0);
  assert.equal(host.provider.distributedPlanStopEpoch, 0);
  assert.equal(host.provider.distributedQueueTickPromise, undefined);
  const oldGeneration = host.provider.distributedQueueGeneration;
  let blocked = false;
  host.provider.saveDistributedQueue = async (_root, next, options = {}) => {
    if (options.queueGeneration !== undefined && options.queueGeneration !== host.provider.distributedQueueGeneration) {
      blocked = true;
      return;
    }
    saved = next;
  };
  await host.provider.saveDistributedQueue("D:/project", queued, { queueGeneration: oldGeneration - 1 });
  assert.equal(blocked, true);
  assert.equal(saved.plans.length, 0);
  releaseTick();
  host.provider.tickDistributedQueueCore = () => Promise.resolve();
  const restarted = host.provider.tickDistributedQueue();
  assert.ok(restarted);
  await restarted;
  assert.equal(host.provider.distributedQueueTickPromise, undefined);
});

test("a stuck worker probe does not block clearing an undispatched plan, and a remote job stays", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const queued = queueApi.enqueuePlan(queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/tick.yaml", revision: "rev-tick", codeFingerprint: "old",
    jobs: [{ index: 0, case: "bus", seed: 4, outputDir: "work/tick/0" }],
  }, "plan-tick"), {
    planFile: "plans/keep.yaml", revision: "rev-keep", codeFingerprint: "old",
    jobs: [{ index: 0, case: "pad", seed: 1, outputDir: "work/keep/0", status: "running", workerId: "w-keep", gpuId: "0", commandId: "cmd-keep", attempt: 1 }],
  }, "plan-keep");
  queued.deferred = [{ id: "defer-tick", planFile: "plans/tick.yaml", revision: "rev-tick", codeFingerprint: "old", body: {}, enqueuedAt: "t", status: "pending" }];
  let saved = queued;
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除"],
    distributedQueueTickPromise: new Promise(() => {}),
    distributedQueueWritePromise: Promise.resolve(),
    distributedPlanStopEpoch: 0,
    distributedLaunchInFlight: new Set(),
    planStopClearByFile: {},
    localOperations: {
      "plan-submit-tick": { operationId: "plan-submit-tick", type: "run-plan", status: "running", localSubmissionProgress: true, planFile: "plans/tick.yaml", message: "提交中，待生成 job" },
      "plan-submit-keep": { operationId: "plan-submit-keep", type: "run-plan", status: "running", localSubmissionProgress: true, planFile: "plans/keep.yaml", message: "提交中" },
    },
    markLocalOperationsDirty: () => undefined,
    client: { getWorkerTasks: () => new Promise(() => {}) },
    isRealtimeMode: () => false,
    enabledWorkerConfigs: () => [],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => saved,
    saveDistributedQueue: async (_root, next) => { saved = next; },
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async () => undefined } },
  };
  const host = installStopClearHost(sandbox);
  const started = Date.now();
  const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/tick.yaml" });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.status, "completed", result.message);
  assert.equal(saved.plans.some((plan) => plan.id === "plan-tick"), false);
  assert.equal(saved.plans.find((plan) => plan.id === "plan-keep").jobs[0].commandId, "cmd-keep");
  assert.equal(saved.deferred.length, 0);
  assert.equal(host.provider.localOperations["plan-submit-tick"].status, "cancelled");
  assert.equal(host.provider.localOperations["plan-submit-keep"].status, "running");
  assert.equal(host.provider.distributedQueueTickPromise, undefined);
  assert.equal(host.provider.distributedPlanStopEpoch, 0);
});

test("a tick that resumes after the timeout still cannot save or dispatch, and scheduling resumes after it ends", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const queued = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/late.yaml", revision: "rev-late", codeFingerprint: "old",
    jobs: [{ index: 0, case: "bus", seed: 8, outputDir: "work/late/0", status: "running", workerId: "w-late", gpuId: "0", commandId: "cmd-late", attempt: 1 }],
  }, "plan-late");
  let releaseCore;
  let failCore = false;
  const writes = [];
  const dispatches = [];
  const sandbox = {
    distributedQueueTickPromise: undefined,
    distributedPlanStopEpoch: 0,
    tickDistributedQueueCore: () => new Promise((resolve, reject) => { releaseCore = failCore ? reject : resolve; }),
  };
  const tickSource = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const wrapperStart = tickSource.indexOf("async tickDistributedQueue() {");
  const wrapperEnd = tickSource.indexOf("refreshSelectedDistributedLog(queue", wrapperStart);
  assert.ok(wrapperStart >= 0 && wrapperEnd > wrapperStart);
  const wrapper = tickSource.slice(wrapperStart, wrapperEnd);
  const host = installStopClearHost({
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除"],
    ...sandbox,
    distributedPlanStopEpoch: 0,
    planStopClearByFile: {},
    isRealtimeMode: () => false,
    enabledWorkerConfigs: () => [],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => queued,
    saveDistributedQueue: async (_root, next) => { writes.push(next); },
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async () => undefined } },
  });
  const provider = host.provider;
  provider.tickDistributedQueue();
  const trackedTick = provider.distributedQueueTickPromise;
  assert.ok(trackedTick);
  provider.tickDistributedQueue();
  assert.equal(provider.distributedQueueTickPromise, trackedTick);
  const result = await provider.stopAndClearPlanFromUi({ planFile: "plans/late.yaml" });
  const stopIntentWrites = writes.length;
  assert.ok(writes.some(queue => queue.plans[0].automaticRetry.disabledAt));
  assert.notEqual(result.status, "cancelled");
  assert.equal(provider.distributedPlanStopEpoch, 0);
  assert.ok(provider.distributedQueueGeneration > 0);
  assert.equal(provider.distributedQueueTickPromise, undefined);
  const tickStart = tickSource.indexOf("async tickDistributedQueueCore(generation");
  const tickEnd = tickSource.indexOf("async syncDistributedJobArtifacts(", tickStart);
  assert.ok(tickStart >= 0 && tickEnd > tickStart);
  const tickBody = tickSource.slice(tickStart, tickEnd);
  let continued = false;
  const tickHost = {
    queuePlanArtifactSyncStatusCheck: () => undefined,
    distributedPlanStopEpoch: provider.distributedPlanStopEpoch,
    distributedQueueGeneration: provider.distributedQueueGeneration,
    distributedQueueTickPromise: undefined,
    distributedLaunchInFlight: new Set(),
    detachStaleDistributedTick(task) {
      if (this.distributedQueueTickPromise === task) this.distributedQueueTickPromise = undefined;
    },
    postState: () => undefined,
    saveDistributedQueue: async () => { writes.push("late-save"); },
    sendDistributedJob: async () => { dispatches.push("late-dispatch"); },
    loadDistributedQueue: async () => queued,
    isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    client: { getGpu: async () => { continued = true; return { rows: [] }; } },
    workerCodeSyncTargets: () => [],
    workerActionTargets: () => [],
    testTunnel: async () => undefined,
    lastWorkerProbes: { w1: { status: "ok" } },
    lastCodeSyncState: { workerVersions: {} },
    readWorkerTaskSnapshot: async () => ({ tasks: [] }),
    readWorkerTaskSnapshotBatch: async function (workerIds) { return Promise.all(workerIds.map((id) => this.readWorkerTaskSnapshot(id))); },
    localWorkerAvailabilityRows: () => [{ workerId: "w1", availableGpuIds: ["0"] }],
    availabilityPushTtlSeconds: () => 30,
    schedulerSettings: () => ({}),
    recordActionError: () => undefined,
    refreshSelectedDistributedLog: () => undefined,
    scheduleDistributedPostprocess: () => undefined,
    distributedNextProbeAt: Date.now() + 60_000,
    distributedNextFailureDetailAt: Date.now() + 60_000,
    distributedNextPostprocessAt: Date.now() + 60_000,
  };
  vm.createContext(Object.assign(tickHost, { DistributedPlanQueue: queueApi, workspaceRoot: () => "D:/project", mapLimited: async (items, _limit, worker) => Promise.all(items.map(worker)), AbortController, setInterval, clearInterval }));
  vm.runInContext(`this.run = async function (generation) { ${tickBody.replace(/async tickDistributedQueueCore\(generation[^)]*\)/, "async function tickDistributedQueueCore(generation, signal)")} const signal = undefined; await tickDistributedQueueCore.call(this, generation, signal); };`, tickHost);
  await tickHost.run(provider.distributedQueueGeneration - 1);
  assert.equal(continued, false);
  assert.equal(writes.length, stopIntentWrites, "stale tick must not write after explicit stop intent");
  assert.equal(dispatches.length, 0);
  releaseCore();
  await trackedTick.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(provider.distributedQueueTickPromise, undefined);
  assert.equal(provider.distributedPlanStopEpoch, 0);
  failCore = true;
  const rejectedTick = provider.tickDistributedQueue();
  const rejection = new Error("worker snapshot failed");
  const rejectionSeen = rejectedTick.then(() => { throw new Error("rejected tick resolved"); }, (error) => error);
  provider.distributedPlanStopEpoch = 1;
  releaseCore(rejection);
  assert.equal((await rejectionSeen).message, "worker snapshot failed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(provider.distributedQueueTickPromise, undefined);
  provider.distributedPlanStopEpoch = 0;
  tickHost.distributedPlanStopEpoch = provider.distributedPlanStopEpoch;
  tickHost.distributedQueueGeneration = provider.distributedQueueGeneration;
  continued = false;
  await tickHost.run(provider.distributedQueueGeneration);
  assert.equal(continued, true);
});

test("a late old tick cannot revive a queue-only plan after a newer tick saves", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const dist = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const tickStart = dist.indexOf("async tickDistributedQueueCore(generation");
  const tickEnd = dist.indexOf("async syncDistributedJobArtifacts(", tickStart);
  assert.ok(tickStart >= 0 && tickEnd > tickStart);
  const tickBody = dist.slice(tickStart, tickEnd).replace(/async tickDistributedQueueCore\(generation[^)]*\)/, "async function tickDistributedQueueCore(generation, signal)");
  const stale = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/stale.yaml", revision: "rev-stale", codeFingerprint: "old",
    jobs: [{ index: 0, case: "bus", seed: 1, outputDir: "work/stale/0", status: "running", workerId: "w1", gpuId: "0", commandId: "cmd-stale", attempt: 1 }],
  }, "plan-stale");
  const fresh = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/fresh.yaml", revision: "rev-fresh", codeFingerprint: "new",
    jobs: [{ index: 0, case: "pad", seed: 2, outputDir: "work/fresh/0" }],
  }, "plan-fresh");
  const releases = [];
  const writes = [];
  const dispatches = [];
  let saved = stale;
  const host = {
    distributedQueueGeneration: 2,
    queuePlanArtifactSyncStatusCheck: () => undefined,
    distributedPlanStopEpoch: 0,
    distributedQueueTickPromise: undefined,
    distributedLaunchInFlight: new Set(),
    detachStaleDistributedTick(task) {
      if (this.distributedQueueTickPromise === task) this.distributedQueueTickPromise = undefined;
    },
    postState: () => undefined,
    loadDistributedQueue: async () => saved,
    saveDistributedQueue: async (_root, next, options = {}) => {
      if (options.queueGeneration !== undefined && options.queueGeneration !== host.distributedQueueGeneration) {
        writes.push("rejected:" + next.plans.map((plan) => plan.id).join(","));
        throw new Error("过期调度轮次，已拒绝写入队列");
      }
      saved = next;
      writes.push(next.plans.map((plan) => plan.id).join(","));
    },
    sendDistributedJob: async () => { dispatches.push("dispatch"); },
    isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    workerCodeSyncTargets: () => [],
    workerActionTargets: () => [{ id: "w1" }],
    lastWorkerProbes: { w1: { status: "ok" } },
    lastCodeSyncState: { workerVersions: { w1: { fingerprint: "new" } } },
    lastRealtimeState: {},
    readWorkerTaskSnapshot: () => new Promise((resolve) => { releases.push(() => resolve({ tasks: [] })); }),
    readWorkerTaskSnapshotBatch: async function (workerIds) { return Promise.all(workerIds.map((id) => this.readWorkerTaskSnapshot(id))); },
    localWorkerAvailabilityRows: () => [{ workerId: "w1", availableGpuIds: ["0"] }],
    availabilityPushTtlSeconds: () => 30,
    schedulerSettings: () => ({}),
    recordActionError: () => undefined,
    refreshSelectedDistributedLog: () => undefined,
    scheduleDistributedPostprocess: () => undefined,
    distributedNextProbeAt: Date.now() + 60_000,
    distributedNextFailureDetailAt: Date.now() + 60_000,
    distributedNextPostprocessAt: Date.now() + 60_000,
    client: { getGpu: async () => ({ rows: [{ workerId: "w1", availableGpuIds: ["0"] }] }) },
  };
  vm.createContext(Object.assign(host, { DistributedPlanQueue: queueApi, workspaceRoot: () => "D:/project", errorMessage: (error) => String(error && error.message || error), mapLimited: async (items, _limit, worker) => Promise.all(items.map(worker)), AbortController, setInterval, clearInterval, RequestBudget_1: { RequestBudgetDeniedError: class RequestBudgetDeniedError extends Error {} } }));
  vm.runInContext(`this.run = async function (generation) { ${tickBody}\nconst signal = undefined;\nconst task = tickDistributedQueueCore.call(this, generation, signal); this.distributedQueueTickPromise = task; try { await task; } finally { if (this.distributedQueueTickPromise === task) this.distributedQueueTickPromise = undefined; } };`, host);
  host.distributedQueueGeneration = 1;
  const oldTick = host.run(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1);
  host.distributedQueueGeneration = 2;
  await host.saveDistributedQueue("D:/project", fresh, { queueGeneration: 2 });
  releases[0]();
  await oldTick;
  assert.deepEqual(writes, ["plan-fresh"]);
  assert.deepEqual(dispatches, []);
  assert.equal(saved.plans.map((plan) => plan.id).join(","), "plan-fresh");
  const beforeStale = releases.length;
  const never = host.run(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, beforeStale);
  const current = host.run(host.distributedQueueGeneration);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, beforeStale + 1);
  releases[releases.length - 1]();
  await current;
  let neverSettled = false;
  await Promise.race([never.then(() => { neverSettled = true; }), new Promise((resolve) => setTimeout(resolve, 20))]);
  assert.equal(neverSettled, true);
  assert.equal(saved.plans.some((plan) => plan.id === "plan-stale"), false);
  assert.equal(writes.some((item) => item.includes("plan-stale")), false);
  const releaseCount = releases.length;
  host.distributedQueueGeneration = 1;
  const lateProbe = host.run(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(releases.length > releaseCount);
  const newerProbe = new Promise(() => {});
  host.distributedQueueTickPromise = newerProbe;
  host.distributedQueueGeneration = 3;
  releases[releases.length - 1]();
  await lateProbe;
  assert.equal(host.distributedQueueTickPromise, newerProbe);
});

test("a stale reconciliation launch does not start after the project changes", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const dist = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const tickStart = dist.indexOf("async tickDistributedQueueCore(generation");
  const tickEnd = dist.indexOf("async syncDistributedJobArtifacts(", tickStart);
  const tickBody = dist.slice(tickStart, tickEnd).replace(/async tickDistributedQueueCore\(generation[^)]*\)/, "async function tickDistributedQueueCore(generation, signal)");
  const allocated = queueApi.allocateAvailable(queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/retry.yaml", revision: "rev-retry", codeFingerprint: "new",
    jobs: [{ index: 0, case: "bus", seed: 1, outputDir: "work/retry/0" }],
  }, "plan-retry"), [{ workerId: "w1", idleGpuIds: ["0"], online: true }]);
  const queued = allocated.queue;
  queued.plans[0].jobs[0].status = "running";
  let root = "D:/project";
  let releaseProbe;
  const launches = [];
  const host = {
    distributedQueueGeneration: 4,
    queuePlanArtifactSyncStatusCheck: () => undefined,
    distributedPlanStopEpoch: 0,
    distributedQueueTickPromise: undefined,
    distributedLaunchInFlight: new Set(),
    detachStaleDistributedTick(task) {
      if (this.distributedQueueTickPromise === task) this.distributedQueueTickPromise = undefined;
    },
    postState: () => undefined,
    loadDistributedQueue: async () => queued,
    saveDistributedQueue: async () => undefined,
    sendDistributedJob: async () => { launches.push(root); return { status: "completed" }; },
    isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    workerCodeSyncTargets: () => [],
    workerActionTargets: () => [{ id: "w1" }],
    lastWorkerProbes: { w1: { status: "ok" } },
    lastCodeSyncState: { workerVersions: { w1: { fingerprint: "new" } } },
    lastRealtimeState: {},
    readWorkerTaskSnapshot: () => new Promise((resolve) => { releaseProbe = () => resolve({ tasks: [] }); }),
    readWorkerTaskSnapshotBatch: async function (workerIds) { return Promise.all(workerIds.map((id) => this.readWorkerTaskSnapshot(id))); },
    localWorkerAvailabilityRows: () => [],
    availabilityPushTtlSeconds: () => 30,
    schedulerSettings: () => ({}),
    recordActionError: () => undefined,
    refreshSelectedDistributedLog: () => undefined,
    scheduleDistributedPostprocess: () => undefined,
    distributedNextProbeAt: Date.now() + 60_000,
    distributedNextFailureDetailAt: Date.now() + 60_000,
    distributedNextPostprocessAt: Date.now() + 60_000,
    client: { getGpu: async () => ({ rows: [] }) },
  };
  vm.createContext(Object.assign(host, {
    DistributedPlanQueue: queueApi,
    workspaceRoot: () => root,
    errorMessage: (error) => String(error && error.message || error),
    mapLimited: async (items, _limit, worker) => Promise.all(items.map(worker)),
    AbortController, setInterval, clearInterval,
    RequestBudget_1: { RequestBudgetDeniedError: class RequestBudgetDeniedError extends Error {} },
  }));
  vm.runInContext(`this.run = async function (generation) { ${tickBody}\nconst signal = undefined;\nawait tickDistributedQueueCore.call(this, generation, signal); };`, host);
  const running = host.run(4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseProbe, "function");
  root = "D:/other";
  releaseProbe();
  await running;
  assert.deepEqual(launches, []);
  assert.equal(host.distributedLaunchInFlight.size, 0);
  assert.equal(queued.plans[0].jobs[0].status, "running");
});

test("cancelling the second confirmation publishes a cancelled card state", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const queued = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/cancel.yaml", revision: "rev-cancel", codeFingerprint: "old",
    jobs: [{ index: 0, case: "bus", seed: 5, outputDir: "work/cancel/0" }],
  }, "plan-cancel");
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "先不清理"],
    distributedQueueTickPromise: undefined,
    distributedPlanStopEpoch: 0,
    planStopClearByFile: {},
    isRealtimeMode: () => false,
    enabledWorkerConfigs: () => [],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => queued,
    saveDistributedQueue: async () => { throw new Error("cancel must not save"); },
    postState: () => undefined,
  };
  const host = installStopClearHost(sandbox);
  const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/cancel.yaml" });
  assert.equal(result.status, "cancelled");
  assert.equal(host.provider.planStopClearByFile["plans/cancel.yaml"].outcome, "cancelled");
  assert.match(host.provider.planStopClearByFile["plans/cancel.yaml"].message, /第二次确认已取消/);
});

test("the plan card renders the persistent stop-clear reason beside the target plan", () => {
  const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");
  const htmlSource = renderPanelHtml();
  const script = panelScriptContaining(htmlSource, "function executionPlanGroupKey(");
  const start = script.indexOf("function executionPlanGroupKey(");
  const end = script.indexOf("function renderOperationSection(state)", start);
  const source = script.slice(start, end);
  let html = "";
  const sandbox = {
    Map, Set,
    operationRowsForState: () => [],
    taskSectionViewModelForState: () => ({ allRows: [] }),
    taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}),
    normalizePlanSelectionKey: String,
    samePlanSelection: (left, right) => left === right,
    selectedExecutionPlanFile: "",
    collapsedExecutionPlanKeys: new Set(),
    persistWebviewState: () => undefined,
    taskStatusToken: String,
    TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]),
    TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: () => false,
    operationIsFailureLike: () => false,
    operationHasDeadEvidence: () => false,
    taskFailureLikeStatus: () => false,
    planBaseName: (value) => String(value).split("/").pop(),
    esc: String,
    escAttr: String,
    detailsOpenAttr: () => "",
    statusClass: String,
    loadingPrefix: () => "BUSY ",
    renderOperationItem: () => "",
    renderTaskCards: () => "",
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + "\nthis.render = renderExecutionPlanList;", sandbox);
  sandbox.render({
    distributedPlans: [{ planFile: "plans/live.yaml", jobs: [{ status: "running", case: "bus", seed: 3 }] }],
    planStopClearByFile: {
      "plans/live.yaml": { planFile: "plans/live.yaml", phase: "partial-clear", outcome: "failed", message: "Worker w1 不可达", nextStep: "重新点“终止并清理”", failures: ["job 0: Worker w1 不可达"] },
    },
  });
  assert.match(html, /data-plan-stop-clear="plans\/live\.yaml"/);
  assert.match(html, /data-plan-stop-outcome="failed"/);
  assert.match(html, /清理失败/);
  assert.match(html, /Worker w1 不可达/);
  assert.match(html, /下一步：重新点“终止并清理”/);
  assert.doesNotMatch(html, /清理完成/);
  const head = html.slice(0, html.indexOf("<details"));
  assert.match(head, /data-plan-stop-outcome="failed"/);
  assert.match(head, /清理失败/);
  assert.match(head, /下一步：重新点“终止并清理”/);
  const details = html.slice(html.indexOf("<details"));
  assert.match(details, /job 0: Worker w1 不可达/);
  sandbox.collapsedExecutionPlanKeys = new Set(["plans/live.yaml"]);
  sandbox.render({
    distributedPlans: [{ planFile: "plans/live.yaml", jobs: [{ status: "running", case: "bus", seed: 3 }] }],
    planStopClearByFile: {
      "plans/live.yaml": { planFile: "plans/live.yaml", phase: "partial-clear", outcome: "failed", message: "Worker w1 不可达", nextStep: "重新点“终止并清理”", failures: ["job 0"] },
    },
  });
  assert.match(html, /data-plan-stop-fold="failed"/);
  assert.match(html, /清理失败/);
  assert.match(html, /恢复监控/);
  sandbox.collapsedExecutionPlanKeys = new Set();
  sandbox.render({
    operations: {},
    distributedPlans: [],
    planStopClearByFile: {
      "plans/only-feedback.yaml": { planFile: "plans/only-feedback.yaml", phase: "partial-clear", outcome: "failed", message: "远端 job 未确认停止", nextStep: "稍后重试", failures: ["tick"] },
    },
  });
  assert.match(html, /data-plan-stop-clear="plans\/only-feedback.yaml"/);
  assert.match(html, /远端 job 未确认停止/);
  assert.match(html.slice(0, html.indexOf("<details")), /下一步：稍后重试/);
});

test("completed stop-clear feedback does not invent a plan card and a newer run hides stale failure text", () => {
  const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");
  const htmlSource = renderPanelHtml();
  const script = panelScriptContaining(htmlSource, "function executionPlanGroupKey(");
  const start = script.indexOf("function executionPlanGroupKey(");
  const end = script.indexOf("function renderOperationSection(state)", start);
  const source = script.slice(start, end);
  let html = "";
  const sandbox = {
    Map, Set,
    operationRowsForState: () => [],
    taskSectionViewModelForState: () => ({ allRows: [] }),
    taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}),
    normalizePlanSelectionKey: (value) => String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase(),
    samePlanSelection: (left, right) => String(left).toLowerCase() === String(right).toLowerCase(),
    selectedExecutionPlanFile: "",
    collapsedExecutionPlanKeys: new Set(),
    persistWebviewState: () => undefined,
    taskStatusToken: String,
    TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]),
    TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: () => false,
    operationIsFailureLike: () => false,
    operationHasDeadEvidence: () => false,
    taskFailureLikeStatus: () => false,
    planBaseName: (value) => String(value).split("/").pop(),
    esc: String,
    escAttr: String,
    detailsOpenAttr: () => "",
    statusClass: String,
    loadingPrefix: () => "",
    renderOperationItem: () => "",
    renderTaskCards: () => "",
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + "\nthis.render = renderExecutionPlanList;", sandbox);
  sandbox.render({
    distributedPlans: [],
    operations: {},
    planStopClearByFile: {
      "plans/gone.yaml": { planFile: "plans/gone.yaml", outcome: "completed", updatedAt: "2026-09-27T01:00:00Z", message: "已清除", nextStep: "完成" },
      "plans/kept.yaml": { planFile: "plans/kept.yaml", outcome: "failed", updatedAt: "2026-09-27T01:00:00Z", message: "Worker 查询失败", nextStep: "恢复隧道", failures: ["w1 timeout"] },
    },
  });
  assert.doesNotMatch(html, /plans\/gone\.yaml|清理完成/);
  assert.match(html, /data-plan-stop-clear="plans\/kept\.yaml"/);
  assert.match(html, /Worker 查询失败/);
  sandbox.render({
    distributedPlans: [{ planFile: "plans/kept.yaml", enqueuedAt: "2026-09-27T02:00:00Z", jobs: [{ status: "running", case: "bus", seed: 1, updatedAt: "2026-09-27T02:00:00Z" }] }],
    planStopClearByFile: {
      "plans/kept.yaml": { planFile: "plans/kept.yaml", outcome: "failed", updatedAt: "2026-09-27T01:00:00Z", message: "旧清理失败", nextStep: "不要再显示" },
    },
  });
  assert.match(html, /plans\/kept\.yaml/);
  assert.doesNotMatch(html, /旧清理失败|不要再显示/);
});

test("a failed worker query keeps its plan progress while an exact receipt still clears another plan", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const queued = queueApi.emptyDistributedQueue();
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除"],
    distributedQueueTickPromise: undefined,
    distributedPlanStopEpoch: 0,
    planStopClearByFile: {},
    client: { getWorkerTasks: async (workerId) => { if (workerId === "slow") throw new Error("查询 slow 超过 8 秒"); return { tasks: [] }; } },
    isRealtimeMode: () => true,
    enabledWorkerConfigs: () => [{ id: "slow" }, { id: "ok" }],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {
      "op-slow": { operationId: "op-slow", type: "run-plan", planFile: "plans/query.yaml", status: "failed", schedulerOwnerWorkerId: "slow" },
      "op-ok": { operationId: "op-ok", type: "run-plan", planFile: "plans/query.yaml", status: "failed", schedulerOwnerWorkerId: "ok" },
    } }),
    runOperationWorkerId: (row) => row.schedulerOwnerWorkerId,
    loadDistributedQueue: async () => queued,
    saveDistributedQueue: async () => undefined,
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async (_key, value) => { sandbox.hidden = value; } } },
  };
  const host = installStopClearHost(sandbox);
  const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/query.yaml" });
  assert.equal(result.status, "failed");
  assert.match(result.message, /slow/);
  assert.deepEqual(sandbox.hidden, ["op-ok"]);
  const card = host.provider.planStopClearByFile["plans/query.yaml"];
  assert.match(card.failures.join("\n"), /op-slow/);
  assert.match(card.failures.join("\n"), /刷新状态/);
});

test("execution section redraws when only the stop-clear feedback changes", () => {
  const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");
  const htmlSource = renderPanelHtml();
  const script = panelScriptContaining(htmlSource, "function sectionPreRenderKey(");
  const start = script.indexOf("function sectionPreRenderKey(");
  const end = script.indexOf("function sectionLocalPreKey(", start);
  assert.ok(start >= 0 && end > start);
  const dependency = script.slice(script.indexOf("function sectionDependencyKey("), script.indexOf("function sectionLocalPreKey("));
  assert.match(dependency, /planStopClearByFile/);
  const renders = [];
  const sandbox = {
    sectionIsCollapsed: () => false,
    panelNow: () => 0, panelSectionShouldRenderNow: () => true, panelSectionPayloadNotLoaded: () => false,
    clearPanelSectionLoadingStatus: () => {}, sectionRenderModel: () => undefined, recordPanelSectionSample: () => {},
    dirtyPanelSections: new Set(), failedPanelSections: new Set(),
    lastSectionPreRenderKeys: {},
    lastRenderedSectionSignatures: {},
    sectionPreRenderKey: (state, section) => section + "::" + JSON.stringify((state || {}).planStopClearByFile || {}),
    sectionRenderSignature: (state, section) => section + "::" + JSON.stringify((state || {}).planStopClearByFile || {}),
    renderExecutionSection: (state) => { renders.push(JSON.stringify(state.planStopClearByFile || {})); },
    applyResourceTreeChildLayout: () => undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(script.slice(script.indexOf("function renderSectionIfVisible("), script.indexOf("function panelNow(", script.indexOf("function renderSectionIfVisible("))) + "\nthis.render = renderSectionIfVisible;", sandbox);
  const state = { planStopClearByFile: {} };
  sandbox.render(state, "execution");
  sandbox.render(state, "execution");
  state.planStopClearByFile = { "plans/stuck.yaml": { outcome: "failed", message: "调度未停下", nextStep: "稍后重试" } };
  sandbox.render(state, "execution");
  assert.deepEqual(renders, ["{}", '{"plans/stuck.yaml":{"outcome":"failed","message":"调度未停下","nextStep":"稍后重试"}}']);
});

test("handleMessage posts the real stop-clear outcome for failed, cancelled, and completed", async () => {
  const dist = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const messageStart = dist.indexOf("async handleMessage(message) {");
  const messageEnd = dist.indexOf("async handleMessageCore(message, command = getSafeCommand(message)) {", messageStart);
  const coreStart = dist.indexOf("async handleMessageCore(message, command = getSafeCommand(message)) {");
  const coreEnd = dist.indexOf("async withUiCommandStatus(clientActionId, command, message, work) {", coreStart);
  const statusStart = dist.indexOf("async withUiCommandStatus(clientActionId, command, message, work) {");
  const statusEnd = dist.indexOf("postUiCommandStatus(clientActionId, status, command, message, extra = undefined) {", statusStart);
  const postStart = dist.indexOf("postUiCommandStatus(clientActionId, status, command, message, extra = undefined) {");
  const postEnd = dist.indexOf("notifyLocalActionStarted(title, detail) {", postStart);
  const leaseStart = dist.indexOf("async withHostOperationLease(actionType, actionLabel, operation, options = {}) {");
  const leaseEnd = dist.indexOf("async ensureRealtimeConnected(", leaseStart);
  assert.ok(messageStart >= 0 && messageEnd > messageStart && coreStart >= 0 && coreEnd > coreStart && statusStart >= 0 && statusEnd > statusStart && postStart >= 0 && postEnd > postStart && leaseStart >= 0 && leaseEnd > leaseStart);
  const methods = [dist.slice(messageStart, messageEnd), dist.slice(coreStart, coreEnd), dist.slice(statusStart, statusEnd), dist.slice(postStart, postEnd), dist.slice(leaseStart, leaseEnd)].join("\n");
  const posted = [];
  const outcomes = {
    failed: { status: "failed", message: "未完成清除 plans/a.yaml\n阶段：partial-clear", planStopClear: { planFile: "plans/a.yaml", outcome: "failed", phase: "partial-clear", nextStep: "稍后重试" } },
    cancelled: { status: "cancelled", message: "第二次确认已取消", planStopClear: { planFile: "plans/a.yaml", outcome: "cancelled", phase: "confirm-cancelled" } },
    completed: { status: "completed", message: "已清除 1 条运行进度", planStopClear: { planFile: "plans/a.yaml", outcome: "completed", phase: "cleared" } },
  };
  const context = {
    OperationOutcome_1: OperationOutcome,
    getSafeCommand: (message) => message.command,
    stringField: (message, key) => String(message[key] || ""),
    booleanField: () => false,
    debugModeBlockedUiCommand: () => false,
    hostOperationLeaseActionForUiCommand: () => "stopAndClearPlan",
    hostOperationLeaseActionLabel: () => "终止并清理",
    commandNeedsUiStatus: () => true,
    PLAN_SUBMISSION_COMMANDS: new Set(["runPlan", "reproducePlan"]),
    withSafeTransferRetry: (_command, _message, work) => work(),
    extensionRuntimeVersionState: () => ({ reloadRequired: false }),
    localCommandReleasesAfterTrigger: () => false,
    isUiCommandRemotePending: () => false,
    isUiCommandCancelled: () => false,
    errorMessage: (error) => String(error.message || error),
    compactSensitiveText: (value, max = 240) => String(value || "").slice(0, max),
    uiCommandWatchdogMs: () => 0,
    finishPlanSubmissionProgress: () => undefined,
    recordActionError: () => undefined,
    actionErrorSuggestion: () => "",
    postState: () => undefined,
    console,
    currentHostOperationLeaseContext: () => ({ workspaceUri: "file://project", hostProjectPath: "D:/project" }),
    hostOperationLease: { run: async (_meta, operation) => operation() },
    stopAndClearPlanFromUi: async (message) => outcomes[message.outcome],
    view: { webview: { postMessage: async (payload) => { posted.push(payload); } } },
    vscode: { window: { showInformationMessage: () => Promise.resolve(undefined), showErrorMessage: () => Promise.resolve(undefined) } },
  };
  vm.createContext(context);
  vm.runInContext(`class Host { ${methods} }\nthis.provider = Object.assign(new Host(), this);`, context);
  for (const outcome of ["failed", "cancelled", "completed"]) {
    await context.provider.handleMessage({ command: "stopAndClearPlan", clientActionId: "act-" + outcome, outcome });
  }
  assert.deepEqual(posted.map((item) => item.status), ["running", "failed", "running", "cancelled", "running", "completed"], JSON.stringify(posted));
  assert.equal(posted.filter((item) => item.status !== "running").every((item) => item.command === "stopAndClearPlan" && item.planStopClear.planFile === "plans/a.yaml"), true);
  assert.equal(posted.some((item) => item.status === "failed" && item.planStopClear.phase === "partial-clear"), true);
  assert.equal(posted.some((item) => item.status === "cancelled" && item.planStopClear.phase === "confirm-cancelled"), true);
  assert.equal(posted.some((item) => item.status === "completed" && item.planStopClear.phase === "cleared"), true);
});

test("a preview failure before confirmation stays on the plan card", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const sandbox = {
    root: "D:/project",
    answers: [],
    distributedQueueTickPromise: undefined,
    distributedPlanStopEpoch: 0,
    distributedQueueGeneration: 0,
    planStopClearByFile: {},
    isRealtimeMode: () => false,
    enabledWorkerConfigs: () => [],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
      planFile: "plans/preview.yaml", revision: "rev", codeFingerprint: "old",
      jobs: [{ index: 0, case: "bus", seed: 1, outputDir: "work/preview/0" }],
    }, "plan-preview"),
    saveDistributedQueue: async () => { throw new Error("must not save"); },
    postState: () => undefined,
  };
  const realPreview = require("../../dist/features/PlanStopClear.js").planStopClearPreview;
  require("../../dist/features/PlanStopClear.js").planStopClearPreview = () => { throw new Error("预览拼装失败"); };
  try {
    const host = installStopClearHost(sandbox);
    const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/preview.yaml" });
    assert.equal(result.status, "failed");
    assert.match(result.message, /生成清理预览失败/);
    assert.match(result.message, /预览拼装失败/);
    assert.equal(host.provider.planStopClearByFile["plans/preview.yaml"].phase, "preview");
  } finally {
    require("../../dist/features/PlanStopClear.js").planStopClearPreview = realPreview;
  }
});

test("only stopAndClearPlan consumes a structured command result", async () => {
  const dist = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const start = dist.indexOf("const guardedWork = work()");
  const end = dist.indexOf("const result = await guardedWork", start);
  const body = dist.slice(start, end);
  assert.match(body, /command === "stopAndClearPlan"/);
  const structured = { status: "failed", message: "未完成清除", planStopClear: { planFile: "plans/a.yaml" } };
  const run = async (command) => {
    const context = {
      command,
      PLAN_SUBMISSION_COMMANDS: new Set(["runPlan", "reproducePlan"]),
      isLocalTrigger: false,
      work: async () => structured,
      localCommandReleasesAfterTrigger: () => false,
      isUiCommandRemotePending: () => false,
      isUiCommandCancelled: () => false,
      errorMessage: (error) => String(error.message || error),
    };
    vm.createContext(context);
    vm.runInContext(`this.guarded = (async () => { ${body}\nreturn guardedWork; })()`, context);
    return context.guarded;
  };
  const other = await run("snapshot");
  assert.equal(other.status, "completed");
  assert.equal(other.message, "completed");
  assert.equal(other.planStopClear, undefined);
  const clear = await run("stopAndClearPlan");
  assert.equal(clear.status, "failed");
  assert.match(clear.message, /未完成清除/);
  assert.equal(clear.planStopClear.planFile, "plans/a.yaml");
});

test("mixed clear drops the pending job and keeps the running job when the worker never answers", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const allocated = queueApi.allocateAvailable(queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/mix.yaml", revision: "rev-mix", codeFingerprint: "new",
    jobs: [
      { index: 0, case: "bus", seed: 1, outputDir: "work/mix/0" },
      { index: 1, case: "bus", seed: 2, outputDir: "work/mix/1" },
    ],
  }, "plan-mix"), [{ workerId: "w1", idleGpuIds: ["0"], online: true }]);
  const queued = allocated.queue;
  const remote = queued.plans[0].jobs.find((job) => job.workerId);
  remote.status = "running";
  const other = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/other.yaml", revision: "rev-other", codeFingerprint: "new",
    jobs: [{ index: 0, case: "pad", seed: 9, outputDir: "work/other/0", status: "running", workerId: "w9", gpuId: "1", commandId: "cmd-other", attempt: 1 }],
  }, "plan-other");
  queued.plans.push(other.plans[0]);
  let saved = queued;
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除"],
    distributedQueueTickPromise: new Promise(() => {}),
    distributedQueueWritePromise: Promise.resolve(),
    distributedPlanStopEpoch: 0,
    distributedLaunchInFlight: new Set(),
    planStopClearByFile: {},
    planStopClearTimeoutMs: 30,
    client: { getWorkerTasks: () => new Promise(() => {}) },
    isRealtimeMode: () => true,
    enabledWorkerConfigs: () => [{ id: "w1" }],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => saved,
    saveDistributedQueue: async (_root, next) => { saved = next; },
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async () => undefined } },
  };
  const host = installStopClearHost(sandbox);
  const started = Date.now();
  const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/mix.yaml" });
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.status, "failed");
  assert.match(result.message, /job 1 保留|30 秒无有效响应/);
  const mix = saved.plans.find((plan) => plan.id === "plan-mix");
  assert.equal(mix.jobs.length, 1);
  assert.equal(mix.jobs[0].commandId, remote.commandId);
  assert.equal(mix.jobs[0].status, "running");
  assert.equal(saved.plans.find((plan) => plan.id === "plan-other").jobs[0].commandId, "cmd-other");
  assert.equal(host.provider.distributedPlanStopEpoch, 0);
  assert.equal(host.provider.distributedQueueTickPromise, undefined);
});

test("a launch still in flight is not treated as an undispatched job", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const queued = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/launch.yaml", revision: "rev-launch", codeFingerprint: "new",
    jobs: [{ index: 0, case: "bus", seed: 3, outputDir: "work/launch/0" }],
  }, "plan-launch");
  const job = queued.plans[0].jobs[0];
  let saved = queued;
  let writes = 0;
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除"],
    distributedQueueTickPromise: undefined,
    distributedQueueWritePromise: Promise.resolve(),
    distributedPlanStopEpoch: 0,
    distributedLaunchInFlight: new Set([`${queued.plans[0].id}\0${job.index}\0${job.attempt}`]),
    planStopClearByFile: {},
    client: { getWorkerTasks: async () => { throw new Error("must not query"); } },
    isRealtimeMode: () => false,
    enabledWorkerConfigs: () => [],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => saved,
    saveDistributedQueue: async (_root, next) => { saved = next; writes += 1; },
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async () => undefined } },
  };
  const host = installStopClearHost(sandbox);
  const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/launch.yaml" });
  assert.equal(result.status, "failed");
  assert.match(result.message, /远端身份尚未回写/);
  assert.equal(writes, 1, "only persist explicit stop intent; never clear an in-flight launch");
  assert.ok(saved.plans[0].automaticRetry.disabledAt);
  assert.equal(saved.plans[0].jobs.length, 1);
});

test("a hung queue write keeps the undispatched plan and a later clear removes it", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const queued = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/write.yaml", revision: "rev-write", codeFingerprint: "old",
    jobs: [{ index: 0, case: "bus", seed: 5, outputDir: "work/write/0" }],
  }, "plan-write");
  let saved = queued;
  let releaseWrite;
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除", "继续中止并清除", "确认中止并清除"],
    distributedQueueTickPromise: undefined,
    planStopClearTimeoutMs: 30,
    distributedQueueWritePromise: new Promise((resolve) => { releaseWrite = resolve; }),
    distributedPlanStopEpoch: 0,
    distributedLaunchInFlight: new Set(),
    planStopClearByFile: {},
    isRealtimeMode: () => false,
    enabledWorkerConfigs: () => [],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => saved,
    saveDistributedQueue: async (_root, next) => { saved = next; },
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async () => undefined } },
  };
  const host = installStopClearHost(sandbox);
  const started = Date.now();
  const blocked = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/write.yaml" });
  assert.ok(Date.now() - started < 1000);
  assert.equal(blocked.status, "failed");
  assert.match(blocked.message, /仍在写入/);
  assert.equal(saved.plans[0].jobs.length, 1);
  assert.equal(host.provider.distributedPlanStopEpoch, 0);
  releaseWrite();
  await host.provider.distributedQueueWritePromise;
  const cleared = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/write.yaml" });
  assert.equal(cleared.status, "completed", cleared.message);
  assert.equal(saved.plans.length, 0);
});

test("cancelling either confirmation and switching projects writes nothing", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const queued = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/cancel.yaml", revision: "rev-cancel", codeFingerprint: "old",
    jobs: [{ index: 0, case: "bus", seed: 6, outputDir: "work/cancel/0" }],
  }, "plan-cancel");
  let writes = 0;
  const sandbox = {
    root: "D:/project",
    answers: ["取消"],
    distributedQueueTickPromise: undefined,
    distributedQueueWritePromise: Promise.resolve(),
    distributedPlanStopEpoch: 0,
    planStopClearByFile: {},
    isRealtimeMode: () => false,
    enabledWorkerConfigs: () => [],
    captureProjectContext: () => ({ root: sandbox.root }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => queued,
    saveDistributedQueue: async () => { writes += 1; },
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async () => undefined } },
  };
  const host = installStopClearHost({ ...sandbox, answers: ["取消"] });
  const first = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/cancel.yaml" });
  assert.equal(first.status, "cancelled", first && first.message);
  const secondHost = installStopClearHost({ ...sandbox, answers: ["继续中止并清除", "先不清理"] });
  const second = await secondHost.provider.stopAndClearPlanFromUi({ planFile: "plans/cancel.yaml" });
  assert.equal(second.status, "cancelled", second && second.message);
  const switchSandbox = { ...sandbox, root: "D:/project", answers: ["继续中止并清除", "确认中止并清除"] };
  const switchHost = installStopClearHost(switchSandbox);
  const originalWarn = switchHost.vscode.window.showWarningMessage;
  switchHost.vscode.window.showWarningMessage = async (text, options, action) => {
    if (String(text).startsWith("第二次确认")) switchSandbox.root = "D:/other";
    return originalWarn(text, options, action);
  };
  const switched = await switchHost.provider.stopAndClearPlanFromUi({ planFile: "plans/cancel.yaml" });
  assert.equal(switched.status, "cancelled", switched.message);
  assert.match(switched.message, /项目已切换/);
  assert.equal(writes, 0);
});

test("a local submission spinner clears without a remote stop", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const stops = [];
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除"],
    distributedQueueTickPromise: undefined,
    distributedQueueWritePromise: Promise.resolve(),
    distributedPlanStopEpoch: 0,
    distributedLaunchInFlight: new Set(),
    planStopClearByFile: {},
    planStopClearTimeoutMs: 30,
    localOperations: {
      "plan-submit-local": { operationId: "plan-submit-local", type: "run-plan", status: "running", localSubmissionProgress: true, planFile: "plans/spinner.yaml", message: "提交中，待生成 job" },
    },
    markLocalOperationsDirty: () => undefined,
    client: { getWorkerTasks: async () => { throw new Error("local spinner must not query a worker"); } },
    stopExperimentRouted: async () => { stops.push("stop"); },
    isRealtimeMode: () => true,
    enabledWorkerConfigs: () => [{ id: "w1" }],
    captureProjectContext: () => ({ root: "D:/project" }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: sandbox.localOperations }),
    loadDistributedQueue: async () => queueApi.emptyDistributedQueue(),
    saveDistributedQueue: async () => { throw new Error("local spinner must not write the queue"); },
    postState: () => undefined,
    context: { workspaceState: { get: () => [], update: async () => undefined } },
  };
  const host = installStopClearHost(sandbox);
  const result = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/spinner.yaml" });
  assert.equal(result.status, "completed", result && result.message);
  assert.deepEqual(stops, []);
  assert.equal(host.provider.localOperations["plan-submit-local"].status, "cancelled");
});

test("stopping during a hung fingerprint cancels that submission and a new one can enqueue", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  let saved = queueApi.emptyDistributedQueue();
  const hashReleases = new Map();
  const writes = [];
  const sandbox = {
    root: "D:/project",
    answers: ["继续中止并清除", "确认中止并清除"],
    distributedQueueTickPromise: new Promise(() => {}),
    distributedQueueWritePromise: Promise.resolve(),
    distributedPlanStopEpoch: 0,
    distributedQueueGeneration: 0,
    distributedLaunchInFlight: new Set(),
    planStopClearByFile: {},
    planStopClearTimeoutMs: 30,
    localOperations: {},
    lastCodeSyncState: { fingerprint: "code-1" },
    markLocalOperationsDirty: () => undefined,
    postState: () => undefined,
    postUiCommandStatus: () => undefined,
    isRealtimeMode: () => false,
    enabledWorkerConfigs: () => [],
    workerActionTargets: () => [],
    captureProjectContext: () => ({ root: sandbox.root }),
    projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState() { return { operations: this.localOperations }; },
    loadDistributedQueue: async () => saved,
    saveDistributedQueue: async (_root, next) => { writes.push(next.plans.map((plan) => plan.planFile)); saved = next; },
    context: { workspaceState: { get: () => [], update: async () => undefined }, globalStorageUri: { fsPath: "C:/tmp" } },
    distributedCodeVersionHold: (body) => new Promise((resolve) => { hashReleases.set(body.planFile, () => resolve(null)); }),
    localDistributedCodeFingerprint: async () => "code-1",
    ensureCodeReadyForRun: async () => undefined,
    runPlanPreflight: async () => ({ validation: { jobs: [{ index: 0, case: "bus", seed: 1, output_dir: "work/hash" }] } }),
    confirmDistributedPlanExistingOutputs: async () => undefined,
    assertExecutionCondaEnvReady: () => undefined,
    reportPlanStage: () => undefined,
    openPanelAt: async () => undefined,
    tickDistributedQueue: async () => undefined,
    recordActionError: () => undefined,
  };
  const host = installStopClearHost(sandbox);
  host.provider.beginPlanSubmissionProgress({ clientActionId: "hash-1" }, { planFile: "plans/hash.yaml" });
  host.provider.beginPlanSubmissionProgress({ clientActionId: "other-1" }, { planFile: "plans/other.yaml" });
  const target = host.provider.finishDistributedPlanSubmission("runPlan", { clientActionId: "hash-1", planFile: "plans/hash.yaml" }, {}, { planFile: "plans/hash.yaml", planRevision: "rev-hash" });
  const other = host.provider.finishDistributedPlanSubmission("runPlan", { clientActionId: "other-1", planFile: "plans/other.yaml" }, {}, { planFile: "plans/other.yaml", planRevision: "rev-other" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof hashReleases.get("plans/hash.yaml"), "function");
  const cleared = await host.provider.stopAndClearPlanFromUi({ planFile: "plans/hash.yaml" });
  assert.equal(cleared.status, "completed", cleared && cleared.message);
  assert.equal(host.provider.localOperations["plan-submit-hash-1"].status, "cancelled");
  assert.equal(host.provider.localOperations["plan-submit-other-1"].status, "running");
  // The fixture's original scheduler tick intentionally never settles; exercise enqueue without awaiting that stale tick.
  host.provider.tickDistributedQueue = async () => undefined;
  await Promise.race([target, new Promise((_, reject) => setTimeout(() => reject(new Error("cancelled submission kept its lease")), 300))]);
  hashReleases.get("plans/hash.yaml")();
  hashReleases.get("plans/other.yaml")();
  await target;
  await other;
  assert.equal(JSON.stringify(writes), JSON.stringify([["plans/other.yaml"]]));
  assert.equal(saved.plans.length, 1);
  assert.equal(host.provider.localOperations["plan-submit-hash-1"].status, "cancelled");
  const again = installStopClearHost({ ...sandbox, answers: ["继续中止并清除", "先不清理"], localOperations: {} });
  again.provider.beginPlanSubmissionProgress({ clientActionId: "keep-1" }, { planFile: "plans/hash.yaml" });
  const kept = again.provider.finishDistributedPlanSubmission("runPlan", { clientActionId: "keep-1", planFile: "plans/hash.yaml" }, {}, { planFile: "plans/hash.yaml", planRevision: "rev-keep" });
  await new Promise((resolve) => setImmediate(resolve));
  const cancelledConfirm = await again.provider.stopAndClearPlanFromUi({ planFile: "plans/hash.yaml" });
  assert.equal(cancelledConfirm.status, "cancelled", cancelledConfirm && cancelledConfirm.message);
  assert.equal(again.provider.localOperations["plan-submit-keep-1"].status, "running");
  // This host also inherits the deliberately pending tick; completing the fingerprint should test queueing only.
  again.provider.tickDistributedQueue = async () => undefined;
  hashReleases.get("plans/hash.yaml")();
  await kept;
  assert.equal(again.provider.localOperations["plan-submit-keep-1"].status, "succeeded");
  assert.equal(saved.plans.some((plan) => plan.planFile === "plans/hash.yaml"), true);
});

test("concurrent submissions append to the latest queue and reject the old scheduler snapshot", async () => {
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const dist = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const start = dist.indexOf("async saveDistributedQueue(root, queue, options");
  const end = dist.indexOf("async patchDistributedJob(", start);
  assert.ok(start >= 0 && end > start);
  const method = dist.slice(start, end).replace("async saveDistributedQueue(", "async function saveDistributedQueue(");
  const snapshots = [];
  const files = new Map();
  let releaseFirst;
  const host = {
    withQueueWriteResource: async (_root, work) => work(),
    distributedQueueGeneration: 0,
    distributedQueueWritePromise: Promise.resolve(),
    distributedQueueRoot: "D:/project",
    distributedQueueCache: queueApi.emptyDistributedQueue(),
    distributedSubmissionEpochs: new Map([["submit-a", 1], ["submit-b", 1]]),
    context: { globalStorageUri: { fsPath: "C:/fake-storage" } },
    detachStaleDistributedTick: () => undefined,
  };
  vm.createContext(Object.assign(host, {
    DistributedPlanQueue: queueApi, workspaceRoot: () => "D:/project", path, process,
    errorMessage: (error) => String(error?.message || error),
    compactSensitiveText: (value) => String(value || "").slice(0, 240),
    crypto: { randomBytes: () => Buffer.from("fake") },
    fsNode: require("node:fs"),
    fs: {
      mkdir: async () => undefined,
      lstat: async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
      readFile: async (file) => {
        if (!files.has(file)) { const error = new Error("missing"); error.code = "ENOENT"; throw error; }
        return files.get(file);
      },
      open: async (file) => ({
        writeFile: async (text) => {
          files.set(file, text);
          snapshots.push(JSON.parse(text));
          if (snapshots.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
        },
        sync: async () => undefined,
        close: async () => undefined,
      }),
      writeFile: async (file, text) => {
        files.set(file, text);
        snapshots.push(JSON.parse(text));
        if (snapshots.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      },
      rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    },
  }));
  // This fixture exercises queue append ordering; atomic-writer retry behavior has its own real-writer fixture.
  host.StateStore_1 = { atomicWriteText: async (file, text, options = {}) => {
    await host.fs.writeFile(file + ".writing", text);
    await options.beforeRename?.();
    await host.fs.rename(file + ".writing", file);
  } };
  vm.runInContext(method + "\nthis.save = saveDistributedQueue;", host);
  const a = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/a.yaml", revision: "rev-a", codeFingerprint: "code-1", jobs: [{ index: 0, case: "bus", seed: 1, outputDir: "work/a" }],
  }, "a");
  const b = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    planFile: "plans/b.yaml", revision: "rev-b", codeFingerprint: "code-1", jobs: [{ index: 0, case: "bus", seed: 2, outputDir: "work/b" }],
  }, "b");
  const first = host.save("D:/project", a, { appendPlanId: "a", queueGeneration: 0, submissionOperationId: "submit-a", submissionEpoch: 1 });
  const second = host.save("D:/project", b, { appendPlanId: "b", queueGeneration: 0, submissionOperationId: "submit-b", submissionEpoch: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseFirst, "function");
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(host.distributedQueueCache.plans.map((plan) => plan.id).join(","), "a,b");
  await assert.rejects(host.save("D:/project", a, { queueGeneration: 0 }), /过期调度/);
  host.distributedSubmissionEpochs.set("submit-a", 2);
  await assert.rejects(host.save("D:/project", a, { appendPlanId: "a", submissionOperationId: "submit-a", submissionEpoch: 1 }), /提交已取消/);
  assert.equal(snapshots.length, 2);
});

test("caller cancellation reaches the actual Worker task HTTP request", async () => {
  const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
  const { HttpTunnelClient } = require("../../dist/tunnel/TunnelClient.js");
  const originalFetch = global.fetch;
  let started;
  let requestAbortReason;
  const ready = new Promise((resolve) => { started = resolve; });
  global.fetch = async (url, options) => {
    assert.match(url, /api\/worker\/tasks$/);
    started();
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => {
      requestAbortReason = options.signal.reason;
      reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("caller aborted"));
    }, { once: true }));
  };
  try {
    const budget = new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] });
    const client = new HttpTunnelClient({ localHost: "localhost", localPort: 23456, timeoutMs: 1000 }, budget);
    const controller = new AbortController();
    const abortReason = new Error("caller aborted");
    const failed = assert.rejects(client.getWorkerTasks({ signal: controller.signal }), /caller aborted/);
    await ready;
    controller.abort(abortReason);
    await failed;
    assert.equal(requestAbortReason, abortReason, "the final subscriber's cancellation reason must reach fetch");
  } finally {
    global.fetch = originalFetch;
  }
});

test("plugin refuses exact pane stop unless the live worker probe advertises it", () => {
  const stopper = extension.slice(extension.indexOf("workerSupportsExactPaneStop("), extension.indexOf("async stopAndClearPlanFromUi("));
  assert.match(stopper, /lastWorkerProbes\?\.\[workerId\]/);
  assert.match(stopper, /stop-worker-task-exact-pane/);
  assert.match(stopper, /请先更新并重启该 Worker Agent/);
  const agent = fs.readFileSync(path.join(__dirname, "../../src/clusterAgentRuntime.legacy.ts"), "utf8");
  const capabilities = agent.slice(agent.indexOf("def api_capabilities"), agent.indexOf("def api_file_capabilities"));
  assert.match(capabilities, /"stop-worker-task-exact-pane": True/);
  const clear = extension.slice(extension.indexOf("const stopEpoch = this.distributedPlanStopEpoch"), extension.indexOf("async downloadDebugBundle("));
  const arm = clear.indexOf("this.distributedPlanStopEpoch = (this.distributedPlanStopEpoch || 0) + 1");
  const wait = clear.indexOf("distributedQueueTickPromise");
  const restore = clear.lastIndexOf("this.distributedPlanStopEpoch = 0");
  assert.ok(arm >= 0 && wait > arm && restore > wait);
  assert.ok(clear.indexOf("try {") < wait);
  assert.ok(clear.lastIndexOf("finally {") < restore);
});

test("serialized Agent stop receipts pass the production project-scoped clear chain", async () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const file = path.join(__dirname, "fixtures/exactPaneStop.py");
  const result = spawnSync("python", [file], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", TEST_AGENT_PATH: agentPath },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const fixture = JSON.parse(result.stdout);
  const { modernTask: task, modernResult: receipt } = fixture;
  const queueApi = require("../../dist/features/DistributedPlanQueue.js");
  const plan = { id: task.workflowId, projectId: task.projectId, planFile: task.planFile,
    revision: task.planRevision, codeFingerprint: task.codeFingerprint, planJobCount: task.planJobCount };
  const job = { index: task.experimentIndex, case: task.case, seed: task.seed, attempt: task.attempt,
    outputDir: task.outputDir, commandId: task.commandId, runKey: task.runKey, workerId: task.workerId,
    gpuId: task.gpuId, status: task.status };
  assert.equal(queueApi.stopIdentityMatchesJob(plan, job, receipt.stoppedTasks[0]), true);
  const context = vm.createContext({ DistributedPlanQueue: queueApi, makeOpId: () => "stop-host",
    workspaceRoot: () => "D:/project" });
  const stopper = loadExtensionHandler("async stopDistributedJobForClear(", "async stopAndClearPlanFromUi(");
  vm.runInContext(`class Host { ${stopper} } this.Host = Host;`, context);
  const provider = new context.Host();
  const client = { postWorkerAction: async () => receipt, getWorkerTasks: async () => ({ tasks: [task] }) };
  Object.assign(provider, { refreshExactPaneStopCapability: async () => true, client,
    withRemoteActionResource: async (_worker, _action, _request, action) => action() });
  assert.equal((await provider.stopDistributedJobForClear(plan, job)).status, "completed");
  const modernQueue = { ...queueApi.emptyDistributedQueue(), plans: [{ ...plan, jobs: [job], enqueuedAt: "t" }] };
  let saved = modernQueue;
  const clearHost = installStopClearHost({ root: "D:/project", answers: ["继续中止并清除", "确认中止并清除"],
    distributedPlanStopEpoch: 0, planStopClearByFile: {}, client,
    isRealtimeMode: () => true, enabledWorkerConfigs: () => [{ id: task.workerId }],
    captureProjectContext: () => ({ root: "D:/project" }), projectContextIsCurrent: () => true,
    buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
    loadDistributedQueue: async () => saved, saveDistributedQueue: async (_root, next) => { saved = next; },
    stopDistributedJobForClear: (currentPlan, currentJob) => provider.stopDistributedJobForClear(currentPlan, currentJob),
    postState: () => undefined, context: { workspaceState: { get: () => [], update: async () => undefined } } });
  const cleared = await clearHost.provider.stopAndClearPlanFromUi({ command: "stopAndClearPlan", planFile: plan.planFile });
  assert.equal(cleared.status, "completed", JSON.stringify(cleared));
  assert.equal(cleared.planStopClear.clearedJobs, 1);
  assert.equal(saved.plans.length, 0);
  const recoverAfterClear = (value, tasks, projectId) => {
    const now = Date.now();
    const workerIds = [...new Set(tasks.map(row => row.workerId))];
    return queueApi.mergeDurableWorkerSnapshots(JSON.parse(JSON.stringify(value)), workerIds.map(workerId => ({
      workerId, capabilities: { durablePlanQueue: true, schemaVersion: 1 },
      generatedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(),
      tasks: tasks.filter(row => row.workerId === workerId),
    })), projectId, now);
  };
  for (let index = 0; index < 3; index++) {
    saved = recoverAfterClear(saved, [task], task.projectId);
    assert.equal(saved.plans.length, 0, "real serialized receipt must remain cleared after restart and remote recovery");
  }
  for (const field of ["projectId", "codeFingerprint", "experimentIndex", "runKey", "attempt", "workerId", "outputDir"]) {
    const invalid = { ...receipt, stoppedTasks: [{ ...receipt.stoppedTasks[0], [field]: "wrong" }] };
    provider.client = { ...client, postWorkerAction: async () => invalid };
    await assert.rejects(provider.stopDistributedJobForClear(plan, job), /回执.*身份/);
  }
  if (process.env.TEST_STOP_EVIDENCE) {
    const evidence = JSON.parse(process.env.TEST_STOP_EVIDENCE);
    const liveClient = {
      getWorkerTasks: async (workerId) => ({ tasks: evidence.tasks.filter(row => row.workerId === workerId) }),
      postWorkerAction: async (workerId, _action, request) => ({ status: "completed", message: "stopped=0 matched=1",
        stoppedTasks: fixture.liveReceipts.filter(row => row.workerId === workerId && row.commandId === request.targetCommandId) }),
    };
    provider.client = liveClient;
    let liveQueue = { ...queueApi.emptyDistributedQueue(), plans: [evidence.plan] };
    const liveHost = installStopClearHost({ root: "D:/project", answers: ["继续中止并清除", "确认中止并清除"],
      distributedPlanStopEpoch: 0, planStopClearByFile: {}, client: liveClient,
      isRealtimeMode: () => true, enabledWorkerConfigs: () => evidence.inventories.map(row => ({ id: row.workerId })),
      captureProjectContext: () => ({ root: "D:/project" }), projectContextIsCurrent: () => true,
      buildPlanRuntimeEvidenceState: () => ({ operations: {} }),
      loadDistributedQueue: async () => liveQueue, saveDistributedQueue: async (_root, next) => { liveQueue = next; },
      stopDistributedJobForClear: (currentPlan, currentJob) => provider.stopDistributedJobForClear(currentPlan, currentJob),
      postState: () => undefined, context: { workspaceState: { get: () => [], update: async () => undefined } } });
    const liveCleared = await liveHost.provider.stopAndClearPlanFromUi({ command: "stopAndClearPlan", planFile: evidence.plan.planFile });
    assert.equal(liveCleared.status, "completed", JSON.stringify(liveCleared));
    assert.equal(liveCleared.planStopClear.clearedJobs, evidence.plan.jobs.length);
    assert.equal(liveQueue.plans.length, 0);
    for (let index = 0; index < 3; index++) {
      liveQueue = recoverAfterClear(liveQueue, evidence.tasks, evidence.plan.projectId);
      assert.equal(liveQueue.plans.length, 0, "live audit receipts must not resurrect this exact cleared run");
    }
  }
});
