const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

// 7c23e89 基线：overviewStatusCard 渲染 mini grid（flex 可见），details popover，app-shell 主行流高位。
test("overview status cards keep mini grid and details popover", () => {
  assert.match(panel, /function statusInfoPopover\(text, label\)/);
  assert.match(panel, /\.section-desc \{[^}]*color: var\(--muted\)/s);
  assert.match(panel, /function renderResultEvidenceWorkbench\(/);
  assert.match(panel, /var\(--tree-col\)|always-visible three columns/);
  assert.match(panel, /grid-template-rows: auto auto minmax\(0, 1fr\)/);
  assert.match(panel, /function statusInfoPopover\(text, label\)/);
});
