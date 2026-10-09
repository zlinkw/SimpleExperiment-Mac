const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

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

function loadWorkflowHelpers() {
  const sandbox = {
    PLAN_WORKFLOW_BUSY_PHASES: new Set(["validating", "dry-running", "submitting"]),
    PLAN_WORKFLOW_RUNNING_PHASES: new Set(["validating", "dry-running", "submitting", "monitor"]),
    PLAN_WORKFLOW_TERMINAL_PHASES: new Set(["results", "debug-review", "review"]),
    PLAN_WORKFLOW_TASK_PHASES: new Set(["monitor", "results", "debug-review", "review"]),
    PLAN_WORKFLOW_READY_PHASES: new Set(["ready", "run"]),
    currentPlanRevisionRunEvidenceForState: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("projectOnboardingExecutionTarget"),
    extractFunction("planFirstRunRecommended"),
    extractFunction("projectWorkflowExecutionStep"),
    "this.api = { projectOnboardingExecutionTarget, planFirstRunRecommended, projectWorkflowExecutionStep };",
  ].join("\n"), sandbox);
  return sandbox.api;
}

test("Plan workflow navigation preserves busy task and ready phase semantics", () => {
  const api = loadWorkflowHelpers();
  assert.equal(api.projectOnboardingExecutionTarget({ phase: "validating" }).section, "execution");
  assert.equal(api.projectOnboardingExecutionTarget({ phase: "monitor" }).section, "execution");
  assert.equal(api.projectOnboardingExecutionTarget({ phase: "review" }).section, "execution");
  assert.equal(api.projectOnboardingExecutionTarget({ phase: "ready" }).section, "plans");

  assert.equal(api.planFirstRunRecommended({}, "plan.yaml", {}, { phase: "ready" }, true), true);
  assert.equal(api.planFirstRunRecommended({}, "plan.yaml", {}, { phase: "run", status: "提交失败" }, true), false);
  assert.equal(api.planFirstRunRecommended({}, "plan.yaml", {}, { phase: "monitor" }, true), false);

  assert.equal(api.projectWorkflowExecutionStep({ phase: "dry-running" }, true, false).status, "处理中");
  assert.equal(api.projectWorkflowExecutionStep({ phase: "ready" }, true, false).status, "可提交");
  assert.equal(api.projectWorkflowExecutionStep({ phase: "results" }, true, false).status, "运行完成");
  assert.equal(api.projectWorkflowExecutionStep({ phase: "review" }, true, false).status, "任务需处理");
});

test("Plan workflow phase classifiers reuse fixed sets", () => {
  for (const name of ["PLAN_WORKFLOW_BUSY_PHASES", "PLAN_WORKFLOW_RUNNING_PHASES", "PLAN_WORKFLOW_TERMINAL_PHASES", "PLAN_WORKFLOW_TASK_PHASES", "PLAN_WORKFLOW_READY_PHASES"]) {
    assert.match(panel, new RegExp(`const ${name} = new Set\\(`));
  }
  assert.doesNotMatch(panel, /\["validating", "dry-running", "submitting"\]\.includes/);
  assert.doesNotMatch(panel, /\["validating", "dry-running", "submitting", "monitor"\]\.includes/);
  assert.doesNotMatch(panel, /\["ready", "run"\]\.includes/);
  assert.match(panel, /const PLAN_WORKFLOW_RUNNING_PHASES = new Set\(\[\.\.\.PLAN_WORKFLOW_BUSY_PHASES, "monitor"\]\);/);
  assert.match(extractFunction("overviewProjectReadiness"), /PLAN_WORKFLOW_RUNNING_PHASES\?\.has/);
  assert.match(extractFunction("projectOnboardingExecutionTarget"), /PLAN_WORKFLOW_(?:BUSY|TASK)_PHASES\?\.has/);
});
