const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const {
  applyRealtimeEvent,
  compactRealtimeState,
  createRealtimeState,
  REALTIME_FILE_TRANSFER_RECORD_LIMIT,
  REALTIME_OPERATION_RECORD_LIMIT,
  REALTIME_SCHEDULER_RECORD_LIMIT,
  REALTIME_TRACE_RECORD_LIMIT,
  REALTIME_WORKER_TASK_RECORD_LIMIT,
} = require("../../dist/tunnel/RealtimeEventReducer.js");
const { mergeAuthorityRealtimeStates } = require("../../dist/tunnel/AuthorityMergePolicy.js");

test("realtime reducer caps traces operations transfers and last known good", () => {
  let state = createRealtimeState();
  for (let seq = 1; seq <= REALTIME_TRACE_RECORD_LIMIT + 30; seq += 1) {
    state = applyRealtimeEvent(state, event(seq, "experiment_trace", { runKey: `run-${seq}`, status: "completed" }));
  }
  assert.equal(state.experimentTraces.length, REALTIME_TRACE_RECORD_LIMIT);
  assert.equal(state.experimentTraces.some((row) => row.runKey === "run-1"), false);
  assert.equal(state.lastKnownGood.experimentTraces.length, REALTIME_TRACE_RECORD_LIMIT);

  for (let seq = 1000; seq < 1000 + REALTIME_OPERATION_RECORD_LIMIT + 30; seq += 1) {
    state = applyRealtimeEvent(state, {
      ...event(seq, "operation_completed", { operationId: `op-${seq}`, status: "completed" }),
      operationId: `op-${seq}`,
    });
  }
  assert.equal(Object.keys(state.operations).length, REALTIME_OPERATION_RECORD_LIMIT);
  assert.equal(Boolean(state.operations["op-1000"]), false);

  for (let seq = 2000; seq < 2000 + REALTIME_FILE_TRANSFER_RECORD_LIMIT + 30; seq += 1) {
    state = applyRealtimeEvent(state, {
      ...event(seq, "file_transfer_progress", { transferId: `transfer-${seq}`, status: "completed" }),
      transferId: `transfer-${seq}`,
    });
  }
  assert.equal(Object.keys(state.fileTransfers).length, REALTIME_FILE_TRANSFER_RECORD_LIMIT);
  assert.equal(Boolean(state.fileTransfers["transfer-2000"]), false);
});

test("snapshot and authority merge apply realtime state budgets", () => {
  const schedulerRows = Array.from({ length: REALTIME_SCHEDULER_RECORD_LIMIT + 20 }, (_, i) => ({ runKey: `sched-${i}`, status: "completed", seq: i }));
  const traceRows = Array.from({ length: REALTIME_TRACE_RECORD_LIMIT + 20 }, (_, i) => ({ runKey: `trace-${i}`, status: "archived", seq: i }));
  const workerTasks = Array.from({ length: REALTIME_WORKER_TASK_RECORD_LIMIT + 20 }, (_, i) => ({ runKey: `worker-${i}`, localStatus: "process_gone", lastSeenAt: `2026-07-05T00:${String(i % 60).padStart(2, "0")}:00Z` }));
  const state = compactRealtimeState({
    ...createRealtimeState({ schedulerStates: schedulerRows, experimentTraces: traceRows }),
    workerTasks: { w1: workerTasks },
  });
  assert.equal(state.schedulerStates.length, REALTIME_SCHEDULER_RECORD_LIMIT);
  assert.equal(state.experimentTraces.length, REALTIME_TRACE_RECORD_LIMIT);
  assert.equal(state.workerTasks.w1.length, REALTIME_WORKER_TASK_RECORD_LIMIT);
  assert.equal(state.lastKnownGood.schedulerStates.length, REALTIME_SCHEDULER_RECORD_LIMIT);

  const merged = mergeAuthorityRealtimeStates([
    { endpoint: { id: "hub", role: "hub" }, state },
    { endpoint: { id: "w1", role: "worker" }, state: { ...createRealtimeState(), lastHeartbeatAt: new Date().toISOString(), workerTasks: { w1: workerTasks } } },
  ]);
  assert.equal(merged.schedulerStates.length, REALTIME_SCHEDULER_RECORD_LIMIT);
  assert.equal(merged.experimentTraces.length, REALTIME_TRACE_RECORD_LIMIT);
  assert.equal(merged.workerTasks.w1.length, REALTIME_WORKER_TASK_RECORD_LIMIT);
  assert.equal(merged.lastKnownGood.experimentTraces.length, REALTIME_TRACE_RECORD_LIMIT);
});

test("realtime compaction reuses state branches that are already within budget", () => {
  const schedulerStates = [{ running_experiments: [{ runKey: "run-1", status: "running" }] }];
  const experimentTraces = [{ runKey: "run-1", status: "running" }];
  const operations = { "op-1": { status: "running", seq: 1 } };
  const fileTransfers = { "transfer-1": { status: "running", seq: 1 } };
  const workerTasks = { worker1: [{ runKey: "run-1", status: "running" }] };
  const lastKnownGood = { gpu: {}, schedulerStates, experimentTraces };
  const compacted = compactRealtimeState({
    ...createRealtimeState(),
    schedulerStates,
    experimentTraces,
    operations,
    fileTransfers,
    workerTasks,
    lastKnownGood,
  });
  assert.equal(compacted.schedulerStates, schedulerStates);
  assert.equal(compacted.experimentTraces, experimentTraces);
  assert.equal(compacted.operations, operations);
  assert.equal(compacted.fileTransfers, fileTransfers);
  assert.equal(compacted.workerTasks, workerTasks);
  assert.equal(compacted.lastKnownGood, lastKnownGood);
});

test("realtime compaction reuses fixed status rank tables", () => {
  const source = readSource("src/tunnel/RealtimeEventReducer.ts");
  assert.match(source, /const realtimeRecordStatusRanks = new Map<string, number>\(\[/);
  assert.match(source, /const genericRowStatusRanks = new Map<string, number>\(\[/);
  assert.match(source, /return realtimeRecordStatusRanks\.get\(genericStatus\(row\)\) \?\? 2/);
  assert.match(source, /return genericRowStatusRanks\.get\(genericStatus\(row\)\) \?\? 2/);

  const experimentTraces = Array.from({ length: REALTIME_TRACE_RECORD_LIMIT }, (_, index) => ({
    runKey: `completed-${index}`,
    status: "completed",
    seq: index,
  })).concat([
    { runKey: "active", status: "testing", seq: 1 },
    { runKey: "failed", status: "residue", seq: 1 },
    { runKey: "unknown", status: "custom", seq: 1 },
  ]);
  const operations = Object.fromEntries(Array.from({ length: REALTIME_OPERATION_RECORD_LIMIT }, (_, index) => [
    `completed-${index}`,
    { status: "completed", seq: index },
  ]).concat([
    ["active", { status: "accepted", seq: 1 }],
    ["failed", { status: "error", seq: 1 }],
    ["unknown", { status: "custom", seq: 1 }],
  ]));
  const compacted = compactRealtimeState({
    ...createRealtimeState(),
    experimentTraces,
    operations,
  });
  assert.equal(compacted.experimentTraces.some((row) => row.runKey === "active"), true);
  assert.equal(compacted.experimentTraces.some((row) => row.runKey === "failed"), true);
  assert.equal(compacted.experimentTraces.some((row) => row.runKey === "unknown"), true);
  assert.equal(Boolean(compacted.operations.active), true);
  assert.equal(Boolean(compacted.operations.failed), true);
  assert.equal(Boolean(compacted.operations.unknown), true);
});

function event(seq, type, payload) {
  return {
    schemaVersion: 1,
    seq,
    type,
    generatedAt: `2026-07-05T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    source: "hub_agent",
    payload,
  };
}
