const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = panel.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function extractFrozenObject(name) {
  const start = panel.indexOf(`const ${name} = Object.freeze({`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = panel.indexOf("});", start);
  assert.ok(end > start, `unterminated ${name}`);
  return panel.slice(start, end + 3);
}

function stats(rows) {
  const sandbox = {
    OPERATION_ACTIVE_MATCH_TOKENS: Object.freeze(["accepted", "submitted", "pending", "queued", "running", "in_progress", "started", "progress"]),
    OPERATION_FAILURE_MATCH_TOKENS: Object.freeze(["failed", "failure", "stalled", "timeout", "unsupported", "error"]),
    operationRowsForState: () => rows,
    overviewOperationStatsCacheRows: null,
    overviewOperationStatsCacheValue: null,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("operationIsActive"),
    extractFunction("operationIsFailureLike"),
    extractFunction("operationSucceeded"),
    extractFunction("operationIsCompleted"),
    extractFunction("operationIsCancelled"),
    extractFunction("overviewOperationStats"),
    "this.check = overviewOperationStats;",
  ].join("\n"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.check({})));
}

function typeLabel(type) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFrozenObject("OPERATION_TYPE_LABELS")}\n${extractFunction("operationTypeLabel")}\nthis.check = operationTypeLabel;`, sandbox);
  return sandbox.check(type);
}

function statusLabel(status) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("operationStatusLabel")}\nthis.check = operationStatusLabel;`, sandbox);
  return sandbox.check(status);
}

test("operation types use clear Chinese labels with raw fallback", () => {
  assert.equal(typeLabel("validate-plan"), "校验计划");
  assert.equal(typeLabel("runPlan"), "运行计划");
  assert.equal(typeLabel("parse_results"), "解析结果");
  assert.equal(typeLabel("future-operation"), "future-operation");
  assert.equal(typeLabel(""), "操作");
  assert.equal(statusLabel("submitted"), "已提交");
  assert.equal(statusLabel("completed_with_errors"), "部分失败");
  assert.equal(statusLabel("stopped"), "已停止");
  assert.match(panel, /const OPERATION_TYPE_LABELS = Object\.freeze\(\{/);
  assert.match(extractFunction("operationTypeLabel"), /OPERATION_TYPE_LABELS\[key\] \|\| raw/);
  assert.doesNotMatch(extractFunction("operationTypeLabel"), /const labels =/);
});

test("overview operation stats cover active failure and completed statuses", () => {
  const rows = [
    { type: "newest", status: "unsupported", updatedAt: "2026-07-18T12:00:00Z" },
    { type: "a", status: "accepted" },
    { type: "b", status: "submitted" },
    { type: "c", status: "running" },
    { type: "d", status: "stalled" },
    { type: "e", status: "error" },
    { type: "f", status: "completed" },
  ];
  assert.deepEqual(stats(rows), {
    total: 7,
    running: 3,
    failed: 3,
    completed: 1,
    latest: "2026-07-18T12:00:00Z",
    latestStatus: "unsupported",
    latestType: "newest",
  });
  assert.match(panel, /const OPERATION_ACTIVE_MATCH_TOKENS = Object\.freeze\(\[/);
  assert.match(panel, /const OPERATION_FAILURE_MATCH_TOKENS = Object\.freeze\(\[/);
  assert.match(extractFunction("operationIsActive"), /OPERATION_ACTIVE_MATCH_TOKENS\.some/);
  assert.match(extractFunction("operationIsFailureLike"), /OPERATION_FAILURE_MATCH_TOKENS\.some/);
  assert.doesNotMatch(extractFunction("operationIsActive"), /return \[/);
  assert.doesNotMatch(extractFunction("operationIsFailureLike"), /return \[/);
});

// (提交一) 运维总览已删除: renderOverviewOpsWorkbench 切片断言随之移除; operation 通用断言保留在前两个用例。
