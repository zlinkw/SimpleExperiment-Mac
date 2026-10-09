const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panelSource = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panelSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panelSource.indexOf("{", start);
  let depth = 0;
  for (let i = body; i < panelSource.length; i += 1) {
    if (panelSource[i] === "{") depth += 1;
    if (panelSource[i] === "}") depth -= 1;
    if (depth === 0) return panelSource.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractConst(name) {
  const start = panelSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing const ${name}`);
  const end = panelSource.indexOf(";", start);
  assert.ok(end > start, `unterminated const ${name}`);
  return panelSource.slice(start, end + 1);
}

function loadGraceHelpers(nowMs) {
  const sandbox = {
    Date: {
      now: () => nowMs,
      parse: Date.parse,
    },
  };
  vm.createContext(sandbox);
  const code = [
    extractConst("OPERATION_ACTIVE_MATCH_TOKENS"),
    extractConst("OPERATION_FAILURE_MATCH_TOKENS"),
    extractFunction("operationIsActive"),
    extractFunction("operationIsFailureLike"),
    extractFunction("operationIsCancelled"),
    extractFunction("operationIsCompleted"),
    extractFunction("operationEvidenceOf"),
    extractFunction("operationPayloadText"),
    extractFunction("operationEvidenceHasErrorText"),
    extractFunction("operationGraceRemainingSeconds"),
    extractFunction("operationDisplayMessage"),
    "this.graceRemaining = operationGraceRemainingSeconds;",
    "this.displayMessage = operationDisplayMessage;",
  ].join("\n");
  vm.runInContext(code, sandbox);
  return sandbox;
}

const FIXED_NOW = Date.parse("2026-08-30T12:00:00.000Z");

test("operationGraceRemainingSeconds 双键兼容：camelCase 与 snake_case", () => {
  const h = loadGraceHelpers(FIXED_NOW);
  const isoFuture = new Date(FIXED_NOW + 45 * 1000).toISOString();
  const isoFutureSnake = new Date(FIXED_NOW + 30 * 1000).toISOString();

  // camelCase
  assert.equal(h.graceRemaining({ reconcileGraceExpiresAt: isoFuture }), 45);
  // snake_case
  assert.equal(h.graceRemaining({ reconcile_grace_expires_at: isoFutureSnake }), 30);
  // camel 优先于 snake（源码 || 逻辑）
  const both = { reconcileGraceExpiresAt: isoFuture, reconcile_grace_expires_at: isoFutureSnake };
  assert.equal(h.graceRemaining(both), 45);
  // 空
  assert.equal(h.graceRemaining({}), null);
  assert.equal(h.graceRemaining({ reconcileGraceExpiresAt: "" }), null);
  assert.equal(h.graceRemaining(null), null);
  assert.equal(h.graceRemaining("not-an-object"), null);
});

test("operationGraceRemainingSeconds 边界：过期、非法、向上取整", () => {
  const h = loadGraceHelpers(FIXED_NOW);
  // 已过期
  const expired = new Date(FIXED_NOW - 5 * 1000).toISOString();
  assert.equal(h.graceRemaining({ reconcileGraceExpiresAt: expired }), 0);
  // 刚好过期 0.2s 前 -> remaining 0
  const justExpired = new Date(FIXED_NOW - 200).toISOString();
  assert.equal(h.graceRemaining({ reconcileGraceExpiresAt: justExpired }), 0);
  // 0.2s 后 -> ceil => 1
  const almost = new Date(FIXED_NOW + 200).toISOString();
  assert.equal(h.graceRemaining({ reconcileGraceExpiresAt: almost }), 1);
  // 非法日期
  assert.equal(h.graceRemaining({ reconcileGraceExpiresAt: "not-a-date" }), null);
  assert.equal(h.graceRemaining({ reconcileGraceExpiresAt: "2026-13-40" }), null);
  // 远未来
  const far = new Date(FIXED_NOW + 90 * 1000).toISOString();
  assert.equal(h.graceRemaining({ reconcileGraceExpiresAt: far }), 90);
});

test("operationDisplayMessage 宽限期文案：active + message 组合", () => {
  const h = loadGraceHelpers(FIXED_NOW);
  const future = new Date(FIXED_NOW + 60 * 1000).toISOString();

  // active 且有原 message -> 前缀宽限期 + 原 message 括号
  const withMsg = h.displayMessage({ status: "running", message: "等待 Hub Agent 回传进度", reconcileGraceExpiresAt: future });
  assert.match(withMsg, /宽限期剩余 60s，等待调度收敛/);
  assert.match(withMsg, /等待 Hub Agent 回传进度/);
  assert.match(withMsg, /宽限期剩余 60s.*（等待 Hub Agent 回传进度）/);

  // active 无 message -> 宽限期 + 默认已提交文案
  const noMsg = h.displayMessage({ status: "running", reconcileGraceExpiresAt: future });
  assert.equal(noMsg, "宽限期剩余 60s，等待调度收敛（已提交，等待 Hub Agent 回传进度）");

  // snake_case 同样生效
  const snake = h.displayMessage({ status: "running", message: "排队中", reconcile_grace_expires_at: future });
  assert.match(snake, /宽限期剩余 60s，等待调度收敛（排队中）/);

  // 非 active 非 terminal 且有宽限期 -> 仅宽限期
  const pending = h.displayMessage({ status: "unknown_status", reconcileGraceExpiresAt: future });
  assert.equal(pending, "宽限期剩余 60s，等待调度收敛");

  // 无宽限期回退到普通 message
  const plain = h.displayMessage({ status: "running", message: "自定义消息" });
  assert.equal(plain, "自定义消息");
});

test("operationDisplayMessage 宽限期被终态抑制：failed/cancelled/completed/stale 不显示宽限期", () => {
  const h = loadGraceHelpers(FIXED_NOW);
  const future = new Date(FIXED_NOW + 60 * 1000).toISOString();

  const terminals = [
    { status: "failed", message: "出错" },
    { status: "failure", message: "出错" },
    { status: "error", message: "出错" },
    { status: "stalled", message: "卡死" },
    { status: "cancelled", message: "已取消" },
    { status: "canceled", message: "已取消" },
    { status: "stopped", message: "已停止" }, // cancelled via stop
    { status: "completed", message: "完成" },
    { status: "done", message: "完成" },
    { status: "succeeded", message: "完成" },
    { status: "stale", message: "stale" },
    { status: "running_stale", message: "stale inside" },
  ];
  for (const row of terminals) {
    const msg = h.displayMessage({ ...row, reconcileGraceExpiresAt: future });
    assert.doesNotMatch(msg, /宽限期剩余/, `terminal ${row.status} should not show grace`);
  }

  // completed_with_errors 也属于 failure-like，不应显示宽限期
  const cwe = h.displayMessage({ status: "completed_with_errors", error: "部分失败", reconcileGraceExpiresAt: future });
  assert.doesNotMatch(cwe, /宽限期剩余/);
});

test("operationDisplayMessage 宽限期过期后回退", () => {
  const h = loadGraceHelpers(FIXED_NOW);
  const expired = new Date(FIXED_NOW - 10 * 1000).toISOString();
  // expired => 0，不进宽限期分支
  const msg = h.displayMessage({ status: "running", message: "等待中", reconcileGraceExpiresAt: expired });
  assert.equal(msg, "等待中");
  const noMsg = h.displayMessage({ status: "running", reconcileGraceExpiresAt: expired });
  assert.equal(noMsg, "已提交，等待 Hub Agent 回传进度；可手动刷新数据。");
});

test("operationDisplayMessage 调度已停止优先于宽限期", () => {
  const h = loadGraceHelpers(FIXED_NOW);
  const future = new Date(FIXED_NOW + 60 * 1000).toISOString();
  // 等待 scheduler 终态 + dead evidence -> 应返回 调度已停止 而非宽限期
  const deadRow = {
    status: "running",
    message: "等待 scheduler 终态",
    reconcileGraceExpiresAt: future,
    evidence: { pidAlive: false, tmuxSessionAlive: false },
  };
  const msg = h.displayMessage(deadRow);
  assert.equal(msg, "调度已停止（远端进程已退出，未收到终态；请查看日志或点击“中止清理”）");
  assert.doesNotMatch(msg, /宽限期/);
});

test("running evidence conflict points at refresh and logs before any clear", () => {
  const sandbox = {
    Date: { now: () => FIXED_NOW + 120000, parse: Date.parse },
    esc: (value) => String(value ?? ""),
    escAttr: (value) => String(value ?? ""),
    operationIsActive: (status) => String(status) === "running",
    operationEvidenceOf: (row) => row.evidence || {},
    operationEvidenceHasErrorText: () => "dead",
    operationHasDeadEvidence: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("operationRunningEvidenceWarning")}\n${extractFunction("operationEvidenceNextActions")}\nthis.warn = operationRunningEvidenceWarning;`, sandbox);
  const old = new Date(FIXED_NOW - 120000).toISOString();
  const conflict = sandbox.warn({
    status: "running", operationId: "op-sync", planFile: "experiments/plans/old.yaml",
    startedAt: old, evidence: { dead: true, error: "timedOut", logTail: "worker dead" },
  });
  assert.match(conflict, /下一步/);
  assert.match(conflict, /data-command="snapshot"/);
  assert.match(conflict, />刷新状态</);
  assert.match(conflict, /data-command="showLogHistory"/);
  assert.match(conflict, /data-command="openFullLog"/);
  assert.match(conflict, /data-command="stopAndClearPlan"/);
  assert.match(conflict, /data-confirm="true"/);
  assert.match(conflict, /data-plan-file="experiments\/plans\/old\.yaml"/);
  assert.match(conflict, /不能证明该操作已经失败|还不能证明/);
  assert.match(conflict, /这一条前序 Plan/);
  assert.doesNotMatch(conflict, /可能已失败|中止清理|继续提交/);
  const held = sandbox.warn({
    status: "cancelled", operationId: "op-new", planFile: "experiments/plans/summation.yaml",
    startedAt: old, message: "未提交。旧代码版本仍占用 Worker", evidence: { dead: true, error: "timedOut" },
  });
  assert.equal(held, "");
  sandbox.operationHasDeadEvidence = () => false;
  sandbox.operationEvidenceHasErrorText = () => "";
  const quiet = sandbox.warn({ status: "running", startedAt: old, evidence: { pidAlive: true, tmuxSessionAlive: true } });
  assert.equal(quiet, "");
  const clicks = [];
  const button = { dataset: { command: "snapshot", confirm: "" } };
  if (button.dataset.command === "snapshot") clicks.push("refresh");
  if (button.dataset.command === "stopAndClearPlan" && button.dataset.confirm !== "true") clicks.push("cleared");
  assert.deepEqual(clicks, ["refresh"]);
});

test("operationGraceRemainingSeconds 与 operationDisplayMessage 源码存在性", () => {
  assert.match(panelSource, /function operationGraceRemainingSeconds\(row\)/);
  assert.match(panelSource, /reconcileGraceExpiresAt \|\| safe\.reconcile_grace_expires_at/);
  assert.match(panelSource, /宽限期剩余 .*s，等待调度收敛/);
  assert.match(panelSource, /operationGraceRemainingSeconds\(safe\)/);
});
