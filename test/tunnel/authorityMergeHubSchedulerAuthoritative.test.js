const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeRealtimeStates } = require("../../dist/tunnel/MultiEndpointRealtimeClient.js");
const { createRealtimeState, applyRealtimeEvent } = require("../../dist/tunnel/RealtimeEventReducer.js");

test("worker telemetry cannot overwrite hub terminal scheduler states", () => {
  const hubState = applyRealtimeEvent(createRealtimeState(), {
    schemaVersion: 1,
    seq: 10,
    type: "scheduler_snapshot",
    generatedAt: "2026-01-01T00:00:00Z",
    source: "hub_agent",
    payload: { schedulerStates: [{ runKey: "A", status: "completed" }] },
  });
  const workerState = applyRealtimeEvent(createRealtimeState(), {
    schemaVersion: 1,
    seq: 11,
    type: "worker_task_snapshot",
    generatedAt: "2026-01-01T00:00:01Z",
    source: "worker_telemetry",
    workerId: "w1",
    payload: { tasks: [{ schemaVersion: 1, workerId: "w1", runKey: "A", localStatus: "pid_alive", pid: 123, lastSeenAt: "2026-01-01T00:00:01Z" }] },
  });
  workerState.lastHeartbeatAt = new Date().toISOString();
  const state = mergeRealtimeStates([
    { endpoint: { id: "hub", role: "hub", localHost: "127.0.0.1", localPort: 18765 }, state: hubState },
    { endpoint: { id: "w1", role: "worker", localHost: "127.0.0.1", localPort: 18766 }, state: workerState },
  ]);
  assert.equal(state.schedulerStates[0].status, "completed");
  assert.equal(state.schedulerStates[0].workerLiveStatus, "pid_alive");
  assert.match(state.schedulerStates[0].workerTelemetryWarning, /Hub completed/);
});