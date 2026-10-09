const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("extension compacts scheduler state payload for all-day webview runs", () => {
  const source = readSource("src/extension.ts");
  const runtimeEvidence = source.match(/private buildPlanRuntimeEvidenceState\(\)[\s\S]*?return \{ connectionMode, realtimeState, snapshot, offlineSnapshot, schedulerStates, operations \};/)?.[0] || "";
  const compact = source.match(/function compactSchedulerStates[\s\S]*?function operationsRecord/)?.[0] || "";

  assert.match(source, /const SCHEDULER_STATE_RECORD_LIMIT = 240/);
  assert.match(source, /const SCHEDULER_ACTIVE_BUCKET_LIMIT = 160/);
  assert.match(source, /const SCHEDULER_TERMINAL_BUCKET_LIMIT = 80/);
  assert.match(runtimeEvidence, /const schedulerStates = compactSchedulerStates\(/);
  assert.match(runtimeEvidence, /this\.schedulerProtectedKeys\(\)/);
  assert.match(compact, /completed_experiments/);
  assert.match(compact, /uiOmittedSchedulerRows/);
  assert.match(compact, /schedulerRowMatchesProtectedKey/);
  assert.match(compact, /compactFlatSchedulerRows/);
  assert.match(compact, /const active = \[\];\s*const rest = \[\];\s*for \(const row of rows\)/);
  assert.doesNotMatch(compact, /rest = rows\.filter\(\(row\) => !active\.includes\(row\)\)/);
});

test("architecture records the all-day scheduler payload budget", () => {
  const architecture = fs.readFileSync(path.join(root, "docs", "architecture.md"), "utf8");
  assert.match(architecture, /Long-lived Webview payloads stay bounded/);
  assert.match(architecture, /Scheduler states/);
});
