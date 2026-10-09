const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("panel distinguishes initial loading from a loaded empty operation list", () => {
  assert.match(panel, /id="initialStateNotice"[\s\S]{0,240}正在读取本地面板状态/);
  assert.match(panel, /function requestInitialPanelState\(\)[\s\S]{0,700}command: "webviewReady"/);
  assert.match(panel, /尚未收到本地面板状态。[\s\S]{0,180}retry\.hidden = false/);
  assert.match(panel, /if \(latestStateMessage\) \{[\s\S]{0,1600}completeInitialPanelState\(\)/);
  assert.match(panel, /function completeInitialPanelState\(\)[\s\S]{0,320}notice\.hidden = true/);
  assert.match(panel, /'<div class="empty-state">尚无操作记录。<\/div>'/);
});
