const test = require("node:test");
const assert = require("node:assert/strict");

const { applyRealtimeEvent, createRealtimeState } = require("../../dist/tunnel/RealtimeEventReducer.js");

test("file_changed event is accepted and advances seq", () => {
  const state = applyRealtimeEvent(createRealtimeState(), {
    schemaVersion: 1,
    seq: 3,
    type: "file_changed",
    generatedAt: new Date().toISOString(),
    source: "hub_agent",
    payload: { path: "work_dirs/a/metrics_summary.csv", changeType: "modified" },
  });
  assert.equal(state.lastSeq, 3);
  assert.deepEqual(state.warnings, []);
});
