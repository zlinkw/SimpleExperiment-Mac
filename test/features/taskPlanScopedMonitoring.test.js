const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function taskStatusSets() {
  const TASK_STOPPED_STATUSES = new Set(["stopped", "cancelled"]);
  return {
    TASK_STOPPED_STATUSES,
    TASK_FAILURE_STATUSES: new Set([...TASK_STOPPED_STATUSES, "failed", "error", "stalled"]),
    TASK_TERMINAL_STATUSES: new Set(["completed", "done", "archived", "deleted"]),
    TASK_ARCHIVABLE_STATUSES: new Set(["completed", "done"]),
  };
}

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractFrozenObject(name) {
  const start = panel.indexOf(`const ${name} = Object.freeze({`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = panel.indexOf("});", start);
  assert.ok(end > start, `unterminated ${name}`);
  return panel.slice(start, end + 3);
}

function loadCompletion() {
  const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const sandbox = {
    ...taskStatusSets(),
    asArray: (value) => Array.isArray(value) ? value : [],
    samePlanSelection(left, right) {
      const a = normalize(left);
      const b = normalize(right);
      return Boolean(a && b && (a === b || a.split("/").pop() === b.split("/").pop()));
    },
    debugRunRecord(row) { return row && row.debugMode === true; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("taskStatusToken")}\n${extractFunction("taskFailureLikeStatus")}\n${extractFunction("taskTerminalStatus")}\n${extractFunction("taskPlanResultCount")}\n${extractFunction("taskPlanCompletionState")}\nthis.completion = taskPlanCompletionState;`, sandbox);
  return sandbox.completion;
}

function loadTaskStatus() {
  const sandbox = taskStatusSets();
  vm.createContext(sandbox);
  vm.runInContext([
    extractFrozenObject("TASK_STATUS_LABELS"),
    extractFunction("taskStatusToken"),
    extractFunction("taskStatusLabel"),
    extractFunction("taskFailureLikeStatus"),
    extractFunction("taskTerminalStatus"),
    extractFunction("taskArchivableStatus"),
    extractFunction("taskCardClass"),
    extractFunction("statusClass"),
    "this.api = { taskStatusToken, taskStatusLabel, taskFailureLikeStatus, taskTerminalStatus, taskArchivableStatus, taskCardClass, statusClass };",
  ].join("\n"), sandbox);
  return sandbox.api;
}

function loadFailureLogTarget() {
  const sandbox = {
    asArray: (value) => Array.isArray(value) ? value : [],
    taskFailureLikeStatus: (status) => ["failed", "error", "stalled", "stopped", "cancelled", "canceled"].includes(String(status || "")),
    taskLogActionKey: (row) => String((row || {}).logKey || ""),
    resolveWorkerId: (value) => value ? "worker:" + value : "",
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("taskFailureLogTarget")}
this.target = taskFailureLogTarget;`, sandbox);
  return (scope) => {
    const result = sandbox.target(scope);
    return result ? JSON.parse(JSON.stringify(result)) : undefined;
  };
}

function loadDebugLogTarget() {
  const sandbox = {
    asArray: (value) => Array.isArray(value) ? value : [],
    debugRunRecord: (row) => row && row.debugMode === true,
    taskLogActionKey: (row) => String((row || {}).logKey || ""),
    resolveWorkerId: (value) => value ? "worker:" + value : "",
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("taskDebugLogTarget")}
this.target = taskDebugLogTarget;`, sandbox);
  return (scope) => {
    const result = sandbox.target(scope);
    return result ? JSON.parse(JSON.stringify(result)) : undefined;
  };
}

test("Plan monitoring groups all visible scheduler tasks and preserves trace scope and actions", () => {
  assert.doesNotMatch(panel, /taskPlanScope|data-task-plan-scope|renderTaskSection|taskDetailPane|id="taskTable"/);
  assert.match(panel, /taskSectionViewModelForState\(state\)\.allRows\.forEach/);
  assert.match(panel, /handleTaskSelectionChange\(input\)/);
  assert.match(panel, /data-trace-plan-scope/);
  assert.match(panel, /persistWebviewState\(\{ tracePlanScope \}\)/);
  for (const command of ["stopExperiment", "retryExperiment", "reassignWorkerTask", "parseResults", "selectLogRunKey"]) {
    assert.ok(extractFunction("renderTaskCard").includes(command));
  }
});

test("task model retains other Plans and revisions while filtering hidden and excluded history", () => {
  const rows = [{ uiKey: "current", plan: "a", planRevision: "r2" }, { uiKey: "old", plan: "a", planRevision: "r1" }, { uiKey: "other", plan: "b" }, { uiKey: "hidden" }, { uiKey: "excluded" }];
  const selected = { hiddenLegacyTaskUiKeys: new Set(["hidden"]) };
  const sandbox = {
    taskSectionViewCacheState: null, taskSectionViewCacheValue: null,
    taskSelectionSetsForState: () => selected, schedulerRowsForState: () => rows,
    taskStatusToken: String, TASK_LIVE_STATUS_TOKENS: new Set(), TASK_QUEUED_STATUSES: new Set(),
    executionHistoryRowVisible: (_state, row) => row.uiKey !== "excluded", taskPlanFile: row => row.plan,
    taskRowsViewModel: rows => ({ selectedRows: [rows[0]] })
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction("taskSectionViewModelForState") + ";this.view = taskSectionViewModelForState;", sandbox);
  const result = sandbox.view({ planFileInput: "a" });
  assert.deepEqual(Array.from(result.allRows, row => row.uiKey), ["current", "old", "other"]);
  assert.equal(result.selected, selected);
  assert.equal(result.taskView.selectedRows[0].uiKey, "current");
});

test("a Plan with more than twenty tasks exposes remaining tasks inside its own details", () => {
  const batches = [];
  const sandbox = {
    escAttr: String, detailsOpenAttr: () => "",
    renderTaskCards: (_state, rows) => { batches.push(rows); return rows.map(row => '<div class="task-card">' + row.uiKey + '</div>').join(""); }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction("renderPlanTaskCards") + ";this.render = renderPlanTaskCards;", sandbox);
  const rows = Array.from({ length: 25 }, (_, i) => ({ uiKey: "task-" + (i + 1) }));
  const html = sandbox.render({}, rows, {}, "plan-a");
  assert.deepEqual(batches.map(rows => rows.length), [20, 5]);
  assert.match(html, /<details class="executionPlanMoreTasks"[^>]*><summary>显示其余 5 个任务<\/summary>[\s\S]*task-25/);
  assert.doesNotMatch(html, /taskTable|taskDetailPane/);
  assert.match(extractFunction("renderExecutionPlanList"), /renderPlanTaskCards\(state, sortedTasks, selected, group\.key\)/);
  assert.doesNotMatch(sandbox.render({}, [], {}, "empty"), /task-card|details/);
});

test("current Plan terminal tasks lead to results or explicit failure recovery", () => {
  const completion = loadCompletion();
  const planFile = "experiments/plans/smoke.yaml";
  const scope = (rows) => ({ scoped: true, selectedPlanFile: planFile, rows });
  assert.equal(completion({}, scope([{ status: "running" }])), undefined);
  const waiting = JSON.parse(JSON.stringify(completion({}, scope([{ status: "completed" }]))));
  assert.equal(waiting.kind, "waiting");
  assert.match(waiting.message, /等待自动检查输出并解析结果/);
  const review = JSON.parse(JSON.stringify(completion({}, scope([{ status: "failed" }, { status: "completed" }]))));
  assert.equal(review.kind, "review");
  assert.match(review.message, /1 个失败、停止或取消/);
  for (const status of ["error", "stalled", "stopped", "cancelled", "canceled"]) {
    const variant = JSON.parse(JSON.stringify(completion({}, scope([{ status }]))));
    assert.equal(variant.kind, "review", `${status} must be terminal and recoverable`);
  }
  const results = JSON.parse(JSON.stringify(completion({ resultsSummary: { planFile, results: [{ planFile }, { provenance: { planFile } }] } }, scope([{ status: "completed" }]))));
  assert.equal(results.kind, "results");
  assert.match(results.message, /已解析 2 条结果/);
  assert.equal(completion({ resultsSummary: { planFile: "other.yaml", results: [{ planFile: "other.yaml" }] } }, scope([{ status: "completed" }])).kind, "waiting");
  const debugReview = JSON.parse(JSON.stringify(completion({ resultsSummary: { planFile, results: [{ planFile }] } }, scope([{ status: "completed", debugMode: true }]))));
  assert.equal(debugReview.kind, "results");
  const debugFailed = JSON.parse(JSON.stringify(completion({}, scope([{ status: "failed", debugMode: true }]))));
  assert.equal(debugFailed.kind, "review");
  assert.match(debugFailed.message, /失败、停止或取消/);
  const mixedFormal = JSON.parse(JSON.stringify(completion({}, scope([{ status: "completed", debugMode: true }, { status: "completed" }]))));
  assert.equal(mixedFormal.kind, "waiting");
  assert.match(panel, /data\.workerTelemetry, data\.resultsSummary/);
});

test("historical Debug completion has no special run action", () => {
  const target = loadDebugLogTarget();
  assert.deepEqual(target({ rows: [{ status: "completed", debugMode: true, logKey: "debug/run", serverId: "worker-a" }] }), {
    runKey: "debug/run",
    workerId: "worker:worker-a",
  });
  assert.deepEqual(target({ rows: [{ status: "completed", debugMode: true }] }), { manualReview: true });
  assert.equal(target({ rows: [{ status: "completed" }] }), undefined);
  const source = extractFunction("renderTaskPlanCompletionNext");
  assert.doesNotMatch(source, /打开 Debug 日志|data-debug-mode="false" data-force-formal="true"|outcome.kind === "debug-review"/);
});

test("failed current-Plan tasks expose a direct log target without auto retry", () => {
  const target = loadFailureLogTarget();
  assert.deepEqual(target({ rows: [{ status: "completed" }, { status: "failed", logKey: "run/failure", serverId: "worker-a" }] }), {
    runKey: "run/failure",
    workerId: "worker:worker-a",
  });
  assert.deepEqual(target({ rows: [{ status: "failed" }, { status: "stopped", logKey: "run/stopped", serverId: "worker-b" }] }), {
    runKey: "run/stopped",
    workerId: "worker:worker-b",
  });
  assert.deepEqual(target({ rows: [{ status: "cancelled" }] }), { manualReview: true });
  assert.equal(target({ rows: [{ status: "completed" }] }), undefined);
  const recoverySource = extractFunction("renderTaskPlanCompletionNext");
  assert.match(recoverySource, /打开失败日志/);
  assert.match(recoverySource, /任务缺少可定位日志标识，请从任务卡检查 Worker、runKey 和日志路径/);
  assert.doesNotMatch(recoverySource, /retryExperiment/);
});

test("automatic retry display distinguishes code stops and resource requeue", () => {
  const sandbox={};vm.createContext(sandbox);
  vm.runInContext(extractFunction("automaticJobRetryView")+";this.view=automaticJobRetryView;",sandbox);
  for(const [failureClass,label] of [['deterministic','代码错误，停止重试'],['unknown','需人工核查']]){
    const result=sandbox.view({status:'failed',automaticRetry:{failureCount:1,failureClass,blockedReason:'检查日志后手动处理',retryAt:'2026-10-09T00:00:00Z'}});
    assert.equal(result.label,label);assert.match(result.note,/检查日志后手动处理/);assert.doesNotMatch(result.note,/重新排队/);
  }
  assert.equal(sandbox.view({status:'failed',automaticRetry:{failureCount:1,retryAt:'2026-10-09T00:00:00Z'}}).label,'等待自动重试');
  assert.equal(sandbox.view({status:'failed',automaticRetry:{failureCount:1,failureClass:'resource',retryAt:'2026-10-09T00:00:00Z'}}).label,'资源不足，等待重试');
  assert.equal(sandbox.view({status:'pending',automaticRetry:{failureCount:1,failureClass:'resource'}}).label,'资源不足，重新排队');
});

test("task UI treats all scheduler failure terminals as visible retryable failures", () => {
  const status = loadTaskStatus();
  assert.match(panel, /const TASK_STOPPED_STATUSES = new Set\(\["stopped", "cancelled"\]\)/);
  assert.match(panel, /const TASK_FAILURE_STATUSES = new Set\(\[\.\.\.TASK_STOPPED_STATUSES, "failed", "error", "stalled"\]\)/);
  assert.match(panel, /const TASK_TERMINAL_STATUSES = new Set\(\["completed", "done", "archived", "deleted"\]\)/);
  assert.match(panel, /const TASK_ARCHIVABLE_STATUSES = new Set\(\["completed", "done"\]\)/);
  assert.match(panel, /TASK_FAILURE_STATUSES\??\.has\(taskStatusToken\(status\)\)/);
  assert.match(panel, /TASK_TERMINAL_STATUSES\??\.has\(value\)/);
  assert.match(panel, /TASK_ARCHIVABLE_STATUSES\??\.has\(value\)/);
  assert.match(extractFunction("taskCardClass"), /TASK_STOPPED_STATUSES\??\.has\(value\)/);
  assert.match(extractFunction("taskCardClass"), /TASK_FAILURE_STATUSES\??\.has\(value\)/);
  assert.equal(status.taskStatusLabel("queued"), "排队中");
  assert.equal(status.taskStatusLabel("normal_completed"), "已完成");
  assert.equal(status.taskStatusLabel("manual_interrupted_completed"), "已停止");
  assert.equal(status.taskStatusLabel("failed"), "失败");
  assert.equal(status.taskStatusLabel("unknown_custom_status"), "unknown_custom_status");
  assert.equal(status.taskStatusToken("canceled"), "cancelled");
  for (const value of ["failed", "error", "stalled", "stopped", "cancelled", "canceled", "manual_interrupted_completed"]) {
    assert.equal(status.taskFailureLikeStatus(value), true, value);
    assert.equal(status.taskTerminalStatus(value), true, value);
    assert.equal(status.taskArchivableStatus(value), true, value);
    assert.equal(status.statusClass(value), "status-failed", value);
  }
  assert.equal(status.taskStatusToken("normal_completed"), "completed");
  assert.equal(status.taskTerminalStatus("normal_completed"), true);
  assert.equal(status.taskCardClass("cancelled"), "is-stopped");
  assert.equal(status.taskCardClass("canceled"), "is-stopped");
  assert.equal(status.taskCardClass("stalled"), "is-failed");
  assert.match(extractFunction("renderTaskCard"), /\["重试", "retryExperiment", taskFailureLikeStatus\(row\.status\), true\]/);
  assert.doesNotMatch(panel, /\["归档", "archiveArtifacts", taskArchivableStatus\(row\.status\), true\]/);
  assert.doesNotMatch(panel, /\["删除", "deleteArtifacts", true, false, true\]/);
  assert.match(panel, /function taskStatusLabel\(status\)/);
  assert.match(panel, /const TASK_STATUS_LABELS = Object\.freeze\(\{/);
  assert.match(extractFunction("taskStatusLabel"), /TASK_STATUS_LABELS\[taskStatusToken\(raw\)\] \|\| raw/);
  assert.doesNotMatch(extractFunction("taskStatusLabel"), /const labels =/);
  assert.match(panel, /原始状态：/);
});

test("scheduler signature refreshes Plan tasks beyond the old global render budget", () => {
  const sandbox = {
    TASK_RENDER_LIMIT: 80,
    taskSectionViewModelForState: state => ({ selected: { hiddenLegacyTaskUiKeys: new Set() }, allRows: state.rows, taskView: { counts: {}, selectedRows: [], visibleRows: state.rows.slice(0, 80), activeRows: [] } }),
    compactRowsForSignature: (rows, limit, keys) => rows.slice(0, limit).map(row => Object.fromEntries(keys.map(key => [key, row[key]])))
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction("compactTaskRowsForSignature") + "\n" + extractFunction("compactSchedulerForSignature") + ";this.signature = compactSchedulerForSignature;", sandbox);
  const rows = Array.from({ length: 90 }, (_, i) => ({ uiKey: "task-" + i, status: "running" }));
  const before = JSON.stringify(sandbox.signature({ rows }));
  rows[89] = { ...rows[89], status: "failed", finalLog: "failure evidence" };
  assert.notEqual(JSON.stringify(sandbox.signature({ rows })), before);
});
