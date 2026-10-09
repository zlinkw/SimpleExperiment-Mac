const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

// 7c23e89 基线：advanced 用 <details class="advanced">，诊断预算通知保留省略逻辑，调度器术语完整。
test("overview advanced blocks keep details wrapper and diagnostic budget", () => {
  assert.match(panel, /<details class="advanced"/);
  assert.match(panel, /function diagnosticBudgetNotice\(/);
  assert.match(panel, /已省略 /);
  assert.match(panel, /\["实时事件最多等待", "/);
  assert.match(panel, /\["Worker 操作防连点间隔", "/);
  assert.match(panel, /\["Worker 操作同时执行数", "/);
  assert.match(panel, /function statusInfoPopover\(text, label\)/);
  assert.match(panel, /var\(--tree-col\)|always-visible three columns/);
});
