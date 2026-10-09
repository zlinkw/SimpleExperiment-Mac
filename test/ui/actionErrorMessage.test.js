const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("ui action errors include command action suggestion capability and timestamp", () => {
  const source = readSource("src/extension.ts");
  for (const field of ["type UiActionError", "command:", "action?: TunnelAction", "suggestion?", "capabilityMissing?", "timestamp:"]) {
    assert.match(source, new RegExp(field.replace("?", "\\?")));
  }
  assert.match(source, /recordActionError/);
  assert.match(source, /actionErrorSuggestion/);
});

function loadSuggestion() {
  const source = fs.readFileSync(path.join(root, "src/extension/legacy.ts"), "utf8");
  const start = source.indexOf("function actionErrorSuggestion(");
  const end = source.indexOf("function compactUiActionError(", start);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end)}\nthis.actionErrorSuggestion = actionErrorSuggestion;`, sandbox);
  return sandbox.actionErrorSuggestion;
}

test("actionErrorSuggestion names a concrete next step for each diagnostic kind", () => {
  const suggestion = loadSuggestion();
  const held = suggestion("summation.yaml 未提交。旧代码版本仍占用 Worker");
  assert.match(held, /刷新状态/);
  assert.match(held, /终止并清除该 Plan/);
  assert.match(held, /校验并提交运行/);
  assert.doesNotMatch(held, /继续提交/);
  assert.match(suggestion("ECONNREFUSED tunnel closed"), /服务器/);
  assert.match(suggestion("ECONNREFUSED tunnel closed"), /刷新状态/);
  assert.match(suggestion("missing capability endpoint 404"), /诊断与自检|检测全部/);
  assert.match(suggestion("401 token unauthorized"), /token/);
  assert.match(suggestion("safe path traversal"), /允许根目录/);
  assert.match(suggestion("code fingerprint mismatch"), /代码同步/);
  const unknown = suggestion("something unexpected happened");
  assert.match(unknown, /原因还不明确/);
  assert.match(unknown, /刷新状态/);
  assert.doesNotMatch(unknown, /终止并清除该 Plan/);
  assert.match(suggestion(""), /原因还不明确/);
});

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(name);
}

test("rendered diagnostic rows expose real navigation and keep the original message", () => {
  const panel = fs.readFileSync(path.join(root, "src/ui/PanelHtml.legacy.ts"), "utf8");
  const sandbox = {
    esc: (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;"),
    escAttr: (value) => String(value ?? "").replace(/"/g, "&quot;"),
    compactText: (value) => String(value || ""),
    featureCommandLabel: (value) => String(value || "unknown"),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(panel, "actionErrorLinksFor"),
    extractFunction(panel, "actionErrorGuide"),
    extractFunction(panel, "actionErrorDiagnosticSummary"),
    extractFunction(panel, "renderActionErrorRow"),
    "this.render = renderActionErrorRow;",
  ].join("\n"), sandbox);
  const tunnel = sandbox.render({ command: "testTunnel", message: "ECONNREFUSED", timestamp: "t" });
  assert.match(tunnel, /下一步：/);
  assert.match(tunnel, /data-section-target="settings"/);
  assert.match(tunnel, /data-anchor-target="settings-servers"/);
  assert.match(tunnel, /data-command="snapshot"/);
  assert.match(tunnel, />ECONNREFUSED</);
  const fingerprint = sandbox.render({
    command: "distributedPlanQueue",
    message: "code fingerprint mismatch",
    suggestion: "打开代码同步，核对本机与 Worker 指纹是否一致。一致后再到实验准备的 Plan 列表手动选中，点“校验并提交运行”。",
  });
  assert.match(fingerprint, /data-section-target="sync"/);
  assert.match(fingerprint, /data-anchor-target="plans-list"/);
  assert.match(fingerprint, />代码同步</);
  assert.match(fingerprint, />Plan 列表</);
  const unknown = sandbox.render({ command: "selfCheck", message: "boom", timestamp: "t" });
  assert.match(unknown, /原因还不明确/);
  assert.match(unknown, /data-section-target="diagnostics"/);
  assert.match(unknown, /data-anchor-target="diagnostics-errors"/);
  assert.doesNotMatch(unknown, /data-command="stopAndClearPlan"/);
  const heartbeat = sandbox.render({
    command: "panelLifecycle",
    message: "Webview heartbeat timeout",
    details: { reason: "heartbeatTimeout", lifecycle: "recovering", postedStateSeq: 8, receivedStateSeq: 8, renderedStateSeq: 6, statePayloadBytes: 8192, stateBuildDurationMs: 47 },
  });
  assert.match(heartbeat, /诊断：原因 heartbeatTimeout/);
  assert.match(heartbeat, /已发\/已收\/已渲染 8\/8\/6/);
  assert.match(heartbeat, /载荷 8192 B/);
  const clicks = [];
  const document = {
    querySelector(selector) {
      assert.equal(selector, '[data-section="settings"]');
      return { scrollIntoView() { clicks.push("settings"); } };
    },
  };
  function navigateToResourceTarget(section) { document.querySelector(`[data-section="${section}"]`).scrollIntoView(); }
  const button = { dataset: { sectionTarget: "settings", command: "" }, closest() { return this; } };
  if (button.dataset.sectionTarget) navigateToResourceTarget(button.dataset.sectionTarget);
  assert.deepEqual(clicks, ["settings"]);
  assert.equal(button.dataset.command, "");
});

test("string and Error action records keep a visible message and next step", () => {
  const source = fs.readFileSync(path.join(root, "src/extension/legacy.ts"), "utf8");
  const suggestionStart = source.indexOf("function actionErrorSuggestion(");
  const suggestionEnd = source.indexOf("function compactSensitiveText(", suggestionStart);
  const compactStart = source.indexOf("function compactSensitiveText(");
  const compactEnd = source.indexOf("function userFacingFileError(");
  const sandbox = { Date, OperationOutcome_1: require("../../dist/core/OperationOutcome.js"), UI_ACTION_ERROR_MESSAGE_LIMIT: 400, UI_ACTION_ERROR_SUGGESTION_LIMIT: 400, UI_ACTION_ERROR_CAPABILITY_LIMIT: 8 };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(suggestionStart, suggestionEnd)}\n${source.slice(compactStart, compactEnd)}\nthis.compact = compactUiActionError;`, sandbox);
  const fromString = sandbox.compact("token=secret-value ECONNREFUSED");
  assert.match(fromString.message, /ECONNREFUSED/);
  assert.match(fromString.message, /token=<已脱敏>/);
  assert.doesNotMatch(fromString.message, /secret-value/);
  assert.match(fromString.suggestion, /服务器|刷新状态/);
  const fromError = sandbox.compact(new Error("code fingerprint mismatch"));
  assert.match(fromError.message, /fingerprint/);
  assert.match(fromError.suggestion, /代码同步/);
  const fromObject = sandbox.compact({ command: "distributedPlanQueue", message: "boom" });
  assert.equal(fromObject.command, "distributedPlanQueue");
  assert.equal(fromObject.message, "boom");
  assert.match(fromObject.suggestion, /原因还不明确/);
});

test("panel lifecycle diagnostics survive persistence with bounded, non-sensitive detail", () => {
  const source = fs.readFileSync(path.join(root, "src/extension/legacy.ts"), "utf8");
  const sandbox = {
    Date,
    OperationOutcome_1: require("../../dist/core/OperationOutcome.js"),
    UI_ACTION_ERROR_MESSAGE_LIMIT: 480,
    UI_ACTION_ERROR_SUGGESTION_LIMIT: 240,
    UI_ACTION_ERROR_CAPABILITY_LIMIT: 8,
    actionErrorSuggestion: () => "retry",
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(source, "redactSensitiveText"),
    extractFunction(source, "compactSensitiveText"),
    extractFunction(source, "compactPanelLifecycleDetails"),
    extractFunction(source, "compactPanelRenderEvidence"),
    extractFunction(source, "panelLifecycleDiagnosticMessage"),
    extractFunction(source, "normalizeUiActionError"),
    extractFunction(source, "compactUiActionError"),
    extractFunction(source, "normalizeActionErrorRow"),
    "this.compact = compactUiActionError; this.normalize = normalizeActionErrorRow;",
  ].join("\n"), sandbox);
  const row = sandbox.compact({
    command: "panelLifecycle",
    message: "Webview heartbeat timeout",
    details: {
      reason: "heartbeatTimeout", registryState: "match", runningVersion: "0.5.198", installedVersion: "0.5.198",
      runningFingerprint: "0123456789abcdef", diskFingerprint: "fedcba9876543210", lifecycle: "recovering",
      documentGeneration: 4, viewGeneration: 2, postedStateSeq: 8, receivedStateSeq: 8, renderedStateSeq: 6,
      statePayloadBytes: 8192, stateBuildDurationMs: 47, token: "must-not-survive", path: "C:/private/project",
    },
  });
  assert.equal(sandbox.panelLifecycleDiagnosticMessage("heartbeatTimeout"), "Webview heartbeat timeout");
  assert.equal(sandbox.panelLifecycleDiagnosticMessage("state-render-sequence-stalled"), "Webview state render stalled");
  assert.equal(row.details.runningFingerprint, "0123456789ab");
  assert.equal(row.details.diskFingerprint, "fedcba987654");
  assert.equal(row.details.renderedStateSeq, 6);
  const persisted = sandbox.normalize(JSON.parse(JSON.stringify(row)));
  assert.deepEqual(JSON.parse(JSON.stringify(persisted.details)), JSON.parse(JSON.stringify(row.details)));
  assert.doesNotMatch(JSON.stringify(persisted), /must-not-survive|private\/project/);
  const ordinary = sandbox.normalize({ command: "snapshot", message: "ordinary", details: { token: "secret" } });
  assert.equal(ordinary.command, "snapshot");
  assert.equal(ordinary.message, "ordinary");
  assert.equal(Object.hasOwn(ordinary, "details"), false);
});
