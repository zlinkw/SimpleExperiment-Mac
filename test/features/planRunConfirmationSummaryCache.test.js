const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadSummaries(cacheLimit = 3) {
  const sandbox = {
    PLAN_RUN_OUTPUT_LOCATION_VARIANT_CACHE_LIMIT: cacheLimit,
    PLAN_TRAIN_MODE_TOKENS: new Set(["train", "training", "train_only"]),
    PLAN_TEST_MODE_TOKENS: new Set(["test", "eval", "evaluate", "evaluation", "test_only", "eval_only"]),
    planRunOutputLocationSummaryCache: new WeakMap(),
    planRunTargetLocationsCache: new WeakMap(),
    uniqueCalls: 0,
    pathCalls: 0,
    uniqueStrings(values) {
      sandbox.uniqueCalls += 1;
      const seen = new Set();
      return values.filter((value) => {
        const key = String(value || "").toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    normalizeRemoteWorkRoot(value) {
      sandbox.pathCalls += 1;
      return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    },
    PlanBuilder_1: {
      normalizePlanMode(value) {
        const mode = String(value || "train_test").trim().toLowerCase().replace(/[\s-]+/g, "_");
        return ["train", "test"].includes(mode) ? mode : "train_test";
      },
    },
    guidedPlanSummaryValue(value, limit) { return String(value || "").slice(0, limit); },
    executionEnvironmentLabel(value) { return String(value || "").trim() || "默认环境"; },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("guidedPlanModeLabel"),
    extractFunction("planRunOutputLocationSummary"),
    extractFunction("planRunCommandSummary"),
    extractFunction("planRunTargetLocations"),
    extractFunction("planRunWorkerCapacitySummary"),
    extractFunction("planRunKnownJobCount"),
    extractFunction("planRunScaleSummary"),
    extractFunction("planRunConfiguredCapacitySummary"),
    extractFunction("planRunExpectedRemoteLocations"),
    extractFunction("planRunConfirmationDetail"),
    extractFunction("planBatchRunConfirmationDetail"),
    "this.outputSummary = planRunOutputLocationSummary;",
    "this.commandSummary = planRunCommandSummary;",
    "this.targetLocations = planRunTargetLocations;",
    "this.confirmOne = planRunConfirmationDetail;",
    "this.confirmBatch = planBatchRunConfirmationDetail;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("Plan command summaries reuse fixed mode aliases", () => {
  const sandbox = loadSummaries();
  const plan = { trainCommand: "python train.py", testCommand: "python test.py" };
  assert.deepEqual(Array.from(sandbox.commandSummary({ ...plan, mode: "training" })), ["训练：python train.py"]);
  assert.deepEqual(Array.from(sandbox.commandSummary({ ...plan, mode: "eval_only" })), ["评估：python test.py"]);
  assert.deepEqual(Array.from(sandbox.commandSummary({ ...plan, mode: "train_test" })), ["训练：python train.py", "评估：python test.py"]);
  const source = extractFunction("planRunCommandSummary");
  assert.match(source, /PLAN_TRAIN_MODE_TOKENS\??\.has\(mode\)/);
  assert.match(source, /PLAN_TEST_MODE_TOKENS\??\.has\(mode\)/);
  assert.doesNotMatch(source, /\["train", "training", "train_only"\]\.includes/);
});

test("Plan output location summaries reuse normalized limits and evict old variants", () => {
  const sandbox = loadSummaries(3);
  const plan = {
    outputCandidates: ["metrics.csv", "METRICS.CSV", "summary.json", "stdout.log"],
    confirmationOutputCandidates: ["fallback.csv"],
  };
  const first = sandbox.outputSummary(plan, 2);
  const calls = sandbox.uniqueCalls;

  assert.deepEqual(JSON.parse(JSON.stringify(first)), {
    source: "Plan",
    values: ["metrics.csv", "summary.json", "stdout.log"],
    text: "metrics.csv、summary.json 等 3 项",
  });
  assert.strictEqual(sandbox.outputSummary(plan, 2.9), first);
  assert.equal(sandbox.uniqueCalls, calls);

  sandbox.outputSummary(plan, 1);
  const three = sandbox.outputSummary(plan, 3);
  sandbox.outputSummary(plan, 4);
  assert.equal(sandbox.planRunOutputLocationSummaryCache.get(plan).size, 3);
  assert.notStrictEqual(sandbox.outputSummary(plan, 2), first);
  assert.strictEqual(sandbox.outputSummary(plan, 3), three);

  const replacement = { ...plan, outputCandidates: [...plan.outputCandidates] };
  assert.notStrictEqual(sandbox.outputSummary(replacement, 2), first);
  assert.equal(sandbox.outputSummary({ confirmationOutputCandidates: ["fallback.csv"] }, 2).source, "接入配置");
  const empty = {};
  assert.strictEqual(sandbox.outputSummary(empty), sandbox.outputSummary(empty));
});

test("Plan run targets reuse stable arrays and preserve normalized target order", () => {
  const sandbox = loadSummaries();
  const targets = [
    { label: "Worker B", role: "worker", remotePath: " /srv/demo/ ", maxConcurrentGpus: 2, allowedGpuIds: ["1", "1", "3"], condaEnv: "torch" },
    { label: "Hub", role: "hub", remotePath: "/srv/hub" },
    { label: "Worker B", role: "worker", remotePath: "/srv/demo" },
  ];
  const first = sandbox.targetLocations(targets);
  const counts = { unique: sandbox.uniqueCalls, path: sandbox.pathCalls };

  assert.deepEqual(JSON.parse(JSON.stringify(first)), [
    { id: "", label: "Worker B", role: "worker", remotePath: "/srv/demo", maxConcurrentGpus: 2, condaEnv: "torch" },
    { id: "", label: "Hub", role: "hub", remotePath: "/srv/hub", maxConcurrentGpus: "auto", condaEnv: "" },
  ]);
  assert.strictEqual(sandbox.targetLocations(targets), first);
  assert.strictEqual(sandbox.targetLocations(first), first);
  assert.deepEqual({ unique: sandbox.uniqueCalls, path: sandbox.pathCalls }, counts);

  const replacement = targets.map((target) => ({ ...target }));
  assert.notStrictEqual(sandbox.targetLocations(replacement), first);
  assert.ok(sandbox.pathCalls > counts.path);
  const empty = [];
  assert.strictEqual(sandbox.targetLocations(empty), sandbox.targetLocations(empty));
});

test("single and batch Plan confirmations keep path roles and section order", () => {
  const sandbox = loadSummaries();
  const plan = {
    planFile: "experiments/plans/demo.yaml",
    baseConfig: "configs/demo.yaml",
    mode: "train_test",
    cases: [{ id: "base" }, { id: "improved" }],
    seeds: [1, 2],
    outputCandidates: ["metrics.csv"],
    trainCommand: "python train.py",
    testCommand: "python test.py",
  };
  const targets = [
    { label: "Worker A", role: "worker", remotePath: "/srv/demo", maxConcurrentGpus: 2, allowedGpuIds: ["0", "1"], condaEnv: "torch" },
    { label: "Hub", role: "hub", remotePath: "/srv/hub" },
  ];
  const detail = sandbox.confirmOne("runPlan", plan, targets);
  const ordered = [
    "Plan：experiments/plans/demo.yaml",
    "运行类型：正式运行",
    "模式：训练并评估",
    "任务：4",
    "任务规模：2 个实验项 × 2 个随机种子 = 4 个任务",
    "静态配置容量：2 个并发任务",
    "配置：configs/demo.yaml",
    "实际执行命令：",
    "结果位置（Plan）：metrics.csv",
    "Worker：Worker A",
    "Worker 调度配置：",
    "远端项目位置：",
    "预期结果文件位置（模板）：",
  ];
  let previous = -1;
  for (const value of ordered) {
    const index = detail.indexOf(value);
    assert.ok(index > previous, value);
    previous = index;
  }
  assert.match(detail, /Worker A（运行生成）：\/srv\/demo\/metrics\.csv/);
  assert.match(detail, /Hub（同步后汇总）：\/srv\/hub\/metrics\.csv/);

  const batch = sandbox.confirmBatch([plan], targets);
  assert.match(batch, /【批量运行确认】运行全部计划/);
  assert.match(batch, /experiments\/plans\/demo\.yaml \| Worker 未选择 \| 训练并评估/);
  assert.match(batch, /Worker A（运行生成）：\/srv\/demo\/metrics\.csv/);
  assert.match(batch, /Hub（同步后汇总）：\/srv\/hub\/metrics\.csv/);
  assert.equal(sandbox.planRunOutputLocationSummaryCache.get(plan).size, 2);
  const normalizedTargets = sandbox.planRunTargetLocationsCache.get(targets);
  assert.strictEqual(sandbox.planRunTargetLocationsCache.get(normalizedTargets), normalizedTargets);
  assert.match(extension, /const planRunOutputLocationSummaryCache = new WeakMap\(\)/);
  assert.match(extension, /const planRunTargetLocationsCache = new WeakMap\(\)/);
});
