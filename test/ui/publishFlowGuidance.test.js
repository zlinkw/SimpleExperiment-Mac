const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const panelSource = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");

// 单链第二步：旧 publishFlow 函数族已下线，新链由 renderServerChainOverview 承载。
test("old publish flow functions are retired in favor of the settings chain overview", () => {
  assert.doesNotMatch(panelSource, /function publishFlowSteps\(/);
  assert.doesNotMatch(panelSource, /function publishFlowBlocker\(/);
  assert.doesNotMatch(panelSource, /function renderPublishFlow\(/);
  assert.doesNotMatch(panelSource, /function renderActionSections\(/);
  assert.doesNotMatch(panelSource, /function renderPublishActionGroups\(/);
  assert.match(panelSource, /function renderServerChainOverview\(/);
  assert.match(panelSource, /data-anchor="settings-chain-overview"/);
  // P0：外层模板内残留裸转义即失败（双写 \\ 校验）
  assert.doesNotMatch(panelSource, /replace\(\/\^\\d/);
});
