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


test("run history overrides the experiment index", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-history-priority-"));
  writeProject(dir, {
    "experiments/runs/run-1/artifact_manifest.json": JSON.stringify({ exitCode: 0, generatedAt: "2026-03-01T00:00:00Z" }),
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-1", status: "running", plan: "from-index.yaml", updated: new Date().toISOString(), progress: { epoch: 2, loss: 0.4 } },
    ], null, 2),
  });
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1", "--json"], { cwd: dir })).stdout);
  assert.equal(inspected.summary.status, "success");
  assert.equal(inspected.snapshot.runtime_source, "history");
  assert.equal(inspected.status.plan, "from-index.yaml");
  assert.equal(inspected.progress.epoch, 2);
});


test("runtime history keeps worker run fields without a live runtime", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-history-fields-"));
  writeProject(dir, {
    "experiments/runs/run-9/artifact_manifest.json": JSON.stringify({
      exitCode: 0,
      generatedAt: "2026-03-01T00:00:00Z",
      plan: "plan.yaml",
      worker_id: "worker-a",
      gpu: { id: "0" },
      stage: "run",
      experiment_case: "case-a",
      seed: "7",
      progress: { epoch: 3, loss: 0.2 },
    }),
    "experiments/runs/run-9/env_snapshot.json": "{}",
  });
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-9", "--json"], { cwd: dir })).stdout);
  assert.equal(inspected.summary.id, "run-9");
  assert.equal(inspected.summary.type, "worker_run");
  assert.equal(inspected.summary.status, "success");
  assert.equal(inspected.summary.experiment_case, "case-a");
  assert.equal(inspected.summary.seed, "7");
  assert.equal(inspected.status.plan, "plan.yaml");
  assert.equal(inspected.status.stage, "run");
  assert.deepEqual(inspected.status.worker, { id: "worker-a" });
  assert.deepEqual(inspected.status.gpu, { id: "0" });
  assert.equal(inspected.progress.epoch, 3);
  assert.equal(inspected.snapshot.runtime_source, "history");
  assert.equal(inspected.snapshot.runtime_version, "2026-03-01T00:00:00.000Z");
});


test("failed worker run history can be diagnosed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-history-failed-"));
  writeProject(dir, {
    "experiments/runs/run-9/artifact_manifest.json": JSON.stringify({ exitCode: 1, generatedAt: "2026-03-01T00:00:00Z" }),
    "experiments/runs/run-9/env_snapshot.json": "{}",
    "experiments/runs/run-9/stdout.log": "2026-03-01T00:00:00Z ERROR CUDA out of memory\n",
  });
  const args = { cwd: dir };
  const diagnosis = JSON.parse((await runCli(["experiment", "diagnose", "run-9", "--json"], args)).stdout);
  assert.equal(diagnosis.id, "run-9");
  assert.equal(diagnosis.status, "failed");
  assert.ok(diagnosis.reason.includes("cuda out of memory"));
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-9", "--json"], args)).stdout);
  assert.equal(inspected.schema_version, "1");
  assert.equal(inspected.summary.status, "failed");
});
