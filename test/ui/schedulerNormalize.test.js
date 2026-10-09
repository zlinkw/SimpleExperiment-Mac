const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeSchedulerRows, taskStatusRank, formatDuration } = require("../../dist/ui/WebviewRenderState.js");
const { readSource } = require("../_helpers/sourceReader");
const source = readSource("src/ui/WebviewRenderState.ts");

function functionSource(name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "missing " + name);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
}

test("scheduler normalize expands buckets and sorts active tasks first", () => {
  const rows = normalizeSchedulerRows([
    {
      plan: "plan-a",
      running_experiments: [{ run_key: "run", case: "train", worker_id: "w1", gpu_ids: [0], started_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:01:00Z" }],
      completed_experiments: [{ run_key: "done", case: "eval", worker_id: "w2" }],
      failed_experiments: [{ run_key: "bad", case: "fail", worker_id: "w3" }],
      pending_experiments: [{ run_key: "queued", case: "q", worker_id: "w4" }],
    },
  ]);
  assert.deepEqual(rows.map((row) => row.status), ["running", "queued", "failed", "completed"]);
  assert.equal(rows[0].plan, "plan-a");
  assert.equal(rows[0].gpuIds[0], 0);
  assert.equal(taskStatusRank("running") < taskStatusRank("completed"), true);
  assert.equal(formatDuration("2026-07-01T00:00:00Z", "2026-07-01T00:01:05Z"), "1m 5s");
});

test("scheduler normalize filters deleted rows from task table", () => {
  const rows = normalizeSchedulerRows([{ status: "deleted", runKey: "gone" }, { state: "completed", runKey: "done" }]);
  assert.deepEqual(rows.map((row) => row.runKey), ["done"]);
});

test("task status sorting reuses one immutable rank table", () => {
  const ranker = functionSource("taskStatusRank");
  assert.match(source, /const TASK_STATUS_RANKS: Readonly<Record<string, number>> = Object\.freeze\(\{/);
  assert.match(ranker, /TASK_STATUS_RANKS\[/);
  assert.doesNotMatch(ranker, /const map|Object\.freeze|\{ running:/);
  assert.equal(taskStatusRank("RUNNING"), 0);
  assert.equal(taskStatusRank("future-status"), 6);
});

test("scheduler bucket expansion reuses fixed fields and status mapping", () => {
  const expander = functionSource("expandSchedulerRow");
  const mapper = functionSource("bucketStatus");
  assert.match(source, /const SCHEDULER_BUCKET_STATUSES: Readonly<Record<string, string>> = Object\.freeze\(\{/);
  assert.match(source, /const SCHEDULER_BUCKETS: readonly string\[\] = Object\.freeze\(Object\.keys\(SCHEDULER_BUCKET_STATUSES\)\)/);
  assert.match(expander, /SCHEDULER_BUCKETS\.flatMap/);
  assert.doesNotMatch(expander, /const buckets = \[/);
  assert.match(mapper, /SCHEDULER_BUCKET_STATUSES\[bucket\] \?\?/);
  assert.match(mapper, /replace\("_experiments", ""\)/);

  const rows = normalizeSchedulerRows([{
    queued_experiments: [{ runKey: "queued" }],
    pending_experiments: [{ runKey: "pending" }],
    running_experiments: [{ runKey: "running" }],
    testing_experiments: [{ runKey: "testing" }],
    completed_experiments: [{ runKey: "completed" }],
    failed_experiments: [{ runKey: "failed" }],
    stopped_experiments: [{ runKey: "stopped" }],
  }]);
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.runKey, row.status])), {
    running: "running",
    testing: "testing",
    pending: "queued",
    queued: "queued",
    failed: "failed",
    completed: "completed",
    stopped: "stopped",
  });
});
