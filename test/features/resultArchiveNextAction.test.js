const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("result panel hides legacy archive and delete entry points", () => {
  assert.match(panel, /archivableCount: traceStats\.archivable/);
  assert.match(panel, /archiveBlockedCount: traceStats\.archiveBlocked/);
  assert.match(panel, /archivedCount <= 0 && Number\(status\.archivableCount \|\| 0\) > 0[\s\S]{0,100}kind: "archive"/);
  assert.match(panel, /archivedCount <= 0 && Number\(status\.archiveBlockedCount \|\| 0\) > 0[\s\S]{0,110}kind: "archive-blocked"/);
  assert.match(panel, /待归档 [\s\S]{0,80}条实验记录/);
  assert.match(panel, /条记录缺少 Worker，暂不可归档/);
  assert.match(panel, /data-section-target="results" data-anchor-target="results-traces"[^>]*>选择实验记录/);
  assert.match(panel, /usableTaskKey\(item\.workerId\)\) stats\.archivable \+= 1;[\s\S]{0,80}else stats\.archiveBlocked \+= 1/);
  assert.match(panel, /function isArchivableTraceStatus\(status\)/);
  assert.doesNotMatch(panel, /traceActionButton\("归档", "archiveArtifacts", row, true\)/);
  assert.doesNotMatch(panel, /traceActionButton\("删除", "deleteArtifacts", row, true, true\)/);
  assert.match(panel, /\["archive", "archive-blocked", "review"\]\.includes\(stage\.kind\)\) return ""/);
});
