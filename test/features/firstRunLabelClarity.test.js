const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("run gate explains code synchronization and fingerprint in Chinese", () => {
  assert.match(panel, /planRunRow\("运行前同步"/);
  assert.match(panel, /"代码指纹 " \+ compactIdentifier\(sync\.fingerprint/);
  assert.match(panel, /syncReady \? "代码指纹已确认" : "运行时自动同步"/);
  assert.match(panel, /data-command="runPlan"/);
});
