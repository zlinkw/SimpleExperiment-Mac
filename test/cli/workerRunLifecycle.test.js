const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const cli = path.resolve(__dirname, "../../dist/cli.js");
const runId = "run0-123456-123";
const workflowId = "workflow-run-1";
const plan = "experiments/plans/baseline.yaml";

function callCli(root, apiFile, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "experiment", ...args, "--json"], {
      cwd: root,
      env: { ...process.env, SIMPLE_EXPERIMENT_API_FILE: apiFile },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, body: JSON.parse(stdout) }));
  });
}

test("scheduler worker run remains listed and inspectable after runtime disappears", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-worker-run-"));
  const stateFile = path.join(root, "simple_cluster", "tmp", "cluster_scheduler", "baseline_state.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(path.join(root, "simple_cluster", "experiment_index.json"), JSON.stringify([
    { global_job_id: runId, status: "failed", plan: "stale-plan.yaml", updated: "2026-09-22T00:00:00Z" },
  ]), "utf8");
  const started = "2026-09-23T00:00:00Z";
  const run = { session: runId, worker_id: "worker-a", gpu_id: "0", experiment_index: 0, output_dir: "work_dirs/baseline/case-a_seed7", started_at: started };
  const saveState = (bucket, row, updated) => fs.writeFileSync(stateFile, JSON.stringify({
    plan, scheduler_session: "scheduler-1", updated_at: updated,
    running_experiments: bucket === "running_experiments" ? [row] : [],
    completed_experiments: bucket === "completed_experiments" ? [row] : [],
    failed_experiments: bucket === "failed_experiments" ? [row] : [],
    stopped_experiments: bucket === "stopped_experiments" ? [row] : [],
  }), "utf8");
  saveState("running_experiments", run, started);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const result = method === "tasks.list"
        ? { schedulerStates: [state], experimentTraces: [] }
        : method === "operations.list"
          ? { records: [{ operationId: workflowId, type: "workflow-run", status: "running", planFile: plan, tmuxSession: "scheduler-1", startedAt: started }] }
          : method === "state.get" ? { value: { workerTunnels: [] } } : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const apiFile = path.join(root, "api.json");
  fs.writeFileSync(apiFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "test" }), "utf8");

  const active = await callCli(root, apiFile, ["list"]);
  assert.equal(active.code, 0);
  const worker = active.body.find((row) => row.id === runId);
  assert.equal(worker?.type, "worker_run");
  assert.equal(worker?.status, "running");
  assert.equal(worker?.parent_id, workflowId);
  assert.equal(active.body.filter((row) => row.id === runId).length, 1);
  assert.equal(worker?.plan, plan);

  saveState("completed_experiments", { ...run, status: "normal_completed", finished_at: "2026-09-23T00:03:00Z" }, "2026-09-23T00:03:00Z");
  const finished = await callCli(root, apiFile, ["list"]);
  assert.equal(finished.body.find((row) => row.id === runId)?.status, "success");
  const finishedInspect = await callCli(root, apiFile, ["inspect", runId]);
  assert.equal(finishedInspect.body.summary.status, "success");

  saveState("failed_experiments", { ...run, status: "failed", finished_at: "2026-09-23T00:04:00Z" }, "2026-09-23T00:04:00Z");
  const failed = await callCli(root, apiFile, ["list"]);
  assert.equal(failed.body.find((row) => row.id === runId)?.status, "failed");

  saveState("stopped_experiments", { ...run, status: "manual_interrupted_completed", manualInterrupted: true, finished_at: "2026-09-23T00:05:00Z" }, "2026-09-23T00:05:00Z");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).stopped_experiments[0].session, runId);
  const after = await callCli(root, apiFile, ["list"]);
  assert.equal(after.code, 0);
  assert.equal(after.body.find((row) => row.id === runId)?.status, "cancelled");
  const inspected = await callCli(root, apiFile, ["inspect", runId]);
  assert.equal(inspected.code, 0);
  assert.equal(inspected.body.summary.id, runId);
  assert.equal(inspected.body.summary.type, "worker_run");
  assert.equal(inspected.body.summary.status, "cancelled");
  assert.equal(inspected.body.snapshot.runtime_source, "history");
});

test("Worker Agent task snapshot survives after scheduler and runtime rows disappear", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-worker-snapshot-"));
  fs.mkdirSync(path.join(root, "experiments", "plans"), { recursive: true });
  const task = {
    runKey: runId, commandId: "cmd-1", workerId: "worker-a", status: "completed",
    planFile: plan, gpuId: "0", stage: "train_test", experimentCase: "baseline", seed: 7,
    outputDir: "work_dirs/demo/0_baseline_seed7",
    configPath: "work_dirs/demo/0_baseline_seed7/job_config.yaml",
    workflowId, startedAt: "2026-09-23T00:00:00Z", finishedAt: "2026-09-23T00:03:00Z",
  };
  const yaml = "experiment_name: suite/baseline/seed_7\nseed: 7\ndata:\n  dataset: pad_ufes_20\nmodel:\n  name: frozen_feature_mlp\noptimizer:\n  name: AdamW\ntrain:\n  batch_size: 64\n  epochs: 300\n";
  const resultRecord = {
    schemaVersion: 1, resultId: "worker-result-clean", experimentId: "suite/baseline/seed_7",
    runKey: "suite/baseline/seed_7:clean", status: "parsed",
    planFile: plan, workerId: "worker-a", dimensions: { case: "baseline", seed: 7, eval_protocol: "clean" },
    primaryMetric: "accuracy", metrics: { accuracy: { value: 0.91, higherIsBetter: true } },
    sourceFiles: [{ path: "experiments/results/demo.csv", type: "csv", endpoint: "worker" }],
    createdAt: "2026-09-23T00:04:00Z", updatedAt: "2026-09-23T00:04:00Z",
  };
  const workerServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/files/download" && url.searchParams.get("path") === task.configPath) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(yaml);
    } else if (url.pathname === "/api/results/summary") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schemaVersion: 1, resultCount: 1, parsedResults: 1, parseFailed: 0, results: [resultRecord] }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => workerServer.listen(0, "127.0.0.1", resolve));
  t.after(() => workerServer.close());
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = method === "tasks.list"
        ? { schedulerStates: [], experimentTraces: [], workerTasks: [
          { workerId: "worker-a", schemaVersion: 1, generatedAt: "2026-09-23T00:04:00Z", tasks: [task] },
          { workerId: "worker-b", tasks: [], error: "Worker task snapshot unavailable" },
        ] }
        : method === "operations.list"
          ? { records: [{ operationId: workflowId, type: "workflow-run", status: "completed", planFile: plan }] }
          : method === "state.get"
            ? { value: { workerTunnels: [{ id: "worker-a", localForwardHost: "127.0.0.1", localForwardPort: workerServer.address().port, enabled: true }] } }
          : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const apiFile = path.join(root, "api.json");
  fs.writeFileSync(apiFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "test" }), "utf8");

  const listed = await callCli(root, apiFile, ["list", "--type", "worker_run"]);
  assert.equal(listed.code, 0);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].id, runId);
  assert.equal(listed.body[0].type, "worker_run");
  assert.equal(listed.body[0].status, "success");
  const inspected = await callCli(root, apiFile, ["inspect", runId]);
  assert.equal(inspected.code, 0);
  assert.equal(inspected.body.summary.status, "success");
  assert.equal(inspected.body.snapshot.runtime_source, "history");
  assert.equal(inspected.body.status.plan, plan);
  assert.deepEqual(inspected.body.status.worker, { id: "worker-a" });
  assert.deepEqual(inspected.body.status.gpu, { id: "0" });
  assert.equal(inspected.body.summary.experiment_case, "baseline");
  assert.equal(inspected.body.summary.seed, "7");
  const status = await callCli(root, apiFile, ["status", runId]);
  assert.equal(status.code, 0);
  assert.equal(status.body.id, runId);
  const diagnosis = await callCli(root, apiFile, ["diagnose", runId]);
  assert.equal(diagnosis.code, 0);
  assert.equal(diagnosis.body.id, runId);
  const config = await callCli(root, apiFile, ["config", runId]);
  assert.equal(config.code, 0);
  assert.equal(config.body.config_path, task.configPath);
  assert.equal(config.body.yaml, yaml);
  assert.equal(String(config.body.seed), "7");
  assert.equal(config.body.dataset, "pad_ufes_20");
  assert.equal(config.body.model, "frozen_feature_mlp");
  assert.equal(config.body.optimizer, "AdamW");
  assert.equal(config.body.batch_size, "64");
  assert.equal(config.body.epoch, "300");
  const results = await callCli(root, apiFile, ["results", runId]);
  assert.equal(results.code, 0);
  assert.equal(results.body.experiment_id, runId);
  assert.deepEqual(results.body.result_ids, ["worker-result-clean"]);
  assert.equal(results.body.metrics["worker-result-clean"].accuracy, 0.91);
  assert.ok(results.body.output_paths.includes("experiments/results/demo.csv"));
  assert.equal(results.body.reason, "");
  resultRecord.dimensions.seed = "7.0";
  assert.deepEqual((await callCli(root, apiFile, ["results", runId])).body.result_ids, ["worker-result-clean"]);
  resultRecord.dimensions.seed = 8;
  assert.deepEqual((await callCli(root, apiFile, ["results", runId])).body.result_ids, []);
  resultRecord.dimensions.seed = 7;
  resultRecord.workerId = "worker-b";
  assert.deepEqual((await callCli(root, apiFile, ["results", runId])).body.result_ids, []);
  resultRecord.workerId = "worker-a";
  resultRecord.planFile = "experiments/plans/other.yaml";
  assert.deepEqual((await callCli(root, apiFile, ["results", runId])).body.result_ids, []);
  resultRecord.planFile = plan;
  resultRecord.dimensions.case = "other";
  assert.deepEqual((await callCli(root, apiFile, ["results", runId])).body.result_ids, []);
  resultRecord.dimensions.case = "baseline";

  task.status = "manual_interrupted_completed";
  const stopped = await callCli(root, apiFile, ["inspect", runId]);
  assert.equal(stopped.body.summary.status, "cancelled");
  assert.deepEqual((await callCli(root, apiFile, ["results", runId])).body.result_ids, []);
  task.status = "failed";
  const failed = await callCli(root, apiFile, ["inspect", runId]);
  assert.equal(failed.body.summary.status, "failed");
  assert.deepEqual((await callCli(root, apiFile, ["results", runId])).body.result_ids, []);
  resultRecord.experimentId = runId;
  assert.deepEqual((await callCli(root, apiFile, ["results", runId])).body.result_ids, ["worker-result-clean"]);
  assert.equal((await callCli(root, apiFile, ["config", runId])).body.config_path, task.configPath);
});

test("historical launch config text survives a missing job config and terminal pane", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-worker-launch-config-"));
  fs.mkdirSync(path.join(root, "experiments", "plans"), { recursive: true });
  fs.writeFileSync(path.join(root, "experiments", "plans", "old.yaml"), "suite: changed\nseeds: [99]\n", "utf8");
  const workerRunId = "run6-historical";
  const configPath = "work_dirs/archive/6_case_seed43/job_config.yaml";
  const logPath = "simple_cluster/tmp/cluster_scheduler/logs/run6-historical.log";
  const yaml = "experiment_name: historical/case/seed_43\nseed: 43\ntrain:\n  epochs: 300\n";
  const task = {
    runKey: workerRunId, commandId: workerRunId, workerId: "worker-a", status: "completed",
    planFile: "experiments/plans/old.yaml", experimentIndex: 6, experimentCase: "case", seed: 43,
    outputDir: "work_dirs/archive/6_case_seed43", logPath,
    startedAt: "2026-09-23T00:00:00Z", finishedAt: "2026-09-23T01:00:00Z",
  };
  let log = `[runtime] python run_wrapper.py --context-json ${JSON.stringify({ config_path: configPath, output_dir: task.outputDir, config_text: yaml })} -- python test.py --config ${configPath}\n`;
  const results = ["clean", "p100_low"].map((protocol) => ({
    schemaVersion: 1, resultId: `historical-${protocol}`, experimentId: "historical/case/seed_43",
    runKey: `historical/case/seed_43:${protocol}`, status: "parsed", planFile: task.planFile,
    workerId: "worker-a", dimensions: { case: "case", seed: 43, eval_protocol: protocol },
    metrics: { accuracy: { value: 0.9 } }, primaryMetric: "accuracy",
    sourceFiles: [{ path: `work_dirs/archive/6_case_seed43/${protocol}.csv`, type: "csv", endpoint: "worker" }],
    createdAt: "2026-09-23T01:00:00Z", updatedAt: "2026-09-23T01:00:00Z",
  }));
  const workerServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/files/download-range" && url.searchParams.get("path") === logPath) {
      res.writeHead(206, { "content-type": "application/octet-stream" }); res.end(log);
    } else if (url.pathname === "/api/results/summary") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schemaVersion: 1, resultCount: 2, parsedResults: 2, parseFailed: 0, results }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => workerServer.listen(0, "127.0.0.1", resolve));
  t.after(() => workerServer.close());
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = method === "tasks.list"
        ? { schedulerStates: [], experimentTraces: [], workerTasks: [{ workerId: "worker-a", tasks: [task] }] }
        : method === "state.get"
          ? { value: { workerTunnels: [{ id: "worker-a", localForwardHost: "127.0.0.1", localForwardPort: workerServer.address().port }] } }
          : { results: [] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const apiFile = path.join(root, "api.json");
  fs.writeFileSync(apiFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "test" }), "utf8");
  const config = await callCli(root, apiFile, ["config", workerRunId]);
  assert.equal(config.code, 0);
  assert.equal(config.body.config_path, configPath);
  assert.equal(config.body.yaml, yaml);
  assert.deepEqual((await callCli(root, apiFile, ["results", workerRunId])).body.result_ids.sort(), ["historical-clean", "historical-p100_low"]);
  log += `[runtime] python run_wrapper.py --context-json ${JSON.stringify({ config_path: "work_dirs/other/job_config.yaml", config_text: "experiment_name: wrong\n" })}\n`;
  const { readWorkerTaskConfig } = require("../../dist/cli/runtime.js");
  const api = require("../../dist/cli/api.js");
  const previous = api.optionalApi;
  api.optionalApi = async () => ({ value: { workerTunnels: [{ id: "worker-a", localForwardHost: "127.0.0.1", localForwardPort: workerServer.address().port }] } });
  try {
    assert.equal((await readWorkerTaskConfig("worker-a", workerRunId, "", logPath)).yaml, "");
  } finally { api.optionalApi = previous; }
});

test("failed Worker task retrieves its remote log without persisting logPath", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-worker-remote-log-"));
  const workerRunId = "run0-failed";
  const logPath = "simple_cluster/tmp/cluster_scheduler/logs/run0-failed.log";
  const requests = [];
  const task = {
    runKey: workerRunId, commandId: workerRunId, workerId: "worker-a", status: "failed",
    planFile: plan, gpuId: "0", experimentCase: "baseline", seed: 7, logPath,
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    finishedAt: new Date(Date.now() - 59 * 60 * 1000).toISOString(),
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (method === "live.output") requests.push(params);
      const result = method === "tasks.list"
        ? { schedulerStates: [], experimentTraces: [], workerTasks: [{ workerId: "worker-a", tasks: [task] }] }
        : method === "live.output" && params.runKey === logPath && params.workerId === "worker-a"
          ? { runKey: logPath, logs: [{ key: logPath, text: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'omegaconf'\nImportError: transformers is required for HuggingFace text encoders." }] }
          : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const apiFile = path.join(root, "api.json");
  fs.writeFileSync(apiFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "test" }), "utf8");

  const inspected = await callCli(root, apiFile, ["inspect", workerRunId]);
  assert.equal(inspected.code, 0);
  assert.ok(inspected.body.diagnosis.reason.includes("missing dependency"));
  assert.ok(inspected.body.diagnosis.failure_context.last_error.length > 0);
  assert.ok(inspected.body.diagnosis.failure_context.last_error.length <= 300);
  assert.match(inspected.body.diagnosis.failure_context.last_error, /ImportError/);
  const diagnosed = await callCli(root, apiFile, ["diagnose", workerRunId, "--full"]);
  assert.equal(diagnosed.code, 0);
  assert.ok(diagnosed.body.reason.includes("missing dependency"));
  assert.ok(diagnosed.body.suggestions.some((item) => /conda environment|dependency/i.test(item)));
  assert.ok(diagnosed.body.evidence.length > 0);
  assert.ok(diagnosed.body.evidence.length <= 20);
  assert.ok(diagnosed.body.evidence.every((item) => item.length <= 200));
  assert.ok(requests.length >= 2);
  assert.ok(requests.every((params) => params.runKey === logPath && params.workerId === "worker-a"));
  const historyFile = path.join(root, "simple_cluster", "tmp", "worker_task_snapshots", "worker-a.json");
  const history = JSON.parse(fs.readFileSync(historyFile, "utf8"));
  assert.equal("raw" in history.rows[0], false);
  assert.equal("logPath" in history.rows[0], false);
});

test("scheduler-style artifact history survives without a live API", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-worker-history-"));
  const runsDir = path.join(root, "experiments", "runs");
  const runDir = path.join(runsDir, "run0-123456-123");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(runsDir, "empty-directory"));
  fs.writeFileSync(path.join(runDir, "artifact_manifest.json"), JSON.stringify({ exitCode: 0, generatedAt: "2026-09-23T01:00:00Z" }), "utf8");
  const apiFile = path.join(root, "missing-api.json");
  const listed = await callCli(root, apiFile, ["list"]);
  assert.equal(listed.code, 0);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].id, "run0-123456-123");
  assert.equal(listed.body[0].type, "worker_run");
  const inspected = await callCli(root, apiFile, ["inspect", "run0-123456-123"]);
  assert.equal(inspected.code, 0);
  assert.equal(inspected.body.summary.status, "success");
});

test("rate-limited snapshots keep the last run while classification stays stable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-worker-ratelimit-"));
  const sharedPlan = "experiments/plans/baseline.yaml";
  const firstWorkflow = "run-plan-111-aaaa";
  const secondWorkflow = "run-plan-222-bbbb";
  const otherRunId = "run0-123456-124";
  const phases = ["success", "limited", "recovered"];
  let phase = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const current = phases[Math.min(phase, phases.length - 1)];
      if (method === "tasks.list") phase += 1;
      const result = method === "tasks.list" ? taskPayload(current, sharedPlan, firstWorkflow, secondWorkflow, otherRunId)
        : method === "operations.list" ? operationPayload(sharedPlan, firstWorkflow, secondWorkflow)
        : method === "live.output" ? livePayload(params && params.runKey, otherRunId)
        : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const apiFile = path.join(root, "api.json");
  fs.writeFileSync(apiFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "test" }), "utf8");

  const first = await callCli(root, apiFile, ["list"]);
  assert.equal(first.body.find((row) => row.id === runId).type, "worker_run");
  assert.equal(first.body.find((row) => row.id === runId).parent_id ?? "", "");
  assert.equal(first.body.find((row) => row.id === otherRunId).parent_id, secondWorkflow);
  assert.equal(first.body.find((row) => row.id === firstWorkflow).type, "workflow");
  assert.equal(first.body.some((row) => row.id === "validate-plan-1" || row.id === "stop-scheduler-1"), false);
  const historyFile = path.join(root, "simple_cluster", "tmp", "worker_task_snapshots", "worker-a.json");
  const history = JSON.parse(fs.readFileSync(historyFile, "utf8"));
  assert.equal(history.rows.length, 2);
  assert.equal("raw" in history.rows[0], false);
  assert.equal("logPath" in history.rows[0], false);

  const limited = await callCli(root, apiFile, ["list"]);
  assert.equal(limited.body.find((row) => row.id === runId).type, "worker_run");
  assert.equal(limited.body.find((row) => row.id === runId).status, "running");
  const limitedInspect = await callCli(root, apiFile, ["inspect", runId]);
  assert.equal(limitedInspect.body.summary.type, "worker_run");
  assert.equal(limitedInspect.body.summary.status, "running");

  const aged = JSON.parse(fs.readFileSync(historyFile, "utf8"));
  aged.rows.find((row) => row.id === runId).updated = "2026-09-23T00:04:00Z";
  fs.writeFileSync(historyFile, JSON.stringify(aged), "utf8");
  const recovered = await callCli(root, apiFile, ["inspect", runId]);
  assert.equal(recovered.body.summary.type, "worker_run");
  assert.equal(recovered.body.summary.status, "unknown");
  assert.match(recovered.body.diagnosis.latest_message, new RegExp(runId));
  assert.doesNotMatch(recovered.body.diagnosis.latest_message, new RegExp(otherRunId));
  const other = await callCli(root, apiFile, ["inspect", otherRunId]);
  assert.match(other.body.diagnosis.latest_message, new RegExp(otherRunId));
  assert.doesNotMatch(other.body.diagnosis.latest_message, new RegExp(runId));
});

test("Scheduler operation provenance overrides stale experiment index", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-operation-provenance-"));
  const workflow = "run-plan-provenance";
  const indexFile = path.join(root, "simple_cluster", "experiment_index.json");
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify([
    { global_job_id: workflow, type: "workflow", status: "running", plan: "stale-plan.yaml", started_at: "2026-09-23T00:00:00Z" },
  ]), "utf8");
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = method === "tasks.list"
        ? { schedulerStates: [], experimentTraces: [], workerTasks: [] }
        : method === "operations.list"
          ? { records: [{
            operationId: workflow,
            type: "run-plan",
            status: "interrupted",
            planFile: "experiments/plans/real.yaml",
            workerId: "worker-a",
            startedAt: "2026-09-23T00:00:00Z",
            updatedAt: "2026-09-23T00:10:00Z",
          }] }
          : method === "state.get" ? { value: { workerTunnels: [] } } : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const apiFile = path.join(root, "api.json");
  fs.writeFileSync(apiFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "test" }), "utf8");

  const listed = await callCli(root, apiFile, ["list", "--full"]);
  assert.equal(listed.code, 0);
  const row = listed.body.find((item) => item.id === workflow);
  assert.equal(row.type, "workflow");
  assert.equal(row.status, "cancelled");
  assert.equal(row.status_source, "scheduler");
  assert.equal(row.plan, "experiments/plans/real.yaml");
  assert.equal(row.worker_id, "worker-a");

  const inspected = await callCli(root, apiFile, ["inspect", workflow]);
  assert.equal(inspected.body.summary.status, "cancelled");
  assert.equal(inspected.body.status.status, "cancelled");
  assert.equal(inspected.body.status.plan, "experiments/plans/real.yaml");
  assert.equal(inspected.body.snapshot.runtime_source, "history");

  const tree = await callCli(root, apiFile, ["tree"]);
  const node = tree.body.find((item) => item.id === workflow);
  assert.equal(node.status, "cancelled");
  assert.equal(node.status_source, "scheduler");
  assert.equal(node.children_count, 0);
});

test("historical Worker task gains and retains a unique workflow parent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-worker-parent-"));
  const workflow = "run-plan-1790156858344-oz9lwg";
  const workerRun = "run0-866039-975";
  const planFile = "experiments/plans/demo.yaml";
  const indexFile = path.join(root, "simple_cluster", "experiment_index.json");
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify([
    { global_job_id: workflow, type: "workflow", status: "failed", plan: planFile, started_at: "2026-09-23T00:00:00Z", finished_at: "2026-09-23T00:10:00Z" },
  ]), "utf8");
  let tasksVisible = true;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = method === "operations.list"
        ? { records: [{ operationId: workflow, type: "run-plan", status: "failed", startedAt: "2026-09-23T00:00:00Z", finishedAt: "2026-09-23T00:10:00Z" }] }
        : method === "tasks.list"
          ? { workerTasks: tasksVisible ? [{ workerId: "worker-a", generatedAt: "2026-09-23T00:07:00Z", tasks: [
            { runKey: workerRun, status: "failed", planFile, workerId: "worker-a", startedAt: "2026-09-23T00:05:00Z", finishedAt: "2026-09-23T00:07:00Z", logPath: "secret.log" },
          ] }] : [] }
          : method === "state.get" ? { value: { workerTunnels: [] } } : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const apiFile = path.join(root, "api.json");
  fs.writeFileSync(apiFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "test" }), "utf8");

  const listed = await callCli(root, apiFile, ["list", "--full"]);
  assert.equal(listed.code, 0);
  assert.equal(listed.body.find((row) => row.id === workerRun)?.parent_id, workflow);
  const historyFile = path.join(root, "simple_cluster", "tmp", "worker_task_snapshots", "worker-a.json");
  const cached = JSON.parse(fs.readFileSync(historyFile, "utf8"));
  assert.equal(cached.rows.find((row) => row.id === workerRun)?.parent_id, workflow);
  assert.equal("raw" in cached.rows[0], false);
  assert.equal("logPath" in cached.rows[0], false);

  tasksVisible = false;
  const tree = await callCli(root, apiFile, ["tree"]);
  const node = tree.body.find((row) => row.id === workflow);
  assert.equal(node?.children_count, 1);
  assert.equal(node?.children?.[0]?.id, workerRun);
  assert.equal(node?.status_source, "aggregate");
  const inspectedWorkflow = await callCli(root, apiFile, ["inspect", workflow]);
  assert.equal(inspectedWorkflow.body.snapshot.runtime_source, "history");
  const status = await callCli(root, apiFile, ["status", workflow, "--full"]);
  assert.equal(status.body.children?.[0]?.id, workerRun);
});

function taskPayload(phase, planFile, firstWorkflow, secondWorkflow, otherRunId) {
  if (phase === "limited") {
    return { workerTasks: [{ workerId: "worker-a", tasks: [], error: "Worker task snapshot rate_limited", generatedAt: "2026-09-23T00:05:00Z" }] };
  }
  return { workerTasks: [{ workerId: "worker-a", schemaVersion: 1, generatedAt: new Date().toISOString(), tasks: [
    { operationId: firstWorkflow, status: "running", planFile, workerId: "worker-a" },
    ...(phase === "recovered" ? [] : [{ runKey: runId, status: "running", planFile, workerId: "worker-a", startedAt: "2026-09-23T00:02:00Z", logPath: "secret.log", largeConfig: { secret: "never-cache" } }]),
    { runKey: otherRunId, workflowId: secondWorkflow, status: "running", planFile, workerId: "worker-a", startedAt: "2026-09-23T00:03:00Z" },
  ] }] };
}

function operationPayload(planFile, firstWorkflow, secondWorkflow) {
  return { records: [
    { operationId: firstWorkflow, type: "run-plan", status: "running", planFile, workerId: "worker-a", startedAt: "2026-09-23T00:00:00Z" },
    { operationId: secondWorkflow, type: "workflow-run", status: "running", planFile, workerId: "worker-a", startedAt: "2026-09-23T00:01:00Z" },
    { operationId: "validate-plan-1", type: "validate-plan", status: "completed", planFile },
    { operationId: "stop-scheduler-1", type: "stop-scheduler-operation", status: "completed", planFile },
  ] };
}

function livePayload(requested, otherRunId) {
  return { output: { runKey: requested }, text: `${requested} epoch 1`, logs: [
    { runKey: runId, text: `${runId} epoch 1` },
    { runKey: otherRunId, text: `${otherRunId} epoch 2` },
  ] };
}
