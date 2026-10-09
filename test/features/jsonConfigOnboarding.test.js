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

test("JSON configs participate in discovery, summaries, and onboarding evidence", async () => {
  const sandbox = {
    fs: fs.promises,
    path,
    defaultYamlScanBudget: { maxFiles: 500, maxDirs: 800, maxDepth: 8 },
    localConfigParamLimit: 80,
    JSON_PRIMITIVE_TYPES: new Set(["string", "number", "boolean"]),
    isHeavyProjectDir: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("yamlScalar"),
    extractFunction("yamlMapKey"),
    extractFunction("isImportantParam"),
    extractFunction("paramKind"),
    extractFunction("jsonConfigEvidenceText"),
    extractFunction("extractJsonParams"),
    extractFunction("walkYaml"),
    "this.api = { jsonConfigEvidenceText, extractJsonParams, walkYaml };",
  ].join("\n"), sandbox);

  const config = {
    task: "classification",
    metrics: ["auc", "accuracy"],
    dataset: { path: "datasets/demo" },
    outputs: { result_csv: "experiments/results/demo.csv" },
    seed: 42,
  };
  const evidence = sandbox.api.jsonConfigEvidenceText(config);
  assert.match(evidence, /^task: classification$/m);
  assert.match(evidence, /^metrics:\n  - auc\n  - accuracy$/m);
  assert.match(evidence, /^  result_csv: experiments\/results\/demo\.csv$/m);
  assert.ok(parsePlanOutputEvidence(evidence).outputCandidates.includes("experiments/results/demo.csv"));

  const params = sandbox.api.extractJsonParams(JSON.stringify(config));
  assert.ok(params.some((item) => item.key === "dataset.path" && item.value === "datasets/demo"));
  assert.ok(params.some((item) => item.key === "outputs.result_csv" && item.value === "experiments/results/demo.csv"));
  assert.ok(params.some((item) => item.key === "metrics" && item.value === '["auc","accuracy"]'));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-json-config-"));
  fs.writeFileSync(path.join(root, "base.yaml"), "seed: 1\n", "utf8");
  fs.writeFileSync(path.join(root, "smoke.json"), JSON.stringify(config), "utf8");
  fs.writeFileSync(path.join(root, "notes.txt"), "ignore", "utf8");
  const yamlOnly = await sandbox.api.walkYaml(root);
  const withJson = await sandbox.api.walkYaml(root, { includeJson: true });
  assert.deepEqual([...yamlOnly].map((file) => path.basename(file)).sort(), ["base.yaml"]);
  assert.deepEqual([...withJson].map((file) => path.basename(file)).sort(), ["base.yaml", "smoke.json"]);

  assert.match(source, /discoverProjectConfigFiles\(root\)/);
  assert.match(source, /includeJson: true,[\s\S]{0,80}includePython: true/);
  assert.match(source, /configEvidenceText\(item\.file, item\.text\)/);
  assert.match(source, /const params = \/\\\.json\$\/i\.test\(file\)[\s\S]{0,180}extractJsonParams\(text\)[\s\S]{0,180}extractYamlParams\(text\)/);
});
