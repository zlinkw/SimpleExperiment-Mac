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
