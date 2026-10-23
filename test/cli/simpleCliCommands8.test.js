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


test("stalled uses Worker output activity before CLI observation time", () => {
  const { isStalled } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-24T12:00:00Z");
  assert.equal(isStalled({ status: "running", updated: "2026-09-24T10:00:00Z", raw: { runtimeActivityAt: "2026-09-24T11:45:00Z" } }, now), false);
  assert.equal(isStalled({ status: "running", updated: "2026-09-24T11:59:59Z", raw: { runtimeActivityAt: "2026-09-24T11:20:00Z" } }, now), true);
  assert.equal(isStalled({ status: "success", updated: "2020-01-01T00:00:00Z", raw: { runtimeActivityAt: "2020-01-01T00:00:00Z" } }, now), false);
  assert.equal(isStalled({ status: "running", updated: "2026-09-24T11:20:00Z", raw: {} }, now), true);
});


test("live runtime activity time drives stalled health instead of query time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-stalled-"));
  const now = Date.now();
  const updated = new Date(now - 1000).toISOString();
  const runtimeActivityAt = new Date(now - 40 * 60 * 1000).toISOString();
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-stalled", type: "worker_run", status: "running", stage: "train_test", started_at: new Date(now - 60 * 60 * 1000).toISOString(), updated, runtimeActivityAt, progress: { epoch: 4, max_epoch: 10, percent: 40 } },
    ]),
  });
  const healthRun = await runCli(["experiment", "health", "--json"], { cwd: dir });
  assert.equal(healthRun.code, 0, healthRun.stderr);
  const health = JSON.parse(healthRun.stdout);
  assert.equal(health.health.status, "warning");
  assert.equal(health.health.reason, "stalled");
  assert.equal(health.alerts.stalled, true);
  assert.equal(health.alerts.missing_progress, false);
  assert.match(health.alerts.alert_details.find((item) => item.type === "stalled").message, /output has not changed/);

  const overviewRun = await runCli(["experiment", "overview", "--json"], { cwd: dir });
  assert.equal(overviewRun.code, 0, overviewRun.stderr);
  const overview = JSON.parse(overviewRun.stdout);
  assert.deepEqual(overview.alerts.stalled.map((row) => row.id), ["run-stalled"]);

  const inspectRun = await runCli(["experiment", "inspect", "run-stalled", "--json"], { cwd: dir });
  assert.equal(inspectRun.code, 0, inspectRun.stderr);
  const inspect = JSON.parse(inspectRun.stdout);
  assert.deepEqual(inspect.health, { status: "warning", reason: "stalled" });
  assert.equal(inspect.alerts.stalled, true);
  assert.ok(inspect.diagnosis.stale_seconds >= 30 * 60);
  assert.equal(inspect.status.updated_at, updated);
});


test("aggregate workflow failures do not duplicate their worker failures", () => {
  const { classifyRecentFailures, buildHealthSummary } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-23T11:00:00Z");
  const workflow = { id: "wf-1", type: "workflow", status: "failed", status_source: "aggregate", plan: "p.yaml", updated: "2026-09-23T10:00:00Z" };
  const worker = { id: "worker-1", type: "worker_run", parent_id: "wf-1", status: "failed", plan: "p.yaml", updated: "2026-09-23T10:05:00Z" };
  assert.deepEqual(classifyRecentFailures([workflow, worker], now).unresolved, [worker]);
  assert.deepEqual(buildHealthSummary([workflow, worker], now), { status: "error", reason: "failed_recent" });
  assert.deepEqual(classifyRecentFailures([workflow], now).unresolved, [workflow]);
  assert.deepEqual(buildHealthSummary([workflow], now), { status: "error", reason: "failed_recent" });
});


test("independent scheduler workflow failures remain in recent failures", () => {
  const { classifyRecentFailures, buildHealthSummary } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-23T11:00:00Z");
  for (const status_source of ["scheduler", "unknown"]) {
    const workflow = { id: "wf-scheduler-failed", type: "workflow", status: "failed", status_source, plan: "p.yaml", updated: "2026-09-23T10:00:00Z" };
    assert.deepEqual(classifyRecentFailures([workflow], now).unresolved, [workflow]);
    assert.deepEqual(buildHealthSummary([workflow], now), { status: "error", reason: "failed_recent" });
  }
});


test("recent worker failures use only the latest matching attempt", () => {
  const { classifyRecentFailures, buildHealthSummary, recentFailureRecoveryState } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-23T11:00:00Z");
  const failure = { id: "old", type: "worker_run", plan: "plans\\p.yaml", experiment_case: "A", seed: "42", status: "failed", updated: "2026-09-23T10:00:00Z" };
  const retry = { id: "new", type: "worker_run", plan: "plans/p.yaml", experiment_case: "A", seed: "42", status: "running", created: "2026-09-23T10:05:00Z", updated: "2026-09-23T10:06:00Z" };
  const classify = (rows) => classifyRecentFailures(rows, now);
  assert.equal(recentFailureRecoveryState(failure, [failure, retry], now), "running_retry");
  assert.deepEqual(classify([failure, retry]).unresolved, []);
  assert.deepEqual(classify([failure, retry]).running_retry, [failure]);
  assert.deepEqual(buildHealthSummary([failure, retry], now), { status: "warning", reason: "failed_recent" });
  const success = { ...retry, status: "success" };
  assert.deepEqual(classify([failure, success]).resolved, [failure]);
  assert.deepEqual(buildHealthSummary([failure, success], now), { status: "healthy", reason: "" });
  const failedAgain = { ...retry, id: "newest", status: "failed", created: "2026-09-23T10:10:00Z", updated: "2026-09-23T10:11:00Z" };
  assert.equal(recentFailureRecoveryState(failure, [failure, success, failedAgain], now), "unresolved");
  assert.equal(classify([failure, success, failedAgain]).unresolved.length, 2);
  for (const changed of [{ seed: "43" }, { experiment_case: "B" }, { plan: "plans/other.yaml" }]) {
    assert.equal(recentFailureRecoveryState(failure, [failure, { ...retry, ...changed }], now), "unresolved");
  }
  for (const missing of [{ experiment_case: "" }, { seed: "" }]) {
    assert.equal(recentFailureRecoveryState({ ...failure, ...missing }, [{ ...failure, ...missing }, retry], now), "unresolved");
  }
});


test("experiment health distinguishes running and successful retries from failure history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-health-retry-"));
  const indexPath = path.join(dir, "simple_cluster", "experiment_index.json");
  const old = { global_job_id: "run0-old", type: "worker_run", plan: "p.yaml", experiment_case: "A", seed: "42", status: "failed", updated: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
  const newer = { global_job_id: "run0-new", type: "worker_run", plan: "p.yaml", experiment_case: "A", seed: "42", status: "running", created: new Date(Date.now() - 5 * 60 * 1000).toISOString(), updated: new Date().toISOString(), stage: "branch" };
  writeProject(dir, { "simple_cluster/experiment_index.json": JSON.stringify([old, newer]) });
  const healthRun = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(healthRun.health, { status: "warning", reason: "failed_recent", alert_level: "warning" });
  assert.equal(healthRun.alerts.recent_failure, true);
  assert.match(healthRun.alerts.alert_details.find((item) => item.type === "recent_failure").message, /1 experiment identity has newer running retries/);
  const overviewRun = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.equal(overviewRun.alerts.failed_recent[0].id, old.global_job_id);
  assert.deepEqual(overviewRun.health, { status: "warning", reason: "failed_recent" });
  const inspected = JSON.parse((await runCli(["experiment", "inspect", old.global_job_id, "--json"], { cwd: dir })).stdout);
  assert.deepEqual(inspected.health, { status: "error", reason: "failed_recent" });
  fs.writeFileSync(indexPath, JSON.stringify([old, { ...newer, status: "success" }]), "utf8");
  const healthSuccess = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(healthSuccess.health, { status: "healthy", reason: "", alert_level: "ok" });
  assert.equal(healthSuccess.alerts.recent_failure, false);
  const overviewSuccess = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overviewSuccess.alerts.failed_recent, []);
  assert.equal(overviewSuccess.summary.recent_failures[0].id, old.global_job_id);
  assert.deepEqual(overviewSuccess.health, { status: "healthy", reason: "" });
  const summarySuccess = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  assert.equal(summarySuccess.recent_failures[0].id, old.global_job_id);
  const inspectedSuccess = JSON.parse((await runCli(["experiment", "inspect", old.global_job_id, "--json"], { cwd: dir })).stdout);
  assert.deepEqual(inspectedSuccess.health, { status: "error", reason: "failed_recent" });
  assert.equal(inspectedSuccess.alerts.recent_failure, true);
});
