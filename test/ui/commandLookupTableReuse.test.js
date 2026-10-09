const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");

function declaration(name) {
  const start = source.indexOf("const " + name + " =");
  assert.ok(start >= 0, "missing " + name);
  const end = source.indexOf(";", start);
  assert.ok(end >= 0, "unterminated " + name);
  return source.slice(start, end + 1);
}

function functionSource(name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "missing " + name);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error("unterminated " + name);
}

test("webview command routing reuses frozen lookup tables", () => {
  const names = ["COMMAND_ACTION_NAMES", "COMMAND_INSPECTOR_SECTIONS", "ACTION_RESOURCE_ANCHORS", "SYNC_COMMAND_ANCHORS"];
  const functions = ["commandActionName", "commandInspectorSection", "syncCommandAnchor", "actionResourceAnchor"];
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(names.map(declaration).concat(functions.map(functionSource), ["this.api = { commandActionName, commandInspectorSection, syncCommandAnchor, actionResourceAnchor };"]).join("\n"), sandbox);

  assert.equal(sandbox.api.commandActionName("runPlan"), "run-plan");
  assert.equal(sandbox.api.commandActionName("futureCommand"), "futureCommand");
  assert.equal(sandbox.api.commandInspectorSection("plotResultsToPpt"), "results");
  assert.equal(sandbox.api.commandInspectorSection("futureCommand"), "overview");
  assert.equal(sandbox.api.syncCommandAnchor("deployLatestAgent"), "sync-deploy-agent");
  // 单链第二步：未知命令回退到新链锚点
  assert.equal(sandbox.api.syncCommandAnchor("futureCommand"), "settings-chain-overview");
  assert.equal(sandbox.api.actionResourceAnchor("results", "runStatistics"), "results-summary");
  assert.equal(sandbox.api.actionResourceAnchor("sync", "publishGithub"), "sync-publish-github");
  for (const name of names) assert.match(declaration(name), /Object\.freeze\(/);
  for (const name of functions) assert.doesNotMatch(functionSource(name), /const map = \{/);
});
