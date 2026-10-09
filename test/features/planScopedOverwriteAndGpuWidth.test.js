const assert = require("node:assert/strict");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");
const scheduler = readSource("src/clusterSchedulerRuntime.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const agent = readSource("src/clusterAgentRuntime.ts");

test("overwrite confirmation derives exact existing job directories from the selected Plan", () => {
  assert.match(scheduler, /existing = detect_existing_outputs\(jobs\)/);
  assert.match(scheduler, /"existing": existing/);
  assert.match(extension, /await this\.confirmPlanExistingOutputs\(plan, body, preflightOk\)/);
  assert.match(extension, /validation\.existing/);
  assert.match(extension, /影响范围仅限当前 Plan/);
  assert.match(extension, /scheduler 现有 overwriteExisting\/--overwrite 语义/);
  assert.doesNotMatch(extension, /const checkRoots = \["work_dirs"/);
});

test("GPU table scales visible columns to panel width and scrolls below their minimum", () => {
  assert.match(panel, /denseTable\.style\.minWidth = denseTotal \+ "px"/);
  assert.match(panel, /ww \* 100 \/ denseTotal/);
  assert.match(panel, /var gearWidth = 64/);
});

test("scheduler watchdog does not fail a live Plan at a fixed elapsed time", () => {
  assert.doesNotMatch(agent, /if _elapsed > _hard_max:/);
  assert.match(agent, /_python_running and _elapsed > _launch_grace/);
});
