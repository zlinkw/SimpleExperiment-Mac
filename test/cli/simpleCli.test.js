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

test("simpleex --help lists domains", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /simpleex/);
  for (const domain of ["project", "experiment", "plan", "result", "gpu", "server", "artifact"]) {
    assert.match(result.stdout, new RegExp(domain));
  }
});

test("simpleex run retains the manual experiment recorder", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simpleex-recorded-run-"));
  const result = await runCli(["run", "--name", "manual", "--", process.execPath, "-e", "console.log('AUC: 0.9')"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  const recorded = JSON.parse(result.stdout);
  assert.ok(recorded.runDir.startsWith(path.join(cwd, "experiments", "runs")));
  assert.equal(recorded.metricsRows, 1);
  assert.equal(fs.existsSync(path.join(recorded.runDir, "artifact_manifest.json")), true);
});

test("simpleex project status is human readable and json", async () => {
  const human = await runCli(["project", "status"]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /Project:/);
  assert.match(human.stdout, /Services:/);
  assert.match(human.stdout, /Status:/);

  const json = await runCli(["project", "status", "--json"]);
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.stdout);
  assert.ok(payload.name);
  assert.ok(payload.root);
  assert.ok("version" in payload);
  assert.ok(payload.services.experiment);
  assert.ok(payload.services.cluster);
  assert.ok(payload.services.api);
});

test("project root uses Local API workspace from unrelated cwd and explicit env takes priority", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-root-"));
  const project = path.join(parent, "MultiModal");
  const override = path.join(parent, "ExplicitProject");
  writeProject(project, { "experiments/plans/plan.yaml": "name: test\n" });
  writeProject(override, { "experiments/plans/plan.yaml": "name: override\n" });
  const server = http.createServer((req, res) => {
    if (req.url === "/api/v1/capabilities") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schemaVersion: 1, rpc: "json-rpc-2.0", methods: ["status"] }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = method === "status" ? { workspace: project, version: "0.5.60" } : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const apiFile = path.join(parent, "api.json");
  fs.writeFileSync(apiFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "test" }), "utf8");
  const resolved = await runCli(["project", "status", "--json"], { cwd: parent, apiFile });
  assert.equal(resolved.code, 0);
  assert.equal(JSON.parse(resolved.stdout).root, project);
  assert.equal(JSON.parse(resolved.stdout).services.experiment, "ready");

  const explicit = await runCli(["project", "status", "--json"], {
    cwd: parent, apiFile, env: { SIMPLE_EXPERIMENT_PROJECT_ROOT: override },
  });
  assert.equal(explicit.code, 0);
  assert.equal(JSON.parse(explicit.stdout).root, override);
  const invalid = await runCli(["project", "status", "--json"], {
    cwd: parent, apiFile, env: { SIMPLE_EXPERIMENT_PROJECT_ROOT: path.join(parent, "missing") },
  });
  assert.equal(invalid.code, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, "ENV");
});

test("simpleex plan validate reuses PlanBuilder contract", async () => {
  const ok = await runCli(["plan", "validate", validPlan, "--json"]);
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ok.stdout).valid, true);

  const bad = await runCli(["plan", "validate", invalidPlan, "--json"]);
  assert.equal(bad.code, 3);
  const payload = JSON.parse(bad.stdout);
  assert.equal(payload.valid, false);
  assert.ok(Array.isArray(payload.errors));
  assert.ok(payload.errors.length > 0);
});

test("simpleex experiment list --json is parseable and filterable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-exp-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "exp-ok", case: "baseline", status: "completed", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T01:00:00Z" },
      { global_job_id: "exp-bad", case: "ablation", status: "failed", started_at: "2026-01-02T00:00:00Z", finished_at: "2026-01-02T01:00:00Z" },
    ], null, 2),
  });
  const listed = await runCli(["experiment", "list", "--json", "--full"], { cwd: dir });
  assert.equal(listed.code, 0);
  const rows = JSON.parse(listed.stdout);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok("id" in row);
    assert.ok("name" in row);
    assert.ok("status" in row);
    assert.ok("created" in row);
    assert.ok("updated" in row);
  }
  const failed = await runCli(["experiment", "list", "--status", "failed", "--json", "--full"], { cwd: dir });
  assert.equal(JSON.parse(failed.stdout).length, 1);
  const limited = await runCli(["experiment", "list", "--limit", "1", "--json"], { cwd: dir });
  assert.equal(JSON.parse(limited.stdout).length, 1);
  const status = await runCli(["experiment", "status", "exp-bad", "--json", "--full"], { cwd: dir });
  assert.equal(status.code, 0);
  const detail = JSON.parse(status.stdout);
  assert.equal(detail.status, "failed");
  assert.ok("stage" in detail);
  assert.ok("node" in detail);
  assert.ok("recentLogs" in detail);
  assert.ok("error" in detail);
  assert.ok("outputDir" in detail);
});

test("workflow terminal aliases normalize to canonical public statuses", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-terminal-status-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "wf-interrupted", type: "workflow", status: "interrupted" },
      { global_job_id: "wf-completed-errors", type: "workflow", status: "completed_with_errors" },
      { global_job_id: "run-normal", type: "worker_run", status: "normal_completed" },
      { global_job_id: "run-manual-stop", type: "worker_run", status: "manual_interrupted_completed" },
    ]),
  });
  const rows = JSON.parse((await runCli(["experiment", "list", "--json", "--full"], { cwd: dir })).stdout);
  const statuses = Object.fromEntries(rows.map((row) => [row.id, row.status]));
  assert.equal(statuses["wf-interrupted"], "cancelled");
  assert.equal(statuses["wf-completed-errors"], "failed");
  assert.equal(statuses["run-normal"], "success");
  assert.equal(statuses["run-manual-stop"], "cancelled");
  const cancelled = JSON.parse((await runCli(["experiment", "list", "--status", "cancelled", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(cancelled.map((row) => row.id).sort(), ["run-manual-stop", "wf-interrupted"]);
  const unknown = JSON.parse((await runCli(["experiment", "list", "--status", "unknown", "--json"], { cwd: dir })).stdout);
  assert.equal(unknown.some((row) => ["wf-interrupted", "run-manual-stop"].includes(row.id)), false);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "wf-interrupted", "--json"], { cwd: dir })).stdout);
  assert.equal(inspected.summary.status, "cancelled");
});

test("simpleex experiment run --dry-run does not submit", async () => {
  const result = await runCli(["experiment", "run", validPlan, "--seed", "42", "--dry-run", "--json"]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.submitted, false);
  assert.equal(payload.seed, "42");
  assert.equal(payload.submitPath, "workflow.run");
  assert.equal(payload.runner, "runRecordedExperiment");
});

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

test("GPU tasks require one matching running worker and GPU", () => {
  const { flattenGpus } = require("../../dist/cli/commands/gpu.js");
  const snapshot = { gpu: {
    nwpu2: { gpus: [{ index: 0 }, { index: 1 }] },
    nwpu3: { gpus: [{ index: 0 }] },
  } };
  const experiments = [
    { id: "workflow", type: "workflow", status: "running", worker_id: "nwpu2", gpu: { id: "0" } },
    { id: "nwpu2-gpu0", type: "worker_run", status: "running", worker_id: "nwpu2", gpu: { id: "0" } },
    { id: "nwpu2-gpu1", type: "worker_run", status: "running", worker_id: "nwpu2", gpu: { id: "1" } },
    { id: "nwpu3-gpu0", type: "worker_run", status: "running", worker_id: "nwpu3", gpu: { id: "0" } },
    { id: "finished", type: "worker_run", status: "success", worker_id: "nwpu2", gpu: { id: "0" } },
    { id: "missing-worker", type: "worker_run", status: "running", worker_id: "", gpu: { id: "0" } },
    { id: "missing-gpu", type: "worker_run", status: "running", worker_id: "nwpu2", gpu: null },
  ];
  const rows = flattenGpus(snapshot, experiments);
  assert.equal(rows.find((row) => row.server === "nwpu2" && row.gpu === "0").task, "nwpu2-gpu0");
  assert.equal(rows.find((row) => row.server === "nwpu2" && row.gpu === "1").task, "nwpu2-gpu1");
  assert.equal(rows.find((row) => row.server === "nwpu3" && row.gpu === "0").task, "nwpu3-gpu0");
});

test("simpleex artifact list from local run dir", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-art-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "exp-ok", case: "baseline", status: "completed", hub_job_dir: "experiments/runs/exp-ok", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T01:00:00Z" },
    ], null, 2),
    "experiments/runs/exp-ok/artifact_manifest.json": JSON.stringify({
      files: [{ path: "metrics.csv", size: 12 }],
    }, null, 2),
    "experiments/runs/exp-ok/metrics.csv": "metric,value\naccuracy,0.9\n",
  });
  const listed = await runCli(["artifact", "list", "exp-ok", "--json"], { cwd: dir });
  assert.equal(listed.code, 0);
  const rows = JSON.parse(listed.stdout);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1);
  assert.ok("id" in rows[0]);
  assert.ok("path" in rows[0]);
  const dest = path.join(dir, "experiments", "downloads", "metrics.csv");
  const downloaded = await runCli(["artifact", "download", rows[0].id, "--out", dest, "--json"], { cwd: dir });
  assert.equal(downloaded.code, 0);
  const payload = JSON.parse(downloaded.stdout);
  assert.equal(payload.source, "local");
  assert.equal(fs.existsSync(payload.path || dest), true);
});

test("simpleex json errors are strict JSON", async () => {
  const result = await runCli(["experiment", "status", "--json"]);
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, false);
  assert.ok(payload.error.code);
  assert.ok(payload.error.message);
  assert.ok("detail" in payload.error);
});


test("training progress parser returns null without a recognized line", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  assert.equal(parseTrainingProgress("no metrics here"), null);
  const progress = parseTrainingProgress("[A assigned seed=43] epoch 21/300 74% 126/171 0:00:42\n  当前 loss 0.3806\n  lr 1.00e-03   显存 5.2 GiB");
  assert.equal(progress.epoch, 21);
  assert.equal(progress.max_epoch, 300);
  assert.equal(progress.batch, 126);
  assert.equal(progress.total_batch, 171);
  assert.equal(progress.percent, 6.9);
  assert.equal(progress.loss, 0.3806);
  assert.equal(progress.lr, "1.00e-03");
  assert.equal(progress.memory, "5.2 GiB");
  assert.equal(parseTrainingProgress("epoch 21/300 74%\n当前 loss 0.3").percent, 6.9);
  const localOnly = parseTrainingProgress("74%\n当前 loss 0.3");
  assert.equal(localOnly.percent, null);
  assert.equal(localOnly.loss, 0.3);
});

test("current training loop percent uses completed epochs and bounded within-epoch progress", () => {
  const { currentTrainingLoopPercent, overallTrainingPercent } = require("../../dist/cli/runtime.js");
  assert.equal(currentTrainingLoopPercent(21, 300, 126, 171, 74), 6.9);
  assert.equal(currentTrainingLoopPercent(24, 300, 53, 171, null), 7.8);
  assert.equal(currentTrainingLoopPercent(1, 300, 0, 171, null), 0);
  assert.equal(currentTrainingLoopPercent(300, 300, 171, 171, null), 100);
  assert.equal(currentTrainingLoopPercent(300, 300, 200, 171, null), 100);
  assert.equal(currentTrainingLoopPercent(1, 300, -4, 171, null), 0);
  assert.equal(currentTrainingLoopPercent(21, 300, null, null, 74), 6.9);
  assert.equal(currentTrainingLoopPercent(21, 300, null, null, null), 6.7);
  assert.equal(currentTrainingLoopPercent(0, 300, 0, 171, null), 0);
  assert.equal(currentTrainingLoopPercent(301, 300, 171, 171, null), 100);
  assert.equal(currentTrainingLoopPercent(21, 0, 126, 171, 74), null);
  assert.equal(currentTrainingLoopPercent(null, 300, 126, 171, 74), null);
  assert.equal(currentTrainingLoopPercent(NaN, 300, 126, 171, 74), null);
  assert.equal(currentTrainingLoopPercent(21, Infinity, 126, 171, 74), null);
  assert.equal(overallTrainingPercent(21, 300, 126, 171, 74), currentTrainingLoopPercent(21, 300, 126, 171, 74));
});

test("training loop percent may reset within one worker run", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const first = parseTrainingProgress("[A assigned seed=42] epoch 102/300 50% 85/171 0:02:00\n当前 loss 0.2");
  const second = parseTrainingProgress("[A shuffled seed=42] epoch 17/300 13% 22/171 0:03:00\n当前 loss 0.2");
  assert.equal(first.percent, 33.8);
  assert.equal(second.percent, 5.4);
  assert.ok(second.percent < first.percent);
});

test("standard epoch validation logs expose the latest completed epoch", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const capture = [
    "2026-09-24 16:16:10 INFO - Epoch 8: Val Loss = 0.8649, accuracy = 0.72",
    "2026-09-24 16:17:44 INFO - Epoch 9: Val Loss = 1.0077, accuracy = 0.73",
  ].join("\n");
  const progress = parseTrainingProgress(capture, 300);
  assert.equal(progress.epoch, 9);
  assert.equal(progress.max_epoch, 300);
  assert.equal(progress.percent, 3);
  assert.equal(progress.loss, 1.0077);
  assert.equal(progress.batch, null);
  assert.equal(progress.total_batch, null);
  const withoutMax = parseTrainingProgress(capture);
  assert.equal(withoutMax.epoch, 9);
  assert.equal(withoutMax.max_epoch, null);
  assert.equal(withoutMax.percent, null);
  assert.equal(withoutMax.loss, 1.0077);
  assert.equal(parseTrainingProgress("Epoch 12: Val Loss = 1.25e-03", 300).loss, 0.00125);
  assert.equal(parseTrainingProgress("Epoch 13: accuracy = 0.7", 300).loss, null);
  assert.equal(parseTrainingProgress(`${capture}\nStarting p100_low inference...`, 300), null);
  assert.equal(parseTrainingProgress(`${capture}\n[simple-experiment-runtime] done index=0`, 300), null);
});

test("mixed progress formats use the latest epoch signal", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const rich = "epoch 30/300 50% 10/20 0:00:10\n当前 loss 0.2";
  const standard = "Epoch 31: Val Loss = 0.18";
  assert.equal(parseTrainingProgress(`${rich}\n${standard}`, 300).epoch, 31);
  const latestRich = parseTrainingProgress(`${standard}\n${rich.replace("30/300", "32/300")}`, 300);
  assert.equal(latestRich.epoch, 32);
  assert.equal(latestRich.loss, 0.2);
  assert.equal(parseTrainingProgress("epoch 2/300 20% 2/10 0:00:10\nepoch 3/300 50% 5/10 0:00:10", 300).epoch, 3);
});

test("TerminalProgress wide layout does not depend on numeric ETA", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const progress = parseTrainingProgress([
    "Epoch 26/300 [Train] ━━━━━━━━━━━━━━━━━━━━ 0% 0/171 -:--:--",
    "  当前 loss --   本轮均值 --   速度 0.0 batch/s",
    "  lr 1.00e-03   显存 0.0 GiB",
  ].join("\n"), 300);
  assert.equal(progress.epoch, 26);
  assert.equal(progress.max_epoch, 300);
  assert.equal(progress.batch, 0);
  assert.equal(progress.total_batch, 171);
  assert.equal(progress.percent, 8.3);
  assert.equal(progress.loss, null);
  assert.equal(progress.lr, "1.00e-03");
  assert.equal(progress.memory, "0.0 GiB");
  const advancing = parseTrainingProgress([
    "Epoch 26/300 [Train] ━━━━━━━━━━━━━━━━━━━━ 42% 72/171 0:00:23",
    "  当前 loss 1.2344   本轮均值 1.1000   速度 2.1 batch/s",
    "  lr 1.00e-03   显存 5.2 GiB",
  ].join("\n"), 300);
  assert.equal(advancing.batch, 72);
  assert.equal(advancing.percent, 8.5);
  assert.equal(advancing.loss, 1.2344);
});

test("newer compact Rich evidence replaces stale standard epoch without guessing epoch", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const standard = "Epoch 25: Val Loss = 1.3000";
  const compact = [
    "Train ━━━━━━━━ 42% 72/171 0:00:23",
    "  当前 loss 1.2344   本轮均值 1.1000   速度 2.1 batch/s",
    "  lr 1.00e-03   显存 5.2 GiB",
  ].join("\n");
  const progress = parseTrainingProgress(`${standard}\n${compact}`, 300);
  assert.equal(progress.epoch, null);
  assert.equal(progress.max_epoch, 300);
  assert.equal(progress.batch, 72);
  assert.equal(progress.total_batch, 171);
  assert.equal(progress.percent, null);
  assert.equal(progress.loss, 1.2344);
  assert.equal(progress.lr, "1.00e-03");
  assert.equal(progress.memory, "5.2 GiB");
  const laterStandard = parseTrainingProgress(`${compact}\n${standard}`, 300);
  assert.equal(laterStandard.epoch, 25);
  assert.equal(laterStandard.percent, 8.3);
  assert.equal(laterStandard.loss, 1.3);
});

test("compact validation is partial progress and test phase is not training", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const validation = parseTrainingProgress("Val low ━━━━━━━━ 60% 6/10 -:--:--", 300);
  assert.equal(validation.epoch, null);
  assert.equal(validation.max_epoch, 300);
  assert.equal(validation.batch, 6);
  assert.equal(validation.total_batch, 10);
  assert.equal(validation.percent, null);
  assert.equal(parseTrainingProgress("Epoch 25: Val Loss = 1.3\nTest ━━━━━━━━ 30% 3/10 0:00:20", 300), null);
  assert.equal(parseTrainingProgress("cache hit 42% 72/171", 300), null);
});

test("training epoch count accepts only positive integers from job config", () => {
  const { trainingMaxEpochFromYaml } = require("../../dist/cli/runtime.js");
  assert.equal(trainingMaxEpochFromYaml("train:\n  epochs: 300\n"), 300);
  assert.equal(trainingMaxEpochFromYaml("train:\n  max_epochs: 120\n"), 120);
  assert.equal(trainingMaxEpochFromYaml("train:\n  num_epochs: 50\n"), 50);
  for (const invalid of ["0", "-1", "auto", "300 epochs", "1.5"]) {
    assert.equal(trainingMaxEpochFromYaml(`train:\n  epochs: ${invalid}\n`), null);
  }
  assert.equal(trainingMaxEpochFromYaml("epochs: 70\n"), 70);
});

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

test("workflow and worker run status counts do not mix", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-summary-levels-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", status: "running", worker_id: "scheduler-owner", gpu: { id: "9" } },
      { global_job_id: "run-plan-2", type: "run-plan", status: "failed" },
      { global_job_id: "run-plan-3", type: "run-plan", status: "completed" },
      { global_job_id: "run-100", type: "run", status: "running", parent_id: "run-plan-1", worker_id: "worker-a", gpu: { id: "0" } },
      { global_job_id: "run-200", type: "run", status: "failed", parent_id: "run-plan-2" },
      { global_job_id: "run-300", type: "run", status: "completed", parent_id: "run-plan-3" },
    ]),
  });
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  assert.equal(summary.running_count, 1);
  assert.equal(summary.failed_count, 1);
  assert.equal(summary.success_count, 1);
  assert.equal(summary.workflows, 3);
  assert.deepEqual(summary.active_workers, ["worker-a"]);
  assert.deepEqual(summary.gpu_usage, [{ id: "run-100", worker: "worker-a", gpu: "0" }]);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overview.summary, summary);
  assert.equal(overview.active.active_count, 2);
});

test("workflow-only history does not count as a worker run failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-summary-workflow-only-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "workflow-failed", type: "run-plan", status: "failed" },
    ]),
  });
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  assert.equal(summary.workflows, 1);
  assert.equal(summary.failed_count, 0);
});

test("alerts sort failures and inspect omits evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-alerts-"));
  writeProject(dir, {
    "experiments/runs/run-old/stdout.log": "2026-01-01T00:00:00Z ERROR CUDA out of memory\n",
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", status: "running", plan: "plan.yaml", updated: new Date().toISOString() },
      { global_job_id: "run-old", type: "run", status: "failed", parent_id: "run-plan-1", updated: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), stdout: "experiments/runs/run-old/stdout.log" },
      { global_job_id: "run-200", type: "run", status: "failed", parent_id: "run-plan-1", updated: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
      { global_job_id: "run-300", type: "run", status: "running", stage: "run", parent_id: "run-plan-1", updated: new Date().toISOString() },
    ], null, 2),
  });
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overview.alerts.failed_recent.map((row) => row.id), ["run-200", "run-old"]);
  assert.deepEqual(overview.summary.recent_failures, overview.alerts.failed_recent);
  assert.equal(overview.alerts.failed_recent.some((row) => row.id === "run-plan-1"), false);
  assert.equal(overview.alerts.failed_recent.length <= 3, true);
  assert.equal(overview.alerts.missing_progress.some((row) => row.id === "run-plan-1"), false);
  assert.equal(overview.alerts.missing_progress.some((row) => row.id === "run-300"), false);
  const inspectedWorkflow = JSON.parse((await runCli(["experiment", "inspect", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal(inspectedWorkflow.summary.status, "failed");
  assert.equal(inspectedWorkflow.health.status, "error");
  assert.equal(inspectedWorkflow.health.reason, "failed_recent");
  assert.equal(inspectedWorkflow.alerts.recent_failure, true);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-old", "--json"], { cwd: dir })).stdout);
  assert.equal("evidence" in inspected.diagnosis, false);
  assert.equal("health_status" in inspected.diagnosis, false);
  assert.equal("stalled" in inspected.diagnosis, false);
  assert.equal("latest_message" in inspected.diagnosis, true);
  assert.ok(String(inspected.diagnosis.latest_message).length <= 300);
  const full = JSON.parse((await runCli(["experiment", "inspect", "run-old", "--json", "--full"], { cwd: dir })).stdout);
  assert.ok(full.diagnosis.evidence.length <= 20);
  assert.ok(full.diagnosis.evidence.some((line) => /out of memory/i.test(line)));
});

test("experiment active returns only running workflows and runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-active-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", status: "running", plan: "plan.yaml" },
      { global_job_id: "run-100", type: "run", status: "running", parent_id: "run-plan-1", worker_id: "worker-a" },
      { global_job_id: "run-200", type: "run", status: "failed", parent_id: "run-plan-1" },
    ], null, 2),
  });
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], { cwd: dir })).stdout);
  assert.equal(active.active_count >= 2, true);
  assert.ok(Array.isArray(active.workflows));
  assert.ok(Array.isArray(active.runs));
  assert.equal(active.runs.some((row) => row.id === "run-200"), false);
  assert.equal("raw" in active, false);
  assert.deepEqual(Object.keys(active).sort(), ["active_count", "runs", "schema_version", "snapshot", "workflows"]);
  assert.equal("children" in active.workflows[0], false);
  assert.equal("created_at" in active.workflows[0], false);
  assert.equal("worker" in active.workflows[0] ? active.workflows[0].worker.id.length > 0 : active.workflows[0].id === "run-plan-1", true);
  const full = JSON.parse((await runCli(["experiment", "active", "--json", "--full"], { cwd: dir })).stdout);
  assert.equal("created_at" in full.workflows[0], true);
  assert.equal("children" in full.workflows[0], true);
  assert.equal("health_status" in full.workflows[0], true);
  assert.equal("model" in full.workflows[0], true);
  assert.equal("dataset" in full.workflows[0], true);
  const both = JSON.parse((await runCli(["experiment", "active", "--json", "--full", "--compact-json"], { cwd: dir })).stdout);
  assert.equal("created_at" in both.workflows[0], true);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  for (const key of ["summary", "active", "alerts"]) assert.equal(key in overview, true, key);
  for (const key of ["failed_recent", "stalled", "missing_progress"]) assert.equal(key in overview.alerts, true, key);
  const status = JSON.parse((await runCli(["experiment", "status", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal("recentLogs" in status, false);
  assert.equal("children" in status, false);
  assert.equal(status.updated_at !== undefined, true);
  const statusFull = JSON.parse((await runCli(["experiment", "status", "run-plan-1", "--json", "--full"], { cwd: dir })).stdout);
  assert.equal("recentLogs" in statusFull, true);
});

test("overview failed_recent caps at 3 unless --full", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-overview-full-"));
  const failed = Array.from({ length: 12 }, (_value, index) => ({
    global_job_id: `fail-${String(index).padStart(2, "0")}`,
    type: "run",
    status: "failed",
    updated: new Date(Date.now() - index * 60 * 60 * 1000).toISOString(),
  }));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify(failed, null, 2),
  });
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.equal(overview.alerts.failed_recent.length, 3);
  assert.deepEqual(overview.alerts.failed_recent.map((row) => row.id), ["fail-00", "fail-01", "fail-02"]);
  const full = JSON.parse((await runCli(["experiment", "overview", "--json", "--full"], { cwd: dir })).stdout);
  assert.equal(full.alerts.failed_recent.length, 10);
  assert.equal(full.alerts.stalled.length, overview.alerts.stalled.length);
  assert.equal(full.alerts.missing_progress.length, overview.alerts.missing_progress.length);
});

test("experiment health reports healthy warning and error", async () => {
  const { buildHealthSummary, isRecentFailure } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-23T00:00:00Z");
  assert.equal(isRecentFailure({ status: "failed", updated: "2026-09-22T12:00:00Z" }, now), true);
  assert.equal(isRecentFailure({ status: "failed", updated: "2026-01-01T00:00:00Z" }, now), false);
  assert.deepEqual(buildHealthSummary([{ status: "success", health_status: "healthy", updated: "" }], now), { status: "healthy", reason: "" });
  assert.deepEqual(buildHealthSummary([{ status: "running", health_status: "stalled", updated: "2020-01-01T00:00:00Z" }], now), { status: "warning", reason: "stalled" });
  assert.deepEqual(buildHealthSummary([
    { status: "failed", health_status: "error", updated: "2026-09-23T00:00:00Z" },
    { status: "running", health_status: "stalled", updated: "2020-01-01T00:00:00Z" },
  ], now), { status: "error", reason: "failed_recent" });
  assert.deepEqual(buildHealthSummary([
    { status: "failed", health_status: "error", updated: "2026-01-01T00:00:00Z" },
  ], now), { status: "healthy", reason: "" });

  const healthyDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-health-ok-"));
  writeProject(healthyDir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-ok", type: "run", status: "completed", updated: new Date().toISOString() },
    ], null, 2),
  });
  const healthy = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: healthyDir })).stdout);
  assert.deepEqual(Object.keys(healthy).sort(), ["alerts", "health", "schema_version", "snapshot"]);
  assert.equal(healthy.health.status, "healthy");
  assert.equal(healthy.alerts.recent_failure, false);
  assert.equal(healthy.alerts.stalled, false);

  const stalledDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-health-stalled-"));
  writeProject(stalledDir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-stale", type: "run", status: "running", stage: "run", updated: "2020-01-01T00:00:00Z" },
    ], null, 2),
  });
  const warning = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: stalledDir })).stdout);
  assert.equal(warning.health.status, "warning");
  assert.equal(warning.health.reason, "stalled");
  assert.equal(warning.alerts.stalled, true);
  assert.equal(warning.alerts.alert_details.some((item) => item.type === "stalled"), true);

  const failedDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-health-failed-"));
  writeProject(failedDir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      ...Array.from({ length: 6 }, (_value, index) => ({
        global_job_id: `fail-${index}`,
        type: "run",
        status: "failed",
        updated: new Date(Date.now() - index * 60 * 1000).toISOString(),
      })),
      { global_job_id: "run-stale", type: "run", status: "running", updated: "2020-01-01T00:00:00Z" },
    ], null, 2),
  });
  const error = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: failedDir })).stdout);
  assert.equal(error.health.status, "error");
  assert.equal(error.health.reason, "failed_recent");
  assert.equal(error.alerts.recent_failure, true);
  assert.equal(error.alerts.stalled, true);
});

test("stalled uses Worker output activity before CLI observation time", () => {
  const { isStalled } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-24T12:00:00Z");
  assert.equal(isStalled({ status: "running", updated: "2026-09-24T10:00:00Z", raw: { runtimeActivityAt: "2026-09-24T11:45:00Z" } }, now), false);
  assert.equal(isStalled({ status: "running", updated: "2026-09-24T11:59:59Z", raw: { runtimeActivityAt: "2026-09-24T11:20:00Z" } }, now), true);
  assert.equal(isStalled({ status: "success", updated: "2020-01-01T00:00:00Z", raw: { runtimeActivityAt: "2020-01-01T00:00:00Z" } }, now), false);
  assert.equal(isStalled({ status: "running", updated: "2026-09-24T11:20:00Z", raw: {} }, now), true);
});

test("live runtime activity time drives stalled health instead of query time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-stalled-"));
  const now = Date.now();
  const updated = new Date(now - 1000).toISOString();
  const runtimeActivityAt = new Date(now - 40 * 60 * 1000).toISOString();
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-stalled", type: "worker_run", status: "running", stage: "train_test", started_at: new Date(now - 60 * 60 * 1000).toISOString(), updated, runtimeActivityAt, progress: { epoch: 4, max_epoch: 10, percent: 40 } },
    ]),
  });
  const healthRun = await runCli(["experiment", "health", "--json"], { cwd: dir });
  assert.equal(healthRun.code, 0, healthRun.stderr);
  const health = JSON.parse(healthRun.stdout);
  assert.equal(health.health.status, "warning");
  assert.equal(health.health.reason, "stalled");
  assert.equal(health.alerts.stalled, true);
  assert.equal(health.alerts.missing_progress, false);
  assert.match(health.alerts.alert_details.find((item) => item.type === "stalled").message, /output has not changed/);

  const overviewRun = await runCli(["experiment", "overview", "--json"], { cwd: dir });
  assert.equal(overviewRun.code, 0, overviewRun.stderr);
  const overview = JSON.parse(overviewRun.stdout);
  assert.deepEqual(overview.alerts.stalled.map((row) => row.id), ["run-stalled"]);

  const inspectRun = await runCli(["experiment", "inspect", "run-stalled", "--json"], { cwd: dir });
  assert.equal(inspectRun.code, 0, inspectRun.stderr);
  const inspect = JSON.parse(inspectRun.stdout);
  assert.deepEqual(inspect.health, { status: "warning", reason: "stalled" });
  assert.equal(inspect.alerts.stalled, true);
  assert.ok(inspect.diagnosis.stale_seconds >= 30 * 60);
  assert.equal(inspect.status.updated_at, updated);
});

test("aggregate workflow failures do not duplicate their worker failures", () => {
  const { classifyRecentFailures, buildHealthSummary } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-23T11:00:00Z");
  const workflow = { id: "wf-1", type: "workflow", status: "failed", status_source: "aggregate", plan: "p.yaml", updated: "2026-09-23T10:00:00Z" };
  const worker = { id: "worker-1", type: "worker_run", parent_id: "wf-1", status: "failed", plan: "p.yaml", updated: "2026-09-23T10:05:00Z" };
  assert.deepEqual(classifyRecentFailures([workflow, worker], now).unresolved, [worker]);
  assert.deepEqual(buildHealthSummary([workflow, worker], now), { status: "error", reason: "failed_recent" });
  assert.deepEqual(classifyRecentFailures([workflow], now).unresolved, [workflow]);
  assert.deepEqual(buildHealthSummary([workflow], now), { status: "error", reason: "failed_recent" });
});

test("independent scheduler workflow failures remain in recent failures", () => {
  const { classifyRecentFailures, buildHealthSummary } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-23T11:00:00Z");
  for (const status_source of ["scheduler", "unknown"]) {
    const workflow = { id: "wf-scheduler-failed", type: "workflow", status: "failed", status_source, plan: "p.yaml", updated: "2026-09-23T10:00:00Z" };
    assert.deepEqual(classifyRecentFailures([workflow], now).unresolved, [workflow]);
    assert.deepEqual(buildHealthSummary([workflow], now), { status: "error", reason: "failed_recent" });
  }
});

test("recent worker failures use only the latest matching attempt", () => {
  const { classifyRecentFailures, buildHealthSummary, recentFailureRecoveryState } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-23T11:00:00Z");
  const failure = { id: "old", type: "worker_run", plan: "plans\\p.yaml", experiment_case: "A", seed: "42", status: "failed", updated: "2026-09-23T10:00:00Z" };
  const retry = { id: "new", type: "worker_run", plan: "plans/p.yaml", experiment_case: "A", seed: "42", status: "running", created: "2026-09-23T10:05:00Z", updated: "2026-09-23T10:06:00Z" };
  const classify = (rows) => classifyRecentFailures(rows, now);
  assert.equal(recentFailureRecoveryState(failure, [failure, retry], now), "running_retry");
  assert.deepEqual(classify([failure, retry]).unresolved, []);
  assert.deepEqual(classify([failure, retry]).running_retry, [failure]);
  assert.deepEqual(buildHealthSummary([failure, retry], now), { status: "warning", reason: "failed_recent" });
  const success = { ...retry, status: "success" };
  assert.deepEqual(classify([failure, success]).resolved, [failure]);
  assert.deepEqual(buildHealthSummary([failure, success], now), { status: "healthy", reason: "" });
  const failedAgain = { ...retry, id: "newest", status: "failed", created: "2026-09-23T10:10:00Z", updated: "2026-09-23T10:11:00Z" };
  assert.equal(recentFailureRecoveryState(failure, [failure, success, failedAgain], now), "unresolved");
  assert.equal(classify([failure, success, failedAgain]).unresolved.length, 2);
  for (const changed of [{ seed: "43" }, { experiment_case: "B" }, { plan: "plans/other.yaml" }]) {
    assert.equal(recentFailureRecoveryState(failure, [failure, { ...retry, ...changed }], now), "unresolved");
  }
  for (const missing of [{ experiment_case: "" }, { seed: "" }]) {
    assert.equal(recentFailureRecoveryState({ ...failure, ...missing }, [{ ...failure, ...missing }, retry], now), "unresolved");
  }
});

test("experiment health distinguishes running and successful retries from failure history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-health-retry-"));
  const indexPath = path.join(dir, "simple_cluster", "experiment_index.json");
  const old = { global_job_id: "run0-old", type: "worker_run", plan: "p.yaml", experiment_case: "A", seed: "42", status: "failed", updated: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
  const newer = { global_job_id: "run0-new", type: "worker_run", plan: "p.yaml", experiment_case: "A", seed: "42", status: "running", created: new Date(Date.now() - 5 * 60 * 1000).toISOString(), updated: new Date().toISOString(), stage: "branch" };
  writeProject(dir, { "simple_cluster/experiment_index.json": JSON.stringify([old, newer]) });
  const healthRun = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(healthRun.health, { status: "warning", reason: "failed_recent", alert_level: "warning" });
  assert.equal(healthRun.alerts.recent_failure, true);
  assert.match(healthRun.alerts.alert_details.find((item) => item.type === "recent_failure").message, /1 experiment identity has newer running retries/);
  const overviewRun = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.equal(overviewRun.alerts.failed_recent[0].id, old.global_job_id);
  assert.deepEqual(overviewRun.health, { status: "warning", reason: "failed_recent" });
  const inspected = JSON.parse((await runCli(["experiment", "inspect", old.global_job_id, "--json"], { cwd: dir })).stdout);
  assert.deepEqual(inspected.health, { status: "error", reason: "failed_recent" });
  fs.writeFileSync(indexPath, JSON.stringify([old, { ...newer, status: "success" }]), "utf8");
  const healthSuccess = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(healthSuccess.health, { status: "healthy", reason: "", alert_level: "ok" });
  assert.equal(healthSuccess.alerts.recent_failure, false);
  const overviewSuccess = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overviewSuccess.alerts.failed_recent, []);
  assert.equal(overviewSuccess.summary.recent_failures[0].id, old.global_job_id);
  assert.deepEqual(overviewSuccess.health, { status: "healthy", reason: "" });
  const summarySuccess = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  assert.equal(summarySuccess.recent_failures[0].id, old.global_job_id);
  const inspectedSuccess = JSON.parse((await runCli(["experiment", "inspect", old.global_job_id, "--json"], { cwd: dir })).stdout);
  assert.deepEqual(inspectedSuccess.health, { status: "error", reason: "failed_recent" });
  assert.equal(inspectedSuccess.alerts.recent_failure, true);
});

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

const FAILURE_KEYS = ["id", "status", "health_status", "updated_at"];

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

test("overview active matches experiment active", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-active-shared-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", status: "running", plan: "plan.yaml" },
      { global_job_id: "run-100", type: "run", status: "running", parent_id: "run-plan-1", stage: "run" },
      { global_job_id: "run-200", type: "run", status: "failed", parent_id: "run-plan-1" },
    ], null, 2),
  });
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], { cwd: dir })).stdout);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overview.active, { active_count: active.active_count, workflows: active.workflows, runs: active.runs });
});

test("runtime fields stay aligned across inspect health and active", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-runtime-align-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "python train.py --config plan.yaml",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12 loss 0.31 auc 0.82",
      "tmux attach -t simple",
    ].join("\n"),
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        worker_id: "worker-a",
        updated,
        stdout: "experiments/runs/run-1789994720003/stdout.log",
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  const status = JSON.parse((await runCli(["experiment", "status", "run-1789994720003", "--json"], { cwd: dir })).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], { cwd: dir })).stdout);
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(inspected.progress, active.runs[0].progress);
  assert.deepEqual(status.progress, active.runs[0].progress);
  assert.deepEqual(active.runs[0].worker, { id: "worker-a" });
  assert.deepEqual(active.runs[0].gpu, { id: "0" });
  assert.equal(health.health.status, inspected.health.status);
  assert.match(inspected.diagnosis.latest_message, /loss 0\.31/);
  assert.doesNotMatch(inspected.diagnosis.latest_message, /^python /);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.equal(overview.alerts.missing_progress.some((row) => row.id === "run-1789994720003"), false);
});

test("missing progress past timeout is a warning", async () => {
  const { isMissingProgress, buildHealthSummary, findLatestTrainingMessage } = require("../../dist/cli/commands/experiment.js");
  const now = Date.parse("2026-09-23T00:20:00Z");
  const fresh = { type: "worker_run", status: "running", stage: "train_test", progress: null, started_at: "2026-09-23T00:15:00Z", created: "2026-09-23T00:15:00Z", updated: "2026-09-23T00:19:59Z" };
  const stale = { type: "worker_run", status: "running", stage: "train_test", progress: null, started_at: "2026-09-23T00:00:00Z", created: "2026-09-23T00:00:00Z", updated: "2026-09-23T00:19:59Z" };
  assert.equal(isMissingProgress(fresh, now), false);
  assert.equal(isMissingProgress(stale, now), true);
  assert.equal(isMissingProgress({ ...stale, stage: "train" }, now), true);
  assert.equal(isMissingProgress({ ...stale, stage: "run" }, now), true);
  assert.equal(isMissingProgress({ ...stale, stage: "train-test" }, now), true);
  assert.equal(isMissingProgress({ ...stale, stage: "test" }, now), false);
  assert.equal(isMissingProgress({ ...stale, stage: "debug" }, now), false);
  assert.equal(isMissingProgress({ ...stale, progress: { epoch: null, max_epoch: null, batch: 5, total_batch: 10, percent: null, loss: 0.4 } }, now), false);
  assert.equal(isMissingProgress({ ...stale, started_at: "invalid" }, now), true);
  assert.equal(isMissingProgress({ ...stale, started_at: "invalid", created: "invalid" }, now), false);
  assert.deepEqual(buildHealthSummary([stale], now), { status: "warning", reason: "missing_progress" });
  const message = findLatestTrainingMessage([
    { timestamp: "", level: "", message: "python train.py --epochs 10" },
    { timestamp: "", level: "INFO", message: "epoch 2/10 loss 0.4" },
    { timestamp: "", level: "", message: "tmux attach -t simple" },
  ]);
  assert.equal(message, "epoch 2/10 loss 0.4");
});

test("train_test missing progress uses task start time instead of refreshed runtime time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-missing-progress-"));
  const now = Date.now();
  const started = new Date(now - 20 * 60 * 1000).toISOString();
  const updated = new Date(now - 1000).toISOString();
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-train-stale", type: "worker_run", status: "running", stage: "train_test", started_at: started, updated },
      { global_job_id: "run-test-stale", type: "worker_run", status: "running", stage: "test", started_at: started, updated },
    ]),
  });
  const overviewRun = await runCli(["experiment", "overview", "--json"], { cwd: dir });
  assert.equal(overviewRun.code, 0, overviewRun.stderr);
  const overview = JSON.parse(overviewRun.stdout);
  assert.deepEqual(overview.alerts.missing_progress.map((row) => row.id), ["run-train-stale"]);
  assert.deepEqual(overview.health, { status: "warning", reason: "missing_progress" });

  const healthRun = await runCli(["experiment", "health", "--json"], { cwd: dir });
  assert.equal(healthRun.code, 0, healthRun.stderr);
  const health = JSON.parse(healthRun.stdout);
  assert.equal(health.health.status, "warning");
  assert.equal(health.health.reason, "missing_progress");
  assert.equal(health.alerts.missing_progress, true);

  const inspectRun = await runCli(["experiment", "inspect", "run-train-stale", "--json"], { cwd: dir });
  assert.equal(inspectRun.code, 0, inspectRun.stderr);
  const inspect = JSON.parse(inspectRun.stdout);
  assert.equal(inspect.alerts.missing_progress, true);
  assert.deepEqual(inspect.health, { status: "warning", reason: "missing_progress" });
});

test("status monitor and diagnose share runtime fields with inspect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-runtime-query-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": "2026-03-01T00:00:00Z INFO epoch 4/10 loss 0.31\n",
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        worker_id: "worker-a",
        updated,
        stdout: "experiments/runs/run-1789994720003/stdout.log",
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const id = "run-1789994720003";
  const status = JSON.parse((await runCli(["experiment", "status", id, "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", id, "--json"], args)).stdout);
  const monitor = JSON.parse((await runCli(["experiment", "monitor", id, "--json"], args)).stdout);
  const diagnosis = JSON.parse((await runCli(["experiment", "diagnose", id, "--json"], args)).stdout);
  assert.equal(status.status, inspected.summary.status);
  assert.equal(status.health_status, inspected.summary.health_status);
  assert.deepEqual(status.worker, inspected.status.worker);
  assert.deepEqual(status.gpu, inspected.status.gpu);
  assert.deepEqual(status.progress, inspected.progress);
  assert.equal(monitor.stage, inspected.status.stage);
  assert.deepEqual(monitor.progress, inspected.progress);
  assert.equal(monitor.updated_at, inspected.status.updated_at);
  assert.equal(diagnosis.health_status, inspected.summary.health_status);
});

test("query commands share one runtime snapshot schema", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-snapshot-schema-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "base_config: configs/base.yaml",
      "python -m train --config plan.yaml",
      "dataset: data/train encoder: resnet",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12 loss 0.31 auc 0.82",
    ].join("\n"),
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        plan: "plan.yaml",
        worker_id: "worker-a",
        updated,
        stdout: "experiments/runs/run-1789994720003/stdout.log",
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const id = "run-1789994720003";
  const status = JSON.parse((await runCli(["experiment", "status", id, "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", id, "--json"], args)).stdout);
  const monitor = JSON.parse((await runCli(["experiment", "monitor", id, "--json"], args)).stdout);
  const diagnosis = JSON.parse((await runCli(["experiment", "diagnose", id, "--json"], args)).stdout);
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);

  for (const key of ["status", "health_status", "stage"]) {
    assert.equal(status[key], monitor[key], key);
    assert.equal(status[key], diagnosis[key], key);
  }
  assert.equal(status.status, inspected.summary.status);
  assert.equal(status.stage, inspected.status.stage);
  assert.equal(status.updated_at, monitor.updated_at);

  const progressKeys = ["epoch", "max_epoch", "percent", "loss", "updated_at"];
  for (const payload of [status.progress, monitor.progress, inspected.progress, active.runs[0].progress]) {
    assert.deepEqual(Object.keys(payload).sort(), progressKeys.slice().sort());
  }
  assert.deepEqual(status.progress, monitor.progress);
  assert.deepEqual(status.progress, inspected.progress);

  for (const node of [status, diagnosis, active.runs[0]]) {
    assert.deepEqual(node.worker, { id: "worker-a" });
    assert.deepEqual(node.gpu, { id: "0" });
  }
  assert.match(monitor.latest_message, /loss 0\.31/);
  assert.doesNotMatch(monitor.latest_message, /yaml|config|python\s+-m/i);
  assert.ok(monitor.latest_message.length <= 300);
  assert.equal("last_update" in status, false);
  assert.equal("last_update" in monitor, false);
  assert.equal("last_update" in diagnosis, false);
  assert.equal(status.updated_at, diagnosis.updated_at);
  assert.deepEqual(status.progress, diagnosis.progress);
  assert.deepEqual(status.worker, diagnosis.worker);
  assert.deepEqual(status.gpu, diagnosis.gpu);
  for (const payload of [status, monitor, diagnosis, inspected.snapshot]) {
    assert.match(String(payload.snapshot_id), /^\d+$/);
    assert.match(String(payload.snapshot_time), /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.deepEqual(
    [status.progress.epoch, status.progress.loss, status.progress.updated_at],
    [diagnosis.progress.epoch, diagnosis.progress.loss, diagnosis.progress.updated_at],
  );
  assert.deepEqual(
    [status.progress.epoch, status.progress.loss, status.progress.updated_at],
    [inspected.progress.epoch, inspected.progress.loss, inspected.progress.updated_at],
  );
});

test("partial runtime progress survives and stays shared", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-partial-progress-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "base_config: configs/base.yaml",
      "python -m train --config plan.yaml",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12",
    ].join("\n"),
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        worker_id: "worker-a",
        updated,
        stdout: "experiments/runs/run-1789994720003/stdout.log",
        progress: { epoch: 4 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const id = "run-1789994720003";
  const status = JSON.parse((await runCli(["experiment", "status", id, "--json"], args)).stdout);
  const monitor = JSON.parse((await runCli(["experiment", "monitor", id, "--json"], args)).stdout);
  const diagnosis = JSON.parse((await runCli(["experiment", "diagnose", id, "--json"], args)).stdout);
  assert.notEqual(status.progress, null);
  assert.equal(status.progress.epoch, 4);
  assert.equal(status.progress.loss, null);
  assert.deepEqual(monitor.progress, status.progress);
  assert.deepEqual(diagnosis.progress, status.progress);
  assert.deepEqual(status.worker, monitor.worker);
  assert.deepEqual(status.gpu, diagnosis.gpu);
  assert.equal(status.stage, monitor.stage);
  assert.equal(status.health_status, diagnosis.health_status);
  assert.match(monitor.latest_message, /epoch 4\/10/);
  assert.doesNotMatch(monitor.latest_message, /yaml|config|python/i);
});

test("inspect is a self contained experiment view", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-inspect-view-"));
  const updated = "2026-03-01T00:00:00Z";
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "epoch 1/10 loss --",
      "epoch 2/10 loss null",
      "epoch 3/10 loss N/A",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12 loss 0.31",
    ].join("\n"),
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        plan: "plan.yaml",
        worker_id: "worker-a",
        updated,
        stdout: "experiments/runs/run-1789994720003/stdout.log",
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const id = "run-1789994720003";
  const status = JSON.parse((await runCli(["experiment", "status", id, "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", id, "--json"], args)).stdout);
  for (const key of ["snapshot_id", "snapshot_time", "runtime_version"]) assert.equal(key in inspected.snapshot, true, key);
  assert.equal(inspected.snapshot.runtime_version, status.updated_at);
  assert.equal(inspected.snapshot.runtime_version, inspected.progress.updated_at);
  for (const key of ["worker", "gpu", "stage", "health_status"]) {
    assert.deepEqual(inspected.status[key], status[key], key);
  }
  assert.deepEqual(Object.keys(inspected.health).sort(), ["reason", "status"]);
  assert.equal(inspected.alerts.missing_progress, false);
  assert.equal(inspected.alerts.recent_failure, false);
  assert.equal(typeof inspected.alerts.stalled, "boolean");
  assert.match(inspected.diagnosis.latest_message, /loss 0\.31/);
  assert.doesNotMatch(inspected.diagnosis.latest_message, /loss --|loss null|N\/A/i);
  assert.equal(typeof inspected.diagnosis.stale_seconds, "number");
});

test("inspect schema keeps one responsibility per field", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-inspect-schema-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        worker_id: "worker-a",
        updated: new Date().toISOString(),
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
        gpu: { id: "0" },
      },
      { global_job_id: "run-old-fail", type: "run", status: "failed", updated: "2020-01-01T00:00:00Z" },
      { global_job_id: "run-new-fail", type: "run", status: "failed", updated: new Date().toISOString() },
    ], null, 2),
  });
  const args = { cwd: dir };
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  for (const key of ["snapshot", "summary", "status", "progress", "health", "diagnosis", "alerts"]) {
    assert.equal(key in inspected, true, key);
  }
  for (const key of ["snapshot_id", "snapshot_time", "runtime_version"]) {
    assert.equal(key in inspected.snapshot, true, key);
    assert.equal(key in inspected.status, false, key);
  }
  assert.equal("progress" in inspected.diagnosis, false);
  assert.equal("runtime" in inspected.diagnosis, false);
  assert.equal("health_status" in inspected.diagnosis, false);
  assert.equal("stalled" in inspected.diagnosis, false);
  assert.deepEqual(Object.keys(inspected.health).sort(), ["reason", "status"]);
  const text = JSON.stringify(inspected);
  assert.equal(text.split('{"progress":').length - 1 + text.split('"progress":').length - 1, 1);

  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  assert.equal(health.alerts.recent_failure, true);
  assert.equal("failed_recent" in health.alerts, false);
});

test("inspect schema version 1 is frozen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-inspect-frozen-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        case: "baseline",
        seed: "42",
        updated: new Date().toISOString(),
        progress: { epoch: 4, loss: 0.31 },
      },
    ], null, 2),
  });
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], { cwd: dir })).stdout);
  assert.equal(inspected.schema_version, "1");
  assert.deepEqual(Object.keys(inspected).sort(), ["alerts", "diagnosis", "health", "progress", "schema_version", "snapshot", "status", "summary"]);
  assert.equal(inspected.summary.experiment_case, "baseline");
  assert.equal(inspected.summary.seed, "42");
  assert.equal("runtime" in inspected.diagnosis, false);
  assert.equal(JSON.stringify(inspected).split('"stale_seconds"').length - 1, 1);
  assert.ok(Array.isArray(inspected.alerts.alert_details));
  const stalled = inspected.alerts.stalled
    ? [{ type: "stalled", message: "experiment has no progress update" }]
    : [];
  assert.deepEqual(inspected.alerts.alert_details, stalled);
});

test("health field is shared by health overview and inspect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-health-field-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        case: "baseline",
        seed: "7",
        worker_id: "worker-a",
        updated: new Date().toISOString(),
        progress: { epoch: 4, loss: 0.31 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  assert.equal(inspected.schema_version, "1");
  for (const payload of [health, overview]) {
    assert.equal("health" in payload, true);
    assert.equal("overall" in payload, false);
    assert.deepEqual(Object.keys(payload.health).sort(), payload === health ? ["alert_level", "reason", "status"] : ["reason", "status"]);
  }
  assert.deepEqual(health.health, { ...overview.health, alert_level: "ok" });
  assert.deepEqual(health.health, { ...inspected.health, alert_level: "ok" });
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  const running = active.runs[0];
  for (const key of ["id", "experiment_case", "seed", "worker", "gpu", "stage", "progress"]) {
    assert.equal(key in running, true, key);
  }
  assert.equal(running.experiment_case, "baseline");
  assert.equal(running.seed, "7");
});

test("overview active health and inspect keep separate responsibilities", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-responsibilities-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        updated: new Date().toISOString(),
        progress: { epoch: 4, loss: 0.31 },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], args)).stdout);
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  assert.equal("active_runs" in overview.summary, false);
  assert.equal("running" in health, false);
  assert.ok(Array.isArray(active.runs));
  assert.deepEqual(Object.keys(overview.active).sort(), ["active_count", "runs", "workflows"]);
  assert.deepEqual(overview.active, { active_count: active.active_count, workflows: active.workflows, runs: active.runs });
  for (const key of ["missing_progress", "stalled", "recent_failure", "alert_details"]) {
    assert.equal(key in health.alerts, true, key);
    assert.equal(key in inspected.alerts, true, key);
  }
  assert.equal("failed_recent" in health.alerts, false);
  assert.equal("failed_recent" in overview.alerts, true);
});

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

test("retries on one GPU keep older worker history separate", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  const older = { ...history, id: "run0-older", run_id: "run0-older", created: "2026-09-23T09:50:00Z", raw: {} };
  const byId = new Map([[older.id, older], [history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(byId.size, 2);
  assert.equal(older.source, "history");
  assert.equal(older.run_id, older.id);
  assert.equal(history.source, "runtime_observation");
  assert.equal(history.run_id, observation.run_id);
});

test("ambiguous physical matches do not consume an observation", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  const second = { ...history, id: "run0-second", run_id: "run0-second", created: "2026-09-23T09:55:45Z", raw: {} };
  const byId = new Map([[history.id, history], [second.id, second]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(history.source, "history");
  assert.equal(second.source, "history");
  assert.equal(byId.has(observation.run_id), true);
});

test("one history row does not choose the first of multiple runtime candidates", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  const second = { ...observation, run_id: "run-1790157345723" };
  const byId = new Map([[history.id, history]]);
  await applyRuntimeObservations(byId, [observation, second]);
  assert.equal(history.source, "history");
  assert.equal(byId.has(observation.run_id), true);
  assert.equal(byId.has(second.run_id), true);
});

test("exact run ID matching takes priority and preserves an existing workflow parent", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  history.run_id = observation.run_id;
  history.parent_id = "wf-existing";
  const byId = new Map([[history.id, history], ["wf-existing", { id: "wf-existing", type: "workflow", status: "running", plan: history.plan }]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(byId.size, 2);
  assert.equal(history.id, "run0-326826-291");
  assert.equal(history.run_id, observation.run_id);
  assert.equal(history.parent_id, "wf-existing");
});

test("historical workflow parents are inferred only from a unique exact time window", () => {
  const { backfillWorkflowParents } = require("../../dist/cli/commands/experiment.js");
  const plan = "experiments/plans/demo.yaml";
  const workflow = (id, start, end, overrides = {}) => ({ id, type: "workflow", status: "failed", plan, worker_id: "worker-a", created: start, finished_at: end, ...overrides });
  const run = (id, start, overrides = {}) => ({ id, type: "worker_run", plan, worker_id: "worker-a", started_at: start, parent_id: "", ...overrides });
  const first = workflow("workflow-a", "2026-09-23T00:00:00Z", "2026-09-23T00:10:00Z");
  const later = workflow("workflow-b", "2026-09-23T00:20:00Z", "2026-09-23T00:30:00Z");
  const matched = run("run-1", "2026-09-23T00:05:00Z", { plan: ".\\experiments\\plans\\demo.yaml" });
  backfillWorkflowParents([first, later, matched]);
  assert.equal(matched.parent_id, first.id);

  const overlap = workflow("workflow-overlap", "2026-09-23T00:04:00Z", "2026-09-23T00:08:00Z");
  const ambiguous = run("run-2", "2026-09-23T00:05:00Z");
  backfillWorkflowParents([first, overlap, ambiguous]);
  assert.equal(ambiguous.parent_id, "");

  const explicit = run("run-3", "2026-09-23T00:05:00Z", { parent_id: "explicit-parent" });
  backfillWorkflowParents([first, explicit]);
  assert.equal(explicit.parent_id, "explicit-parent");

  const otherPlan = run("run-4", "2026-09-23T00:05:00Z", { plan: "other/demo.yaml" });
  const otherWorker = run("run-5", "2026-09-23T00:05:00Z", { worker_id: "worker-b" });
  const missingStart = run("run-6", "");
  const unknownOpen = workflow("workflow-unknown", "2026-09-23T00:00:00Z", "", { status: "unknown" });
  const unknownRun = run("run-7", "2026-09-23T00:05:00Z");
  backfillWorkflowParents([first, otherPlan, otherWorker, missingStart]);
  backfillWorkflowParents([unknownOpen, unknownRun]);
  assert.equal(otherPlan.parent_id, "");
  assert.equal(otherWorker.parent_id, "");
  assert.equal(missingStart.parent_id, "");
  assert.equal(unknownRun.parent_id, "");
});

test("finished worker runs stay inspectable after runtime observation is gone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-history-"));
  writeProject(dir, {
    "experiments/runs/run-1789994720003/artifact_manifest.json": JSON.stringify({ exitCode: 0, generatedAt: "2026-03-01T00:00:00Z" }),
    "experiments/runs/run-1789994720003/env_snapshot.json": JSON.stringify({ finishedAt: "2026-03-01T00:00:00Z" }),
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "wf-1", status: "success", updated: "2026-03-02T00:00:00Z" },
    ], null, 2),
  });
  const args = { cwd: dir };
  const list = JSON.parse((await runCli(["experiment", "list", "--json"], args)).stdout);
  const types = new Set(list.map((row) => row.type));
  assert.equal(types.has("workflow"), true);
  assert.equal(types.has("worker_run"), true);
  for (const row of list) {
    const inspected = await runCli(["experiment", "inspect", row.id, "--json"], args);
    assert.equal(inspected.code, 0, row.id);
    assert.equal(JSON.parse(inspected.stdout).summary.id, row.id);
  }
  const finished = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  assert.equal(finished.summary.type, "worker_run");
  assert.equal(finished.summary.status, "success");
  assert.equal(finished.snapshot.runtime_source, "history");
  assert.equal(finished.snapshot.runtime_version, "2026-03-01T00:00:00.000Z");
  const workflow = JSON.parse((await runCli(["experiment", "inspect", "wf-1", "--json"], args)).stdout);
  assert.equal(workflow.snapshot.runtime_source, "experiment_index");
});

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
