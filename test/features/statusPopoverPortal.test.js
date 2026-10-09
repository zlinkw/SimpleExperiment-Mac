const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

// 7c23e89 基线：statusInfoPopover 用 details 弹层，带 hover/close 调度与图例条目。
test("status popovers use details layer with legend entries", () => {
  assert.match(panel, /function statusInfoPopover\(text, label\)/);
  assert.match(panel, /function scheduleStatusInfoPopoverClose\(details\)/);
  assert.match(panel, /let statusInfoPopoverTimers = new Map\(\)/);
  assert.match(panel, /function cleanupDetachedStatusInfoPopoverTimers\(\)/);
  assert.match(panel, /cleanupDetachedStatusInfoPopoverTimers\(\)/);
  assert.match(panel, /if \(!details\.isConnected\)/);
  assert.match(panel, /<details class="statusInfoPopover">/);
  assert.match(panel, /\.statusInfoPopoverBody \{ position: absolute/);
  assert.match(panel, /class="legendItem"/);
  assert.match(panel, /class="legendDot good"/);
});
