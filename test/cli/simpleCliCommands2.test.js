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


test("simpleex experiment run without API is env error", async () => {
  const result = await runCli(["experiment", "run", validPlan, "--json"]);
  assert.equal(result.code, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, false);
  assert.equal(payload.error.code, "ENV");
});


test("simpleex experiment retry reuses lifecycle without submitting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-retry-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "exp-bad", case: "ablation", status: "failed", started_at: "2026-01-02T00:00:00Z", finished_at: "2026-01-02T01:00:00Z", suite: "smoke" },
    ], null, 2),
  });
  const result = await runCli(["experiment", "retry", "exp-bad", "--from", "failed_stage", "--json"], { cwd: dir });
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.id, "exp-bad");
  assert.equal(payload.from, "failed_stage");
  assert.equal(payload.submitted, false);
  assert.ok(payload.lifecycle);
});


test("simpleex plan list and matrix reuse PlanBuilder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-plan-"));
  writeProject(dir, {
    "experiments/plans/baseline.yaml": fs.readFileSync(validPlan, "utf8"),
  });
  const listed = await runCli(["plan", "list", "--json"], { cwd: dir });
  assert.equal(listed.code, 0);
  const rows = JSON.parse(listed.stdout);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.ok("name" in row);
    assert.ok("path" in row);
    assert.ok("status" in row);
    assert.ok("validation" in row);
  }
  const matrix = await runCli(["plan", "matrix", "experiments/plans/baseline.yaml", "--json"], { cwd: dir });
  assert.equal(matrix.code, 0);
  const payload = JSON.parse(matrix.stdout);
  assert.ok(typeof payload.count === "number");
  assert.ok(payload.count >= 1);
});


test("simpleex result list show export reuse Results", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-result-"));
  writeProject(dir, {
    "simple_cluster/results/result_registry.json": JSON.stringify({
      records: [{
        schemaVersion: 1,
        resultId: "res-1",
        experimentId: "exp-ok",
        runKey: "exp-ok",
        suite: "smoke",
        experimentName: "baseline",
        status: "parsed",
        sourceFiles: [{ path: "experiments/results/smoke.csv", type: "csv", endpoint: "local" }],
        metrics: { accuracy: { value: 0.91 } },
        dimensions: { seed: 42, suite: "smoke" },
        primaryMetric: "accuracy",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T01:00:00Z",
        provenance: { configPath: "configs/base.yaml", artifactKey: "ckpt.pt" },
      }],
    }, null, 2),
  });
  const listed = await runCli(["result", "list", "--json"], { cwd: dir });
  assert.equal(listed.code, 0);
  const rows = JSON.parse(listed.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "res-1");
  const filtered = await runCli(["result", "list", "--experiment", "exp-ok", "--json"], { cwd: dir });
  assert.equal(JSON.parse(filtered.stdout).length, 1);
  const shown = await runCli(["result", "show", "res-1", "--json"], { cwd: dir });
  assert.equal(shown.code, 0);
  const detail = JSON.parse(shown.stdout);
  assert.ok("metrics" in detail);
  assert.ok("time" in detail);
  assert.ok("config" in detail);
  assert.ok("seed" in detail);
  assert.ok("checkpoint" in detail);
  assert.ok("outputFiles" in detail);
  const exported = await runCli(["result", "export", "res-1", "--format", "json", "--json"], { cwd: dir });
  assert.equal(exported.code, 0);
  const exportPayload = JSON.parse(exported.stdout);
  assert.equal(exportPayload.format, "json");
  assert.equal(exportPayload.id, "res-1");
});


test("loadResults includes parsed Worker summaries", async () => {
  const api = require("../../dist/cli/api.js");
  const { loadResults } = require("../../dist/cli/commands/result.js");
  const originalOptionalApi = api.optionalApi;
  const record = {
    schemaVersion: 1, resultId: "worker-result-1", experimentId: "suite/baseline/seed_7",
    runKey: "suite/baseline/seed_7:clean", status: "parsed",
    metrics: { accuracy: { value: 0.91, higherIsBetter: true } },
    dimensions: { case: "baseline", seed: 7, eval_protocol: "clean" },
    primaryMetric: "accuracy",
    sourceFiles: [{ path: "experiments/results/demo.csv", type: "csv", endpoint: "hub" }],
    createdAt: "2026-09-23T00:04:00Z", updatedAt: "2026-09-23T00:04:00Z",
    provenance: { planFile: "experiments/plans/baseline.yaml", workerId: "worker-a", resultOwnerWorkerId: "worker-a" },
    planFile: "experiments/plans/baseline.yaml", workerId: "worker-a", resultOwnerWorkerId: "worker-a",
  };
  const diagnostic = {
    ...record,
    resultId: "worker-stderr-row0",
    sourceFiles: [{ path: "work_dirs/demo/stderr.log", type: "text", endpoint: "hub" }],
  };
  const workerServer = http.createServer((req, res) => {
    if (req.url === "/api/results/summary") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schemaVersion: 1, resultCount: 2, parsedResults: 2, parseFailed: 0, results: [record, diagnostic] }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => workerServer.listen(0, "127.0.0.1", resolve));
  api.optionalApi = async (method) => method === "state.get"
    ? { value: { workerTunnels: [
      { id: "worker-a", localForwardHost: "127.0.0.1", localForwardPort: workerServer.address().port, enabled: true },
      { id: "offline-worker", localForwardHost: "127.0.0.1", localForwardPort: 1, enabled: true },
    ] } }
    : { results: [diagnostic] };
  try {
    const rows = await loadResults();
    const result = rows.find((row) => row.id === "worker-result-1");
    assert.equal(result?.experimentId, "suite/baseline/seed_7");
    assert.equal(result?.primaryMetric, "accuracy");
    assert.equal(result?.primaryValue, 0.91);
    assert.equal(rows.some((row) => row.id === "worker-stderr-row0"), false);
  } finally {
    api.optionalApi = originalOptionalApi;
    workerServer.closeAllConnections();
    await new Promise((resolve) => workerServer.close(resolve));
  }
});


test("simpleex gpu status and server list stay offline-safe", async () => {
  const gpu = await runCli(["gpu", "status", "--json"]);
  assert.equal(gpu.code, 0);
  const gpuRows = JSON.parse(gpu.stdout);
  assert.ok(Array.isArray(gpuRows));
  const server = await runCli(["server", "list", "--json"]);
  assert.equal(server.code, 0);
  const serverRows = JSON.parse(server.stdout);
  assert.ok(Array.isArray(serverRows));
  assert.ok(serverRows.length >= 1);
  assert.ok("id" in serverRows[0]);
  assert.ok("online" in serverRows[0]);
  assert.ok("ssh" in serverRows[0]);
  assert.ok("gpu" in serverRows[0]);
});
