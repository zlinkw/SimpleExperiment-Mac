const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

test("onboarding changes keep result refresh scoped to the selected Plan", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /queuePlanScopedResultParse\(reason, planFile, planId\)/);
  assert.match(source, /queuePlanScopedResultParse\("切换计划"/);
  assert.match(source, /queuePlanScopedResultParse\("生成计划模板"/);
  assert.match(source, /queueResultParseAfterProjectChange\("生成输出接入模板"/);
  assert.match(source, /queueResultParseAfterProjectChange\("保存接入规则"/);
  assert.match(source, /queuePlanScopedResultParse\("切换计划", nextPlanFile, nextPlanId\)/);
  assert.match(source, /queueSelectedPlanResultParse\("识别工作区切换计划", planFile\)/);
  assert.match(source, /queuePlanScopedResultParse\(reason, planFile, planId\)/);
});
