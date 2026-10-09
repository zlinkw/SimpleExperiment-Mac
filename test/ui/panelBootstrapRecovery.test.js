const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const { renderPanelBootstrapDocument } = require("../../dist/ui/PanelBootstrap.js");
const { readSource } = require("../_helpers/sourceReader");
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const recoverySource = readSource("src/ui/PanelRecoveryHtml.ts");
const recoveryModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(recoverySource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: recoveryModule.exports, module: recoveryModule });

test("panel host rendering falls back to a recovery document", () => {
  const normal = renderPanelBootstrapDocument(() => "<main>ready</main>", () => "recovery");
  assert.deepEqual(normal, { html: "<main>ready</main>", recovered: false });

  const recovered = renderPanelBootstrapDocument(
    () => { throw new Error("render exploded"); },
    (message) => `<main>${message}</main>`,
  );
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.error, "render exploded");
  assert.match(recovered.html, /render exploded/);

  const empty = renderPanelBootstrapDocument(() => "", (message) => `<main>${message}</main>`);
  assert.equal(empty.recovered, true);
  assert.match(empty.error, /渲染结果为空/);
});

test("recovery page exposes reload, window reload, and safe diagnostic copy", () => {
  const html = recoveryModule.exports.renderPanelRecoveryHtml("recover", JSON.stringify({ lifecycle: "recovering", payloadBytes: 123 }));
  assert.match(html, /重新加载面板/);
  assert.match(html, /重载窗口/);
  assert.match(html, /复制诊断摘要/);
  assert.match(html, /command:"copyPanelDiagnostics"/);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new vm.Script(script);
});

test("panel ready watchdog is cleared on ready, recovery, reload, and dispose", () => {
  const resolveFlow = extension.slice(extension.indexOf("resolveWebviewView(webviewView)"), extension.indexOf("async dispose()"));
  const messageFlow = extension.slice(extension.indexOf('case "webviewReady"'), extension.indexOf('case "webviewBootstrapError"'));
  const watchdogFlow = extension.slice(extension.indexOf("private startPanelReadyWatchdog"), extension.indexOf("private flushStatePost"));
  const disposeFlow = extension.slice(extension.indexOf("async dispose()"), extension.indexOf("async withHostOperationLease"));

  assert.match(resolveFlow, /this\.loadPanelHtml\(\)/);
  assert.match(messageFlow, /this\.clearPanelReadyWatchdog\(\)/);
  assert.match(watchdogFlow, /private showPanelRecovery\(message: string, force = false, recoveryReason = "panel-recovery"\): void/);
  assert.match(watchdogFlow, /this\.clearPanelReadyWatchdog\(\)/);
  assert.match(watchdogFlow, /renderPanelRecoveryHtml\(message, JSON\.stringify\(this\.panelDiagnosticSummary\(\)\)\)/);
  assert.match(watchdogFlow, /this\.extensionRuntimeVersionState\(\)\.reloadRequired[\s\S]{0,100}this\.showPanelReloadRequired\(\)/);
  assert.match(watchdogFlow, /renderPanelBootstrapDocument\(renderPanelHtml, renderPanelRecoveryHtml\)/);
  assert.match(watchdogFlow, /if \(document\.recovered\)/);
  assert.match(watchdogFlow, /this\.startPanelReadyWatchdog\(\)/);
  const reload = extension.slice(extension.indexOf("private reloadPanelHtml"), extension.indexOf("private reloadPanelLowEffects", extension.indexOf("private reloadPanelHtml")));
  assert.match(reload, /this\.loadPanelHtml\(\)/);
  assert.match(disposeFlow, /this\.clearPanelReadyWatchdog\(\)/);
});

test("webviewReady without a client action id reaches the real ready handler", () => {
  const start = extension.indexOf("async handleMessage(message)");
  const end = extension.indexOf("async handleMessageCore(", start);
  const dispatch = extension.slice(start, end);
  assert.match(dispatch, /await this\.handleMessageCore\(message, command\)/);
  assert.doesNotMatch(dispatch, /await work\(\)/);
  const ready = extension.slice(extension.indexOf('case "webviewReady"'), extension.indexOf('case "webviewBootstrapError"'));
  assert.match(ready, /this\.webviewReady = true/);
  assert.match(ready, /this\.clearPanelReadyWatchdog\(\)/);
  assert.match(ready, /this\.postState\(true, true\)/);
  assert.match(ready, /this\.flushPendingPanelNavigation\(\)/);
});

test("panel registers the message listener before HTML can emit the ready handshake", () => {
  const start = extension.indexOf("resolveWebviewView(webviewView)");
  const end = extension.indexOf("async dispose()", start);
  const flow = extension.slice(start, end);
  const listener = flow.indexOf("webviewView.webview.onDidReceiveMessage");
  const html = flow.indexOf("this.loadPanelHtml()");

  assert.ok(listener >= 0, "missing webview message listener");
  assert.ok(html >= 0, "missing panel HTML load");
  assert.ok(listener < html, "ready listener must be attached before HTML assignment");
  assert.match(extension, /if \(!this\.webviewReady\)\s*this\.startPanelReadyWatchdog\(\)/);
});

test("panel reports post-bootstrap render failures without hiding the recovery path", () => {
  const renderError = extension.slice(extension.indexOf('case "webviewRenderError"'), extension.indexOf('case "reloadPanel"', extension.indexOf('case "webviewRenderError"')));
  const performance = renderError.slice(renderError.indexOf('if (message?.performanceWarning === true)'), renderError.indexOf('if (message?.sectionRecovered === true)'));
  assert.match(performance, /recordPanelSectionTelemetry\(/);
  assert.match(performance, /break;/);
  assert.doesNotMatch(performance, /recordActionError|panelSectionFailures\.add|transitionPanelLifecycle/);
  assert.match(renderError, /this\.recordActionError/);
  assert.match(renderError, /this\.panelSectionFailures\.add/);
  for (const name of ["SAFE_WEBVIEW_COMMANDS", "API_INTERNAL_COMMANDS"]) {
    const declaration = extension.match(new RegExp("const " + name + " = new Set\\(\\[[\\s\\S]*?\\]\\);"))?.[0];
    assert.ok(declaration, name);
    const commands = new Function(declaration + " return " + name + ";")();
    for (const command of ["webviewReady", "webviewHeartbeatAck", "webviewStateRendered", "webviewBootstrapError", "webviewRenderError", "webviewVisibility", "reloadPanel", "reloadWindow"]) assert.ok(commands.has(command), name + ": " + command);
  }
  assert.match(panel, /let lastRenderErrorMessage = ""/);
  assert.match(panel, /vscode\.postMessage\(\{ command: "webviewRenderError", documentGeneration: panelDocumentGeneration, error: .*\.slice\(0, \d+\) \}\)/);
});

test("heartbeat recovery records lifecycle context and uses reload page only for version mismatch", () => {
  const heartbeat = extension.slice(extension.indexOf("private recoverPanelHeartbeatFailure"), extension.indexOf("private schedulePanelHeartbeat"));
  const lifecycle = extension.slice(extension.indexOf("private recordPanelLifecycleDiagnostic"), extension.indexOf("private showPanelReloadRequired"));
  assert.match(heartbeat, /this\.recordPanelLifecycleDiagnostic\(/);
  assert.match(heartbeat, /this\.extensionRuntimeVersionState\(\)\.reloadRequired[\s\S]{0,120}this\.showPanelReloadRequired\(\)/);
  assert.match(heartbeat, /this\.loadPanelHtml\(\)/);
  assert.match(heartbeat, /this\.showPanelRecovery\([\s\S]{0,220}, true, diagnosticReason\)/);
  assert.match(lifecycle, /runningVersion/);
  assert.match(lifecycle, /installedVersion/);
  for (const field of ["documentGeneration", "viewGeneration", "webviewReady", "viewVisible", "reason", "reloadRequired"]) assert.match(lifecycle, new RegExp(field));
  const schedule = extension.slice(extension.indexOf("private schedulePanelHeartbeat"), extension.indexOf("private buildPanelFallbackState"));
  assert.match(schedule, /\.then\(\(accepted\) => \{/);
  assert.match(schedule, /accepted === false/);
  assert.match(schedule, /\.catch\(\(\) => \{/);
  assert.doesNotMatch(schedule, /catch\(\(\) => undefined\)/);
});
