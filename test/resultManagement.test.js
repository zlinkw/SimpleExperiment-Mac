const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMetricsFile } = require("../dist/features/Metrics.js");

const {
  builtInResultPresets,
  buildResultLeaderboard,
  defaultValidationRules,
  exportPaperTable,
  leaderboardToCsv,
  parseResultFile,
  previewResultParse,
  readResultConfigJson,
  upsertExperimentResults,
  validateResultRecords,
} = require("../dist/features/Results.js");

test("results parser supports standard long CSV", () => {
  const csv = [
    "experiment_id,attempt_id,suite,run_key,dataset,split,fold,seed,metric,value,unit,higher_is_better,step,epoch,timestamp",
    "exp_001,attempt_001,smoke,2_fusion,VinDr,test,0,42,DSC,0.876,,true,final,200,2026-06-30T12:00:00Z",
    "exp_001,attempt_001,smoke,2_fusion,VinDr,test,0,42,ASD,1.42,mm,false,final,200,2026-06-30T12:00:00Z",
  ].join("\n");
  const preset = builtInResultPresets.find((item) => item.id === "medical_segmentation_long_csv");
  const preview = previewResultParse(csv, "results.csv", preset);
  const records = parseResultFile(csv, { path: "results.csv", type: "csv", endpoint: "local" }, preset);
  assert.equal(preview.records, 1);
  assert.equal(records[0].metrics.DSC.value, 0.876);
  assert.equal(records[0].metrics.ASD.higherIsBetter, false);
});

test("result parser skips invalid metric inputs and reports preview warnings", () => {
  const preset = builtInResultPresets.find((item) => item.id === "generic_metric_long_csv");
  const csv = [
    "experiment_id,run_key,metric,value,step",
    "e1,r1,AUC,0.91,final",
    "e1,r1,,0.8,final",
    "e1,r1,loss,,final",
    "e1,r1,F1,NaN,final",
    "e1,r1,precision,Infinity,final",
  ].join("\n");
  const records = parseResultFile(csv, { path: "results.csv", type: "csv", endpoint: "local" }, preset);
  const preview = previewResultParse(csv, "results.csv", preset);
  assert.deepEqual(Object.keys(records[0].metrics), ["AUC"]);
  assert.match(preview.warnings.join(" "), /已跳过 1 行空指标名/);
  assert.match(preview.warnings.join(" "), /已跳过 3 行空值或非有限数值指标/);

  const widePreset = builtInResultPresets.find((item) => item.id === "medical_segmentation_wide_csv");
  const wide = parseResultFile("experiment_id,DSC,HD95\ne2,0.8,NaN\n", { path: "wide.csv", type: "csv", endpoint: "local" }, widePreset, { metricColumns: ["DSC", "HD95"] });
  assert.deepEqual(Object.keys(wide[0].metrics), ["DSC"]);
});

test("compatibility metrics parser excludes blank null boolean and non-finite values", () => {
  const csvRows = parseMetricsFile("runKey,experimentId,DSC,HD95\nr1,e1,,NaN\nr2,e2,0.8,Infinity\n", "results.csv");
  assert.deepEqual(csvRows[0].metrics, {});
  assert.deepEqual(csvRows[1].metrics, { DSC: 0.8 });
  const [jsonRow] = parseMetricsFile(JSON.stringify({ experimentId: "e3", metrics: { blank: "", missing: null, flag: true, AUC: "0.91" } }), "results.json");
  assert.deepEqual(jsonRow.metrics, { AUC: 0.91 });
});

test("results parser supports standard wide CSV and custom metric columns", () => {
  const csv = [
    "experiment_id,attempt_id,suite,run_key,dataset,split,fold,seed,DSC,ASD,HD95,AUC,accuracy,loss,epoch,timestamp",
    "exp_001,attempt_001,smoke,2_fusion,VinDr,test,0,42,0.876,1.42,8.31,0.932,0.881,0.12,200,2026-06-30T12:00:00Z",
  ].join("\n");
  const preset = builtInResultPresets.find((item) => item.id === "medical_segmentation_wide_csv");
  const records = parseResultFile(csv, { path: "wide.csv", type: "csv", endpoint: "local" }, preset, { metricColumns: ["DSC", "ASD", "HD95"] });
  assert.equal(records.length, 1);
  assert.equal(records[0].metrics.HD95.value, 8.31);
  assert.equal(records[0].dimensions.dataset, "VinDr");
});

test("custom column mapping and dimensions work", () => {
  const csv = "id,run,site,m,score\nexp,a,VinDr,DSC,0.9\n";
  const preset = { ...builtInResultPresets.find((item) => item.id === "generic_metric_long_csv"), columnMapping: { experimentId: "id", runKey: "run", metric: "m", value: "score", dataset: "site" } };
  const records = parseResultFile(csv, { path: "custom.csv", type: "csv", endpoint: "local" }, preset, { dimensions: [{ key: "method", label: "Method", type: "category", source: { type: "regex_from_path", pattern: "(custom)" } }] });
  assert.equal(records[0].experimentId, "exp");
  assert.equal(records[0].dimensions.method, "custom");
});

test("validation rules keep bad results but emit warnings", () => {
  const csv = "experiment_id,suite,run_key,metric,value,step\nexp,s,r,DSC,1.2,final\n";
  const records = parseResultFile(csv, { path: "bad.csv", type: "csv", endpoint: "local" }, builtInResultPresets[0]);
  const issues = validateResultRecords(records, defaultValidationRules);
  assert.equal(records[0].status, "parsed");
  assert.equal(issues.some((item) => item.metric === "DSC"), true);
});

test("registry upsert preserves createdAt and updates values", () => {
  const first = parseResultFile("experiment_id,suite,run_key,metric,value,step\ne,s,r,DSC,0.8,final\n", { path: "a.csv", type: "csv", endpoint: "local" }, builtInResultPresets[0]);
  const second = parseResultFile("experiment_id,suite,run_key,metric,value,step\ne,s,r,DSC,0.9,final\n", { path: "a.csv", type: "csv", endpoint: "local" }, builtInResultPresets[0]);
  const merged = upsertExperimentResults(first, second);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].metrics.DSC.value, 0.9);
  assert.equal(merged[0].createdAt, first[0].createdAt);
});

test("leaderboard aggregates mean/std and exports markdown/csv/latex with lower-is-better", () => {
  const csv = [
    "experiment_id,suite,run_key,dataset,metric,value,step",
    "e1,s,m1,VinDr,DSC,0.8,final",
    "e2,s,m1,VinDr,DSC,0.9,final",
    "e3,s,m2,VinDr,ASD,2,final",
    "e4,s,m3,VinDr,ASD,1,final",
  ].join("\n");
  const records = parseResultFile(csv, { path: "long.csv", type: "csv", endpoint: "local" }, builtInResultPresets[0]);
  const config = { id: "lb", name: "LB", filter: { includeWarnings: true }, groupBy: ["runKey"], metrics: [{ key: "DSC", higherIsBetter: true, decimals: 3 }, { key: "ASD", higherIsBetter: false, decimals: 2 }], aggregate: "mean_std", primarySortMetric: "DSC" };
  const rows = buildResultLeaderboard(records, config, []);
  assert.ok(rows.find((row) => row.groupKey === "m1").values.DSC.mean > 0.84);
  assert.match(leaderboardToCsv(rows, config), /group,count/);
  assert.match(exportPaperTable(rows, config, { id: "t", title: "T", leaderboardId: "lb", rowDimension: "runKey", metrics: ["DSC", "ASD"], boldBest: true, showMeanStd: true, decimals: { DSC: 3, ASD: 2 }, metricDisplayNames: {} }, "latex_booktabs"), /\\toprule/);
});

test("broken result config keeps lastKnownGood", () => {
  const last = [{ id: "generic_metric_long_csv" }];
  const result = readResultConfigJson("{broken", (value) => Array.isArray(value), last);
  assert.equal(result.ok, false);
  assert.equal(result.value, last);
});
