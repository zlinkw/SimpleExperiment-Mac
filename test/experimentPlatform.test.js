const test = require("node:test");
const assert = require("node:assert/strict");

const { buildExperimentMatrix, builtInPlanTemplates, parsePlanCases, parsePlanOutputEvidence, renderPlanTemplate } = require("../dist/features/PlanBuilder.js");
const { dryRunScheduling } = require("../dist/features/SmartScheduler.js");
const { applyExperimentEvent, retryExperiment } = require("../dist/features/Lifecycle.js");
const { parseMetricsFile, buildLeaderboard, leaderboardToMarkdown } = require("../dist/features/Metrics.js");
const { compareExperiments, comparisonToMarkdown } = require("../dist/features/Comparison.js");
const { detectAnomalies } = require("../dist/features/Anomaly.js");
const { NotificationThrottle } = require("../dist/features/Notifications.js");
const { searchExperiments, upsertTag } = require("../dist/features/SearchTags.js");
const { recycleView, recycleAuditMarkdown } = require("../dist/features/RecycleBin.js");

test("plan builder generates grid plan and detects duplicate runKey", () => {
  const result = buildExperimentMatrix({
    baseConfig: "configs/base.yaml",
    suite: "abl",
    seeds: ["1", "2"],
    variables: [
      { name: "model", values: ["a", "b"], mode: "grid" },
      { name: "loss", values: ["dice"], mode: "grid" },
    ],
  }, ["abl:abl__model-a__loss-dice__seed-1"]);
  assert.equal(result.experiments.length, 4);
  assert.equal(result.duplicateRunKeys.length, 1);
  assert.equal(parsePlanCases(result.yaml).length, 2);
  assert.match(result.yaml, /paper:\n  result_csv: "\{output_dir\}\/metrics_summary\.csv"/);
  assert.match(result.yaml, /runner:\n  train_command: "python train\.py --config \{config\}/);
  assert.match(result.yaml, /naming:\n  sweep_dir: "work_dirs\/multirun\/\{suite\}"/);
  assert.match(result.yaml, /cases:\n  - case: "abl__loss-dice__model-a"/);
  assert.doesNotMatch(result.yaml, /\n      seed:/);
  assert.match(result.yaml, /expectedResults:\n      - "work_dirs\/multirun\/\{suite\}\/\{case\}_seed\{seed\}\/metrics_summary\.csv"/);
});

test("built-in plan template uses the shared scheduler plan contract", () => {
  const rendered = renderPlanTemplate(builtInPlanTemplates[0], {
    suite: "cls_smoke",
    base_config: "configs/base.yaml",
    dataset: "demo",
    seed: "1",
  })[0].content;
  assert.match(rendered, /suite: cls_smoke/);
  assert.match(rendered, /base_config: configs\/base.yaml/);
  assert.match(rendered, /paper:\n  result_csv: \{output_dir\}\/metrics_summary\.csv/);
  assert.match(rendered, /runner:\n  train_command: "python train\.py --config \{config\}/);
  assert.match(rendered, /naming:\n  sweep_dir: work_dirs\/multirun\/\{suite\}/);
  assert.match(rendered, /cases:\n  - case: cls_smoke_demo/);
  assert.match(rendered, /outputDir: work_dirs\/multirun\/\{suite\}\/\{case\}_seed\{seed\}/);
  assert.match(rendered, /expectedResults:\n      - work_dirs\/multirun\/\{suite\}\/\{case\}_seed\{seed\}\/metrics_summary\.csv/);
});

test("plan builder parses case name and id aliases", () => {
  const cases = parsePlanCases([
    "cases:",
    "  - case: baseline",
    "  - name: convnext",
    "  - id: external_001",
  ].join("\n"));
  assert.deepEqual(cases, ["baseline", "convnext", "external_001"]);
});

test("plan builder parses aliases when external plan fields come first", () => {
  const cases = parsePlanCases([
    "experiments:",
    "  - command: python train.py --config {config}",
    "    name: ext_command_first",
    "    outputDir: work_dirs/ext_command_first",
    "  - outputDir: work_dirs/ext_id_second",
    "    expectedResults:",
    "      - work_dirs/ext_id_second/metrics_summary.csv",
    "    id: ext_id_second",
    "cases:",
    "  mapped_case:",
    "    config: configs/mapped.yaml",
    "  flow_case: {base_config: configs/flow.yaml}",
  ].join("\n"));
  assert.deepEqual(cases, ["ext_command_first", "ext_id_second", "mapped_case", "flow_case"]);
});

test("plan builder parses flow-map case aliases", () => {
  const cases = parsePlanCases([
    "experiments:",
    "  - {id: flow_id, command: python train.py}",
    "  - {command: python train.py, name: flow_name, outputDir: outputs/name}",
    "  - {outputDir: outputs/case, case: flow_case}",
  ].join("\n"));
  assert.deepEqual(cases, ["flow_id", "flow_name", "flow_case"]);
});

test("plan builder ignores nested result ids when parsing external cases", () => {
  const cases = parsePlanCases([
    "experiments:",
    "  - command: python train.py",
    "    expectedResults:",
    "      - id: not_a_case",
    "        path: outputs/a.csv",
    "    name: real_case",
    "  - outputDir: work_dirs/b",
    "    expected_results:",
    "      - path: outputs/b.csv",
    "    case: second_case",
  ].join("\n"));
  assert.deepEqual(cases, ["real_case", "second_case"]);
});

test("plan builder parses map-style cases without nested config keys", () => {
  const cases = parsePlanCases([
    "suite: mapped",
    "cases:",
    "  case_a:",
    "    runner:",
    "      train_command: echo a",
    "    overrides:",
    "      model.name: a",
    "  case_b:",
    "    config: configs/b.yaml",
    "    outputDir: work_dirs/b",
  ].join("\n"));
  assert.deepEqual(cases, ["case_a", "case_b"]);
});

test("plan output evidence ignores comments and object ids", () => {
  const evidence = parsePlanOutputEvidence([
    "suite: comment_false_positive",
    "base_config: configs/base.yaml",
    "# expectedResults:",
    "#   - metrics_summary.csv",
    "cases:",
    "  - case: no_output",
    "    output_dir: work_dirs/no_output",
    "    expectedResults:",
    "      - id: not_a_result",
    "        note: metrics_summary.csv only in note",
  ].join("\n"));
  assert.deepEqual(evidence.evidenceCandidates, []);
  assert.deepEqual(evidence.outputSignals, ["结果目录: work_dirs/no_output"]);
  assert.equal(evidence.outputCandidates.includes("work_dirs/no_output/metrics_summary.csv"), true);
});

test("plan output evidence reads object style expected result paths", () => {
  // 终版5文件契约（2026-09）：outputs/ 宿主下仅契约 basename 放行；classification_report.json/output.out 走声明不计入候选。
  const evidence = parsePlanOutputEvidence([
    "suite: object_results",
    "base_config: configs/base.yaml",
    "runner:",
    "  test_command: \"python test.py --result-csv {result_csv}\"",
    "cases:",
    "  - id: object_case",
    "    expectedResults:",
    "      - id: report_row",
    "        path: outputs/object_case/metrics_summary.csv",
    "      - {id: ignored_id, file: outputs/object_case/classification_report.json}",
    "      - result_csv: outputs/object_case/output.out",
  ].join("\n"));
  assert.deepEqual(evidence.evidenceCandidates, [
    "outputs/object_case/metrics_summary.csv",
  ]);
  assert.equal(evidence.outputSignals.some((item) => item.includes("outputs/object_case/metrics_summary.csv")), true);
  assert.equal(evidence.outputSignals.includes("命令参数: result_csv"), true);
});

test("smart scheduler dry-run explains GPU choice and failover", () => {
  const decision = dryRunScheduling("exp1", [
    { serverId: "bad", gpuId: "0", freeMemoryMb: 100, utilizationPercent: 0, healthScore: 10 },
    { serverId: "ok", gpuId: "1", freeMemoryMb: 24000, utilizationPercent: 2, healthScore: 90 },
  ], [
    { serverId: "bad", enabled: true, maxConcurrentJobs: 1, minFreeMemoryMb: 8000, maxUtilizationPercent: 20 },
    { serverId: "ok", enabled: true, maxConcurrentJobs: 1, minFreeMemoryMb: 8000, maxUtilizationPercent: 20, priorityWeight: 2 },
  ], 12000);
  assert.equal(decision.serverId, "ok");
  assert.match(decision.reason, /free=24000/);
});

test("lifecycle timeline protects terminal state and retry creates attempt", () => {
  let lc = applyExperimentEvent(undefined, { experimentId: "e1", seq: 1, type: "state", to: "completed", at: "2026-01-01T00:00:00Z", source: "scheduler", attemptId: "attempt-1" });
  lc = applyExperimentEvent(lc, { experimentId: "e1", seq: 0, type: "state", to: "running", at: "2026-01-01T00:00:01Z", source: "agent", attemptId: "attempt-1" });
  assert.equal(lc.state, "completed");
  const retry = retryExperiment(lc, "another_worker");
  assert.equal(retry.state, "queued");
  assert.equal(retry.attemptId, "attempt-2");
});

test("metrics leaderboard exports markdown", () => {
  const rows = parseMetricsFile("runKey,experimentId,DSC,HD95\nm_seed1,e1,0.8,10\nm_seed2,e2,0.9,8\n", "results.csv");
  const board = buildLeaderboard(rows, (row) => row.runKey.replace(/_seed\d+/, ""), "DSC", true);
  const md = leaderboardToMarkdown(board, ["DSC", "HD95"]);
  assert.equal(board[0].bestExperimentId, "e2");
  assert.match(md, /0\.85/);
});

test("experiment comparison exports config and metric diff", () => {
  const report = compareExperiments([
    { experimentId: "a", config: { lr: 1 }, metrics: { DSC: 0.8 } },
    { experimentId: "b", config: { lr: 2 }, metrics: { DSC: 0.9 } },
  ]);
  assert.equal(report.configDiffs[0].key, "lr");
  assert.match(comparisonToMarkdown(report), /Experiment Comparison/);
});

test("anomaly detects stalled run, NaN loss, and low disk", () => {
  const anomalies = detectAnomalies({
    now: Date.parse("2026-01-01T01:00:00Z"),
    experiments: [{ experimentId: "e", status: "running", serverId: "w", gpuMemoryMb: 0, gpuUtilization: 1, lastLogAt: "2026-01-01T00:00:00Z", logText: "loss=NaN" }],
    disks: [{ serverId: "w", freePercent: 2, path: "/" }],
  });
  assert.equal(anomalies.some((item) => item.type === "stalled_log"), true);
  assert.equal(anomalies.some((item) => item.type === "nan_loss"), true);
  assert.equal(anomalies.some((item) => item.type === "disk_low"), true);
});

test("notification throttle, search tags, recycle view", () => {
  const throttle = new NotificationThrottle();
  const rule = { id: "r", enabled: true, eventType: "experiment_failed", severity: "warning", channels: ["vscode"], throttleSeconds: 60 };
  assert.equal(throttle.shouldNotify(rule, { type: "experiment_failed", severity: "warning", message: "failed", key: "e", at: 1000 }), true);
  assert.equal(throttle.shouldNotify(rule, { type: "experiment_failed", severity: "warning", message: "failed", key: "e", at: 2000 }), false);
  assert.equal(throttle.shouldNotify(rule, { type: "experiment_failed", severity: "warning", message: "failed", key: "other", at: 2000 }), true);
  assert.equal(throttle.shouldNotify(rule, { type: "experiment_failed", severity: "warning", message: "failed", key: "e", at: 61000 }), true);
  assert.equal(throttle.shouldNotify({ ...rule, enabled: false }, { type: "experiment_failed", severity: "warning", message: "failed", key: "disabled", at: 1000 }), false);
  const tags = upsertTag([], { experimentId: "e", tag: "paper-candidate", createdAt: "now" });
  assert.equal(searchExperiments([{ experimentId: "e", status: "completed", metrics: { DSC: 0.9 } }], { tag: "paper-candidate", metricRange: { metric: "DSC", min: 0.8 } }, tags).length, 1);
  const recycle = recycleView([{ archiveKey: "k", state: "delete_failed", targetPaths: ["/x"], residue: [{ endpoint: "hub", path: "/x" }] }]);
  assert.equal(recycle.length, 1);
  assert.match(recycleAuditMarkdown(recycle), /delete_failed/);
});
