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
      env: { ...process.env, SIMPLE_EXPERIMENT_MAC_API_FILE: extra.apiFile || path.join(os.tmpdir(), "missing-simple-experiment-api.json"), ...extra.env },
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


test("overview active matches experiment active", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-active-shared-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", status: "running", plan: "plan.yaml" },
      { global_job_id: "run-100", type: "run", status: "running", parent_id: "run-plan-1", stage: "run" },
      { global_job_id: "run-200", type: "run", status: "failed", parent_id: "run-plan-1" },
    ], null, 2),
  });
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], { cwd: dir })).stdout);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overview.active, { active_count: active.active_count, workflows: active.workflows, runs: active.runs });
});


test("runtime fields stay aligned across inspect health and active", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-runtime-align-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "python train.py --config plan.yaml",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12 loss 0.31 auc 0.82",
      "tmux attach -t simple",
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
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  const status = JSON.parse((await runCli(["experiment", "status", "run-1789994720003", "--json"], { cwd: dir })).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], { cwd: dir })).stdout);
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(inspected.progress, active.runs[0].progress);
  assert.deepEqual(status.progress, active.runs[0].progress);
  assert.deepEqual(active.runs[0].worker, { id: "worker-a" });
  assert.deepEqual(active.runs[0].gpu, { id: "0" });
  assert.equal(health.health.status, inspected.health.status);
  assert.match(inspected.diagnosis.latest_message, /loss 0\.31/);
  assert.doesNotMatch(inspected.diagnosis.latest_message, /^python /);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.equal(overview.alerts.missing_progress.some((row) => row.id === "run-1789994720003"), false);
});


test("missing progress past timeout is a warning", async () => {
  const { isMissingProgress, buildHealthSummary, findLatestTrainingMessage } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-23T00:20:00Z");
  const fresh = { type: "worker_run", status: "running", stage: "train_test", progress: null, started_at: "2026-09-23T00:15:00Z", created: "2026-09-23T00:15:00Z", updated: "2026-09-23T00:19:59Z" };
  const stale = { type: "worker_run", status: "running", stage: "train_test", progress: null, started_at: "2026-09-23T00:00:00Z", created: "2026-09-23T00:00:00Z", updated: "2026-09-23T00:19:59Z" };
  assert.equal(isMissingProgress(fresh, now), false);
  assert.equal(isMissingProgress(stale, now), true);
  assert.equal(isMissingProgress({ ...stale, stage: "train" }, now), true);
  assert.equal(isMissingProgress({ ...stale, stage: "run" }, now), true);
  assert.equal(isMissingProgress({ ...stale, stage: "train-test" }, now), true);
  assert.equal(isMissingProgress({ ...stale, stage: "test" }, now), false);
  assert.equal(isMissingProgress({ ...stale, stage: "debug" }, now), false);
  assert.equal(isMissingProgress({ ...stale, progress: { epoch: null, max_epoch: null, batch: 5, total_batch: 10, percent: null, loss: 0.4 } }, now), false);
  assert.equal(isMissingProgress({ ...stale, started_at: "invalid" }, now), true);
  assert.equal(isMissingProgress({ ...stale, started_at: "invalid", created: "invalid" }, now), false);
  assert.deepEqual(buildHealthSummary([stale], now), { status: "warning", reason: "missing_progress" });
  const message = findLatestTrainingMessage([
    { timestamp: "", level: "", message: "python train.py --epochs 10" },
    { timestamp: "", level: "INFO", message: "epoch 2/10 loss 0.4" },
    { timestamp: "", level: "", message: "tmux attach -t simple" },
  ]);
  assert.equal(message, "epoch 2/10 loss 0.4");
});


test("train_test missing progress uses task start time instead of refreshed runtime time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-missing-progress-"));
  const now = Date.now();
  const started = new Date(now - 20 * 60 * 1000).toISOString();
  const updated = new Date(now - 1000).toISOString();
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-train-stale", type: "worker_run", status: "running", stage: "train_test", started_at: started, updated },
      { global_job_id: "run-test-stale", type: "worker_run", status: "running", stage: "test", started_at: started, updated },
    ]),
  });
  const overviewRun = await runCli(["experiment", "overview", "--json"], { cwd: dir });
  assert.equal(overviewRun.code, 0, overviewRun.stderr);
  const overview = JSON.parse(overviewRun.stdout);
  assert.deepEqual(overview.alerts.missing_progress.map((row) => row.id), ["run-train-stale"]);
  assert.deepEqual(overview.health, { status: "warning", reason: "missing_progress" });

  const healthRun = await runCli(["experiment", "health", "--json"], { cwd: dir });
  assert.equal(healthRun.code, 0, healthRun.stderr);
  const health = JSON.parse(healthRun.stdout);
  assert.equal(health.health.status, "warning");
  assert.equal(health.health.reason, "missing_progress");
  assert.equal(health.alerts.missing_progress, true);

  const inspectRun = await runCli(["experiment", "inspect", "run-train-stale", "--json"], { cwd: dir });
  assert.equal(inspectRun.code, 0, inspectRun.stderr);
  const inspect = JSON.parse(inspectRun.stdout);
  assert.equal(inspect.alerts.missing_progress, true);
  assert.deepEqual(inspect.health, { status: "warning", reason: "missing_progress" });
});


test("status monitor and diagnose share runtime fields with inspect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-runtime-query-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": "2026-03-01T00:00:00Z INFO epoch 4/10 loss 0.31\n",
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
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
  const monitor = JSON.parse((await runCli(["experiment", "monitor", id, "--json"], args)).stdout);
  const diagnosis = JSON.parse((await runCli(["experiment", "diagnose", id, "--json"], args)).stdout);
  assert.equal(status.status, inspected.summary.status);
  assert.equal(status.health_status, inspected.summary.health_status);
  assert.deepEqual(status.worker, inspected.status.worker);
  assert.deepEqual(status.gpu, inspected.status.gpu);
  assert.deepEqual(status.progress, inspected.progress);
  assert.equal(monitor.stage, inspected.status.stage);
  assert.deepEqual(monitor.progress, inspected.progress);
  assert.equal(monitor.updated_at, inspected.status.updated_at);
  assert.equal(diagnosis.health_status, inspected.summary.health_status);
});


test("query commands share one runtime snapshot schema", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-snapshot-schema-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "base_config: configs/base.yaml",
      "python -m train --config plan.yaml",
      "dataset: data/train encoder: resnet",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12 loss 0.31 auc 0.82",
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
  const monitor = JSON.parse((await runCli(["experiment", "monitor", id, "--json"], args)).stdout);
  const diagnosis = JSON.parse((await runCli(["experiment", "diagnose", id, "--json"], args)).stdout);
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);

  for (const key of ["status", "health_status", "stage"]) {
    assert.equal(status[key], monitor[key], key);
    assert.equal(status[key], diagnosis[key], key);
  }
  assert.equal(status.status, inspected.summary.status);
  assert.equal(status.stage, inspected.status.stage);
  assert.equal(status.updated_at, monitor.updated_at);

  const progressKeys = ["epoch", "max_epoch", "percent", "loss", "updated_at"];
  for (const payload of [status.progress, monitor.progress, inspected.progress, active.runs[0].progress]) {
    assert.deepEqual(Object.keys(payload).sort(), progressKeys.slice().sort());
  }
  assert.deepEqual(status.progress, monitor.progress);
  assert.deepEqual(status.progress, inspected.progress);

  for (const node of [status, diagnosis, active.runs[0]]) {
    assert.deepEqual(node.worker, { id: "worker-a" });
    assert.deepEqual(node.gpu, { id: "0" });
  }
  assert.match(monitor.latest_message, /loss 0\.31/);
  assert.doesNotMatch(monitor.latest_message, /yaml|config|python\s+-m/i);
  assert.ok(monitor.latest_message.length <= 300);
  assert.equal("last_update" in status, false);
  assert.equal("last_update" in monitor, false);
  assert.equal("last_update" in diagnosis, false);
  assert.equal(status.updated_at, diagnosis.updated_at);
  assert.deepEqual(status.progress, diagnosis.progress);
  assert.deepEqual(status.worker, diagnosis.worker);
  assert.deepEqual(status.gpu, diagnosis.gpu);
  for (const payload of [status, monitor, diagnosis, inspected.snapshot]) {
    assert.match(String(payload.snapshot_id), /^\d+$/);
    assert.match(String(payload.snapshot_time), /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.deepEqual(
    [status.progress.epoch, status.progress.loss, status.progress.updated_at],
    [diagnosis.progress.epoch, diagnosis.progress.loss, diagnosis.progress.updated_at],
  );
  assert.deepEqual(
    [status.progress.epoch, status.progress.loss, status.progress.updated_at],
    [inspected.progress.epoch, inspected.progress.loss, inspected.progress.updated_at],
  );
});
