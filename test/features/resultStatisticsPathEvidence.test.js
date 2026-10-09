const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("statistics stage requires artifact path instead of timestamp-only evidence", () => {
  assert.match(panel, /statisticsPath: pick\(item, \["statisticsPath", "statistics_path"\]/);
  assert.match(panel, /const statisticsReady = Boolean\(meaningfulValue\(statisticsPath\)\) && effectiveArchivedResultCount > 0 && Number\(statisticsResultCount\) === effectiveArchivedResultCount/);
  assert.match(panel, /statisticsResultCount: pick\(item, \["statisticsResultCount", "statistics_result_count"\]/);
  assert.match(panel, /renderResultNextAction\(\{ parsed, parsedRows, qualityGatePath: qualityReady \? qualityGatePath : "", statisticsPath: statisticsReady \? statisticsPath : ""/);
  assert.match(panel, /!meaningfulValue\(status\.statisticsPath\)[\s\S]{0,150}等待最终统计[\s\S]{0,80}"runStatistics"/);
  assert.doesNotMatch(panel, /!meaningfulValue\(status\.statisticsUpdatedAt\)[\s\S]{0,150}"runStatistics"/);
  assert.match(panel, /\["统计文件", compactPath\(statisticsPath\), statisticsPath\]/);
});
