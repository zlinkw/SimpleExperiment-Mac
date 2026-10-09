const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const agent = readSource("src/clusterAgentRuntime.ts");
const scheduler = readSource("src/clusterSchedulerRuntime.ts");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("result CSV directory is project-scoped and editable from Settings", () => {
  const setting = pkg.contributes.configuration.properties["simpleExperiment.resultCsvDir"];
  assert.equal(setting.default, "experiments/results");
  assert.equal(setting.scope, "resource");
  assert.match(panel, /id="resultCsvDirectorySettings" data-anchor="settings-result-csv"/);
  assert.match(panel, /data-config-input="resultOutput" data-key="csvDirectory"/);
  assert.match(panel, /data-command="chooseResultCsvDir"/);
  assert.match(panel, /data-command="saveResultCsvDir"/);
  assert.match(panel, /data\.resultOutputConfig/);
  assert.match(extension, /case "saveResultCsvDir":\s*await this\.saveResultCsvDirFromUi\(message\)/);
  assert.match(extension, /case "chooseResultCsvDir":\s*await this\.chooseResultCsvDirFromUi\(\)/);
  assert.match(extension, /ConfigurationTarget\.WorkspaceFolder/);
  assert.match(extension, /canSelectFolders: true/);
});

test("local path validation rejects roots, absolute paths, and traversal", () => {
  const start = extension.indexOf("function normalizeResultCsvDir(");
  const end = extension.indexOf("function resultCsvDirSafe()", start);
  assert.ok(start > 0 && end > start);
  const normalize = Function("path", `${extension.slice(start, end)}; return normalizeResultCsvDir;`)(path);
  assert.equal(normalize("custom\\csv\\"), "custom/csv");
  assert.throws(() => normalize(""), /不能为空/);
  assert.throws(() => normalize("."), /工作区根目录/);
  assert.throws(() => normalize("../outside"), /不能离开工作区/);
  assert.throws(() => normalize("C:/outside"), /相对路径/);
  assert.throws(() => normalize("/outside"), /相对路径/);
});

test("configured default reaches Agent, scheduler, Worker, and keeps explicit Plan paths", () => {
  assert.match(extension, /defaultResultCsvDir: this\.resultCsvDirectory/);
  assert.match(agent, /--default-result-csv-dir", default_result_csv_dir/);
  assert.match(agent, /"defaultResultCsvDir": default_result_csv_dir/);
  assert.match(scheduler, /parser\.add_argument\("--default-result-csv-dir"/);
  assert.match(scheduler, /Path\(normalize_default_result_csv_dir\(args\.default_result_csv_dir\)\) \/ "jobs\.csv"/);

  const python = process.platform === "win32" ? "python" : "python3";
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, "../_helpers"))})`,
    "from extractRuntimeFunctions import extract_runtime_functions",
    "m = extract_runtime_functions(sys.argv[1], ['build_jobs', 'normalize_default_result_csv_dir']).__dict__",
    "base = {'suite':'demo','base_config':{'model':'x'},'mode':'test','runner':{'test_command':'python test.py --result-csv {result_csv}'},'cases':[{'case':'a'}]}",
    "_, fallback = m['build_jobs'](base, 'custom/csv')",
    "explicit_plan = dict(base)",
    "explicit_plan['paper'] = {'result_csv':'fixed/results.csv'}",
    "_, explicit = m['build_jobs'](explicit_plan, 'custom/csv')",
    "blocked = False",
    "try: m['normalize_default_result_csv_dir']('/outside')",
    "except SystemExit: blocked = True",
    "print(json.dumps({'fallback': fallback[0].result_csv, 'explicit': explicit[0].result_csv, 'blocked': blocked}))",
  ].join("\n");
  const testDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "result-csv-config-"));
  const scriptFile = path.join(testDir, "check.py");
  fs.writeFileSync(scriptFile, script, "utf8");
  const result = spawnSync(python, ["-X", "utf8", "-B", scriptFile, path.join(root, "dist/runtime/cluster_scheduler.py")], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    fallback: "custom/csv/demo.csv",
    explicit: "fixed/results.csv",
    blocked: true,
  });
});

test("guided Plan uses the configured directory only for injectable defaults", () => {
  assert.match(extension, /guidedPlanResultPathReview\(resultCommand, suite, resultSuggestion\.resultExtension, this\.resultCsvDirectory\)/);
  assert.match(extension, /\$\{resultDir\}\/\$\{safeSuite\}\/\{case\}_seed\{seed\}\$\{extension\}/);
  assert.match(extension, /explicitPaths\[0\]\.path/);
});

test("Provider reuses one normalized result directory until config or workspace changes", () => {
  assert.match(extension, /resultCsvDirectory = resultCsvDirSafe\(\)/);
  assert.match(extension, /refreshResultCsvDirectory\(\) \{\s*this\.resultCsvDirectory = resultCsvDirSafe\(\)/);
  assert.match(extension, /affectsConfiguration\("simpleExperiment\.resultCsvDir"\)[\s\S]{0,220}this\.refreshResultCsvDirectory\(\)/);
  assert.match(extension, /resetProjectContextInMemory\(\)[\s\S]*this\.refreshResultCsvDirectory\(\)/);
  assert.match(extension, /defaultResultCsvDir: this\.resultCsvDirectory/);
  assert.match(extension, /csvDirectory: this\.resultCsvDirectory/);
  assert.equal((extension.match(/resultCsvDirSafe\(\)/g) || []).length, 3);
  assert.equal((extension.match(/this\.resultCsvDirectory = resultCsvDir;/g) || []).length, 2);
});

 test("configured root catalog and table paths use dataset partitions", () => {
  const tables = require("../../dist/results/ProjectResultTables");
  const workspace = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "result-config-behavior-"));
  const registry = tables.emptyTableRegistry();
  registry.plans["experiments/plans/demo.yaml"] = {revision: "r1", expectedSeeds: 1, records: [{planFile: "experiments/plans/demo.yaml", workerId: "worker", case: "case", seed: "1", method: "demo", dataset: "BUS", rate: "", endpoint: "", metrics: {accuracy: .8}}]};
  const table = tables.buildTables(registry)["BUS/final"];
  const relative = path.posix.join("artifacts/results", table.relativePath);
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, tables.writeCsv(table.header, table.rows), "utf8");
  const found = tables.tableCatalog(workspace, "artifacts/results");
  assert.equal(found[0].path, "artifacts/results/BUS/final/final.csv");
  assert.equal(found[0].tableKey, "BUS/final");
  assert.equal(fs.existsSync(path.join(workspace, "experiments/results")), false);
 });
