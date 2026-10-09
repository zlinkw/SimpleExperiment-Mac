const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const PlanBuilder = require("../../dist/features/PlanBuilder.js");
const PlanArchive = require("../../dist/features/PlanArchive.js");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const schedulerSource = readSource("src/clusterSchedulerRuntime.ts");
const agentSource = readSource("src/clusterAgentRuntime.ts");
const extensionSource = readSource("src/extension.ts");
const panelSource = readSource("src/ui/PanelHtml.ts");

function planText(mode, commands, result = "experiments/results/smoke.csv") {
  return [
    "suite: smoke",
    `mode: ${mode}`,
    "base_config: configs/base.yaml",
    "seeds: [0]",
    "paper:",
    `  result_csv: ${result}`,
    "runner:",
    ...commands.map((command) => `  ${command}`),
    "naming:",
    "  sweep_dir: work_dirs/{suite}",
    "  job_name: '{index}_{case}_seed{seed}'",
    "cases:",
    "  - case: baseline",
    "    overrides: {}",
    "",
  ].join("\n");
}

test("Plan contract requires only commands used by the selected mode", () => {
  const train = PlanBuilder.validateDeepLearningPlanContract(planText("train", [
    "train_command: python train.py --result-csv experiments/results/smoke.csv",
  ]));
  assert.equal(train.ok, true, JSON.stringify(train.issues));
  assert.equal(train.summary.mode, "train");
  assert.equal(train.summary.testCommand, "");

  const evaluate = PlanBuilder.validateDeepLearningPlanContract(planText("test", [
    "test_command: python eval.py --result-csv experiments/results/smoke.csv",
  ]));
  assert.equal(evaluate.ok, true, JSON.stringify(evaluate.issues));
  assert.equal(evaluate.summary.mode, "test");
  assert.equal(evaluate.summary.trainCommand, "");

  const combined = PlanBuilder.validateDeepLearningPlanContract(planText("train_test", [
    "train_command: python train.py",
  ]));
  assert.equal(combined.ok, false);
  assert.ok(combined.issues.some((issue) => issue.field === "test_command"));

  const invalid = PlanBuilder.validateDeepLearningPlanContract(planText("predict", [
    "train_command: python train.py",
    "test_command: python eval.py",
  ]));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.field === "mode"));
});

test("mode-specific output evidence ignores an unused command", () => {
  const yaml = [
    "suite: smoke",
    "mode: train",
    "base_config: configs/base.yaml",
    "seeds: [0]",
    "runner:",
    "  train_command: python train.py",
    "  test_command: python missing_eval.py --result-csv work_dirs/stale.csv",
    "cases:",
    "  - case: baseline",
  ].join("\n");
  const contract = PlanBuilder.validateDeepLearningPlanContract(yaml);
  assert.equal(contract.ok, false);
  assert.ok(contract.issues.some((issue) => issue.field === "result_output"), JSON.stringify(contract));
  assert.equal(contract.outputCandidates.includes("work_dirs/stale.csv"), false);
});

test("mode-specific local config references ignore an unused command", () => {
  const yaml = [
    "base_config: configs/base.yaml",
    "runner:",
    "  train_command: python train.py --config configs/train.yaml",
    "  test_command: python eval.py --config configs/test.yaml",
  ].join("\n");
  assert.deepEqual(PlanArchive.planRuntimeConfigReferences(yaml, "train"), ["configs/base.yaml", "configs/train.yaml"]);
  assert.deepEqual(PlanArchive.planRuntimeConfigReferences(yaml, "test"), ["configs/base.yaml", "configs/test.yaml"]);
  assert.deepEqual(PlanArchive.planStaticConfigReferences(yaml), ["configs/base.yaml", "configs/train.yaml", "configs/test.yaml"]);
});

function isolatedModeFixture(kind) {
  const proc = spawnSync("python", ["-B", "-X", "utf8", path.join(__dirname, "planRunModeWorkflow.fixture.py"), kind], { cwd: root, encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return JSON.parse(proc.stdout.trim());
}

test("Hub output gate and Worker retry derive the same Plan mode", () => {
  const payload = isolatedModeFixture("agent");
  assert.equal(payload.mode, "train");
  assert.equal(payload.gate.ok, false, JSON.stringify(payload.gate));
  assert.equal(payload.gate.expectedResults.includes("work_dirs/metrics_summary.csv"), false);
});

test("scheduler derives train-only and test-only execution from Plan", () => {
  const result = isolatedModeFixture("scheduler");
  for (const mode of ["train", "test", "train_test"]) {
    assert.equal(result[mode].validation.execution_mode, mode);
    assert.equal(result[mode].preview.executionMode, mode);
    assert.deepEqual(result[mode].preview.runnerWarnings, []);
    assert.deepEqual(result[mode].commands, mode === "train_test" ? ["train", "test"] : [mode]);
    assert.deepEqual(result[mode].verified, [true], "output verification must run after the selected stages");
  }
});
