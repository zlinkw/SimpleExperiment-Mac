const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// 回归：输出捕获重复（metrics_summary / metrics_case / stdout / stderr 各 ×2）。
// 真实现：直接 require 构建产物 dist（npm test / npm run build 先行构建）。
const planBuilder = require(path.join(__dirname, "../../dist/features/PlanBuilder.js"));
const extensionSrc = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const panelSrc = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");

const TRIPLE_PLAN = [
  "suite: demo",
  "mode: test",
  "base_config: configs/base.yaml",
  "seeds: [0]",
  "cases:",
  "  - case: smoke",
  "paper:",
  "  result_csv: \"{output_dir}/metrics_summary.csv\"",
  "runner:",
  "  test_command: \"python test.py --config {config} --output-dir {output_dir} --result-csv {output_dir}/metrics_summary.csv\"",
  "expectedResults:",
  "  - work_dirs/multirun/demo/smoke_seed0/metrics_summary.csv",
  "  - work_dirs/multirun/demo/smoke_seed0/metrics_case.csv",
  "  - work_dirs/multirun/demo/smoke_seed0/stdout.log",
  "  - work_dirs/multirun/demo/smoke_seed0/stderr.log",
  "output_dir: work_dirs/multirun/demo/smoke_seed0",
].join("\n");

function contractBasename(value) {
  return String(value || "").split("/").pop().toLowerCase();
}

test("normalizeOutputCandidateKey folds contract variants and keeps big tables distinct", () => {
  const key = planBuilder.normalizeOutputCandidateKey;
  assert.equal(typeof key, "function");
  assert.equal(key("  {output_dir}/metrics_summary.csv "), "contract:metrics_summary.csv");
  assert.equal(key("work_dirs/multirun/demo/x/metrics_summary.csv"), "contract:metrics_summary.csv");
  assert.equal(key("METRICS_SUMMARY.CSV"), "contract:metrics_summary.csv");
  assert.equal(key("a\\metrics_case.csv"), "contract:metrics_case.csv");
  assert.equal(key("STDOUT.LOG"), "contract:stdout.log");
  assert.equal(key("x/stderr.log"), "contract:stderr.log");
  assert.notEqual(key("experiments/results/methodA.csv"), key("experiments/results/methodB.csv"));
  assert.notEqual(key("contract:metrics_summary.csv"), key("experiments/results/metrics_summary.csv"));
});

test("triple-declared plan yields each contract file exactly once", () => {
  const evidence = planBuilder.parsePlanOutputEvidence(TRIPLE_PLAN);
  assert.equal(evidence.outputCandidates.length, 4);
  const basenames = evidence.outputCandidates.map(contractBasename).sort();
  assert.deepEqual(basenames, ["metrics_case.csv", "metrics_summary.csv", "stderr.log", "stdout.log"]);
  assert.equal(evidence.evidenceCandidates.length, 4);
  assert.deepEqual(evidence.evidenceCandidates.map(contractBasename).sort(), basenames);

  const summary = planBuilder.parsePlanSummary(TRIPLE_PLAN);
  assert.equal(summary.outputCandidates.length, 4);
  // 折叠后 expectedResults 形态的信号仍保留（按归一键匹配，不过滤掉）
  assert.ok(summary.outputSignals.some((signal) => signal.includes("expectedResults") || signal.includes("work_dirs") || signal.includes("result_csv")));
});

test("extension and panel derive comparison keys from the same contract folding", () => {
  assert.match(extensionSrc, /function normalizeOutputCandidateKey\(/);
  assert.match(extensionSrc, /function dedupOutputCandidates\(/);
  assert.match(extensionSrc, /candidateKeys\.has\(targetKey\)/);
  assert.match(panelSrc, /function normalizeOutputCandidateKey\(/);
  assert.match(panelSrc, /function dedupOutputCandidates\(/);
  assert.match(panelSrc, /candidateKeys\.has\(targetKey\)/);
  assert.match(panelSrc, /const values = dedupOutputCandidates\(asArray\(candidates/);
});
