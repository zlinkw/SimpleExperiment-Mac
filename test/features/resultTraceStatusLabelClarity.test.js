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

function labelStatus(value) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFrozenObject("STATUS_LABELS")}\n${extractFunction("labelStatus")}\nthis.labelStatus = labelStatus;`, sandbox);
  return sandbox.labelStatus(value);
}

function traceStageStatuses(row) {
  const sandbox = {
    pick(value, keys, fallback) {
      for (const key of keys) if (value && value[key] !== undefined && value[key] !== null && value[key] !== "") return value[key];
      return fallback;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("traceStageStatuses")}\nthis.traceStageStatuses = traceStageStatuses;`, sandbox);
  return sandbox.traceStageStatuses(row);
}

function traceStats(rows) {
  const sandbox = {
    resultEvidenceTraceStatsCacheRows: null,
    resultEvidenceTraceStatsCacheValue: null,
    asArray(value) { return Array.isArray(value) ? value : []; },
    usableTaskKey(value) { const text = String(value || "").trim(); return Boolean(text && text !== "-"); },
    meaningfulValue(value) { const text = String(value || "").trim(); return text && text !== "-" ? text : ""; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("isArchivableTraceStatus")}\n${extractFunction("resultEvidenceTraceStatsForRows")}\nthis.traceStats = resultEvidenceTraceStatsForRows;`, sandbox);
  return sandbox.traceStats(rows);
}

test("result trace statuses use Chinese workflow labels", () => {
  assert.equal(labelStatus("archived"), "已归档");
  assert.equal(labelStatus("pending_review"), "待筛选");
  assert.equal(labelStatus("parsed"), "已解析");
  assert.equal(labelStatus("parse_failed"), "解析失败");
  assert.equal(labelStatus("deleted"), "已删除");
  assert.equal(labelStatus("residue"), "有残留");
});

test("result trace UI keeps raw statuses available in hover text", () => {
  assert.match(panel, /原始归档状态：/);
  assert.match(panel, /原始删除状态：/);
  assert.match(panel, /taskMetric\("解析", labelStatus\(row\.resultStatus\)\)/);
  assert.match(panel, /detailTab\("归档", labelStatus\(row\.status/);
  assert.match(panel, /\["解析", labelStatus\(rawResultStatus\), traceTone\(row\.resultStatus\), rawResultStatus\]/);
  assert.match(panel, /\["归档", labelStatus\(rawArchiveStatus\), traceTone\(row\.status\), rawArchiveStatus\]/);
  assert.match(panel, /\["删除", labelStatus\(rawDeleteStatus\), traceTone\(row\.deleteStatus\), rawDeleteStatus\]/);
  assert.match(panel, /title === "更新" \? "原始时间：" : title \+ "原始状态："/);
  assert.match(panel, /const traceTime = relativeTimestampView\(row\.updatedAt, "更新"\)/);
  assert.match(panel, /timeMetric\("更新", traceTime\)/);
  assert.match(panel, /label \+ "时间：" \+ time\.raw/);
});

test("unknown result status remains unchanged for old and future records", () => {
  assert.equal(labelStatus("future_archive_state"), "future_archive_state");
});

test("trace statuses are attributed to execution and archive stages", () => {
  assert.deepEqual({ ...traceStageStatuses({ status: "completed" }) }, { executionStatus: "completed", archiveStatus: "pending_review" });
  assert.deepEqual({ ...traceStageStatuses({ status: "completed", reviewState: "archived" }) }, { executionStatus: "completed", archiveStatus: "archived" });
  assert.deepEqual({ ...traceStageStatuses({ status: "failed", archiveStatus: "archived" }) }, { executionStatus: "failed", archiveStatus: "archived" });
  assert.deepEqual({ ...traceStageStatuses({ status: "archived", executionStatus: "failed" }) }, { executionStatus: "failed", archiveStatus: "archived" });
});

test("trace cards and details label each status owner explicitly", () => {
  assert.match(panel, /原始执行状态：/);
  assert.match(panel, /执行 ' \+ esc\(labelStatus\(row\.executionStatus\)\)/);
  assert.match(panel, /归档 ' \+ esc\(labelStatus\(row\.status\)\)/);
  assert.match(panel, /detailTab\("执行", labelStatus\(row\.executionStatus/);
  assert.match(panel, /detailTab\("取舍", reviewStateLabel\(row\.reviewState\)\)/);
  assert.match(panel, /isArchivableTraceStatus\(item\.executionStatus\)/);
  assert.match(panel, /\["执行", labelStatus\(rawExecutionStatus\)/);
});

test("trace summary uses execution for readiness and archive state for completion", () => {
  const stats = traceStats([
    { id: "ready", archiveKey: "ready", executionStatus: "completed", status: "pending_review", workerId: "w1", resultStatus: "parsed" },
    { id: "archived", archiveKey: "archived", executionStatus: "completed", status: "archived", reviewState: "archived", workerId: "w1" },
    { id: "blocked", archiveKey: "blocked", executionStatus: "failed", status: "pending_review", workerId: "-" },
    { id: "excluded", archiveKey: "excluded", executionStatus: "completed", status: "excluded", reviewState: "excluded", workerId: "w1" },
  ]);
  assert.equal(stats.archived, 1);
  assert.equal(stats.excluded, 1);
  assert.equal(stats.archivable, 1);
  assert.equal(stats.archiveBlocked, 1);
  assert.equal(stats.parsedRows, 1);
});
