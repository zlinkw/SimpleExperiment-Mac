const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("./_helpers/sourceReader");

const {
  COMPARISON_REGISTRY_PATH,
  addComparisonMethod,
  addReproductionDeviation,
  analyzeComparisonResults,
  builtInComparisonProtocols,
  builtInComparisonTemplates,
  checkFairness,
  createComparisonStudy,
  createReproductionRecord,
  deprecateComparisonStudy,
  exportComparisonReport,
  generateComparisonPlans,
  manualResultToRecord,
  updateReproductionChecklist,
  upsertComparisonStudies,
  validateComparisonProtocol,
} = require("../dist/features/Comparison.js");

function studyFixture() {
  let study = createComparisonStudy({
    name: "seg_baseline",
    taskType: "segmentation",
    comparisonType: "baseline_comparison",
    protocolId: "medical_segmentation_fair",
    resultSchemaId: "medical_segmentation",
    planSchemaId: "medical_segmentation_plan",
    datasets: [{ datasetId: "VinDr", name: "VinDr", preprocessing: "v1" }],
    splits: [{ splitId: "test", name: "test" }],
    seeds: [1, 2, 3],
    primaryMetrics: ["DSC"],
  });
  study = addComparisonMethod(study, { methodId: "baseline", name: "Baseline", role: "baseline", implementation: { type: "local_config", configPath: "configs/base.yaml" } });
  study = addComparisonMethod(study, { methodId: "ours", name: "Ours", role: "ours", implementation: { type: "local_config", configPath: "configs/ours.yaml" } });
  return study;
}

function result(methodId, seed, dsc, asd = 1) {
  return {
    schemaVersion: 1,
    resultId: `${methodId}-${seed}`,
    experimentId: `${methodId}-${seed}`,
    runKey: `seg_${methodId}_${seed}`,
    suite: "seg_baseline",
    experimentName: `${methodId} ${seed}`,
    status: "parsed",
    sourceFiles: [{ path: "results.csv", type: "csv", endpoint: "local" }],
    metrics: { DSC: { value: dsc, seed }, ASD: { value: asd, seed } },
    dimensions: { methodId, dataset: "VinDr", split: "test", seed },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    provenance: {},
  };
}

test("comparison registry creates studies and methods", () => {
  const study = studyFixture();
  const merged = upsertComparisonStudies([], [study]);
  assert.equal(COMPARISON_REGISTRY_PATH, "simple_cluster/comparisons/comparison_registry.json");
  assert.equal(merged[0].methods.length, 2);
  assert.equal(deprecateComparisonStudy(study).status, "deprecated");
  assert.equal(builtInComparisonTemplates.some((item) => item.id === "paper_reproduction_basic"), true);
});

test("protocol validation and fairness checker flag deviations", () => {
  const study = studyFixture();
  const protocol = builtInComparisonProtocols[0];
  const protocolResult = validateComparisonProtocol(study, protocol);
  assert.equal(protocolResult.status, "ok");
  let reproduction = createReproductionRecord(study.studyId, "baseline", { paperTitle: "Paper", reportedMetrics: { DSC: 0.88 } });
  reproduction = updateReproductionChecklist(reproduction, "official_code_checked", "matched");
  reproduction = addReproductionDeviation(reproduction, { severity: "major", category: "preprocessing", description: "Different resize", reason: "paper omitted exact code", expectedImpact: "moderate", reportedInPaperTable: false });
  const fairness = checkFairness(study, protocol, [result("baseline", 1, 0.8)], [reproduction]);
  assert.equal(fairness.status, "failed");
  assert.equal(fairness.issues.some((item) => item.category === "preprocessing"), true);
});

test("comparison plan generator creates linked plan records", () => {
  const study = studyFixture();
  const generated = generateComparisonPlans(study, { studyId: study.studyId, methods: ["baseline", "ours"], datasets: ["VinDr"], seeds: [1, 2], splits: ["test"], skipExistingCompleted: true, skipExistingRunning: true, createSeparatePlanPerMethod: true });
  assert.equal(generated.dryRun.experiments.length, 4);
  assert.equal(generated.plans.length, 2);
  assert.match(generated.plans[0].provenance.baseConfig, /configs\/base/);
});

test("comparison analyzer computes baseline improvement, lower better, paired test, and reproduction gap", () => {
  const study = studyFixture();
  const protocol = builtInComparisonProtocols[0];
  const records = [
    result("baseline", 1, 0.80, 2.0),
    result("baseline", 2, 0.82, 2.2),
    result("ours", 1, 0.90, 1.0),
    result("ours", 2, 0.92, 1.2),
  ];
  const reproduction = createReproductionRecord(study.studyId, "baseline", { reportedMetrics: { DSC: 0.85 } });
  const analysis = analyzeComparisonResults(study, protocol, records, [], [reproduction]);
  assert.equal(analysis.leaderboard.length, 2);
  assert.equal(analysis.baselineImprovements.some((item) => item.methodId === "ours" && item.metric === "DSC" && item.absoluteDiff > 0), true);
  assert.equal(analysis.baselineImprovements.some((item) => item.methodId === "ours" && item.metric === "ASD" && item.absoluteDiff < 0 && item.higherIsBetter === false), true);
  assert.equal(analysis.significance.some((item) => item.test === "paired_t_test"), true);
  assert.equal(analysis.reproductionGap[0].gap < 0, true);
});

test("comparison paired values build both method maps in one row traversal", () => {
  const source = readSource("src/features/Comparison.ts");
  const body = source.match(/function pairedValues[\s\S]*?\n}\n\nfunction pairedTTest/)?.[0] || "";
  assert.match(body, /for \(const row of rows\)/);
  assert.match(body, /row\.methodId === a \? amap : row\.methodId === b \? bmap/);
  assert.match(body, /for \(const \[key, value\] of amap\)/);
  assert.doesNotMatch(body, /rows\.filter\(/);
  assert.doesNotMatch(body, /Array\.from\(amap\.entries\(\)\)\.filter/);
});

test("manual paper result stays separate unless included and report exports all formats", () => {
  const study = studyFixture();
  const protocol = builtInComparisonProtocols[0];
  const manual = { studyId: study.studyId, methodId: "baseline", dataset: "VinDr", split: "test", seed: 1, metric: "DSC", value: 0.88, source: "paper", citation: "Paper", includeInFairStats: false };
  const manualRecord = manualResultToRecord(manual);
  assert.equal(manualRecord.sourceFiles[0].type, "manual");
  const analysis = analyzeComparisonResults(study, protocol, [result("ours", 1, 0.9)], [manual], []);
  assert.equal(analysis.warnings.some((item) => item.includes("manual result excluded")), true);
  const fairness = checkFairness(study, protocol, [result("ours", 1, 0.9)], []);
  const cfg = { id: "r", studyId: study.studyId, sections: ["overview", "protocol", "methods", "datasets", "fairness", "main_table", "statistics", "reproduction_gap", "notes"], exportFormats: ["markdown", "json", "csv", "latex"], includeAcceptedWarnings: true, includeFailedExperiments: true };
  assert.match(exportComparisonReport(study, protocol, analysis, fairness, [], cfg, "markdown"), /# seg_baseline/);
  assert.match(exportComparisonReport(study, protocol, analysis, fairness, [], cfg, "latex"), /\\begin\{tabular\}/);
  assert.match(exportComparisonReport(study, protocol, analysis, fairness, [], cfg, "csv"), /methodId,count/);
  assert.equal(JSON.parse(exportComparisonReport(study, protocol, analysis, fairness, [], cfg, "json")).study.studyId, study.studyId);
});
