const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// 真实现：直接读取 src/ui/PanelHtml.legacy.ts（门面已不再包含逻辑），
// 提取真实函数体（含真实 uniqueText / isParseableResultCandidate /
// normalizeOutputCandidateKey / dedupOutputCandidates），不再手写 mock。
const panel = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function extractConst(name) {
  const start = panel.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = panel.indexOf(";", start);
  assert.ok(end > start, `unterminated ${name}`);
  return panel.slice(start, end + 1);
}

// Panel 内层脚本位于外层模板字符串内，落盘前会被剥离一层转义；
// 此处模拟同一剥离（双反斜杠→单反斜杠），得到与线上运行时完全一致的真实代码。
function stripOuterTemplateEscapes(code) {
  return String(code || "").split("\\\\").join("\\");
}

function loadOutputDerivations() {
  const sandbox = {
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    EMPTY_OUTPUT_DERIVATION_SOURCE: Object.freeze({}),
    planOutputCandidatesCache: new WeakMap(),
    planOutputEvidenceCandidatesCache: new WeakMap(),
    planOutputEvidenceSignalsCache: new WeakMap(),
    adapterRuleResultCandidatesCache: new WeakMap(),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst("RESULT_METADATA_FILENAMES"),
    extractConst("RESULT_METADATA_SUFFIXES"),
    extractFunction("asArray"),
    extractFunction("uniqueText"),
    stripOuterTemplateEscapes(extractFunction("normalizeOutputCandidateKey")),
    extractFunction("dedupOutputCandidates"),
    stripOuterTemplateEscapes(extractFunction("normalizeResultCandidatePath")),
    stripOuterTemplateEscapes(extractFunction("isParseableResultCandidate")),
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

test("Plan output derivations reuse one immutable Plan object and invalidate on replacement", () => {
  const sandbox = loadOutputDerivations();
  const plan = {
    outputCandidates: ["jobs.csv", "runs/metrics.csv", "RUNS/METRICS.CSV", "runs/stdout.log"],
    outputSignals: ["结果文件: runs/metrics.csv", "stdout 捕获", "普通说明"],
  };

  const candidates = sandbox.planCandidates(plan);
  const evidence = sandbox.planEvidence(plan);
  const signals = sandbox.planSignals(plan);

  assert.deepEqual(JSON.parse(JSON.stringify(candidates)), ["jobs.csv", "runs/metrics.csv", "runs/stdout.log"]);
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)), ["runs/metrics.csv", "runs/stdout.log"]);
  assert.deepEqual(JSON.parse(JSON.stringify(signals)), ["结果文件: runs/metrics.csv", "stdout 捕获"]);
  assert.strictEqual(sandbox.planCandidates(plan), candidates);
  assert.strictEqual(sandbox.planEvidence(plan), evidence);
  assert.strictEqual(sandbox.planSignals(plan), signals);

  const replacement = { outputCandidates: [...plan.outputCandidates], outputSignals: [...plan.outputSignals] };
  assert.notStrictEqual(sandbox.planCandidates(replacement), candidates);
  assert.notStrictEqual(sandbox.planEvidence(replacement), evidence);
  assert.notStrictEqual(sandbox.planSignals(replacement), signals);
});

test("adapter rule result candidates reuse one rules object and keep metadata excluded", () => {
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

test("output derivation caches are weak and return one shared empty result for missing input", () => {
  const sandbox = loadOutputDerivations();
  assert.match(panel, /const planOutputCandidatesCache = new WeakMap\(\)/);
  assert.match(panel, /const planOutputEvidenceCandidatesCache = new WeakMap\(\)/);
  assert.match(panel, /const planOutputEvidenceSignalsCache = new WeakMap\(\)/);
  assert.match(panel, /const adapterRuleResultCandidatesCache = new WeakMap\(\)/);
  assert.strictEqual(sandbox.planCandidates(null), sandbox.EMPTY_OUTPUT_DERIVATION_VALUES);
  assert.strictEqual(sandbox.planEvidence(undefined), sandbox.EMPTY_OUTPUT_DERIVATION_VALUES);
  assert.strictEqual(sandbox.planSignals(""), sandbox.EMPTY_OUTPUT_DERIVATION_VALUES);
  assert.strictEqual(sandbox.ruleCandidates(null), sandbox.EMPTY_OUTPUT_DERIVATION_VALUES);
});

test("frontend output candidates fold contract variants into one key", () => {
  const sandbox = loadOutputDerivations();
  assert.equal(sandbox.outputKey("{output_dir}/metrics_summary.csv"), "contract:metrics_summary.csv");
  assert.equal(sandbox.outputKey("work_dirs/x/metrics_summary.csv"), "contract:metrics_summary.csv");
  assert.equal(sandbox.outputKey("STDERR.LOG"), "contract:stderr.log");
  const plan = {
    outputCandidates: [
      "{output_dir}/metrics_summary.csv",
      "work_dirs/x/metrics_summary.csv",
      "{output_dir}/metrics_case.csv",
      "STDERR.LOG",
      "work_dirs/x/stderr.log",
    ],
    outputSignals: [],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.planCandidates(plan))), [
    "{output_dir}/metrics_summary.csv",
    "{output_dir}/metrics_case.csv",
    "STDERR.LOG",
  ]);
});
