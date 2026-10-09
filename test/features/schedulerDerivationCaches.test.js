const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");
const extension = readSource("src/extension.ts");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function extractDeclaration(source, name) {
  const start = source.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing declaration ${name}`);
  const end = source.indexOf(";", start);
  return source.slice(start, end + 1);
}

test("frontend scheduler rows skip repeated expansion inside one state", () => {
  const sandbox = {
    EMPTY_SCHEDULER_STATES: [],
    schedulerRowsCacheState: null,
    schedulerRowsCacheSource: null,
    schedulerRowsCacheSignature: "",
    schedulerRowsCacheRows: [],
    sourceReads: 0,
    normalizations: 0,
    schedulerRowsSourceModel(source) {
      sandbox.sourceReads += 1;
      return { flat: source, signature: source.map((row) => `${row.id}:${row.status}`).join("|") };
    },
    normalizeExpandedSchedulerRows(rows) {
      sandbox.normalizations += 1;
      return rows.map((row) => ({ ...row }));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(panel, "schedulerRowsForState")}\nthis.rowsForState = schedulerRowsForState;`, sandbox);

  const source = [{ id: "task-a", status: "running" }];
  const firstState = { schedulerStates: source };
  const first = sandbox.rowsForState(firstState);
  assert.equal(sandbox.rowsForState(firstState), first);
  assert.deepEqual({ sourceReads: sandbox.sourceReads, normalizations: sandbox.normalizations }, { sourceReads: 1, normalizations: 1 });

  const nextState = { schedulerStates: source };
  assert.equal(sandbox.rowsForState(nextState), first);
  assert.deepEqual({ sourceReads: sandbox.sourceReads, normalizations: sandbox.normalizations }, { sourceReads: 2, normalizations: 1 });

  source[0].status = "completed";
  const changed = sandbox.rowsForState({ schedulerStates: source });
  assert.notEqual(changed, first);
  assert.equal(changed[0].status, "completed");
  assert.deepEqual({ sourceReads: sandbox.sourceReads, normalizations: sandbox.normalizations }, { sourceReads: 3, normalizations: 2 });

  const replacement = sandbox.rowsForState({ schedulerStates: [{ id: "task-a", status: "completed" }] });
  assert.notEqual(replacement, changed);
  assert.deepEqual({ sourceReads: sandbox.sourceReads, normalizations: sandbox.normalizations }, { sourceReads: 4, normalizations: 3 });
});

test("backend Plan archive scheduler rows reuse one runtime state and invalidate on replacement", () => {
  const sandbox = {
    EMPTY_PLAN_ARCHIVE_SCHEDULER_ROWS: [],
    planArchiveSchedulerRowsCacheState: null,
    planArchiveSchedulerRowsCacheSource: null,
    planArchiveSchedulerRowsCacheValue: [],
    flattenCalls: 0,
    flattenPlanArchiveSchedulerRows(source) {
      sandbox.flattenCalls += 1;
      return source.map((row) => ({ ...row }));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(extension, "planArchiveSchedulerRowsForState")}\nthis.rowsForState = planArchiveSchedulerRowsForState;`, sandbox);

  const source = [{ id: "task-a" }];
  const firstState = { schedulerStates: source };
  const first = sandbox.rowsForState(firstState);
  assert.equal(sandbox.rowsForState(firstState), first);
  assert.equal(sandbox.flattenCalls, 1);

  const nextState = { schedulerStates: source };
  const next = sandbox.rowsForState(nextState);
  assert.notEqual(next, first);
  assert.equal(sandbox.rowsForState(nextState), next);
  assert.equal(sandbox.flattenCalls, 2);

  const replacement = sandbox.rowsForState({ schedulerStates: [{ id: "task-b" }] });
  assert.equal(replacement[0].id, "task-b");
  assert.equal(sandbox.flattenCalls, 3);
});

test("Plan archive scheduler flattening preserves bucket status and parent version", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(extension, "flattenPlanArchiveSchedulerRows")}\nthis.flatten = flattenPlanArchiveSchedulerRows;`, sandbox);
  const rows = sandbox.flatten([{
    planFile: "experiments/plans/a.yaml",
    planRevision: "r1",
    running_experiments: [{ runKey: "run-a" }],
    failed_experiments: [{ runKey: "run-b", status: "error", planRevision: "r2" }],
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { runKey: "run-a", status: "running", planFile: "experiments/plans/a.yaml", planRevision: "r1" },
    { runKey: "run-b", status: "error", planFile: "experiments/plans/a.yaml", planRevision: "r2" },
  ]);
});

test("backend scheduler fallback preserves terminal task data while refreshing fixed Worker observations", () => {
  const sandbox = {
    schedulerRowStatus: (row) => String(row?.status || row?.state || "").toLowerCase(),
    schedulerStatusTerminal: (status) => ["completed", "failed", "cancelled"].includes(status),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractDeclaration(extension, "SCHEDULER_FALLBACK_LIVE_FIELDS"),
    extractFunction(extension, "mergeFallbackRow"),
    extractFunction(extension, "mergeSchedulerFallbackRow"),
    "this.api = { fields: SCHEDULER_FALLBACK_LIVE_FIELDS, merge: mergeSchedulerFallbackRow };",
  ].join("\n"), sandbox);

  const previous = {
    status: "completed",
    resultPath: "runs/final",
    finishedAt: "2026-07-30T00:00:00Z",
    workerLiveStatus: "stale",
    worker_live_status: "stale",
    workerPid: 10,
    worker_pid: 11,
    workerGpuIds: [0],
    worker_gpu_ids: [0],
    workerTelemetryWarning: "old warning",
    worker_telemetry_warning: "old warning",
    lastHeartbeatAt: "2026-07-30T00:00:00Z",
    last_heartbeat_at: "2026-07-30T00:00:00Z",
  };
  const incoming = {
    status: "running",
    resultPath: "runs/stale",
    finishedAt: "",
    workerLiveStatus: "pid_alive",
    worker_live_status: "pid_alive",
    workerPid: 20,
    worker_pid: 21,
    workerGpuIds: [1, 2],
    worker_gpu_ids: [1, 2],
    workerTelemetryWarning: "",
    worker_telemetry_warning: "",
    lastHeartbeatAt: "2026-07-30T00:01:00Z",
    last_heartbeat_at: "2026-07-30T00:01:00Z",
  };
  const merged = sandbox.api.merge(previous, incoming);

  assert.equal(merged.status, "completed");
  assert.equal(merged.resultPath, "runs/final");
  assert.equal(merged.finishedAt, "2026-07-30T00:00:00Z");
  for (const key of sandbox.api.fields) assert.deepEqual(merged[key], incoming[key], key);
  assert.equal(Object.isFrozen(sandbox.api.fields), true);
  assert.equal(sandbox.api.fields.length, 10);

  const source = extractFunction(extension, "mergeSchedulerFallbackRow");
  assert.match(source, /SCHEDULER_FALLBACK_LIVE_FIELDS/);
  assert.doesNotMatch(source, /for \(const key of \[/);
});

test("frontend scheduler expansion reuses fixed rank and bucket definitions", () => {
  const sandbox = { asArray: (value) => Array.isArray(value) ? value : [] };
  vm.createContext(sandbox);
  vm.runInContext([
    extractDeclaration(panel, "TASK_STATUS_RANKS"),
    extractDeclaration(panel, "SCHEDULER_BUCKET_STATUSES"),
    extractDeclaration(panel, "SCHEDULER_BUCKETS"),
    extractFunction(panel, "taskStatusToken"),
    extractFunction(panel, "taskStatusRank"),
    extractFunction(panel, "bucketStatus"),
    extractFunction(panel, "expandSchedulerRow"),
    "this.api = { taskStatusRank, expandSchedulerRow };",
  ].join("\n"), sandbox);

  assert.equal(sandbox.api.taskStatusRank("RUNNING"), 0);
  assert.equal(sandbox.api.taskStatusRank("future-status"), 6);
  const rows = sandbox.api.expandSchedulerRow({
    planFile: "experiments/plans/a.yaml",
    planRevision: "r1",
    pending_experiments: [{ runKey: "pending" }],
    failed_experiments: [{ runKey: "failed" }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { runKey: "pending", status: "queued", planFile: "experiments/plans/a.yaml", planRevision: "r1", debugMode: false, debugRunId: "", debugOutputDir: "" },
    { runKey: "failed", status: "failed", planFile: "experiments/plans/a.yaml", planRevision: "r1", debugMode: false, debugRunId: "", debugOutputDir: "" },
  ]);
  assert.doesNotMatch(extractFunction(panel, "taskStatusRank"), /const map =/);
  assert.doesNotMatch(extractFunction(panel, "expandSchedulerRow"), /const buckets =/);
});
