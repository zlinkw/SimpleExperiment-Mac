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


test("partial runtime progress survives and stays shared", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-partial-progress-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "base_config: configs/base.yaml",
      "python -m train --config plan.yaml",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12",
    ].join("\n"),
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        worker_id: "worker-a",
        updated,
        stdout: "experiments/runs/run-1789994720003/stdout.log",
        progress: { epoch: 4 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const id = "run-1789994720003";
  const status = JSON.parse((await runCli(["experiment", "status", id, "--json"], args)).stdout);
  const monitor = JSON.parse((await runCli(["experiment", "monitor", id, "--json"], args)).stdout);
  const diagnosis = JSON.parse((await runCli(["experiment", "diagnose", id, "--json"], args)).stdout);
  assert.notEqual(status.progress, null);
  assert.equal(status.progress.epoch, 4);
  assert.equal(status.progress.loss, null);
  assert.deepEqual(monitor.progress, status.progress);
  assert.deepEqual(diagnosis.progress, status.progress);
  assert.deepEqual(status.worker, monitor.worker);
  assert.deepEqual(status.gpu, diagnosis.gpu);
  assert.equal(status.stage, monitor.stage);
  assert.equal(status.health_status, diagnosis.health_status);
  assert.match(monitor.latest_message, /epoch 4\/10/);
  assert.doesNotMatch(monitor.latest_message, /yaml|config|python/i);
});


test("inspect is a self contained experiment view", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-inspect-view-"));
  const updated = "2026-03-01T00:00:00Z";
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "epoch 1/10 loss --",
      "epoch 2/10 loss null",
      "epoch 3/10 loss N/A",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12 loss 0.31",
    ].join("\n"),
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        plan: "plan.yaml",
        worker_id: "worker-a",
        updated,
        stdout: "experiments/runs/run-1789994720003/stdout.log",
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const id = "run-1789994720003";
  const status = JSON.parse((await runCli(["experiment", "status", id, "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", id, "--json"], args)).stdout);
  for (const key of ["snapshot_id", "snapshot_time", "runtime_version"]) assert.equal(key in inspected.snapshot, true, key);
  assert.equal(inspected.snapshot.runtime_version, status.updated_at);
  assert.equal(inspected.snapshot.runtime_version, inspected.progress.updated_at);
  for (const key of ["worker", "gpu", "stage", "health_status"]) {
    assert.deepEqual(inspected.status[key], status[key], key);
  }
  assert.deepEqual(Object.keys(inspected.health).sort(), ["reason", "status"]);
  assert.equal(inspected.alerts.missing_progress, false);
  assert.equal(inspected.alerts.recent_failure, false);
  assert.equal(typeof inspected.alerts.stalled, "boolean");
  assert.match(inspected.diagnosis.latest_message, /loss 0\.31/);
  assert.doesNotMatch(inspected.diagnosis.latest_message, /loss --|loss null|N\/A/i);
  assert.equal(typeof inspected.diagnosis.stale_seconds, "number");
});


test("inspect schema keeps one responsibility per field", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-inspect-schema-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        worker_id: "worker-a",
        updated: new Date().toISOString(),
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
        gpu: { id: "0" },
      },
      { global_job_id: "run-old-fail", type: "run", status: "failed", updated: "2020-01-01T00:00:00Z" },
      { global_job_id: "run-new-fail", type: "run", status: "failed", updated: new Date().toISOString() },
    ], null, 2),
  });
  const args = { cwd: dir };
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  for (const key of ["snapshot", "summary", "status", "progress", "health", "diagnosis", "alerts"]) {
    assert.equal(key in inspected, true, key);
  }
  for (const key of ["snapshot_id", "snapshot_time", "runtime_version"]) {
    assert.equal(key in inspected.snapshot, true, key);
    assert.equal(key in inspected.status, false, key);
  }
  assert.equal("progress" in inspected.diagnosis, false);
  assert.equal("runtime" in inspected.diagnosis, false);
  assert.equal("health_status" in inspected.diagnosis, false);
  assert.equal("stalled" in inspected.diagnosis, false);
  assert.deepEqual(Object.keys(inspected.health).sort(), ["reason", "status"]);
  const text = JSON.stringify(inspected);
  assert.equal(text.split('{"progress":').length - 1 + text.split('"progress":').length - 1, 1);

  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  assert.equal(health.alerts.recent_failure, true);
  assert.equal("failed_recent" in health.alerts, false);
});


test("inspect schema version 1 is frozen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-inspect-frozen-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        case: "baseline",
        seed: "42",
        updated: new Date().toISOString(),
        progress: { epoch: 4, loss: 0.31 },
      },
    ], null, 2),
  });
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], { cwd: dir })).stdout);
  assert.equal(inspected.schema_version, "1");
  assert.deepEqual(Object.keys(inspected).sort(), ["alerts", "diagnosis", "health", "progress", "schema_version", "snapshot", "status", "summary"]);
  assert.equal(inspected.summary.experiment_case, "baseline");
  assert.equal(inspected.summary.seed, "42");
  assert.equal("runtime" in inspected.diagnosis, false);
  assert.equal(JSON.stringify(inspected).split('"stale_seconds"').length - 1, 1);
  assert.ok(Array.isArray(inspected.alerts.alert_details));
  const stalled = inspected.alerts.stalled
    ? [{ type: "stalled", message: "experiment has no progress update" }]
    : [];
  assert.deepEqual(inspected.alerts.alert_details, stalled);
});


test("health field is shared by health overview and inspect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-health-field-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        case: "baseline",
        seed: "7",
        worker_id: "worker-a",
        updated: new Date().toISOString(),
        progress: { epoch: 4, loss: 0.31 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  assert.equal(inspected.schema_version, "1");
  for (const payload of [health, overview]) {
    assert.equal("health" in payload, true);
    assert.equal("overall" in payload, false);
    assert.deepEqual(Object.keys(payload.health).sort(), payload === health ? ["alert_level", "reason", "status"] : ["reason", "status"]);
  }
  assert.deepEqual(health.health, { ...overview.health, alert_level: "ok" });
  assert.deepEqual(health.health, { ...inspected.health, alert_level: "ok" });
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  const running = active.runs[0];
  for (const key of ["id", "experiment_case", "seed", "worker", "gpu", "stage", "progress"]) {
    assert.equal(key in running, true, key);
  }
  assert.equal(running.experiment_case, "baseline");
  assert.equal(running.seed, "7");
});


test("overview active health and inspect keep separate responsibilities", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-responsibilities-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        updated: new Date().toISOString(),
        progress: { epoch: 4, loss: 0.31 },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], args)).stdout);
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  assert.equal("active_runs" in overview.summary, false);
  assert.equal("running" in health, false);
  assert.ok(Array.isArray(active.runs));
  assert.deepEqual(Object.keys(overview.active).sort(), ["active_count", "runs", "workflows"]);
  assert.deepEqual(overview.active, { active_count: active.active_count, workflows: active.workflows, runs: active.runs });
  for (const key of ["missing_progress", "stalled", "recent_failure", "alert_details"]) {
    assert.equal(key in health.alerts, true, key);
    assert.equal(key in inspected.alerts, true, key);
  }
  assert.equal("failed_recent" in health.alerts, false);
  assert.equal("failed_recent" in overview.alerts, true);
});
