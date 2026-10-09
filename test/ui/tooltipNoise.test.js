const assert = require("node:assert/strict");
const test = require("node:test");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("native hover text excludes label-only noise", () => {
  const html = renderPanelHtml();

  assert.doesNotMatch(html, /title="快捷操作"/);
  assert.doesNotMatch(html, /title="无状态"/);
  assert.doesNotMatch(html, /title="目标验收矩阵"/);
  assert.doesNotMatch(html, /title="功能可用性"/);
  assert.doesNotMatch(html, /右键可折叠或展开此状态卡片/);
});
