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

function pendingLabel(command) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFrozenObject("PENDING_ACTION_LABELS")}\n${extractFunction("pendingLabel")}\nthis.check = pendingLabel;`, sandbox);
  return sandbox.check({ command });
}

function loadTaskStatusLabel() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFrozenObject("TASK_STATUS_LABELS")}\n${extractFunction("taskStatusToken")}\n${extractFunction("taskStatusLabel")}\nthis.check = taskStatusLabel;\nthis.labels = TASK_STATUS_LABELS;`, sandbox);
  return sandbox;
}

test("task timeline translates task status and preserves the raw value in details", () => {
  assert.match(panel, /data-task-status-label="true"[^\n]*title="' \+ escAttr\("原始状态：" \+ row\.status\)[^\n]*esc\(taskStatusLabel\(row\.status\)\)/);
  assert.match(panel, /taskCardClass\(row\.status\)/);
  assert.match(panel, /const taskTime = taskTimestampView\(row\)/);
  assert.match(panel, /taskTime\.label \+ "时间：" \+ taskTime\.raw/);
  assert.match(extractFunction("taskTimestampView"), /relativeTimestampView\(row\.updatedAt, taskTerminalStatus\(row\.status\) \? "终态" : "更新"\)/);
});

test("task timeline keeps unknown task status values compatible", () => {
  const sandbox = loadTaskStatusLabel();
  assert.equal(sandbox.check("queued"), "排队中");
  assert.equal(sandbox.check("normal_completed"), "已完成");
  assert.equal(sandbox.check("manual_interrupted_completed"), "已停止");
  assert.equal(sandbox.check("future-status"), "future-status");
  assert.equal(sandbox.check(""), "未知");
  assert.equal(sandbox.check("-"), "-");
  assert.equal(Object.isFrozen(sandbox.labels), true);
  assert.match(panel, /const TASK_STATUS_LABELS = Object\.freeze\(\{/);
  assert.match(extractFunction("taskStatusLabel"), /TASK_STATUS_LABELS\[taskStatusToken\(raw\)\] \|\| raw/);
  assert.doesNotMatch(extractFunction("taskStatusLabel"), /const labels =/);
});

test("task pending labels reuse one immutable lookup table", () => {
  assert.equal(pendingLabel("stopExperiment"), "停止中");
  assert.equal(pendingLabel("completeThreeWay"), "校验中");
  assert.equal(pendingLabel("futureCommand"), "执行中");
  assert.match(panel, /const PENDING_ACTION_LABELS = Object\.freeze\(\{/);
  assert.match(extractFunction("pendingLabel"), /PENDING_ACTION_LABELS\[command\] \|\| "执行中"/);
  assert.doesNotMatch(extractFunction("pendingLabel"), /const labels =/);
});
