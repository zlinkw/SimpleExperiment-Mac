const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

// 7c23e89 基线：empty-state 用统一虚线占位（无 compact 变体），结果用 evidence workbench + statusInfoPopover details。
test("main path empty states stay readable and result workbench renders", () => {
  assert.match(panel, /\.empty-state \{/);
  assert.match(panel, /\.empty-state \{[^}]*display: grid[^}]*color: var\(--muted\)/s);
  assert.match(panel, /function renderResultEvidenceWorkbench\(state, summary\)/);
  assert.match(panel, /function statusInfoPopover\(text, label\)/);
  assert.match(panel, /var\(--tree-col\)|always-visible three columns/);
});
