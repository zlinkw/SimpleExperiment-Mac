const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createWorkerPlanShardSet, workerPlanShardSetMatches } = require("../../dist/features/WorkerPlanSharding.js");
const { readSource } = require("../_helpers/sourceReader");
const root = path.join(__dirname, "..", "..");

function extensionFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test("Worker pool sharding is deterministic and covers every experiment once", () => {
  const first = createWorkerPlanShardSet("plan-rev-1", ["worker-b", "worker-a", "worker-c"], [4, 0, 3, 1, 2, 2]);
  const second = createWorkerPlanShardSet("plan-rev-1", ["worker-c", "worker-b", "worker-a"], [0, 1, 2, 3, 4]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.workerIds, ["worker-a", "worker-b", "worker-c"]);
  assert.deepEqual(first.shards.flatMap((shard) => shard.experimentIndices).sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.equal(new Set(first.shards.flatMap((shard) => shard.experimentIndices)).size, 5);
  assert.equal(workerPlanShardSetMatches(first, "plan-rev-1", ["worker-c", "worker-a", "worker-b"]), true);
});

test("Plan or Worker set changes create a new immutable shard revision", () => {
  const base = createWorkerPlanShardSet("plan-rev-1", ["worker-a", "worker-b"], [0, 1, 2, 3, 4, 5]);
  const changedPlan = createWorkerPlanShardSet("plan-rev-2", ["worker-a", "worker-b"], [0, 1, 2, 3, 4, 5]);
  const changedWorkers = createWorkerPlanShardSet("plan-rev-1", ["worker-a", "worker-b", "worker-c"], [0, 1, 2, 3, 4, 5]);
  assert.notEqual(base.workerSetRevision, changedPlan.workerSetRevision);
  assert.notEqual(base.workerSetRevision, changedWorkers.workerSetRevision);
  assert.equal(workerPlanShardSetMatches(base, "plan-rev-1", ["worker-a", "worker-c"]), false);
});

test("Worker pool sharding rejects incomplete identity", () => {
  assert.throws(() => createWorkerPlanShardSet("", ["worker-a", "worker-b"], [0]), /Plan revision/);
  assert.throws(() => createWorkerPlanShardSet("rev", ["worker-a"], [0]), /at least two/);
  assert.throws(() => createWorkerPlanShardSet("rev", ["worker-a", "worker-b"], []), /no experiment/);
});

test("Extension asks for one Plan target and submits the complete Plan to that Worker", () => {
  const source = readSource("src/extension.ts");
  const methodStart = source.indexOf("async postWorkerPoolPlanAction");
  const method = source.slice(methodStart, source.indexOf("assertTopologyActualWorkRoots", methodStart));
  assert.match(method, /ensureWorkerPoolPlanTarget\(body, options\.title \|\| action\)/);
  assert.match(method, /postWorkerTunnelAction\(workerId, action, request/);
  assert.doesNotMatch(method, /createWorkerPlanShardSet/);
  assert.doesNotMatch(method, /activeShards/);
  assert.doesNotMatch(method, /postTunnelAction\(/);

  const selectionStart = source.indexOf("async ensureWorkerPoolPlanTarget");
  const selection = source.slice(selectionStart, source.indexOf("    stampWorkerPoolManualTarget(body, workerId)", selectionStart));
  assert.match(selection, /showQuickPick/);
  assert.match(selection, /该 Worker 将独立校验、预演并调度完整 Plan；本机不会自动分片/);
  assert.match(selection, /probe\.status === "ok"/);

  const requestStart = source.indexOf("workerPoolActionBody(body");
  const request = source.slice(requestStart, source.indexOf("async postWorkerPoolPlanAction", requestStart));
  assert.match(request, /workers: \[\{/);
  assert.match(request, /schedulerOwnerWorkerId: workerId/);
  assert.match(request, /workerPoolDispatchPolicy: manualPlanTarget \? "manual_plan_target" : "deterministic_shard"/);
  assert.match(request, /assignedExperimentIndices: manualPlanTarget \? undefined : indices/);
  assert.match(request, /automaticBackup: false/);
});

test("no-Hub result fanout preserves every Worker outcome before reporting failure", () => {
  const source = readSource("src/extension.ts");
  const methodStart = source.indexOf("async postNoHubResultAction");
  const method = source.slice(methodStart, source.indexOf("assertTopologyActualWorkRoots", methodStart));
  assert.match(method, /for \(const workerId of workerIds\)/);
  assert.match(method, /catch \(error\)/);
  assert.match(method, /resultOwnerWorkerId: workerId/);
  assert.match(method, /status: isUiCommandCancelled\(error\) \? "cancelled" : "failed"/);
  assert.match(method, /return workerResultAggregateResult\(action, submissions\)/);

  const sandbox = {
    resultStatus: (result) => result?.status,
    stringFromRecord: (record, keys) => keys.map((key) => record?.[key]).find(Boolean) || "",
    operationFailureTerminalStatus: (status) => ["failed", "completed_with_errors", "error"].includes(status),
    operationCancelledTerminalStatus: (status) => ["cancelled", "canceled"].includes(status),
  };
  vm.createContext(sandbox);
  const aggregateSource = extensionFunction(source, "workerResultAggregateResult");
  assert.doesNotMatch(aggregateSource, /rows\.filter\(/);
  assert.doesNotMatch(aggregateSource, /failedWorkerIds\.includes\(/);
  assert.match(aggregateSource, /failedWorkerIdSet\.has\(workerId\)/);
  vm.runInContext(`${aggregateSource}\nthis.aggregate = workerResultAggregateResult;`, sandbox);
  const aggregate = sandbox.aggregate("parse-results", [
    { workerId: "worker-a", result: { status: "completed" } },
    { workerId: "worker-b", result: { status: "failed", error: "timeout" } },
    { workerId: "worker-c", result: { status: "cancelled" } },
    { workerId: "worker-d", result: { status: "completed" } },
    { workerId: "worker-d", result: { status: "failed" } },
    { workerId: "worker-e", result: { status: "completed" } },
    { workerId: "worker-e", result: { status: "completed" } },
  ]);
  assert.equal(aggregate.status, "completed_with_errors");
  assert.deepEqual([...aggregate.failedWorkerIds], ["worker-b", "worker-c", "worker-d"]);
  assert.deepEqual([...aggregate.completedWorkerIds], ["worker-a", "worker-e", "worker-e"]);
  assert.match(aggregate.message, /失败 Worker：worker-b、worker-c、worker-d/);
  assert.match(aggregate.message, /成功 Worker：worker-a、worker-e、worker-e/);

  const actionCoreStart = source.indexOf("async runActionCommandCore");
  const actionCore = source.slice(actionCoreStart, source.indexOf("async runPlanPreflight", actionCoreStart));
  assert.ok(actionCore.indexOf("await this.refreshResultsSummary(planHint)") < actionCore.indexOf("this.throwIfTerminalActionFailure(command, action, resultStatus(finalResult), finalResult)"));
});

test("Worker Agent accepts manual full-Plan targets and gates legacy shard requests", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  assert.match(source, /topology_mode != "single_worker" and topology_mode != "worker_pool"/);
  assert.match(source, /owner != current_worker or worker_ids != \[owner\]/);
  assert.match(source, /dispatch_policy = str\(options\.get\("workerPoolDispatchPolicy"\)/);
  assert.match(source, /topology_mode == "worker_pool" and dispatch_policy != "manual_plan_target" and action in \("dry-run-plan", "run-plan", "reproduce-plan"\)/);
  assert.match(source, /if not assigned or not worker_set_revision:/);
  assert.match(source, /"workerPoolDispatchPolicy": worker_pool_dispatch_policy/);
  assert.match(source, /scheduler_args\.extend\(\["--only-indices"/);
  assert.match(source, /scheduler_args\.extend\(\["--worker-set-revision"/);
  assert.match(source, /scheduler_args\.extend\(\["--scheduler-owner-worker-id"/);
});

test("Scheduler limits dry-run and execution queues to assigned indices", () => {
  const source = readSource("src/clusterSchedulerRuntime.ts");
  assert.match(source, /parser\.add_argument\("--only-indices", default=""\)/);
  assert.match(source, /jobs = \[job for job in jobs if int\(job\.index\) in allowed\]/);
  assert.match(source, /missing = sorted\(allowed\.difference\(int\(job\.index\) for job in jobs\)\)/);
  assert.match(source, /jobs_by_index\[int\(experiment_index\)\]/);
  assert.match(source, /"workerSetRevision": str\(args\.worker_set_revision or ""\)/);
  assert.match(source, /"assignedExperimentIndices": only_indices_for_args\(args\)/);
});
