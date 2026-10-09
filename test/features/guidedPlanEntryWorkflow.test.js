const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test("guided Plan requires confirmed real entry commands and keeps first run small", () => {
  const sandbox = {
    path,
    DEFAULT_RESULT_CSV_DIR: "experiments/results",
    localConfigSummaryLimit: 80,
    guidedPlanConfigPickerSummaryLimit: 24,
    configSummaryTargetsCache: new WeakMap(),
    uniqueStrings: (values) => [...new Set(values)],
    GUIDED_PLAN_RESULT_FLAG_EXTENSIONS: new Map([
      ["result-csv", ".csv"], ["results-csv", ".csv"], ["metrics-csv", ".csv"], ["summary-csv", ".csv"], ["output-csv", ".csv"],
      ["result-json", ".json"], ["metrics-json", ".json"], ["summary-txt", ".txt"], ["log-file", ".log"], ["stdout", ".log"], ["stderr", ".log"],
    ]),
    GUIDED_PLAN_OUTPUT_DIR_FLAGS: new Set([
      "output", "out", "output-dir", "out-dir", "result-dir", "results-dir", "work-dir", "workdir", "save-dir", "log-dir",
      "logging-dir", "loggingdir", "tensorboard-log-dir", "tensorboardlogdir", "tb-log-dir", "tblogdir", "run-dir", "rundir",
      "default-root-dir", "defaultrootdir", "dirpath", "hydra.run.dir", "hydra.sweep.dir", "logger.save-dir", "trainer.default-root-dir",
    ]),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("isWeakMapCacheKey"),
    extractFunction("experimentEntryFileName"),
    extractFunction("isTrainEntryCandidate"),
    extractFunction("isTestEntryCandidate"),
    extractFunction("stripPythonComment"),
    extractFunction("pythonQuotedCliTokens"),
    extractFunction("staticPythonCliArguments"),
    extractFunction("planPlaceholderForCliArgument"),
    extractFunction("guidedPlanCommandInfo"),
    extractFunction("guidedPlanCommand"),
    extractFunction("guidedPlanCommandWarnings"),
    extractFunction("guidedPlanCommandPrompt"),
    extractFunction("guidedPlanResultPathReview"),
    extractFunction("guidedPlanResultPath"),
    extractFunction("planResultPathValidationMessage"),
    extractFunction("guidedPlanCommandUsesConfig"),
    extractFunction("guidedPlanScaleKey"),
    extractFunction("guidedPlanScaleReview"),
    extractFunction("guidedPlanConfigChoiceItem"),
    extractFunction("guidedPlanSummaryValue"),
    extractFunction("safePlanToken"),
    extractFunction("guidedPlanFallbackConfigPath"),
    extractFunction("guidedPlanConfigRecommendationPriority"),
    extractFunction("guidedPlanRecommendedConfig"),
    extractFunction("configSummaryPriority"),
    extractFunction("configSummaryTargets"),
    "this.api = { experimentEntryFileName, isTrainEntryCandidate, isTestEntryCandidate, staticPythonCliArguments, guidedPlanCommandInfo, guidedPlanCommand, guidedPlanCommandPrompt, guidedPlanResultPath, planResultPathValidationMessage, guidedPlanCommandUsesConfig, guidedPlanScaleReview, guidedPlanConfigChoiceItem, guidedPlanSummaryValue, guidedPlanFallbackConfigPath, guidedPlanConfigRecommendationPriority, guidedPlanRecommendedConfig, configSummaryPriority, configSummaryTargets };",
  ].join("\n"), sandbox);

  assert.equal(sandbox.api.experimentEntryFileName("train_net.py"), true);
  assert.equal(sandbox.api.experimentEntryFileName("notes.py"), false);
  assert.equal(sandbox.api.isTrainEntryCandidate("tools/train_net.py"), true);
  assert.equal(sandbox.api.isTrainEntryCandidate("src/main_worker.py"), true);
  assert.equal(sandbox.api.isTrainEntryCandidate("run.py"), true);
  assert.equal(sandbox.api.isTestEntryCandidate("tools/test_net.py"), true);
  assert.equal(sandbox.api.isTestEntryCandidate("src/evaluate.py"), true);
  assert.equal(sandbox.api.guidedPlanCommand("", "train"), "");
  assert.equal(sandbox.api.guidedPlanCommand("tools/train_net.py", "train"), 'python "tools/train_net.py"');

  const trainSource = [
    'parser.add_argument("config")',
    'parser.add_argument("--seed", type=int)',
    'parser.add_argument("--output-dir")',
    'parser.add_argument("--worker-id")',
    'parser.add_argument("--unknown")',
    '# parser.add_argument("--case")',
  ].join("\n");
  const trainInfo = sandbox.api.guidedPlanCommandInfo("tools/train_net.py", "train", trainSource);
  assert.equal(trainInfo.command, 'python "tools/train_net.py" {config} --seed {seed} --output-dir {output_dir} --worker-id {worker_id}');
  assert.equal(trainInfo.usesConfig, true);
  assert.equal(trainInfo.command.includes("--unknown"), false);
  assert.equal(trainInfo.command.includes("--case"), false);

  const testSource = [
    'parser.add_argument("--config-file")',
    'parser.add_argument("checkpoint")',
    '@click.option("--metrics-json")',
  ].join("\n");
  const testInfo = sandbox.api.guidedPlanCommandInfo("tools/test.py", "test", testSource);
  assert.equal(testInfo.command, 'python "tools/test.py" --config-file {config} --metrics-json {result_csv}');
  assert.equal(testInfo.resultExtension, ".json");
  assert.deepEqual([...testInfo.ignoredPositionals], ["checkpoint"]);
  assert.match(sandbox.api.guidedPlanCommandPrompt(testInfo, "test"), /未自动填写位置参数：checkpoint/);
  const trainOnlyInfo = sandbox.api.guidedPlanCommandInfo("tools/train.py", "train_result", 'parser.add_argument("--result-csv")\nparser.add_argument("--worker-id")');
  assert.equal(trainOnlyInfo.command, 'python "tools/train.py" --result-csv {result_csv} --worker-id {worker_id}');

  const typerInfo = sandbox.api.guidedPlanCommandInfo("eval.py", "test", 'config: str = typer.Option(..., "--config")\nresult: str = typer.Option(..., "--result-csv")');
  assert.equal(typerInfo.command, 'python "eval.py" --config {config} --result-csv {result_csv}');
  const inferredTyper = sandbox.api.guidedPlanCommandInfo("train.py", "train", 'config: str = typer.Argument(...)\nrandom_seed: int = typer.Option(42)');
  assert.equal(inferredTyper.command, 'python "train.py" {config} --random-seed {seed}');

  assert.equal(
    sandbox.api.guidedPlanResultPath('python eval.py --metrics-json {result_csv}', "smoke", ".csv"),
    "experiments/results/smoke/{case}_seed{seed}.csv",
  );
  assert.equal(
    sandbox.api.guidedPlanResultPath('python eval.py --result-csv {result_csv}', "smoke", ".json"),
    "experiments/results/smoke/{case}_seed{seed}.csv",
  );
  assert.equal(
    sandbox.api.guidedPlanResultPath('python eval.py result_csv={result_csv}', "smoke", ".csv"),
    "experiments/results/smoke/{case}_seed{seed}.csv",
  );
  assert.equal(
    sandbox.api.guidedPlanResultPath('python eval.py --metrics-json "work_dirs/{suite}/{case}/scores.json"', "smoke", ".csv"),
    "work_dirs/{suite}/{case}/scores.json",
  );
  assert.equal(
    sandbox.api.guidedPlanResultPath('python eval.py --output-dir {output_dir}', "smoke", ".csv"),
    "{output_dir}/metrics_summary.csv",
  );
  assert.equal(
    sandbox.api.guidedPlanResultPath('python eval.py > reports/{suite}/summary.txt', "smoke", ".csv"),
    "reports/{suite}/summary.txt",
  );
  assert.equal(
    sandbox.api.guidedPlanResultPath('python eval.py hydra.run.dir=work_dirs/{suite}/{case}', "smoke", ".csv"),
    "work_dirs/{suite}/{case}/metrics_summary.csv",
  );
  assert.match(source, /const GUIDED_PLAN_RESULT_FLAG_EXTENSIONS = new Map\(/);
  assert.match(source, /const GUIDED_PLAN_OUTPUT_DIR_FLAGS = new Set\(/);
  assert.match(source, /GUIDED_PLAN_RESULT_FLAG_EXTENSIONS\??\.has\(flag\)/);
  assert.match(source, /GUIDED_PLAN_OUTPUT_DIR_FLAGS\??\.has\(key\)/);
  assert.equal(sandbox.api.planResultPathValidationMessage("{output_dir}/metrics.json"), undefined);
  assert.match(sandbox.api.planResultPathValidationMessage("../metrics.csv"), /不能离开项目目录/);
  assert.match(sandbox.api.planResultPathValidationMessage("C:/tmp/metrics.csv"), /相对路径/);
  assert.match(sandbox.api.planResultPathValidationMessage("work_dirs/metrics.bin"), /扩展名/);
  assert.equal(sandbox.api.guidedPlanCommandUsesConfig("python train.py --config {config}"), true);
  assert.equal(sandbox.api.guidedPlanCommandUsesConfig("python train.py --seed {seed}"), false);
  assert.equal(sandbox.api.guidedPlanFallbackConfigPath("demo suite"), "configs/demo_suite_simple_experiment.yaml");
  assert.equal(sandbox.api.guidedPlanRecommendedConfig(["configs/a_full.yaml", "configs/z_smoke.yaml"]), "configs/z_smoke.yaml");
  assert.equal(sandbox.api.guidedPlanRecommendedConfig(["configs/production.yaml", "configs/base.yaml"]), "configs/base.yaml");
  assert.equal(sandbox.api.guidedPlanRecommendedConfig(["configs/main.yaml", "configs/nested/debug_small.json"]), "configs/nested/debug_small.json");
  assert.equal(sandbox.api.guidedPlanRecommendedConfig(["configs/first.yaml", "configs/second.yaml"]), "configs/first.yaml");
  assert.equal(sandbox.api.guidedPlanConfigRecommendationPriority("configs/full_config.yaml"), 10);
  assert.equal(sandbox.api.configSummaryPriority("configs/full_config.yaml"), 10);
  assert.equal(sandbox.api.configSummaryPriority("configs/z_smoke.yaml"), 0);
  assert.equal(sandbox.api.configSummaryPriority("configs/dataset/main.yaml"), 3);
  const manyConfigs = Array.from({ length: 100 }, (_, index) => `configs/full_${String(index).padStart(3, "0")}.yaml`);
  manyConfigs.push("configs/z_smoke.yaml");
  const summaryTargets = sandbox.api.configSummaryTargets(manyConfigs);
  assert.equal(summaryTargets.length, 80);
  assert.equal(summaryTargets[0], "configs/z_smoke.yaml");
  assert.equal(sandbox.api.guidedPlanScaleReview("configs/smoke.yaml", []).needsReview, true);
  assert.equal(sandbox.api.guidedPlanScaleReview("configs/main.yaml", [{ key: "trainer.max_epochs", value: "100" }]).needsReview, true);
  assert.equal(sandbox.api.guidedPlanScaleReview("configs/main.yaml", [{ key: "trainer.max_steps", value: "200" }]).needsReview, false);
  assert.equal(sandbox.api.guidedPlanScaleReview("configs/generated.yaml", [], true).needsReview, true);
  assert.match(sandbox.api.guidedPlanScaleReview("configs/main.yaml", [{ key: "trainer.max_epochs", value: "100" }]).summary, /trainer\.max_epochs=100/);
  const smallChoice = sandbox.api.guidedPlanConfigChoiceItem("configs/quick.yaml", "configs/quick.yaml", sandbox.api.guidedPlanScaleReview("configs/quick.yaml", [{ key: "trainer.max_steps", value: "200" }]));
  assert.equal(smallChoice.description, "推荐首跑 · 小规模参数");
  assert.match(smallChoice.detail, /trainer\.max_steps=200/);
  const uncheckedChoice = sandbox.api.guidedPlanConfigChoiceItem("configs/full.yaml", "configs/quick.yaml", undefined, false);
  assert.equal(uncheckedChoice.description, "未预读规模");
  assert.match(uncheckedChoice.detail, /前 24 个高优先级配置/);
  assert.equal(sandbox.api.guidedPlanSummaryValue("x".repeat(200), 20).length, 20);

  assert.match(source, /\["scripts", "src", "tools", "experiments"\]\.map/);
  assert.match(source, /walkProjectFiles\(dir, root, experimentEntryFileName, 20, 3/);
  assert.match(source, /guidedPlanCommandSuggestion\(root, trainEntry, trainCommandStage\)/);
  assert.match(source, /guidedPlanCommandSuggestion\(root, testEntry, "test"\)/);
  assert.match(source, /guidedPlanResultPathReview\(resultCommand, suite, resultSuggestion\.resultExtension, this\.resultCsvDirectory\)/);
  assert.match(source, /title: "选择 Plan 运行模式"/);
  assert.match(source, /inputPlanResultPath\("确认最终结果文件"/);
  assert.match(source, /result_csv: \$\{JSON\.stringify\(resultPath\)\}/);
  assert.match(source, /首次接入固定为单 case、单 seed/);
  assert.match(source, /await confirmGuidedPlanCreation\(\{ relative, mode, baseConfig, trainEntry, testEntry, trainCommand, testCommand, resultPath, resultReview, configReview \}\)/);
  assert.match(source, /"任务规模：1 个实验项 × 1 个随机种子 = 1 个任务"/);
  assert.match(source, /showWarningMessage\(detail, \{ modal: true \}, label\)/);
  assert.match(source, /const recommended = guidedPlanRecommendedConfig\(list\)/);
  assert.match(source, /const choices = await guidedPlanConfigChoiceItems\(options\.root, list, recommended\)/);
  assert.match(source, /placeHolder: "优先选择已检测到小规模参数的配置/);
  assert.doesNotMatch(source, /python -m your_package\.(?:train|test)/);
  assert.doesNotMatch(source, /"  (?:gpu_per_job|max_parallel|poll_seconds|test_on_failed_train|skip_success):/);
});

test("config summary targets cache stable source identity and invalidate on replacement", () => {
  const sandbox = { path, localConfigSummaryLimit: 80, configSummaryTargetsCache: new WeakMap() };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("isWeakMapCacheKey"),
    extractFunction("guidedPlanConfigRecommendationPriority"),
    extractFunction("configSummaryPriority"),
    extractFunction("configSummaryTargets"),
    "this.targets = configSummaryTargets;",
  ].join("\n"), sandbox);

  const files = [
    "configs/z_full.yaml",
    "configs/z_train.yaml",
    "configs/dataset/main.yaml",
    "configs/base.yaml",
    "configs/z_smoke.yaml",
    "configs/a_train.yaml",
  ];
  const first = sandbox.targets(files);
  assert.strictEqual(sandbox.targets(files), first);
  assert.deepEqual([...first], [
    "configs/z_smoke.yaml",
    "configs/base.yaml",
    "configs/a_train.yaml",
    "configs/dataset/main.yaml",
    "configs/z_train.yaml",
    "configs/z_full.yaml",
  ]);

  const replacement = [...files].reverse();
  const replaced = sandbox.targets(replacement);
  assert.notStrictEqual(replaced, first);
  assert.deepEqual([...replaced], [...first]);

  const empty = [];
  const emptyTargets = sandbox.targets(empty);
  assert.strictEqual(sandbox.targets(empty), emptyTargets);
  assert.notStrictEqual(sandbox.targets([]), emptyTargets);
  assert.deepEqual([...emptyTargets], []);
});

test("guided Plan config picker previews only the high-priority budget", async () => {
  const reviewed = [];
  const sandbox = {
    guidedPlanConfigPickerSummaryLimit: 2,
    configSummaryTargets: (files) => [...files],
    mapLimited: async (items, _limit, worker) => Promise.all(items.map(worker)),
    guidedPlanConfigReview: async (_root, file) => {
      reviewed.push(file);
      return { needsReview: file !== "configs/smoke.yaml", summary: `${file}=summary`, reason: "review" };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("guidedPlanConfigChoiceItem"),
    `async ${extractFunction("guidedPlanConfigChoiceItems")}`,
    "this.items = guidedPlanConfigChoiceItems;",
  ].join("\n"), sandbox);
  const items = await sandbox.items("D:/project", ["configs/smoke.yaml", "configs/base.yaml", "configs/full.yaml"], "configs/smoke.yaml");
  assert.deepEqual(reviewed, ["configs/smoke.yaml", "configs/base.yaml"]);
  assert.equal(items[0].description, "推荐首跑 · 小规模参数");
  assert.equal(items[1].description, "需核对规模");
  assert.equal(items[2].description, "未预读规模");
});
