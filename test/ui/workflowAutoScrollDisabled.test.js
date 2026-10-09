const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("workflow completion does not auto-scroll and manual navigation stays available", () => {
  const html = renderPanelHtml();
  assert.doesNotMatch(html, /maybeAutoAdvanceFromSync|lastSyncChainGreen|isSyncChainGreen/);
  assert.match(html, /function scrollMainColumnToSection\(next\)/);
  assert.doesNotMatch(html, /navigateToResourceTarget\(submittedTarget\./);
  assert.match(html, /navigateToResourceTarget\(treeTarget\.dataset\.sectionTarget, treeTarget\.dataset\.anchorTarget\)/);
  assert.match(html, /item\.userInitiated === true \|\| item\.openResultMapping === true/);
});

test("Host completion navigation does nothing; an explicit navigation click still opens the requested section", async () => {
  const source = fs.readFileSync(require.resolve("../../dist/extension/legacy.js"), "utf8");
  const start = source.indexOf("async openPanelAt("), end = source.indexOf("async assertPlanLocalConfigFiles(", start);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`this.methods = { ${source.slice(start, end).replace(/}\s+async /g, "}, async ")} };`, sandbox);
  const sent = [], host = { ...sandbox.methods, webviewReady: true,
    view: { webview: { postMessage: async data => { sent.push(data); return true; } } },
    openPanel: async () => { sent.push("focus"); },
  };
  await host.openPanelAt("execution", "execution-operations");
  assert.deepEqual(sent, []);
  assert.equal(host.pendingPanelNavigation, undefined);
  await host.openPanelAt("results", "results", { userInitiated: true });
  assert.equal(sent[0], "focus");
  assert.equal(sent[1].section, "results");
  assert.equal(sent[1].userInitiated, true);
});

test("completed schedule history starts collapsed with its Plan recovery controls intact", () => {
  const html = renderPanelHtml();
  assert.match(html, /<details class="executionPlanHistory"><summary>已完成 Plan 历史/);
  assert.match(html, /data-command="runPlan"/);
  assert.match(html, /data-command="recallPlanToLocalQueue"/);
  assert.match(html, /data-command="stopAndClearPlan"/);
});
