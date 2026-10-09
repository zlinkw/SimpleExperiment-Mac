const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { checkProjectOutputContract, builtInOutputContracts } = require("../dist/features/Quality.js");
const { importLegacyPlanYamlToRegistry } = require("../dist/features/PlanBuilder.js");
const { readSource } = require("./_helpers/sourceReader");
const {
  buildCompletenessMatrix,
  buildOutputCapabilityMatrix,
  buildPostRunChecklist,
  buildPreRunChecklist,
  buildSmallScaleReport,
  compareFreezeToCurrent,
  completenessMatrixToCsv,
  completenessMatrixToMarkdown,
  createPaperFreeze,
  filterByManualReview,
  generateMissingOnlyRerunPlan,
  normalizeSmallScaleSettings,
  upsertManualReview,
} = require("../dist/features/SmallScale.js");

function resultRecord(experimentId, metrics = { DSC: { value: 0.9 } }, extra = {}) {
  return {
    schemaVersion: 1,
    resultId: `r_${experimentId}`,
    experimentId,
    runKey: `method-ours_dataset-VinDr_split-test_seed-${extra.seed || 42}`,
    suite: "smoke",
    experimentName: experimentId,
    status: "parsed",
    sourceFiles: [{ path: "metrics_summary.csv", type: "csv", endpoint: "local" }],
    metrics,
    dimensions: { method: "ours", dataset: "VinDr", split: "test", seed: extra.seed || 42 },
    primaryMetric: "DSC",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    provenance: {},
    ...extra,
  };
}

function gate(experimentId, status) {
  return { experimentId, gateId: "paper_gate", status, checkedAt: "2026-01-01T00:00:00Z", failedChecks: status === "failed" ? [{ checkType: "required_metric", severity: "critical", message: "missing DSC" }] : [] };
}

test("small scale settings force file registry and cap concurrency", () => {
  const settings = normalizeSmallScaleSettings({ scaleMode: "custom", maxConcurrentExperiments: 99, enableExternalDatabase: true, enableHeavyIndexing: true, useFileBasedRegistryOnly: false });
  assert.equal(settings.maxConcurrentExperiments, 10);
  assert.equal(settings.useFileBasedRegistryOnly, true);
  assert.equal(settings.enableExternalDatabase, false);
  assert.equal(settings.enableHeavyIndexing, false);
});

test("completeness matrix finds missing results and quality failures", () => {
  const plan = importLegacyPlanYamlToRegistry("experiments/plans/smoke.yaml", [
    "suite: smoke",
    "cases:",
    "  - name: method-ours_dataset-VinDr_split-test_seed-42",
    "  - name: method-ours_dataset-VinDr_split-test_seed-43",
    "  - name: method-ours_dataset-VinDr_split-test_seed-44",
  ].join("\n"));
  const results = [
    resultRecord(plan.plannedExperiments[0].experimentKey, { DSC: { value: 0.9 } }, { seed: 42 }),
    resultRecord(plan.plannedExperiments[1].experimentKey, {}, { seed: 43 }),
  ];
  const cells = buildCompletenessMatrix({
    id: "m",
    name: "matrix",
    scope: { planId: plan.planId },
    axes: ["method", "dataset", "split", "seed"],
    requiredMetrics: ["DSC"],
    requireQualityGatePassed: true,
  }, { plans: [plan], results, gateResults: [gate(results[0].experimentId, "passed"), gate(results[1].experimentId, "failed")], lifecycles: [{ experimentId: plan.plannedExperiments[2].experimentKey, status: "completed" }] });
  assert.equal(cells.some((cell) => cell.status === "ready_for_analysis"), true);
  assert.equal(cells.some((cell) => cell.status === "quality_failed"), true);
  assert.equal(cells.some((cell) => cell.status === "completed_no_result"), true);
  assert.match(completenessMatrixToMarkdown(cells), /ready_for_analysis/);
  assert.match(completenessMatrixToCsv(cells), /quality_failed/);
});

test("completeness matrix groups scoped results once and preserves result order", () => {
  const source = readSource("src/features/SmallScale.ts");
  const body = source.match(/export function buildCompletenessMatrix[\s\S]*?\n}\n\nexport function completenessMatrixToMarkdown/)?.[0] || "";
  assert.match(body, /const resultKeys = new Map<string, ExperimentResultRecord\[\]>/);
  assert.match(body, /const plannedItems = planKeys\.get\(key\)/);
  assert.match(body, /if \(plannedItems\) plannedItems\.push\(item\)/);
  assert.doesNotMatch(body, /planKeys\.set\(key, \[\.\.\.\(planKeys\.get\(key\)/);
  assert.match(body, /for \(const record of input\.results \|\| \[\]\)/);
  assert.match(body, /const records = resultKeys\.get\(key\) \|\| \[\]/);
  assert.doesNotMatch(body, /resultRows|\.filter\(\(row\) => row\.key === key\)/);

  const cells = buildCompletenessMatrix({
    id: "grouped",
    name: "grouped",
    scope: { suite: "keep" },
    axes: ["method"],
    requiredMetrics: [],
    requireQualityGatePassed: false,
  }, {
    results: [
      resultRecord("e2", {}, { resultId: "r2", suite: "keep", dimensions: { method: "ours" } }),
      resultRecord("e1", {}, { resultId: "r1", suite: "keep", dimensions: { method: "ours" } }),
      resultRecord("ignored", {}, { resultId: "ignored", suite: "drop", dimensions: { method: "ours" } }),
      resultRecord("e3", {}, { resultId: "r3", suite: "keep", runKey: "method-baseline_dataset-VinDr_split-test_seed-42", dimensions: { method: "baseline" } }),
    ],
  });
  assert.deepEqual(cells.map((cell) => [cell.key.method, cell.resultIds]), [
    ["baseline", ["r3"]],
    ["ours", ["r2", "r1"]],
  ]);
});

test("completeness matrix indexes gates and lifecycles without duplicate cell matches", () => {
  const source = readSource("src/features/SmallScale.ts");
  const body = source.match(/export function buildCompletenessMatrix[\s\S]*?\n}\n\nexport function completenessMatrixToMarkdown/)?.[0] || "";
  assert.match(body, /const gateResultsByExperiment = new Map/);
  assert.match(body, /const lifecyclesByExperiment = new Map/);
  assert.doesNotMatch(body, /\(input\.gateResults \|\| \[\]\)\.filter/);
  assert.doesNotMatch(body, /\(input\.lifecycles \|\| \[\]\)\.filter/);

  const repeated = resultRecord("e1", {}, { resultId: "r1", suite: "keep", dimensions: { method: "ours" } });
  const second = resultRecord("e2", {}, { resultId: "r2", suite: "keep", dimensions: { method: "ours" } });
  const cells = buildCompletenessMatrix({
    id: "indexed",
    name: "indexed",
    scope: { suite: "keep" },
    axes: ["method"],
    requiredMetrics: [],
    requireQualityGatePassed: false,
  }, {
    results: [repeated, { ...repeated, resultId: "r1-repeat" }, second],
    gateResults: [
      { ...gate("e2", "warning"), gateId: "second" },
      { ...gate("e1", "warning"), gateId: "first" },
      { ...gate("ignored", "warning"), gateId: "ignored" },
    ],
  });
  assert.deepEqual(cells[0].warnings, ["second: warning", "first: warning"]);

  const plan = importLegacyPlanYamlToRegistry("indexed.yaml", "suite: indexed\ncases:\n  - name: method-ours_seed-1\n");
  plan.plannedExperiments.push({ ...plan.plannedExperiments[0] });
  const lifecycleCells = buildCompletenessMatrix({
    id: "lifecycle-indexed",
    name: "lifecycle-indexed",
    scope: { planId: plan.planId },
    axes: ["method"],
    requiredMetrics: [],
    requireQualityGatePassed: false,
  }, {
    plans: [plan],
    lifecycles: [
      { experimentId: "ignored", status: "completed" },
      { experimentId: plan.plannedExperiments[0].experimentKey, status: "running" },
    ],
  });
  assert.equal(lifecycleCells[0].status, "running");
});

test("pre-run and post-run checklists expose blocking and warning items", () => {
  const plan = importLegacyPlanYamlToRegistry("p.yaml", "suite: s\ncases:\n  - name: a\n");
  plan.experimentCount = 12;
  const pre = buildPreRunChecklist(plan, { planValidationStatus: "failed", datasetPathsOk: false, outputContractOk: false, diskEnough: false, lockedResultIds: ["r1"] });
  assert.equal(pre.status, "failed");
  assert.equal(pre.items.some((item) => item.id === "small_scale_limit" && item.status === "warning"), true);
  const post = buildPostRunChecklist(resultRecord("e1", { DSC: { value: Number.NaN } }), { files: { "train.log": "Traceback OOM" }, gate: gate("e1", "failed"), statisticsUpdated: false, paperTableUpdated: false });
  assert.equal(post.status, "failed");
  assert.equal(post.items.some((item) => item.id === "train_log_errors" && item.status === "warning"), true);
  const cleanPost = buildPostRunChecklist(resultRecord("e2", { DSC: { value: 0.9 } }), { files: { "metrics_summary.csv": "x", "metrics_case.csv": "x", "checkpoint_manifest.json": "{}" }, gate: gate("e2", "passed") });
  assert.equal(cleanPost.items.find((item) => item.id === "finite_metrics").status, "ok");
});

test("missing-only rerun plan generates only selected missing cells", () => {
  const cells = [
    { key: { method: "ours", seed: 1 }, status: "ready_for_analysis", experimentIds: ["e1"], resultIds: ["r1"] },
    { key: { method: "ours", seed: 2 }, status: "completed_no_result", experimentIds: ["e2"], resultIds: [] },
    { key: { method: "ours", seed: 3 }, status: "quality_failed", experimentIds: ["e3"], resultIds: ["r3"] },
  ];
  const plan = generateMissingOnlyRerunPlan(cells, { sourcePlanId: "p1", missingTypes: ["completed_no_result"], skipLockedResults: true, keepSameSeed: true, keepSameSplit: true, generateNewAttemptId: true });
  assert.equal(plan.experimentCount, 1);
  assert.equal(plan.provenance.parentPlanId, "p1");
});

test("manual review filters paper-ready records without overwriting state", () => {
  let reviews = [];
  reviews = upsertManualReview(reviews, { targetType: "result", targetId: "r1", state: "paper_ready", reason: "checked" });
  reviews = upsertManualReview(reviews, { targetType: "result", targetId: "r2", state: "do_not_use", reason: "bad" });
  const records = [{ resultId: "r1" }, { resultId: "r2" }, { resultId: "r3" }];
  assert.deepEqual(filterByManualReview(records, reviews, "paper_ready_only").map((r) => r.resultId), ["r1"]);
  assert.deepEqual(filterByManualReview(records, reviews, "exclude_do_not_use").map((r) => r.resultId), ["r1", "r3"]);
});

test("paper freeze preserves snapshot and detects current drift", () => {
  const freeze = createPaperFreeze({ studyId: "s1", resultIds: ["r1"], statisticalResultIds: ["st1"], label: "camera-ready", markdown: "|m|", latex: "\\begin{tabular}x\\end{tabular}" });
  assert.match(freeze.freezeId, /^freeze_/);
  assert.equal(compareFreezeToCurrent(freeze, { resultIds: ["r1"], statisticalResultIds: ["st1"], markdown: "|m|" }).changed, false);
  const drift = compareFreezeToCurrent(freeze, { resultIds: ["r1", "r2"], statisticalResultIds: ["st1"], markdown: "|new|" });
  assert.equal(drift.changed, true);
  assert.equal(drift.differences.includes("markdown changed"), true);
});

test("small-scale report summarizes missing actions", () => {
  const report = buildSmallScaleReport({
    id: "rep",
    scope: { suite: "smoke" },
    sections: ["overview", "completeness", "missing_items", "failed_experiments", "manual_review", "next_actions"],
  }, {
    results: [resultRecord("e1")],
    cells: [{ key: { seed: 1 }, status: "completed_no_result", experimentIds: ["e1"], resultIds: [] }],
    reviews: [{ targetType: "result", targetId: "r1", state: "paper_ready", reviewedAt: "2026-01-01T00:00:00Z" }],
  });
  assert.match(report.markdown, /Missing Items/);
  assert.match(report.csv, /missing,1/);
  assert.equal(JSON.parse(report.json).summary.missing, 1);
});

test("output capability matrix maps missing files and columns to disabled features", () => {
  const source = readSource("src/features/SmallScale.ts");
  const body = source.match(/export function buildOutputCapabilityMatrix[\s\S]*?\n}\n\nfunction completenessStatus/)?.[0] || "";
  assert.match(body, /const missingFileIds = new Set<string>\(\)/);
  assert.match(body, /const missingColumnNames = new Set<string>\(\)/);
  assert.match(body, /missingFileIds\.has\(id\)/);
  assert.match(body, /missingColumnNames\.has\(column\)/);
  assert.doesNotMatch(body, /report\.(?:files|columns)\.some\(/);

  const contract = builtInOutputContracts[0];
  const report = checkProjectOutputContract({ "metrics_summary.csv": "experiment_id,metric,value\nexp,DSC,0.9\n" }, contract);
  const caps = buildOutputCapabilityMatrix(report);
  const leaderboard = caps.find((cap) => cap.capability === "leaderboard");
  const caseLevel = caps.find((cap) => cap.capability === "case_level_analysis");
  assert.equal(leaderboard.status, "partial");
  assert.equal(leaderboard.missingColumns.includes("method"), true);
  assert.equal(caseLevel.status, "unavailable");
  assert.equal(caseLevel.missingFiles.includes("metrics_case"), true);
});
