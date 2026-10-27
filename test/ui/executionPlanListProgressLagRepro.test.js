const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

// Requirement regression for task ui-plan-gpu-progress-20261024, item 4:
// "Plan 列表状态根据运行进度已有状态及时更新，不新增服务器请求."
//
// Pinned production chain (PanelHtml.legacy.ts @ aa663bb1…, symbols re-verified):
//  - renderExecutionSection L15067 → renderExecutionPlanListIfChanged L15041:
//    full rerender ONLY when executionPlanListKey(state) changes; NO DOM patch
//    path for plan rows (unlike renderOperationSectionIfChanged L15048 which
//    calls patchExecutionProgressDom even on key hit — the operation rows ARE
//    live-patched, which is why the operation card moves and the plan row does not).
//  - executionRenderKeysForState L(?): active submission contributes
//    { status, startedAt, ..., message: active ? "" : row.message } — stage and
//    active message NEVER enter the planList key.
//  - statusText L~14618: `submission ? executionSubmissionLabel(submission) : …`
//    and executionSubmissionLabel L14453 returns a fixed "提交中"/"等待继续提交"
//    label that never consumes row.stage/message; countText during submission is
//    fixed "提交中 · 待生成 job". Job counts only change with data.distributedPlans
//    (host queue/refresh state), never from the live localOperations stage.
// Root cause = R1 (key excludes active stage) + R2 (builder ignores stage).
// Fix must stay on the same-source projection; no new server requests allowed.

function inlineFunction(name) {
  const html = renderPanelHtml();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((candidate) => candidate.includes("function " + name + "(")) || "";
  const start = script.indexOf("function " + name + "(");
  assert.notEqual(start, -1, "missing inline function " + name);
  const bodyStart = script.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < script.length; index += 1) {
    const char = script[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && script[index + 1] === "/") {
      const newline = script.indexOf("\n", index);
      index = newline === -1 ? script.length : newline;
      continue;
    }
    if (char === "/" && script[index + 1] === "*") {
      const end = script.indexOf("*/", index + 2);
      index = end === -1 ? script.length : end + 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return script.slice(start, index + 1);
  }
  throw new Error("unclosed inline function " + name);
}

// Single-statement const declarations the extracted functions close over
// (real values from the shipped script, never re-typed by hand here). Handles
// multi-line object literals by tracking brace depth outside string literals.
function inlineConst(name) {
  const html = renderPanelHtml();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((candidate) => candidate.includes("const " + name + " =")) || "";
  const start = script.indexOf("const " + name + " =");
  assert.notEqual(start, -1, "missing inline const " + name);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < script.length; index += 1) {
    const char = script[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (char === ";" && depth === 0) return script.slice(start, index + 1);
  }
  throw new Error("unterminated inline const " + name);
}

const KEY_FUNCTIONS = [
  "stableSectionHashToken", "stableSectionHashValue", "stableSectionSignature",
  "executionOperationWorkflowId", "operationIsActive", "executionRenderKeysForState",
];

function keyContext(rowsByState) {
  const context = {
    selectedExecutionPlanFile: "",
    selectedExecutionPlanFiles: new Set(),
    collapsedExecutionPlanKeys: new Set(),
    operationStatusFilter: "all",
    selectedOperationHistoryIds: new Set(),
    expandedTaskLogs: {},
    executionRenderKeysCacheState: null,
    executionRenderKeysCacheValue: null,
    executionRenderKeysCacheLocalSignature: null,
    asArray(value) { return Array.isArray(value) ? value : []; },
    // Task-side projection is orthogonal to the run-plan rows under test and is
    // byte-identical across the compared states; stub keeps the key surface to
    // the operations contribution.
    taskSectionViewModelForState() { return { allRows: [], taskView: { selectedRows: [] } }; },
    compactTaskRowsForRenderStructureSignature() { return []; },
    operationRowsForState(state) { return state.__rows || []; },
    // Signatures of these three inputs are identical across the compared states
    // (same rows/empty server data), so identity stubs keep hashing deterministic.
    compactCapabilitiesForSignature(value) { return value || null; },
    normalizeFileTransferRows(value) { return Array.isArray(value) ? value : []; },
    compactOperationRowsForSignature(rows) { return rows; },
  };
  vm.runInNewContext(
    inlineConst("OPERATION_ACTIVE_MATCH_TOKENS") + "\n" + KEY_FUNCTIONS.map(inlineFunction).join("\n"),
    context,
  );
  return context;
}

function submissionRow(patch) {
  return Object.assign({
    operationId: "op-run-1",
    id: "op-run-1",
    type: "run-plan",
    status: "running",
    localSubmissionProgress: true,
    planFile: "experiments/plans/p.yaml",
    planRevision: "r7",
    startedAt: "2026-10-24T10:00:00.000Z",
    enqueuedAt: "",
    createdAt: "",
    finishedAt: "",
    reconcileEvidenceActive: false,
    workflowId: "",
    error: "",
    stage: "sync",
    message: "正在同步代码到 Worker…",
  }, patch || {});
}

function planListKeyOf(context, rows, extra) {
  const state = Object.assign({ __rows: rows, distributedPlans: [], planArtifactSyncStatuses: {} }, extra || {});
  return context.executionRenderKeysForState(state).planList;
}

test("REPRO-4A planList key must change when the displayed progress text changes (R1)", () => {
  const context = keyContext();
  const early = planListKeyOf(context, [submissionRow({})]);
  const later = planListKeyOf(context, [submissionRow({
    stage: "dispatch",
    message: "调度已接收，正在等待 Agent nwpu3 终态…",
    updatedAt: "2026-10-24T10:03:00.000Z",
  })]);
  // The plan row visibly carries progress text in the operation card; once the
  // list is required to reflect 运行进度 已有状态, a changed displayed stage MUST
  // trigger a list rerender. Today stage/active message are excluded → key equal.
  assert.notEqual(early, later,
    "planList key must not stay identical when the same active submission advances its stage/message");
});

test("BASELINE 4B planList key still detects status transitions and reconcile-evidence flips", () => {
  const context = keyContext();
  const running = planListKeyOf(context, [submissionRow({})]);
  const succeeded = planListKeyOf(context, [submissionRow({
    status: "succeeded", message: "已提交运行", finishedAt: "2026-10-24T10:05:00.000Z", localSubmissionProgress: false,
  })]);
  const failed = planListKeyOf(context, [submissionRow({ status: "failed", message: "提交失败", error: "boom", finishedAt: "2026-10-24T10:05:00.000Z" })]);
  const cancelled = planListKeyOf(context, [submissionRow({ status: "cancelled", message: "已取消", finishedAt: "2026-10-24T10:05:00.000Z" })]);
  const keys = new Set([running, succeeded, failed, cancelled]);
  assert.equal(keys.size, 4, "进行中/完成/失败/终止必须各自产生不同列表 key（保护既有状态转换可见性）");
  const evidenceOff = planListKeyOf(context, [submissionRow({ reconcileEvidenceActive: true })]);
  assert.notEqual(running, evidenceOff, "reconcileEvidenceActive 翻转必须改变 key（保护确认完成语义可见）");
});

test("REPRO-4C plan group label must surface the existing progress stage (R2)", () => {
  const context = {};
  vm.runInNewContext([
    inlineConst("PLAN_EXECUTION_PHASE_LABELS"),
    inlineFunction("executionSubmissionProgressText"),
    inlineFunction("executionSubmissionLabel"),
  ].join("\n"), context);
  const label = context.executionSubmissionLabel(submissionRow({
    stage: "dispatch",
    message: "调度已接收，正在等待 Agent nwpu3 终态…",
  }));
  // Requirement: the list row reflects the same progress information the
  // operation card shows, from the same row, without new requests. Today the
  // label is fixed and drops the stage entirely.
  assert.match(label, /调度/, "提交中行标签必须并入既有 stage/message（实际: " + label + "）");
});

test("BASELINE 4D revision filter semantics stay intact (no degradation allowed)", () => {
  const context = {};
  vm.runInNewContext(inlineFunction("operationMatchesPlanVersion"), context);
  const planUpdatedAt = Date.parse("2026-10-24T09:00:00.000Z");
  // Revision present → exact-match against the selected plan revision.
  assert.equal(context.operationMatchesPlanVersion({ planRevision: "r7", updatedAt: "2026-10-24T10:00:00Z" }, "r7", planUpdatedAt), true);
  assert.equal(context.operationMatchesPlanVersion({ planRevision: "r6", updatedAt: "2026-10-24T10:00:00Z" }, "r7", planUpdatedAt), false);
  // No revision on the row → time fallback: only rows updated at/after the plan count.
  assert.equal(context.operationMatchesPlanVersion({ updatedAt: "2026-10-24T10:00:00Z" }, "r7", planUpdatedAt), true);
  assert.equal(context.operationMatchesPlanVersion({ updatedAt: "2026-10-24T08:00:00Z" }, "r7", planUpdatedAt), false);
  // Unparseable planUpdatedAt → only an unfiltered request (empty revision) matches.
  assert.equal(context.operationMatchesPlanVersion({ updatedAt: "2026-10-24T10:00:00Z" }, "", Number.NaN), true);
  assert.equal(context.operationMatchesPlanVersion({ updatedAt: "2026-10-24T10:00:00Z" }, "r7", Number.NaN), false);
});
