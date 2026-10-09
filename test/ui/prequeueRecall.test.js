const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panel = fs.readFileSync(path.resolve(__dirname, '../../src/ui/PanelHtml.legacy.ts'), 'utf8');
const extension = fs.readFileSync(path.resolve(__dirname, '../../src/extension/legacy.ts'), 'utf8');

test('Plan and job recall controls send exact Plan identity and only expose queued work', () => {
  assert.match(panel, /"recallPlanToLocalQueue"/);
  assert.match(panel, /data-command="recallPlanToLocalQueue" data-plan-id=/);
  assert.match(panel, /data-job-index=/);
  assert.match(panel, /status === "queued" \|\| job\.recallRequested === true/);
  assert.match(panel, /currentJobs\.some\(\(job\) => String\(job\.status \|\| ""\) === "queued" \|\| job\.recallRequested === true\)/);
  assert.match(panel, /recallPlanIds\.length === 1/);
  assert.match(panel, /escAttr\(recallPlanIds\[0\]\)/);
  assert.match(panel, /if \(button\.dataset\.jobIndex !== undefined\) payload\.jobIndex = Number\(button\.dataset\.jobIndex\)/);
  assert.match(extension, /case "recallPlanToLocalQueue":/);
  assert.match(extension, /async recallPlanToLocalQueueFromUi\(message\)/);
});

test('Plan policy and per-job recall state reach the panel without losing restart intent', () => {
  assert.match(extension, /localDispatchOverride: plan\.localDispatchOverride === true/);
  assert.match(extension, /localQueueOnly: job\.localQueueOnly === true, recallRequested: job\.recallRequested === true/);
  assert.match(extension, /recallOperationId: job\.recallOperationId \|\| ""/);
  assert.match(panel, /group\.localDispatchOverride = plan\.localDispatchOverride === true/);
  assert.match(panel, /job\.recallRequested \? "重试召回" : "召回到本机"/);
});
