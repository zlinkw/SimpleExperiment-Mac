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

test("current Plan result workflow derivation is bounded and isolated by state and Plan", () => {
  const calls = { readiness: 0, workflow: 0 };
  const sandbox = {
    CURRENT_PLAN_WORKFLOW_RESULT_CACHE_LIMIT: 2,
    currentPlanWorkflowResultCacheState: null,
    currentPlanWorkflowResultCache: new Map(),
    normalizePlanSelectionKey: (value) => String(value || "").replace(/\\/g, "/").toLowerCase(),
    resultAutoParseReadinessForState: (state) => {
      calls.readiness += 1;
      return { status: "parsed", planFile: state.planFileInput };
    },
    currentPlanResultWorkflowStatus: (state) => {
      calls.workflow += 1;
      return { planFile: state.planFileInput };
    },
    resultWorkflowStage: (status) => ({ kind: "done", planFile: status.planFile }),
    projectWorkflowResultStep: (stage) => ({ tone: "good", status: stage.planFile, detail: "done" }),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    ["cacheCurrentPlanWorkflowResult", "currentPlanWorkflowResultReadiness"].map(extractFunction).join("\n")
      + "\nthis.readiness = currentPlanWorkflowResultReadiness;",
    sandbox,
  );

  const firstState = { resultsSummary: {} };
  const first = sandbox.readiness(firstState, "plans/A.yaml");
  assert.equal(sandbox.readiness(firstState, "plans/A.yaml"), first);
  assert.equal(calls.readiness, 1);
  assert.equal(calls.workflow, 1);

  const secondPlan = sandbox.readiness(firstState, "plans/B.yaml");
  assert.notEqual(secondPlan, first);
  assert.equal(secondPlan.status, "plans/B.yaml");
  sandbox.readiness(firstState, "plans/C.yaml");
  assert.ok(sandbox.currentPlanWorkflowResultCache.size <= 2);

  const secondState = { resultsSummary: {} };
  const refreshed = sandbox.readiness(secondState, "plans/A.yaml");
  assert.notEqual(refreshed, first);
  assert.equal(calls.readiness, 4);
  assert.equal(calls.workflow, 4);
});
