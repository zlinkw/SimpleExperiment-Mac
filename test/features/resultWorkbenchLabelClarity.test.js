const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("result workbench uses clear Chinese entry labels while retaining source identifiers", () => {
  assert.match(panel, /id="results-dataset"[\s\S]{0,160}title="CSV\/split\/leakage">数据集画像<\/a>/);
  assert.match(panel, /id="results-checkpoints"[\s\S]{0,160}title="dry-run\/retention">检查点清理预案<\/a>/);
  assert.match(panel, /id="results-plotting"[\s\S]{0,180}title="registry\/statistics\/table">PPT 绘图契约<\/a>/);
  assert.match(panel, /treeObjectItem\("results", "数据集画像"/);
  assert.match(panel, /treeObjectItem\("results", "检查点清理预案"/);
  assert.match(panel, /pptPlotButton\("统计结果", statisticsSourcePath, "statistics"/);
  assert.match(panel, /pptPlotButton\("论文表格", paperTableSourcePath, "paper table"/);
  assert.match(panel, /pptPlotButton\("样本级结果", analysisArtifacts\.caseLevelPath, "case_level"/);
  assert.match(panel, /pptPlotButton\("异常原因", analysisArtifacts\.anomalyPath, "root cause\/storyline"/);
  assert.match(panel, /\["论文声明", String\(claimCount\)/);
  assert.doesNotMatch(panel, /<b>Dataset 画像<\/b>/);
  assert.doesNotMatch(panel, /<b>Checkpoint 预案<\/b>/);
});
