const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

// 7c23e89 基线：端口接入适配器保留 FwdReq 说明、project 规则编辑器与 openPlan 入口。
test("server worker port adapter keeps project rule editors and openPlan", () => {
  assert.match(panel, /低频稳态、随机抖动与实时事件边界/);
  // Mac 适配：端口对读取 Termius 转发配置；回退文案为手动对齐 Termius 端口（Windows 为解析 Xshell FwdReq）。
  assert.match(panel, /已读取 Termius FwdReq。/);
  assert.match(panel, /填写与 Termius 一致的端口；保存后手动启动转发，再检测。/);
  assert.match(panel, /function projectRuleInput\(key, label, value, title, cls\)/);
  assert.match(panel, /function projectRuleTextarea\(key, label, value, title, cls\)/);
  assert.match(panel, /data-command="openPlan" data-file="' \+ escAttr\(file\)/);
  assert.match(panel, /\.empty-state \{/);
  assert.match(panel, /function helpBadge\(help\)/);
});
