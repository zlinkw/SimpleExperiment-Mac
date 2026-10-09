const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("task timeline labels Worker live status without changing task status logic", () => {
  const livePillsStart = panel.indexOf("function taskLivePills(row)");
  const livePills = panel.slice(livePillsStart, panel.indexOf("function taskCardClass", livePillsStart));
  assert.match(livePills, /TASK_LIVE_STATUS_TOKENS\?\.has\(taskStatusToken\(String\(\(row \|\| \{\}\)\.status \|\| ""\)\)\)/);
  assert.match(livePills, /const worker = \(row \|\| \{\}\)\.serverId/);
  assert.doesNotMatch(livePills, /workerLiveStatus/);
  assert.match(panel, /taskCardClass\(row\.status\)/);
});

test("task progress card keeps raw Worker status in the tooltip", () => {
  assert.match(panel, /原始 Worker 状态：/);
  assert.match(panel, /Worker ' \+ esc\(labelStatus\(row\.workerLiveStatus\)\)/);
  assert.match(panel, /row\.workerTelemetryWarning \? '<div class="status-warning">'/);
});

test("Worker live status does not replace task terminal helpers", () => {
  assert.match(panel, /function taskTerminalStatus\(status\)/);
  assert.match(panel, /function taskFailureLikeStatus\(status\)/);
  assert.match(panel, /function taskArchivableStatus\(status\)/);
});
