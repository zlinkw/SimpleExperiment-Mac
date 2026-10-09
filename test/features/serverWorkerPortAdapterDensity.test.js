const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

// 7c23e89 基线：端口接入适配器保留 FwdReq 说明、project 规则编辑器与 openPlan 入口。
test("server worker port adapter keeps project rule editors and openPlan", () => {
  assert.match(panel, /低频稳态、随机抖动与实时事件边界/);
  assert.match(panel, /已读取 Xshell FwdReq。/);
  assert.match(panel, /当前会话文件未解析到 FwdReq，才需要手动填写。/);
  assert.match(panel, /function projectRuleInput\(key, label, value, title, cls\)/);
  assert.match(panel, /function projectRuleTextarea\(key, label, value, title, cls\)/);
  assert.match(panel, /data-command="openPlan" data-file="' \+ escAttr\(file\)/);
  assert.match(panel, /\.empty-state \{/);
  assert.match(panel, /function helpBadge\(help\)/);
});
