const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

// 7c23e89 基线：helpBadge 保留悬浮问号徽标，带 title 帮助文案。
test("helpBadge injects a hover help mark with title text", () => {
  assert.match(panel, /function helpBadge\(help\) \{[\s\S]*?return help \? '<span class="helpBadge" title="' \+ escAttr\(help\) \+ '">[^<]*<\/span>' : "";/);
  assert.match(panel, /class="helpBadge"/);
});
