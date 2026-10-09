const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function renderPanelHtmlFromSource(source) {
  return require("../../dist/ui/PanelHtml.js").renderPanelHtml();
}

test("legend tree and first-paint placeholders are restored", () => {
  assert.match(panel, /\.statusLegend \{/);
  assert.match(panel, /\.legendItem \{[\s\S]*display: inline-flex/);
  assert.match(panel, /\.legendDot \{/);
  assert.match(panel, /\.legendDot\.good \{/);
  assert.match(panel, /\.legendDot\.info \{/);
  assert.match(panel, /\.legendDot\.warn \{/);
  assert.match(panel, /\.legendDot\.error \{/);
  assert.match(panel, /\.legendDot\.mine \{/);
  assert.match(panel, /\.tree-item, \.tree-object \{/);
  assert.match(panel, /\.tree-search \{/);
  assert.match(panel, /\.workbenchInspector \{[\s\S]*display: grid/s);
  assert.match(panel, /id="resourceTreeBody"><\/div>/);
  assert.match(panel, /id="workbenchInspector"[^>]*><\/aside>/);
  assert.match(panel, /\.workbench-summary \{ display: grid/);
  assert.match(panel, /id="serverCards" data-anchor="servers-list"><\/div>/);
  // densify retained
  assert.match(panel, /端口冲突 /);
  const html = renderPanelHtmlFromSource(panel);
  assert.match(html, /class="legendDot good"/);
  assert.match(html, /id="cardDeck"/);
  assert.match(html, /id="mainColumn"/);
});
