const assert = require("node:assert/strict");
const test = require("node:test");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("sync publish panel is compact without nested progress card header", () => {
  const html = renderPanelHtml();

  // 单链第二步：旧 sync 节三 div 已下线（CSS 类名保留仅为样式兼容，不代表 DOM）
  assert.doesNotMatch(html, /<div class="syncPublishPanel"/);
  assert.doesNotMatch(html, /data-anchor="sync-publish"/);
  assert.doesNotMatch(html, /id="publishFlow"/);
  assert.doesNotMatch(html, /id="publishActions"/);
  assert.doesNotMatch(html, /id="codeSyncState"/);
  assert.doesNotMatch(html, /发布与代码同步/);
  assert.doesNotMatch(html, /sync-publish[\s\S]*progressCard/);
  // 新链锚点必须存在
  assert.match(html, /data-anchor="settings-chain-overview"/);
});
