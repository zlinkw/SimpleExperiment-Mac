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
