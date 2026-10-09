const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildCheckpointRetentionPlan,
  checkpointRecordsFromManifest,
} = require("../dist/features/Checkpoint.js");
const {
  inspectDatasetCsvFiles,
} = require("../dist/features/DatasetInspector.js");
const {
  parseSimpleRunArgs,
  runRecordedExperiment,
} = require("../dist/features/ExperimentRunner.js");
const {
  buildPlottingOutputContract,
  plottingContractMarkdown,
} = require("../dist/features/PlottingContract.js");
const {
  inferExperimentConfigFromRun,
  recoveredPlanOutputFiles,
  renderRecoveredPlanYaml,
} = require("../dist/features/ExperimentConfigRecovery.js");
const {
  detectResultAnomaly,
  renderAnomalyDiagnosisReport,
} = require("../dist/features/ResultAnomaly.js");

function resultRecord(id, auc, extra = {}) {
  return {
    schemaVersion: 1,
    resultId: id,
    experimentId: id,
    runKey: id,
    suite: "classification",
    experimentName: id,
    status: "parsed",
    sourceFiles: [{ path: `experiments/runs/${id}/metrics_summary.csv`, type: "csv", endpoint: "local" }],
    metrics: { AUC: { value: auc, higherIsBetter: true } },
    dimensions: { method: id, dataset: "VinDr", split: "test", seed: extra.seed || "1" },
    primaryMetric: "AUC",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    provenance: {},
    ...extra,
  };
}

test("checkpoint retention dry-run does not delete and protects best/latest/running", () => {
  const plan = buildCheckpointRetentionPlan({
    now: new Date("2026-01-10T00:00:00Z"),
    runningRunIds: ["running-run"],
    checkpoints: [
      { path: "work_dirs/a/best.ckpt", type: "best", score: 0.95, epoch: 10 },
      { path: "work_dirs/a/latest.ckpt", type: "latest", score: 0.9, epoch: 12 },
      { path: "work_dirs/a/old.ckpt", type: "regular", score: 0.7, epoch: 1, updatedAt: "2025-01-01T00:00:00Z" },
      { path: "work_dirs/a/running.ckpt", runId: "running-run", status: "running" },
      { path: "../escape.ckpt", type: "regular" },
    ],
    policy: { topK: 1, minAgeDays: 1 },
  });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.deleteCount, 1);
  assert.equal(plan.items.find((item) => item.path.endsWith("old.ckpt")).action, "delete");
  assert.equal(plan.items.find((item) => item.path.includes("escape")).action, "skip");
});

test("checkpoint policies reuse fixed path and boolean lookups", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "features", "Checkpoint.ts"), "utf8");
  assert.match(source, /const CHECKPOINT_FORBIDDEN_PATH_SEGMENTS = new Set\(/);
  assert.match(source, /const CHECKPOINT_ALLOWED_ROOTS = new Set\(/);
  assert.match(source, /const CHECKPOINT_TRUE_TOKENS = new Set\(/);
  assert.match(source, /CHECKPOINT_FORBIDDEN_PATH_SEGMENTS\??\.has\(part\)/);
  assert.match(source, /CHECKPOINT_ALLOWED_ROOTS\??\.has\(lowered\[0\]\)/);
  assert.match(source, /CHECKPOINT_TRUE_TOKENS\??\.has\(String\(value\)\.toLowerCase\(\)\)/);

  const records = checkpointRecordsFromManifest({
    checkpoints: [{ path: "outputs/demo/model.pth", paper_ready: "paper_ready" }],
  });
  assert.equal(records[0].paperReady, true);

  const plan = buildCheckpointRetentionPlan({
    checkpoints: [
      { path: "outputs/demo/model.pth" },
      { path: "outputs/.git/model.pth" },
      { path: "unknown/model.pth" },
    ],
    policy: {
      keepBest: false,
      keepLatest: false,
      topK: 0,
      protectPaperReady: false,
      protectRunning: false,
      protectFrozen: false,
    },
  });
  assert.equal(plan.items.find((item) => item.path === "outputs/demo/model.pth").action, "delete");
  assert.equal(plan.items.find((item) => item.path === "outputs/.git/model.pth").action, "skip");
  assert.equal(plan.items.find((item) => item.path === "unknown/model.pth").action, "skip");
});

test("dataset inspector profiles splits/classes and reports patient leakage", () => {
  const train = "case_id,patient_id,split,class,file\nc1,p1,train,pos,images/a.png\n";
  const testCsv = "case_id,patient_id,split,class,file\nc2,p1,test,neg,images/missing.png\n";
  const { profile, leakageCsv } = inspectDatasetCsvFiles([
    { path: "datasets/train.csv", text: train },
    { path: "datasets/test.csv", text: testCsv },
  ], { requiredColumns: ["case_id", "patient_id", "split", "class"], existingFiles: ["images/a.png"] }, new Date("2026-01-01T00:00:00Z"));
  assert.equal(profile.totalRows, 2);
  assert.equal(profile.classDistribution.pos, 1);
  assert.equal(profile.splitDistribution.test, 1);
  assert.equal(profile.fileExistence.missing.includes("images/missing.png"), true);
  assert.equal(profile.leakage.status, "failed");
  assert.match(leakageCsv, /patient_overlap/);
});

test("simpleex run creates standard run directory and metrics summary from stdout", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simpleex-run-"));
  const options = parseSimpleRunArgs(["--name", "baseline", "--seed", "1", "--config", "configs/a.yaml", "--", "node", "-e", "console.log('AUC: 0.932 accuracy: 89.5% F1=0.88')"]);
  const result = runRecordedExperiment({ ...options, cwd });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(path.join(result.runDir, "command.txt")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "stdout.log")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "env_snapshot.json")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "config_snapshot.yaml")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "artifact_manifest.json")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "metrics_summary.csv")), true);
  assert.equal(result.metricsRows, 3);
});

test("plotting contract exposes stable fields for PPT plugin", () => {
  const contract = buildPlottingOutputContract("2026-01-01T00:00:00Z");
  for (const field of ["method", "dataset", "split", "fold", "seed", "metric", "value", "mean", "std", "ci", "pValue", "adjustedPValue", "significant", "case_id", "patient_id", "subgroup", "error_type"]) {
    assert.equal(contract.requiredFields.includes(field), true);
  }
  assert.equal(contract.files.resultRegistry.path, "simple_cluster/results/result_registry.json");
  assert.match(plottingContractMarkdown(contract), /datasetProfile/);
});

test("experiment config recovery produces editable recovered plan and low-confidence warnings", () => {
  const recovered = inferExperimentConfigFromRun({
    "artifact_manifest.json": JSON.stringify({ result_csv: "work_dirs/run1/metrics_summary.csv" }),
    "env_snapshot.json": JSON.stringify({ command: "python train.py --config configs/a.yaml --seed 7 --output-dir work_dirs/run1", git_commit: "abc" }),
    "config_snapshot.yaml": "seed: 7\nmodel: resnet\n",
    "stdout.log": "test AUC: 0.91\n",
    "metrics_summary.csv": "experiment_id,metric,value\nr,AUC,0.91\n",
  }, { runId: "baseline_seed7", runDir: "experiments/runs/baseline_seed7" });
  const yaml = renderRecoveredPlanYaml(recovered);
  const files = recoveredPlanOutputFiles(recovered);
  assert.equal(recovered.plan.seed, "7");
  assert.match(yaml, /suite:/);
  assert.match(files.report, /字段置信度/);
  const low = inferExperimentConfigFromRun({ "stdout.log": "done\n" }, { runId: "missing_seed" });
  assert.equal(low.fields.seed.status, "needs_user_input");
});

test("result anomaly diagnosis ranks OOM and config diff against best run", () => {
  const current = resultRecord("current", 0.7, { dimensions: { method: "current", dataset: "VinDr", split: "test", seed: "1" } });
  const best = resultRecord("best", 0.9, { dimensions: { method: "best", dataset: "VinDr", split: "test", seed: "1" } });
  const diagnosis = detectResultAnomaly(current, [current, best], {
    currentConfig: { optimizer: { lr: 0.1 }, batch_size: 4 },
    bestConfig: { optimizer: { lr: 0.001 }, batch_size: 4 },
    logText: "RuntimeError: CUDA out of memory",
  });
  assert.equal(diagnosis.comparableResultId, "best");
  assert.equal(diagnosis.causes[0].severity, "critical");
  assert.equal(diagnosis.causes.some((cause) => cause.code === "oom"), true);
  assert.equal(diagnosis.configDiffs.some((diff) => diff.key === "optimizer.lr" && diff.severity === "warning"), true);
  assert.match(renderAnomalyDiagnosisReport(diagnosis), /结果异常诊断报告/);
});
