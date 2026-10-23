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
