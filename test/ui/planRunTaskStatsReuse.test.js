const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadTaskStats() {
  const sandbox = {
    overviewTaskStatsCacheRows: null,
    overviewTaskStatsCacheValue: null,
    schedulerRowsForState(state) { return state.rows; },
    taskFailureLikeStatus(status) { return new Set(["failed", "error", "stalled", "stopped", "cancelled"]).has(status); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("overviewTaskStats")}\nthis.check = overviewTaskStats;`, sandbox);
  return sandbox;
}

function trackedRows(statuses, counter) {
  return {
    forEach(callback) {
      counter.count += 1;
      statuses.forEach((status) => callback({ status }));
    },
  };
}

test("overview task statistics reuse stable scheduler rows and preserve status groups", () => {
  const sandbox = loadTaskStats();
  const scans = { count: 0 };
  const rows = trackedRows([
    "RUNNING", "testing", "queued", "pending", "failed", "error", "stalled",
    "stopped", "cancelled", "completed", "done", "unknown",
  ], scans);
  const state = { rows };
  const first = sandbox.check(state);

  assert.strictEqual(sandbox.check(state), first);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), { running: 2, queued: 2, failed: 5, completed: 2 });
  assert.equal(scans.count, 1);

  state.rows = trackedRows(["running", "completed"], scans);
  const refreshed = sandbox.check(state);
  assert.notStrictEqual(refreshed, first);
  assert.deepEqual(JSON.parse(JSON.stringify(refreshed)), { running: 1, queued: 0, failed: 0, completed: 1 });
  assert.equal(scans.count, 2);
});

test("Plan run workbench consumes the shared task statistics", () => {
  const source = extractFunction("renderPlanRunWorkbench");
  assert.match(source, /const taskStats = overviewTaskStats\(state\)/);
  assert.match(source, /const running = taskStats\.running/);
  assert.match(source, /const queued = taskStats\.queued/);
  assert.match(source, /const failed = taskStats\.failed/);
  assert.doesNotMatch(source, /rows\.filter\(/);
  assert.doesNotMatch(source, /const rows = schedulerRowsForState\(state\)/);
});
