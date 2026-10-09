const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("operations surfaces explain the compact Plan view", () => {
  assert.match(panel, /每个 Plan 一张概览卡；详情按需展开/);
  assert.match(panel, /运行中、排队和异常置顶；手动折叠的 Plan 收进折叠区/);
  assert.match(panel, /完整操作记录/);
  assert.match(panel, /失败或卡住的操作需要查看错误和残留/);
  assert.match(panel, /确认耗时按钮在完成、失败、取消或超时后恢复可点击/);
  assert.match(panel, /\["运行器警告", row\.runnerWarningCount/);
});

test("operations surfaces keep raw compatibility terms outside visible labels", () => {
  assert.match(panel, /accepted running completed failed stalled/);
  assert.match(panel, /"操作列表", "入口", "", "查看已提交、执行中、已完成和异常操作/);
  assert.doesNotMatch(panel, />UI 操作、Agent operation</);
  assert.doesNotMatch(panel, /"operation 终态"/);
  assert.doesNotMatch(panel, /\["runner 警告",/);
});
