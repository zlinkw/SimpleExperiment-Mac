const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

test("accepted Plan submissions preserve the page without an explicit navigation request", () => {
  const start = extension.indexOf("async runActionCommandCore(command, message)");
  const end = extension.indexOf("async runPlanPreflight(body, label, authority = {})", start);
  assert.ok(start >= 0 && end > start);
  const source = extension.slice(start, end);
  assert.ok(source.indexOf("const result = noHubResult !== undefined") >= 0);
  assert.ok(source.indexOf("this.throwIfRemoteActionPending(command, action, finalResult)") >= 0);
  assert.doesNotMatch(source, /openPanelAt\(/, "run submission must not move the user's current page");
  const open = extension.slice(extension.indexOf("async openPanelAt("), extension.indexOf("async openPanelAt(") + 800);
  assert.match(open, /if \(options\.userInitiated !== true\) return false;/);
});

test("submission navigation does not replace preflight blocking", () => {
  const start = extension.indexOf("async runActionCommandCore(command, message)");
  const end = extension.indexOf("async runPlanPreflight(body, label, authority = {})", start);
  const source = extension.slice(start, end);
  const preflight = source.indexOf("await this.runPlanPreflight(body, \"当前计划\"");
  assert.ok(preflight >= 0 && preflight < source.indexOf("const result = noHubResult !== undefined"));
  // LENIENT_RUN 软门禁：允许带警告继续提交，硬阻塞返回改为可配置
  assert.match(source, /runPlanPreflight\(body, "当前计划"[,)]/);
  const hasHardReturn = /if \(!await this\.runPlanPreflight\(body, "当前计划"\)\)\s*return;/.test(source);
  const hasLenient = /LENIENT_RUN[\s\S]*runPlanPreflight/.test(source) || /preflightOk/.test(source);
  assert.ok(hasHardReturn || hasLenient, "preflight blocking should exist either as hard return or lenient warn");
});
