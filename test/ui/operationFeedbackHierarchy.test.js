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
  for (let index = body; index < panelSource.length; index += 1) {
    if (panelSource[index] === "{") depth += 1;
    if (panelSource[index] === "}") depth -= 1;
    if (depth === 0) return panelSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function sandboxWithHelpers(extra) {
  const sandbox = Object.assign({
    esc: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    escAttr: (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"),
    compactText: (value, maxLength) => {
      const text = String(value === undefined || value === null || value === "" ? "-" : value);
      const limit = Math.max(8, Number(maxLength) || 42);
      return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
    },
  }, extra || {});
  vm.createContext(sandbox);
  return sandbox;
}

function loadErrorLine() {
  const sandbox = sandboxWithHelpers();
  vm.runInContext(`${extractFunction("operationEvidenceNextActions")}\n${extractFunction("operationErrorLine")}\nthis.errorLine = operationErrorLine;`, sandbox);
  return sandbox.errorLine;
}

function loadActionErrorRow() {
  const sandbox = sandboxWithHelpers({ featureCommandLabel: (command) => "命令:" + command });
  vm.runInContext(`${extractFunction("actionErrorLinksFor")}\n${extractFunction("actionErrorGuide")}\n${extractFunction("actionErrorDiagnosticSummary")}\n${extractFunction("renderActionErrorRow")}\nthis.row = renderActionErrorRow;`, sandbox);
  return sandbox.row;
}

test("operation errors that add information are promoted out of the tooltip", () => {
  const errorLine = loadErrorLine();
  const html = errorLine({ error: "worker-a 拒绝连接：端口 8765 未监听" }, "归档失败");

  assert.match(html, /class="operationError"/);
  assert.match(html, /<b>错误<\/b>/);
  assert.match(html, /worker-a 拒绝连接：端口 8765 未监听/);
  assert.match(html, /title="worker-a 拒绝连接：端口 8765 未监听"/);
});

test("operation errors that duplicate the message stay collapsed", () => {
  const errorLine = loadErrorLine();
  assert.equal(errorLine({ error: "同一条文本" }, "同一条文本"), "");
  assert.equal(errorLine({ error: "端口未监听" }, "归档失败：端口未监听"), "");
  assert.equal(errorLine({ error: "-" }, "归档失败"), "");
  assert.equal(errorLine({ error: "" }, "归档失败"), "");
  assert.equal(errorLine({}, "归档失败"), "");
  assert.equal(errorLine(null, "归档失败"), "");
});

test("long errors are clipped inline but kept whole in the tooltip", () => {
  const errorLine = loadErrorLine();
  const long = "E".repeat(400);
  const html = errorLine({ error: long }, "归档失败");
  assert.match(html, /…</);
  assert.match(html, new RegExp(`title="${long}"`));
});

test("operation item drops the redundant error pill when the line is shown", () => {
  const renderer = extractFunction("renderOperationItem");
  assert.match(renderer, /const errorLine = operationErrorLine\(row, message\)/);
  assert.match(renderer, /!errorLine && row\.error && row\.error !== "-"/);
  assert.ok(renderer.indexOf("errorLine +") < renderer.indexOf("details +"), "error line must sit right after the message");
  assert.match(panelSource, /\.operationError \{/);
});

test("operation card shows a clickable Plan name and keeps its full path", () => {
  const sandbox = sandboxWithHelpers({
    firstPathLike: (...values) => values.find((value) => String(value || "").includes("/")) || "",
    operationIsActive: () => false, operationIsFailureLike: () => true,
    operationIsCancelled: () => false, operationIsCompleted: () => false,
    operationDisplayMessage: (row) => row.message, operationErrorLine: () => "",
    operationRunningEvidenceWarning: () => "", renderOperationDetailPills: () => "",
    renderRemoteResultInspectionActions: () => "", operationTypeLabel: String,
    operationStatusLabel: String, operationTimestampView: () => ({ label: "结束", raw: "", relative: "刚刚" }),
    PLAN_RUN_OPERATION_TYPES: new Set(), renderTensorBoardLinksForRunning: () => "",
    renderOperationLogsWindowed: () => "", statusClass: String,
    compactIdentifier: String, treeAnchorId: () => "operation-anchor", loadingPrefix: () => "",
    redactUiText: String, meaningfulValue: () => false,
    selectedOperationHistoryIds: new Set(),
  });
  vm.runInContext(`${extractFunction("planBaseName")}\n${extractFunction("planPathButtonForMetric")}\n${extractFunction("renderOperationItem")}\nthis.render = renderOperationItem;`, sandbox);
  const html = sandbox.render({ type: "workflow-run", status: "failed", operationId: "run-1",
    planFile: "experiments/plans/comparison/concatenation.yaml", message: "运行失败" });
  assert.match(html, /data-command="openPlan" data-file="experiments\/plans\/comparison\/concatenation.yaml"/);
  assert.match(html, />concatenation.yaml<\/button>/);
  assert.match(html, /title="experiments\/plans\/comparison\/concatenation.yaml"/);
  const historyHtml = sandbox.render({ type: "workflow-run", status: "failed", operationId: "run-1",
    planFile: "experiments/plans/comparison/concatenation.yaml", message: "运行失败" }, true);
  assert.match(historyHtml, /data-operation-history-select="run-1"/);
  assert.match(historyHtml, /data-command="clearOperations" data-operation-id="run-1"[^>]*>清理此条/);
  assert.match(historyHtml, />历史操作<\/span>/);
  assert.doesNotMatch(historyHtml, /data-command="abortScheduler"/);
  assert.match(panelSource, /payload\.operationIds = Array\.from\(selectedOperationHistoryIds\)/);
});

test("diagnostic action errors show the recovery hint inline", () => {
  const renderRow = loadActionErrorRow();
  const withSuggestion = renderRow({ command: "archiveArtifacts", message: "归档失败", suggestion: "先启动 Hub 隧道再重试" });
  assert.match(withSuggestion, /class="errorRowSuggestion"/);
  assert.match(withSuggestion, /下一步：先启动 Hub 隧道再重试/);

  const capabilityGap = renderRow({ command: "parseResults", message: "缺少能力", capabilityMissing: ["actions.parse"] });
  assert.match(capabilityGap, /下一步：需要升级 Hub Agent: actions\.parse/);

  const fallback = renderRow({ command: "selfCheck", message: "未知错误" });
  assert.match(fallback, /下一步：原因还不明确/);
  assert.match(fallback, /刷新状态/);
  assert.match(fallback, /data-command="snapshot"/);
  assert.doesNotMatch(fallback, /终止并清除该 Plan/);
  assert.match(panelSource, /\.errorRowSuggestion \{ grid-column: 1 \/ -1;/);
});
