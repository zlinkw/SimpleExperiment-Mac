const assert = require("node:assert/strict");
const test = require("node:test");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("recent action errors render as compact rows", () => {
  const html = renderPanelHtml();

  assert.match(html, /errorRow/);
  assert.doesNotMatch(html, /errorCard/);
});
