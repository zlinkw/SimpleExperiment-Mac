const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const ts = require("typescript");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");
const script = [...renderPanelHtml().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join("\n");
const parsed = ts.createSourceFile("panel.js", script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const functions = new Map(); let click;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(parsed));
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === "document.addEventListener"
    && node.arguments[0]?.text === "click" && node.arguments[1]?.getText(parsed).includes("data-distributed-retry")) click = node.arguments[1].getText(parsed);
  ts.forEachChild(node, visit);
}
visit(parsed);
function helpers(names) {
  return names.map(name => { assert.ok(functions.has(name), name); return functions.get(name); }).join("\n");
}
function render(jobs) {
  let html;
  const sandbox = { operationRowsForState: () => [], taskSectionViewModelForState: () => ({ allRows: [] }),
    taskPlanFile: row => row.planFile, taskSelectionSetsForState: () => ({}), normalizePlanSelectionKey: String,
    samePlanSelection: (a, b) => a === b, selectedExecutionPlanFile: "", collapsedExecutionPlanKeys: new Set(),
    persistWebviewState() {}, taskStatusToken: String, TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]), TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: () => false, operationIsFailureLike: () => false, operationHasDeadEvidence: () => false,
    taskFailureLikeStatus: status => status === "failed", planBaseName: file => file.split("/").pop(),
    detailsOpenAttr: () => "", statusClass: String, loadingPrefix: () => "", renderOperationItem: () => "",
    renderTaskCards: () => "", setHtmlIfChanged: (_, value) => { html = value; } };
  vm.createContext(sandbox);
  vm.runInContext(helpers(["asArray", "esc", "escAttr", "distributedPlanRecoveryView", "executionPlanGroupKey",
    "executionCurrentDistributedJobs", "executionSubmissionLabel", "executionOperationWorkflowId",
    "executionNewerSubmission", "executionDeferredView", "renderExecutionPlanList"]), sandbox);
  sandbox.renderExecutionPlanList({ distributedPlans: [{ id: "run-id", planFile: "plans/tuning/method.yaml",
    enqueuedAt: "2026-10-10T00:00:00Z", planJobCount: jobs.length, jobs }] });
  return html;
}
const base = { index: 0, attempt: 1, case: "case", seed: 42, commandId: "command-0", workerId: "worker", outputDir: "outputs/attempts/run-id" };

test("per-job exclusion and undo render with exact job identity; active jobs have neither action", () => {
  const failed = render([{ ...base, status: "failed" }]);
  assert.match(failed, /data-command="markJobUnavailable"[^>]*data-plan-id="run-id"[^>]*data-job-index="0"[^>]*data-attempt="1"[^>]*data-command-id="command-0"/);
  for (const status of ["running", "queued", "dispatching", "unknown", "completed"])
    assert.doesNotMatch(render([{ ...base, status }]), /data-command="(?:markJobUnavailable|restoreJobAvailability)"/);
  assert.match(render([{ ...base, status: "pending", workerId: undefined, commandId: undefined }]), /标记不可用/);
  const excluded = render([{ ...base, status: "cancelled", unavailable: { reason: "参数 <invalid>", markedAt: "2026-10-10T00:02:00Z" } },
    { ...base, index: 1, seed: 43, status: "completed" }]);
  assert.match(excluded, /已结束（含不可用 job）/); assert.match(excluded, /成功 1\/2/);
  assert.match(excluded, /不可用 1/); assert.match(excluded, /data-command="restoreJobAvailability"/);
  assert.match(excluded, /参数 &lt;invalid&gt;/); assert.doesNotMatch(excluded, /不可用原因：参数 <invalid>/);
});

test("actual generic click dispatch carries attempt and commandId and correlates independent jobs", () => {
  const sent = [], loading = [];
  const sandbox = { vscode: { postMessage: payload => sent.push(payload) },
    COMMANDS_WITHOUT_LOADING: new Set(), RESTORABLE_PLAN_FILE_PAYLOAD_COMMANDS: new Set(), ARTIFACT_SCOPE_COMMANDS: new Set(),
    pendingButtonKeys: new Set(), pendingActions: {}, pendingActionsById: {}, pendingActionTimeouts: {},
    retryableTransferCommand: () => false, planPhaseCommand: () => false, renderCommandPhaseLine() {}, hidePinContextMenu() {},
    setButtonLoading: (button, key) => loading.push({ button, key }), setTimeout: () => 1,
  };
  vm.createContext(sandbox);
  vm.runInContext(helpers(["payloadFromButton", "commandNeedsLoading", "createClientActionId", "pendingKeyForButton",
    "pendingKeyForAction", "pendingKeyFromButtonDataset"]) + "\nthis.click = " + click, sandbox);
  const button = (command, index) => ({ dataset: { command, planId: "run-id", planFile: "plans/tuning/method.yaml",
    jobIndex: String(index), attempt: "3", commandId: "command-" + index }, textContent: "标记不可用", disabled: false,
    closest: () => null, getAttribute: () => null });
  function press(target) { sandbox.click({ preventDefault() {}, stopPropagation() {}, target: {
    closest: selector => selector === "button[data-command]" ? target : null } }); }
  const first = button("markJobUnavailable", 0);
  press(first); press(first); press(button("markJobUnavailable", 1)); press(button("restoreJobAvailability", 0));
  assert.equal(sent.length, 3); assert.equal(loading.length, 3);
  for (const payload of sent) {
    assert.equal(payload.planId, "run-id"); assert.equal(payload.planFile, "plans/tuning/method.yaml");
    assert.equal(payload.attempt, 3); assert.equal(payload.commandId, "command-" + payload.jobIndex); assert.ok(payload.clientActionId);
  }
  assert.equal(sent[0].jobIndex, 0); assert.equal(sent[1].jobIndex, 1); assert.equal(sent[2].command, "restoreJobAvailability");
  assert.notEqual(loading[0].key, loading[1].key);
});
