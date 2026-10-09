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
  const bodyStart = panel.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function extractFrozenObject(name) {
  const start = panel.indexOf(`const ${name} = Object.freeze({`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = panel.indexOf("});", start);
  assert.ok(end > start, `unterminated ${name}`);
  return panel.slice(start, end + 3);
}

function loadPhaseLabel() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFrozenObject("PLAN_EXECUTION_PHASE_LABELS")}\n${extractFunction("planExecutionPhaseLabel")}\nthis.phaseLabel = planExecutionPhaseLabel;\nthis.phaseLabels = PLAN_EXECUTION_PHASE_LABELS;`, sandbox);
  return sandbox;
}

test("plan execution phases use workflow labels", () => {
  const sandbox = loadPhaseLabel();
  assert.equal(sandbox.phaseLabel("ready"), "可提交");
  assert.equal(sandbox.phaseLabel("validating"), "校验中");
  assert.equal(sandbox.phaseLabel("dry-running"), "预演中");
  assert.equal(sandbox.phaseLabel("monitor"), "运行中");
  assert.equal(sandbox.phaseLabel("results"), "结果待处理");
  assert.equal(sandbox.phaseLabel("review"), "任务需处理");
  assert.equal(Object.isFrozen(sandbox.phaseLabels), true);
  assert.match(panel, /const PLAN_EXECUTION_PHASE_LABELS = Object\.freeze\(\{/);
  assert.match(extractFunction("planExecutionPhaseLabel"), /PLAN_EXECUTION_PHASE_LABELS\[raw\] \|\| raw \|\| "未知"/);
  assert.doesNotMatch(extractFunction("planExecutionPhaseLabel"), /const labels =/);
});

test("unknown execution phases remain visible for compatibility", () => {
  const sandbox = loadPhaseLabel();
  assert.equal(sandbox.phaseLabel("future-phase"), "future-phase");
  assert.equal(sandbox.phaseLabel(""), "未知");
});

test("run workbench keeps the raw phase in the badge tooltip", () => {
  assert.match(panel, /planExecutionPhaseLabel\(executionStage\.phase\)/);
  assert.match(panel, /原始阶段：/);
  assert.match(panel, /function planRunRow\(label, tone, value, badge, badgeTitle\)/);
});
