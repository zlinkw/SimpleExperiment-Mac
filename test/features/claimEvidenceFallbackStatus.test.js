const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("claim evidence preview and status prevent false completed result workflow", () => {
  assert.match(panel, /function claimEvidenceIssueCounts\(rows\)/);
  assert.match(panel, /status\.includes\("need"\)[\s\S]{0,80}needsExperiment \+= 1/);
  assert.match(panel, /status\.includes\("unsupported"\)[\s\S]{0,80}unsupported \+= 1/);
  assert.match(panel, /Math\.max\([\s\S]{0,300}previewIssueCounts\.unsupported[\s\S]{0,120}claimStatusText\.includes\("unsupported"\) \? 1 : 0/);
  assert.match(panel, /Math\.max\([\s\S]{0,300}previewIssueCounts\.needsExperiment[\s\S]{0,120}claimStatusText\.includes\("need"\) \? 1 : 0/);
  assert.match(panel, /status\.claimIssueCount[\s\S]{0,260}打开 claims\.md[\s\S]{0,120}paper\/claims\.md/);
});
