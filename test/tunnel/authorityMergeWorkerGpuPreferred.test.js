const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeRealtimeStates } = require("../../dist/tunnel/MultiEndpointRealtimeClient.js");
const { createRealtimeState, applyRealtimeEvent } = require("../../dist/tunnel/RealtimeEventReducer.js");

test("fresh worker GPU telemetry is preferred over Hub fallback", () => {
  const hubState = applyRealtimeEvent(createRealtimeState(), {
    schemaVersion: 1,
    seq: 1,
    type: "gpu_snapshot",
    generatedAt: "2026-01-01T00:00:00Z",
    source: "hub_agent",
    workerId: "w1",
    payload: { gpus: [{ index: 0, name: "hub-copy" }] },
  });
  const workerState = applyRealtimeEvent(createRealtimeState(), {
    schemaVersion: 1,
    seq: 2,
    type: "gpu_snapshot",
    generatedAt: new Date().toISOString(),
    source: "worker_telemetry",
    payload: { gpus: [{ index: 0, name: "worker-direct" }] },
  });
  workerState.lastHeartbeatAt = new Date().toISOString();
  const state = mergeRealtimeStates([
    { endpoint: { id: "hub", role: "hub", localHost: "127.0.0.1", localPort: 18765 }, state: hubState },
    { endpoint: { id: "w1", role: "worker", localHost: "127.0.0.1", localPort: 18766 }, state: workerState },
  ]);
  assert.equal(state.gpu.w1[0].name, "worker-direct");
  assert.equal(state.gpu.w1[0].workerDirect, true);
});