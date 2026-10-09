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

function commandLabel(command) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("featureCommandLabel")}\nthis.label = featureCommandLabel;`, sandbox);
  return sandbox.label(command);
}

test("recent error commands use clear Chinese labels", () => {
  assert.equal(commandLabel("runPlan"), "校验并提交运行");
  assert.equal(commandLabel("parseResults"), "解析结果");
  assert.equal(commandLabel("uploadProjectToHub"), "上传 Hub");
});

test("unknown error command remains visible for compatibility", () => {
  assert.equal(commandLabel("futureCommand"), "futureCommand");
});

test("error rows keep raw command IDs in the tooltip", () => {
  assert.match(panel, /const rawCommand = row\.command \|\| "unknown"/);
  assert.match(panel, /const commandLabel = featureCommandLabel\(rawCommand\)/);
  assert.match(panel, /原始命令：/);
});
