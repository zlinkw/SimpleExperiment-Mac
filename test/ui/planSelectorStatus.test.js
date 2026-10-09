const assert = require("node:assert/strict");
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

function selectorSandbox(stateForSummary) {
  const planSource = panel.slice(panel.indexOf("function planFileOf("), panel.indexOf("function renderPlanSection("));
  assert.ok(planSource.startsWith("function planFileOf("));
  const elements = {
    planFileInput: { value: "", innerHTML: "" },
    planSelectorQuery: { value: "" },
    planSelectorStatusFilter: { value: "all" },
    planSelectorSortOrder: { value: "scan" },
    planSelectorStatus: { className: "", innerHTML: "" },
  };
  const readCounts = { tasks: 0, operations: 0 };
  const sandbox = {
    el: (id) => elements[id],
    normalizePlanSelectionKey: (value) => String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, ""),
    samePlanSelection: (left, right) => String(left || "").replaceAll("\\", "/") === String(right || "").replaceAll("\\", "/"),
    planFromContext: (state, context) => (state.plans || []).find((plan) => plan.file === context.planFile) || {},
    planVersionTaskRows: (state, file, revision) => (state.tasks || []).filter((task) => task.planFile === file && task.planRevision === revision),
    planVersionOperationRows: (state, file, revision) => (state.operations || []).filter((row) => row.planFile === file && row.planRevision === revision),
    operationRowsForState: (state) => { readCounts.operations += 1; return state.operations || []; },
    schedulerRowsForState: (state) => { readCounts.tasks += 1; return state.tasks || []; },
    operationMatchesPlanVersion: (row, revision) => !row.planRevision || row.planRevision === revision,
    taskMatchesPlanVersion: (row, revision) => !row.planRevision || row.planRevision === revision,
    planFileEquivalenceKeys: (file) => [String(file || "").replaceAll("\\", "/")],
    asArray: (value) => Array.isArray(value) ? value : [],
    operationPending: (row) => ["accepted", "queued", "pending", "running"].includes(String((row || {}).status || "").toLowerCase()),
    operationAtOrAfter: (candidate, reference) => Number(candidate.seq || 0) >= Number(reference.seq || 0),
    operationSucceeded: (row) => ["completed", "done", "succeeded"].includes(String((row || {}).status || "").toLowerCase()),
    taskStatusToken: (status) => String(status || "").toLowerCase(),
    taskFailureLikeStatus: (status) => ["failed", "error", "stalled", "stopped", "cancelled"].includes(status),
    taskTerminalStatus: (status) => ["completed", "done", "archived", "failed", "error", "stalled", "stopped", "cancelled"].includes(status),
    operationIsFailureLike: (status) => ["failed", "error", "stalled", "interrupted"].includes(String(status || "").toLowerCase()),
    PLAN_ACTIVE_STATUSES: new Set(["accepted", "submitted", "queued", "pending", "running", "testing", "progress", "in_progress", "operation_started", "started"]),
    PLAN_RUN_OPERATION_TYPES: new Set(["run-plan", "reproduce-plan"]),
    naturalCompare: (left, right) => String(left || "").localeCompare(String(right || ""), undefined, { numeric: true }),
    esc: (value) => String(value || ""),
    escAttr: (value) => String(value || ""),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${planSource}\nthis.selector = { summary: planSelectorRunSummary, index: planSelectorStatusIndex, matches: planSelectorMatchesFilter, progress: planSelectorProgress, sort: planSelectorSortEntries, refresh: refreshPlanFileOptions };`, sandbox);
  sandbox.elements = elements;
  sandbox.readCounts = readCounts;
  sandbox.summaryState = stateForSummary;
  return sandbox;
}

test("selector derives task progress from the selected Plan revision only", () => {
  const sandbox = selectorSandbox();
  const state = {
    plans: [{ file: "plans/demo.yaml", revision: "rev2", updatedAt: "2026-09-01T00:00:00Z", jobCount: 3 }],
    tasks: [
      { planFile: "plans/demo.yaml", planRevision: "rev1", status: "completed" },
      { planFile: "plans/demo.yaml", planRevision: "rev2", status: "completed" },
      { planFile: "plans/demo.yaml", planRevision: "rev2", status: "running" },
    ],
  };
  const summary = sandbox.selector.summary(state, "plans/demo.yaml");
  assert.equal(summary.status, "running");
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.totalCount, 3);
  assert.equal(summary.revision, "rev2");

  const historicalOnly = {
    plans: state.plans,
    tasks: [{ planFile: "plans/demo.yaml", planRevision: "rev1", status: "completed" }],
    operations: [{ planFile: "plans/demo.yaml", planRevision: "rev1", type: "run-plan", status: "completed" }],
  };
  const current = sandbox.selector.summary(historicalOnly, "plans/demo.yaml");
  assert.equal(current.status, "not-started");
  assert.equal(current.completedCount, 0);
  assert.equal(current.totalCount, 3);
});

test("selector classifies partial and failed plans and orders by progress", () => {
  const sandbox = selectorSandbox();
  const state = {
    plans: [
      { file: "plans/partial.yaml", revision: "p1", jobCount: 4 },
      { file: "plans/failed.yaml", revision: "f1", jobCount: 2 },
    ],
    tasks: [
      { planFile: "plans/partial.yaml", planRevision: "p1", status: "completed" },
      { planFile: "plans/partial.yaml", planRevision: "p1", status: "queued" },
      { planFile: "plans/failed.yaml", planRevision: "f1", status: "failed" },
    ],
  };
  const partial = sandbox.selector.summary(state, "plans/partial.yaml");
  const failed = sandbox.selector.summary(state, "plans/failed.yaml");
  assert.equal(partial.status, "partial");
  assert.equal(partial.completedCount, 1);
  assert.equal(partial.totalCount, 4);
  assert.equal(failed.status, "failed");
  assert.equal(sandbox.selector.matches(partial, "remaining"), true);
  assert.equal(sandbox.selector.matches({ status: "completed" }, "remaining"), false);

  const rows = [
    { file: "plans/low.yaml", index: 0, summary: { completedCount: 1, totalCount: 5 } },
    { file: "plans/high.yaml", index: 1, summary: { completedCount: 4, totalCount: 5 } },
  ];
  assert.deepEqual(Array.from(sandbox.selector.sort(rows, "progress-desc"), (row) => row.file), ["plans/high.yaml", "plans/low.yaml"]);
  assert.deepEqual(Array.from(sandbox.selector.sort(rows, "progress-asc"), (row) => row.file), ["plans/low.yaml", "plans/high.yaml"]);
});

test("a finished submission does not mark missing configured jobs complete", () => {
  const sandbox = selectorSandbox();
  const state = {
    plans: [{ file: "plans/incomplete.yaml", revision: "v3", jobCount: 3 }],
    tasks: [
      { planFile: "plans/incomplete.yaml", planRevision: "v3", status: "completed" },
      { planFile: "plans/incomplete.yaml", planRevision: "v3", status: "completed" },
    ],
    operations: [{ planFile: "plans/incomplete.yaml", planRevision: "v3", type: "run-plan", status: "completed" }],
  };
  const summary = sandbox.selector.summary(state, "plans/incomplete.yaml");
  assert.equal(summary.status, "partial");
  assert.equal(summary.completedCount, 2);
  assert.equal(summary.totalCount, 3);
});

test("cancelled submission is incomplete rather than running", () => {
  const sandbox = selectorSandbox();
  const file = "plans/tuning.yaml";
  const summary = sandbox.selector.summary({ plans: [{ file, revision: "r1", jobCount: 36 }],
    operations: [{ planFile: file, planRevision: "r1", type: "run-plan", status: "cancelled" }] }, file);
  assert.equal(summary.status, "partial");
  assert.equal(summary.completedCount, 0);
});

test("completed jobs suppress old operation activity while a newer rerun stays active", () => {
  const sandbox = selectorSandbox();
  const file = "plans/comparison.yaml";
  const state = { plans: [{ file, revision: "r1", jobCount: 1 }],
    distributedPlans: [{ planFile: file, revision: "r1", enqueuedAt: "2026-10-09T00:00:00Z", jobs: [{ index: 0, status: "completed", updatedAt: "2026-10-09T02:00:00Z" }] }],
    operations: [{ planFile: file, planRevision: "r1", type: "run-plan", status: "running", startedAt: "2026-10-09T01:00:00Z" }] };
  assert.equal(sandbox.selector.summary(state, file).status, "completed");
  const newer = { ...state, operations: [{ ...state.operations[0], startedAt: "2026-10-09T03:00:00Z" }] };
  assert.equal(sandbox.selector.summary(newer, file).status, "running");
});

test("latest successful retry supersedes an older failure for the same job", () => {
  const sandbox = selectorSandbox();
  const state = {
    plans: [{ file: "plans/retry.yaml", revision: "r1", jobCount: 1 }],
    tasks: [
      { planFile: "plans/retry.yaml", planRevision: "r1", experimentIndex: 0, attempt: 1, status: "failed" },
      { planFile: "plans/retry.yaml", planRevision: "r1", experimentIndex: 0, attempt: 2, status: "completed" },
    ],
  };
  const summary = sandbox.selector.summary(state, "plans/retry.yaml");
  assert.equal(summary.status, "completed");
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.totalCount, 1);
});

test("current distributed jobs outrank stale scheduler history", () => {
  const sandbox = selectorSandbox();
  const state = {
    plans: [{ file: "plans/retry.yaml", revision: "r1", jobCount: 1 }],
    tasks: [{ planFile: "plans/retry.yaml", planRevision: "r1", experimentIndex: 0, attempt: 1, status: "failed" }],
    distributedPlans: [{ planFile: "plans/retry.yaml", planRevision: "r1", jobs: [{ index: 0, attempt: 2, status: "completed" }] }],
  };
  const summary = sandbox.selector.summary(state, "plans/retry.yaml");
  assert.equal(summary.status, "completed");
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.totalCount, 1);
});

test("selector accepts distributed queue revision without planRevision or timestamps", () => {
  const sandbox = selectorSandbox();
  const state = {
    plans: [{ file: "plans/complete.yaml", revision: "r1", updatedAt: "2026-09-01T00:00:00Z", jobCount: 2 }],
    distributedPlans: [{ planFile: "plans/complete.yaml", revision: "r1", jobs: [
      { index: 0, status: "completed" },
      { index: 1, status: "completed" },
    ] }],
  };
  const summary = sandbox.selector.summary(state, "plans/complete.yaml");
  assert.equal(summary.status, "completed");
  assert.equal(summary.completedCount, 2);
  assert.equal(summary.totalCount, 2);
});

test("trusted summaries keep all completed Plan options accurate after execution history is projected away", () => {
  const sandbox = selectorSandbox();
  const state = {
    planFileInput: "experiments/plans/b.yaml",
    plans: ["a", "b", "c"].map((name) => ({
      file: `experiments/plans/${name}.yaml`,
      revision: "r1",
      jobCount: 6,
    })),
    planStatusSummaries: ["a", "b", "c"].map((name) => ({
      planFile: `experiments/plans/${name}.yaml`,
      revision: "r1",
      status: "completed",
      completedCount: 6,
      totalCount: 6,
      taskCount: 6,
      failedCount: 0,
      activeCount: 0,
      queuedCount: 0,
    })),
    schedulerStates: [],
    tasks: [],
    operations: {},
    distributedPlans: [],
  };

  sandbox.selector.refresh(state);
  for (const name of ["a", "b", "c"]) {
    assert.match(sandbox.elements.planFileInput.innerHTML, new RegExp(`value="experiments/plans/${name}\\.yaml"`));
  }
  assert.equal((sandbox.elements.planFileInput.innerHTML.match(/6\/6 已完成/g) || []).length, 3);
  assert.equal(sandbox.readCounts.tasks, 0);
  assert.equal(sandbox.readCounts.operations, 0);
});

test("selector rejects a trusted summary from an older Plan revision and falls back to evidence", () => {
  const sandbox = selectorSandbox();
  const state = {
    plans: [{ file: "plans/edit.yaml", revision: "r2", jobCount: 1 }],
    planStatusSummaries: [{
      planFile: "plans/edit.yaml",
      revision: "r1",
      status: "completed",
      completedCount: 1,
      totalCount: 1,
      taskCount: 1,
      failedCount: 0,
      activeCount: 0,
      queuedCount: 0,
    }],
    tasks: [{ planFile: "plans/edit.yaml", planRevision: "r1", status: "completed" }],
    operations: [{ planFile: "plans/edit.yaml", planRevision: "r1", type: "run-plan", status: "completed" }],
  };

  const summary = sandbox.selector.summary(state, "plans/edit.yaml");
  assert.equal(summary.status, "not-started");
  assert.equal(summary.completedCount, 0);
  assert.ok(sandbox.readCounts.tasks > 0);
  assert.ok(sandbox.readCounts.operations > 0);
});

test("selector checks Plan update time when revision metadata is unavailable", () => {
  const sandbox = selectorSandbox();
  const state = {
    plans: [{ file: "plans/mtime.yaml", updatedAt: "2026-09-01T00:00:00Z", jobCount: 1 }],
    planStatusSummaries: [{
      planFile: "plans/mtime.yaml",
      revision: "",
      updatedAt: "2026-08-01T00:00:00Z",
      status: "completed",
      completedCount: 1,
      totalCount: 1,
      taskCount: 1,
      failedCount: 0,
      activeCount: 0,
      queuedCount: 0,
    }],
    tasks: [],
    operations: [],
  };

  assert.equal(sandbox.selector.summary(state, "plans/mtime.yaml").status, "not-started");
  assert.ok(sandbox.readCounts.tasks > 0);
});

test("search and status filters keep the selected Plan available", () => {
  const sandbox = selectorSandbox();
  const state = {
    planFileInput: "plans/beta.yaml",
    plans: [
      { file: "plans/alpha.yaml", revision: "a1", jobCount: 2 },
      { file: "plans/beta.yaml", revision: "b1", jobCount: 2 },
    ],
    tasks: [
      { planFile: "plans/alpha.yaml", planRevision: "a1", status: "completed" },
      { planFile: "plans/alpha.yaml", planRevision: "a1", status: "completed" },
    ],
  };
  const elements = sandbox.elements;
  elements.planFileInput.value = "plans/beta.yaml";
  elements.planSelectorQuery.value = "alpha";
  elements.planSelectorStatusFilter.value = "completed";
  sandbox.selector.refresh(state);

  assert.equal(elements.planFileInput.value, "plans/beta.yaml");
  assert.match(elements.planFileInput.innerHTML, /plans\/alpha\.yaml/);
  assert.match(elements.planFileInput.innerHTML, /plans\/beta\.yaml/);
  assert.match(elements.planFileInput.innerHTML, /当前；不符合筛选/);
  assert.match(elements.planSelectorStatus.className, /is-not-started/);
});

test("selector controls expose status, search, and progress ordering", () => {
  assert.match(panel, /id="planSelectorQuery"/);
  assert.match(panel, /id="planSelectorStatusFilter"/);
  assert.match(panel, /id="planSelectorSortOrder"/);
  assert.match(panel, /value="remaining">未完成/);
  assert.match(panel, /value="progress-desc">进度从高到低/);
  assert.match(panel, /planSelectorStatus is-/);
  assert.match(panel, /planSelectorQuery"\)\.addEventListener\("input"/);
});
