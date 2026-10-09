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

function loadLabelStatus() {
  const sandbox = {};
  vm.createContext(sandbox);
  const runtimeFunction = extractFunction("labelStatus").replace(/\\\\/g, "\\");
  vm.runInContext(`${extractFrozenObject("STATUS_LABELS")}\n${runtimeFunction}\nthis.labelStatus = labelStatus;\nthis.labels = STATUS_LABELS;`, sandbox);
  return sandbox;
}

function labelStatus(value) {
  return loadLabelStatus().labelStatus(value);
}

test("connection and sync statuses use clear Chinese labels", () => {
  const sandbox = loadLabelStatus();
  assert.equal(labelStatus("running"), "运行中");
  assert.equal(labelStatus("connected"), "已连接");
  assert.equal(labelStatus("syncing"), "同步中");
  assert.equal(labelStatus("failed: permission denied"), "失败：permission denied");
  assert.equal(labelStatus("completed_with_errors"), "部分失败");
  assert.equal(Object.isFrozen(sandbox.labels), true);
  assert.match(panel, /const STATUS_LABELS = Object\.freeze\(\{/);
  assert.match(extractFunction("labelStatus"), /STATUS_LABELS\[key\]/);
  assert.doesNotMatch(extractFunction("labelStatus"), /const map =/);
});

test("unknown status remains available for compatibility diagnostics", () => {
  assert.equal(labelStatus("agent_future_state"), "agent_future_state");
  assert.equal(labelStatus("同步完成 2 台"), "同步完成 2 台");
});
