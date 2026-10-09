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

function labelStatus(value) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFrozenObject("STATUS_LABELS")}\n${extractFunction("labelStatus")}\nthis.labelStatus = labelStatus;`, sandbox);
  return sandbox.labelStatus(value);
}

test("GPU server statuses use clear Chinese labels", () => {
  assert.equal(labelStatus("online"), "在线");
  assert.equal(labelStatus("offline"), "离线");
  assert.equal(labelStatus("stale"), "已过期");
  assert.equal(labelStatus("degraded"), "降级");
});

test("unknown GPU server status remains available for compatibility", () => {
  assert.equal(labelStatus("future_gpu_state"), "future_gpu_state");
});
