const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
require("../_helpers/registerTsRequire");
const { readSource } = require("../_helpers/sourceReader");
const legacyMethod = require("../_helpers/legacyMethod");
const panelFunction = require("../_helpers/panelFunction");
const { RealtimeTunnelClient, defaultRealtimeRefreshPolicy } = require("../../src/tunnel/RealtimeTunnelClient.ts");
const { MultiEndpointRealtimeClient } = require("../../src/tunnel/MultiEndpointRealtimeClient.ts");
const { RequestBudget } = require("../../src/tunnel/RequestBudget.ts");

// r2-final-1 rework coverage (GPT review of PR #25). Every assertion runs the real production
// artefact: the real tunnel client, the real multi-endpoint aggregator, the extracted host methods,
// or the rendered panel script. Nothing is reimplemented in the fixture.
const source = readSource("src/extension/legacy.ts");
const json = (value) => JSON.stringify(value);
const endpoint = (id) => ({ id, role: "worker", displayName: id, localHost: "localhost", localPort: 18765, remoteAgentPort: 18765 });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function transpile(members) {
  return ts.transpileModule("globalThis.api = {" + members.map((body) => body.replace(/^ {4}/gm, "").replace(/^private\s+/gm, "")).join(",\n") + "};", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function hostFixture(members) {
  const calls = { applyTrafficScheduling: 0, policyAtApply: [], posts: 0 };
  const sandbox = {
    console,
    stringField: (message, key) => String((message && typeof message === "object" ? message[key] : "") || ""),
    errorMessage: (error) => String((error && error.message) || error),
    NORMAL_TRAFFIC_INTERVALS: { queueMs: 500, progressMs: 2000, tmuxMs: 5000, snapshotFallbackSeconds: 5 },
    LOW_TRAFFIC_INTERVALS: { queueMs: 5000, progressMs: 10000, tmuxMs: 0, snapshotFallbackSeconds: 0 },
    GpuHistoryState_1: { normalizeGpuHistoryQuery: (query) => ({ ...query }) },
    objectRecord: (value) => (value && typeof value === "object" ? value : undefined),
    numberField: (message, key) => (message && typeof message === "object" && typeof message[key] === "number" ? message[key] : undefined),
  };
  vm.runInNewContext(transpile(members), sandbox);
  const host = {
    lowTrafficMode: true,
    projectContextGeneration: 1,
    lastHealth: undefined,
    lastError: undefined,
    budget: { isPaused: () => false },
    tunnelConfig: { refreshProfile: "realtime", pauseAllBackgroundTraffic: false, allowStreaming: true, pauseWhenWebviewHidden: true },
    view: { visible: true, webview: { postMessage: (payload) => { (host.posted || (host.posted = [])).push(payload); return true; } } },
    client: {
      resume() { calls.resume = (calls.resume || 0) + 1; },
      pauseAll() { calls.pauseAll = (calls.pauseAll || 0) + 1; },
      disconnect: async () => { calls.disconnect = (calls.disconnect || 0) + 1; },
      connect: async () => { calls.connect = (calls.connect || 0) + 1; },
      diagnostics: () => ({ endpoints: [], }),
    },
    projectBootstrapPromise: Promise.resolve(),
    restoreRemotePlanOperations: async () => undefined,
    reconcileStalePlanRunOperations: async () => undefined,
    clearOfflineImport: async () => undefined,
    ensureRealtimeConnected: async () => undefined,
    postState: () => { calls.posts += 1; },
    applyTrafficScheduling() {
      calls.applyTrafficScheduling += 1;
      calls.policyAtApply.push(sandbox.api.effectiveTrafficPolicy ? sandbox.api.effectiveTrafficPolicy.call(host) : undefined);
    },
    posted: [],
  };
  Object.assign(host, sandbox.api);
  return { host, api: sandbox.api, calls };
}

test("r2: the shared policy object and the module default are never mutated, and endpoints stay independent", async () => {
  assert.equal(Object.isFrozen(defaultRealtimeRefreshPolicy), true, "the module default policy must be frozen");
  const before = json(defaultRealtimeRefreshPolicy);
  const shared = { ...defaultRealtimeRefreshPolicy };
  const first = new RealtimeTunnelClient(endpoint("w1"), new RequestBudget(), shared);
  const second = new RealtimeTunnelClient(endpoint("w2"), new RequestBudget(), shared);
  try {
    first.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    assert.equal(json(shared), before, "the caller's policy snapshot must not be written in place");
    assert.equal(json(defaultRealtimeRefreshPolicy), before, "the module default must stay untouched");
    assert.equal(first.policy.displayAutoRefresh, false);
    assert.equal(second.policy.displayAutoRefresh, true, "another endpoint must not see the first endpoint's change");
    assert.equal(second.policy.snapshotFallbackIntervalSeconds, defaultRealtimeRefreshPolicy.snapshotFallbackIntervalSeconds);
    // Restoring the first endpoint compares against its OWN previous view, so it cannot early-return.
    let firstConnects = 0;
    first.connect = async () => { firstConnects += 1; first.status = "polling"; };
    first.updateRefreshPolicy({ displayAutoRefresh: true, snapshotFallbackIntervalSeconds: 5 });
    await tick();
    assert.ok(firstConnects >= 1, "the endpoint the guard closed must actually re-arm on restore");
    assert.equal(first.policy.snapshotFallbackIntervalSeconds, 5);
    assert.equal(second.policy.displayAutoRefresh, true, "the other endpoint is still untouched");
  }
  finally { await first.disconnect("dispose"); await second.disconnect("dispose"); }
});

test("r2: the multi-endpoint client hands every endpoint its own copy and restores each of them", async () => {
  const before = json(defaultRealtimeRefreshPolicy);
  const shared = { ...defaultRealtimeRefreshPolicy };
  const multi = new MultiEndpointRealtimeClient([endpoint("w1"), endpoint("w2")], () => new RequestBudget(), shared);
  const children = [...multi.clients.values()];
  assert.equal(children.length, 2);
  assert.notEqual(children[0].policy, children[1].policy, "no policy object may be shared between endpoints");
  try {
    multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    assert.equal(json(shared), before, "the aggregator must not mutate the caller's snapshot either");
    assert.ok(children.every((child) => child.policy.displayAutoRefresh === false && child.policy.snapshotFallbackIntervalSeconds === 0),
      "every endpoint applies the guard, not only the first one");
    const guarded = multi.diagnostics();
    assert.equal(guarded.displayAutoRefreshDisabled, true);
    assert.equal(guarded.displayAutoClosed, true, "all endpoints closed by the guard is reported as such");
    let restores = 0;
    for (const child of children) child.connect = async () => { restores += 1; };
    multi.updateRefreshPolicy({ displayAutoRefresh: true, snapshotFallbackIntervalSeconds: 5 });
    await tick();
    assert.equal(restores, 2, "each endpoint restores independently instead of an early return on a shared value");
    assert.ok(children.every((child) => child.policy.displayAutoRefresh === true && child.policy.snapshotFallbackIntervalSeconds === 5));
  }
  finally { await multi.disconnect("dispose"); }
});

test("r3: a guarded display closure is not an outage, a real connection loss still is", async () => {
  const client = new RealtimeTunnelClient(endpoint("w1"), new RequestBudget());
  try {
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await client.connect();
    let diagnostics = client.diagnostics();
    assert.equal(diagnostics.streamStatus, "disconnected");
    assert.equal(diagnostics.displayAutoRefreshDisabled, true);
    assert.equal(diagnostics.displayAutoClosed, true, "the closure is explained by the guard");
    assert.equal(diagnostics.lastError, undefined, "no connection error may be invented for the guard");
    // A real failure has to stay visible.
    client.connectionLost("socket hang up");
    diagnostics = client.diagnostics();
    assert.equal(diagnostics.displayAutoClosed, false, "a real loss clears the guard explanation");
    assert.match(String(diagnostics.lastError), /socket hang up/);
  }
  finally { await client.disconnect("dispose"); }
});

test("r3: the host does not publish tunnel_unavailable for a guarded closure and still reports a real failure", async () => {
  const members = [legacyMethod(source, "effectiveTrafficPolicy()"), legacyMethod(source, "ensureRealtimeConnected(_reason)")];
  const fixture = hostFixture(members);
  const { host, calls } = fixture;
  host.isRealtimeMode = () => true;
  host.applyTrafficScheduling = () => { calls.applyTrafficScheduling += 1; };
  host.client.diagnostics = () => ({
    endpoints: [{ id: "w1", streamStatus: "disconnected", displayAutoRefreshDisabled: true, displayAutoClosed: true }],
    displayAutoRefreshDisabled: true,
    displayAutoClosed: true,
  });
  await host.ensureRealtimeConnected("resume network");
  assert.notEqual(host.lastError, "tunnel_unavailable", "a guarded closure must not be published as an outage");
  assert.equal(host.lastHealth, undefined, "no fake local_port_closed health may be produced");

  // The same code path still reports a real outage.
  const broken = hostFixture(members);
  broken.host.lowTrafficMode = false; // Preserve the original normal-mode path alongside §20 low traffic.
  broken.host.isRealtimeMode = () => true;
  broken.host.applyTrafficScheduling = () => { broken.calls.applyTrafficScheduling += 1; };
  broken.host.client.diagnostics = () => ({
    endpoints: [{ id: "w1", streamStatus: "disconnected", displayAutoRefreshDisabled: false, displayAutoClosed: false }],
    displayAutoRefreshDisabled: false,
    displayAutoClosed: false,
  });
  await broken.host.ensureRealtimeConnected("startup");
  assert.equal(broken.host.lastError, "tunnel_unavailable");
  assert.equal(broken.host.lastHealth.status, "local_port_closed");
});

test("r4: pause, resume and a client reset converge the strategy on the current toggle", async () => {
  const members = [
    legacyMethod(source, "effectiveTrafficPolicy()"),
    legacyMethod(source, "pauseAllNetworkActivity()"),
    legacyMethod(source, "resumeNetwork()"),
  ];
  const fixture = hostFixture(members);
  const { host, api, calls } = fixture;
  // Pause: the stronger constraint is recorded first, then the whole strategy is recomputed.
  await api.pauseAllNetworkActivity.call(host);
  assert.equal(host.lastHealth.state, "paused");
  assert.equal(calls.applyTrafficScheduling, 1, "pause must re-apply the strategy, not only the host timers");
  // Resume: the stale pause evidence is dropped so the policy follows the persisted toggle, and the
  // display gate that the toggle closed stays closed.
  await api.resumeNetwork.call(host);
  assert.notEqual(host.lastHealth && host.lastHealth.state, "paused", "a resume must not keep claiming a pause");
  assert.ok(calls.applyTrafficScheduling >= 2, "resume must recompute the strategy after fresh evidence");
  const applied = calls.policyAtApply.filter(Boolean).pop();
  assert.equal(applied.displayAutoRefresh, false, "the restored policy keeps A-class display traffic off while the toggle is on");
  assert.equal(applied.blockedBy, "");

  // The reset path converges as well (config change → new client → re-applied strategy).
  const resetBody = legacyMethod(source, "resetClient()");
  assert.match(resetBody, /this\.applyTrafficScheduling\(\);/, "a client reset must re-apply cadence and guard");
  assert.match(resetBody, /this\.displayReadInFlight\.clear\(\);/, "a reset must not let a new round join an older display read");
  assert.match(legacyMethod(source, "ensureRealtimeConnected(_reason)"), /this\.applyTrafficScheduling\(\);/,
    "the connection path must converge the strategy on fresh evidence");
});

test("r1: automatic GPU history entries produce no request under the guard, a manual key still gets its round", () => {
  const posted = [];
  const sandbox = {
    console,
    Date,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    vscode: { postMessage: (message) => { posted.push(message); return true; } },
    gpuHistoryRequestLastAt: new Map(),
    GPU_HISTORY_REQUEST_COOLDOWN_MS: 4000,
    GPU_HISTORY_SERIES_CACHE_LIMIT: 8,
    gpuWindowPendingByKey: new Map(),
    gpuWindowPending: new Map(),
    gpuWindowRequestSeq: 0,
    gpuWindowFineWindowMs: () => 60000,
    lastState: { trafficMode: { enabled: true, displayAutoRefresh: false } },
    tmuxDisplayAutoHint: true,
    notices: 0,
  };
  const code = [
    panelFunction("lowTrafficModeFromState"),
    panelFunction("displayAutoAllowed"),
    panelFunction("gpuHistorySeriesKey"),
    panelFunction("requestGpuHistoryRemote"),
    panelFunction("requestGpuHistory"),
    "function renderDisplayAutoNotices() { this.notices += 1; }",
    "this.request = requestGpuHistory; this.remote = requestGpuHistoryRemote;",
  ].join("\n");
  vm.runInNewContext(code, sandbox, { filename: "panel-gpu.js" });
  sandbox.notices = 0;
  // Expansion / snapshot follow-up / ring fallback: automatic, so nothing leaves the machine.
  assert.equal(sandbox.request({ serverId: "srv", gpuId: "0", maxPoints: 288 }, true, "auto"), false, "expanding a series must not fetch in low traffic");
  assert.equal(sandbox.request({ maxPoints: 96 }, undefined, undefined), false, "an origin-less (automatic) follow-up must not fetch either");
  assert.deepEqual(posted, [], "no loadGpuHistory or gpuWindowSamples message may be produced by an automatic entry");
  assert.equal(sandbox.notices >= 1, true, "the area reports why nothing refreshed");
  assert.equal(sandbox.gpuHistoryRequestLastAt.size, 0, "a blocked automatic entry must not burn the cooldown of its key");
  // The explicit manual entry still performs exactly one round per key, tagged as user traffic.
  assert.equal(sandbox.request({ maxPoints: 96 }, true, "user"), true);
  assert.deepEqual(posted.map((message) => message.command), ["loadGpuHistory"], "one history round for the clicked key");
  assert.equal(posted[0].origin, "user", "the host must be able to tell this apart from automatic traffic");
  // A per-series round first asks the local host ring and remembers its origin, so the eventual
  // remote fallback of that same round is still an explicit user round.
  assert.equal(sandbox.request({ serverId: "srv", gpuId: "0", maxPoints: 288 }, true, "user"), true);
  const entry = [...sandbox.gpuWindowPendingByKey.values()][0];
  assert.equal(entry.origin, "user", "the ring fallback keeps the origin of the round that started it");
  assert.equal(sandbox.remote({ serverId: "srv", gpuId: "1" }, "user"), true);
  assert.equal(sandbox.remote({ serverId: "srv", gpuId: "1" }, "auto"), false, "the ring fallback may not turn into automatic traffic");
  // In normal mode the same automatic entry behaves exactly as before.
  sandbox.lastState = { trafficMode: { enabled: false, displayAutoRefresh: true } };
  posted.length = 0;
  assert.equal(sandbox.request({ maxPoints: 96 }, true, "auto"), true, "normal mode keeps its automatic history refresh");
  assert.equal(posted.length, 1);
});

test("r1: the host refuses an automatic GPU history round in low traffic and answers a manual round per key", async () => {
  const members = [legacyMethod(source, "effectiveTrafficPolicy()"), legacyMethod(source, "displayReadBlockedFor(message)"),
    legacyMethod(source, "loadGpuHistoryFromUi(message)")];
  const fixture = hostFixture(members);
  const { host } = fixture;
  let loads = 0;
  host.effectiveConnectionMode = () => "realtime";
  host.lastProbe = { capabilities: { endpoints: { gpuHistory: true } } };
  host.gpuHistoryState = {
    load: (query, loader) => { loads += 1; return loader(query).then(() => undefined); },
  };
  host.client.getGpuHistory = async () => ({ ok: true });
  await host.loadGpuHistoryFromUi({ serverId: "srv", gpuId: "0" });
  assert.equal(loads, 0, "an automatic history request must not reach the client in low traffic");
  assert.deepEqual(host.posted, [], "no result frame may claim a sample that never happened");
  await host.loadGpuHistoryFromUi({ serverId: "srv", gpuId: "0", origin: "user" });
  assert.equal(loads, 1, "the explicit manual entry still performs its round");
  const frame = host.posted.find((message) => message.type === "gpuHistoryResult");
  assert.ok(frame, "the round is answered so the panel can record the real sample time");
  assert.deepEqual([frame.ok, frame.serverId, frame.gpuId, frame.origin], [true, "srv", "0", "user"]);
  assert.ok(frame.fetchedAt, "the answer carries the actual completion time");
  // Normal mode keeps the automatic round.
  const normal = hostFixture(members);
  normal.host.lowTrafficMode = false;
  normal.host.effectiveConnectionMode = () => "realtime";
  normal.host.lastProbe = { capabilities: { endpoints: { gpuHistory: true } } };
  let normalLoads = 0;
  normal.host.gpuHistoryState = { load: (query, loader) => { normalLoads += 1; return loader(query).then(() => undefined); } };
  normal.host.client.getGpuHistory = async () => ({ ok: true });
  await normal.host.loadGpuHistoryFromUi({ maxPoints: 96 });
  assert.equal(normalLoads, 1, "normal mode still refreshes GPU history automatically");
});

test("r1: every display area states the real sample or manual time, and the hint polarity is consistent", () => {
  const mode = { trafficMode: { enabled: true, displayAutoRefresh: false } };
  const sandbox = { console, Date, lastState: mode, tmuxDisplayAutoHint: true, displayRefreshAt: new Map([["tmuxList|fetch", "10:00:00"]]) };
  vm.runInNewContext(panelFunction("lowTrafficModeFromState") + "\n" + panelFunction("displaySampleNotice")
    + "\nthis.notice = displaySampleNotice;", sandbox, { filename: "panel-notice.js" });
  const blocked = sandbox.notice("tmuxList");
  assert.match(blocked, /自动刷新已关闭/, "the hint is shown while the guard is on");
  assert.match(blocked, /当前缓存采样于 10:00:00/, "a cached sample is labelled as cached and as never manually refreshed");
  assert.match(blocked, /尚未手动刷新/);
  sandbox.displayRefreshAt.set("tmuxList|manual", "10:30:00");
  assert.match(sandbox.notice("tmuxList"), /上次手动刷新 10:30:00/);
  assert.match(sandbox.notice("gpuHistory:srv::0", "09:15:00"), /当前缓存采样于 09:15:00/, "a GPU key without its own sample falls back to the real curve time");
  assert.match(sandbox.notice("gpuHistory:srv::1", ""), /尚未手动刷新/, "no cache and no manual click says so plainly");
  sandbox.lastState = { trafficMode: { enabled: false, displayAutoRefresh: true } };
  assert.equal(sandbox.notice("tmuxList"), "", "normal mode shows no low-traffic hint at all");
  // The persisted pre-handshake hint is written and read with the same polarity (true = off), and the
  // old inverted key is gone.
  const rendered = panelFunction("applyLowTrafficModeState");
  assert.match(rendered, /persistWebviewState\(\{ lowTrafficDisplayAutoOff: mode\.displayAutoRefresh === false \}\)/);
  const script = require("../../dist/ui/PanelHtml").renderPanelHtml();
  assert.doesNotMatch(script, /lowTrafficDisplayAuto:/, "the inverted hint key must be gone");
  assert.match(script, /restoredWebviewState\.lowTrafficDisplayAutoOff === true/, "the initial hint reads the same polarity it was written with");
  assert.match(script, /lowTrafficDisplayAutoOff: !displayAutoAllowed\("auto"\)/);
});

test("r6: the confirmed receipt drives both the label and the next click target, and a stale requestId cannot cancel the current timer", () => {
  const sandbox = {
    console,
    Date,
    setTimeout: () => 77,
    clearTimeout: (id) => { sandbox.cleared.push(id); },
    cleared: [],
    lowTrafficTogglePending: { target: true, requestId: "ltm-2" },
    lowTrafficReceiptDisplay: null,
    lowTrafficReceiptNotice: "",
    lowTrafficReceiptTimer: 77,
    lastState: { trafficMode: { enabled: false } },
  };
  vm.runInNewContext([
    panelFunction("clearLowTrafficReceiptTimer"),
    panelFunction("handleLowTrafficModeReceipt"),
    panelFunction("lowTrafficDisplayEnabled"),
    "function applyLowTrafficModeState() {}",
    "this.receipt = handleLowTrafficModeReceipt; this.enabled = lowTrafficDisplayEnabled;",
  ].join("\n"), sandbox, { filename: "panel-receipt.js" });
  // A receipt for an abandoned request must not touch the current request's timer or display.
  sandbox.receipt({ ok: true, enabled: true, requestId: "ltm-1" });
  assert.deepEqual(sandbox.cleared, [], "a stale requestId must not cancel the pending request's timeout timer");
  assert.equal(sandbox.lowTrafficTogglePending.requestId, "ltm-2");
  assert.equal(sandbox.lowTrafficReceiptDisplay, null, "a stale receipt is not a confirmation");
  // The matching receipt confirms the value before the authoritative state frame arrives; the label
  // and the next target read the same confirmed value.
  sandbox.receipt({ ok: true, enabled: true, requestId: "ltm-2" });
  assert.equal(sandbox.lowTrafficTogglePending, null);
  assert.deepEqual(sandbox.cleared, [77]);
  assert.equal(sandbox.lowTrafficReceiptDisplay.enabled, true);
  assert.equal(sandbox.enabled(sandbox.lastState.trafficMode), true, "the display follows the confirmed value");
  assert.equal(!sandbox.enabled(sandbox.lastState.trafficMode), false, "the next click targets the confirmed value, not the stale state frame");
  // A late failure for a request already given up on keeps the current display.
  sandbox.lowTrafficReceiptDisplay = { enabled: true, until: Date.now() + 5000 };
  sandbox.lowTrafficReceiptNotice = "";
  sandbox.receipt({ ok: false, error: "late", requestId: "ltm-0" });
  assert.equal(sandbox.lowTrafficReceiptDisplay.enabled, true, "an unrelated late failure must not flip the display");
  assert.equal(sandbox.lowTrafficReceiptNotice, "");
  // The panel never computes the target from the raw state any more.
  const rendered = require("../../dist/ui/PanelHtml").renderPanelHtml();
  assert.match(rendered, /const lowTrafficTarget = !lowTrafficDisplayEnabled\(lowTrafficModeFromState\(lastState \|\| \{\}\)\);/);
});

// r2-final-2 rework coverage (GPT second final review of PR #25, items B1 and B2). Both tests walk a
// continuous state sequence instead of a single call, and they run the real production artefacts:
// the real tunnel client, the real multi-endpoint aggregator and the extracted host method for B1;
// the rendered production panel functions for B2.
test("r3/b1: a real outage keeps its attribution through guard, loss, repeated policy, connect and host ensure", async () => {
  const multi = new MultiEndpointRealtimeClient([endpoint("w1")], () => new RequestBudget());
  const child = [...multi.clients.values()][0];
  const members = [legacyMethod(source, "effectiveTrafficPolicy()"), legacyMethod(source, "ensureRealtimeConnected(_reason)")];
  const fixture = hostFixture(members);
  const { host } = fixture;
  host.isRealtimeMode = () => true;
  // The host method under test talks to the real aggregator over the real client: no diagnostics stub.
  host.client = { connect: async () => { await multi.connect(); }, diagnostics: () => multi.diagnostics() };
  try {
    // Step 1 - our own closure: no display stream, reported as a policy closure, no invented outage.
    multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await host.ensureRealtimeConnected("startup");
    let diagnostics = multi.diagnostics();
    assert.equal(diagnostics.displayAutoRefreshDisabled, true);
    assert.equal(diagnostics.displayAutoClosed, true, "step 1: the guard closure is attributed to the policy");
    assert.ok(diagnostics.endpoints.every((item) => !item.lastError), "step 1: no connection error may be invented");
    assert.notEqual(host.lastError, "tunnel_unavailable", "step 1: a pure guard closure must not look like an outage");
    assert.equal(host.lastHealth, undefined, "step 1: no fake local_port_closed health for the guard");

    // Step 2 - a real soft connection loss while the mode stays on, then the very same policy and
    // connect are applied again plus another host ensure: the outage attribution must survive.
    child.connectionLost("socket hang up");
    diagnostics = multi.diagnostics();
    assert.equal(diagnostics.displayAutoClosed, false, "step 2: a real loss clears the guard explanation");
    assert.match(String(diagnostics.endpoints[0].lastError), /socket hang up/);
    multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await multi.connect();
    await host.ensureRealtimeConnected("resume network");
    diagnostics = multi.diagnostics();
    assert.equal(diagnostics.displayAutoClosed, false, "step 2: repeating the same policy cannot rewrite the outage into a guard closure");
    assert.match(String(diagnostics.endpoints[0].lastError), /socket hang up/, "step 2: the failure evidence is kept");
    assert.equal(host.lastError, "tunnel_unavailable", "step 2: a real outage is still published as unavailable");
    assert.equal(host.lastHealth, undefined, "step 2: display transport failure does not invent a port probe");
    assert.match(String(child.diagnostics().lastError), /socket hang up/, "step 2: the original transport evidence remains");

    // Step 3 - recovery attempt: restoring the cadence re-arms the real connection, but until a
    // connection actually succeeds the endpoint stays disconnected and keeps the failure attribution
    // (no fake online, and no silent reclassification as a guard closure either).
    let restores = 0;
    child.connect = async () => { restores += 1; };
    multi.updateRefreshPolicy({ displayAutoRefresh: true, snapshotFallbackIntervalSeconds: 5 });
    await tick();
    assert.equal(restores, 1, "step 3: restoring the policy re-arms a real connection round");
    diagnostics = multi.diagnostics();
    assert.equal(diagnostics.endpoints[0].streamStatus, "disconnected", "step 3: nothing is presented as online without a connection");
    assert.equal(diagnostics.displayAutoClosed, false, "step 3: the outage is not relabelled as the guard");
    assert.match(String(diagnostics.endpoints[0].lastError), /socket hang up/, "step 3: the failure evidence survives the restore");
  }
  finally { await multi.disconnect("dispose"); }
});

test("r3/b1: a hard authentication failure stays a manual-reconnect outage through repeated policy and ensure", async () => {
  const multi = new MultiEndpointRealtimeClient([endpoint("w1")], () => new RequestBudget());
  const child = [...multi.clients.values()][0];
  const members = [legacyMethod(source, "effectiveTrafficPolicy()"), legacyMethod(source, "ensureRealtimeConnected(_reason)")];
  const fixture = hostFixture(members);
  const { host } = fixture;
  host.isRealtimeMode = () => true;
  host.client = { connect: async () => { await multi.connect(); }, diagnostics: () => multi.diagnostics() };
  try {
    multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await host.ensureRealtimeConnected("startup");
    assert.equal(multi.diagnostics().displayAutoClosed, true, "the guard closure alone is still reported as the guard");
    // A hard error (auth/version) is a real outage with a manual-reconnect requirement.
    child.connectionLost("HTTP 401 unauthorized");
    multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await host.ensureRealtimeConnected("resume network");
    const diagnostics = multi.diagnostics();
    assert.equal(diagnostics.displayAutoClosed, false, "a hard failure must never be attributed to the guard");
    assert.equal(child.diagnostics().requiresManualReconnect, true, "the manual-reconnect evidence is kept on the real endpoint client");
    assert.match(String(diagnostics.endpoints[0].lastError), /401/, "the real failure text is kept");
    assert.match(String(diagnostics.lastError), /401/, "the aggregator still surfaces the real failure upward");
    assert.equal(host.lastError, "tunnel_unavailable", "the hard failure is still published as unavailable");
    assert.equal(host.lastHealth, undefined, "401 is not evidence of an observed closed local port");
    assert.match(String(child.diagnostics().lastError), /401/, "the authentication evidence remains");
  }
  finally { await multi.disconnect("dispose"); }
});

test("r6/b2: a receipt without an outstanding request has no display, timer or next-target effect through the whole sequence", () => {
  const timers = new Map();
  let nextTimer = 1;
  const sandbox = {
    console,
    Date,
    timers,
    setTimeout: (fn, _ms) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); sandbox.cleared.push(id); },
    cleared: [],
    LOW_TRAFFIC_RECEIPT_TIMEOUT_MS: 5000,
    lowTrafficToggleSeq: 0,
    lowTrafficTogglePending: null,
    lowTrafficReceiptDisplay: null,
    lowTrafficReceiptNotice: "",
    lowTrafficReceiptTimer: 0,
    // The persisted preference of this panel is "off"; every step below must keep showing that until
    // a receipt bound to the outstanding request says otherwise.
    lastState: { trafficMode: { enabled: false } },
  };
  vm.runInNewContext([
    panelFunction("clearLowTrafficReceiptTimer"),
    panelFunction("beginLowTrafficToggle"),
    panelFunction("handleLowTrafficModeReceipt"),
    panelFunction("lowTrafficDisplayEnabled"),
    "function applyLowTrafficModeState() {}",
    "this.receipt = handleLowTrafficModeReceipt; this.enabled = lowTrafficDisplayEnabled; this.begin = beginLowTrafficToggle;",
  ].join("\n"), sandbox, { filename: "panel-receipt-sequence.js" });
  const mode = sandbox.lastState.trafficMode;
  const shown = () => sandbox.enabled(mode);
  const nextTarget = () => !shown();
  const fireTimeout = () => { const fn = [...timers.values()].pop(); timers.clear(); fn(); };

  // Round 1: the request is given up on after the timeout, so the display falls back to the
  // authoritative persisted value and the next target stays "turn it on".
  sandbox.begin(true, "ltm-1");
  assert.equal(sandbox.lowTrafficTogglePending.requestId, "ltm-1");
  assert.equal(shown(), true, "while a request is outstanding the pending target is shown");
  fireTimeout();
  assert.equal(sandbox.lowTrafficTogglePending, null);
  assert.ok(String(sandbox.lowTrafficReceiptNotice).indexOf("未收到回执") >= 0, "the timeout tells the user the result is unknown");
  assert.equal(shown(), false, "after giving up the display shows the persisted preference again");
  assert.equal(nextTarget(), true);

  // Round 2: a matching receipt confirms "off" - label, aria value and next target all move together.
  const clearedBeforeRound2 = sandbox.cleared.length;
  sandbox.begin(false, "ltm-2");
  sandbox.receipt({ ok: true, enabled: false, requestId: "ltm-2" });
  assert.equal(sandbox.cleared.length, clearedBeforeRound2 + 1, "only the outstanding request's timer is cancelled");
  assert.equal(shown(), false, "the confirmed value is shown");
  assert.equal(nextTarget(), true, "the next click targets the confirmed value");

  // A late success for the abandoned ltm-1 must be completely inert: no display change, no timer
  // churn, no next-target flip.
  const inertTimerOps = sandbox.cleared.length;
  sandbox.receipt({ ok: true, enabled: true, requestId: "ltm-1" });
  assert.equal(sandbox.cleared.length, inertTimerOps, "an abandoned receipt touches no timer");
  assert.equal(sandbox.lowTrafficTogglePending, null, "an abandoned receipt cannot re-open a pending state");
  assert.equal(shown(), false, "an abandoned success must not roll the display back");
  assert.equal(nextTarget(), true, "the next target still equals the latest confirmed preference");

  // A duplicate receipt for the already confirmed request, and a receipt without identity, are inert
  // as well.
  sandbox.receipt({ ok: true, enabled: true, requestId: "ltm-2" });
  assert.equal(shown(), false, "a duplicate receipt for a finished request is inert");
  sandbox.receipt({ ok: true, enabled: true });
  assert.equal(shown(), false, "a receipt without requestId is inert");
  assert.equal(sandbox.cleared.length, inertTimerOps, "neither duplicate nor identity-free receipt touches the timer");

  // Round 3: a matching failure keeps the persisted value and says so; the next target is unchanged.
  sandbox.begin(true, "ltm-3");
  assert.equal(shown(), true, "the outstanding round shows its target");
  sandbox.receipt({ ok: false, error: "globalState 写入失败", requestId: "ltm-3" });
  assert.equal(sandbox.lowTrafficTogglePending, null);
  assert.equal(sandbox.lowTrafficReceiptDisplay, null, "a failure is never remembered as a confirmed value");
  assert.ok(String(sandbox.lowTrafficReceiptNotice).indexOf("globalState 写入失败") >= 0, "the real failure reason is reported");
  assert.equal(shown(), false, "a failed write keeps showing the persisted preference");
  assert.equal(nextTarget(), true, "and the next click target with it");
});


// §17.3 r2-final-3: claiming the closure requires a genuine policy transition plus real success
// evidence, so a pause, a never-completed handshake, a standing lastError or a hard manual-reconnect
// fault can never be relabelled as the guard's intentional closure - and a refused claim must not leave
// a stale claim behind. The reverse case (no fault evidence at all) must still be attributed to the
// guard, so normal low traffic never looks like an outage.
test("r3/b1: a real loss keeps its attribution through pause, repeated policy and resume (soft and hard)", async () => {
  for (const [reason, hard] of [["socket hang up", false], ["HTTP 401 Unauthorized", true]]) {
    const multi = new MultiEndpointRealtimeClient([endpoint("w1")], () => new RequestBudget());
    const child = [...multi.clients.values()][0];
    const members = [legacyMethod(source, "effectiveTrafficPolicy()"), legacyMethod(source, "ensureRealtimeConnected(_reason)")];
    const fixture = hostFixture(members);
    const { host } = fixture;
    host.isRealtimeMode = () => true;
    host.client = { connect: async () => { await multi.connect(); }, diagnostics: () => multi.diagnostics() };
    try {
      multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
      await host.ensureRealtimeConnected("startup");
      assert.equal(multi.diagnostics().displayAutoClosed, true, reason + ": step 0 baseline guard closure");
      // Step 1 - a real failure establishes its own attribution (a hard one also demands a manual
      // reconnect).
      await child.connectionLost(reason);
      let diagnostics = multi.diagnostics();
      assert.equal(diagnostics.displayAutoClosed, false, reason + ": step 1 the failure clears the guard explanation");
      assert.equal(Boolean(child.diagnostics().requiresManualReconnect), hard, reason + ": step 1 hard/soft marking");
      // Step 2 - the user pauses the stream (pauseRealtimeStream calls disconnect("paused")).
      await child.disconnect("paused");
      await host.ensureRealtimeConnected("pause stream");
      diagnostics = multi.diagnostics();
      assert.equal(diagnostics.endpoints[0].streamStatus, "paused", reason + ": step 2 paused state");
      assert.equal(host.lastError, undefined, reason + ": step 2 a pause is not published as unavailable");
      assert.equal(host.lastHealth, undefined, reason + ": step 2 a pause writes no offline health");
      // Step 3 - the same low-traffic policy is applied again (pauseAllNetworkActivity and
      // resumeNetwork both re-apply it) while the failure is still outstanding.
      multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
      await tick();
      diagnostics = multi.diagnostics();
      assert.equal(diagnostics.endpoints[0].streamStatus, "disconnected", reason + ": step 3 the policy really closed the stream");
      assert.equal(diagnostics.displayAutoClosed, false, reason + ": step 3 a paused real failure must not become a guard closure");
      assert.match(String(diagnostics.endpoints[0].lastError), hard ? /401/ : /socket hang up/, reason + ": step 3 failure evidence kept");
      await host.ensureRealtimeConnected("resume network");
      assert.equal(host.lastError, "tunnel_unavailable", reason + ": step 3 the outage is still published");
      assert.equal(host.lastHealth, undefined, reason + ": step 3 no invented port probe or checkedAt");
      assert.equal(child.diagnostics().displayFaultClass, hard ? "H" : "T", reason + ": step 3 exact fault preserved");
      // Step 4 - restoring the cadence must not fake a recovery: without a successful round the
      // endpoint stays disconnected, keeps the failure and claims nothing.
      let restores = 0;
      child.connect = async () => { restores += 1; };
      multi.updateRefreshPolicy({ displayAutoRefresh: true, snapshotFallbackIntervalSeconds: 5 });
      await tick();
      assert.equal(restores, hard ? 0 : 1, reason + ": step 4 a soft loss re-arms, a hard failure stays limited");
      diagnostics = multi.diagnostics();
      assert.equal(diagnostics.endpoints[0].streamStatus, "disconnected", reason + ": step 4 nothing looks online");
      assert.equal(diagnostics.displayAutoClosed, false, reason + ": step 4 no stale claim survives");
      assert.match(String(diagnostics.endpoints[0].lastError), hard ? /401/ : /socket hang up/, reason + ": step 4 failure evidence survives the restore");
      await host.ensureRealtimeConnected("resume network");
      assert.equal(host.lastError, "tunnel_unavailable", reason + ": step 5 the host still reports the real outage");
    }
    finally { await multi.disconnect("dispose"); }
  }
});

test("r3/b1: a failure during a never-succeeded connecting handshake keeps its attribution", async () => {
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  // The handshake hangs before any socket or fetch is created, so the client really stops in
  // "connecting" with no successful round and no network traffic.
  const hangingBudget = { isPaused: () => false, run: async (_kind, fn) => { await gate; return fn(); }, setHidden: () => {}, noteCoalescedRequest: () => {} };
  const multi = new MultiEndpointRealtimeClient([endpoint("w1")], () => new RequestBudget());
  const child = new RealtimeTunnelClient(endpoint("w1"), hangingBudget);
  multi.clients.clear();
  multi.clients.set("w1", child);
  const members = [legacyMethod(source, "effectiveTrafficPolicy()"), legacyMethod(source, "ensureRealtimeConnected(_reason)")];
  const fixture = hostFixture(members);
  const { host } = fixture;
  host.isRealtimeMode = () => true;
  host.client = { connect: async () => { await multi.connect(); }, diagnostics: () => multi.diagnostics() };
  try {
    multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await host.ensureRealtimeConnected("startup");
    assert.equal(multi.diagnostics().displayAutoClosed, true, "step 0: a guard closure without any failure is still the guard");
    // Step 1 - a real soft loss before anything ever connected successfully.
    await child.connectionLost("socket hang up");
    assert.equal(child.diagnostics().displayAutoClosed, false, "step 1: the real loss owns the attribution");
    // Step 2 - turning the guard off starts a real recovery round that stops inside the handshake.
    multi.updateRefreshPolicy({ displayAutoRefresh: true, snapshotFallbackIntervalSeconds: 5 });
    await tick();
    assert.equal(child.diagnostics().streamStatus, "connecting", "step 2: the handshake really has not completed");
    // Step 3 - the guard goes back on while the handshake is still outstanding, then the same policy
    // is applied again.
    multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    let diagnostics = multi.diagnostics();
    assert.equal(diagnostics.endpoints[0].streamStatus, "disconnected", "step 3: the unfinished handshake was closed by the policy");
    assert.equal(diagnostics.displayAutoClosed, false, "step 3: a never-succeeded connecting must not become a guard closure");
    assert.match(String(diagnostics.endpoints[0].lastError), /socket hang up/, "step 3: the older real failure is kept");
    // Step 4 - the early-return connect path may not claim it either.
    await multi.connect();
    await child.connect();
    diagnostics = multi.diagnostics();
    assert.equal(diagnostics.displayAutoClosed, false, "step 4: connect after the refused claim still does not claim it");
    // Step 5 - the real host method over the real aggregator publishes the outage.
    await host.ensureRealtimeConnected("resume network");
    assert.equal(host.lastError, "tunnel_unavailable", "step 5: the unfinished handshake failure is published as unavailable");
    assert.equal(host.lastHealth, undefined, "step 5: an unfinished handshake does not prove a port closed");
    assert.equal(child.diagnostics().displayFaultClass, "T", "step 5: the real transport fault is preserved");
  }
  finally { releaseGate(); await multi.disconnect("dispose"); }
});

test("r3/b1 reverse: a guard closure without any fault evidence is never reported as an outage", async () => {
  const multi = new MultiEndpointRealtimeClient([endpoint("w1")], () => new RequestBudget());
  const child = [...multi.clients.values()][0];
  const members = [legacyMethod(source, "effectiveTrafficPolicy()"), legacyMethod(source, "ensureRealtimeConnected(_reason)")];
  const fixture = hostFixture(members);
  const { host } = fixture;
  host.isRealtimeMode = () => true;
  host.client = { connect: async () => { await multi.connect(); }, diagnostics: () => multi.diagnostics() };
  try {
    multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await host.ensureRealtimeConnected("startup");
    assert.equal(child.diagnostics().displayAutoClosed, true, "step 1: closing without any failure evidence stays the guard");
    assert.equal(multi.diagnostics().displayAutoClosed, true, "step 1: the aggregator keeps the policy attribution");
    assert.equal(host.lastError, undefined, "step 1: no invented tunnel_unavailable for the guard");
    assert.equal(host.lastHealth, undefined, "step 1: no invented local_port_closed health for the guard");
    // A pause of a channel that never failed, then the policy applied again, must still look like the
    // policy rather than an outage.
    await child.disconnect("paused");
    multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    await host.ensureRealtimeConnected("resume network");
    assert.equal(multi.diagnostics().displayAutoClosed, true, "step 2: a healthy pause then closure is not an outage");
    assert.equal(host.lastError, undefined, "step 2: still no invented outage");
    assert.equal(host.lastHealth, undefined, "step 2: still no invented offline health");
    // The counter-case inside the same sequence: once a real failure exists the identical sequence has
    // to publish the outage.
    await child.connectionLost("socket hang up");
    multi.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    await host.ensureRealtimeConnected("resume network");
    assert.equal(multi.diagnostics().displayAutoClosed, false, "step 3: a real failure revokes the claim");
    assert.equal(host.lastError, "tunnel_unavailable", "step 3: the real failure is published");
    assert.equal(host.lastHealth, undefined, "step 3: the failure does not invent a fresh port observation");
    assert.equal(child.diagnostics().displayFaultClass, "T", "step 3: the real transport evidence remains visible");
  }
  finally { await multi.disconnect("dispose"); }
});
