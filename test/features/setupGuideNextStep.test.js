const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function nextStep(options) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(extractFunction("setupGuideNextStep") + "\nthis.check = setupGuideNextStep;", sandbox);
  return JSON.parse(JSON.stringify(sandbox.check(options)));
}

test("setup guide offers the only next action supported by current readiness", () => {
  assert.deepEqual(nextStep({ setupComplete: false }), {
    message: "配置说明已打开。下一步：在“设置 > 服务器”手动填写 Hub/Worker 会话和项目父目录。",
    action: "打开服务器设置",
  });
  assert.equal(nextStep({ setupComplete: true, workerCount: 0, workspaceOpen: true }).action, "添加 Worker");
  assert.equal(nextStep({ setupComplete: true, workerCount: 1, workspaceOpen: false }).action, "选择项目并继续");
  assert.equal(nextStep({ setupComplete: true, workerCount: 1, workspaceOpen: true }).action, "识别工作区");

  const start = source.indexOf("async openSetupGuide()");
  const end = source.indexOf("async openPanelAt(", start);
  const handler = source.slice(start, end);
  assert.match(handler, /setupGuideNextStep\(\{/);
  assert.match(source, /const SETUP_GUIDE_MAX_STEPS = 4/);
  assert.match(handler, /for \(let step = 0; step < SETUP_GUIDE_MAX_STEPS; step \+= 1\)/);
  assert.match(handler, /const seen = new Set\(\)/);
  assert.match(handler, /seen\.has\(key\)[\s\S]{0,50}return/);
  assert.match(handler, /showInformationMessage\(next\.message, next\.action, "打开面板"\)/);
  assert.match(handler, /choice === "打开服务器设置"[\s\S]{0,100}openPanelAt\("settings", "settings-servers", \{ userInitiated: true \}\)/);
  assert.match(handler, /choice === "添加 Worker"[\s\S]{0,100}this\.addWorkerConfigFromUi\(false\)[\s\S]{0,40}continue/);
  assert.match(handler, /choice === "选择项目并继续"[\s\S]{0,140}openWorkspaceFolderForContinuation\("配置说明", "setupGuide"\)/);
  assert.match(handler, /choice === "识别工作区"[\s\S]{0,80}this\.bootstrapProjectFromUi\(\)/);
  assert.match(source, /pending\.action === "setupGuide"[\s\S]{0,100}openSetupGuide\(\)/);
});
