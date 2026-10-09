const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveCommandHandlerMap } = require("../../dist/extension/ProviderCommands.js");
const { readSource } = require("../_helpers/sourceReader");

test("workflow panel command is bound and navigation does not call an unbound command", async () => {
  let focused = false;
  const handlers = resolveCommandHandlerMap({ openPanel() { focused = true; } });
  await handlers["simpleExperiment.openPanel"]();
  assert.equal(focused, true);
  const source = readSource("src/extension/legacy.ts");
  const openPanel = source.slice(source.indexOf("async openPanel()"), source.indexOf("async flushPendingPanelNavigation()"));
  assert.match(openPanel, /executeCommand\(`\$\{viewId\}\.focus`\)/);
  assert.match(openPanel, /await this\.openPanel\(\)/);
});
