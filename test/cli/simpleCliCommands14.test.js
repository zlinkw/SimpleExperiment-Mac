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


test("unknown cached worker row reactivates through exact Worker task id", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  history.id = "run6-600294-437";
  history.status = "unknown";
  observation.run_id = "run-1790241627897";
  observation.worker_task = { id: history.id, status: "running", plan: history.plan, gpu_id: "0", experiment_case: "A", seed: "42", started_at: "2026-09-24T09:20:27Z", finished_at: "" };
  const byId = new Map([[history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.deepEqual([...byId.keys()], [history.id]);
  assert.equal(history.status, "running");
  assert.equal(history.source, "runtime_observation");
  assert.equal(history.run_id, observation.run_id);
});


test("terminal worker history suppresses stale runtime observation", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  history.status = "success";
  history.finished_at = "2026-09-24T05:39:11Z";
  history.updated = history.finished_at;
  history.progress = { epoch: 102, percent: 33.8 };
  const priorProgress = history.progress;
  const byId = new Map([[history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(byId.has(observation.run_id), false);
  assert.equal(history.id, "run0-326826-291");
  assert.equal(history.status, "success");
  assert.equal(history.source, "history");
  assert.equal(history.run_id, history.id);
  assert.equal(history.progress, priorProgress);
  assert.equal(history.updated, history.finished_at);
  assert.equal(history.raw.runtimeRunId, observation.run_id);
  assert.equal(history.raw.workerTaskId, history.id);
});


test("terminal history outranks direct running task id", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  history.status = "success";
  history.finished_at = "2026-09-24T05:39:11Z";
  observation.worker_task = { id: history.id, status: "running", plan: history.plan, gpu_id: "0", experiment_case: "A", seed: "42", started_at: history.created, finished_at: "" };
  const byId = new Map([[history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.deepEqual([...byId.keys()], [history.id]);
  assert.equal(history.status, "success");
  assert.equal(history.source, "history");
  assert.equal(history.raw.runtimeRunId, observation.run_id);
});


test("exact runtime alias cannot revive terminal worker history", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  history.status = "success";
  history.run_id = observation.run_id;
  history.finished_at = "2026-09-24T05:39:11Z";
  history.updated = history.finished_at;
  const byId = new Map([[history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(byId.has(observation.run_id), false);
  assert.equal(history.status, "success");
  assert.equal(history.source, "history");
  assert.equal(history.run_id, observation.run_id);
  assert.equal(history.updated, history.finished_at);
});


test("ambiguous terminal and running history leave runtime observation separate", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  const terminal = { ...history, id: "run0-terminal", run_id: "run0-terminal", status: "success", raw: {} };
  const byId = new Map([[terminal.id, terminal], [history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(terminal.source, "history");
  assert.equal(history.source, "history");
  assert.equal(byId.has(observation.run_id), true);
});


test("runtime observations attach only to nonterminal workflows", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { observation } = physicalWorkerFixture();
  const completed = { id: "wf-completed", type: "workflow", status: "success", plan: observation.plan };
  const running = { id: "wf-running", type: "workflow", status: "running", plan: observation.plan };
  const withRunning = new Map([[completed.id, completed], [running.id, running]]);
  await applyRuntimeObservations(withRunning, [observation]);
  assert.equal(withRunning.get(observation.run_id).parent_id, running.id);
  const terminalOnly = new Map([[completed.id, completed]]);
  await applyRuntimeObservations(terminalOnly, [observation]);
  assert.equal(terminalOnly.get(observation.run_id).parent_id, "");
});
