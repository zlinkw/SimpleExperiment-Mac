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


test("resolved recent failures stay in summary history but leave overview alerts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-resolved-history-"));
  const stamp = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const failed = (id, experiment_case, minutes) => ({ global_job_id: id, type: "worker_run", status: "failed", plan: "p.yaml", experiment_case, seed: "42", created: stamp(minutes + 1), updated: stamp(minutes) });
  const success = (id, experiment_case, minutes) => ({ global_job_id: id, type: "worker_run", status: "success", plan: "p.yaml", experiment_case, seed: "42", created: stamp(minutes + 1), updated: stamp(minutes) });
  writeProject(dir, { "simple_cluster/experiment_index.json": JSON.stringify([
    failed("A-old", "A", 20), success("A-new", "A", 5),
    failed("B-old", "B", 30), success("B-new", "B", 6),
  ]) });
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overview.health, { status: "healthy", reason: "" });
  assert.deepEqual(overview.alerts.failed_recent, []);
  assert.deepEqual(overview.summary.recent_failures.map((row) => row.id), ["A-old", "B-old"]);
  const full = JSON.parse((await runCli(["experiment", "overview", "--json", "--full"], { cwd: dir })).stdout);
  assert.deepEqual(full.alerts.failed_recent, []);
  assert.deepEqual(full.summary.recent_failures.map((row) => row.id), ["A-old", "B-old"]);
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(summary.recent_failures.map((row) => row.id), ["A-old", "B-old"]);
});


test("overview alerts prioritize unresolved failures before running retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-failure-priority-"));
  const stamp = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const failed = (id, experiment_case, minutes) => ({ global_job_id: id, type: "worker_run", status: "failed", plan: "p.yaml", experiment_case, seed: "42", created: stamp(minutes + 1), updated: stamp(minutes) });
  const running = (id, experiment_case) => ({ global_job_id: id, type: "worker_run", status: "running", plan: "p.yaml", experiment_case, seed: "42", created: stamp(5), updated: stamp(1) });
  writeProject(dir, { "simple_cluster/experiment_index.json": JSON.stringify([
    failed("A-old", "A", 15), failed("B-old", "B", 16),
    failed("X-old", "X", 60), failed("Y-old", "Y", 61),
    running("A-new", "A"), running("B-new", "B"),
  ]) });
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.equal(overview.health.status, "error");
  assert.deepEqual(overview.alerts.failed_recent.map((row) => row.id), ["X-old", "Y-old", "A-old"]);
  const full = JSON.parse((await runCli(["experiment", "overview", "--json", "--full"], { cwd: dir })).stdout);
  assert.deepEqual(full.alerts.failed_recent.map((row) => row.id), ["X-old", "Y-old", "A-old", "B-old"]);
});


test("health alert counts failure attempts by experiment identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-failure-count-"));
  const stamp = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const failed = (id, experiment_case, minutes) => ({ global_job_id: id, type: "worker_run", status: "failed", plan: "p.yaml", experiment_case, seed: "42", created: stamp(minutes + 1), updated: stamp(minutes) });
  const rows = [
    ...[70, 69, 68, 67].map((minutes, index) => failed(`X-${index}`, "X", minutes)),
    ...["A", "B", "controls"].flatMap((experiment_case) => [
      failed(`${experiment_case}-1`, experiment_case, 30),
      failed(`${experiment_case}-2`, experiment_case, 20),
      { global_job_id: `${experiment_case}-new`, type: "worker_run", status: "running", plan: "p.yaml", experiment_case, seed: "42", created: stamp(5), updated: stamp(1) },
    ]),
  ];
  writeProject(dir, { "simple_cluster/experiment_index.json": JSON.stringify(rows) });
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  assert.equal(health.health.status, "error");
  const message = health.alerts.alert_details.find((item) => item.type === "recent_failure").message;
  assert.match(message, /1 unresolved experiment identity/);
  assert.match(message, /4 recent failed attempts/);
  assert.match(message, /3 experiment identities/);
  assert.match(message, /running retries/);
});


test("progress includes updated_at for active status and inspect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-progress-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-100",
        type: "run",
        status: "running",
        stage: "run",
        updated: "2026-03-01T00:00:00Z",
        progress: { epoch: 2, max_epoch: 10, percent: 20, loss: 0.4 },
      },
    ], null, 2),
  });
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], { cwd: dir })).stdout);
  const status = JSON.parse((await runCli(["experiment", "status", "run-100", "--json"], { cwd: dir })).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-100", "--json"], { cwd: dir })).stdout);
  for (const progress of [active.runs[0].progress, status.progress, inspected.progress]) {
    assert.equal(progress.epoch, 2);
    assert.equal(progress.percent, 20);
    assert.equal(progress.updated_at, "2026-03-01T00:00:00.000Z");
  }
  assert.equal(typeof inspected.diagnosis.stale_seconds, "number");
  assert.ok(inspected.diagnosis.stale_seconds > 0);
  assert.equal(inspected.status.updated_at, "2026-03-01T00:00:00.000Z");
});


test("failure rows share one schema across overview health and summary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-failure-schema-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-bad", type: "run", status: "failed", plan: "plan.yaml", worker_id: "worker-a", stage: "run", updated: new Date().toISOString() },
    ], null, 2),
  });
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  const rows = [overview.alerts.failed_recent[0], summary.recent_failures[0]];
  assert.deepEqual(rows[0], rows[1]);
  for (const key of FAILURE_KEYS) assert.equal(key in rows[0], true, key);
  assert.equal(health.health.status, "error");
});


test("old failures do not mark current health as error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-old-failure-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-old", type: "run", status: "failed", updated: "2020-01-01T00:00:00Z" },
      { global_job_id: "run-1789994720003", type: "run", status: "running", stage: "train", updated: new Date().toISOString() },
    ], null, 2),
  });
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  assert.equal(health.health.status, "healthy");
  assert.equal(health.alerts.recent_failure, false);
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], { cwd: dir })).stdout);
  assert.equal(active.runs[0].id, "run-1789994720003");
  assert.equal(active.runs[0].stage, "train");
  assert.equal("progress" in active.runs[0], true);
});
