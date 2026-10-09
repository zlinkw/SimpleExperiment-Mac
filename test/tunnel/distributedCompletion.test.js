const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRealtimeState, applyRealtimeEvent } = require("../../dist/tunnel/RealtimeEventReducer.legacy.js");

test("Worker terminal event updates the task immediately for queue wakeup", () => {
  const initial = createRealtimeState();
  const next = applyRealtimeEvent(initial, {
    schemaVersion: 1, seq: 1, type: "worker_task_completed", generatedAt: "2026-09-25T00:00:00Z",
    source: "worker_telemetry", workerId: "nwpu2", serverId: "nwpu2", operationId: "command-a",
    payload: { commandId: "command-a", workerId: "nwpu2", case: "bus", seed: 42, status: "completed" },
  });
  assert.equal(next.workerTasks.nwpu2[0].commandId, "command-a");
  assert.equal(next.workerTasks.nwpu2[0].status, "completed");
});
