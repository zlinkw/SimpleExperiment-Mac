const assert = require("node:assert/strict");
const test = require("node:test");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("result contract links render as compact inline entries", () => {
  const html = renderPanelHtml();

  assert.match(html, /contractQuickLinks/);
  assert.match(html, /summaryLink/);
  assert.match(html, /data-anchor="results-dataset"/);
  assert.match(html, /data-anchor="results-checkpoints"/);
  assert.match(html, /data-anchor="results-plotting"/);
  assert.doesNotMatch(html, /summaryCard/);
});