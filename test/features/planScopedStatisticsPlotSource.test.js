const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("all primary statistics plot entries share the selected plan source", () => {
  assert.match(panel, /pptPlotButton\("统计绘图", statisticsSourcePath, "SCI 统计"/);
  assert.match(panel, /pptPlotButton\("均值绘图", statisticsSourcePath, "SCI 聚合统计"/);
  assert.match(panel, /pptPlotButton\("统计结果", statisticsSourcePath, "statistics"/);
  assert.match(panel, /statisticsSourcePath = statisticsReady \? meaningfulValue\(statisticsPath\) : ""/);
  assert.match(panel, /unavailable = Boolean\(debugReason \|\| !source \|\| !automation\.ready\)/);
  assert.match(panel, /pptPlotButton\("聚合绘图", traceStatisticsSourcePath/);
  assert.match(panel, /pptPlotButton\("论文表格", paperTableSourcePath/);
  assert.doesNotMatch(panel, /pptPlotButton\([^\n]*"simple_cluster\/results\/statistics\.json"/);
});
