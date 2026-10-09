const test = require("node:test");
const assert = require("node:assert/strict");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("overview hides internal seq and only shows paused state when active", () => {
  const html = renderPanelHtml();
  assert.doesNotMatch(html, /row\("最后 seq"/);
  assert.doesNotMatch(html, /row\("已暂停"/);
  assert.match(html, /paused: "已暂停"/);
});
