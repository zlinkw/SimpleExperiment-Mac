const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} missing`);
  const brace = panel.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < panel.length; i += 1) {
    if (panel[i] === "{") depth += 1;
    if (panel[i] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, i + 1);
  }
  throw new Error(`${name} incomplete`);
}

function loadResultWorkflowStage() {
  const sandbox = {
    meaningfulValue(value) {
      const text = String(value === undefined || value === null ? "" : value).trim();
      return text && text !== "-" ? text : "";
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("resultWorkflowStage")}\n${extractFunction("zeroResultOutputContractStage")}\nthis.stage = resultWorkflowStage;`, sandbox);
  return sandbox.stage;
}

function loadLatestOutputContractCheck() {
  const sandbox = {
    operationRowsForState: (state) => state.operations || [],
    samePlanSelection: (left, right) => String(left || "") === String(right || ""),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("operationMatchesPlanVersion")}\n${extractFunction("latestResultOutputContractCheck")}\nthis.latest = latestResultOutputContractCheck;`, sandbox);
  return sandbox.latest;
}

function loadResultSummaryNeedsOutputContractRecovery() {
  const sandbox = {
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
    asArray(value) { return Array.isArray(value) ? value : []; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("resultSummaryNeedsOutputContractRecovery")}\nthis.needs = resultSummaryNeedsOutputContractRecovery;`, sandbox);
  return sandbox.needs;
}

function loadOutputContractStageForCheck() {
  const sandbox = {
    meaningfulValue(value) {
      const text = String(value === undefined || value === null ? "" : value).trim();
      return text && text !== "-" ? text : "";
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("zeroResultOutputContractStage")}\n${extractFunction("outputContractStageForCheck")}\nthis.stage = outputContractStageForCheck;`, sandbox);
  return sandbox.stage;
}

test("result workbench follows preview, archive, and final-analysis order", () => {
  const stage = loadResultWorkflowStage();
  assert.equal(stage({}).command, "parseResults");
  const waitingRun = stage({ autoParseStatus: "waiting-run", planFile: "experiments/plans/demo.yaml", parsedRows: 4 });
  assert.equal(waitingRun.kind, "await-run");
  assert.match(waitingRun.message, /自动解析已跳过/);
  assert.equal(stage({ autoParseStatus: "run-evidence" }).command, "parseResults");
  assert.match(stage({ autoParseStatus: "run-evidence" }).message, /当前版本运行记录/);
  assert.equal(stage({ autoParseStatus: "no-plan" }).section, "plans");
  assert.equal(stage({ parsed: true, previewResultCount: 0 }).command, "checkOutputContract");
  assert.match(stage({ parsed: true, previewResultCount: 0 }).message, /未发现结果记录/);
  assert.equal(stage({ parsed: true, outputContractStatus: "running" }).section, "execution");
  const missing = stage({ parsed: true, outputContractStatus: "failed", outputContractMissingFiles: "metrics_summary.csv、env_snapshot.json" });
  assert.equal(missing.section, "plans");
  assert.match(missing.message, /metrics_summary\.csv/);
  const unparseable = stage({ parsed: true, outputContractStatus: "failed", outputContractUnparseableFiles: "work_dirs/run/metrics_summary.csv" });
  assert.equal(unparseable.section, "plans");
  assert.match(unparseable.message, /结果文件不可解析/);
  assert.equal(stage({ parsed: true, outputContractStatus: "completed" }).command, "parseResults");
  assert.equal(stage({ parsed: true, previewResultCount: 2 }).kind, "review");
  assert.equal(stage({ parsed: true, previewResultCount: 2 }).count, 2);
  assert.equal(stage({ parsed: true, archivableCount: 2 }).kind, "archive");
  assert.equal(stage({ parsed: true, archiveBlockedCount: 1 }).kind, "archive-blocked");
  assert.equal(stage({ parsed: true, pendingReviewCount: 3 }).kind, "review");
  assert.equal(stage({ parsed: true, effectiveArchivedResultCount: 1, pendingReviewCount: 2, archivableCount: 2 }).command, "runQualityGate");
  assert.equal(stage({ parsed: true, qualityGatePath: "quality.json", effectiveArchivedResultCount: 1, pendingReviewCount: 2, archivableCount: 2 }).command, "runStatistics");
  assert.equal(stage({ parsed: true, qualityGatePath: "quality.json", effectiveArchivedResultCount: 1, statisticsPath: "statistics.json", claimStatus: "待检查" }).command, "checkClaimEvidence");
  const missingClaim = stage({ parsed: true, qualityGatePath: "quality.json", effectiveArchivedResultCount: 1, statisticsPath: "statistics.json", claimStatus: "unsupported", claimIssueCount: 2 });
  assert.equal(missingClaim.command, "openPlan");
  assert.equal(missingClaim.file, "paper/claims.md");
  assert.equal(stage({ parsed: true, qualityGatePath: "quality.json", effectiveArchivedResultCount: 1, statisticsPath: "statistics.json", claimStatus: "supported" }).command, "exportPaperTable");
  assert.equal(stage({ parsed: true, qualityGatePath: "quality.json", effectiveArchivedResultCount: 1, statisticsPath: "statistics.json", claimStatus: "supported", paperTablePath: "table.csv" }).command, "exportPlottingContract");
  assert.equal(stage({ parsed: true, qualityGatePath: "quality.json", effectiveArchivedResultCount: 1, statisticsPath: "statistics.json", claimStatus: "supported", paperTablePath: "table.csv", plottingContractPath: "plotting.json" }).command, "plotResultsToPpt");
  assert.match(panel, /function renderResultNextAction\(/);
  assert.match(panel, /尚未生成结果摘要[\s\S]{0,100}"parseResults"/);
  assert.match(panel, /解析已完成，但未发现结果记录[\s\S]{0,120}"checkOutputContract"/);
  assert.match(panel, /正在检查输出契约[\s\S]{0,180}"execution"/);
  assert.match(panel, /输出契约缺失：[\s\S]{0,220}"plans"/);
  assert.match(panel, /输出契约完整，重新读取结果文件[\s\S]{0,160}"parseResults"/);
  assert.match(panel, /previewResultCount: pick\(item, \["previewResultCount", "preview_result_count", "resultCount", "result_count"\]/);
  assert.match(panel, /\["预览条数", String\(previewResultCount\)/);
  assert.match(panel, /已归档 [\s\S]{0,180}条未纳入[\s\S]{0,180}"runQualityGate"/);
  assert.match(panel, /结果已归档，等待最终统计[\s\S]{0,100}"runStatistics"/);
  assert.match(panel, /统计已完成，等待证据检查[\s\S]{0,180}"checkClaimEvidence"/);
  assert.match(panel, /论文声明仍有 [\s\S]{0,160}项缺失证据[\s\S]{0,180}"paper\/claims\.md"/);
  assert.match(panel, /证据检查已完成[\s\S]{0,100}"exportPaperTable"/);
  assert.match(panel, /论文表格已生成，等待 PPT 绘图契约[\s\S]{0,120}"exportPlottingContract"/);
  assert.match(panel, /结果证据与绘图契约均已完成[\s\S]{0,120}"plotResultsToPpt"/);
  assert.match(panel, /projectNextAction\(stage\.message, stage\.label, stage\.command, \{ file: stage\.file, planFile: stage\.planFile \}\)/);
  assert.match(panel, /results: \[\["解析结果", "parseResults"\][\s\S]*\["绘图到 PPT", "plotResultsToPpt"\]\]/);
});

test("runtime contract repair disappears after results become available", () => {
  const needs = loadResultSummaryNeedsOutputContractRecovery();
  assert.equal(needs({}), false);
  assert.equal(needs({ lastParsedAt: "2026-07-17T02:00:00.000Z", previewResultCount: 0 }), true);
  assert.equal(needs({ lastParsedAt: "2026-07-17T02:00:00.000Z", previewResultCount: 1 }), false);
  assert.equal(needs({ lastParsedAt: "2026-07-17T02:00:00.000Z", effectiveArchivedResultCount: 1 }), false);
});

test("zero-result Plan workbench starts contract diagnosis before a check operation exists", () => {
  const stage = loadOutputContractStageForCheck();
  assert.equal(stage({}).command, "checkOutputContract");
  assert.equal(stage({ status: "running" }).section, "execution");
  assert.equal(stage({ status: "failed", missingFiles: "metrics_summary.csv" }).section, "plans");
});
