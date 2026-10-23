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


test("agent commands expose status, tree, logs, control, results, and json", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-agent-"));
  const log = [
    "2026-01-02T00:00:00Z INFO training started",
    ...Array.from({ length: 60 }, (_value, index) => `2026-01-02T00:${String(index).padStart(2, "0")}:00Z INFO step ${index}`),
    "2026-01-02T01:00:00Z ERROR CUDA out of memory",
  ].join("\n");
  writeProject(dir, {
    "experiments/plans/bus_p100.yaml": "suite: bus\nseeds: [42, 43]\nbase_config: configs/base.yaml\ndataset: data/train\nmodel: resnet\noptimizer: adam\nbatch_size: 8\nepochs: 20\ncases:\n  - case: baseline\n",
    "configs/base.yaml": "model: resnet\n",
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", case: "workflow", status: "failed", plan: "experiments/plans/bus_p100.yaml", seed: 42, started_at: "2026-01-02T00:00:00Z", finished_at: "2026-01-02T01:00:00Z", stdout: "experiments/runs/run-plan-1/stdout.log" },
      { global_job_id: "run-100", type: "run", case: "worker", status: "failed", plan: "experiments/plans/bus_p100.yaml", seed: 43, parent_id: "run-plan-1", started_at: "2026-01-02T00:10:00Z", finished_at: "2026-01-02T00:40:00Z" },
    ], null, 2),
    "experiments/runs/run-plan-1/stdout.log": `${log}\n`,
    "experiments/runs/run-plan-1/artifact_manifest.json": JSON.stringify({ files: [{ path: "metrics.csv", size: 12 }] }, null, 2),
    "experiments/runs/run-plan-1/metrics.csv": "metric,value\nauc,0.8\n",
    "simple_cluster/results/result_registry.json": JSON.stringify({ records: [
      { schemaVersion: 1, resultId: "res-a", experimentId: "run-plan-1", runKey: "run-plan-1", suite: "bus", experimentName: "a", status: "parsed", sourceFiles: [], metrics: { auc: { value: 0.80 }, loss: { value: 0.40 } }, dimensions: { seed: 42 }, primaryMetric: "auc", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T01:00:00Z", provenance: {} },
      { schemaVersion: 1, resultId: "res-b", experimentId: "run-100", runKey: "run-100", suite: "bus", experimentName: "b", status: "parsed", sourceFiles: [], metrics: { auc: { value: 0.90 }, loss: { value: 0.20 }, f1: { value: 0.70 } }, dimensions: { seed: 43 }, primaryMetric: "auc", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T01:00:00Z", provenance: {} },
    ] }, null, 2),
  });

  const listed = JSON.parse((await runCli(["experiment", "list", "--json", "--full"], { cwd: dir })).stdout);
  assert.equal(listed[0].status, "failed");
  for (const key of ["id", "type", "parent_id", "created_at", "started_at", "finished_at", "duration", "status", "health_status", "health_reason"]) {
    assert.ok(key in listed[0], key);
  }

  const tree = JSON.parse((await runCli(["experiment", "tree", "--json"], { cwd: dir })).stdout);
  assert.equal(tree[0].type, "workflow");
  assert.equal(tree[0].children[0].type, "worker_run");
  assert.ok(["id", "type", "stage", "status"].every((key) => key in tree[0].children[0]));

  const status = JSON.parse((await runCli(["experiment", "status", "run-plan-1", "--json", "--full"], { cwd: dir })).stdout);
  assert.ok(status.children.length >= 1);

  const monitor = await runCli(["experiment", "monitor", "run-100", "--json", "--full"], { cwd: dir });
  assert.equal(monitor.code, 0);
  const monitorPayload = JSON.parse(monitor.stdout);
  assert.equal(monitorPayload.status, "failed");
  assert.ok("epoch" in monitorPayload && "batch" in monitorPayload && "loss" in monitorPayload && "gpu" in monitorPayload);
  const monitorDefault = JSON.parse((await runCli(["experiment", "monitor", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal("recentLogs" in monitorDefault, false);
  assert.equal("health_status" in monitorDefault, true);
  assert.equal("updated_at" in monitorDefault, true);
  assert.ok(monitorDefault.latest_message.length <= 300);
  const monitorFull = JSON.parse((await runCli(["experiment", "monitor", "run-plan-1", "--json", "--full"], { cwd: dir })).stdout);
  assert.ok(monitorFull.recentLogs.length <= 20);
  assert.ok(monitorFull.recentLogs.every((line) => line.length <= 200));

  const shown = JSON.parse((await runCli(["log", "show", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.ok(shown.some((row) => row.level === "INFO"));
  assert.ok(shown.some((row) => row.level === "ERROR"));
  assert.ok(shown.every((row) => "timestamp" in row && "level" in row && "message" in row));
  const tail = JSON.parse((await runCli(["log", "tail", "run-plan-1", "--lines", "100", "--json"], { cwd: dir })).stdout);
  assert.ok(tail.length <= 100);

  const diagnosis = JSON.parse((await runCli(["experiment", "diagnose", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal(diagnosis.status, "failed");
  assert.deepEqual(diagnosis.reason, ["cuda out of memory"]);
  assert.equal("evidence" in diagnosis, false);
  const diagnosisFull = JSON.parse((await runCli(["experiment", "diagnose", "run-plan-1", "--json", "--full"], { cwd: dir })).stdout);
  assert.ok(diagnosisFull.evidence.length <= 20);
  assert.ok(diagnosisFull.evidence.every((line) => line.length <= 200));
  assert.ok(diagnosisFull.evidence.some((line) => /out of memory/i.test(line)));
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  assert.equal("active_runs" in summary, false);
  assert.ok(Array.isArray(summary.recent_failures));
  assert.ok(summary.recent_failures.length <= 5);

  const stopped = await runCli(["experiment", "stop", "run-plan-1", "--json"], { cwd: dir });
  assert.notEqual(stopped.code, 0);
  assert.match(stopped.stdout, /stopExperiment|Local API/);
  const paused = JSON.parse((await runCli(["experiment", "pause", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal(paused.status, "unsupported");
  const resumed = JSON.parse((await runCli(["experiment", "resume", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal(resumed.submitPath, "features/Lifecycle.retryExperiment");
  const retried = JSON.parse((await runCli(["experiment", "retry", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal(retried.submitted, false);

  const config = JSON.parse((await runCli(["experiment", "config", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.match(config.config_path, /bus_p100\.yaml/);
  assert.match(config.yaml, /resnet/);
  assert.equal(String(config.seed), "42");
  assert.equal(config.dataset, "data/train");
  assert.equal(config.model, "resnet");
  assert.equal(config.optimizer, "adam");
  assert.equal(config.batch_size, "8");
  assert.equal(config.epoch, "20");

  const results = JSON.parse((await runCli(["experiment", "results", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal(results.experiment_id, "run-plan-1");
  assert.ok(results.result_ids.includes("res-a"));
  assert.equal(results.metrics["res-a"].auc, 0.8);
  assert.equal(results.metrics["res-b"], undefined);
  const metric = JSON.parse((await runCli(["metric", "show", "run-100", "--json"], { cwd: dir })).stdout);
  assert.equal(metric.auc, 0.9);
  assert.equal(metric.f1, 0.7);
  assert.equal("accuracy" in metric, false);

  const compared = JSON.parse((await runCli(["compare", "run-plan-1", "run-100", "--json"], { cwd: dir })).stdout);
  assert.equal(compared.metric_difference.auc.delta, 0.1);
  assert.ok(compared.improvement.includes("auc"));
  assert.ok(compared.improvement.includes("loss"));
  assert.equal(compared.metric_difference.f1, undefined);

  const batch = JSON.parse((await runCli(["experiment", "batch", "bus_p100.yaml", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(Object.keys(batch.seeds).sort(), ["42", "43"]);
  assert.ok(batch.status.failed.length >= 2);

  const dry = JSON.parse((await runCli(["experiment", "run", "experiments/plans/bus_p100.yaml", "--dry-run", "--json"], { cwd: dir })).stdout);
  assert.equal(dry.submitted, false);
  assert.match(dry.wouldExecute, /workflow\.run/);
  const checked = JSON.parse((await runCli(["experiment", "run", "experiments/plans/bus_p100.yaml", "--check", "--json"], { cwd: dir })).stdout);
  assert.equal(checked.submitted, false);
  assert.equal(checked.checks.config.status, "true");
  assert.equal(checked.checks.data.status, "unknown");
  assert.equal(checked.checks.gpu.status, "unknown");

  const resource = JSON.parse((await runCli(["resource", "available", "--json"], { cwd: dir })).stdout);
  assert.ok(Array.isArray(resource));
  const gpu = JSON.parse((await runCli(["gpu", "status", "--json"], { cwd: dir })).stdout);
  assert.ok(Array.isArray(gpu));

  const artifacts = JSON.parse((await runCli(["artifact", "list", "run-plan-1", "--json"], { cwd: dir })).stdout);
  const inspected = JSON.parse((await runCli(["artifact", "inspect", artifacts[0].id, "--json"], { cwd: dir })).stdout);
  assert.equal(inspected.size, fs.statSync(path.join(dir, "experiments", "runs", "run-plan-1", "metrics.csv")).size);
  assert.ok(inspected.mtime);
  assert.equal(inspected.hash.length, 64);
  const copy = path.join(dir, "copy.csv");
  const downloaded = await runCli(["artifact", "download", artifacts[0].id, "--out", copy, "--json"], { cwd: dir });
  assert.equal(downloaded.code, 0);
  assert.equal(fs.existsSync(copy), true);

  const compact = JSON.parse((await runCli(["experiment", "status", "run-plan-1", "--compact-json"], { cwd: dir })).stdout);
  assert.equal("recentLogs" in compact, false);
  const failure = await runCli(["experiment", "status", "--compact-json"], { cwd: dir });
  assert.notEqual(failure.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(failure.stdout).error).sort(), ["code", "detail", "message"]);

  const help = await runCli(["--help"]);
  for (const text of ["tree", "overview", "health", "monitor", "diagnose", "stop", "pause", "resume", "config", "results", "batch", "log", "metric", "compare", "resource available", "artifact inspect", "experiment diagnose", "experiment stop"]) {
    assert.match(help.stdout, new RegExp(text.replace(/[.]/g, "\\.")));
  }
});


test("agent compact output drops bulky fields and summary is stable", async () => {
  const { compactJsonValue } = require("../../dist/cli/format.js");
  const compact = compactJsonValue({
    id: "run-1",
    type: "worker_run",
    status: "running",
    created_at: "2026-01-01T00:00:00Z",
    children: [{ id: "child" }],
    raw: { debug: true },
    recentLogs: "large",
  });
  for (const key of ["created_at", "children", "raw", "recentLogs"]) assert.equal(key in compact, false);
  const metric = compactJsonValue({ id: "metric1", type: "auc", value: 0.8, raw: { debug: true } });
  assert.equal(metric.type, "auc");
  assert.equal(metric.value, 0.8);
  assert.equal("raw" in metric, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-summary-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", status: "failed", plan: "plan.yaml" },
      { global_job_id: "run-100", type: "run", status: "completed", parent_id: "run-plan-1" },
    ], null, 2),
  });
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  for (const key of ["running_count", "failed_count", "success_count", "workflows", "active_workers", "gpu_usage", "stalled_experiments"]) {
    assert.equal(key in summary, true, key);
  }
  assert.equal(summary.running_count, 0);
  assert.equal(summary.failed_count, 0);
  assert.equal(summary.success_count, 1);
  assert.equal(summary.workflows, 1);
  const listed = JSON.parse((await runCli(["experiment", "list", "--json"], { cwd: dir })).stdout);
  assert.equal("recentLogs" in listed[0], false);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overview.summary, summary);
  assert.equal("created_at" in listed[0], false);
  const full = JSON.parse((await runCli(["experiment", "list", "--json", "--full"], { cwd: dir })).stdout);
  assert.equal("created_at" in full[0], true);
});


test("experiment tree keeps orphan worker runs visible exactly once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-tree-orphans-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "workflow", status: "success" },
      { global_job_id: "run-child", type: "worker_run", parent_id: "run-plan-1", status: "success" },
      { global_job_id: "run-orphan", type: "worker_run", parent_id: "", status: "cancelled" },
      { global_job_id: "run-missing-parent", type: "worker_run", parent_id: "workflow-does-not-exist", status: "failed" },
    ]),
  });
  const tree = JSON.parse((await runCli(["experiment", "tree", "--json"], { cwd: dir })).stdout);
  const roots = new Map(tree.map((node) => [node.id, node]));
  assert.equal(roots.has("run-plan-1"), true);
  assert.equal(roots.has("run-child"), false);
  assert.deepEqual(roots.get("run-plan-1").children.map((node) => node.id), ["run-child"]);
  for (const id of ["run-orphan", "run-missing-parent"]) {
    assert.equal(roots.get(id).type, "worker_run");
    assert.deepEqual(roots.get(id).children, []);
  }
  const flattenIds = (nodes) => nodes.flatMap((node) => [node.id, ...flattenIds(node.children)]);
  const treeIds = flattenIds(tree);
  assert.equal(new Set(treeIds).size, treeIds.length);
  const listed = JSON.parse((await runCli(["experiment", "list", "--json", "--full"], { cwd: dir })).stdout);
  assert.deepEqual(new Set(treeIds), new Set(listed.map((row) => row.id)));
});


test("experiment tree roots preserve input order and include missing parents", () => {
  const { experimentTreeRoots } = require("../../dist/cli/commands/experiment.js");
  const workflow = { id: "run-plan-1", type: "workflow" };
  const child = { id: "run-child", type: "worker_run", parent_id: "run-plan-1" };
  const orphan = { id: "run-orphan", type: "worker_run", parent_id: "" };
  const missingParent = { id: "run-missing-parent", type: "worker_run", parent_id: "workflow-does-not-exist" };
  assert.deepEqual(experimentTreeRoots([orphan, child, workflow, missingParent]), [orphan, workflow, missingParent]);
});
