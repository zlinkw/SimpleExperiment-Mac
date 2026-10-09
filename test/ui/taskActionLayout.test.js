const test = require("node:test");
const assert = require("node:assert/strict");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("task row actions use normal-sized action buttons", () => {
  const html = renderPanelHtml();
  assert.doesNotMatch(html, /id="taskTable"|id="taskDetailPane"/);
  assert.match(html, /\.taskActions \{ display: flex; flex-wrap: wrap; gap: 6px; align-items: center; \}/);
  assert.match(html, /\.taskActionButton \{ min-height: 30px; padding: 6px 10px; font-size: 12px;/);
  assert.match(html, /'<div class="taskActions">' \+ actions \+ '<\/div>'/);
  assert.match(html, /'<button class="taskActionButton" data-command="'/);
});
