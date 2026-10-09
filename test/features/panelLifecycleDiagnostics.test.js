const assert = require("node:assert/strict");
const fsNode = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "../../src/extension/legacy.ts");
const source = fsNode.readFileSync(sourcePath, "utf8");

function extractFunction(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
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

function persistenceHarness() {
  const files = new Map();
  const dirs = new Set();
  const normalize = (value) => String(value).replaceAll("\\", "/");
  const fs = {
    async mkdir(value) { dirs.add(normalize(value)); },
    async writeFile(value, contents) { files.set(normalize(value), String(contents)); },
    async readFile(value) { const key = normalize(value); if (!files.has(key)) throw new Error("ENOENT"); return files.get(key); },
  };
  const sandbox = {
    fs, path, Date,
    UI_ACTION_ERROR_RECORD_LIMIT: 8,
    UI_ACTION_ERROR_MESSAGE_LIMIT: 480,
    UI_ACTION_ERROR_SUGGESTION_LIMIT: 240,
    UI_ACTION_ERROR_CAPABILITY_LIMIT: 8,
    PANEL_LIFECYCLE_DIAGNOSTIC_LIMIT: 24,
    compactPanelRenderEvidence: (value) => value,
    OperationOutcome_1: require("../../dist/core/OperationOutcome.js"),
    async writeAtomicPluginStateJson(file, value) { files.set(normalize(file), JSON.stringify(value, null, 2) + "\n"); },
    actionErrorSuggestion: () => "retry after reload",
  };
  vm.createContext(sandbox);
  vm.runInContext(`(async () => {${[
    'const PROJECT_ACTION_ERRORS_PATH = "simple_cluster/ui/action_errors.json";',
    'const PROJECT_PANEL_LIFECYCLE_PATH = "simple_cluster/ui/panel_lifecycle.json";',
    extractFunction("redactSensitiveText"),
    extractFunction("compactSensitiveText"),
    extractFunction("panelLifecycleDiagnosticMessage"),
    extractFunction("compactPanelLifecycleDetails"),
    extractFunction("normalizeUiActionError"),
    extractFunction("compactUiActionError"),
    extractFunction("normalizeActionErrorRow"),
    extractFunction("readProjectActionErrorsState"),
    extractFunction("writeProjectActionErrorsState"),
    extractFunction("normalizePanelLifecycleDiagnosticRow"),
    extractFunction("readProjectPanelLifecycleDiagnosticsState"),
    extractFunction("writeProjectPanelLifecycleDiagnosticsState"),
    "this.compact = compactUiActionError; this.panelLifecycleDiagnosticMessage = panelLifecycleDiagnosticMessage; this.readErrors = readProjectActionErrorsState; this.writeErrors = writeProjectActionErrorsState; this.readEvents = readProjectPanelLifecycleDiagnosticsState; this.writeEvents = writeProjectPanelLifecycleDiagnosticsState;",
  ].join("\n")} })()`, sandbox);
  return { api: sandbox, files, dirs };
}

test("normal detached to booting to ready transitions do not emit lifecycle failures", () => {
  const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
  const provider = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "RealtimeTunnelPanelProvider");
  const method = provider.members.find((node) => node.name?.getText(ast) === "transitionPanelLifecycle");
  assert.ok(method);
  const code = ts.transpileModule(`class Subject { panelLifecycleState = "detached"; panelLifecycleGeneration = 0; forceReloadRequired = false; panelDisposed = false; ${method.getText(ast)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let failures = 0;
  const sandbox = { PanelLifecycle_1: { transitionPanelLifecycle(current, next) { return { state: next, changed: current !== next, allowed: true }; } } };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const providerHarness = new sandbox.Subject();
  providerHarness.recordPanelLifecycleDiagnostic = () => { failures += 1; };
  assert.equal(providerHarness.transitionPanelLifecycle("booting", "resolveWebviewView"), true);
  assert.equal(providerHarness.transitionPanelLifecycle("ready", "webviewReady"), true);
  assert.equal(providerHarness.panelLifecycleState, "ready");
  assert.equal(failures, 0);
});

test("action error details and structured lifecycle telemetry survive write then read", async () => {
  const { api, files } = persistenceHarness();
  const error = api.compact({
    command: "panelLifecycle", message: api.panelLifecycleDiagnosticMessage("heartbeatTimeout"),
    details: {
      reason: "heartbeatTimeout", lifecycle: "recovering", documentGeneration: 12, viewGeneration: 3,
      failureDocumentGeneration: 11, currentDocumentGeneration: 12,
      renderHealthStatus: "unknown", renderHealthReason: "document-hidden", documentHidden: true,
      postedStateSeq: 71, receivedStateSeq: 54, renderedStateSeq: 54, statePayloadBytes: 717609,
      previousHeartbeatRenderedSeq: 53, stalledAckCount: 0,
      stateBuildDurationMs: 42, runningBuildId: "0123456789abcdef", diskBuildId: "0123456789abcdef",
      token: "secret-token", path: "C:/private/project",
    },
  });
  await api.writeErrors("C:/project", [error]);
  const errors = await api.readErrors("C:/project");
  assert.equal(errors[0].details.reason, "heartbeatTimeout");
  assert.equal(errors[0].details.lifecycle, "recovering");
  assert.equal(errors[0].details.documentGeneration, 12);
  assert.equal(errors[0].details.failureDocumentGeneration, 11);
  assert.equal(errors[0].details.currentDocumentGeneration, 12);
  assert.equal(errors[0].details.renderHealthStatus, "unknown");
  assert.equal(errors[0].details.renderHealthReason, "document-hidden");
  assert.equal(errors[0].details.documentHidden, true);
  assert.equal(errors[0].details.postedStateSeq, 71);
  assert.equal(errors[0].details.renderedStateSeq, 54);
  assert.equal(errors[0].details.previousHeartbeatRenderedSeq, 53);
  assert.equal(errors[0].details.stalledAckCount, 0);
  assert.equal(errors[0].details.statePayloadBytes, 717609);
  assert.equal(errors[0].details.runningBuildId, "0123456789ab");
  assert.doesNotMatch(files.get("C:/project/simple_cluster/ui/action_errors.json"), /secret-token|private\/project/);
});

test("bounded lifecycle file keeps only sanitized failure samples across reload", async () => {
  const { api, files } = persistenceHarness();
  const events = Array.from({ length: 30 }, (_, index) => ({
    timestamp: `2026-10-01T00:00:${String(index).padStart(2, "0")}Z`,
    reason: "state-render-sequence-stalled", message: "Webview state render stalled", lifecycle: "recovering",
    runningVersion: "0.5.200", installedVersion: "0.5.200", runningBuildId: "abcdef1234567890", diskBuildId: "abcdef1234567890",
    documentGeneration: index + 1, failureDocumentGeneration: index, currentDocumentGeneration: index + 1,
    viewGeneration: 2, webviewReady: true, viewVisible: true,
    renderHealthStatus: "ok", renderHealthReason: "render-completed", documentHidden: false,
    postedSeq: 71, receivedSeq: 54, renderedSeq: 54, previousHeartbeatRenderedSeq: 54, stalledAckCount: 3, payloadBytes: 717609, stateBuildDurationMs: 42,
    serverToken: "secret-token", originalLog: "large log",
  }));
  await api.writeEvents("C:/project", events);
  const loaded = await api.readEvents("C:/project");
  assert.equal(loaded.length, 24);
  assert.equal(loaded[0].reason, "state-render-sequence-stalled");
  assert.equal(loaded[0].failureDocumentGeneration, 29);
  assert.equal(loaded[0].currentDocumentGeneration, 30);
  assert.equal(loaded[0].renderHealthStatus, "ok");
  assert.equal(loaded[0].renderHealthReason, "render-completed");
  assert.equal(loaded[0].documentHidden, false);
  assert.equal(loaded[0].receivedSeq, 54);
  assert.equal(loaded[0].previousHeartbeatRenderedSeq, 54);
  assert.equal(loaded[0].stalledAckCount, 3);
  assert.equal(loaded[0].payloadBytes, 717609);
  assert.doesNotMatch(files.get("C:/project/simple_cluster/ui/panel_lifecycle.json"), /secret-token|large log/);
});

test("unknown lifecycle reasons never masquerade as heartbeat timeouts", () => {
  const { api } = persistenceHarness();
  assert.equal(api.panelLifecycleDiagnosticMessage("lifecycle:resolveWebviewView:booting"), "Panel lifecycle anomaly: lifecycle:resolveWebviewView:booting");
  assert.equal(api.panelLifecycleDiagnosticMessage("heartbeatTimeout"), "Webview heartbeat timeout");
});

test("a real heartbeat timeout creates one explicit structured failure", () => {
  const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
  const provider = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "RealtimeTunnelPanelProvider");
  const method = provider.members.find((node) => node.name?.getText(ast) === "recordPanelLifecycleDiagnostic");
  assert.ok(method);
  const code = ts.transpileModule(`class Subject { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox = { PANEL_LIFECYCLE_DIAGNOSTIC_LIMIT: 24, Date, compactPanelRenderEvidence: (value) => value, compactPanelLayoutEvidence: (value) => value };
  vm.runInNewContext([
    extractFunction("redactSensitiveText"),
    extractFunction("compactSensitiveText"),
    extractFunction("normalizePanelLifecycleDiagnosticRow"),
    extractFunction("compactPanelLifecycleDetails"),
    extractFunction("panelLifecycleDiagnosticMessage"),
    code,
    "this.Subject = Subject;",
  ].join("\n"), sandbox);
  const subject = new sandbox.Subject();
  const events = [];
  const errors = [];
  Object.assign(subject, {
    panelLifecycleState: "recovering", panelDocumentGeneration: 5, viewGeneration: 2,
    webviewReady: true, view: { visible: true }, lastPanelLifecycleDiagnosticKey: "",
    lastPostedStateSeq: 20, lastReceivedStateSeq: 18, lastRenderedStateSeq: 18, stateRenderStalledAcks: 3,
    latestPanelHeartbeatEvidence: {
      documentGeneration: 5, renderHealthStatus: "ok", renderHealthReason: "render-completed", documentHidden: false,
      postedSeq: 20, receivedSeq: 18, renderedSeq: 18, previousRenderedSeq: 18, stalledAckCount: 3,
    },
    latestPanelHeartbeatProgress: { renderedSeq: 18, previousRenderedSeq: 18, stalledAckCount: 3 },
    latestPanelStateTelemetry: { sampleId: 9, postedSeq: 71, receivedSeq: 54, renderedSeq: 54, payloadBytes: 717609, buildTotalMs: 42 },
    panelLifecycleDiagnostics: [], currentSessionPanelLifecycleDiagnostics: [], extensionRuntimeVersionState: () => ({
      runningVersion: "0.5.200", installedVersion: "0.5.200", registryState: "match",
      runningBuildId: "a".repeat(64), diskBuildId: "a".repeat(64), reloadRequired: false,
    }),
    persistProjectPanelLifecycleDiagnosticsState: async () => {},
    recordActionError: (error) => errors.push(error),
    recordPanelIncident() {},
  });
  subject.persistProjectPanelLifecycleDiagnosticsState = () => { events.push(...subject.panelLifecycleDiagnostics); return Promise.resolve(); };
  subject.recordPanelLifecycleDiagnostic("heartbeatTimeout");
  subject.recordPanelLifecycleDiagnostic("heartbeatTimeout");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "Webview heartbeat timeout");
  assert.equal(errors[0].details.reason, "heartbeatTimeout");
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "heartbeatTimeout");
  assert.equal(events[0].postedSeq, 20);
  assert.equal(events[0].receivedSeq, 18);
  assert.equal(events[0].renderedSeq, 18);
  assert.equal(events[0].previousHeartbeatRenderedSeq, 18);
  assert.equal(events[0].stalledAckCount, 3);
  assert.equal(events[0].failureDocumentGeneration, 5);
  assert.equal(events[0].currentDocumentGeneration, 5);
  assert.equal(events[0].renderHealthStatus, "ok");
  assert.equal(events[0].renderHealthReason, "render-completed");
  assert.equal(events[0].documentHidden, false);
  assert.equal(events[0].payloadBytes, 717609);
  assert.equal(events[0].stateBuildDurationMs, 42);
  assert.equal(errors[0].details.postedStateSeq, 20);
  assert.equal(errors[0].details.receivedStateSeq, 18);
  assert.equal(errors[0].details.renderedStateSeq, 18);
  assert.equal(errors[0].details.previousHeartbeatRenderedSeq, 18);
  assert.equal(errors[0].details.stalledAckCount, 3);
});

test("panel.diagnostics returns the saved sample without rebuilding state or probing disk", () => {
  const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
  const provider = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "RealtimeTunnelPanelProvider");
  const method = provider.members.find((node) => node.name?.getText(ast) === "panelDiagnosticsApi");
  assert.ok(method);
  const code = ts.transpileModule(`class Subject { ${method.getText(ast)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sandbox = { PANEL_LIFECYCLE_DIAGNOSTIC_LIMIT: 24, compactPanelRenderEvidence: (value) => value, compactPanelLayoutEvidence: (value) => value };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const telemetry = {
    sampleId: 8, payloadBytes: 717609, buildTotalMs: 42, runtimeEvidenceMs: 3,
    resultCatalog: { cacheHit: false, buildMs: 22 }, postedSeq: 71, receivedSeq: 54, renderedSeq: 54,
    receivedRenderedSemantics: "latest_heartbeat_ack",
  };
  const subject = new sandbox.Subject();
  Object.assign(subject, {
    panelLifecycleState: "ready", latestPanelBuildIdentityState: {
      runningVersion: "0.5.200", installedVersion: "0.5.200", runningBuildId: "a".repeat(64), diskBuildId: "a".repeat(64),
    },
    runningBuildIdentity: {}, diskBuildIdentity: {}, panelDocumentGeneration: 4, viewGeneration: 2,
    latestPanelStateTelemetry: telemetry, panelSectionFailures: new Set(["results"]),
    panelStateTrafficSnapshot: () => ({ fullStatePosts: 12, coalescedStatePosts: 80, hiddenSuppressedStatePosts: 100, fullStatePostsLastMinute: 4 }),
    panelStateDeliverySnapshot: () => ({ postedSeq: 71, deliveredSeq: 71, renderedSeq: 54, outstandingSeq: 71, pendingDirty: true, outstandingAgeMs: 27 }),
    latestRenderDurationMs: 9, panelRenderPerformance: [], currentSessionRecoveryReason: "", currentSessionLastFailure: null,
    currentSessionPanelLifecycleDiagnostics: [], automaticRecoveryCount: 0, lastAutomaticRecoveryAt: null,
    recoveryLoopPreventedCount: 0, historicalLastFailure: null, panelLifecycleDiagnostics: [],
    panelHostEventLoopSamples: [], panelLayoutEvents: [], panelIncidentEvents: [], panelIncidentSlots: { previous: null },
    buildState() { throw new Error("diagnostics must not rebuild state"); },
    readInstalledBuildIdentity() { throw new Error("diagnostics must not read disk"); },
  });
  const result = subject.panelDiagnosticsApi();
  assert.equal(result.lifecycle, "ready");
  assert.equal(result.runningBuildId, result.diskBuildId);
  assert.equal(result.latestTelemetry, telemetry);
  assert.deepEqual(result.statePostTraffic, { fullStatePosts: 12, coalescedStatePosts: 80, hiddenSuppressedStatePosts: 100, fullStatePostsLastMinute: 4 });
  assert.deepEqual(result.stateDelivery, { postedSeq: 71, deliveredSeq: 71, renderedSeq: 54, outstandingSeq: 71, pendingDirty: true, outstandingAgeMs: 27 });
  assert.equal(result.currentSession.lifecycle, "ready");
  assert.equal(result.currentSession.lastFailure, null);
  assert.equal(result.currentSession.lastRecoveryReason, null);
  assert.equal(result.currentSession.automaticRecoveryCount, 0);
  assert.equal(result.currentSession.lastAutomaticRecoveryAt, null);
  assert.equal(result.currentSession.recoveryLoopPreventedCount, 0);
  assert.equal(result.historicalLastFailure, null);
  assert.deepEqual(Array.from(result.sectionFailures), ["results"]);
  assert.equal(result.lastRecoveryReason, null);
});

test("historical lifecycle failures do not become current-session failures and sectionSlow stays out of the failure ring", async () => {
  const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
  const provider = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "RealtimeTunnelPanelProvider");
  const loadMethod = provider.members.find((node) => node.name?.getText(ast) === "loadProjectPanelLifecycleDiagnosticsState");
  const telemetryMethod = provider.members.find((node) => node.name?.getText(ast) === "recordPanelSectionTelemetry");
  assert.ok(loadMethod && telemetryMethod);
  const code = ts.transpileModule(`class Subject { ${loadMethod.getText(ast)} ${telemetryMethod.getText(ast)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sandbox = { PANEL_LIFECYCLE_DIAGNOSTIC_LIMIT: 24, Date, readProjectPanelLifecycleDiagnosticsState() {} };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const subject = new sandbox.Subject();
  const historical = [
    { timestamp: "2026-09-01T00:00:00Z", reason: "sectionSlow:execution" },
    { timestamp: "2026-08-31T00:00:00Z", reason: "panelReadyWatchdogTimeout" },
  ];
  Object.assign(subject, {
    currentSessionRecoveryReason: "", currentSessionLastFailure: null,
    readCurrentProjectState: async () => ({ current: true, value: historical }),
  });
  await subject.loadProjectPanelLifecycleDiagnosticsState();
  assert.equal(subject.currentSessionRecoveryReason, "");
  assert.equal(subject.currentSessionLastFailure, null);
  assert.deepEqual(Array.from(subject.panelLifecycleDiagnostics, (item) => item.reason), ["panelReadyWatchdogTimeout"]);
  assert.equal(subject.historicalLastFailure.reason, "panelReadyWatchdogTimeout");

  subject.panelDocumentGeneration = 8;
  subject.panelRenderPerformance = [];
  for (let index = 0; index < 40; index += 1) {
    subject.recordPanelSectionTelemetry({
      documentGeneration: 8, stateSeq: index + 1, samples: [{
        section: "execution", signatureMs: index, modelMs: index + 1, domMs: index + 2,
        totalMs: (index + 1) * 3, skipped: index % 2 === 0, skipReason: index % 2 === 0 ? "offscreen" : "",
        operationCount: index, taskCount: 3, planCount: 2,
      }],
    });
  }
  subject.recordPanelSectionTelemetry({
    documentGeneration: 7, stateSeq: 999,
    samples: [{ section: "stale", signatureMs: 9, modelMs: 9, domMs: 9, totalMs: 27, skipped: false }],
  });
  assert.equal(subject.panelRenderPerformance.length, 32);
  assert.equal(subject.panelRenderPerformance[0].stateSeq, 40);
  assert.equal(subject.panelRenderPerformance[0].signatureMs, 39);
  assert.equal(subject.panelRenderPerformance[0].modelMs, 40);
  assert.equal(subject.panelRenderPerformance[0].domMs, 41);
  assert.equal(subject.panelRenderPerformance[0].totalMs, 120);
  assert.equal(subject.panelRenderPerformance[0].skipped, false);
  assert.equal(subject.panelRenderPerformance[0].operationCount, 39);
  assert.equal(subject.panelRenderPerformance[0].taskCount, 3);
  assert.equal(subject.panelRenderPerformance[0].planCount, 2);
  assert.equal(subject.panelRenderPerformance.at(-1).stateSeq, 9);
  assert.equal(subject.panelRenderPerformance.at(-1).signatureMs, 8);
  assert.equal(subject.panelRenderPerformance.at(-1).modelMs, 9);
  assert.equal(subject.panelRenderPerformance.at(-1).domMs, 10);
  assert.equal(subject.panelRenderPerformance.at(-1).totalMs, 27);
  assert.equal(subject.panelRenderPerformance.at(-1).skipped, true);
  assert.equal(subject.panelRenderPerformance.at(-1).skipReason, "offscreen");
});

test("copied recovery summary retains the recovery cause and sequence stall evidence", () => {
  const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
  const provider = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "RealtimeTunnelPanelProvider");
  const method = provider.members.find((node) => node.name?.getText(ast) === "panelDiagnosticSummary");
  assert.ok(method);
  const code = ts.transpileModule(`class Subject { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox = { compactPanelRenderEvidence: (value) => value, compactPanelLayoutEvidence: (value) => value };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const subject = new sandbox.Subject();
  Object.assign(subject, {
    latestPanelBuildIdentityState: { runningVersion: "0.5.200", installedVersion: "0.5.200" },
    currentSessionRecoveryReason: "state-render-sequence-stalled", panelDocumentGeneration: 4, viewGeneration: 1,
    lastPanelFailureEvidence: {
      reason: "state-render-sequence-stalled", failureDocumentGeneration: 3, currentDocumentGeneration: 3,
      renderHealthStatus: "ok", renderHealthReason: "render-completed", documentHidden: false,
      postedSeq: 7962, receivedSeq: 7961, renderedSeq: 7961, previousRenderedSeq: 7961, stalledAckCount: 3,
    },
    panelLifecycleState: "recovering", latestPanelStateTelemetry: { payloadBytes: 727520, buildTotalMs: 3 },
    lastPostedStateSeq: 7962, lastReceivedStateSeq: 7961, lastRenderedStateSeq: 7961,
    latestPanelHeartbeatProgress: { renderedSeq: 7961, previousRenderedSeq: 7961, stalledAckCount: 3 },
    stateRenderStalledAcks: 3,
    panelHostEventLoopSamples: [], panelLayoutEvents: [], panelIncidentEvents: [], panelIncidentSlots: { previous: null },
  });
  const summary = subject.panelDiagnosticSummary();
  assert.equal(summary.reason, "state-render-sequence-stalled");
  assert.equal(summary.failureDocumentGeneration, 3);
  assert.equal(summary.currentDocumentGeneration, 4);
  assert.equal(summary.renderHealthStatus, "ok");
  assert.equal(summary.renderHealthReason, "render-completed");
  assert.equal(summary.documentHidden, false);
  assert.equal(summary.postedSeq, 7962);
  assert.equal(summary.receivedSeq, 7961);
  assert.equal(summary.renderedSeq, 7961);
  assert.equal(summary.previousHeartbeatRenderedSeq, 7961);
  assert.equal(summary.stalledAckCount, 3);
  assert.equal(summary.telemetry.payloadBytes, 727520);
  assert.equal(summary.telemetry.buildTotalMs, 3);
});

test("state telemetry records one serialized sample and labels ACK sequence semantics", () => {
  const flushStart = source.indexOf("private flushStatePost(force, bootstrap = false)");
  const flushEnd = source.indexOf("\n    private ", flushStart + 1);
  const flush = source.slice(flushStart, flushEnd);
  assert.ok(flushStart >= 0 && flushEnd > flushStart);
  assert.ok(flush.indexOf("const signature = webviewStatePostSignature(state)") < flush.indexOf("this.latestPanelStateTelemetry = Object.freeze({"));
  for (const field of ["sampleId", "startedAt", "finishedAt", "buildTotalMs", "runtimeEvidenceMs", "resultCatalog", "serializationMs", "payloadBytes", "postedSeq", "deliveredSeq", "receivedSeq", "renderedSeq"]) {
    assert.match(flush, new RegExp(`${field}[:,]`));
  }
  assert.match(flush, /receivedRenderedSemantics: "explicit_render_ack_with_heartbeat_fallback"/);
  assert.match(flush, /resultCatalog: \{ \.\.\.this\.latestPanelBuildTiming\.resultCatalog \}/);
  assert.match(flush, /this\.latestPanelBuildTiming = \{[\s\S]*?runtimeEvidenceMs: 0,[\s\S]*?resultCatalog: \{ cacheHit: true, buildMs: 0 \}/);
});
