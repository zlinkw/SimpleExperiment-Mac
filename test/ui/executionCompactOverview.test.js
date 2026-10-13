const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extract(startName, endName) {
  const start = panel.indexOf(`function ${startName}(`);
  const end = panel.indexOf(`function ${endName}(`, start + 1);
  assert.ok(start >= 0 && end > start);
  return panel.slice(start, end).replaceAll("\\\\", "\\");
}

function executionPlanSource() {
  const helpers = panel.indexOf("function renderPlanTaskCards(");
  const end = panel.indexOf("function renderOperationSectionIfChanged(", helpers);
  assert.ok(helpers > 0 && end > helpers);
  const asArray = panel.slice(panel.indexOf("function asArray(")).split("\n")[0];
  return asArray + "\n" + panel.slice(helpers, end).replaceAll("\\\\", "\\");
}

test("formal failed recall binds original command while historical cleanup receipts stay read-only", () => {
  const sandbox = clickSandbox();
  const state = { distributedPlans: [{ id: "failed-run", planFile: "plans/cpsc.yaml", failedAttemptRecoveries: [],
    jobs: ["failed", "running", "completed"].map((status, index) => ({ index, case: "case" + index, seed: 42,
      status, workerId: "worker-a", commandId: "command-" + index, resultPathPolicy: "declared",
      globalJobId: "failed-run:" + index, outputDir: "work_dirs/a/job-" + index })) }] };
  sandbox.render(state);
  assert.equal((sandbox.html.match(/data-command="recallFailedJob"/g) || []).length, 1);
  assert.match(sandbox.html, /data-command="recallFailedJob"[^>]*data-plan-id="failed-run"[^>]*data-job-index="0"[^>]*data-command-id="command-0"/);
  assert.doesNotMatch(sandbox.html, /data-command="recallFailedJob"[^>]*data-attempt=/);
  const oldKey = sandbox.executionRenderKeysForState(state).planList;
  const updated = structuredClone(state);
  updated.distributedPlans[0].failedAttemptRecoveries = [{ jobIndex: 0, attempt: 1, status: "pending" }];
  updated.distributedPlans[0].jobs[0].commandId = "replacement-command";
  updated.distributedPlans[0].jobs[0].status = "pending";
  assert.notEqual(sandbox.executionRenderKeysForState(updated).planList, oldKey);
  sandbox.render(updated); assert.match(sandbox.html, /历史遗留清理记录需人工审核，不会自动移动或删除/);
  const final = structuredClone(updated);
  final.distributedPlans[0].failedAttemptRecoveries[0].status = "completed";
  sandbox.render(final); assert.match(sandbox.html, /历史回执：失败目录已移入原 Worker 的 clean_dir/);
  const absent = structuredClone(final);
  absent.distributedPlans[0].failedAttemptRecoveries[0].alreadyAbsent = true;
  sandbox.render(absent); assert.match(sandbox.html, /历史失败目录已核验不存在/);
  const historical = structuredClone(state);
  for (const job of historical.distributedPlans[0].jobs) { delete job.resultPathPolicy; delete job.globalJobId; job.attempt = 1; }
  sandbox.render(historical); assert.doesNotMatch(sandbox.html, /data-command="recallFailedJob"/);
});

test("formal preflight rejection explains that training never started and disables nonexistent TMUX logs", () => {
  const sandbox = clickSandbox();
  const state = { distributedPlans: [{ id: "formal-run", planFile: "plans/formal.yaml", jobs: [{ index: 0,
    case: "formal", seed: 42, status: "failed", workerId: "worker-a", commandId: "rejected-command", attempt: 0,
    outputDir: "work_dirs/formal", error: "FORMAL_JOB_CONFLICT: work_dirs/formal",
    admissionRejection: { code: "FORMAL_JOB_CONFLICT", message: "conflict", rejectedAt: "2026-10-12T00:00:00Z" } }] }] };
  sandbox.render(state);
  assert.match(sandbox.html, /启动前预检已拒绝此 job，训练未开始，不会自动重派/);
  assert.match(sandbox.html, /worker-a · 未启动/);
  assert.match(sandbox.html, /data-job-tmux-log="1"[^>]* disabled/);
  assert.doesNotMatch(sandbox.html, /这是已提交 job 的失败|data-command="recallFailedJob"/);
  const updated = structuredClone(state);
  updated.distributedPlans[0].jobs[0].admissionRejection.code = "FORMAL_JOB_DECLARATION_CHANGED";
  assert.notEqual(sandbox.executionRenderKeysForState(updated).planList, sandbox.executionRenderKeysForState(state).planList);
});

test("completed Plan history keeps explicit expansion across status refreshes, count changes and recreation", () => {
  const sandbox = clickSandbox({ detailsOpenState: {}, persistTransientPanelState: () => {} });
  vm.runInContext(extract("detailsOpenAttr", "scheduleStatusInfoPopoverClose"), sandbox);
  const toggleStart = panel.indexOf('const keyed = event.target.closest && event.target.closest("details[data-details-key]")');
  const toggleEnd = panel.indexOf('const historyDetails =', toggleStart);
  vm.runInContext('this.toggleHistory = function(event) {' + panel.slice(toggleStart, toggleEnd) + '};', sandbox);
  const plan = { id: "completed-run", planFile: "plans/done.yaml", enqueuedAt: "2026-10-09T08:00:00Z",
    jobs: [{ index: 0, case: "done", seed: 42, status: "completed", workerId: "worker-a", commandId: "done-command" }] };
  const render = (extra = []) => sandbox.render({ distributedPlans: [plan, ...extra] });
  const history = /<details class="executionPlanHistory" data-details-key="execution-plan-history"([^>]*)>/;
  render();
  assert.ok(history.test(sandbox.html), "history participates in persisted detail state");
  assert.doesNotMatch(sandbox.html.match(history)[1], /open/);
  const element = { open: true, dataset: { detailsKey: "execution-plan-history" }, closest() { return this; } };
  sandbox.toggleHistory({ target: element });
  plan.jobs[0].finishedAt = "2026-10-09T09:00:00Z";
  render(); assert.match(sandbox.html.match(history)[1], /open/);
  render([{ ...plan, id: "second-run", planFile: "plans/second.yaml" }]);
  assert.match(sandbox.html.match(history)[1], /open/);
  sandbox.render({ distributedPlans: [] });
  render(); assert.match(sandbox.html.match(history)[1], /open/);
  element.open = false; sandbox.toggleHistory({ target: element });
  render(); assert.doesNotMatch(sandbox.html.match(history)[1], /open/);
  const restored = clickSandbox({ detailsOpenState: { "execution-plan-history": true } });
  vm.runInContext(extract("detailsOpenAttr", "scheduleStatusInfoPopoverClose"), restored);
  restored.render({ distributedPlans: [plan] });
  assert.match(restored.html.match(history)[1], /open/, "webview restoration retains the explicit expansion");
});

test("automatic retry shows waiting, queue, exhaustion and success without losing the original failure", () => {
  const sandbox = clickSandbox();
  const job = { index: 1, case: "bus", seed: 44, status: "failed", workerId: "nwpu5", commandId: "failed-job",
    error: "CUDA failed", automaticRetry: { failureCount: 1, failedAttempt: 1, retryAt: "2026-10-08T08:01:00Z" } };
  const state = { distributedPlans: [{ id: "current", planFile: "plans/current.yaml", enqueuedAt: "2026-10-08T08:00:00Z", jobs: [job] }] };
  sandbox.render(state);
  assert.match(sandbox.html, /等待自动重试/);
  assert.match(sandbox.html, /连续失败 1\/5/);
  assert.match(sandbox.html, /CUDA failed/);
  assert.doesNotMatch(sandbox.html, /确认需要停止后/);
  job.status = "pending"; delete job.automaticRetry.retryAt; delete job.error;
  sandbox.render(state); assert.match(sandbox.html, /自动重试排队/);
  job.status = "failed"; job.automaticRetry.failureCount = 5; job.automaticRetry.exhausted = true;
  sandbox.render(state); assert.match(sandbox.html, /连续失败 5\/5，自动重试已停止/);
  job.status = "completed";
  sandbox.render(state); assert.doesNotMatch(sandbox.html, /连续失败/);
});

test("queued code-proof rejection describes a blocked start rather than a failed training job", () => {
  const sandbox=clickSandbox();
  const job={index:2,case:"bus",seed:44,status:"queued",workerId:"nwpu2",gpuId:"0",commandId:"pending-command",
    error:"code-sync proof identity mismatch or stale runtime generation"};
  sandbox.render({distributedPlans:[{id:"run",planFile:"plans/current.yaml",jobs:[job]}]});
  assert.match(sandbox.html,/启动前代码校验阻塞/);
  assert.match(sandbox.html,/部署并重启该 Worker 的 Agent/);
  assert.doesNotMatch(sandbox.html,/这是已提交 job 的失败/);
});

test("retry scheduling and exhaustion redraw the Plan even when the failed status and error stay the same", () => {
  const sandbox = clickSandbox();
  const state = { distributedPlans: [{ id: "run", planFile: "plans/current.yaml", jobs: [{ index: 0, status: "failed", error: "CUDA" }] }] };
  const before = sandbox.executionRenderKeysForState(state).planList;
  const waiting = JSON.parse(JSON.stringify(state));
  waiting.distributedPlans[0].jobs[0].automaticRetry = { failureCount: 1, retryAt: "2026-10-08T08:01:00Z" };
  const scheduled = sandbox.executionRenderKeysForState(waiting).planList;
  assert.notEqual(scheduled, before);
  const exhausted = JSON.parse(JSON.stringify(waiting));
  exhausted.distributedPlans[0].jobs[0].automaticRetry = { failureCount: 5, exhausted: true };
  assert.notEqual(sandbox.executionRenderKeysForState(exhausted).planList, scheduled);
});

test("Plan overview keeps completed and failed Plans visible without routine validation rows", () => {
  let html = "";
  const sandbox = {
    Map,
    Set,
    operationRowsForState: () => [
      { planFile: "plans/done.yaml", status: "completed", updatedAt: "2026-09-20T10:00:00Z" },
      { planFile: "plans/old-fail.yaml", status: "failed", finishedAt: "2026-09-20T11:00:00Z" },
      { planFile: "plans/new-fail.yaml", status: "failed", finishedAt: "2026-09-25T12:10:00Z" },
      { planFile: "plans/live.yaml", status: "running", updatedAt: "2026-09-20T09:00:00Z" },
      { planFile: "plans/live.yaml", type: "validate-plan", status: "completed", updatedAt: "2026-09-20T08:00:00Z" },
    ],
    taskSectionViewModelForState: () => ({ allRows: [
      { planFile: "plans/done.yaml", status: "completed" },
      { planFile: "plans/live.yaml", status: "running" },
    ] }),
    taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}),
    normalizePlanSelectionKey: String,
    samePlanSelection: (left, right) => left === right,
    selectedExecutionPlanFile: "plans/live.yaml",
    collapsedExecutionPlanKeys: new Set(),
    persistWebviewState: () => undefined,
    taskStatusToken: String,
    TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]),
    TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: (value) => value === "running",
    operationIsFailureLike: (value) => value === "failed",
    operationHasDeadEvidence: () => false,
    taskFailureLikeStatus: (value) => value === "failed",
    planBaseName: (value) => value.split("/").pop(),
    esc: String,
    escAttr: String,
    loadingPrefix: () => "",
    detailsOpenAttr: () => "",
    statusClass: String,
    renderOperationItem: (row) => "<div>" + (row.type || "operation") + "</div>",
    renderTaskCards: () => "<div>tasks</div>",
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(executionPlanSource() + "\nthis.render = renderExecutionPlanList;", sandbox);
  sandbox.render({ sessionStartedAt: "2026-09-25T12:00:00Z" });
  assert.match(html, /old-fail.yaml/);
  assert.match(html, /new-fail.yaml/);
  assert.doesNotMatch(html, /历史 Plan|validate-plan/);
  assert.match(html, /详情与日志/);
  assert.match(html, /data-command="clearOperations" data-plan-file="plans\/live.yaml"/);
  assert.match(html, /data-execution-plan-select="plans\/live.yaml" aria-pressed="true"/);
});

test("persisted distributed jobs keep their Plan live after restart despite old failed operations", () => {
  let html = "";
  const sandbox = {
    Map, Set,
    operationRowsForState: () => [{ planFile: "plans/corim.yaml", status: "failed", finishedAt: "2026-09-24T11:00:00Z" }],
    taskSectionViewModelForState: () => ({ allRows: [] }),
    taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}),
    normalizePlanSelectionKey: String,
    samePlanSelection: (left, right) => left === right,
    selectedExecutionPlanFile: "plans/corim.yaml",
    collapsedExecutionPlanKeys: new Set(),
    persistWebviewState: () => undefined,
    taskStatusToken: String,
    TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]),
    TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: (value) => value === "running",
    operationIsFailureLike: (value) => value === "failed",
    operationHasDeadEvidence: () => false,
    taskFailureLikeStatus: (value) => value === "failed",
    planBaseName: (value) => value.split("/").pop(),
    esc: String, escAttr: String, loadingPrefix: () => "",
    detailsOpenAttr: () => "",
    statusClass: String,
    renderOperationItem: () => "<div>operation</div>",
    renderTaskCards: () => "<div>tasks</div>",
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(executionPlanSource() + "\nthis.render = renderExecutionPlanList;", sandbox);
  sandbox.render({ sessionStartedAt: "2026-09-25T12:00:00Z", distributedPlans: [{
    id: "distributed-1", planFile: "plans/corim.yaml", enqueuedAt: "2026-09-24T10:00:00Z",
    jobs: [
      { index: 0, case: "bus", seed: 42, status: "completed", workerId: "worker-a", gpuId: "0", commandId: "old-job" },
      { index: 1, case: "pad", seed: 42, status: "running", workerId: "worker-b", gpuId: "1", commandId: "live-job" },
    ],
  }] });
  assert.match(html, /executionPlanRow running/);
  assert.match(html, /成功 1\/2 · 50% · 运行 1/);
  assert.match(html, /pad seed 42/);
  assert.match(html, /worker-b · GPU 1/);
  assert.doesNotMatch(html, /历史 Plan/);
});

test("latest distributed attempt determines completed or failed Plan display", () => {
  let html = "";
  const sandbox = {
    Map, Set,
    operationRowsForState: () => [{ planFile: "plans/concatenation.yaml", type: "run-plan", status: "interrupted", startedAt: "2026-09-20T10:00:00Z" }],
    taskSectionViewModelForState: () => ({ allRows: [] }), taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}), normalizePlanSelectionKey: String,
    samePlanSelection: (left, right) => left === right,
    selectedExecutionPlanFile: "", collapsedExecutionPlanKeys: new Set(), persistWebviewState: () => undefined,
    taskStatusToken: String, TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]), TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: (value) => value === "running",
    operationIsFailureLike: (value) => value === "failed" || value === "interrupted",
    operationHasDeadEvidence: (row) => row.status === "interrupted",
    taskFailureLikeStatus: (value) => value === "failed", planBaseName: (value) => value.split("/").pop(),
    esc: String, escAttr: String, loadingPrefix: () => "", detailsOpenAttr: () => "", statusClass: String,
    renderOperationItem: () => "<div>old interruption</div>", renderTaskCards: () => "<div>tasks</div>",
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(executionPlanSource() + "\nthis.render = renderExecutionPlanList;", sandbox);
  const failed = { id: "older", planFile: "plans/concatenation.yaml", enqueuedAt: "2026-09-24T10:00:00Z",
    jobs: [{ index: 0, case: "bus", seed: 42, status: "failed", workerId: "nwpu5", commandId: "failed-job" }] };
  const completed = { id: "newer", planFile: "plans/concatenation.yaml", enqueuedAt: "2026-09-25T10:00:00Z",
    jobs: [{ index: 0, case: "bus", seed: 42, status: "completed", workerId: "nwpu2", commandId: "completed-job" }] };
  sandbox.render({ sessionStartedAt: "2026-09-25T12:00:00Z", distributedPlans: [failed, completed] });
  assert.match(html, /executionPlanRow completed/);
  assert.match(html, /成功 1\/1 · 100%/);
  assert.doesNotMatch(html, /failed-job|old interruption|>异常</);
  assert.match(html, /nwpu2/);
  assert.doesNotMatch(html, /nwpu5/);
  sandbox.render({ sessionStartedAt: "2026-09-25T12:00:00Z", distributedPlans: [completed, {
    ...failed, id: "newest", enqueuedAt: "2026-09-25T13:00:00Z",
    jobs: [{ ...failed.jobs[0], finishedAt: "2026-09-25T13:10:00Z", artifactError: "missing dataset schema" }],
  }] });
  assert.match(html, /executionPlanRow failed/);
  assert.match(html, /成功 0\/1 · 0% · 失败 1/);
  assert.match(html, /missing dataset schema/);
  assert.doesNotMatch(html, /old interruption|>异常</);
});

test("clearing history hides terminal distributed Plans but keeps active jobs", () => {
  let html = "";
  const sandbox = {
    Map, Set,
    operationRowsForState: () => [],
    taskSectionViewModelForState: () => ({ allRows: [] }), taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}), normalizePlanSelectionKey: String,
    samePlanSelection: (left, right) => left === right,
    selectedExecutionPlanFile: "", collapsedExecutionPlanKeys: new Set(), persistWebviewState: () => undefined,
    taskStatusToken: String, TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]), TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: (value) => value === "running", operationIsFailureLike: () => false,
    operationHasDeadEvidence: () => false, taskFailureLikeStatus: () => false,
    planBaseName: (value) => value.split("/").pop(), esc: String, escAttr: String, loadingPrefix: () => "",
    detailsOpenAttr: () => "", statusClass: String,
    renderOperationItem: () => "", renderTaskCards: () => "", setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract("executionHistoryRowVisible", "operationRowsForInput")
    + executionPlanSource()
    + "\nthis.render = renderExecutionPlanList;", sandbox);
  const old = { id: "old", planFile: "plans/old.yaml", enqueuedAt: "2026-09-20T10:00:00Z",
    jobs: [{ status: "failed", case: "a", seed: 1 }] };
  const active = { id: "active", planFile: "plans/active.yaml", enqueuedAt: "2026-09-20T10:00:00Z",
    jobs: [{ status: "running", case: "b", seed: 1 }] };
  const recent = { id: "recent", planFile: "plans/recent.yaml", enqueuedAt: "2026-09-25T12:00:00Z",
    jobs: [{ status: "completed", case: "c", seed: 1 }] };
  sandbox.render({ executionHistoryCutoffs: { all: "2026-09-25T10:00:00Z" }, distributedPlans: [old, active, recent] });
  assert.doesNotMatch(html, /old.yaml/);
  assert.match(html, /active.yaml|recent.yaml/);
});

test("diagnostics default to current server health and actionable issues", () => {
  let html = "";
  const sandbox = {
    Set,
    asArray: (value) => Array.isArray(value) ? value : [],
    workerName: String,
    compactText: String,
    esc: String,
    escAttr: String,
    loadingPrefix: () => "",
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract("renderDiagnosticOverview", "renderDiagnosticDetailsJson") + "\nthis.render = renderDiagnosticOverview;", sandbox);
  sandbox.render({ setup: { workerTunnels: [{ id: "nwpu3", enabled: true }] }, workerProbes: { nwpu3: { status: "ok" } }, actionErrors: [] });
  assert.match(html, /nwpu3/);
  assert.match(html, /当前无待处理的连接或端口问题/);
  sandbox.render({ setup: { workerTunnels: [{ id: "nwpu3", enabled: true }] }, workerProbes: { nwpu3: { status: "timeout", message: "连接超时" } }, actionErrors: [] });
  assert.match(html, /连接超时/);
  assert.doesNotMatch(html, /当前无待处理的连接或端口问题/);
});

test("history clearing hides old terminal rows only in the selected Plan", () => {
  const sandbox = { normalizePlanSelectionKey: (value) => String(value || "").replaceAll("\\", "/") };
  vm.createContext(sandbox);
  vm.runInContext(extract("executionHistoryRowVisible", "operationRowsForInput") + "\nthis.visible = executionHistoryRowVisible;", sandbox);
  const state = { executionHistoryCutoffs: { "plans/a.yaml": "2026-09-21T10:00:00Z" } };
  const old = { updatedAt: "2026-09-20T10:00:00Z" };
  const newer = { updatedAt: "2026-09-21T10:01:00Z" };
  assert.equal(sandbox.visible(state, old, "plans/a.yaml", false), false);
  assert.equal(sandbox.visible(state, old, "plans/b.yaml", false), true);
  assert.equal(sandbox.visible(state, old, "plans/a.yaml", true), true);
  assert.equal(sandbox.visible(state, { ...old, status: "running", reconcileEvidenceActive: false }, "plans/a.yaml", false), false);
  assert.equal(sandbox.visible(state, newer, "plans/a.yaml", false), true);
});

function clickSandbox(extra) {
  const persisted = [];
  const sandbox = {
    Map, Set,
    operationRowsForState: () => [],
    taskSectionViewModelForState: () => ({ allRows: [], taskView: { selectedRows: [] } }),
    taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}),
    normalizePlanSelectionKey: (value) => String(value || ""),
    samePlanSelection: (left, right) => left === right,
    stableSectionSignature: (value) => JSON.stringify(value),
    asArray: (value) => Array.isArray(value) ? value : [],
    compactTaskRowsForRenderStructureSignature: (rows) => rows,
    distributedPlanRecoveryView: (plan) => plan.recovery || {},
    compactCapabilitiesForSignature: (value) => value,
    compactOperationRowsForSignature: (rows) => rows,
    normalizeFileTransferRows: (rows) => rows,
    taskActionKey: (row) => String(row.uiKey || ""),
    taskArchiveActionKey: (row) => String(row.uiKey || ""),
    operationStatusFilter: "all",
    selectedOperationHistoryIds: new Set(),
    expandedTaskLogs: new Set(),
    executionRenderKeysCacheState: null,
    executionRenderKeysCacheValue: undefined,
    executionRenderKeysCacheLocalSignature: "",
    lastExecutionPlanListKey: "",
    selectedExecutionPlanFile: "",
    collapsedExecutionPlanKeys: new Set(),
    persistWebviewState: (patch) => persisted.push(patch),
    taskStatusToken: String,
    TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued", "pending"]),
    TASK_TERMINAL_STATUSES: new Set(["completed", "failed"]),
    operationIsActive: (value) => value === "running",
    operationIsFailureLike: (value) => value === "failed",
    operationHasDeadEvidence: () => false,
    taskFailureLikeStatus: (value) => value === "failed",
    planBaseName: (value) => String(value || "").split("/").pop(),
    esc: String, escAttr: String, loadingPrefix: () => "", detailsOpenAttr: () => "", statusClass: String,
    renderOperationItem: () => "<div>operation</div>",
    renderTaskCards: () => "<div>tasks</div>",
    setHtmlIfChanged: (_id, value) => { sandbox.html = value; },
    html: "",
    persisted,
  };
  Object.assign(sandbox, extra || {});
  vm.createContext(sandbox);
  const clickStart = panel.indexOf('const executionPlanFold = event.target.closest("button[data-execution-plan-fold]")');
  const clickEnd = panel.indexOf('const tracePlanScopeTarget = event.target.closest', clickStart);
  assert.ok(clickStart > 0 && clickEnd > clickStart);
  vm.runInContext("var lastState = {};\n" + executionPlanSource()
    + "\nthis.render = function (state) { lastState = state; return renderExecutionPlanList(state); };\nthis.foldClick = function (event) {\n"
    + panel.slice(clickStart, clickEnd).replaceAll("\\\\", "\\")
    + "\n};", sandbox);
  return sandbox;
}

test("queue-only deferred Plan, current success counts, and manual fold survive redraw", () => {
  const sandbox = clickSandbox();
  const state = {
    sessionStartedAt: "2026-09-25T12:00:00Z",
    deferredPlans: [{ id: "wait-1", planFile: "plans/queued.yaml", status: "pending", reason: "等待当前代码版本" }],
    distributedPlans: [
      { id: "old-run", planFile: "plans/live.yaml", enqueuedAt: "2026-09-24T10:00:00Z", jobs: [
        { index: 0, case: "old", seed: 1, status: "completed", commandId: "history-ok" },
        { index: 1, case: "old", seed: 2, status: "failed", commandId: "history-fail" },
      ] },
      { id: "current-run", planFile: "plans/live.yaml", enqueuedAt: "2026-09-25T11:00:00Z", jobs: [
        { index: 0, case: "bus", seed: 7, status: "completed", commandId: "current-ok" },
        { index: 1, case: "pad", seed: 7, status: "failed", commandId: "current-fail", artifactError: "missing metric" },
        { index: 2, case: "edge", seed: 7, status: "running", commandId: "current-run" },
      ] },
    ],
  };
  sandbox.render(state);
  assert.match(sandbox.html, /queued.yaml/);
  assert.match(sandbox.html, /executionPlanRow queued/);
  assert.match(sandbox.html, />排队</);
  assert.match(sandbox.html, /排队 · 待调度/);
  assert.match(sandbox.html, /成功 1\/3 · 33% · 运行 1 · 失败 1/);
  assert.match(sandbox.html, /pad seed 7/);
  assert.match(sandbox.html, /missing metric/);
  assert.doesNotMatch(sandbox.html, /history-ok|history-fail/);
  assert.doesNotMatch(sandbox.html, /<details[^>]*open/);
  const fold = { dataset: { executionPlanFold: "plans/live.yaml" } };
  sandbox.foldClick({
    preventDefault() {}, stopPropagation() {},
    target: { closest: (selector) => selector.indexOf("data-execution-plan-fold") >= 0 ? fold : null },
  });
  assert.equal(JSON.stringify(sandbox.persisted.at(-1).collapsedExecutionPlanKeys), JSON.stringify(["plans/live.yaml"]));
  assert.match(sandbox.html, /已折叠 Plan 1/);
  assert.match(sandbox.html, /恢复监控/);
  assert.match(sandbox.html, /成功 1\/3/);
  assert.doesNotMatch(sandbox.html, /data-execution-plan-key="plans\/live.yaml"/);
  assert.match(sandbox.html, /queued.yaml/);
  sandbox.render(state);
  assert.match(sandbox.html, /已折叠 Plan 1/);
  assert.match(sandbox.html, /成功 1\/3/);
  const restored = clickSandbox({ collapsedExecutionPlanKeys: new Set(["plans/live.yaml"]) });
  restored.render(state);
  assert.match(restored.html, /已折叠 Plan 1/);
  assert.match(restored.html, /恢复监控/);
  assert.match(restored.html, /queued.yaml/);
  const cardHead = sandbox.html.slice(sandbox.html.indexOf("executionPlanCard"), sandbox.html.indexOf("详情与日志"));
  assert.match(cardHead, /折叠此 Plan/);
  assert.match(cardHead, /stopAndClearPlan/);
  assert.doesNotMatch(cardHead, /clearOperations|选中 Plan/);
  assert.match(sandbox.html, /data-command="stopAndClearPlan"/);
  assert.match(sandbox.html, /data-command="clearOperations"/);
});

test("server unknown never renders running, hosted readiness requires all confirmed jobs, cancellation remains cancellation", () => {
  const sandbox = clickSandbox();
  const plan = { id: "server-plan", planFile: "plans/authority.yaml", schedulingMode: "server_prequeue",
    enqueuedAt: "2026-09-29T12:00:00Z", planJobCount: 2, remoteAcceptedJobCount: 2,
    jobs: [{ index: 0, case: "bus", seed: 42, status: "completed", workerId: "nwpu3" },
      { index: 1, case: "pad", seed: 42, status: "unknown", workerId: "nwpu5" }] };
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, />待核实</); assert.match(sandbox.html, /尚未完整确认托管/);
  assert.doesNotMatch(sandbox.html, />运行中<|已托管，可关机/);
  plan.jobs[1].status = "queued";
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, /服务器排队/); assert.match(sandbox.html, /已托管，可关机/);
  plan.jobs.forEach((job) => { job.status = "cancelled"; });
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, />已中止</); assert.doesNotMatch(sandbox.html, />已完成</);
});

test("newer active preflight replaces an older completed run until the new run exists", () => {
  const preflight = [{ planFile: "plans/live.yaml", type: "validate-plan", status: "running", startedAt: "2026-09-25T12:00:00Z" }];
  const sandbox = clickSandbox({
    operationRowsForState: () => preflight,
    operationIsActive: (value) => value === "running" || value === "started",
  });
  const oldRun = { id: "old-run", planFile: "plans/live.yaml", enqueuedAt: "2026-09-25T10:00:00Z", jobs: [
    { index: 0, case: "bus", seed: 1, status: "completed" },
    { index: 1, case: "pad", seed: 1, status: "completed" },
  ] };
  sandbox.render({ distributedPlans: [oldRun] });
  assert.match(sandbox.html, /校验中 · 待生成 job/);
  assert.match(sandbox.html, />校验中</);
  assert.doesNotMatch(sandbox.html, /成功 2\/2|bus seed 1/);
  preflight[0] = { ...preflight[0], status: "completed" };
  sandbox.render({
    distributedPlans: [oldRun, { id: "new-run", planFile: "plans/live.yaml", enqueuedAt: "2026-09-25T12:05:00Z", jobs: [
      { index: 0, case: "edge", seed: 3, status: "pending" },
    ] }],
  });
  assert.match(sandbox.html, /成功 0\/1 · 0% · 排队 1/);
  assert.match(sandbox.html, /edge seed 3/);
  assert.doesNotMatch(sandbox.html, /bus seed 1|校验中/);
});

test("background attempt recovery and result operations never hide restored Plan jobs", () => {
  const plan = { id: "distributed-plan-1791608959184-9rrh9s",
    planFile: "experiments/plans/comparison_tuning/qmf.yaml", enqueuedAt: "2026-10-10T05:09:19.203Z",
    jobs: Array.from({ length: 18 }, (_, index) => ({ index, case: "qmf_pad_ufes_20_c00", seed: 42 + index,
      status: index < 15 ? "completed" : "running", workerId: "nwpu2", commandId: "job-" + index })) };
  const operation = { planFile: plan.planFile, status: "running", startedAt: "2026-10-10T09:35:16Z",
    payload: { workflowId: plan.id } };
  const sandbox = clickSandbox({ operationRowsForState: () => [operation] });
  for (const type of ["archive-worker-artifacts", "parse-results", "download-results", "recover-training-completion",
    "stop-worker-task", "refresh-state"]) {
    operation.type = type;
    // Repeated progress/restart snapshots must keep the real job list visible immediately.
    for (let refresh = 0; refresh < 3; refresh++) {
      operation.updatedAt = "2026-10-10T09:36:0" + refresh + "Z";
      sandbox.render({ distributedPlans: [plan] });
      assert.match(sandbox.html, /成功 15\/18 · 83% · 运行 3/, type);
      assert.match(sandbox.html, /qmf_pad_ufes_20_c00 seed 42/, type);
      assert.doesNotMatch(sandbox.html, /待生成 job|当前还没有新 job/, type);
    }
  }
});

test("restored execution identity and progress timestamps cannot masquerade as a new submission", () => {
  const plan = { id: "current-run", planFile: "plans/live.yaml", enqueuedAt: "2026-10-10T05:09:19Z",
    jobs: [{ index: 0, case: "live", seed: 42, status: "unknown" }] };
  const operation = { planFile: plan.planFile, type: "run-plan", status: "running",
    startedAt: "2026-10-10T09:35:16Z", payload: { workflowId: plan.id } };
  const sandbox = clickSandbox({ operationRowsForState: () => [operation] });
  const beforeIdentity = structuredClone(operation);
  delete operation.payload;
  const unboundKey = sandbox.executionRenderKeysForState({ distributedPlans: [plan] }).planList;
  operation.payload = beforeIdentity.payload;
  const boundKey = sandbox.executionRenderKeysForState({ distributedPlans: [plan] }).planList;
  assert.notEqual(boundKey, unboundKey, "late workflow evidence must redraw immediately without a job status change");
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, /live seed 42/);
  assert.match(sandbox.html, /待核实/);
  assert.doesNotMatch(sandbox.html, /待生成 job/);
  delete operation.payload;
  delete operation.startedAt;
  operation.updatedAt = "2026-10-10T09:35:16Z";
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, /live seed 42/, "missing submission time cannot displace known durable jobs");
  assert.doesNotMatch(sandbox.html, /待生成 job/);
  operation.createdAt = "2026-10-10T05:09:13Z";
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, /live seed 42/);
  assert.doesNotMatch(sandbox.html, /待生成 job/);
  operation.createdAt = "2026-10-10T10:00:00Z";
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, /提交中 · 待生成 job/, "a genuinely newer submission still has its own stage");
  assert.doesNotMatch(sandbox.html, /live seed 42/);
});

test("production operation projection and normalization retain submission identity before Plan rendering", () => {
  const ts = require("typescript");
  const projected = { exports: {} };
  vm.runInNewContext(ts.transpileModule(readSource("src/ui/OperationPayload.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, projected);
  const sandbox = clickSandbox({ resolveWorkerId: String, operationStatusFromType: () => "running",
    normalizeUnparseableDetails: () => [], outputContractMissingLabel: String, operationSearchText: () => "" });
  vm.runInContext(extract("operationPayload", "normalizeFileTransferRows") + extract("pick", "formatDuration")
    + extract("normalizeOperationRows", "normalizeUnparseableDetails")
    + "\noperationRowsForState = (state) => normalizeOperationRows(state.operations);", sandbox);
  const plan = { id: "current-run", planFile: "plans/live.yaml", enqueuedAt: "2026-10-10T05:09:19Z",
    jobs: [{ index: 0, case: "live", seed: 42, status: "running" }] };
  const row = { operationId: "operation", planFile: plan.planFile, type: "run-plan", status: "running",
    events: Array.from({ length: 100 }, (_, seq) => ({ seq, message: "large".repeat(5000) })),
    payload: { log: "tail".repeat(5000), workflowId: plan.id },
    startedAt: "2026-10-10T09:35:16Z", updatedAt: "2026-10-10T09:36:00Z" };
  const render = () => sandbox.render({ distributedPlans: [plan],
    operations: projected.exports.compactOperationsForWebview({ operation: { ...row } }) });
  render();
  assert.match(sandbox.html, /live seed 42/, "restored workflow survives large optional diagnostics");
  assert.doesNotMatch(sandbox.html, /待生成 job/);
  delete row.payload;
  row.type = "validate-plan";
  render();
  assert.match(sandbox.html, /校验中 · 待生成 job/, "a real new preflight retains its immutable start time");
  row.startedAt = "2026-10-10T05:09:13Z";
  render();
  assert.match(sandbox.html, /live seed 42/);
  assert.doesNotMatch(sandbox.html, /待生成 job/);
  row.startedAt = "2026-10-10T10:00:00Z";
  row.type = "run-plan";
  row.localSubmissionProgress = true;
  row.status = "queued";
  sandbox.operationIsActive = (status) => status === "running" || status === "queued";
  render();
  assert.match(sandbox.html, /等待继续提交 · 待生成 job/, "local submission metadata survives normalization");
});

test("deferred status stays distinct and is not hidden by an older distributed run", () => {
  const sandbox = clickSandbox();
  sandbox.render({
    distributedPlans: [{ id: "old", planFile: "plans/held.yaml", enqueuedAt: "2026-09-25T09:00:00Z", jobs: [{ status: "completed", case: "old", seed: 1 }] }],
    deferredPlans: [
      { id: "hold", planFile: "plans/held.yaml", status: "blocked", reason: "代码指纹不匹配" },
      { id: "work", planFile: "plans/work.yaml", status: "processing", error: "正在准备输出目录" },
      { id: "wait", planFile: "plans/wait.yaml", status: "pending", reason: "等待当前代码版本" },
      { id: "gone", planFile: "plans/gone.yaml", status: "superseded", reason: "已被新提交替代" },
    ],
  });
  assert.match(sandbox.html, /held\.yaml[\s\S]*阻塞 · 待调度/);
  const held = sandbox.html.slice(sandbox.html.indexOf('data-execution-plan-key="plans/held.yaml"'));
  const heldDetail = held.slice(held.indexOf("详情与日志"));
  assert.match(heldDetail, /代码指纹不匹配/);
  assert.doesNotMatch(held.slice(0, held.indexOf("详情与日志")), /代码指纹不匹配/);
  assert.doesNotMatch(sandbox.html, /old seed 1/);
  assert.match(sandbox.html, /work\.yaml[\s\S]*处理中 · 待生成 job/);
  assert.match(sandbox.html, /正在准备输出目录/);
  assert.match(sandbox.html, /wait\.yaml[\s\S]*排队 · 待调度/);
  assert.match(sandbox.html, /等待当前代码版本/);
  assert.doesNotMatch(sandbox.html, /gone\.yaml|已被新提交替代/);
  const heldHead = sandbox.html.slice(sandbox.html.indexOf("held.yaml"), sandbox.html.indexOf("详情与日志", sandbox.html.indexOf("held.yaml")));
  assert.doesNotMatch(heldHead, /代码指纹不匹配/);
});

test("plan cards follow submission order rather than running or failure priority", () => {
  const sandbox = clickSandbox();
  sandbox.render({
    distributedPlans: [
      { id: "done", planFile: "plans/done.yaml", enqueuedAt: "2026-09-25T12:00:00Z", jobs: [{ status: "completed", case: "a", seed: 1 }] },
      { id: "bad", planFile: "plans/bad.yaml", enqueuedAt: "2026-09-25T12:01:00Z", jobs: [{ status: "failed", case: "b", seed: 1 }] },
      { id: "hold", planFile: "plans/hold.yaml", enqueuedAt: "2026-09-25T12:02:00Z", jobs: [{ status: "pending", case: "c", seed: 1, blockReason: "代码指纹不匹配：旧代码" }] },
      { id: "wait", planFile: "plans/wait.yaml", enqueuedAt: "2026-09-25T12:03:00Z", jobs: [{ status: "pending", case: "d", seed: 1 }] },
      { id: "run", planFile: "plans/run.yaml", enqueuedAt: "2026-09-25T12:04:00Z", jobs: [{ status: "running", case: "e", seed: 1 }] },
    ],
  });
  const order = ["bad.yaml", "hold.yaml", "wait.yaml", "run.yaml"].map((name) => sandbox.html.indexOf(name));
  assert.deepEqual(order, order.slice().sort((left, right) => left - right));
  assert.ok(order.every((index) => index >= 0));
  assert.match(sandbox.html, /已完成 Plan 历史 1/);
  assert.ok(sandbox.html.indexOf("done.yaml") > order.at(-1), "completed history keeps its existing separate fold");
});

test("concurrent Plan cards stay fixed through twenty alternating progress snapshots", () => {
  const sandbox = clickSandbox();
  const first = { id: "first", planFile: "plans/a.yaml", enqueuedAt: "2026-10-07T10:00:00Z",
    jobs: [{ index: 0, case: "bus", seed: 42, status: "running" }] };
  const second = { id: "second", planFile: "plans/b.yaml", enqueuedAt: "2026-10-07T10:01:00Z",
    jobs: [{ index: 0, case: "pad", seed: 42, status: "running" }] };
  for (let index = 0; index < 20; index += 1) {
    const plans = [first, second].map((plan, slot) => ({ ...plan, jobs: plan.jobs.map((job) => ({ ...job,
      status: (index + slot) % 3 === 0 ? "queued" : "running",
      updatedAt: new Date(Date.parse("2026-10-07T10:02:00Z") + (index * 2 + ((index + slot) % 2)) * 500).toISOString(),
      epoch: index, loss: 1 / (index + 1), percent: index * 2,
    })) }));
    sandbox.selectedExecutionPlanFile = index % 2 ? first.planFile : second.planFile;
    sandbox.render({ distributedPlans: index % 2 ? plans.reverse() : plans });
    assert.ok(sandbox.html.indexOf('data-execution-plan-key="plans/a.yaml"')
      < sandbox.html.indexOf('data-execution-plan-key="plans/b.yaml"'), `snapshot ${index}`);
  }
});

test("card order uses the latest submission generation and deterministic path ties", () => {
  const sandbox = clickSandbox();
  const row = (id, planFile, enqueuedAt) => ({ id, planFile, enqueuedAt,
    jobs: [{ index: 0, case: "bus", seed: 42, status: "running" }] });
  const plans = [row("old-a", "plans/a.yaml", "2026-10-07T09:00:00Z"),
    row("b", "plans/b.yaml", "2026-10-07T10:00:00Z"), row("new-a", "plans/a.yaml", "2026-10-07T11:00:00Z")];
  sandbox.render({ distributedPlans: plans });
  assert.ok(sandbox.html.indexOf("b.yaml") < sandbox.html.indexOf("a.yaml"));
  for (const rows of [[row("z", "plans/z.yaml", ""), row("a", "plans/a.yaml", "")],
    [row("a", "plans/a.yaml", ""), row("z", "plans/z.yaml", "")]]) {
    sandbox.render({ distributedPlans: rows });
    assert.ok(sandbox.html.indexOf("a.yaml") < sandbox.html.indexOf("z.yaml"));
  }
});

test("manual fold survives an empty snapshot and webview restore", () => {
  const sandbox = clickSandbox({ collapsedExecutionPlanKeys: new Set(["plans/live.yaml"]) });
  sandbox.render({ distributedPlans: [], deferredPlans: [] });
  assert.doesNotMatch(sandbox.html, /已折叠 Plan/);
  assert.equal(sandbox.collapsedExecutionPlanKeys.has("plans/live.yaml"), true);
  assert.equal(sandbox.persisted.some((patch) => patch.collapsedExecutionPlanKeys), false);
  sandbox.render({
    distributedPlans: [{ id: "back", planFile: "plans/live.yaml", enqueuedAt: "2026-09-25T12:00:00Z", jobs: [{ status: "completed", case: "bus", seed: 1 }] }],
  });
  assert.match(sandbox.html, /已折叠 Plan 1/);
  assert.match(sandbox.html, /恢复监控/);
  assert.doesNotMatch(sandbox.html, /data-execution-plan-key="plans\/live.yaml"/);
  const restored = clickSandbox({ collapsedExecutionPlanKeys: new Set(sandbox.collapsedExecutionPlanKeys) });
  restored.render({
    distributedPlans: [{ id: "back", planFile: "plans/live.yaml", enqueuedAt: "2026-09-25T12:00:00Z", jobs: [{ status: "completed", case: "bus", seed: 1 }] }],
  });
  assert.match(restored.html, /已折叠 Plan 1/);
  assert.match(restored.html, /成功 1\/1/);
});

test("exact operation cleanup hides only terminal records", () => {
  const rows = [
    { operationId: "old-run", status: "failed", planFile: "plans/corim.yaml" },
    { operationId: "live-run", status: "running", planFile: "plans/corim.yaml" },
  ];
  const sandbox = {
    Set, Array,
    executionHistoryRowsCacheState: null, executionHistoryRowsCacheValue: [],
    operationRowsForInput: () => rows,
    operationIsActive: (value) => value === "running",
    executionHistoryRowVisible: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(extract("operationRowsForState", "executionHistoryRowVisible") + "\nthis.visibleRows = operationRowsForState;", sandbox);
  const visible = sandbox.visibleRows({ executionHistoryHiddenOperationIds: ["old-run", "live-run"] });
  assert.deepEqual(Array.from(visible, (row) => row.operationId), ["live-run"]);
});

test("completed history displays run-scoped global artifact verification without expanding details", () => {
  const sandbox = clickSandbox();
  const completed = { id: "latest-run", planFile: "plans/ebmc.yaml", enqueuedAt: "2026-10-07T12:00:00Z",
    jobs: [{ index: 0, case: "bus", seed: 42, status: "completed" }] };
  for (const [status, label] of [["checking", "正在核验全局同步"], ["synced", "已全局同步最新产物"],
    ["partial", "尚未全局同步"], ["unknown", "全局同步待核验"]]) {
    sandbox.render({ distributedPlans: [completed], planArtifactSyncStatuses: {
      "latest-run": { runId: "latest-run", status, targetCount: 3, syncedCount: status === "synced" ? 3 : 1, detail: "包含权重" },
    } });
    assert.match(sandbox.html, /已完成 Plan 历史 1/);
    assert.ok(sandbox.html.includes(label));
    assert.ok(sandbox.html.indexOf(label) < sandbox.html.indexOf("详情与日志"));
  }
  sandbox.render({ distributedPlans: [completed], planArtifactSyncStatuses: {
    "latest-run": { runId: "old-run", status: "synced", targetCount: 3, syncedCount: 3 },
  } });
  assert.doesNotMatch(sandbox.html, /已全局同步最新产物/);
  assert.match(sandbox.html, /全局同步待核验/);
});
