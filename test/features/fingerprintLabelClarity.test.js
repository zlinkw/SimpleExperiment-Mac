const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("run gate names missing plan selection directly", () => {
  assert.match(panel, /selectedPlan \? "已选择" : "需要选择计划"/);
  assert.doesNotMatch(panel, /selectedPlan \? "已选择" : "需要 planFile"/);
  assert.doesNotMatch(panel, /"fp " \+ compactIdentifier\(sync\.fingerprint/);
});
