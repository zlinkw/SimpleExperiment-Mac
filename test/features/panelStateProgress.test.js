const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const legacySource = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");

const source = fs.readFileSync(path.join(__dirname, "../../src/features/PanelStateProgress.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(code, { exports: loaded.exports, module: loaded });
const flowSource = fs.readFileSync(path.join(__dirname, "../../src/features/PanelStateFlowControl.ts"), "utf8");
const flowCode = ts.transpileModule(flowSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const flowLoaded = { exports: {} };
vm.runInNewContext(flowCode, { exports: flowLoaded.exports, module: flowLoaded });

function flowWithOutstanding(documentGeneration, postedSeq, renderedSeq = 0) {
  let state = flowLoaded.exports.createPanelStateFlowControlState(documentGeneration, true);
  state = flowLoaded.exports.markPanelStateFlowPosted(state, postedSeq, 1_000);
  state = flowLoaded.exports.markPanelStateFlowDelivered(state, postedSeq);
  if (renderedSeq > 0) {
    state = flowLoaded.exports.acknowledgePanelStateRendered(state, documentGeneration, renderedSeq, 2_000).state;
  }
  return state;
}

test("rendering progress clears backlog even when posted remains one state ahead", () => {
  const observations = [
    [7900, 7899, 7890],
    [7930, 7929, 7899],
    [7962, 7961, 7929],
  ];
  let stalled = 0;
  for (const [posted, rendered, previous] of observations) {
    const result = loaded.exports.observeStateRenderProgress(posted, rendered, previous, stalled, 3);
    stalled = result.consecutiveStalledAcks;
    assert.equal(result.unhealthy, false);
    assert.equal(stalled, 0);
  }
});

test("three heartbeats with no rendered progress detect a truly stalled UI", () => {
  let stalled = 0;
  let previous = 18;
  for (let ack = 0; ack < 2; ack += 1) {
    const result = loaded.exports.observeStateRenderProgress(20, 18, previous, stalled, 3);
    previous = result.previousObservedRenderedSeq;
    stalled = result.consecutiveStalledAcks;
    assert.equal(result.unhealthy, false);
  }
  const third = loaded.exports.observeStateRenderProgress(20, 18, previous, stalled, 3);
  assert.equal(third.consecutiveStalledAcks, 3);
  assert.equal(third.unhealthy, true);
  const caughtUp = loaded.exports.observeStateRenderProgress(18, 18, 18, third.consecutiveStalledAcks, 3);
  assert.equal(caughtUp.consecutiveStalledAcks, 0);
  assert.equal(caughtUp.unhealthy, false);
});

test("render progress resets the stall counter before a new no-progress period", () => {
  let result = loaded.exports.observeStateRenderProgress(20, 18, 18, 0, 3);
  assert.equal(result.consecutiveStalledAcks, 1);
  result = loaded.exports.observeStateRenderProgress(20, 19, result.previousObservedRenderedSeq, result.consecutiveStalledAcks, 3);
  assert.equal(result.consecutiveStalledAcks, 0);
  for (let expected = 1; expected <= 3; expected += 1) {
    result = loaded.exports.observeStateRenderProgress(20, 19, result.previousObservedRenderedSeq, result.consecutiveStalledAcks, 3);
    assert.equal(result.consecutiveStalledAcks, expected);
    assert.equal(result.unhealthy, expected === 3);
  }
});

test("first heartbeat establishes a baseline and no backlog clears the stall counter", () => {
  const first = loaded.exports.observeStateRenderProgress(20, 18, undefined, 2, 3);
  assert.equal(first.consecutiveStalledAcks, 0);
  assert.equal(first.unhealthy, false);
  const caughtUp = loaded.exports.observeStateRenderProgress(18, 18, 18, 2, 3);
  assert.equal(caughtUp.consecutiveStalledAcks, 0);
});

function extractMethod(name) {
  const ast = ts.createSourceFile("legacy.ts", legacySource, ts.ScriptTarget.Latest, true);
  const provider = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "RealtimeTunnelPanelProvider");
  const method = provider.members.find((node) => node.name?.getText(ast) === name);
  assert.ok(method, name);
  return { ast, method };
}

test("heartbeat ACK integration does not recover while rendered sequence advances", () => {
  const { ast, method } = extractMethod("handlePanelHeartbeatAck");
  const code = ts.transpileModule(`class Subject { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox = { PanelStateProgress_1: loaded.exports, PanelStateFlowControl_1: flowLoaded.exports, Number, Date, compactPanelRenderEvidence: (value) => value };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const subject = new sandbox.Subject();
  Object.assign(subject, {
    panelDisposed: false, view: { visible: true }, panelHeartbeatId: 1, panelDocumentGeneration: 2,
    panelStateFlow: flowWithOutstanding(2, 7962, 7890),
    lastPostedStateSeq: 7962, lastDeliveredStateSeq: 7962, lastReceivedStateSeq: 7890, lastRenderedStateSeq: 7890,
    lastHeartbeatObservedRenderedStateSeq: 7890, stateRenderStalledAcks: 0, webviewReady: true,
    panelHeartbeatTimeout: undefined, panelUnknownHealthSince: 0, panelUnknownHealthGeneration: 0,
    recoveries: [], schedulePanelHeartbeat() {}, recoverPanelHeartbeatFailure(reason) { this.recoveries.push(reason); }, recordPanelIncident() {},
  });
  subject.handlePanelHeartbeatAck({ heartbeatId: 1, documentGeneration: 2, lastReceivedStateSeq: 7962, lastRenderedStateSeq: 7961, renderHealth: { status: "ok" } });
  assert.equal(subject.stateRenderStalledAcks, 0);
  assert.equal(subject.lastHeartbeatObservedRenderedStateSeq, 7961);
  assert.deepEqual(Array.from(subject.recoveries), []);
});

test("explicit current-document render ACK clears one outstanding state without forging delivery", () => {
  const { ast, method } = extractMethod("handlePanelStateRenderedAck");
  const code = ts.transpileModule(`class Subject { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const FixedDate = class extends Date { static now() { return 124; } };
  const sandbox = { PanelStateFlowControl_1: flowLoaded.exports, Number, Date: FixedDate };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  let panelStateFlow = flowLoaded.exports.createPanelStateFlowControlState(2, true);
  panelStateFlow = flowLoaded.exports.markPanelStateFlowPosted(panelStateFlow, 1, 100);
  panelStateFlow = flowLoaded.exports.markPanelStateFlowDelivered(panelStateFlow, 1);
  panelStateFlow = flowLoaded.exports.acknowledgePanelStateRendered(panelStateFlow, 2, 1, 110).state;
  panelStateFlow = flowLoaded.exports.markPanelStateFlowPosted(panelStateFlow, 2, 120);
  panelStateFlow = flowLoaded.exports.requestPanelStateFlowPost(panelStateFlow).state;
  const subject = new sandbox.Subject();
  const flushed = [];
  Object.assign(subject, {
    panelDisposed: false, panelDocumentGeneration: 2, panelStateFlow,
    lastDeliveredStateSeq: 1, lastReceivedStateSeq: 1, lastRenderedStateSeq: 1,
    lastHeartbeatObservedRenderedStateSeq: 1, stateRenderStalledAcks: 2,
    latestPanelHeartbeatProgress: { renderedSeq: 1, previousRenderedSeq: 1, stalledAckCount: 2 },
    panelDocumentHasRenderedState: false, renderAckCount: 0, latestRenderDurationMs: null,
    renderAckLatencyMsLatest: null, renderAckLatencySamples: [], postState(immediate) { flushed.push(immediate); },
    recordPanelIncident() {},
  });
  subject.handlePanelStateRenderedAck({ documentGeneration: 2, seq: 2, renderDurationMs: 34 });
  assert.equal(subject.panelStateFlow.renderedSeq, 2);
  assert.equal(subject.panelStateFlow.outstandingRenderSeq, null);
  assert.equal(subject.panelStateFlow.deliveredSeq, 1);
  assert.equal(subject.lastDeliveredStateSeq, 1);
  assert.equal(subject.lastRenderedStateSeq, 2);
  assert.equal(subject.renderAckCount, 1);
  assert.equal(subject.lastHeartbeatObservedRenderedStateSeq, 2);
  assert.equal(subject.stateRenderStalledAcks, 0);
  assert.equal(subject.latestPanelHeartbeatProgress.stalledAckCount, 0);
  assert.equal(subject.renderAckLatencyMsLatest, 4);
  assert.deepEqual(flushed, [false]);
  const currentState = subject.panelStateFlow;
  subject.handlePanelStateRenderedAck({ documentGeneration: 1, seq: 3, renderDurationMs: 1 });
  assert.strictEqual(subject.panelStateFlow, currentState, "old document ACK cannot mutate the new document flow");
});

function createHeartbeatSubject() {
  const { ast, method } = extractMethod("handlePanelHeartbeatAck");
  const code = ts.transpileModule(`class Subject { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox = { PanelStateProgress_1: loaded.exports, PanelStateFlowControl_1: flowLoaded.exports, Number, Date, Math, clearTimeout() {}, compactPanelRenderEvidence: (value) => value };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const subject = new sandbox.Subject();
  Object.assign(subject, {
    panelDisposed: false, view: { visible: true }, panelHeartbeatId: 0, panelDocumentGeneration: 2,
    panelStateFlow: flowWithOutstanding(2, 0),
    lastDeliveredStateSeq: 0,
    lastPostedStateSeq: 0, lastReceivedStateSeq: 0, lastRenderedStateSeq: 0,
    lastHeartbeatObservedRenderedStateSeq: undefined, stateRenderStalledAcks: 0,
    panelHeartbeatTimeout: undefined, panelUnknownHealthSince: 0, panelUnknownHealthGeneration: 0,
    webviewDocumentVisible: true, panelDocumentHasRenderedState: false, webviewReady: true,
    recoveries: [], schedulePanelHeartbeat() {},
    recoverPanelHeartbeatFailure(reason) { this.recoveries.push(reason); },
    recordPanelIncident() {},
    updatePanelDocumentVisibility(visible) {
      if (this.webviewDocumentVisible !== visible) {
        this.webviewDocumentVisible = visible;
        this.stateRenderStalledAcks = 0;
        this.lastHeartbeatObservedRenderedStateSeq = undefined;
        this.latestPanelHeartbeatProgress = undefined;
      }
    },
  });
  return subject;
}

test("hidden and not-yet-renderable documents never accumulate sequence stalls", () => {
  for (const reason of ["document-hidden", "bootstrap", "awaiting-first-render", "state-render-pending", "render-health-probe-pending"]) {
    const subject = createHeartbeatSubject();
    subject.panelStateFlow = flowWithOutstanding(2, 1010, 100);
    for (let heartbeatId = 1; heartbeatId <= 10; heartbeatId += 1) {
      subject.panelHeartbeatId = heartbeatId;
      subject.lastPostedStateSeq = 1000 + heartbeatId;
      subject.handlePanelHeartbeatAck({
        heartbeatId, documentGeneration: 2, lastReceivedStateSeq: 1000 + heartbeatId,
        lastRenderedStateSeq: 100, renderHealth: { status: "unknown", reason },
      });
    }
    assert.deepEqual(Array.from(subject.recoveries), [], reason);
    assert.equal(subject.stateRenderStalledAcks, 0, reason);
    assert.equal(subject.lastHeartbeatObservedRenderedStateSeq, undefined, reason);
  }
});

test("visible healthy renderer still recovers after three heartbeats with no progress", () => {
  const subject = createHeartbeatSubject();
  subject.panelStateFlow = flowWithOutstanding(2, 20, 18);
  subject.panelDocumentHasRenderedState = true;
  subject.lastHeartbeatObservedRenderedStateSeq = 18;
  for (let heartbeatId = 1; heartbeatId <= 3; heartbeatId += 1) {
    subject.panelHeartbeatId = heartbeatId;
    subject.handlePanelHeartbeatAck({ heartbeatId, documentGeneration: 2,
      lastReceivedStateSeq: 20, lastRenderedStateSeq: 18,
      renderHealth: { status: "ok", reason: "render-completed" } });
  }
  assert.deepEqual(Array.from(subject.recoveries), ["state-render-sequence-stalled"]);
  assert.equal(subject.stateRenderStalledAcks, 3);
});

test("explicit frame-stall health takes precedence over sequence-stall recovery", () => {
  const subject = createHeartbeatSubject();
  subject.panelStateFlow = flowWithOutstanding(2, 20, 18);
  subject.panelDocumentHasRenderedState = true;
  subject.lastHeartbeatObservedRenderedStateSeq = 18;
  subject.stateRenderStalledAcks = 2;
  subject.panelHeartbeatId = 1;
  subject.handlePanelHeartbeatAck({ heartbeatId: 1, documentGeneration: 2,
    lastReceivedStateSeq: 20, lastRenderedStateSeq: 18,
    renderHealth: { status: "unhealthy", reason: "state-render-frame-stalled" } });
  assert.deepEqual(Array.from(subject.recoveries), ["state-render-frame-stalled"]);
});

test("one hundred hidden state updates stay pending and flush once on visibility", () => {
  const { ast, method } = extractMethod("postState");
  const code = ts.transpileModule(`class Subject { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let nextTimerId = 0;
  const timers = new Map();
  const calls = [];
  const sandbox = {
    PanelStateFlowControl_1: flowLoaded.exports,
    Date,
    setTimeout(callback, delay) { const id = ++nextTimerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const subject = new sandbox.Subject();
  Object.assign(subject, {
    panelLifecycleState: "ready", view: { visible: true }, webviewReady: true,
    panelStateFlow: flowLoaded.exports.createPanelStateFlowControlState(2, false),
    webviewDocumentVisible: false, statePostPending: false, statePostTimer: undefined,
    statePostInFlight: false, statePostImmediatePending: false,
    hiddenSuppressedStatePosts: 0, coalescedStatePosts: 0, lastFullStatePostAt: 0,
    statePostBatchMs: 100, statePostMinimumIntervalMs: 200,
    extensionRuntimeVersionState: () => ({ reloadRequired: false }),
    syncPanelStateFlowVisibility() {
      this.panelStateFlow = flowLoaded.exports.setPanelStateFlowVisibility(this.panelStateFlow, this.view.visible === true && this.webviewDocumentVisible === true);
    },
    realtimeRefreshPolicy: () => ({ uiBatchMs: 100 }),
    showPanelReloadRequired() {},
    flushStatePost(force) { calls.push(force); this.statePostPending = false; this.statePostTimer = undefined; },
  });
  for (let index = 0; index < 100; index += 1) subject.postState();
  assert.equal(subject.statePostPending, true);
  assert.equal(subject.hiddenSuppressedStatePosts, 100);
  assert.equal(timers.size, 0);
  assert.deepEqual(calls, []);
  subject.webviewDocumentVisible = true;
  subject.postState(true);
  assert.deepEqual(calls, [true]);
});

test("host visibility transition resets stall evidence and forces one latest state", () => {
  const { ast, method } = extractMethod("updatePanelDocumentVisibility");
  const { ast: visibilityAst, method: visibilityMethod } = extractMethod("syncPanelStateFlowVisibility");
  const code = ts.transpileModule(`class Subject { ${method.getText(ast)} ${visibilityMethod.getText(visibilityAst)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox = { PanelStateFlowControl_1: flowLoaded.exports, clearTimeout() {}, compactPanelRenderEvidence: (value) => value };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const subject = new sandbox.Subject();
  const posts = [];
  Object.assign(subject, {
    view: { visible: true }, panelStateFlow: flowLoaded.exports.createPanelStateFlowControlState(2, false),
    webviewDocumentVisible: false, statePostPending: false, statePostTimer: undefined,
    lastHeartbeatObservedRenderedStateSeq: 100, stateRenderStalledAcks: 2,
    latestPanelHeartbeatProgress: { renderedSeq: 100, previousRenderedSeq: 100, stalledAckCount: 2 },
    postState(immediate) { posts.push(immediate); },
    refreshResultCatalogForCurrentInterest() {},
    recordPanelIncident() {},
  });
  subject.updatePanelDocumentVisibility(true);
  subject.updatePanelDocumentVisibility(true);
  assert.equal(subject.webviewDocumentVisible, true);
  assert.equal(subject.statePostPending, true);
  assert.equal(subject.lastHeartbeatObservedRenderedStateSeq, undefined);
  assert.equal(subject.stateRenderStalledAcks, 0);
  assert.equal(subject.latestPanelHeartbeatProgress, undefined);
  assert.deepEqual(posts, [true]);
});

test("ordinary state updates coalesce at uiBatchMs with a 200 ms full-state floor", () => {
  const { ast, method } = extractMethod("postState");
  const code = ts.transpileModule(`class Subject { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let nextTimerId = 0;
  const timers = new Map();
  const calls = [];
  const sandbox = {
    PanelStateFlowControl_1: flowLoaded.exports,
    Date,
    setTimeout(callback, delay) { const id = ++nextTimerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const subject = new sandbox.Subject();
  Object.assign(subject, {
    panelLifecycleState: "ready", view: { visible: true }, webviewReady: true,
    panelStateFlow: flowLoaded.exports.createPanelStateFlowControlState(2, true),
    webviewDocumentVisible: true, statePostPending: false, statePostTimer: undefined,
    statePostInFlight: false, statePostImmediatePending: false,
    hiddenSuppressedStatePosts: 0, coalescedStatePosts: 0, lastFullStatePostAt: 0,
    statePostBatchMs: 100, statePostMinimumIntervalMs: 200,
    extensionRuntimeVersionState: () => ({ reloadRequired: false }),
    syncPanelStateFlowVisibility() {
      this.panelStateFlow = flowLoaded.exports.setPanelStateFlowVisibility(this.panelStateFlow, this.view.visible === true && this.webviewDocumentVisible === true);
    },
    realtimeRefreshPolicy: () => ({ uiBatchMs: 100 }),
    showPanelReloadRequired() {},
    flushStatePost(force) { calls.push(force); this.statePostPending = false; this.statePostTimer = undefined; },
  });
  for (let index = 0; index < 100; index += 1) subject.postState();
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 200);
  assert.equal(subject.coalescedStatePosts, 99);
  [...timers.values()][0].callback();
  assert.deepEqual(calls, [false]);
});

test("new document stamp and disposal reset the heartbeat render-progress tracker", () => {
  const { ast: stampAst, method: stampMethod } = extractMethod("stampPanelDocument");
  const stampSource = stampMethod.getText(stampAst);
  assert.match(stampSource, /this\.resetPanelStateProgress\(true\)/);
  const { ast: disposeAst, method: disposeMethod } = extractMethod("dispose");
  assert.match(disposeMethod.getText(disposeAst), /this\.resetPanelStateProgress\(true\)/);

  const { ast, method } = extractMethod("resetPanelStateProgress");
  const code = ts.transpileModule(`class Subject { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const canceledTimers = [];
  const sandbox = { PanelStateFlowControl_1: flowLoaded.exports, clearTimeout(id) { canceledTimers.push(id); } };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const subject = new sandbox.Subject();
  subject.lastHeartbeatObservedRenderedStateSeq = 19;
  subject.stateRenderStalledAcks = 2;
  subject.lastReceivedStateSeq = 5593;
  subject.lastRenderedStateSeq = 3640;
  subject.stateSequence = 5593;
  subject.panelDocumentHasRenderedState = true;
  subject.latestPanelHeartbeatProgress = { renderedSeq: 19, previousRenderedSeq: 18, stalledAckCount: 2 };
  Object.assign(subject, {
    statePostAttemptId: 7, statePostInFlight: true, statePostPending: true,
    statePostImmediatePending: true, statePostRetryCount: 2,
    statePostTimer: 10, statePostRetryTimer: 11,
  });
  subject.resetPanelStateProgress(true);
  assert.equal(subject.statePostAttemptId, 8, "a new document invalidates completion callbacks from the old document");
  assert.equal(subject.statePostInFlight, false);
  assert.equal(subject.statePostPending, false);
  assert.equal(subject.statePostImmediatePending, false);
  assert.equal(subject.statePostRetryCount, 0);
  assert.equal(subject.statePostTimer, undefined);
  assert.equal(subject.statePostRetryTimer, undefined);
  assert.deepEqual(canceledTimers, [10, 11]);
  assert.equal(subject.lastHeartbeatObservedRenderedStateSeq, undefined);
  assert.equal(subject.stateRenderStalledAcks, 0);
  assert.equal(subject.latestPanelHeartbeatProgress, undefined);
  assert.equal(subject.lastReceivedStateSeq, 0);
  assert.equal(subject.lastRenderedStateSeq, 0);
  assert.equal(subject.panelDocumentHasRenderedState, false);
  assert.equal(subject.stateSequence, 5593, "document reset must keep the provider-wide state sequence monotonic");
});
