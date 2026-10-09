const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("extension compacts experiment trace payload for all-day webview runs", () => {
  const source = readSource("src/extension.ts");
  const buildStateStart = source.indexOf("private buildState(options:");
  const buildState = source.slice(buildStateStart, source.indexOf("private buildPanelFallbackState", buildStateStart));
  const compact = source.match(/function compactExperimentTraces[\s\S]*?const schedulerBucketKeys/)?.[0] || "";

  assert.match(source, /const EXPERIMENT_TRACE_RECORD_LIMIT = 240/);
  assert.match(source, /const EXPERIMENT_TRACE_ATTENTION_LIMIT = 120/);
  assert.match(buildState, /this\.compactExperimentTracesForPanel\(/);
  assert.match(buildState, /this\.cachedExperimentTracesProjection\(/);
  assert.match(buildState, /this\.traceProtectedKeys\(\)/);
  assert.match(compact, /experimentTraceMatchesProtectedKey/);
  assert.match(compact, /experimentTraceNeedsAttention/);
  assert.match(compact, /const selectedKeys = new Set\(\)/);
  assert.match(compact, /selectedKeys\.has\(key\)/);
  assert.match(compact, /selectedKeys\.add\(key\)/);
  assert.doesNotMatch(compact, /out\.some\(/);
  assert.match(compact, /const sortedInput = sortExperimentTraces\(input\)/);
  assert.match(compact, /const protectedRows = \[\]/);
  assert.match(compact, /const selectedPlanRows = \[\]/);
  assert.match(compact, /const attentionRows = \[\]/);
  assert.match(compact, /for \(const row of sortedInput\)/);
  assert.doesNotMatch(compact, /sortedInput\.filter\(/);
  assert.match(compact, /rank: experimentTraceRank\(row\)/);
  assert.match(compact, /time: experimentTraceTime\(row\)/);
  assert.match(compact, /a\.index - b\.index/);
  assert.match(compact, /sortedInput\.forEach\(add\)/);
  assert.equal((compact.match(/sortExperimentTraces\(/g) || []).length, 2);
  assert.match(source, /experimentTracePayloadBudget: EXPERIMENT_TRACE_RECORD_LIMIT/);
});

test("architecture records the experiment trace payload budget", () => {
  const architecture = fs.readFileSync(path.join(root, "docs", "architecture.md"), "utf8");
  assert.match(architecture, /Long-lived Webview payloads stay bounded/);
  assert.match(architecture, /experiment traces/);
});
