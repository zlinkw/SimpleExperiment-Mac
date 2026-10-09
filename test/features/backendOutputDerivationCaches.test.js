const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// 真实现：直接读取 src/extension/legacy.ts（门面 src/extension.ts 已不再包含逻辑），
// 提取真实函数体（含真实 normalizeOutputCandidateKey / dedupOutputCandidates /
// isParseableResultCandidate），不再手写 uniqueStrings / isParseable mock。
const extension = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");

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

function extractConst(name) {
  const start = extension.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = extension.indexOf(";", start);
  assert.ok(end > start, `unterminated ${name}`);
  return extension.slice(start, end + 1);
}

function loadOutputDerivations() {
  const sandbox = {
    path,
    PlanBuilder_1: {},
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    EMPTY_OUTPUT_DERIVATION_SOURCE: Object.freeze({}),
    planOutputCandidatesCache: new WeakMap(),
    planOutputEvidenceCandidatesCache: new WeakMap(),
    planOutputEvidenceSignalsCache: new WeakMap(),
    adapterRuleResultCandidatesCache: new WeakMap(),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst("OUTPUT_CANDIDATE_CONTRACT_BASENAMES"),
    extractFunction("arrayFromRecord"),
    extractFunction("uniqueStrings"),
    extractFunction("normalizeOutputCandidateKey"),
    extractFunction("dedupOutputCandidates"),
    extractFunction("isParseableResultCandidate"),
    extractFunction("adapterRuleResultCandidates"),
    extractFunction("planOutputCandidates"),
    extractFunction("planOutputEvidenceCandidates"),
    extractFunction("planOutputEvidenceSignals"),
    "this.ruleCandidates = adapterRuleResultCandidates;",
    "this.planCandidates = planOutputCandidates;",
    "this.planEvidence = planOutputEvidenceCandidates;",
    "this.planSignals = planOutputEvidenceSignals;",
    "this.outputKey = normalizeOutputCandidateKey;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("backend Plan output derivations reuse one immutable Plan and invalidate on replacement", () => {
  const sandbox = loadOutputDerivations();
  const plan = {
    outputCandidates: ["jobs.csv", "runs/metrics.csv", "RUNS/METRICS.CSV", "runs/stdout.log"],
    outputSignals: ["结果目录: runs", "命令参数: result_csv", "普通说明"],
  };

  const candidates = sandbox.planCandidates(plan);
  const evidence = sandbox.planEvidence(plan);
  const signals = sandbox.planSignals(plan);

  assert.deepEqual(JSON.parse(JSON.stringify(candidates)), ["jobs.csv", "runs/metrics.csv", "runs/stdout.log"]);
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)), ["runs/metrics.csv", "runs/stdout.log"]);
  assert.deepEqual(JSON.parse(JSON.stringify(signals)), ["结果目录: runs", "命令参数: result_csv"]);
  assert.strictEqual(sandbox.planCandidates(plan), candidates);
  assert.strictEqual(sandbox.planEvidence(plan), evidence);
  assert.strictEqual(sandbox.planSignals(plan), signals);

  const replacement = { outputCandidates: [...plan.outputCandidates], outputSignals: [...plan.outputSignals] };
  assert.notStrictEqual(sandbox.planCandidates(replacement), candidates);
  assert.notStrictEqual(sandbox.planEvidence(replacement), evidence);
  assert.notStrictEqual(sandbox.planSignals(replacement), signals);
});

test("backend adapter rule candidates reuse one rules object and preserve metadata exclusion", () => {
  const sandbox = loadOutputDerivations();
  const rules = {
    candidateCsv: ["jobs.csv", "metrics_summary.csv"],
    candidateJson: ["artifact_manifest.json", "metrics.json"],
    consoleLogs: ["stdout.log"],
    textLogs: ["summary.txt"],
  };

  const first = sandbox.ruleCandidates(rules);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), ["metrics_summary.csv", "metrics.json", "stdout.log", "summary.txt"]);
  assert.strictEqual(sandbox.ruleCandidates(rules), first);

  const replacement = Object.fromEntries(Object.entries(rules).map(([key, value]) => [key, [...value]]));
  assert.notStrictEqual(sandbox.ruleCandidates(replacement), first);
});

test("backend output derivation caches are weak and share empty results for invalid input", () => {
  const sandbox = loadOutputDerivations();
  assert.match(extension, /const planOutputCandidatesCache = new WeakMap\(\)/);
  assert.match(extension, /const planOutputEvidenceCandidatesCache = new WeakMap\(\)/);
  assert.match(extension, /const planOutputEvidenceSignalsCache = new WeakMap\(\)/);
  assert.match(extension, /const adapterRuleResultCandidatesCache = new WeakMap\(\)/);
  assert.strictEqual(sandbox.planCandidates(null), sandbox.EMPTY_OUTPUT_DERIVATION_VALUES);
  assert.strictEqual(sandbox.planEvidence([]), sandbox.EMPTY_OUTPUT_DERIVATION_VALUES);
  assert.strictEqual(sandbox.planSignals(""), sandbox.EMPTY_OUTPUT_DERIVATION_VALUES);
  assert.strictEqual(sandbox.ruleCandidates(null), sandbox.EMPTY_OUTPUT_DERIVATION_VALUES);
});

test("backend output candidates fold contract variants into one key", () => {
  const sandbox = loadOutputDerivations();
  assert.equal(sandbox.outputKey("{output_dir}/metrics_summary.csv"), "contract:metrics_summary.csv");
  assert.equal(sandbox.outputKey("work_dirs/multirun/demo/x_seed0/metrics_summary.csv"), "contract:metrics_summary.csv");
  assert.equal(sandbox.outputKey("METRICS_SUMMARY.CSV"), "contract:metrics_summary.csv");
  const plan = {
    outputCandidates: [
      "{output_dir}/metrics_summary.csv",
      "work_dirs/multirun/demo/x_seed0/metrics_summary.csv",
      "METRICS_SUMMARY.CSV",
      "{output_dir}/metrics_case.csv",
      "work_dirs/multirun/demo/x_seed0/stdout.log",
      "STDOUT.LOG",
    ],
    outputSignals: [],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.planCandidates(plan))), [
    "{output_dir}/metrics_summary.csv",
    "{output_dir}/metrics_case.csv",
    "work_dirs/multirun/demo/x_seed0/stdout.log",
  ]);
});
