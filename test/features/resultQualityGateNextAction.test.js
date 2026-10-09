const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("result next action requires persisted quality gate evidence before statistics", () => {
  assert.match(panel, /qualityGatePath: pick\(item, \["qualityGatePath", "quality_gate_path"\]/);
  assert.match(panel, /qualityGateResultCount: pick\(item, \["qualityGateResultCount", "quality_gate_result_count"\]/);
  assert.match(panel, /renderResultNextAction\(\{ parsed, parsedRows, qualityGatePath: qualityReady \? qualityGatePath : "", statisticsPath:/);
  assert.match(panel, /archivedCount <= 0[\s\S]{0,700}!meaningfulValue\(status\.qualityGatePath\)[\s\S]{0,220}检查已归档结果[\s\S]{0,80}"runQualityGate"/);
  assert.match(panel, /qualityReady \? \(hasWarningValue\(qualityWarnings\) \? "有警告" : "已检查"\) : "待质量门禁"/);
  assert.match(panel, /\["质量报告", compactPath\(qualityGatePath\), qualityGatePath\]/);
  assert.match(panel, /const qualityReady = Boolean\(meaningfulValue\(qualityGatePath\)\) && effectiveArchivedResultCount > 0 && Number\(qualityGateResultCount\) === effectiveArchivedResultCount/);
});
