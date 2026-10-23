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


test("runtime row prefers direct Worker task id over tmux runtime alias", () => {
  const { runtimeRow, resolveRuntimeObservation, applyObservationFields } = require("../../dist/cli/commands/experiment.js");
  const observation = {
    run_id: "run-1790241627897", plan: "experiments/plans/comparison/corim.yaml", status: "running",
    worker: { id: "nwpu2", host: "" }, tmux: { session: "zlk-gpu-1", window: "zlk-gpu-1:2", pane: "zlk-gpu-1:2.0" },
    stage: "train_test", progress: null, gpu: { id: "1", memory: "", utilization: "" },
    config: { path: "", experiment_case: "corim_pad_p100", seed: "43", model: "", dataset: "" },
    worker_task: { id: "run6-600294-437", status: "running", plan: "experiments/plans/comparison/corim.yaml", gpu_id: "1", experiment_case: "corim_pad_p100", seed: "43", started_at: "2026-09-24T09:20:27Z", finished_at: "", log_updated_at: "2026-09-24T09:20:50Z" },
    log: "", updated_at: "2026-09-24T09:21:00Z",
  };
  const row = runtimeRow(observation);
  assert.equal(row.id, "run6-600294-437");
  assert.equal(row.run_id, "run-1790241627897");
  assert.equal(row.created, "2026-09-24T09:20:27Z");
  assert.equal(row.started_at, "2026-09-24T09:20:27Z");
  assert.equal(row.raw.runtimeActivityAt, "2026-09-24T09:20:50Z");
  const history = { ...row, created: "2026-09-24T09:19:00Z", started_at: "2026-09-24T09:19:01Z" };
  applyObservationFields(history, observation);
  assert.equal(history.created, "2026-09-24T09:19:00Z");
  assert.equal(history.started_at, "2026-09-24T09:19:01Z");
  assert.equal(resolveRuntimeObservation("run6-600294-437", [observation]), observation);
  assert.equal(resolveRuntimeObservation("run-1790241627897", [observation]), observation);
  assert.equal(runtimeRow({ ...observation, worker_task: null }).id, observation.run_id);
});


test("wrapped runtime capture merges into the stable worker identity", async () => {
  const { workerHistoryIdentityMatchesRuntime, applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const observation = corimObservation(wrappedRuntimeCapture());
  const history = {
    id: "run0-228782-829", run_id: "run0-228782-829", type: "worker_run", source: "history", status: "running",
    worker_id: "nwpu2", gpu: { id: "0" }, plan: "experiments/plans/comparison/corim.yaml",
    name: "corim_bus_p100", experiment_case: "corim_bus_p100", seed: "42", tmux: "zlk-gpu-0",
    stage: "train_test", created: "2026-09-24T06:27:16Z", parent_id: "", raw: {},
  };
  assert.equal(workerHistoryIdentityMatchesRuntime(history, observation), true);
  const byId = new Map([[history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.deepEqual([...byId.keys()], [history.id]);
  assert.equal(history.run_id, observation.run_id);
  assert.equal(history.seed, "42");
  assert.equal(history.stage, "train_test");
  assert.equal(history.name, "corim_bus_p100");
});


test("physical worker identity requires matching worker GPU metadata and launch time", () => {
  const { workerHistoryMatchesRuntime, workerHistoryIdentityMatchesRuntime } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  assert.equal(workerHistoryMatchesRuntime(history, observation), true);
  assert.equal(workerHistoryMatchesRuntime({ ...history, created: "2026-09-23T09:56:00Z" }, observation), false);
  assert.equal(workerHistoryMatchesRuntime({ ...history, gpu: { id: "1" } }, observation), false);
  assert.equal(workerHistoryMatchesRuntime({ ...history, experiment_case: "B" }, observation), false);
  assert.equal(workerHistoryMatchesRuntime({ ...history, tmux: "zlk-gpu-1" }, observation), false);
  assert.equal(workerHistoryMatchesRuntime({ ...history, worker_id: "" }, observation), false);
  assert.equal(workerHistoryMatchesRuntime({ ...history, source: "runtime_observation" }, observation), false);
  assert.equal(workerHistoryMatchesRuntime({ ...history, status: "success" }, observation), false);
  assert.equal(workerHistoryIdentityMatchesRuntime({ ...history, status: "success" }, observation), true);
  assert.equal(workerHistoryMatchesRuntime({ ...history, plan: "other.yaml" }, observation), false);
  assert.equal(workerHistoryMatchesRuntime({ ...history, seed: "43" }, observation), false);
  assert.equal(workerHistoryMatchesRuntime({ ...history, created: "" }, observation), false);
  assert.equal(workerHistoryMatchesRuntime(history, { ...observation, run_id: "run-unknown" }), false);
  const withExplicitStart = { ...observation, run_id: "run-unknown", worker_task: { started_at: history.created } };
  assert.equal(workerHistoryMatchesRuntime(history, withExplicitStart), true);
  assert.equal(workerHistoryMatchesRuntime(history, { ...withExplicitStart, worker_task: { started_at: "2026-09-23T09:56:00Z" } }), false);
});


test("runtime observation enriches the stable worker task row without a duplicate", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  const workflow = { id: "wf-current", type: "workflow", status: "running", plan: history.plan };
  const byId = new Map([[workflow.id, workflow], [history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(byId.size, 2);
  assert.equal(byId.has(history.id), true);
  assert.equal(byId.has(observation.run_id), false);
  assert.equal(history.id, "run0-326826-291");
  assert.equal(history.source, "runtime_observation");
  assert.equal(history.run_id, observation.run_id);
  assert.deepEqual(history.progress, observation.progress);
  assert.equal(history.stage, "branch");
  assert.equal(history.parent_id, workflow.id);
  assert.equal(history.raw.runtimeRunId, observation.run_id);
  assert.equal(history.raw.workerTaskId, history.id);
});


test("direct Worker task id keeps canonical identity when Hub history row is absent", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { observation } = physicalWorkerFixture();
  observation.run_id = "run-1790241627897";
  observation.worker_task = { id: "run6-600294-437", status: "running", plan: observation.plan, gpu_id: "0", experiment_case: "A", seed: "42", started_at: "2026-09-24T09:20:27Z", finished_at: "" };
  const workflow = { id: "wf-current", type: "workflow", status: "running", plan: observation.plan };
  const byId = new Map([[workflow.id, workflow]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(byId.has("run6-600294-437"), true);
  assert.equal(byId.has(observation.run_id), false);
  const row = byId.get("run6-600294-437");
  assert.equal(row.id, "run6-600294-437");
  assert.equal(row.run_id, observation.run_id);
  assert.equal(row.source, "runtime_observation");
  assert.equal(row.status, "running");
  assert.equal(row.parent_id, workflow.id);
  assert.equal(row.raw.workerTaskId, row.id);
  assert.equal(row.raw.runtimeRunId, observation.run_id);
});


test("direct Worker task id outranks a different physical history match", async () => {
  const { applyRuntimeObservations, workerHistoryMatchesRuntime } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  observation.worker_task = { id: "run6-600294-437", status: "running", plan: history.plan, gpu_id: "0", experiment_case: "A", seed: "42", started_at: history.created, finished_at: "" };
  assert.equal(workerHistoryMatchesRuntime(history, observation), true);
  const byId = new Map([[history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(byId.has(history.id), true);
  assert.equal(byId.has(observation.worker_task.id), true);
  assert.equal(byId.has(observation.run_id), false);
  assert.equal(history.source, "history");
});
