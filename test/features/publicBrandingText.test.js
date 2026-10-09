const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const ppt = readSource("src/PptPlotBridge.ts");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const legacyNotes = fs.readFileSync(path.join(root, "docs/technical-notes.md"), "utf8");

test("public user-facing labels use SimpleExperiment branding", () => {
  assert.doesNotMatch(extension, /ZLK GitHub|ZLK 结果|simple-results\.pptx|非 ZLK 登录后命令|当前 ZLK Agent|其它 ZLK Agent/);
  assert.doesNotMatch(panel, /写入 simple-\* RemoteCommand/);
  assert.doesNotMatch(ppt, /ZLK 结果/);
  assert.match(extension, /SimpleExperiment GitHub publish/);
  assert.match(extension, /SimpleExperiment 结果/);
  assert.match(extension, /simple-experiment-results\.pptx/);
  assert.match(panel, /写入 Agent RemoteCommand/);
  assert.match(ppt, /SimpleExperiment 结果/);
});

test("legacy technical identifiers remain compatible", () => {
  assert.match(extension, /\.simple-backup/);
  assert.match(extension, /__SIMPLE_EXPERIMENT_PROJECT_NAME__/);
  assert.match(legacyNotes, /统一命令 `simpleex run`/);
  assert.match(legacyNotes, /`SIMPLE_EXPERIMENT_AGENT_STATE_DIR`/);
});
