const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("webview state exposes realtime fields as first class fields", () => {
  const source = readSource("src/extension.ts");
  for (const field of ["gpu", "schedulerStates", "experimentTraces", "logs", "operations", "fileTransfers"]) {
    assert.match(source, new RegExp(`\\b${field}\\b`), field);
  }
  assert.match(source, /const realtimeState: RealtimeState/);
  assert.match(source, /offlineSnapshot/);
  assert.match(source, /compactDiagnostics/);
  assert.match(source, /bulkOmitted/);
  assert.match(source, /实时大字段已在 state 顶层提供/);
  const diagnosticsBlock = source.match(/private compactDiagnostics[\s\S]*?private postState/)?.[0] || "";
  assert.doesNotMatch(diagnosticsBlock, /\bgpu,\s*\n/);
  assert.doesNotMatch(diagnosticsBlock, /\bschedulerStates,\s*\n/);
  assert.doesNotMatch(diagnosticsBlock, /\bexperimentTraces,\s*\n/);
  assert.doesNotMatch(diagnosticsBlock, /\bfileTransfers,\s*\n/);
  assert.doesNotMatch(source, /lastKnownGood\.fileTransfers/);
});

test("webview state sends compact lastKnownGood instead of duplicating bulk realtime fields", () => {
  const source = readSource("src/extension.ts");
  const block = source.match(/private compactLastKnownGood[\s\S]*?private compactDiagnostics/)?.[0] || "";
  assert.match(block, /gpuServers/);
  assert.match(block, /schedulerRows/);
  assert.match(block, /experimentTraces/);
  assert.doesNotMatch(block, /\bgpu:\s*snapshot\.gpu/);
  assert.doesNotMatch(block, /\bschedulerStates:\s*snapshot\.schedulerStates/);
});

test("panel html has primary realtime sections", () => {
  const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");
  const html = renderPanelHtml();
  for (const text of ["GPU 状态", "运行进度", "结果文件", "实验记录", "诊断"]) {
    assert.match(html, new RegExp(text));
  }
  assert.doesNotMatch(html, /id="taskTable"|id="taskDetailPane"|当前 Plan 尚无可显示任务|可切换至全部任务查看历史记录/);
  for (const id of ["gpuSummary", "gpuGrid", "executionPlanList", "operationList"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.doesNotMatch(html, /id="taskSummary"|当前 Plan 的调度记录|其他 Plan 的历史与待处理记录/);
  assert.match(html, /detailsOpenState\["execution-full-records"\] = false/);
  assert.match(html, /<details class="executionFullRecords" data-details-key="execution-full-records">/);
});

test("factory execution section contains only Plan progress, batch actions and operation history", () => {
  const { ExecutionSection } = require("../../dist/ui/sections/ExecutionSection.js");
  const section = new ExecutionSection();
  const html = section.renderHtml();
  assert.doesNotMatch(html + section.renderCss(), /taskTable|taskDetailPane|taskWorkbench|taskProgressCards|taskSummary/);
  for (const id of ["executionPlanList", "taskBatchActions", "operationList"]) assert.ok(html.includes('id="' + id + '"'));
  assert.ok(html.indexOf('id="taskBatchActions"') < html.indexOf('class="executionFullRecords"'));
  assert.match(html, /高级：完整操作记录/);
});
