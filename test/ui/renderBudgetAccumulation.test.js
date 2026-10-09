const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function extractConst(name) {
  const start = panel.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing const ${name}`);
  const end = panel.indexOf(";", start);
  assert.ok(end > start, `unterminated const ${name}`);
  return panel.slice(start, end + 1);
}

const TASK_RENDER_LIMIT = 80;
const TRACE_RENDER_LIMIT = 60;

function loadTaskBudget() {
  const sandbox = {
    TASK_RENDER_LIMIT,
    taskStatusToken: (status) => String(status || "").toLowerCase(),
    taskFailureLikeStatus: (status) => ["failed", "error"].includes(String(status || "").toLowerCase()),
    isTaskRowSelected: (row, selected) => Boolean(selected && selected.has(String((row || {}).uiKey || ""))),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst("TASK_LIVE_STATUS_TOKENS"),
    extractConst("TASK_QUEUED_STATUSES"),
    extractFunction("taskRowsViewModel"),
    "this.viewModel = taskRowsViewModel;",
  ].join("\n"), sandbox);
  return sandbox.viewModel;
}

function loadTraceBudget() {
  const sandbox = {
    TRACE_RENDER_LIMIT,
    traceRowKey: (row) => String((row || {}).id || ""),
    traceRowSelected: (row, selected) => String((row || {}).id || "") === String(selected || ""),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("traceVisibleRows"),
    extractFunction("traceNeedsAttention"),
    "this.visibleRows = traceVisibleRows;",
  ].join("\n"), sandbox);
  return sandbox.visibleRows;
}

function loadInspectorActionBudget() {
  const constantsStart = panel.indexOf("const INSPECTOR_ACTION_PRIORITY_COMMON");
  const constantsEnd = panel.indexOf("const ACTION_RESOURCE_ANCHORS", constantsStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart, "missing inspector action priority constants");
  const sandbox = {
    INSPECTOR_ACTION_RENDER_LIMIT: 3,
    inspectorActionSection: (section) => section,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    panel.slice(constantsStart, constantsEnd),
    extractFunction("inspectorActionPriority"),
    extractFunction("budgetInspectorActions"),
    "this.api = { priority: inspectorActionPriority, budget: budgetInspectorActions };",
  ].join("\n"), sandbox);
  return sandbox.api;
}

test("task render budget stays bounded when every row is failure-like", () => {
  const viewModel = loadTaskBudget();
  const rows = Array.from({ length: 500 }, (unused, index) => ({ uiKey: "task-" + index, status: "failed" }));
  const model = viewModel(rows, new Set(["task-499"]));

  assert.equal(model.visibleRows.length, TASK_RENDER_LIMIT);
  assert.equal(model.rows.length, 500);
  assert.equal(model.counts.failed, 500);
  assert.equal(model.visibleRows[0].uiKey, "task-499");
  assert.equal(new Set(model.visibleRows.map((row) => row.uiKey)).size, TASK_RENDER_LIMIT);
});

test("task render budget keeps selected, critical and queued priority order", () => {
  const viewModel = loadTaskBudget();
  const rows = [
    ...Array.from({ length: 200 }, (unused, index) => ({ uiKey: "done-" + index, status: "completed" })),
    { uiKey: "queued-1", status: "queued" },
    { uiKey: "running-1", status: "running" },
    { uiKey: "picked-1", status: "completed" },
  ];
  const model = viewModel(rows, new Set(["picked-1"]));
  const keys = model.visibleRows.map((row) => row.uiKey);

  assert.equal(model.visibleRows.length, TASK_RENDER_LIMIT);
  assert.equal(keys[0], "picked-1");
  assert.equal(keys[1], "running-1");
  assert.equal(keys[2], "queued-1");
  assert.equal(model.selectedRows[0].uiKey, "picked-1");
});

test("trace render budget stays bounded when every row needs attention", () => {
  const visibleRows = loadTraceBudget();
  const rows = Array.from({ length: 400 }, (unused, index) => ({ id: "trace-" + index, status: "failed" }));
  const visible = visibleRows(rows, "trace-399");

  assert.equal(visible.length, TRACE_RENDER_LIMIT);
  assert.equal(visible[0].id, "trace-399");
  assert.equal(new Set(visible.map((row) => row.id)).size, TRACE_RENDER_LIMIT);
});

test("trace render budget prefers attention rows over filler rows", () => {
  const visibleRows = loadTraceBudget();
  const rows = [
    ...Array.from({ length: 300 }, (unused, index) => ({ id: "ok-" + index, status: "archived" })),
    { id: "bad-1", status: "failed" },
    { id: "bad-2", status: "residue" },
  ];
  const visible = visibleRows(rows, "");
  const keys = visible.map((row) => row.id);

  assert.equal(visible.length, TRACE_RENDER_LIMIT);
  assert.equal(keys[0], "bad-1");
  assert.equal(keys[1], "bad-2");
  assert.equal(keys[2], "ok-0");
});

test("small row sets are returned untouched by both budgets", () => {
  const viewModel = loadTaskBudget();
  const visibleRows = loadTraceBudget();
  const tasks = [{ uiKey: "task-1", status: "running" }, { uiKey: "task-2", status: "completed" }];
  const traces = [{ id: "trace-1", status: "archived" }];

  assert.equal(viewModel(tasks, new Set()).visibleRows, tasks);
  assert.equal(visibleRows(traces, ""), traces);
});

test("inspector action budget reuses section priority maps and preserves source order", () => {
  const api = loadInspectorActionBudget();
  const plansPriority = api.priority("plans");
  assert.equal(api.priority("plans"), plansPriority);
  assert.equal(api.priority("unknown"), api.priority("overview"));

  const actions = [
    ["其他", "later"],
    ["运行", "runPlan"],
    ["校验", "validatePlan"],
    ["预演", "dryRunPlan"],
    ["归档", "archivePlan"],
  ];
  assert.deepEqual(Array.from(api.budget(actions, "plans", {}).map((item) => item[1])), ["runPlan", "validatePlan", "dryRunPlan"]);
  assert.match(panel, /const INSPECTOR_ACTION_PRIORITIES = Object\.freeze\(\{/);
  assert.match(extractFunction("inspectorActionPriority"), /return INSPECTOR_ACTION_PRIORITIES\[section\] \|\| INSPECTOR_ACTION_PRIORITY_COMMON/);
  assert.doesNotMatch(extractFunction("inspectorActionPriority"), /new Map|\["prepareAgents"/);
});
