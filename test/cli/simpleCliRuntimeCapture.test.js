const { assert, fs, http, os, path, test, spawn, root, cli, validPlan, invalidPlan, runCli, writeProject, wrappedRuntimeCapture, corimObservation, FAILURE_KEYS, physicalWorkerFixture } = require("./simpleCli.support.cjs");

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

test("historical worker config resolves only through its exact terminal task window", async () => {
  const api = require("../../dist/cli/api.js");
  const { readWorkerTaskConfig } = require("../../dist/cli/runtime.js");
  const originalOptionalApi = api.optionalApi;
  const requests = [];
  const configPath = "work_dirs/corim/6_corim_pad_p100_seed43/job_config.yaml";
  const yaml = "seed: 43\ndata:\n  dataset: pad_ufes_20\nmodel:\n  name: frozen_feature_mlp\noptimizer:\n  name: AdamW\ntrain:\n  batch_size: 64\n  epochs: 300\n";
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/tmux/list") {
      response.end(JSON.stringify({ sessions: [{ name: "zlk-gpu-0", windows: [
        { target: "zlk-gpu-0:1", task: { commandId: "other-task", case: "corim_pad_p100", seed: 43 } },
        { target: "zlk-gpu-0:2", task: { commandId: "run6-600294-437", case: "corim_pad_p100", seed: 43 } },
      ] }] }));
    } else if (url.pathname === "/api/tmux/capture") {
      response.end(JSON.stringify({ text: wrappedRuntimeCapture("43", "43", configPath) }));
    } else if (url.pathname === "/api/files/download" && url.searchParams.get("path") === configPath) {
      response.end(yaml);
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.optionalApi = async () => ({ value: { workerTunnels: [{ id: "nwpu2", localForwardHost: "127.0.0.1", localForwardPort: server.address().port }] } });
  try {
    const result = await readWorkerTaskConfig("nwpu2", "run6-600294-437");
    assert.equal(result.config_path, configPath);
    assert.equal(result.yaml, yaml);
    assert.equal(requests.filter((url) => url.startsWith("/api/tmux/capture")).length, 1);
    assert.match(requests.find((url) => url.startsWith("/api/tmux/capture")), /zlk-gpu-0%3A2/);
    assert.match(requests.find((url) => url.startsWith("/api/tmux/capture")), /lines=4000/);
    assert.equal((await readWorkerTaskConfig("nwpu2", "run6-600294-437", configPath)).yaml, yaml);
    assert.equal(requests.filter((url) => url.startsWith("/api/tmux/capture")).length, 1);
  } finally {
    api.optionalApi = originalOptionalApi;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("experiment rows distinguish workflow and worker runs", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const progress = parseTrainingProgress("epoch 24/300 31% 53/171 0:02:00\n当前 loss 0.2387");
  assert.equal(progress.epoch, 24);
  assert.equal(progress.batch, 53);
  const workflow = { id: "run-plan-1", type: "workflow", plan: "experiments/plans/demo.yaml" };
  const worker = { id: "run-1789994720003", type: "worker_run", plan: workflow.plan, parent_id: workflow.id, progress };
  assert.equal(worker.type, "worker_run");
  assert.notEqual(workflow.type, worker.type);
  assert.equal(worker.parent_id, workflow.id);
});
