const assert = require("node:assert/strict");

const fs = require("node:fs");

const http = require("node:http");

const os = require("node:os");

const path = require("node:path");

const test = require("node:test");

const { spawn } = require("node:child_process");


const root = path.resolve(__dirname, "../..");

const cli = path.join(root, "dist", "cli.js");

const validPlan = path.join(__dirname, "fixtures", "valid-plan.yaml");

const invalidPlan = path.join(__dirname, "fixtures", "invalid-plan.yaml");


function runCli(args, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: extra.cwd || root,
      windowsHide: true,
      env: { ...process.env, SIMPLE_EXPERIMENT_API_FILE: extra.apiFile || path.join(os.tmpdir(), "missing-simple-experiment-api.json"), ...extra.env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-65536); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`CLI fixture exceeded 10 seconds: ${args[0]}`));
      else resolve({ code, stdout, stderr });
    });
  });
}


function writeProject(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, "utf8");
  }
}


function wrappedRuntimeCapture(seed = "42", contextSeed = seed, configPath = `work_dirs/corim/0_corim_bus_p100_seed${seed}/job_config.yaml`) {
  const context = {
    worker_id: "nwpu2", gpu_ids: "0", plan: "experiments/plans/comparison/corim.yaml",
    config_path: configPath,
  };
  if (contextSeed !== null) context.seed = Number(contextSeed);
  return [
    "[simple-experiment-runtime] start index=0 case=corim_bus_p100 seed=42 at 2026-09",
    "-24T14:27:17+08:00",
    `python train.py --context-json '${JSON.stringify(context)}' --case corim_bus_p100 --seed ${seed}`,
    "2026-09-24 14:27:20,123 INFO training",
  ].join("\n");
}


function corimObservation(capture) {
  const { observationFromCapture } = require("../../dist/cli/runtime.js");
  return observationFromCapture(
    { id: "nwpu2", host: "localhost", port: 1 },
    "zlk-gpu-0",
    { name: "run-1790231236812", index: "1", target: "zlk-gpu-0:1" },
    capture,
  );
}


const FAILURE_KEYS = ["id", "status", "health_status", "updated_at"];


function physicalWorkerFixture() {
  const history = {
    id: "run0-326826-291", run_id: "run0-326826-291", type: "worker_run", source: "history", status: "running",
    worker_id: "nwpu2", gpu: { id: "0" }, plan: "experiments/plans/preexperiment/bus_p100.yaml",
    experiment_case: "A", seed: "42", tmux: "zlk-gpu-0", stage: "train_test", created: "2026-09-23T09:55:44Z",
    parent_id: "", raw: {},
  };
  const observation = {
    run_id: "run-1790157344723", worker: { id: "nwpu2", host: "" }, gpu: { id: "0", memory: "", utilization: "" },
    plan: history.plan, config: { experiment_case: "A", seed: "42", path: "", model: "", dataset: "" },
    tmux: { session: "zlk-gpu-0", window: "zlk-gpu-0:1", pane: "zlk-gpu-0:1.0" },
    stage: "branch", status: "running", progress: { epoch: 7, loss: 0.2 }, updated_at: "2026-09-23T11:00:00Z", log: "",
  };
  return { history, observation };
}


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
