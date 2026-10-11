const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
require("../_helpers/registerTsRequire");

const root = path.resolve(__dirname, "../..");
const flow = require("../../src/features/PanelStateFlowControl.ts");
const payload = require("../../src/features/PanelStatePayload.ts");
const bootstrap = require("../../src/ui/PanelBootstrap.ts");
const recovery = require("../../src/ui/PanelRecoveryHtml.ts");
const source = fs.readFileSync(path.join(root, "src/extension/legacy.ts"), "utf8");
const ast = ts.createSourceFile("provider.ts", source, ts.ScriptTarget.Latest, true);
const providerClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === "RealtimeTunnelPanelProvider");
const methodNames = new Set([
  "flushStatePost", "syncPanelStateFlowVisibility", "handlePanelStateRenderedAck",
  "recoverPanelHeartbeatFailure", "schedulePanelHeartbeat", "clearPanelHeartbeat",
  "loadPanelHtml", "reloadPanelHtml", "reloadPanelLowEffects", "restorePanelFromUi",
  "resetUnresponsivePanelRenderer", "startPanelReadyWatchdog", "clearPanelReadyWatchdog",
  "stampPanelDocument", "resetPanelStateProgress", "showPanelRecovery",
]);
const methods = providerClass.members.filter(node => node.name && methodNames.has(node.name.getText(ast))).map(node => node.getText(ast));
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && (
  /^(webviewStatePostSignature|compactPanelDiagnosticsForPostGate|contextActionStatePostSignature|realtimeUi|createRealtimeUiHash)$/.test(node.name?.text)
  || node.name?.text.startsWith("realtimeUi")
)).map(node => node.getText(ast));

function harness() {
  let now = 1_000_000, next = 0;
  const timers = new Map(), messages = [], commands = [], diagnostics = [], notices = [];
  let resolveCommand;
  const timer = {
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, ms) { const id = ++next; timers.set(id, { callback, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const entry = [...timers].filter(([, row]) => row.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at; timers.delete(entry[0]); entry[1].callback();
      }
      now = end;
    },
  };
  const code = ts.transpileModule(functions.join("\n") + "\nclass Subject {" + methods.join("\n") + "}\nthis.Subject = Subject;", {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sandbox = {
    ...timer, Buffer, crypto: require("node:crypto"),
    REALTIME_UI_HASH_MAX_DEPTH: 8, REALTIME_UI_HASH_MAX_ITEMS: 240, REALTIME_UI_HASH_MAX_NODES: 4096,
    PanelStateFlowControl_1: flow, PanelStatePayload_1: payload,
    PanelStateDelivery_1: { postMessageWithTimeout: async post => post() },
    renderPanelBootstrapDocument: bootstrap.renderPanelBootstrapDocument,
    renderPanelHtml: () => '<html><body><div class="topbar-actions"></div></body></html>',
    renderPanelRecoveryHtml: recovery.renderPanelRecoveryHtml,
    compactSensitiveText: value => String(value || ""), errorMessage: error => String(error.message || error),
    viewId: "simpleExperiment.panel",
    vscode: { commands: { async executeCommand(command) {
      commands.push(command);
      if (command === "simpleExperiment.panel.toggleVisibility" && subject.holdReset) {
        await new Promise(resolve => { resolveCommand = resolve; });
      }
      if (subject.onCommand) await subject.onCommand(command);
    } } },
  };
  vm.runInNewContext(code, sandbox);
  const subject = Object.assign(new sandbox.Subject(), {
    view: { visible: true, webview: { html: "", postMessage(message) { messages.push(message); return Promise.resolve(true); } } },
    viewGeneration: 1, panelDocumentGeneration: 1, panelStateFlow: flow.createPanelStateFlowControlState(1, true),
    webviewReady: true, webviewDocumentVisible: true, panelDisposed: false, panelLifecycleState: "ready",
    panelSectionRevisionTracker: { reset() {} },
    automaticRecoveryCount: 0, recoveryLoopPreventedCount: 0, panelNeedsWebviewReset: false,
    panelHeartbeatId: 0, panelHeartbeatIntervalMs: 30000, panelHeartbeatAckTimeoutMs: 12000,
    stateSequence: 0, statePostAttemptId: 0, statePostRetryCount: 0, statePostDeliveryTimeoutMs: 7000,
    statePayloadSoftLimitBytes: 800000, statePayloadHardLimitBytes: 1500000,
    lastPostedStateSignature: "", lastDeliveredStateSeq: 0, lastReceivedStateSeq: 0,
    lastPostedStateSeq: 0, lastRenderedStateSeq: 0, fullStatePosts: 0, fullStateBytesTotal: 0,
    fullStatePostSamples: [], renderAckLatencySamples: [], renderAckCount: 0,
    latestPanelBuildTiming: { runtimeEvidenceMs: 0, resultCatalog: { cacheHit: true, buildMs: 0 } },
    maxOutstandingFullStates: 0, backpressureSuppressedPosts: 0,
    panelSectionFailures: new Set(), context: { extension: { packageJSON: { version: "0.5.263" } } },
    extensionRuntimeVersionState: () => ({ reloadRequired: false }),
    transitionPanelLifecycle(state) { this.panelLifecycleState = state; },
    recordPanelLifecycleDiagnostic(reason) { diagnostics.push(reason); },
    markCurrentSessionPanelFailure(reason) { this.currentSessionRecoveryReason = reason; },
    recordPanelIncident() {}, capturePanelFailureEvidence() {},
    notifyPanelFailureOnce(key, message) { notices.push({ key, message }); },
    panelDiagnosticSummary: () => ({}), postState() {}, recordActionError() {},
    buildPanelFallbackState() { assert.fail("business state should not fail"); },
    jobs: [{ index: 0, status: "running" }], gpu: [{ utilization: 40 }],
    buildState() {
      return { jobs: this.jobs, gpu: this.gpu, diagnostics: {
        lastError: this.businessError || "", panelLifecycle: this.panelLifecycleState,
        bulkCounts: { schedulerRows: this.jobs.length, panelLifecycle: this.panelLifecycleState,
          statePostedSeq: this.lastPostedStateSeq, stateReceivedSeq: this.lastReceivedStateSeq,
          stateRenderedSeq: this.lastRenderedStateSeq, panelStateTelemetryPreviousSample: this.latestPanelStateTelemetry },
      } };
    },
  });
  return { subject, timer, timers, messages, commands, diagnostics, notices, releaseReset: () => resolveCommand?.() };
}

async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
async function refresh(host) {
  host.subject.statePostPending = true;
  host.subject.flushStatePost(false);
  await settle();
  const state = host.messages.findLast(message => message.type === "state");
  if (state) host.subject.handlePanelStateRenderedAck({ documentGeneration: host.subject.panelDocumentGeneration, seq: state.seq });
}

test("eight hours of unchanged state do not feed previous telemetry and ACK counters back into full posts", async () => {
  const host = harness();
  for (let i = 0; i < 480; i++) { host.timer.advance(60000); await refresh(host); }
  assert.equal(host.subject.fullStatePosts, 1, "observing a previous post must not itself change business state");
  assert.equal(host.messages[0].state.diagnostics.bulkCounts.schedulerRows, 1);
  assert.ok(host.subject.latestPanelStateTelemetry, "telemetry remains available in diagnostics");
  host.subject.gpu = [{ utilization: 90 }]; await refresh(host);
  host.subject.jobs = [{ index: 0, status: "completed" }]; await refresh(host);
  host.subject.businessError = "Worker offline"; await refresh(host);
  assert.equal(host.subject.fullStatePosts, 4, "GPU, completion and real diagnostic failures still refresh");
});

test("the overnight lost-heartbeat and failed-handshake trace exposes host recovery and resets the webview renderer", async () => {
  const host = harness(), originalJobs = host.subject.jobs;
  host.subject.schedulePanelHeartbeat();
  host.timer.advance(30000); await settle();
  assert.equal(host.messages.at(-1).type, "panelHeartbeat");
  host.timer.advance(12000);
  assert.equal(host.subject.automaticRecoveryCount, 1);
  assert.match(host.subject.view.webview.html, /panel-low-effects/, "automatic recovery reduces compositor effects");
  host.timer.advance(10000);
  assert.equal(host.subject.currentSessionRecoveryReason, "panelReadyWatchdogTimeout");
  assert.equal(host.subject.panelNeedsWebviewReset, true, "rewriting HTML without a bootstrap must not pretend to repair the renderer");
  assert.equal(host.commands.length, 0, "other webviews reset only on an explicit recovery action");
  await host.subject.restorePanelFromUi();
  assert.deepEqual(host.commands, ["simpleExperiment.panel.toggleVisibility", "simpleExperiment.panel.focus"]);
  assert.strictEqual(host.subject.jobs, originalJobs, "UI recovery does not requeue or stop jobs");
  host.timer.advance(10000);
  assert.ok(host.timers.size <= 1, "no repeated renderer resets or timer storms");
  assert.equal(host.commands.filter(command => command.endsWith("toggleVisibility")).length, 1);
});

test("a hidden view is not misclassified as a failed bootstrap and old generation watchdogs are fenced", () => {
  const host = harness();
  host.subject.loadPanelHtml();
  host.subject.view.visible = false;
  host.timer.advance(10000);
  assert.equal(host.notices.length, 0);
  host.subject.view.visible = true;
  host.subject.startPanelReadyWatchdog();
  host.subject.panelDocumentGeneration++;
  host.timer.advance(10000);
  assert.equal(host.notices.length, 0);
});

test("a healthy manual reload stays local and a pending renderer reset cannot write into a replacement view", async () => {
  const healthy = harness();
  await healthy.subject.restorePanelFromUi();
  assert.deepEqual(healthy.commands, ["simpleExperiment.panel.focus"]);
  const host = harness();
  host.subject.panelNeedsWebviewReset = true; host.subject.holdReset = true;
  const restoring = host.subject.reloadPanelHtml();
  await settle();
  assert.deepEqual(host.commands, ["simpleExperiment.panel.toggleVisibility"]);
  const replacement = { visible: true, webview: { html: "replacement" } };
  host.subject.view = replacement; host.subject.viewGeneration++;
  host.releaseReset(); await restoring;
  assert.equal(replacement.webview.html, "replacement");
});

test("multiple recovery clicks share one renderer reset and preserve the low-effects handshake", async () => {
  const host = harness();
  host.subject.panelNeedsWebviewReset = true; host.subject.holdReset = true;
  const first = host.subject.reloadPanelHtml(), second = host.subject.reloadPanelLowEffects();
  assert.strictEqual(first, second);
  await settle();
  assert.deepEqual(host.commands, ["simpleExperiment.panel.toggleVisibility"]);
  host.releaseReset(); await first;
  assert.equal(host.subject.panelRendererResetPromise, undefined);
  assert.match(host.subject.view.webview.html, /panel-low-effects/);
  assert.equal(host.subject.webviewReady, false, "reset is not evidence of a completed handshake");
  assert.equal(host.subject.panelDocumentGeneration, 2);
});

test("an installed build mismatch prevents renderer recovery from reviving an obsolete host", async () => {
  const host = harness();
  host.subject.panelNeedsWebviewReset = true;
  host.subject.extensionRuntimeVersionState = () => ({ reloadRequired: true });
  let shown = 0;
  host.subject.showPanelReloadRequired = () => { shown++; };
  await host.subject.reloadPanelHtml();
  assert.equal(shown, 1);
  assert.equal(host.commands.length, 0);
});

test("native view disposal is followed by reopening and never rewrites the retired view", async () => {
  const host = harness(), old = host.subject.view;
  host.subject.panelNeedsWebviewReset = true;
  let fresh;
  host.subject.onCommand = command => {
    if (command.endsWith("toggleVisibility")) {
      host.subject.view = undefined; host.subject.viewGeneration++; host.subject.panelLifecycleState = "detached";
    } else if (command.endsWith("focus")) {
      fresh = { visible: true, webview: { html: "" } };
      host.subject.view = fresh; host.subject.viewGeneration++;
      host.subject.loadPanelHtml();
    }
  };
  await host.subject.restorePanelFromUi();
  assert.deepEqual(host.commands, ["simpleExperiment.panel.toggleVisibility", "simpleExperiment.panel.focus"]);
  assert.strictEqual(host.subject.view, fresh);
  assert.match(fresh.webview.html, /panel-low-effects/);
  assert.equal(old.webview.html, "");
  assert.equal(host.subject.panelDocumentGeneration, 2);
});

test("a hidden retained view is shown before removal and a failed reopen remains recoverable from the host", async () => {
  const host = harness();
  host.subject.panelNeedsWebviewReset = true; host.subject.view.visible = false;
  host.subject.onCommand = command => {
    if (command.endsWith("toggleVisibility")) host.subject.view = undefined;
    if (command.endsWith("focus") && host.commands.length > 1) throw new Error("focus unavailable");
  };
  await host.subject.reloadPanelHtml();
  assert.deepEqual(host.commands, ["simpleExperiment.panel.focus", "simpleExperiment.panel.toggleVisibility", "simpleExperiment.panel.focus"]);
  assert.equal(host.subject.panelNeedsWebviewReset, true);
  assert.equal(host.notices.length, 1);
  assert.equal(host.subject.panelRendererResetPromise, undefined);
});
