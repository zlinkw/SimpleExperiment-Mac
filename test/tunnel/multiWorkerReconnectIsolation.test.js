const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeRealtimeStates } = require("../../dist/tunnel/MultiEndpointRealtimeClient.js");
const { createRealtimeState, applyRealtimeEvent } = require("../../dist/tunnel/RealtimeEventReducer.js");

test("one stale worker does not clear other worker telemetry", () => {
  const fresh = applyRealtimeEvent(createRealtimeState(), {
    schemaVersion: 1,
    seq: 1,
    type: "gpu_snapshot",
    generatedAt: new Date().toISOString(),
    source: "worker_telemetry",
    payload: { gpus: [{ index: 0, name: "fresh" }] },
  });
  fresh.lastHeartbeatAt = new Date().toISOString();
  const stale = applyRealtimeEvent(createRealtimeState(), {
    schemaVersion: 1,
    seq: 1,
    type: "gpu_snapshot",
    generatedAt: "2020-01-01T00:00:00Z",
    source: "worker_telemetry",
    payload: { gpus: [{ index: 0, name: "stale" }] },
  });
  stale.lastHeartbeatAt = "2020-01-01T00:00:00Z";
  const state = mergeRealtimeStates([
    { endpoint: { id: "w1", role: "worker", localHost: "127.0.0.1", localPort: 18766 }, state: fresh },
    { endpoint: { id: "w2", role: "worker", localHost: "127.0.0.1", localPort: 18767 }, state: stale },
  ]);
  assert.equal(state.gpu.w1[0].name, "fresh");
  assert.equal(state.gpu.w2, undefined);
  assert.ok(state.warnings.some((warning) => warning.includes("w2")));
});