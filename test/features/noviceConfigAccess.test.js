const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { readSource } = require("../_helpers/sourceReader");

function loadLayoutHelpers() {
  const source = readSource("src/extension.ts");
  const defaultUiSectionOrderStart = source.indexOf("const defaultUiSectionOrder");
  const defaultUiSectionOrderEnd = source.indexOf("const defaultUiLayout =");
  const defaultStart = source.indexOf("const defaultUiLayout =");
  const defaultEnd = source.indexOf("const uiActionCommands");
  const normalizeStart = source.indexOf("function normalizeUiLayout(input)");
  const clampEnd = source.indexOf("function arrayFromRecord");
  const uiActionStart = source.indexOf("const uiActionCommands");
  const uiActionEnd = source.indexOf("const actionCommandMap");
  const prelude = [
    source.slice(defaultUiSectionOrderStart, defaultUiSectionOrderEnd),
    source.slice(defaultStart, defaultEnd),
    source.slice(uiActionStart, uiActionEnd).replace(/new Set<WebviewActionCommand>/g, "new Set"),
    source.slice(normalizeStart, clampEnd),
  ].join("\n");
  const sandbox = { console };
  vm.createContext(sandbox);
  const compiled = ts.transpileModule(prelude + "\nthis.exports = { defaultUiLayout, defaultUiSectionOrder, normalizeUiLayout, normalizeUiButtonActions, normalizeUiButtonPayload };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(compiled, sandbox);
  return sandbox.exports;
}

test("servers config stays expanded near primary workflow by default", () => {
  const helpers = loadLayoutHelpers();
  assert.equal(helpers.defaultUiSectionOrder[0], "sync");
  assert.equal(helpers.defaultUiSectionOrder[1], "plans");
  assert.equal(helpers.defaultUiSectionOrder[2], "gpu");
  assert.equal(helpers.defaultUiSectionOrder[3], "tmux");
  assert.equal(helpers.defaultUiLayout.collapsed.sync, false);
  assert.equal(helpers.defaultUiLayout.collapsed.execution, false);
  assert.equal(helpers.defaultUiLayout.collapsed.diagnostics, true);
});

test("ordinary panel keeps tunnel setup while omitting network pause/resume controls", () => {
  const source = readSource("src/ui/PanelHtml.ts");
  // start/test 全局动作在分区卡片里渲染（overview/ servers-sessions）。
  assert.match(source, /data-command="startAllConnections"/);
  assert.match(source, /data-command="testAll"/);
  // 保留设置和布局恢复入口，网络控制仍有兼容命令。
  assert.match(source, /class="topbar-actions"/);
  assert.doesNotMatch(source, /data-command="pauseAll"|data-command="resumeNetwork"/);
  assert.match(source, /data-command="resetUiLayout"/);
  assert.match(source, /全局配置/);
});

test("layout normalization keeps allowed commands and strips unknown payload fields", () => {
  const helpers = loadLayoutHelpers();
  const actions = JSON.parse(JSON.stringify(helpers.normalizeUiButtonActions([
    { command: "runPlan", payload: { planFile: "experiments/plans/demo.yaml", shellCommand: "blocked" } },
    { command: "unknown", payload: { planFile: "ignored" } },
  ], 40)));
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].payload, { planFile: "experiments/plans/demo.yaml" });
});

test("layout action normalization caches bounded limit variants", () => {
  const helpers = loadLayoutHelpers();
  const input = [
    { command: "runPlan", label: "Run" },
    { command: "testAll", label: "Test" },
    { command: "snapshot", label: "Snapshot" },
    { command: "pauseAll", label: "Pause" },
    { command: "resumeNetwork", label: "Resume" },
  ];
  const one = helpers.normalizeUiButtonActions(input, 1);
  const two = helpers.normalizeUiButtonActions(input, 2);
  helpers.normalizeUiButtonActions(input, 3);
  helpers.normalizeUiButtonActions(input, 4);
  assert.equal(helpers.normalizeUiButtonActions(input, 1), one);
  assert.equal(helpers.normalizeUiButtonActions(one, 1), one);
  helpers.normalizeUiButtonActions(input, 5);
  assert.notEqual(helpers.normalizeUiButtonActions(input, 2), two);
  assert.equal(helpers.normalizeUiButtonActions(input, 2).length, 2);
});
