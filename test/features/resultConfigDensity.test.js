const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

// 7c23e89 基线结果区：result evidence workbench + details popover；解释文案保留。
test("result/config keeps evidence workbench and popover guidance", () => {
  assert.match(panel, /function renderResultEvidenceWorkbench\(state, summary\)/);
  assert.match(panel, /function statusInfoPopover\(text, label\)/);
  assert.match(panel, /\.empty-state \{/);
});
