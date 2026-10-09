const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function makeClock() {
  let now = 1_000_000;
  let id = 0;
  const timers = new Map();
  return {
    timers,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { timers.set(++id, { callback, at: now + delay }); return id; },
    clearTimeout(timerId) { timers.delete(timerId); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = until;
    },
  };
}

function createHost(clock) {
  const root = path.resolve(__dirname, "../..");
  const source = fs.readFileSync(path.join(root, "src/extension/legacy.ts"), "utf8");
  const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
  const provider = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "RealtimeTunnelPanelProvider");
  const methods = new Set(["clearPanelHeartbeat", "handlePanelHeartbeatAck", "recoverPanelHeartbeatFailure", "schedulePanelHeartbeat", "capturePanelFailureEvidence", "updatePanelDocumentVisibility"]);
  const fields = /^(panelHeartbeat.*|panelUnknownHealth.*|panelDisposed|panelDocumentGeneration|viewGeneration|automaticRecoveryCount|lastAutomaticRecoveryAt|recoveryLoopPreventedCount|webviewReady|lastHeartbeatObservedRenderedStateSeq|latestPanelHeartbeatProgress|latestPanelHeartbeatEvidence|lastPanelFailureEvidence|panelDocumentHasRenderedState|webviewDocumentVisible|lastPostedStateSeq|lastDeliveredStateSeq|lastReceivedStateSeq|lastRenderedStateSeq|stateRenderStalledAcks)$/;
  const members = provider.members.filter((node) => node.name && (methods.has(node.name.getText(ast)) || (ts.isPropertyDeclaration(node) && fields.test(node.name.getText(ast)))));
  const code = ts.transpileModule(`class Subject {\n${members.map((node) => node.getText(ast)).join("\n")}\n}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const flowSource = fs.readFileSync(path.join(root, "src/features/PanelStateFlowControl.ts"), "utf8");
  const flowCode = ts.transpileModule(flowSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const flowExports = {};
  vm.runInNewContext(flowCode, { exports: flowExports, module: { exports: flowExports } });
  const sandbox = {
    ...clock,
    PanelStateFlowControl_1: flowExports,
    compactSensitiveText: (value) => String(value || "").slice(0, 180),
    compactPanelRenderEvidence: (value) => value,
    compactPanelLayoutEvidence: (value) => value,
    PanelStateProgress_1: { observeStateRenderProgress: (_posted, rendered) => ({ previousObservedRenderedSeq: rendered, consecutiveStalledAcks: 0, unhealthy: false }) },
  };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const host = new sandbox.Subject();
  host.view = { visible: true, webview: { postMessage: (message) => { host.messages.push(message); return Promise.resolve(true); } } };
  host.messages = [];
  host.webviewReady = true;
  host.panelDocumentGeneration = 7;
  host.panelStateFlow = flowExports.createPanelStateFlowControlState(7, true);
  host.automaticRecoveryCount = 0; host.lastAutomaticRecoveryAt = null; host.recoveryLoopPreventedCount = 0;
  host.transitionPanelLifecycle = (state) => { host.panelLifecycleState = state; };
  host.recordPanelLifecycleDiagnostic = (reason) => { (host.diagnostics ||= []).push(reason); };
  host.recordPanelIncident = () => {};
  host.cancelResultCatalogRefresh = () => {};
  host.refreshResultCatalogForCurrentInterest = () => {};
  host.markCurrentSessionPanelFailure = (reason) => { host.currentSessionRecoveryReason = reason; };
  host.postState = () => {};
  host.syncPanelStateFlowVisibility = () => { host.panelStateFlow = flowExports.setPanelStateFlowVisibility(host.panelStateFlow, host.view?.visible === true && host.webviewDocumentVisible === true); };
  host.extensionRuntimeVersionState = () => ({ reloadRequired: false });
  host.reloaded = 0;
  host.recoveryCards = 0;
  host.loadPanelHtml = () => { host.reloaded++; host.panelDocumentGeneration++; host.panelStateFlow = flowExports.beginPanelStateDocument(host.panelStateFlow, host.panelDocumentGeneration, true); host.webviewReady = true; host.schedulePanelHeartbeat(); };
  host.showPanelRecovery = () => { host.recoveryCards++; host.webviewReady = false; };
  return host;
}

async function ackNext(clock, host, renderHealth) {
  clock.advance(30_000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const request = host.messages.at(-1);
  host.handlePanelHeartbeatAck({ heartbeatId: request.heartbeatId, documentGeneration: request.documentGeneration, renderHealth });
}

test("persistent current-generation unknown health triggers one bounded recovery after grace", async () => {
  const clock = makeClock();
  const host = createHost(clock);
  host.userDraft = "unsaved plan text";
  host.schedulePanelHeartbeat();
  for (let i = 0; i < 4; i++) await ackNext(clock, host, { status: "unknown", reason: "render-status-unavailable" });
  assert.equal(host.reloaded, 1);
  assert.equal(host.userDraft, "unsaved plan text");
  assert.ok(clock.timers.size <= 1);
});

test("bootstrap, hidden, and pending unknown states retain grace and draft", async () => {
  const clock = makeClock();
  const host = createHost(clock);
  host.userDraft = "unsaved plan text";
  host.schedulePanelHeartbeat();
  for (const reason of ["bootstrap", "document-hidden", "awaiting-first-render", "state-render-pending", "render-health-probe-pending", "render-health-probe-pending"]) {
    await ackNext(clock, host, { status: "unknown", reason });
  }
  assert.equal(host.reloaded, 0);
  assert.equal(host.recoveryCards, 0);
  assert.equal(host.userDraft, "unsaved plan text");
});

test("stale-generation ACK cannot reset the current unknown-health grace", async () => {
  const clock = makeClock();
  const host = createHost(clock);
  host.schedulePanelHeartbeat();
  await ackNext(clock, host, { status: "unknown", reason: "render-status-unavailable" });
  const since = host.panelUnknownHealthSince;
  clock.advance(30_000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const request = host.messages.at(-1);
  host.handlePanelHeartbeatAck({ heartbeatId: request.heartbeatId, documentGeneration: request.documentGeneration - 1,
    renderHealth: { status: "ok", reason: "stale" } });
  assert.equal(host.panelUnknownHealthSince, since);
  assert.ok(host.panelHeartbeatTimeout);
});

test("healthy current-generation ACK resets unknown-health age", async () => {
  const clock = makeClock();
  const host = createHost(clock);
  host.schedulePanelHeartbeat();
  await ackNext(clock, host, { status: "unknown", reason: "render-status-unavailable" });
  await ackNext(clock, host, { status: "ok", reason: "render-completed" });
  assert.equal(host.panelUnknownHealthSince, 0);
});
