const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { parsePlanOutputEvidence } = require("../../dist/features/PlanBuilder");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function extractFunction(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next).trim();
}

function extractConst(name) {
  const start = source.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing const ${name}`);
  const end = source.indexOf(";", start);
  assert.ok(end > start, `unterminated const ${name}`);
  return source.slice(start, end + 1);
}

test("Python configs are discovered and inspected without execution", async () => {
  const sandbox = {
    fs: fs.promises,
    path,
    defaultYamlScanBudget: { maxFiles: 500, maxDirs: 800, maxDepth: 8 },
    localConfigParamLimit: 80,
    isHeavyProjectDir: () => false,
    uniqueStrings: (values) => [...new Set(values)],
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("yamlScalar"),
    extractFunction("yamlMapKey"),
    extractFunction("stripYamlComment"),
    extractFunction("extractYamlParams"),
    extractFunction("isImportantParam"),
    extractFunction("paramKind"),
    extractFunction("stripPythonComment"),
    extractFunction("pythonBracketDelta"),
    extractFunction("pythonScalarLiteral"),
    extractFunction("pythonStringList"),
    extractFunction("pythonTopLevelAssignments"),
    extractConst("pythonConfigScalarKeys"),
    extractConst("pythonConfigOutputKeys"),
    extractConst("pythonConfigListKeys"),
    extractFunction("pythonConfigEvidenceText"),
    extractFunction("extractPythonConfigParams"),
    extractFunction("walkYaml"),
    "this.api = { pythonConfigEvidenceText, extractPythonConfigParams, pythonTopLevelAssignments, walkYaml, pythonConfigScalarKeys, pythonConfigOutputKeys, pythonConfigListKeys };",
  ].join("\n"), sandbox);

  const config = [
    "_base_ = ['base_runtime.py']",
    "task = 'classification'",
    "primary_metric = 'auc'",
    "metrics = [",
    "    'auc',",
    "    'accuracy',",
    "]",
    "data_root = 'datasets/demo'",
    "seed = 42",
    "model = dict(",
    "    type='Classifier',",
    "    output_dir='work_dirs/demo',",
    "    result_csv='experiments/results/demo.csv',",
    ")",
    "# result_csv = 'ignored/comment.csv'",
  ].join("\n");

  const assignments = sandbox.api.pythonTopLevelAssignments(config);
  assert.ok(assignments.some((item) => item.key === "metrics" && item.value.includes("accuracy")));
  assert.ok(assignments.some((item) => item.key === "model" && item.value.includes("result_csv")));

  const evidence = sandbox.api.pythonConfigEvidenceText(config);
  assert.match(evidence, /^task: classification$/m);
  assert.match(evidence, /^metric: auc$/m);
  assert.match(evidence, /^metrics:\n  - auc\n  - accuracy$/m);
  assert.match(evidence, /^result_csv: experiments\/results\/demo\.csv$/m);
  assert.doesNotMatch(evidence, /ignored\/comment\.csv/);
  assert.ok(parsePlanOutputEvidence(evidence).outputCandidates.includes("experiments/results/demo.csv"));

  const params = sandbox.api.extractPythonConfigParams(config);
  assert.ok(params.some((item) => item.key === "data_root" && item.value === "datasets/demo"));
  assert.ok(params.some((item) => item.key === "seed" && item.value === "42"));
  assert.ok(params.some((item) => item.key === "result_csv" && item.value === "experiments/results/demo.csv"));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-python-config-"));
  fs.writeFileSync(path.join(root, "base.yaml"), "seed: 1\n", "utf8");
  fs.writeFileSync(path.join(root, "smoke.json"), "{}", "utf8");
  fs.writeFileSync(path.join(root, "model.py"), config, "utf8");
  const yamlOnly = await sandbox.api.walkYaml(root);
  const allConfigs = await sandbox.api.walkYaml(root, { includeJson: true, includePython: true });
  assert.deepEqual([...yamlOnly].map((file) => path.basename(file)).sort(), ["base.yaml"]);
  assert.deepEqual([...allConfigs].map((file) => path.basename(file)).sort(), ["base.yaml", "model.py", "smoke.json"]);

  assert.match(source, /discoverProjectConfigFiles\(root\)/);
  assert.match(source, /includeJson: true,[\s\S]{0,80}includePython: true/);
  assert.match(source, /configEvidenceText\(item\.file, item\.text\)/);
  assert.match(source, /if \(\/\\\.py\$\/i\.test\(name\)\)\s*return pythonConfigEvidenceText\(text\)/);
  assert.equal(sandbox.api.pythonConfigScalarKeys.has("primary_metric"), true);
  assert.equal(sandbox.api.pythonConfigOutputKeys.has("result_csv"), true);
  assert.equal(sandbox.api.pythonConfigListKeys.has("metrics"), true);
  const evidenceFunction = extractFunction("pythonConfigEvidenceText");
  assert.doesNotMatch(evidenceFunction, /const outputKeys = new Set/);
  assert.doesNotMatch(evidenceFunction, /\]\.includes\(assignment\.key\)/);
});
