const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("project next actions respond to the actual main-column width", () => {
  assert.match(panel, /\.mainColumn \{[^}]*container: main-workflow \/ inline-size/);
  const start = panel.indexOf("@container main-workflow (max-width: 520px)");
  const end = panel.indexOf(".projectPathButton", start);
  assert.ok(start >= 0 && end > start);
  const query = panel.slice(start, end);

  assert.match(query, /\.projectQuickNext \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(query, /\.projectQuickNext b \{[^}]*white-space: normal[^}]*overflow-wrap: anywhere/);
  assert.match(query, /\.projectQuickNext > button, \.projectQuickNext > \.projectQuickActions \{[^}]*width: 100%/);
  assert.match(query, /\.projectQuickNext > \.projectQuickActions > button \{[^}]*flex: 1 1 100%/);
});

test("wide-column project workflow keeps the existing compact row layout", () => {
  assert.match(panel, /\.projectQuickNext \{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto/);
  assert.match(panel, /\.projectQuickNext b \{[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/);
  assert.match(panel, /\.projectQuickActions \{[^}]*display: flex[^}]*flex-wrap: wrap/);
});
