const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panelSource = readSource("src/ui/PanelHtml.ts");

// 7c23e89 抽屉基线：渲染与缓存辅助器全部保留，但用 translateX 抽屉而非 absolute rails。
const liveFns = [
  "renderPlanGateList",
  "renderTaskCards",
  "renderTaskProgressCard",
  "renderTaskCard",
  "renderPlanRunWorkbench",
  "renderSectionIfVisible",
  "renderResourceTree",
  "renderWorkbenchInspector"
];

test("functional ui render helpers remain available for drawer recovery", () => {
  for (const name of liveFns) {
    assert.match(panelSource, new RegExp("function\\s+" + name + "\\s*\\("));
  }
  // 抽屉 rails：translateX 隐藏 + hover 展开。
  assert.match(panelSource, /transform: translateX\(calc\(-1 \* \(var\(--tree-col\) - var\(--tree-peek\)\)\)\)/);
  assert.match(panelSource, /transform: translateX\(calc\(var\(--inspector-col\) - var\(--inspector-peek\)\)\)/);
  assert.match(panelSource, /\.resourceTree:hover/);
  assert.match(panelSource, /\.workbenchInspector:hover|\.workbenchInspector:focus-within/);
});
