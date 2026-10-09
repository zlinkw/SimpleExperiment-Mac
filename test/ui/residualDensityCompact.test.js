const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const panelSource = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");

test("functional entry points and drawer rails remain in baseline", () => {
  assert.match(panelSource, /class="section-desc"/);
  // experimentActions 区块已移除：原 div 无渲染函数（预留空位），用户反馈「不知道干嘛的」，确认移除。
  assert.doesNotMatch(panelSource, /id="resultActions"/);
  assert.doesNotMatch(panelSource, /id="artifactActions"/);
  assert.match(panelSource, /id="pptPlotConfig"/);
  assert.match(panelSource, /<summary>绘图到 PPT（可选）<\/summary>/);
  assert.ok(panelSource.indexOf('id="pptPlotConfig"') > panelSource.indexOf('id="traceTable"'));
  assert.match(panelSource, /class="resultMethodList"/);
  assert.doesNotMatch(panelSource, /class="resultTableCards"/);
  // 单链第二步：旧 renderActionSections 已删除，新链为 renderServerChainOverview
  assert.doesNotMatch(panelSource, /function renderActionSections/);
  assert.match(panelSource, /function renderServerChainOverview/);
  // 7c23e89 基线用 translateX 抽屉 rails。
  assert.match(panelSource, /transform: translateX\(calc\(-1 \* \(var\(--tree-col\) - var\(--tree-peek\)\)\)\)/);
  assert.match(panelSource, /transform: translateX\(calc\(var\(--inspector-col\) - var\(--inspector-peek\)\)\)/);
});
