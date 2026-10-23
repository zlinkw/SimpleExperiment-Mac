const { assert, fs, http, os, path, test, spawn, root, cli, validPlan, invalidPlan, runCli, writeProject, wrappedRuntimeCapture, corimObservation, FAILURE_KEYS, physicalWorkerFixture } = require("./simpleCli.support.cjs");

test("agent compact output drops bulky fields and summary is stable", async () => {
  const { compactJsonValue } = require("../../dist/cli/format.js");
  const compact = compactJsonValue({
    id: "run-1",
    type: "worker_run",
    status: "running",
    created_at: "2026-01-01T00:00:00Z",
    children: [{ id: "child" }],
    raw: { debug: true },
    recentLogs: "large",
  });
  for (const key of ["created_at", "children", "raw", "recentLogs"]) assert.equal(key in compact, false);
  const metric = compactJsonValue({ id: "metric1", type: "auc", value: 0.8, raw: { debug: true } });
  assert.equal(metric.type, "auc");
  assert.equal(metric.value, 0.8);
  assert.equal("raw" in metric, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-summary-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", status: "failed", plan: "plan.yaml" },
      { global_job_id: "run-100", type: "run", status: "completed", parent_id: "run-plan-1" },
    ], null, 2),
  });
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  for (const key of ["running_count", "failed_count", "success_count", "workflows", "active_workers", "gpu_usage", "stalled_experiments"]) {
    assert.equal(key in summary, true, key);
  }
  assert.equal(summary.running_count, 0);
  assert.equal(summary.failed_count, 0);
  assert.equal(summary.success_count, 1);
  assert.equal(summary.workflows, 1);
  const listed = JSON.parse((await runCli(["experiment", "list", "--json"], { cwd: dir })).stdout);
  assert.equal("recentLogs" in listed[0], false);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overview.summary, summary);
  assert.equal("created_at" in listed[0], false);
  const full = JSON.parse((await runCli(["experiment", "list", "--json", "--full"], { cwd: dir })).stdout);
  assert.equal("created_at" in full[0], true);
});

test("experiment tree keeps orphan worker runs visible exactly once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-tree-orphans-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "workflow", status: "success" },
      { global_job_id: "run-child", type: "worker_run", parent_id: "run-plan-1", status: "success" },
      { global_job_id: "run-orphan", type: "worker_run", parent_id: "", status: "cancelled" },
      { global_job_id: "run-missing-parent", type: "worker_run", parent_id: "workflow-does-not-exist", status: "failed" },
    ]),
  });
  const tree = JSON.parse((await runCli(["experiment", "tree", "--json"], { cwd: dir })).stdout);
  const roots = new Map(tree.map((node) => [node.id, node]));
  assert.equal(roots.has("run-plan-1"), true);
  assert.equal(roots.has("run-child"), false);
  assert.deepEqual(roots.get("run-plan-1").children.map((node) => node.id), ["run-child"]);
  for (const id of ["run-orphan", "run-missing-parent"]) {
    assert.equal(roots.get(id).type, "worker_run");
    assert.deepEqual(roots.get(id).children, []);
  }
  const flattenIds = (nodes) => nodes.flatMap((node) => [node.id, ...flattenIds(node.children)]);
  const treeIds = flattenIds(tree);
  assert.equal(new Set(treeIds).size, treeIds.length);
  const listed = JSON.parse((await runCli(["experiment", "list", "--json", "--full"], { cwd: dir })).stdout);
  assert.deepEqual(new Set(treeIds), new Set(listed.map((row) => row.id)));
});

test("experiment tree roots preserve input order and include missing parents", () => {
  const { experimentTreeRoots } = require("../../dist/cli/commands/experiment.js");
  const workflow = { id: "run-plan-1", type: "workflow" };
  const child = { id: "run-child", type: "worker_run", parent_id: "run-plan-1" };
  const orphan = { id: "run-orphan", type: "worker_run", parent_id: "" };
  const missingParent = { id: "run-missing-parent", type: "worker_run", parent_id: "workflow-does-not-exist" };
  assert.deepEqual(experimentTreeRoots([orphan, child, workflow, missingParent]), [orphan, workflow, missingParent]);
});

test("workflow and worker run status counts do not mix", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-summary-levels-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", status: "running", worker_id: "scheduler-owner", gpu: { id: "9" } },
      { global_job_id: "run-plan-2", type: "run-plan", status: "failed" },
      { global_job_id: "run-plan-3", type: "run-plan", status: "completed" },
      { global_job_id: "run-100", type: "run", status: "running", parent_id: "run-plan-1", worker_id: "worker-a", gpu: { id: "0" } },
      { global_job_id: "run-200", type: "run", status: "failed", parent_id: "run-plan-2" },
      { global_job_id: "run-300", type: "run", status: "completed", parent_id: "run-plan-3" },
    ]),
  });
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  assert.equal(summary.running_count, 1);
  assert.equal(summary.failed_count, 1);
  assert.equal(summary.success_count, 1);
  assert.equal(summary.workflows, 3);
  assert.deepEqual(summary.active_workers, ["worker-a"]);
  assert.deepEqual(summary.gpu_usage, [{ id: "run-100", worker: "worker-a", gpu: "0" }]);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overview.summary, summary);
  assert.equal(overview.active.active_count, 2);
});

test("workflow-only history does not count as a worker run failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-summary-workflow-only-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "workflow-failed", type: "run-plan", status: "failed" },
    ]),
  });
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  assert.equal(summary.workflows, 1);
  assert.equal(summary.failed_count, 0);
});

test("alerts sort failures and inspect omits evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-alerts-"));
  writeProject(dir, {
    "experiments/runs/run-old/stdout.log": "2026-01-01T00:00:00Z ERROR CUDA out of memory\n",
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", status: "running", plan: "plan.yaml", updated: new Date().toISOString() },
      { global_job_id: "run-old", type: "run", status: "failed", parent_id: "run-plan-1", updated: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), stdout: "experiments/runs/run-old/stdout.log" },
      { global_job_id: "run-200", type: "run", status: "failed", parent_id: "run-plan-1", updated: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
      { global_job_id: "run-300", type: "run", status: "running", stage: "run", parent_id: "run-plan-1", updated: new Date().toISOString() },
    ], null, 2),
  });
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overview.alerts.failed_recent.map((row) => row.id), ["run-200", "run-old"]);
  assert.deepEqual(overview.summary.recent_failures, overview.alerts.failed_recent);
  assert.equal(overview.alerts.failed_recent.some((row) => row.id === "run-plan-1"), false);
  assert.equal(overview.alerts.failed_recent.length <= 3, true);
  assert.equal(overview.alerts.missing_progress.some((row) => row.id === "run-plan-1"), false);
  assert.equal(overview.alerts.missing_progress.some((row) => row.id === "run-300"), false);
  const inspectedWorkflow = JSON.parse((await runCli(["experiment", "inspect", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal(inspectedWorkflow.summary.status, "failed");
  assert.equal(inspectedWorkflow.health.status, "error");
  assert.equal(inspectedWorkflow.health.reason, "failed_recent");
  assert.equal(inspectedWorkflow.alerts.recent_failure, true);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-old", "--json"], { cwd: dir })).stdout);
  assert.equal("evidence" in inspected.diagnosis, false);
  assert.equal("health_status" in inspected.diagnosis, false);
  assert.equal("stalled" in inspected.diagnosis, false);
  assert.equal("latest_message" in inspected.diagnosis, true);
  assert.ok(String(inspected.diagnosis.latest_message).length <= 300);
  const full = JSON.parse((await runCli(["experiment", "inspect", "run-old", "--json", "--full"], { cwd: dir })).stdout);
  assert.ok(full.diagnosis.evidence.length <= 20);
  assert.ok(full.diagnosis.evidence.some((line) => /out of memory/i.test(line)));
});

test("experiment active returns only running workflows and runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-active-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", status: "running", plan: "plan.yaml" },
      { global_job_id: "run-100", type: "run", status: "running", parent_id: "run-plan-1", worker_id: "worker-a" },
      { global_job_id: "run-200", type: "run", status: "failed", parent_id: "run-plan-1" },
    ], null, 2),
  });
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], { cwd: dir })).stdout);
  assert.equal(active.active_count >= 2, true);
  assert.ok(Array.isArray(active.workflows));
  assert.ok(Array.isArray(active.runs));
  assert.equal(active.runs.some((row) => row.id === "run-200"), false);
  assert.equal("raw" in active, false);
  assert.deepEqual(Object.keys(active).sort(), ["active_count", "runs", "schema_version", "snapshot", "workflows"]);
  assert.equal("children" in active.workflows[0], false);
  assert.equal("created_at" in active.workflows[0], false);
  assert.equal("worker" in active.workflows[0] ? active.workflows[0].worker.id.length > 0 : active.workflows[0].id === "run-plan-1", true);
  const full = JSON.parse((await runCli(["experiment", "active", "--json", "--full"], { cwd: dir })).stdout);
  assert.equal("created_at" in full.workflows[0], true);
  assert.equal("children" in full.workflows[0], true);
  assert.equal("health_status" in full.workflows[0], true);
  assert.equal("model" in full.workflows[0], true);
  assert.equal("dataset" in full.workflows[0], true);
  const both = JSON.parse((await runCli(["experiment", "active", "--json", "--full", "--compact-json"], { cwd: dir })).stdout);
  assert.equal("created_at" in both.workflows[0], true);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  for (const key of ["summary", "active", "alerts"]) assert.equal(key in overview, true, key);
  for (const key of ["failed_recent", "stalled", "missing_progress"]) assert.equal(key in overview.alerts, true, key);
  const status = JSON.parse((await runCli(["experiment", "status", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal("recentLogs" in status, false);
  assert.equal("children" in status, false);
  assert.equal(status.updated_at !== undefined, true);
  const statusFull = JSON.parse((await runCli(["experiment", "status", "run-plan-1", "--json", "--full"], { cwd: dir })).stdout);
  assert.equal("recentLogs" in statusFull, true);
});

test("overview failed_recent caps at 3 unless --full", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-overview-full-"));
  const failed = Array.from({ length: 12 }, (_value, index) => ({
    global_job_id: `fail-${String(index).padStart(2, "0")}`,
    type: "run",
    status: "failed",
    updated: new Date(Date.now() - index * 60 * 60 * 1000).toISOString(),
  }));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify(failed, null, 2),
  });
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.equal(overview.alerts.failed_recent.length, 3);
  assert.deepEqual(overview.alerts.failed_recent.map((row) => row.id), ["fail-00", "fail-01", "fail-02"]);
  const full = JSON.parse((await runCli(["experiment", "overview", "--json", "--full"], { cwd: dir })).stdout);
  assert.equal(full.alerts.failed_recent.length, 10);
  assert.equal(full.alerts.stalled.length, overview.alerts.stalled.length);
  assert.equal(full.alerts.missing_progress.length, overview.alerts.missing_progress.length);
});

test("experiment health reports healthy warning and error", async () => {
  const { buildHealthSummary, isRecentFailure } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-23T00:00:00Z");
  assert.equal(isRecentFailure({ status: "failed", updated: "2026-09-22T12:00:00Z" }, now), true);
  assert.equal(isRecentFailure({ status: "failed", updated: "2026-01-01T00:00:00Z" }, now), false);
  assert.deepEqual(buildHealthSummary([{ status: "success", health_status: "healthy", updated: "" }], now), { status: "healthy", reason: "" });
  assert.deepEqual(buildHealthSummary([{ status: "running", health_status: "stalled", updated: "2020-01-01T00:00:00Z" }], now), { status: "warning", reason: "stalled" });
  assert.deepEqual(buildHealthSummary([
    { status: "failed", health_status: "error", updated: "2026-09-23T00:00:00Z" },
    { status: "running", health_status: "stalled", updated: "2020-01-01T00:00:00Z" },
  ], now), { status: "error", reason: "failed_recent" });
  assert.deepEqual(buildHealthSummary([
    { status: "failed", health_status: "error", updated: "2026-01-01T00:00:00Z" },
  ], now), { status: "healthy", reason: "" });

  const healthyDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-health-ok-"));
  writeProject(healthyDir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-ok", type: "run", status: "completed", updated: new Date().toISOString() },
    ], null, 2),
  });
  const healthy = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: healthyDir })).stdout);
  assert.deepEqual(Object.keys(healthy).sort(), ["alerts", "health", "schema_version", "snapshot"]);
  assert.equal(healthy.health.status, "healthy");
  assert.equal(healthy.alerts.recent_failure, false);
  assert.equal(healthy.alerts.stalled, false);

  const stalledDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-health-stalled-"));
  writeProject(stalledDir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-stale", type: "run", status: "running", stage: "run", updated: "2020-01-01T00:00:00Z" },
    ], null, 2),
  });
  const warning = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: stalledDir })).stdout);
  assert.equal(warning.health.status, "warning");
  assert.equal(warning.health.reason, "stalled");
  assert.equal(warning.alerts.stalled, true);
  assert.equal(warning.alerts.alert_details.some((item) => item.type === "stalled"), true);

  const failedDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-health-failed-"));
  writeProject(failedDir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      ...Array.from({ length: 6 }, (_value, index) => ({
        global_job_id: `fail-${index}`,
        type: "run",
        status: "failed",
        updated: new Date(Date.now() - index * 60 * 1000).toISOString(),
      })),
      { global_job_id: "run-stale", type: "run", status: "running", updated: "2020-01-01T00:00:00Z" },
    ], null, 2),
  });
  const error = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: failedDir })).stdout);
  assert.equal(error.health.status, "error");
  assert.equal(error.health.reason, "failed_recent");
  assert.equal(error.alerts.recent_failure, true);
  assert.equal(error.alerts.stalled, true);
});
