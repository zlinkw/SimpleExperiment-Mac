const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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

test("plan version row filters reuse bounded caches and invalidate by state", () => {
  const sandbox = {
    PLAN_VERSION_ROWS_CACHE_LIMIT: 2,
    planVersionRowsCacheState: null,
    planVersionOperationRowsCache: new Map(),
    planVersionTaskRowsCache: new Map(),
    counts: { operations: 0, tasks: 0 },
    normalizePlanSelectionKey: (value) => String(value || "").toLowerCase(),
    samePlanSelection: (left, right) => String(left || "").toLowerCase() === String(right || "").toLowerCase(),
    operationMatchesPlanVersion: (row, revision) => !revision || row.revision === revision,
    taskMatchesPlanVersion: (row, revision) => !revision || row.revision === revision,
    operationRowsForState(state) { sandbox.counts.operations += 1; return state.operations; },
    schedulerRowsForState(state) { sandbox.counts.tasks += 1; return state.tasks; },
  };
  vm.createContext(sandbox);
  const names = ["ensurePlanVersionRowsCache", "planVersionRowsCacheKey", "cachePlanVersionRows", "planVersionOperationRows", "planVersionTaskRows"];
  vm.runInContext(names.map(extractFunction).join("\n") + "\nthis.operationRows = planVersionOperationRows; this.taskRows = planVersionTaskRows;", sandbox);

  const firstState = {
    operations: [{ planFile: "a.yaml", revision: "r1" }, { planFile: "b.yaml", revision: "r1" }],
    tasks: [{ planFile: "a.yaml", revision: "r1" }, { planFile: "b.yaml", revision: "r1" }],
  };
  const firstOperations = sandbox.operationRows(firstState, "a.yaml", "r1", NaN);
  const firstTasks = sandbox.taskRows(firstState, "a.yaml", "r1", NaN);
  assert.equal(sandbox.operationRows(firstState, "a.yaml", "r1", NaN), firstOperations);
  assert.equal(sandbox.taskRows(firstState, "a.yaml", "r1", NaN), firstTasks);
  assert.equal(sandbox.counts.operations, 1);
  assert.equal(sandbox.counts.tasks, 1);

  const secondState = { operations: [{ planFile: "a.yaml", revision: "r2" }], tasks: [{ planFile: "a.yaml", revision: "r2" }] };
  assert.equal(sandbox.operationRows(secondState, "a.yaml", "r2", NaN)[0].revision, "r2");
  assert.equal(sandbox.taskRows(secondState, "a.yaml", "r2", NaN)[0].revision, "r2");
  assert.equal(sandbox.counts.operations, 2);
  assert.equal(sandbox.counts.tasks, 2);

  sandbox.operationRows(secondState, "b.yaml", "r2", NaN);
  sandbox.operationRows(secondState, "c.yaml", "r2", NaN);
  assert.ok(sandbox.planVersionOperationRowsCache.size <= 2);
});
