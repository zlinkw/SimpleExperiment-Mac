const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { enrichSchedulerRows, mergeAuthorityRealtimeStates } = require("../../dist/tunnel/AuthorityMergePolicy.js");
const { createRealtimeState } = require("../../dist/tunnel/RealtimeEventReducer.js");
const { readSource } = require("../_helpers/sourceReader");

test("worker task telemetry enriches hub scheduler rows only", () => {
  const warnings = [];
  const rows = enrichSchedulerRows([{ runKey: "r1", status: "running", workerId: "w1" }], [{
    schemaVersion: 1,
    workerId: "w1",
    runKey: "r1",
    localStatus: "process_gone",
    lastSeenAt: "2026-01-01T00:00:00Z",
  }], warnings);
  assert.equal(rows[0].status, "running");
  assert.equal(rows[0].workerLiveStatus, "process_gone");
  assert.match(rows[0].workerTelemetryWarning, /does not detect/);
  assert.ok(warnings.some((item) => item.includes("r1")));
});

test("authority merge reuses latest worker task for scheduler and trace enrichment", () => {
  const hub = createRealtimeState({
    schedulerStates: [{ runKey: "r1", status: "running" }],
    experimentTraces: [{ runKey: "r1", status: "running" }],
  });
  const worker = {
    ...createRealtimeState(),
    workerTasks: {
      w1: [
        { schemaVersion: 1, workerId: "w1", runKey: "r1", localStatus: "pid_alive", pid: 10, lastSeenAt: "2026-01-01T00:00:00Z" },
        { schemaVersion: 1, workerId: "w1", runKey: "r1", localStatus: "log_updating", pid: 20, lastSeenAt: "2026-01-01T00:00:01Z" },
      ],
    },
  };
  const merged = mergeAuthorityRealtimeStates([
    { endpoint: { id: "hub", role: "hub" }, state: hub },
    { endpoint: { id: "w1", role: "worker" }, state: worker },
  ]);

  assert.equal(merged.schedulerStates[0].workerPid, 20);
  assert.equal(merged.schedulerStates[0].workerLiveStatus, "log_updating");
  assert.equal(merged.experimentTraces[0].localPid, 20);
  assert.equal(merged.experimentTraces[0].liveStatus, "log_updating");

  const source = readSource("src/tunnel/AuthorityMergePolicy.ts");
  assert.match(source, /const workerTasksByRunKey = indexWorkerTasks\(workerTasks\)/);
  assert.match(source, /enrichSchedulerRows\([^;]+workerTasksByRunKey\)/);
  assert.match(source, /enrichTraceRows\([^;]+workerTasksByRunKey\)/);
});
