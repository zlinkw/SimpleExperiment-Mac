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

test("diagnostic severity and fallback transport use Chinese labels", () => {
  assert.equal(labelStatus("warning"), "注意");
  assert.equal(labelStatus("error"), "错误");
  assert.equal(labelStatus("snapshot"), "快照备用");
});

test("port conflict diagnostics retain raw severity in tooltips", () => {
  assert.match(panel, /原始级别：/);
  assert.match(panel, /labelStatus\(item\.severity \|\| "warning"\)/);
  assert.match(panel, /conflict\.severity === "error" \? \(conflict\.conflictType \|\| "端口冲突"\) : "注意"/);
});

test("capability diagnostics retain raw realtime transport", () => {
  assert.match(panel, /const realtimeRaw = endpoints\.websocketEvents \? "WebSocket" : \(endpoints\.sseEvents \? "SSE" : "snapshot"\)/);
  assert.match(panel, /const realtime = labelStatus\(realtimeRaw\)/);
  assert.match(panel, /原始通道：/);
});
