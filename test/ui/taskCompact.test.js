const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panelSource = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panelSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panelSource.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panelSource.length; index += 1) {
    if (panelSource[index] === "{") depth += 1;
    if (panelSource[index] === "}") depth -= 1;
    if (depth === 0) return panelSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test("task section drops progress cards and dense meta grid", () => {
  assert.doesNotMatch(panelSource, /setHtmlIfChanged\("taskProgressCards", active\.length/);
  assert.doesNotMatch(panelSource, /勾选任务后可批量停止、重试、解析、归档或删除/);
  assert.doesNotMatch(panelSource, /已隐藏 ' \+ hiddenLegacyTaskUiKeys\.size \+ ' 条旧任务残留/);
  assert.doesNotMatch(panelSource, /taskMetaGrid/);
  assert.doesNotMatch(panelSource, /taskProgressCards/);
  assert.match(panelSource, /titleBits/);
});

test("task workbench derives counts selections and render priority in one view model", () => {
  const sandbox = {
    TASK_RENDER_LIMIT: 80,
    TASK_LIVE_STATUS_TOKENS: new Set(["running", "testing"]),
    TASK_QUEUED_STATUSES: new Set(["queued", "pending"]),
    taskStatusToken: (status) => String(status || ""),
    taskFailureLikeStatus: (status) => ["failed", "error", "stalled", "stopped", "cancelled", "canceled"].includes(String(status || "")),
    isTaskRowSelected: (row, selected) => selected.has(row.uiKey),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("taskRowsViewModel")}\nthis.model = taskRowsViewModel;`, sandbox);
  const rows = Array.from({ length: 90 }, (_, index) => ({ uiKey: `done-${index}`, status: "completed" }))
    .concat([{ uiKey: "running", status: "running" }, { uiKey: "failed", status: "failed" }])
    .concat(Array.from({ length: 7 }, (_, index) => ({ uiKey: `queued-${index}`, status: "queued" })))
    .concat([{ uiKey: "selected", status: "completed" }]);
  const model = sandbox.model(rows, new Set(["selected"]));

  assert.equal(model.visibleRows.length, 80);
  assert.deepEqual(Array.from(model.visibleRows.slice(0, 3), (row) => row.uiKey), ["selected", "running", "failed"]);
  assert.deepEqual(Array.from(model.selectedRows, (row) => row.uiKey), ["selected"]);
  assert.deepEqual(Array.from(model.activeRows, (row) => row.uiKey), ["running"]);
  assert.equal(model.detailRow, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(model.counts)), { queued: 7, running: 1, testing: 0, completed: 91, failed: 1, stopped: 0 });
  assert.doesNotMatch(extractFunction("taskRowsViewModel"), /allRows\.filter\(/);
  assert.match(extractFunction("taskSectionViewModelForState"), /taskRowsViewModel\(allRows, selected\)/);
});

test("task rendering reuses fixed live queued and active status sets", () => {
  assert.match(panelSource, /const TASK_LIVE_STATUS_TOKENS = new Set\(\["running", "testing"\]\)/);
  assert.match(panelSource, /const TASK_QUEUED_STATUSES = new Set\(\["queued", "pending"\]\)/);
  assert.match(panelSource, /const TASK_ACTIVE_STATUSES = new Set\(\[\.\.\.TASK_LIVE_STATUS_TOKENS, \.\.\.TASK_QUEUED_STATUSES\]\)/);
  assert.doesNotMatch(panelSource, /\["running", "testing"\]\.includes/);
  assert.doesNotMatch(panelSource, /\["queued", "pending"\]\.includes/);
  assert.match(extractFunction("schedulerSourceRowNeedsAttention"), /TASK_ACTIVE_STATUSES\??\.has\(status\)/);
});

test("task views reuse cached selection sets and invalidate on changed sources", () => {
  const helper = extractFunction("taskSelectionSetsForState");
  const sandbox = {
    EMPTY_TASK_SELECTION_VALUES: [],
    taskSelectionSetsCacheSources: null,
    taskSelectionSetsCacheValue: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${helper}\nthis.selectionSets = taskSelectionSetsForState;`, sandbox);
  const firstState = { selection: { selectedTaskUiKeys: ["task-1"], selectedRunKeys: ["run-1"] } };
  const first = sandbox.selectionSets(firstState);
  assert.equal(sandbox.selectionSets(firstState), first);
  assert.equal(first.uiKeys.has("task-1"), true);
  assert.equal(first.operationKeys.has("run-1"), true);

  const second = sandbox.selectionSets({ selection: { selectedTaskUiKeys: ["task-2"], selectedRunKeys: ["run-2"] } });
  assert.notEqual(second, first);
  assert.equal(second.uiKeys.has("task-2"), true);
  assert.equal(second.operationKeys.has("run-1"), false);

  for (const name of ["pruneExpandedTaskLogs", "taskSectionViewModelForState", "selectedTaskRowsFromState"]) {
    assert.match(extractFunction(name), /taskSelectionSetsForState\((?:state|data)\)/, name);
  }
  assert.doesNotMatch(extractFunction("isTaskRowSelected"), /new Set\(/);
});

test("task key derivations reuse row cache and preserve operation key order", () => {
  const sandbox = { taskKeyDerivationCache: new WeakMap() };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("firstText"),
    extractFunction("arrayText"),
    extractFunction("firstPathLike"),
    extractFunction("usableTaskKey"),
    extractFunction("taskKeyDerivations"),
    extractFunction("taskTargetKey"),
    extractFunction("taskActionKey"),
    extractFunction("taskArchiveActionKey"),
    extractFunction("taskLogActionKey"),
    extractFunction("taskPlanFile"),
    extractFunction("taskSelectableKeys"),
    extractFunction("taskOperationKeys"),
    "this.api = { derive: taskKeyDerivations, target: taskTargetKey, action: taskActionKey, archive: taskArchiveActionKey, log: taskLogActionKey, plan: taskPlanFile, selectable: taskSelectableKeys, operation: taskOperationKeys };",
  ].join("\n"), sandbox);

  const row = {
    runKey: "run-1",
    experimentId: "exp-1",
    archiveKey: "archive-1",
    actionArchiveKey: "artifacts/run-1",
    artifactPath: "artifacts/run-1",
    resultPath: "results/run-1.csv",
    logPath: "logs/run-1.log",
    planFile: "experiments/plans/demo.yaml",
  };
  const first = sandbox.api.derive(row);
  assert.strictEqual(sandbox.api.derive(row), first);
  assert.strictEqual(sandbox.api.selectable(row), first.selectableKeys);
  assert.strictEqual(sandbox.api.operation(row), first.operationKeys);
  assert.equal(sandbox.api.target(row), "run-1");
  assert.equal(sandbox.api.action(row), "run-1");
  assert.equal(sandbox.api.archive(row), "artifacts/run-1");
  assert.equal(sandbox.api.log(row), "logs/run-1.log");
  assert.equal(sandbox.api.plan(row), "experiments/plans/demo.yaml");
  assert.deepEqual([...first.operationKeys], ["run-1", "artifacts/run-1", "run-1", "exp-1", "archive-1", "artifacts/run-1", "artifacts/run-1"]);
  assert.deepEqual([...first.selectableKeys], ["run-1", ...first.operationKeys]);

  const replacement = { ...row, runKey: "run-2" };
  const replaced = sandbox.api.derive(replacement);
  assert.notStrictEqual(replaced, first);
  assert.equal(replaced.targetKey, "run-2");

  const fallback = sandbox.api.derive({
    status: "running",
    plan: "demo",
    experimentName: "case-a",
    serverId: "worker-1",
    gpuIds: ["0", "1"],
    startedAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:01:00Z",
    progress: "50%",
  });
  assert.equal(fallback.targetKey, "task|running|demo|case-a|worker-1|0, 1|2026-07-30T00:00:00Z|2026-07-30T00:01:00Z|50%");
  assert.equal(fallback.actionKey, "");
  assert.equal(fallback.logActionKey, fallback.targetKey);
  assert.deepEqual([...fallback.operationKeys], []);
  assert.deepEqual([...fallback.selectableKeys], [fallback.targetKey]);
});

test("task signature and render reuse one scope-independent view model", () => {
  let schedulerCalls = 0;
  const sandbox = {
    taskSectionViewCacheState: null,
    taskSectionViewCacheValue: null,
    taskSelectionSetsForState: () => ({ hiddenLegacyTaskUiKeys: new Set() }),
    schedulerRowsForState: () => {
      schedulerCalls += 1;
      return [{ uiKey: "task-1", planFile: "plan.yaml" }];
    },
    planFromContext: () => ({ revision: "r1" }),
    taskRowsViewModel: (rows) => ({ visibleRows: rows, selectedRows: [], activeRows: [], counts: {}, detailRow: rows[0] }),
    taskStatusToken: (status) => String(status || ""),
    TASK_LIVE_STATUS_TOKENS: new Set(["running", "testing"]),
    TASK_QUEUED_STATUSES: new Set(["queued", "pending"]),
    executionHistoryRowVisible: () => true,
    taskPlanFile: (row) => row.planFile || "",
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("taskSectionViewModelForState")}\nthis.viewForState = taskSectionViewModelForState;`, sandbox);
  const state = { planFileInput: "plan.yaml", selection: {} };
  const first = sandbox.viewForState(state);
  assert.equal(sandbox.viewForState(state), first);
  assert.equal(schedulerCalls, 1);

  assert.notEqual(sandbox.viewForState({ ...state }), first);
  assert.equal(schedulerCalls, 2);
  assert.match(extractFunction("compactSchedulerForSignature"), /taskSectionViewModelForState\(state\)/);
  assert.match(extractFunction("renderExecutionSection"), /renderTaskBatchActionsIfChanged\(state, force\)/);
  assert.doesNotMatch(extractFunction("sectionLocalSignature"), /taskPlanScope/);
});
