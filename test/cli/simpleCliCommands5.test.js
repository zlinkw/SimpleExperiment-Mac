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


test("runtime launch seed survives tmux wrapping with context JSON", () => {
  const observation = corimObservation(wrappedRuntimeCapture());
  assert.equal(observation.config.seed, "42");
  assert.notEqual(observation.config.seed, "422026-09-24");
  assert.equal(observation.worker.id, "nwpu2");
  assert.equal(observation.gpu.id, "0");
  assert.equal(observation.plan, "experiments/plans/comparison/corim.yaml");
  assert.equal(observation.config.experiment_case, "corim_bus_p100");
});


test("runtime launch seed reads raw flag when context has no seed", () => {
  const observation = corimObservation(wrappedRuntimeCapture("43", null, "work_dirs/corim/job_config.yaml"));
  assert.equal(observation.config.seed, "43");
});


test("runtime launch rejects a seed token that is not an integer", () => {
  const observation = corimObservation(wrappedRuntimeCapture("invalid2026-09-24", null, "work_dirs/corim/job_config.yaml"));
  assert.equal(observation.config.seed, "");
});


test("runtime capture retains standard epoch evidence before job config download", () => {
  const observation = corimObservation(`${wrappedRuntimeCapture()}\nEpoch 15: Val Loss = 1.3842, accuracy = 0.6409`);
  assert.equal(observation.progress.epoch, 15);
  assert.equal(observation.progress.loss, 1.3842);
  assert.equal(observation.progress.max_epoch, null);
  assert.equal(observation.progress.percent, null);
  assert.equal(observation.config.max_epoch, null);
});


test("running observation uses one worker config download to complete percent", async () => {
  const api = require("../../dist/cli/api.js");
  const { observeRunningExperiments } = require("../../dist/cli/runtime.js");
  const originalOptionalApi = api.optionalApi;
  const requests = [];
  const capture = `${wrappedRuntimeCapture()}\nEpoch 15: Val Loss = 1.3842, accuracy = 0.6409`;
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "Content-Type": request.url.startsWith("/api/files/download") ? "text/plain" : "application/json" });
    if (request.url === "/api/tmux/list") response.end(JSON.stringify({ sessions: [{ name: "zlk-gpu-0", windows: [{ name: "run-1790231236812", index: "1", target: "zlk-gpu-0:1" }] }] }));
    else if (request.url.startsWith("/api/tmux/capture")) response.end(JSON.stringify({ text: capture }));
    else if (request.url.startsWith("/api/files/download")) response.end("train:\n  epochs: 300\nmodel:\n  name: corim\ndata:\n  dataset: bus\n");
    else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.optionalApi = async () => ({ value: { workerTunnels: [{ id: "nwpu2", localForwardHost: "127.0.0.1", localForwardPort: server.address().port }] } });
  try {
    const observations = await observeRunningExperiments();
    assert.equal(observations.length, 1);
    assert.equal(observations[0].progress.epoch, 15);
    assert.equal(observations[0].progress.max_epoch, 300);
    assert.equal(observations[0].progress.percent, 5);
    assert.equal(requests.filter((url) => url.startsWith("/api/files/download")).length, 1);
  } finally {
    api.optionalApi = originalOptionalApi;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});


test("worker tmux metadata skips terminal windows before capture", async () => {
  const api = require("../../dist/cli/api.js");
  const { observeRunningExperiments } = require("../../dist/cli/runtime.js");
  const originalOptionalApi = api.optionalApi;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/api/tmux/list") response.end(JSON.stringify({ sessions: [{ name: "zlk-gpu-0", windows: [
      { name: "run-1790237001150", target: "zlk-gpu-0:1", task: { commandId: "run3-998997-687", status: "running", gpuId: "0", case: "corim_bus_p100", seed: 45, planFile: "experiments/plans/comparison/corim.yaml", startedAt: "2026-09-24T08:03:21Z", logUpdatedAt: "2026-09-24T11:30:00Z", outputDir: "work_dirs/corim/3_seed45", configPath: "work_dirs/corim/3_seed45/job_config.yaml" } },
      { name: "run-1790231236812", target: "zlk-gpu-0:2", task: { commandId: "run0-228782-829", status: "completed", gpuId: "0", case: "corim_bus_p100", seed: 42, planFile: "experiments/plans/comparison/corim.yaml", startedAt: "2026-09-24T06:27:16Z", finishedAt: "2026-09-24T08:03:04Z" } },
    ] }] }));
    else if (request.url.startsWith("/api/tmux/capture")) response.end(JSON.stringify({ text: "Epoch 10: Val Loss = 0.4" }));
    else response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.optionalApi = async () => ({ value: { workerTunnels: [{ id: "nwpu2", localForwardHost: "127.0.0.1", localForwardPort: server.address().port }] } });
  try {
    const observations = await observeRunningExperiments();
    assert.equal(observations.length, 1);
    const [observation] = observations;
    assert.equal(observation.run_id, "run-1790237001150");
    assert.equal(observation.worker_task.id, "run3-998997-687");
    assert.equal(observation.worker_task.status, "running");
    assert.equal(observation.worker_task.log_updated_at, "2026-09-24T11:30:00Z");
    assert.equal(observation.worker_task.output_dir, "work_dirs/corim/3_seed45");
    assert.equal(observation.worker_task.config_path, "work_dirs/corim/3_seed45/job_config.yaml");
    assert.equal(observation.plan, "experiments/plans/comparison/corim.yaml");
    assert.equal(observation.gpu.id, "0");
    assert.equal(observation.config.experiment_case, "corim_bus_p100");
    assert.equal(observation.config.seed, "45");
    assert.equal(requests.filter((url) => url.startsWith("/api/tmux/capture")).length, 1);
    assert.equal(requests.some((url) => url.includes("zlk-gpu-0%3A2")), false);
    assert.equal(requests.filter((url) => url.startsWith("/api/files/download")).length, 1);
  } finally {
    api.optionalApi = originalOptionalApi;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
