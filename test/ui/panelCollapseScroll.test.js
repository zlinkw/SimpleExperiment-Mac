const test = require("node:test");
const assert = require("node:assert/strict");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("card collapse preserves scroll and does not reorder every card", () => {
  const html = renderPanelHtml();
  assert.match(html, /event\.stopPropagation\(\)/);
  assert.match(html, /preserveScroll\(\(\) => applyUiLayout/);
  assert.match(html, /function preserveScroll\(work\)/);
  assert.match(html, /deck\.insertBefore\(card, cursor\)/);
  assert.doesNotMatch(html, /if \(card\) deck\.appendChild\(card\)/);
  assert.doesNotMatch(html, /deck\.appendChild\(card\)/);
});