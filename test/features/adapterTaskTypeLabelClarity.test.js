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

function loadTaskTypeLabel() {
  const sandbox = {};
  vm.createContext(sandbox);
  const runtimeFunction = extractFunction("projectTaskTypeLabel").replace(/\\\\/g, "\\");
  vm.runInContext(`${extractFrozenObject("PROJECT_TASK_TYPE_LABELS")}\n${runtimeFunction}\nthis.taskTypeLabel = projectTaskTypeLabel;\nthis.taskTypeLabels = PROJECT_TASK_TYPE_LABELS;`, sandbox);
  return sandbox;
}

test("project adapter summaries translate common task types", () => {
  const sandbox = loadTaskTypeLabel();
  assert.equal(sandbox.taskTypeLabel("classification"), "分类");
  assert.equal(sandbox.taskTypeLabel("object-detection"), "目标检测");
  assert.equal(Object.isFrozen(sandbox.taskTypeLabels), true);
  assert.match(panel, /const PROJECT_TASK_TYPE_LABELS = Object\.freeze\(\{/);
  assert.match(panel, /"任务 " \+ projectTaskTypeLabel\(rules\.taskType \|\| "classification"\)/);
});

test("project adapter editor and unknown task types remain compatible", () => {
  const sandbox = loadTaskTypeLabel();
  assert.match(panel, /projectRuleInput\("taskType", "任务类型", rules\.taskType \|\| "classification"/);
  assert.equal(sandbox.taskTypeLabel("future-task"), "future-task");
  assert.equal(sandbox.taskTypeLabel(""), "未指定");
  assert.match(extractFunction("projectTaskTypeLabel"), /PROJECT_TASK_TYPE_LABELS\[key\] \|\| raw \|\| "未指定"/);
  assert.doesNotMatch(extractFunction("projectTaskTypeLabel"), /const labels =/);
});
