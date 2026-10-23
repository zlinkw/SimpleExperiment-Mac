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


test("runtime progress and training messages stay consistent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-runtime-consistency-"));
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "base_config: configs/base.yaml",
      "python -m train --config plan.yaml",
      "cut_lr: 0.1",
      "gate_l2: 0.01",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12 loss 0.31",
    ].join("\n"),
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        updated: new Date().toISOString(),
        stdout: "experiments/runs/run-1789994720003/stdout.log",
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  const monitor = JSON.parse((await runCli(["experiment", "monitor", "run-1789994720003", "--json"], args)).stdout);
  assert.notEqual(active.runs[0].progress, null);
  assert.deepEqual(Object.keys(active.runs[0].progress).sort(), ["epoch", "loss", "max_epoch", "percent", "updated_at"]);
  assert.deepEqual(inspected.progress, active.runs[0].progress);
  assert.equal(inspected.diagnosis.latest_message, monitor.latest_message);
  assert.match(inspected.diagnosis.latest_message, /loss 0\.31/);
  assert.doesNotMatch(inspected.diagnosis.latest_message, /yaml|config|python\s+-m|gate_l2/i);
});


test("agent json apis share schema version 1", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-agent-schema-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-1789994720003", type: "run", status: "running", stage: "run", updated, progress: { epoch: 4, loss: 0.31 } },
    ], null, 2),
  });
  const args = { cwd: dir };
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  for (const payload of [active, health, overview, inspected]) assert.equal(payload.schema_version, "1");
  assert.match(active.runs[0].updated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(health.snapshot).sort(), ["runtime_source", "runtime_version", "snapshot_id", "snapshot_time"]);
  assert.match(String(health.snapshot.snapshot_id), /^\d+$/);
  assert.match(overview.snapshot.snapshot_time, /^\d{4}-\d{2}-\d{2}T/);
  for (const payload of [active, health, overview, inspected]) {
    for (const key of ["snapshot_id", "snapshot_time", "runtime_version"]) assert.equal(key in payload.snapshot, true, key);
  }
  assert.deepEqual(Object.keys(inspected).sort(), ["alerts", "diagnosis", "health", "progress", "schema_version", "snapshot", "status", "summary"]);
  assert.equal("failure_context" in inspected.diagnosis, false);
});


test("agent json schema version 1 stays frozen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-schema-frozen-"));
  const failedDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-schema-failed-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-1789994720003", type: "run", status: "running", stage: "run", case: "case-a", seed: "7", updated, progress: { epoch: 4, loss: 0.31 } },
    ], null, 2),
  });
  writeProject(failedDir, {
    "experiments/runs/run-bad/stdout.log": "2026-03-01T00:00:00Z ERROR CUDA out of memory\n",
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-bad", type: "run", status: "failed", stage: "run", worker_id: "worker-a", updated, stdout: "experiments/runs/run-bad/stdout.log" },
    ], null, 2),
  });
  const running = { cwd: dir };
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], running)).stdout);
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], running)).stdout);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], running)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], running)).stdout);
  for (const payload of [active, health, overview, inspected]) assert.equal(payload.schema_version, "1");
  assert.deepEqual(Object.keys(active).sort(), ["active_count", "runs", "schema_version", "snapshot", "workflows"]);
  assert.deepEqual(Object.keys(health).sort(), ["alerts", "health", "schema_version", "snapshot"]);
  assert.deepEqual(Object.keys(overview).sort(), ["active", "alerts", "health", "schema_version", "snapshot", "summary"]);
  assert.deepEqual(Object.keys(inspected).sort(), ["alerts", "diagnosis", "health", "progress", "schema_version", "snapshot", "status", "summary"]);
  for (const payload of [active, health, overview, inspected]) {
    assert.deepEqual(Object.keys(payload.snapshot).sort(), ["runtime_source", "runtime_version", "snapshot_id", "snapshot_time"]);
  }
  assert.deepEqual(Object.keys(health.health).sort(), ["alert_level", "reason", "status"]);
  assert.equal(health.health.alert_level, "ok");
  assert.deepEqual(Object.keys(overview.health).sort(), ["reason", "status"]);
  assert.equal("alert_level" in inspected.health, false);
  assert.equal("failure_context" in inspected.diagnosis, false);
  assert.deepEqual(Object.keys(active.runs[0]).sort(), ["experiment_case", "gpu", "id", "progress", "seed", "stage", "updated_at", "worker"]);
  const failed = JSON.parse((await runCli(["experiment", "inspect", "run-bad", "--json"], { cwd: failedDir })).stdout);
  assert.equal(failed.schema_version, "1");
  assert.deepEqual(Object.keys(failed.diagnosis.failure_context).sort(), ["last_error", "stage", "worker"]);
  assert.match(failed.diagnosis.failure_context.last_error, /out of memory/i);
  assert.ok(failed.diagnosis.failure_context.last_error.length <= 300);
  assert.equal(failed.diagnosis.failure_context.stage, "run");
  assert.deepEqual(failed.diagnosis.failure_context.worker, { id: "worker-a" });
});


test("experiment references resolve the same way for every query", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-reference-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "exp-1", run_id: "run-9001", runtimeRunId: "run-stale-alias", id: "raw-1", case: "case-a", tmux: "simple:run-9001", type: "run", status: "running", stage: "run", updated: new Date().toISOString() },
      { global_job_id: "exp-2", type: "run", status: "success", stage: "run", updated: "2026-01-01T00:00:00Z" },
    ], null, 2),
  });
  const args = { cwd: dir };
  for (const ref of ["exp-1", "run-9001", "run-stale-alias", "case-a", "raw-1", "simple:run-9001"]) {
    const result = await runCli(["experiment", "inspect", ref, "--json"], args);
    assert.equal(result.code, 0, ref);
    assert.equal(JSON.parse(result.stdout).summary.id, "exp-1", ref);
  }
  for (const command of ["status", "monitor", "diagnose"]) {
    const result = await runCli(["experiment", command, "run-9001", "--json"], args);
    assert.equal(result.code, 0, command);
    assert.equal(JSON.parse(result.stdout).id, "exp-1", command);
  }
  const missing = await runCli(["experiment", "inspect", "does-not-exist", "--json"], args);
  assert.equal(missing.code, 3);
  const body = JSON.parse(missing.stdout);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "BUSINESS");
  assert.equal(body.error.detail.requested, "does-not-exist");
  assert.deepEqual(body.error.detail.candidates, ["exp-1", "exp-2"]);
  assert.ok(body.error.detail.candidates.length <= 5);
});


test("active run ids resolve through inspect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-active-inspect-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-1789994720003", type: "run", status: "running", stage: "run", updated: new Date().toISOString(), progress: { epoch: 4, loss: 0.31 } },
    ], null, 2),
  });
  const args = { cwd: dir };
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  assert.ok(active.runs.length > 0);
  for (const run of active.runs) {
    const inspected = await runCli(["experiment", "inspect", run.id, "--json"], args);
    assert.equal(inspected.code, 0, run.id);
    assert.equal(JSON.parse(inspected.stdout).summary.id, run.id);
  }
  const missing = await runCli(["experiment", "inspect", "run-000", "--json"], args);
  assert.equal(missing.code, 3);
  const detail = JSON.parse(missing.stdout).error.detail;
  assert.equal(detail.requested, "run-000");
  assert.deepEqual(detail.searched_sources, ["current_rows", "runtime_history", "experiment_index", "runtime_observation"]);
  assert.ok(detail.candidates.length <= 5);
});


test("runtime observations resolve to experiment rows", () => {
  const { runtimeRow, resolveRuntimeObservation, lifecycleOf, applyObservationFields } = require("../../dist/cli/commands/experiment.js");
  const observation = {
    run_id: "run-9001",
    plan: "plan.yaml",
    status: "running",
    worker: { id: "worker-a", host: "127.0.0.1" },
    tmux: { session: "simple", window: "simple:3", pane: "simple:3.0" },
    stage: "run",
    progress: { epoch: 4, max_epoch: 10, batch: null, total_batch: null, percent: 40, loss: 0.31, lr: null, memory: null },
    gpu: { id: "0", memory: "", utilization: "" },
    config: { path: "", experiment_case: "case-a", seed: "7", model: "", dataset: "" },
    log: "",
    updated_at: "2026-03-01T00:00:00Z",
  };
  assert.equal(resolveRuntimeObservation("run-9001", [observation]).run_id, "run-9001");
  assert.equal(resolveRuntimeObservation("simple:3", [observation]).run_id, "run-9001");
  const row = runtimeRow(observation);
  assert.equal(row.id, "run-9001");
  assert.equal(row.type, "worker_run");
  assert.equal(row.status, "running");
  assert.equal(row.worker_id, "worker-a");
  assert.equal(row.stage, "run");
  assert.equal(row.plan, "plan.yaml");
  assert.equal(row.gpu.id, "0");
  assert.equal(row.progress.epoch, 4);
  assert.equal(typeof row.health_status, "string");
  assert.equal(row.lifecycle, "running");
  assert.equal(lifecycleOf("success"), "finished");
  assert.equal(lifecycleOf("failed"), "failed");
  assert.equal(lifecycleOf("cancelled"), "cancelled");
  const history = runtimeRow(observation);
  history.source = "history";
  history.status = "success";
  history.lifecycle = "finished";
  applyObservationFields(history, observation);
  assert.equal(history.status, "running");
  assert.equal(history.source, "runtime_observation");
  assert.equal(history.lifecycle, "running");
  assert.equal(lifecycleOf("pending"), "");
});
