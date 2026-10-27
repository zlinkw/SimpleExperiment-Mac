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
