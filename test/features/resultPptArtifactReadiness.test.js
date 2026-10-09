const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function loadArtifactHelper() {
  const sandbox = {
    asArray: (value) => Array.isArray(value) ? value : [],
    operationRowsForState: (state) => state.operations || [],
    operationSucceeded: (row) => String((row || {}).status || "").toLowerCase() === "completed",
    samePlanSelection: (left, right) => String(left || "").toLowerCase() === String(right || "").toLowerCase(),
    planFromContext(state, context) {
      return (state.plans || []).find((plan) => String(plan.planFile || plan.file || "").toLowerCase() === String(context.planFile || "").toLowerCase());
    },
    meaningfulValue(value) {
      const text = String(value === undefined || value === null ? "" : value).trim();
      return text && text !== "-" ? text : "";
    },
    pick(item, keys, fallback) {
      for (const key of keys) {
        if (item && item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
      }
      return fallback;
    },
    RESULT_ANALYSIS_ARTIFACT_FIELDS: Object.freeze({
      "export-plotting-contract": "plottingContractPath",
      "parse-case-level": "caseLevelPath",
      "recover-plan-from-run": "recoveredPlanReportPath",
      "diagnose-result-anomaly": "anomalyPath",
    }),
    PLAN_VERSION_ROWS_CACHE_LIMIT: 64,
    planVersionRowsCacheState: null,
    planVersionOperationRowsCache: new Map(),
    planVersionTaskRowsCache: new Map(),
    resultAnalysisArtifactsCacheState: null,
    resultAnalysisArtifactsCacheSummary: null,
    resultAnalysisArtifactsCacheValue: null,
    normalizePlanSelectionKey: (value) => String(value || "").toLowerCase(),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("operationMatchesPlanVersion"),
    extractFunction("resultSummaryMatchesPlanVersion"),
    extractFunction("ensurePlanVersionRowsCache"),
    extractFunction("planVersionRowsCacheKey"),
    extractFunction("cachePlanVersionRows"),
    extractFunction("planVersionOperationRows"),
    extractFunction("latestResultAnalysisArtifactPaths"),
    extractFunction("resultAnalysisArtifactsForState"),
    "this.check = resultAnalysisArtifactsForState;",
  ].join("\n"), sandbox);
  return sandbox.check;
}

test("PPT artifact readiness keeps successful analysis paths scoped to current Plan", () => {
  const artifacts = loadArtifactHelper()({
    planFileInput: "experiments/plans/current.yaml",
    operations: [
      { type: "parse-case-level", status: "completed", planFile: "experiments/plans/other.yaml", caseLevelPath: "other/case.json" },
      { type: "parse-case-level", status: "completed", planFile: "experiments/plans/current.yaml", caseLevelPath: "current/case.json" },
      { type: "diagnose-result-anomaly", status: "failed", planFile: "experiments/plans/current.yaml", anomalyPath: "current/failed.json" },
      { type: "recover-plan-from-run", status: "completed", planFile: "experiments/plans/current.yaml", recoveredPlanReportPath: "current/recovered.md" },
    ],
  }, {
    planFile: "experiments/plans/current.yaml",
    plottingContractPath: "current/plotting_contract.json",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(artifacts)), {
    plottingContractPath: "current/plotting_contract.json",
    caseLevelPath: "current/case.json",
    recoveredPlanReportPath: "current/recovered.md",
    anomalyPath: "",
  });

  const staleSummary = loadArtifactHelper()({
    planFileInput: "experiments/plans/current.yaml",
    operations: [],
  }, {
    planFile: "experiments/plans/other.yaml",
    plottingContractPath: "other/plotting_contract.json",
  });
  assert.equal(staleSummary.plottingContractPath, "");
});

test("PPT artifact readiness ignores paths from an older revision of the same Plan", () => {
  const state = {
    planFileInput: "experiments/plans/current.yaml",
    plans: [{ planFile: "experiments/plans/current.yaml", revision: "rev-current", updatedAt: "2026-07-18T10:00:00.000Z" }],
    operations: [
      { type: "parse-case-level", status: "completed", planFile: "experiments/plans/current.yaml", planRevision: "rev-old", updatedAt: "2026-07-18T11:00:00.000Z", caseLevelPath: "old/case.json" },
      { type: "recover-plan-from-run", status: "completed", planFile: "experiments/plans/current.yaml", updatedAt: "2026-07-18T09:00:00.000Z", recoveredPlanReportPath: "old/recovered.md" },
      { type: "diagnose-result-anomaly", status: "completed", planFile: "experiments/plans/current.yaml", planRevision: "rev-current", updatedAt: "2026-07-18T11:00:00.000Z", anomalyPath: "current/anomaly.json" },
    ],
  };
  const artifacts = loadArtifactHelper()(state, {
    planFile: "experiments/plans/current.yaml",
    planRevision: "rev-old",
    lastParsedAt: "2026-07-18T11:00:00.000Z",
    plottingContractPath: "old/plotting.json",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(artifacts)), {
    plottingContractPath: "",
    caseLevelPath: "",
    recoveredPlanReportPath: "",
    anomalyPath: "current/anomaly.json",
  });
});

test("result workbench disables unproven PPT sources and refreshes on artifact changes", () => {
  assert.match(panel, /const pptTone = pptReady \? "good" : "warn"/);
  assert.match(panel, /evidencePlanRow\("PPT 绘图", pptTone, pptStatus, pptItems\)/);
  assert.match(panel, /pptPlotButton\("样本级结果", analysisArtifacts\.caseLevelPath/);
  assert.match(panel, /pptPlotButton\("恢复报告页", analysisArtifacts\.recoveredPlanReportPath/);
  assert.match(panel, /unavailableReason \|\| "请先归档结果并运行统计"/);
  assert.match(panel, /请先导出 PPT 绘图契约/);
  assert.match(panel, /请先运行样本级解析/);
  assert.match(panel, /resultEvidenceWorkbenchCacheKeyFor\(summary, traceStats, outputContractCheck, analysisArtifacts, autoParseReadiness\)/);
  assert.match(panel, /analysisArtifacts,\s*\n\s*autoParseReadiness\s*\n\s*\}\);/);
  assert.match(panel, /caseLevelPath: pick\(row,[\s\S]{0,180}payload\.caseLevel/);
  assert.match(panel, /recoveredPlanReportPath: pick\(row/);
  assert.match(panel, /anomalyPath: pick\(row/);
  assert.doesNotMatch(panel, /pptPlotButton\([^\n]+(?:plotting_contract|case_level_index|anomaly\/latest|recovered\/latest)[^\n]+/);
});

test("analysis artifact extraction scans operation rows once", () => {
  const helper = extractFunction("latestResultAnalysisArtifactPaths");
  assert.match(helper, /for \(const row of asArray\(rows\)\)/);
  assert.doesNotMatch(helper, /\.find\(/);
  assert.doesNotMatch(panel, /function latestResultAnalysisArtifactPath\(/);
});

test("analysis artifact derivation reuses state and summary references", () => {
  const artifacts = loadArtifactHelper();
  const state = { planFileInput: "experiments/plans/current.yaml", operations: [] };
  const summary = { planFile: "experiments/plans/current.yaml", plottingContractPath: "current/plotting.json" };
  const first = artifacts(state, summary);
  assert.equal(artifacts(state, summary), first);
  assert.notEqual(artifacts({ ...state }, summary), first);
  assert.notEqual(artifacts(state, { ...summary }), first);
});
