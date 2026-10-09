const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

// 7c23e89 基线保留 workflow 阶段、对象条、通信路径与抽屉 rails，不做 display:none 隐藏。
test("inspector and workflow keep render helpers and drawer rails", () => {
  assert.match(panel, /\.inspectorHint \{/);
  assert.match(panel, /\.inspectorSummary \{/);
  assert.match(panel, /function renderWorkbenchInspector\(state, options\)/);
  assert.match(panel, /var\(--tree-col\)/);
});

// 基线用 statusInfoPopover details 元素（非 fixed portal）。
test("status info uses details popover with close scheduling", () => {
  assert.match(panel, /function statusInfoPopover\(text, label\)/);
  assert.match(panel, /function scheduleStatusInfoPopoverClose\(details\)/);
  assert.match(panel, /<details class="statusInfoPopover">/);
  assert.match(panel, /\.statusInfoPopoverBody \{ position: absolute/);
});
