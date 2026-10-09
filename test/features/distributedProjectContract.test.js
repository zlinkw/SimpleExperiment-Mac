const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../_helpers/registerTsRequire");
const { normalizeDistributedProjectContract } = require("../../src/features/DistributedProjectContract.ts");

test("default distributed contract covers every Plan and retains required evidence", () => {
  const contract = normalizeDistributedProjectContract();
  assert.deepEqual(contract.planPrefixes, []);
  assert.ok(contract.requiredPaths.includes("best_model.pth"));
  assert.ok(contract.fragmentPaths.includes("test_results/formal_result_rows.csv"));
});

test("CSV-only projects explicitly opt out of a model checkpoint without losing result evidence", () => {
  const contract = normalizeDistributedProjectContract({ planPrefixes: ["experiments/plans/"],
    checkpointRequired: false, resultRowsPath: "metrics.csv", fragmentPaths: ["metrics.csv"],
    requiredPaths: ["metrics.csv"], mergeModule: "project_tools.merge" });
  assert.deepEqual(contract.requiredPaths, ["metrics.csv"]);
  assert.deepEqual(contract.fragmentPaths, ["metrics.csv"]);
  assert.equal(contract.checkpointRequired, false);
  assert.equal(normalizeDistributedProjectContract().checkpointRequired, true);
  assert.throws(() => normalizeDistributedProjectContract({checkpointRequired: "false"}), /true/);
});

test("project file parser preserves an explicit checkpoint opt-out", () => {
  const fs=require('node:fs');const ts=require('typescript');const vm=require('node:vm');
  const source=fs.readFileSync(require.resolve('../../src/extension/legacy.ts'),'utf8');
  const ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);
  const method=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='parseProjectAdapterRules').getText(ast);
  const {parseDistributedResultsFlag}=require('../../src/features/DistributedAdapterFlag.ts');
  const c=vm.createContext({parseDistributedResultsFlag,escapeRegExp:value=>value,uniqueStrings:values=>[...new Set(values)]});
  vm.runInContext(ts.transpileModule(method,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);
  const parsed=c.parseProjectAdapterRules('distributed:\n  checkpointRequired: false\n');
  assert.equal(parsed.distributed.checkpointRequired,false);
  assert.equal(c.parseProjectAdapterRules('').distributed.checkpointRequired,undefined);
});

test("project contract accepts a different Plan family and protects the checkpoint", () => {
  const contract = normalizeDistributedProjectContract({ planPrefixes: ["experiments/plans/formal/"],
    mergeModule: "my_project.results.merge", checkpointPath: "weights/final.pt",
    fragmentPaths: ["metrics/job.json"], requiredPaths: ["metrics/job.json"] });
  assert.deepEqual(contract.planPrefixes, ["experiments/plans/formal/"]);
  assert.deepEqual(contract.requiredPaths, ["metrics/job.json", "weights/final.pt"]);
  assert.throws(() => normalizeDistributedProjectContract({ checkpointPath: "../weights/final.pt" }));
  assert.throws(() => normalizeDistributedProjectContract({ mergeModule: "package.module;rm" }));
});

test("all distributed file and prefix fields reject Windows absolute paths and alternate streams", () => {
  for (const unsafe of ["C:/outside.csv", "D:\\outside.csv", "//server/share/file.csv", "metrics.csv:secret", "../metrics.csv"]) {
    for (const field of ["configPath", "checkpointPath", "resultRowsPath", "fourStatePath", "planPrefixes", "fragmentPaths", "requiredPaths"]) {
      const value = ["planPrefixes", "fragmentPaths", "requiredPaths"].includes(field) ? [unsafe] : unsafe;
      assert.throws(() => normalizeDistributedProjectContract({ [field]: value }), /相对路径无效/, `${field}: ${unsafe}`);
    }
  }
});

test("a generic command Plan needs named work and declared artifacts without research metadata or metrics", () => {
  const { validateDeepLearningPlanContract } = require("../../dist/features/PlanBuilder");
  const yaml = ["runner:", "  command: python tools/process.py", "  cwd: .", "  inputs: [data/input.json]", "  outputs: [artifacts/report.bin]", "cases:", "  - name: process", ""].join("\n");
  const result = validateDeepLearningPlanContract(yaml);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.summary.mode, "train", "one-stage command does not require a second test command");
  assert.equal(result.summary.hasGenericRunnerContract, true);
  assert.deepEqual(result.summary.declaredOutputs, ["artifacts/report.bin"]);
  assert.equal(validateDeepLearningPlanContract(yaml.replace("  outputs: [artifacts/report.bin]\n", "")).ok, false);
});
