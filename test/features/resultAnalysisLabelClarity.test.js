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
    if (depth === 0) return panel.slice(start, index + 1).replace(/\\\\/g, "\\");
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

function call(name, value) {
  const sandbox = {};
  vm.createContext(sandbox);
  const dependency = name === "chartTypeLabel"
    ? extractFrozenObject("PPT_CHART_TYPE_LABELS")
    : name === "styleModeLabel" ? extractFrozenObject("PPT_STYLE_MODE_LABELS") : "";
  vm.runInContext(`${dependency}\n${extractFunction(name)}\nthis.fn = ${name};`, sandbox);
  return sandbox.fn(value);
}

test("analysis and PPT config values use clear Chinese labels", () => {
  assert.equal(call("analysisStatusLabel", "significant"), "显著");
  assert.equal(call("analysisStatusLabel", "not-significant"), "不显著");
  assert.equal(call("analysisStatusLabel", "needs experiment"), "需实验");
  assert.equal(call("chartTypeLabel", "auto"), "自动");
  assert.equal(call("styleModeLabel", "activePpt"), "跟随当前 PPT");
  assert.match(panel, /const PPT_CHART_TYPE_LABELS = Object\.freeze\(\{ auto: "自动", leaderboardBar: "柱状", meanStdErrorBar: "误差图", genericTable: "表格" \}\)/);
  assert.match(panel, /const PPT_STYLE_MODE_LABELS = Object\.freeze\(\{ activePpt: "跟随当前 PPT", default: "默认样式" \}\)/);
  assert.doesNotMatch(extractFunction("chartTypeLabel"), /const labels =/);
  assert.doesNotMatch(extractFunction("styleModeLabel"), /const labels =/);
});

test("unknown analysis values remain unchanged for compatibility", () => {
  assert.equal(call("analysisStatusLabel", "future_state"), "future_state");
  assert.equal(call("chartTypeLabel", "futureChart"), "futureChart");
  assert.equal(call("styleModeLabel", "futureStyle"), "futureStyle");
});

test("result summary and PPT selects hide raw identifiers without changing config values", () => {
  assert.match(panel, /\["失败数", parseFailed, ""\]/);
  assert.doesNotMatch(panel, /row\("parse_failed"/);
  assert.match(panel, /optionHtml\("auto", "自动", chartType === "auto"\)/);
  assert.match(panel, /optionHtml\("activePpt", "跟随当前 PPT", styleMode === "activePpt"\)/);
  assert.match(panel, /原始值：/);
});
