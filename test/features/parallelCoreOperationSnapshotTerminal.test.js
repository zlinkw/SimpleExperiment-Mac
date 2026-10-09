const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyRealtimeEvent,
  applySnapshot,
  createRealtimeState,
} = require("../../dist/tunnel/RealtimeEventReducer.js");

function operation(status, extra = {}) {
  return {
    operationId: "op-run-plan",
    status,
    planFile: "experiments/plans/smoke.yaml",
    ...extra,
  };
}

test("initial snapshot restores operation terminal state", () => {
  const state = createRealtimeState({
    operations: [operation("completed", { completedAt: "2026-07-14T04:00:00.000Z" })],
  });

  assert.equal(state.operations["op-run-plan"].status, "completed");
  assert.equal(state.operations["op-run-plan"].planFile, "experiments/plans/smoke.yaml");
});

test("snapshot terminal survives a later progress event after reconnect", () => {
  let state = createRealtimeState();
  state = applySnapshot(state, {
    operations: [operation("completed", { completedAt: "2026-07-14T04:00:00.000Z" })],
  });
  state = applyRealtimeEvent(state, {
    schemaVersion: 1,
    seq: 12,
    generatedAt: "2026-07-14T04:00:01.000Z",
    source: "hub_agent",
    type: "operation_progress",
    operationId: "op-run-plan",
    payload: operation("running", { message: "delayed progress" }),
  });

  assert.equal(state.operations["op-run-plan"].status, "completed");
  assert.equal(state.operations["op-run-plan"].completedAt, "2026-07-14T04:00:00.000Z");
});

test("partial snapshot without operations preserves live operation state", () => {
  let state = createRealtimeState();
  state = applyRealtimeEvent(state, {
    schemaVersion: 1,
    seq: 3,
    generatedAt: "2026-07-14T04:00:00.000Z",
    source: "hub_agent",
    type: "operation_completed",
    operationId: "op-run-plan",
    payload: operation("completed"),
  });

  state = applySnapshot(state, { schedulerStates: [] });

  assert.equal(state.operations["op-run-plan"].status, "completed");
});

test("stale snapshot cannot replace a live terminal with running", () => {
  let state = createRealtimeState();
  state = applyRealtimeEvent(state, {
    schemaVersion: 1,
    seq: 20,
    generatedAt: "2026-07-14T04:00:02.000Z",
    source: "hub_agent",
    type: "operation_completed",
    operationId: "op-run-plan",
    payload: operation("completed", { completedAt: "2026-07-14T04:00:02.000Z" }),
  });

  state = applySnapshot(state, {
    operations: [operation("running", { updatedAt: "2026-07-14T04:00:01.000Z" })],
  });

  assert.equal(state.operations["op-run-plan"].status, "completed");
  assert.equal(state.operations["op-run-plan"].completedAt, "2026-07-14T04:00:02.000Z");
});
