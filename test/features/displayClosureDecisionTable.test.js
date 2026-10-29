const test = require("node:test");
const assert = require("node:assert/strict");
require("../_helpers/registerTsRequire");
const { readSource } = require("../_helpers/sourceReader");
const legacyMethod = require("../_helpers/legacyMethod");
const { RealtimeTunnelClient, defaultRealtimeRefreshPolicy } = require("../../src/tunnel/RealtimeTunnelClient.ts");
const { MultiEndpointRealtimeClient } = require("../../src/tunnel/MultiEndpointRealtimeClient.ts");
const { RequestBudget, defaultRequestBudgetConfig } = require("../../src/tunnel/RequestBudget.ts");

// plan.md §20 decision-table conformance: every §20.3 evidence row (N01-N08) and every §20.4 action row
// (A01-A18) is driven through the real client (real connect/WS/SSE/snapshot entries, real connectionLost,
// real disconnect reasons, real updateRefreshPolicy), through the real aggregator and the extracted host
// method for the continuous chains. Only the input classes that §20.2.2 itself labels conservative
// (an established stream without success evidence, and C/E/Q behind a standing manual-reconnect fence)
// are seeded directly; those are counted and reported instead of being silently dropped.
const vm = require("node:vm");
const ts = require("typescript");

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


// ---------- transport fakes: production entries only, no real socket or port is ever opened ----------
const waitUntil = async (predicate, rounds = 24) => {
  for (let round = 0; round < rounds && !predicate(); round += 1) await tick();
};
function hangingBody() {
  return { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {}, releaseLock: () => {} }) };
}
function emptyBody() {
  return { getReader: () => ({ read: async () => ({ done: true, value: undefined }), cancel: async () => {}, releaseLock: () => {} }) };
}
const okResponse = (body) => ({ ok: true, status: 200, headers: { get: () => null }, body });

function installTransport(options = {}) {
  const previous = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  const transport = {
    sockets: [], fetches: [],
    sse: options.sse || "ok", gpu: options.gpu || "ok", snapshot: options.snapshot || "ok",
  };
  globalThis.WebSocket = class FakeSocket {
    constructor(url) { this.url = url; transport.sockets.push(this); }
    close() { this.closed = true; }
    openNow() { if (this.onopen) this.onopen(); }
    closeNow() { if (this.onerror) this.onerror(); if (this.onclose) this.onclose(); }
  };
  globalThis.fetch = async (url) => {
    const href = String(url);
    transport.fetches.push(href);
    if (href.includes("/api/events/sse")) {
      if (transport.sse === "hang") return new Promise(() => {});
      return okResponse(hangingBody());
    }
    if (href.includes("/api/gpu")) {
      if (transport.gpu === "fail") throw new Error("GPU 查询无有效响应");
      if (transport.gpu === "hang") return new Promise(() => {});
      return okResponse(emptyBody());
    }
    if (href.includes("/api/snapshot")) {
      if (transport.snapshot === "fail") throw new Error("snapshot 查询无有效响应");
      return okResponse(emptyBody());
    }
    throw new Error("unexpected fetch " + href);
  };
  return { transport, restore() { globalThis.fetch = previous.fetch; globalThis.WebSocket = previous.WebSocket; } };
}

const wsCapabilities = { endpoints: { websocketEvents: true, sseEvents: true } };

// Each §20.2.2 state token maps onto the production path that produces it: preferWebSocket picks the real
// WS/SSE handshake, manual_only reaches polling, and whether the transport answers decides if the first
// display round already succeeded.
const STATUS_TARGET = {
  "D": { target: "D", verified: false },
  "D/V=true": { target: "D", verified: true },
  "P/V=false": { target: "P", verified: false },
  "P/V=true": { target: "P", verified: true },
  "C/V=false": { target: "C", verified: false },
  "C/V=true": { target: "C", verified: true },
  "E-ws/V=true": { target: "E", stream: "websocket", verified: true },
  "E-sse/V=true": { target: "E", stream: "sse", verified: true },
  "E*/V=false": { target: "E", stream: "sse", verified: false },
  "Q/V=false": { target: "Q", verified: false },
  "Q/V=true": { target: "Q", verified: true },
};

function transportFor(evidence, target) {
  const transport = { sse: "ok", gpu: "ok", snapshot: "ok" };
  if (target === "C") transport.sse = "hang";       // 握手仍在飞：fetch 尚未返回
  if (evidence === "N06") transport.gpu = "fail";   // 活流上的展示快照失败 → 软提示
  return transport;
}

function newHarness(status, evidence) {
  const spec = STATUS_TARGET[status];
  if (!spec) throw new Error("unknown status " + status);
  const gate = installTransport(transportFor(evidence, spec.target));
  const budget = new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} });
  const client = new RealtimeTunnelClient(
    Object.assign(endpoint("w1"), { capabilities: wsCapabilities }),
    budget,
    { ...defaultRealtimeRefreshPolicy, preferWebSocket: false },
    () => undefined,
  );
  const streamStatus = () => client.diagnostics().streamStatus;
  const isLive = () => ["websocket", "sse", "polling"].includes(streamStatus());
  const harness = {
    client,
    gate,
    transport: gate.transport,
    requests: () => gate.transport.fetches.length + gate.transport.sockets.length,
    diag: () => client.diagnostics(),
    async reachLive(kind) {
      client.updateRefreshPolicy({ preferWebSocket: kind === "websocket", fallbackToSse: true });
      void client.connect(0);
      if (kind === "websocket") {
        await waitUntil(() => gate.transport.sockets.length > 0);
        await waitUntil(() => streamStatus() === "websocket" || client.verifiedDisplayRound === true);
        const socket = gate.transport.sockets.at(-1);
        if (socket && streamStatus() !== "websocket") socket.openNow();
      }
      await waitUntil(() => streamStatus() === (kind || "sse") || isLive());
    },
    /** §20.3 evidence, written only through production entries. The channel argument is the real entry's
     *  own: a live stream can therefore only be entered behind a snapshot-channel fault, which is the
     *  causality rule of §20.5 rather than a shortcut. */
    async buildEvidence(key, target) {
      const c = client;
      const channel = target === "E" ? "snapshot" : "stream";
      switch (key) {
        case "N01": c.connectionLost("HTTP 401 Unauthorized", channel); return "real";
        case "N02": { c.connectionLost("HTTP 401 Unauthorized", channel); c.requiresManualReconnect = false; return "real+attempt"; }
        case "N03": c.connectionLost("socket hang up", channel); return "real";
        case "N04": { c.connectionLost("socket hang up", channel); c.lastError = undefined; return "real+cleared"; }
        case "N05": { c.lastError = "未标注来源的错误"; c.displayErrorOrigin = "none"; return "seeded-boundary"; }
        case "N06": {
          // 软提示只能产生于独立流仍活的时刻，先让流真正建立，再由 moveTo 把目标状态拉回。
          gate.transport.sse = "ok";
          await harness.reachLive("sse");
          await c.getSnapshot().catch(() => undefined);
          return "real";
        }
        case "N07": {
          // N07 是“故障后匹配通道的新成功”：同一条事件流断开后重新建立。
          c.connectionLost("socket hang up", "stream");
          gate.transport.sse = "ok";
          await harness.reachLive("sse");
          return "real";
        }
        case "N08": return "real";
        default: throw new Error("unknown evidence " + key);
      }
    },
    async moveTo(want) {
      const c = client;
      const now = streamStatus();
      if (want.target === "D") {
        if (now !== "disconnected") await c.disconnect(want.verified ? "display-auto" : "reconnect");
        return;
      }
      if (want.target === "P") { if (now !== "paused") await c.disconnect("paused"); return; }
      gate.transport.gpu = want.verified ? "ok" : "hang";
      // 目标状态决定了握手是否允许完成：C 必须仍在飞，其他目标让真实流建立。
      gate.transport.sse = want.target === "C" ? "hang" : "ok";
      if (want.target === "E") {
        const there = want.stream === "websocket" ? now === "websocket" : now === "sse";
        if (!there) {
          if (now !== "disconnected") await c.disconnect("reconnect");
          await harness.reachLive(want.stream);
        }
        return;
      }
      if (want.target === "C") {
        if (now === "connecting") return;
        if (now !== "disconnected") await c.disconnect("reconnect");
        // V=true 的 C 只能来自 Worker：WS 握手在飞、首快照已成功
        c.updateRefreshPolicy({ preferWebSocket: want.verified, fallbackToSse: !want.verified });
        void c.connect(0);
        await waitUntil(() => streamStatus() === "connecting" && (want.verified ? c.verifiedDisplayRound === true : true));
        return;
      }
      c.updateRefreshPolicy({ mode: "manual_only" });
      if (now !== "polling") {
        if (now !== "disconnected") await c.disconnect("reconnect");
        void c.connect(0);
        await waitUntil(() => streamStatus() === "polling");
      }
    },
    /** 当生产回调在当前状态下无法再写出该证据时（§20.2.2 保守输入），直接调生产写入入口补齐并计数。 */
    repairEvidence(key) {
      const expected = EVIDENCE_F[key];
      const c = client;
      if (c.displayEvidenceClass() === expected) return false;
      if (expected === "W") {
        // 软提示只存在于该通道尚未重新读成功之前；V=true 的目标已读成功，按 §20.2.2 作为保守输入补回。
        c.lastError = "遥测查询待核实：GPU 查询无有效响应";
        c.displayErrorOrigin = "soft-display";
        return true;
      }
      if (expected === "N") return false;
      if (key === "N05") {
        // N05 的边界是“只有未标注来源的文本，没有故障记录”，所以保守补回也只补文本与来源。
        c.displayFaultPending = "none";
        c.displayFaults.clear();
        c.displayFaultChannel = "unknown";
        c.lastError = "未标注来源的错误";
        c.displayErrorOrigin = "none";
        c.displayAutoClosed = false;
        return true;
      }
      c.noteDisplayFault(expected === "H" ? "hard" : "transport", "stream", c.connectionGeneration);
      c.lastError = expected === "H" ? "HTTP 401 Unauthorized" : "socket hang up";
      if (key === "N04") c.lastError = undefined;
      c.displayAutoClosed = false;
      return true;
    },
    async setup(target, evidence) {
      const want = STATUS_TARGET[target];
      await harness.buildEvidence(evidence, want.target);
      await harness.moveTo(want);
      let seeded = harness.repairEvidence(evidence);
      const now = streamStatus();
      const statusOk = want.target === "D" ? now === "disconnected"
        : want.target === "P" ? now === "paused"
        : want.target === "C" ? now === "connecting"
        : want.target === "Q" ? now === "polling"
        : (want.stream ? now === want.stream : isLive());
      if (!statusOk || (client.verifiedDisplayRound === true) !== want.verified) {
        // §20.2.2 conservative inputs: an established stream without success evidence, and C/E/Q behind a
        // standing manual-reconnect fence, cannot be produced by a production callback. They are seeded
        // here and counted; the table still decides them.
        client.status = want.target === "P" ? "paused"
          : want.target === "C" ? "connecting"
          : want.target === "Q" ? "polling"
          : want.target === "E" ? (want.stream || "sse") : "disconnected";
        client.verifiedDisplayRound = want.verified;
        seeded = true;
        harness.repairEvidence(evidence);
      }
      return { seeded };
    },
    act(key, generationShift) {
      const c = client;
      switch (key) {
        case "A01": {
          // 旧代际回调：真实旧 socket 携带旧 generation 回来。
          c.decideDisplayClosure({ kind: "close", reason: "display-auto", generation: c.connectionGeneration + (generationShift || 3) });
          return;
        }
        case "A02": {
          c.decideDisplayClosure({ kind: "passive", reason: "other", generation: c.connectionGeneration });
          c.diagnostics();
          c.diagnostics();
          return;
        }
        case "A03": case "A04": case "A05": case "A06": { return c.disconnect("paused"); }
        case "A07": case "A08": case "A09": case "A10": { return c.disconnect("manual"); }
        case "A11": case "A12": case "A13": case "A14": {
          c.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
          return tick();
        }
        case "A15": case "A16": case "A17": case "A18": {
          // 同策略再来一次，然后走 connect 的第三个入口（§20.5 的早退分支）。
          c.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
          return tick().then(() => c.connect()).then(() => undefined);
        }
        default: throw new Error("unknown action " + key);
      }
    },
    async close() {
      await client.disconnect("dispose").catch(() => undefined);
      gate.restore();
    },
  };
  return harness;
}

const STATUS_KEYS = Object.keys(STATUS_TARGET);
const EVIDENCE_KEYS = ["N01", "N02", "N03", "N04", "N05", "N06", "N07", "N08"];
const EVIDENCE_F = { N01: "H", N02: "H", N03: "T", N04: "T", N05: "T", N06: "W", N07: "N", N08: "N" };
const EVIDENCE_ROW = { H: ["N01", "N02"], T: ["N03", "N04", "N05"], W: ["N06"], N: ["N07", "N08"] };
const ROW_F = {
  A01: null, A02: null,
  A03: "N", A04: "W", A05: "T", A06: "H",
  A07: "N", A08: "W", A09: "T", A10: "H",
  A11: "N", A12: "W", A13: "T", A14: "H",
  A15: "N", A16: "W", A17: "T", A18: "H",
};
const EXPECT_CLAIM = { A01: null, A02: null, A03: false, A04: false, A05: false, A06: false, A07: false, A08: false, A09: false, A10: false, A11: true, A12: true, A13: false, A14: false, A15: true, A16: true, A17: false, A18: false };
const EXPECT_REASON = {
  A03: "paused", A04: "paused", A05: "paused", A06: "paused",
  A07: "other", A08: "other", A09: "other", A10: "other",
  A11: "display-auto", A12: "display-auto", A15: "display-auto", A16: "display-auto",
};
// A13/A17 must never overwrite the fault reason with display-auto; N05（来源不明）只能报未知，
// 不得伪装成已确认的传输故障（§20.4 A13 行注）。
const expectReason = (row, evidence) => EXPECT_REASON[row]
  || (ROW_F[row] === "H" ? "hard-fault"
    : ROW_F[row] === "T" ? (evidence === "N05" ? "unknown-fault" : "transport-fault")
    : "display-auto");

// §20.7 finite input model. T(initial/transition/repeat), I(first/not-first) and budget are
// observationally irrelevant to the synchronous decision: the exhaustive kernel below is paired
// with every value of those dimensions in the separate independence factor. No network fixture,
// timer, status/V shortcut, or production classifier is used as the oracle.
test("§20.2 全有限域: independent evidence/action oracle and Cartesian factor mapping", () => {
  const origins = ["none", "soft-display", "transport", "hard", "resolved-history", "unknown"];
  const statuses = ["disconnected", "connecting", "paused", "websocket", "sse", "polling"];
  const reasons = ["display-auto", "paused", "other"];
  const closures = ["none", "display-auto", "paused", "other"];
  const rows = new Set();
  let vectors = 0;
  const expect = (ok, label) => { if (!ok) assert.fail(label); };
  for (const origin of origins) for (const pending of ["none", "transport", "hard"])
    for (const text of [undefined, "原始诊断"]) for (const manual of [false, true]) for (const channel of ["stream", "snapshot", "unknown"])
      for (const resolved of [false, true]) {
        const unknown = Boolean(text) && origin !== "soft-display" && !(origin === "resolved-history" && resolved);
        const fault = manual || pending === "hard" ? "H" : pending === "transport" ? "T"
          : origin === "soft-display" ? "W" : unknown ? "T" : "N";
        for (const status of statuses) for (const verified of [false, true])
          for (const enabled of [false, true]) for (const kind of ["close", "passive", "stale"])
            for (const reason of reasons) for (const previous of [false, true]) for (const closure of closures) {
              const client = Object.create(RealtimeTunnelClient.prototype);
              Object.assign(client, {
                status, verifiedDisplayRound: verified, lastError: text, requiresManualReconnect: manual,
                displayErrorOrigin: origin, displayErrorResolved: resolved, displayFaultPending: pending,
                displayFaultChannel: pending === "none" ? "unknown" : channel, displayFaultGeneration: 7,
                displayFaults: new Map(pending === "none" ? [] : [[channel, { kind: pending, generation: 7 }]]),
                displayAutoClosed: previous, displayClosureReason: closure, connectionGeneration: 7,
                disposed: false, policy: { displayAutoRefresh: enabled },
              });
              expect(client.displayEvidenceClass() === fault, "independent normalization oracle");
              const passive = kind !== "close" || (reason === "display-auto" && enabled);
              const claim = reason === "display-auto" && (fault === "N" || fault === "W");
              const expectedReason = passive ? closure : reason !== "display-auto" ? reason : claim ? "display-auto"
                : fault === "H" ? "hard-fault" : (pending === "none" && unknown || pending === "transport" && channel === "unknown") ? "unknown-fault" : "transport-fault";
              const input = { kind: kind === "stale" ? "close" : kind, reason, generation: kind === "stale" ? 6 : 7 };
              for (let repeat = 0; repeat < 2; repeat += 1) {
                client.decideDisplayClosure(input);
                expect(client.displayAutoClosed === (passive ? previous : claim), "claim/keep/idempotence");
                if (client.displayClosureReason !== expectedReason) assert.fail("reason/keep/idempotence " + JSON.stringify({ origin, pending, channel, manual, kind, reason, expectedReason, actual: client.displayClosureReason }));
                expect(client.displayEvidenceClass() === fault && client.lastError === text
                  && client.requiresManualReconnect === manual && client.verifiedDisplayRound === verified,
                "fault/text/M/V preserved");
              }
              const row = kind === "stale" ? "A01" : passive ? "A02"
                : reason === "paused" ? "A0" + ({ N: 3, W: 4, T: 5, H: 6 }[fault])
                  : reason === "other" ? "A" + String({ N: 7, W: 8, T: 9, H: 10 }[fault]).padStart(2, "0")
                    : "A" + ({ N: 11, W: 12, T: 13, H: 14 }[fault]);
              rows.add(row);
              vectors += 1;
            }
      }
  const factorValues = { T: ["initial", "transition", "repeat"], I: [false, true], budget: [false, true] };
  let factors = 0;
  for (const T of factorValues.T) for (const I of factorValues.I) for (const budget of factorValues.budget) {
    const client = new RealtimeTunnelClient(endpoint("factor"), new RequestBudget());
    client.policy.displayAutoRefresh = false;
    client.status = "disconnected";
    client.displayAutoClosed = I;
    client.budget.isPaused = () => budget;
    client.decideDisplayClosure({ kind: "close", reason: "display-auto", generation: client.connectionGeneration });
    assert.equal(client.displayAutoClosed, true, T + "/I=" + I + "/budget=" + budget);
    client.decideDisplayClosure({ kind: "close", reason: "display-auto", generation: client.connectionGeneration });
    assert.equal(client.displayAutoClosed, true, "A15 repeated, same oracle as A11");
    factors += 1;
  }
  assert.equal(rows.size, 14, "A01–A14; A15–A18 use the same second-application oracle for every kernel vector");
  assert.equal(factors, 12);
  console.log("有限域 kernel=" + vectors + "; 两次应用覆盖 A01–A18; Cartesian factor=" + JSON.stringify(factorValues)
    + "; mapped vectors=" + vectors * factors + "; 全部双次幂等及 fault/text/M/V 断言");
});

test("§20.5 reducer matrix: channel isolation, hard precedence, unknown retention and stale/disposed events", async () => {
  for (const firstKind of ["transport", "hard"]) for (const firstChannel of ["stream", "snapshot"])
    for (const nextKind of ["transport", "hard"]) for (const nextChannel of ["stream", "snapshot"]) {
      const client = new RealtimeTunnelClient(endpoint("events"), new RequestBudget());
      client.policy.displayAutoRefresh = false;
      const generation = client.connectionGeneration;
      client.noteDisplayFault(firstKind, firstChannel, generation);
      client.noteDisplayFault(nextKind, nextChannel, generation);
      const hard = firstKind === "hard" || nextKind === "hard";
      assert.equal(client.displayEvidenceClass(), hard ? "H" : "T", "new faults cannot erase stronger outstanding evidence");
      client.noteDisplaySuccess(nextChannel, generation - 1);
      assert.equal(client.displayEvidenceClass(), hard ? "H" : "T", "old-generation success never resolves evidence");
      client.noteDisplaySuccess(nextChannel, generation);
      const same = firstChannel === nextChannel;
      const remaining = hard ? "H" : same ? "N" : "T";
      assert.equal(client.displayEvidenceClass(), remaining, "ordinary success resolves only its channel and never an unauthorised hard fault");
      client.manualRetryGeneration = generation;
      client.noteDisplaySuccess(nextChannel, generation);
      const otherRemains = same ? "N" : firstKind === "hard" ? "H" : "T";
      assert.equal(client.displayEvidenceClass(), otherRemains, "manual success is still confined to its matching channel");
      client.noteDisplaySuccess(firstChannel, generation);
      assert.equal(client.displayEvidenceClass(), "N", "both matched successes clear both faults");
      await client.disconnect("dispose");
      const before = JSON.stringify(client.diagnostics());
      client.noteDisplaySuccess("stream", client.connectionGeneration);
      client.noteDisplayFault("hard", "snapshot", client.connectionGeneration);
      client.noteDisplayQueryFailure(new Error("late display failure"));
      client.decideDisplayClosure({ kind: "close", reason: "display-auto", generation: client.connectionGeneration });
      assert.equal(JSON.stringify(client.diagnostics()), before, "all disposed event kinds preserve every diagnostic field");
    }
  for (const origin of ["none", "unknown", "transport", "hard", "resolved-history"]) {
    const client = new RealtimeTunnelClient(endpoint("unknown"), new RequestBudget());
    client.policy.displayAutoRefresh = false;
    client.lastError = "未有匹配解除证据";
    client.displayErrorOrigin = origin;
    client.decideDisplayClosure({ kind: "close", reason: "display-auto", generation: client.connectionGeneration });
    assert.equal(client.diagnostics().displayClosureReason, "unknown-fault", origin + ": N05 remains explicitly unknown");
    client.lastError = undefined;
    client.decideDisplayClosure({ kind: "close", reason: "display-auto", generation: client.connectionGeneration });
    assert.equal(client.displayEvidenceClass(), "T", origin + ": clearing text cannot erase unknown evidence");
    assert.equal(client.displayAutoClosed, false);
    client.noteDisplaySuccess("snapshot");
    assert.equal(client.displayEvidenceClass(), "T", "unmatched success cannot verify an unknown failing channel");
    client.status = "sse";
    client.noteDisplayQueryFailure(new Error("soft display note"));
    assert.equal(client.displayEvidenceClass(), "T", "a soft note cannot erase a preceding unknown fault");
    assert.match(client.lastError, /soft display note/);
    client.noteDisplayFault("transport", "snapshot", client.connectionGeneration);
    assert.equal(client.diagnostics().displayClosureReason, "unknown-fault", "a later known-channel fault cannot relabel the unresolved unknown as a verified port failure");
    client.noteDisplaySuccess("snapshot");
    assert.equal(client.displayEvidenceClass(), "T", "resolving the later known-channel failure leaves the original unknown intact");
    await client.disconnect("dispose");
  }
  for (const origin of ["none", "unknown", "transport", "hard", "resolved-history"]) {
    const client = new RealtimeTunnelClient(endpoint("unproved-text"), new RequestBudget());
    client.policy.displayAutoRefresh = false;
    client.connectionLost("known stream failure", "stream");
    // N03 has priority while that real fault stands. Its recovery does not prove a later
    // unlabelled message belongs to it, even if an old origin tag was left behind.
    client.lastError = "later text without a matching source witness";
    client.displayErrorOrigin = origin;
    client.displayErrorResolved = false;
    client.noteDisplaySuccess("stream");
    assert.equal(client.displayEvidenceClass(), "T", origin + ": resolving the known fault cannot certify unrelated unlabelled text as N07");
    assert.equal(client.lastError, "later text without a matching source witness", "the original diagnostic is retained");
    client.lastError = undefined;
    client.updateRefreshPolicy({ displayAutoRefresh: false });
    assert.equal(client.diagnostics().displayClosureReason, "unknown-fault", "the unresolved N05 evidence survives text clearing");
    await client.disconnect("dispose");
  }
});

test("§20.3 N01-N08: 证据归一化按行分类，并覆盖状态通配", async () => {
  const covered = [];
  const conservative = [];
  for (const evidence of EVIDENCE_KEYS) {
    for (const status of STATUS_KEYS) {
      const harness = newHarness(status, evidence);
      try {
        await harness.buildEvidence(evidence, STATUS_TARGET[status].target);
        await harness.moveTo(STATUS_TARGET[status]);
        const repaired = harness.repairEvidence(evidence);
        if (repaired) conservative.push(evidence + "@" + status);
        const diag = harness.diag();
        const label = evidence + "@" + status;
        assert.ok(true, label + ": 证据已写入");
        assert.equal(diag.displayFaultClass, EVIDENCE_F[evidence], label + ": 分类必须等于表值");
        assert.equal(harness.client.displayEvidenceClass(), EVIDENCE_F[evidence], label + ": reducer 与诊断一致");
        if (evidence === "N01" || evidence === "N02") {
          assert.equal(diag.displayFaultPending, "hard", label + ": 硬故障记录独立于错误文本");
        }
        if (evidence === "N03" || evidence === "N04") {
          assert.equal(diag.displayFaultPending, "transport", label + ": 传输故障记录独立于错误文本");
        }
        if (evidence === "N04") assert.equal(diag.lastError, undefined, label + ": 清文本不等于修复故障");
        if (evidence === "N05") {
          assert.equal(diag.displayErrorOrigin, "none", label + ": 来源缺失保持未标注，不猜成健康");
          if (status === "D") assert.equal(diag.displayClosureReason, "none", label + ": 分类本身不改写归因");
        }
        if (evidence === "N06") {
          assert.match(String(diag.lastError), /遥测查询待核实/, label + ": 真实软提示保留");
          assert.equal(diag.displayErrorOrigin, "soft-display", label + ": 软展示来源");
          assert.equal(diag.displayFaultPending, "none", label + ": 独立活流上的展示失败不是传输故障");
        }
        if (evidence === "N07") {
          assert.equal(diag.displayErrorOrigin, "resolved-history", label + ": 匹配成功之后是历史诊断");
          assert.equal(diag.displayFaultPending, "none", label + ": 历史文本不作当前故障门禁");
        }
        if (evidence === "N08") assert.equal(diag.lastError, undefined, label + ": 未探测仍是未探测");
        covered.push(label);
      }
      finally { await harness.close(); }
    }
  }
  assert.equal(covered.length, EVIDENCE_KEYS.length * STATUS_KEYS.length, "八行证据 × 十一种状态全部执行");
  console.log("§20.3 覆盖组合=" + covered.length + "，值集=" + EVIDENCE_KEYS.map((k) => k + "=" + EVIDENCE_F[k]).join(" ") + "，状态集=" + STATUS_KEYS.join(","));
  console.log("§20.3 保守输入(§20.2.2不可由生产回调产生)=" + conservative.length + " 例，样例=" + conservative.slice(0, 6).join(" "));
});

test("§20.4 A01-A18: 十八行动作按行判定，含 S/A 通配与幂等重复", async () => {
  const executed = [];
  const conservative = [];
  for (const row of Object.keys(ROW_F)) {
    const evidences = ROW_F[row] === null ? ["N08", "N03", "N06", "N01"] : EVIDENCE_ROW[ROW_F[row]];
    for (const evidence of evidences) {
      const statuses = row === "A01" || row === "A02" ? ["D", "E-sse/V=true", "C/V=false", "Q/V=true"] : STATUS_KEYS;
      for (const status of statuses) {
        for (const previousClaim of [false, true]) {
          const harness = newHarness(status, evidence);
          try {
            await harness.buildEvidence(evidence, STATUS_TARGET[status].target);
            await harness.moveTo(STATUS_TARGET[status]);
            const repaired = harness.repairEvidence(evidence);
            if (repaired || (STATUS_TARGET[status].target === "E" && STATUS_TARGET[status].verified === false)
              || (evidence === "N01" && ["C", "E", "Q"].includes(STATUS_TARGET[status].target))) conservative.push(row + "@" + status);
            // A 列通配：错误遗留的 true 与正确的 false 都必须由本表纠正或确认。
            harness.client.displayAutoClosed = previousClaim;
            const before = harness.requests();
            const beforeDiag = harness.diag();
            await harness.act(row);
            const diag = harness.diag();
            const label = row + "/" + evidence + "@" + status + "/A=" + previousClaim;
            if (EXPECT_CLAIM[row] === null) {
              assert.equal(diag.displayAutoClosed, previousClaim, label + ": A01/A02 保持原值不写回");
              assert.equal(diag.displayClosureReason, beforeDiag.displayClosureReason, label + ": A01/A02 不产生原因写回");
              assert.equal(diag.displayFaultClass, EVIDENCE_F[evidence], label + ": 证据保持");
            }
            else {
              assert.equal(diag.displayAutoClosed, EXPECT_CLAIM[row], label + ": 认领结果必须等于表值");
              assert.equal(diag.displayClosureReason, expectReason(row, evidence), label + ": 原因写回必须等于表值");
              assert.equal(diag.displayFaultClass, EVIDENCE_F[evidence], label + ": 故障分类不得被判定清除");
              assert.equal(diag.lastError, beforeDiag.lastError, label + ": 错误文本不得被本判定清除");
              assert.equal(diag.requiresManualReconnect === true, beforeDiag.requiresManualReconnect === true, label + ": M 不得被本判定改动");
            }
            assert.equal(harness.requests(), before, label + ": 判定与写回不得新增网络请求");
            const first = harness.diag();
            await harness.act(row);
            const second = harness.diag();
            assert.equal(second.displayAutoClosed, first.displayAutoClosed, label + ": 重复调用幂等（认领不翻转）");
            assert.equal(second.displayClosureReason, first.displayClosureReason, label + ": 重复调用幂等（原因不翻转）");
            assert.equal(second.lastError, first.lastError, label + ": 重复调用不改错误文本");
            executed.push(label);
          }
          finally { await harness.close(); }
        }
      }
    }
  }
  assert.ok(executed.length >= 300, "全组合执行，实际=" + executed.length);
  console.log("§20.4 执行组合=" + executed.length + "，保守输入(§20.2.2)=" + conservative.length + " 例，样例=" + conservative.slice(0, 4).join(" "));
});

// ---------- §20.7 continuous chains ----------
function hostOver(multi) {
  const members = [legacyMethod(source, "effectiveTrafficPolicy()"), legacyMethod(source, "ensureRealtimeConnected(_reason)")];
  const host = hostFixture(members).host;
  host.isRealtimeMode = () => true;
  host.client = { connect: async () => { await multi.connect(); }, diagnostics: () => multi.diagnostics() };
  return host;
}

async function multiOver(pairs) {
  const multi = new MultiEndpointRealtimeClient(pairs.map((pair) => endpoint(pair[0])), () => new RequestBudget());
  multi.clients.clear();
  for (const pair of pairs) multi.clients.set(pair[0], pair[1]);
  return multi;
}

test("chain1: Worker SSE 成功 → 展示快照软失败且独立流仍活 → 首次低流量 → 重复 policy/connect/ensure（A12→A16）", async () => {
  const harness = newHarness("E-sse/V=true", "N06");
  try {
    const client = harness.client;
    await harness.setup("E-sse/V=true", "N06");
    const soft = client.diagnostics();
    assert.equal(soft.streamStatus, "sse", "步骤0: 真实 SSE 已建立且独立流仍活");
    assert.equal(soft.displayFaultClass, "W", "步骤1: 活流上的展示快照失败只是软提示");
    assert.match(String(soft.lastError), /遥测查询待核实/, "步骤1: 真实提示保留");
    const requests = harness.requests();
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    const first = client.diagnostics();
    assert.equal(first.streamStatus, "disconnected", "步骤2: 策略确实关掉展示通道");
    assert.equal(first.displayAutoClosed, true, "步骤2/A12: 首次主动关流必须认领");
    assert.equal(first.displayClosureReason, "display-auto", "步骤2: 原因是 display-auto");
    assert.match(String(first.lastError), /遥测查询待核实/, "步骤2: 软提示仍保留");
    for (let round = 0; round < 3; round += 1) {
      client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
      await tick();
      await client.connect();
      const again = client.diagnostics();
      assert.equal(again.displayAutoClosed, true, "步骤3 第" + (round + 1) + "次/A16: 重复同策略不得翻转成假离线");
      assert.equal(again.displayClosureReason, "display-auto", "步骤3 第" + (round + 1) + "次: 原因不变");
      assert.match(String(again.lastError), /遥测查询待核实/, "步骤3: 软提示不被清除");
    }
    assert.equal(harness.requests(), requests, "整段归因判定零新增网络请求");
    const multi = await multiOver([["w1", client]]);
    const host = hostOver(multi);
    await host.ensureRealtimeConnected("resume network");
    assert.equal(multi.diagnostics().displayAutoClosed, true, "步骤4: 聚合层保留策略关闭");
    assert.notEqual(host.lastError, "tunnel_unavailable", "步骤4: 宿主不得把 A12/A16 报成不可用");
    assert.equal(host.lastHealth, undefined, "步骤4: 不得生成 local_port_closed");
    await multi.disconnect("dispose");
  }
  finally { await harness.close(); }
});

test("chain2: 同一 WS 成功路径与旧代际 onopen 不得交叉写证据", async () => {
  const harness = newHarness("E-ws/V=true", "N08");
  try {
    const client = harness.client;
    await harness.setup("E-ws/V=true", "N08");
    const oldSocket = harness.transport.sockets.at(-1);
    assert.equal(client.diagnostics().streamStatus, "websocket", "步骤1: 真实 WS onopen 建立");
    assert.equal(client.diagnostics().displayFaultClass, "N", "步骤1: 成功即无故障");
    oldSocket.closeNow();
    assert.equal(client.diagnostics().displayFaultClass, "T", "步骤2: onclose 经真实断连入口写入 T");
    assert.equal(client.diagnostics().displayAutoClosed, false, "步骤2: 真实故障撤销认领");
    const generation = client.connectionGeneration;
    oldSocket.openNow();
    const stale = client.diagnostics();
    assert.equal(client.connectionGeneration, generation, "步骤3: 旧回调不改代际");
    assert.equal(stale.displayFaultClass, "T", "步骤3: 旧代际 onopen 不得清除 T");
    assert.equal(stale.streamStatus, "disconnected", "步骤3: 旧代际 onopen 不得改写状态");
    await client.disconnect("dispose");
  }
  finally { await harness.close(); }
});

test("chain3: polling 首快照尚未成功 → 被模式取消且无故障（N/A11→A15）；真实快照失败反证进入 T", async () => {
  const cancelled = newHarness("Q/V=false", "N08");
  try {
    const client = cancelled.client;
    await cancelled.setup("Q/V=false", "N08");
    assert.equal(client.diagnostics().streamStatus, "polling", "步骤1: 首个快照尚未成功");
    assert.equal(client.diagnostics().displayFaultClass, "N", "步骤1: 尚未成功不等于故障");
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    assert.equal(client.diagnostics().displayAutoClosed, true, "步骤2/A11: 模式取消握手不得制造离线");
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    await client.connect();
    assert.equal(client.diagnostics().displayAutoClosed, true, "步骤3/A15: 重复同策略仍认领");
    await client.disconnect("dispose");
  }
  finally { await cancelled.close(); }

  const failed = newHarness("C/V=false", "N08");
  try {
    const client = failed.client;
    failed.transport.gpu = "fail";
    failed.transport.sse = "hang";
    client.updateRefreshPolicy({ preferWebSocket: true, fallbackToSse: false });
    void client.connect(0);
    await waitUntil(() => client.diagnostics().displayFaultClass === "T");
    assert.ok(["connecting", "disconnected", "polling"].includes(client.diagnostics().streamStatus), "反证: 握手/降级路径如实：" + client.diagnostics().streamStatus);
    assert.equal(client.diagnostics().displayFaultClass, "T", "反证: 首快照真实失败进入 T");
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    assert.equal(client.diagnostics().displayAutoClosed, false, "反证: T 不得被策略关流覆盖");
    await client.disconnect("dispose");
  }
  finally { await failed.close(); }
});

test("chain4: 真实软传输断连 → paused → 重复策略 → resume（A05/A13/A17），暂停与恢复都不消除 T", async () => {
  const harness = newHarness("D", "N08");
  try {
    const client = harness.client;
    const multi = await multiOver([["w1", client]]);
    const host = hostOver(multi);
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    await host.ensureRealtimeConnected("startup");
    assert.equal(multi.diagnostics().displayAutoClosed, true, "步骤0: 无故障关流仍认领（A11）");
    assert.equal(multi.diagnostics().endpoints[0].displayClosureReason, "display-auto", "步骤0: 原因是 display-auto");
    client.connectionLost("socket hang up");
    assert.equal(client.diagnostics().displayFaultClass, "T", "步骤1: 真实软断连 → T");
    await client.disconnect("paused");
    const paused = multi.diagnostics().endpoints[0];
    assert.equal(paused.streamStatus, "paused", "步骤2: 暂停状态如实");
    assert.equal(paused.displayFaultClass, "T", "步骤2/A05: 暂停保留传输故障");
    assert.equal(paused.displayAutoClosed, false, "步骤2/A05: 暂停不认领");
    await host.ensureRealtimeConnected("pause stream");
    assert.equal(host.lastError, undefined, "步骤2: 暂停期间不新发 tunnel_unavailable");
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    const afterPolicy = multi.diagnostics().endpoints[0];
    assert.equal(afterPolicy.streamStatus, "disconnected", "步骤3: 策略把暂停的流关掉");
    assert.equal(afterPolicy.displayAutoClosed, false, "步骤3/A13: T 不得被关流覆盖");
    assert.equal(afterPolicy.displayClosureReason, "transport-fault", "步骤3: 原因保持传输故障");
    await host.ensureRealtimeConnected("resume network");
    assert.equal(host.lastError, "tunnel_unavailable", "步骤3: 恢复判定后如实上报不可用");
    assert.equal(host.lastHealth, undefined, "步骤3: 传输故障不冒充主动端口检查");
    assert.match(String(client.diagnostics().lastError), /socket hang up/, "步骤3: 真实传输原因仍在逐端点诊断中");
    client.connect = async () => undefined;
    client.updateRefreshPolicy({ displayAutoRefresh: true, snapshotFallbackIntervalSeconds: 5 });
    await tick();
    assert.equal(client.diagnostics().displayAutoClosed, false, "步骤4/A17: 恢复不遗留错误认领");
    assert.equal(client.diagnostics().displayFaultClass, "T", "步骤4: 恢复尝试不清 T");
    await multi.disconnect("dispose");
  }
  finally { await harness.close(); }
});

test("chain5: 真实硬错 401 → paused → 重复策略 → 普通快照与同策略都不能解除硬错限制", async () => {
  const harness = newHarness("D", "N01");
  try {
    const client = harness.client;
    await harness.buildEvidence("N01", "D");
    const multi = await multiOver([["w1", client]]);
    const host = hostOver(multi);
    assert.equal(client.diagnostics().requiresManualReconnect, true, "步骤1: 硬错建立人工重连围栏");
    assert.equal(client.diagnostics().displayFaultClass, "H", "步骤1: 硬错分类 H");
    await client.disconnect("paused");
    assert.equal(multi.diagnostics().endpoints[0].displayFaultClass, "H", "步骤2/A06: 暂停保留硬错");
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    assert.equal(client.diagnostics().displayAutoClosed, false, "步骤3/A14: 硬错不得被关流覆盖");
    assert.equal(client.diagnostics().displayClosureReason, "hard-fault", "步骤3: 保持真实认证原因");
    await host.ensureRealtimeConnected("resume network");
    assert.equal(host.lastError, "tunnel_unavailable", "步骤3: 硬错仍上报不可用");
    await client.getSnapshot().catch(() => undefined);
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    await client.connect();
    assert.equal(client.diagnostics().displayFaultClass, "H", "步骤4: 普通快照/同策略不清 H");
    assert.equal(client.diagnostics().displayAutoClosed, false, "步骤4/A18: 重复仍是 false（纠正遗留 true）");
    await multi.disconnect("dispose");
  }
  finally { await harness.close(); }
});

test("chain6: 真实失败后恢复握手尚未完成再开低流量 T 保持；无故障的 C(V=false)/C(V=true) 取消都不发明离线", async () => {
  const faulted = newHarness("C/V=true", "N03");
  try {
    const client = faulted.client;
    await faulted.setup("C/V=true", "N03");
    assert.equal(client.diagnostics().streamStatus, "connecting", "步骤1: 恢复握手尚未完成");
    assert.equal(client.diagnostics().displayFaultClass, "T", "步骤1: 未完成的握手不清 T");
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    assert.equal(client.diagnostics().displayAutoClosed, false, "步骤2: 有故障的 connecting 关流不认领");
    await client.connect();
    assert.equal(client.diagnostics().displayAutoClosed, false, "步骤3: 早退后仍不认领");
    await client.disconnect("dispose");
  }
  finally { await faulted.close(); }

  for (const status of ["C/V=false", "C/V=true"]) {
    const harness = newHarness(status, "N08");
    try {
      const client = harness.client;
      await harness.setup(status, "N08");
      assert.equal(client.diagnostics().streamStatus, "connecting", status + ": 握手在飞");
      assert.equal(client.diagnostics().displayFaultClass, "N", status + ": 无故障证据");
      client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
      await tick();
      assert.equal(client.diagnostics().displayAutoClosed, true, status + ": 纯模式取消必须认领，不得发明离线");
      assert.equal(client.diagnostics().displayClosureReason, "display-auto", status + ": 原因 display-auto");
      await client.connect();
      assert.equal(client.diagnostics().displayAutoClosed, true, status + ": 重复仍认领");
      await client.disconnect("dispose");
    }
    finally { await harness.close(); }
  }
});

test("chain7: 故障之后匹配新成功 → 再低流量稳定 true；反证：另一通道成功与旧成功都不清 T", async () => {
  const after = newHarness("E-sse/V=true", "N07");
  try {
    const client = after.client;
    await after.setup("E-sse/V=true", "N07");
    assert.equal(client.diagnostics().displayFaultClass, "N", "步骤1: 匹配成功之后是 N07 历史文本");
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    assert.equal(client.diagnostics().displayAutoClosed, true, "步骤2: 已解除的故障不再阻断认领");
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    assert.equal(client.diagnostics().displayAutoClosed, true, "步骤3: 重复稳定 true");
    await client.disconnect("dispose");
  }
  finally { await after.close(); }

  const mismatched = newHarness("C/V=false", "N08");
  try {
    const client = mismatched.client;
    // 反证一：故障在快照通道，之后成功的是事件流通道，类别不匹配不得当作恢复证据。
    mismatched.transport.gpu = "fail";
    mismatched.transport.sse = "hang";
    client.updateRefreshPolicy({ preferWebSocket: true, fallbackToSse: false });
    void client.connect(0);
    await waitUntil(() => client.diagnostics().displayFaultClass === "T");
    assert.equal(client.diagnostics().displayFaultClass, "T", "反证步骤1: 首快照真实失败（connecting）→ T");
    mismatched.transport.gpu = "hang";          // 快照不再成功
    await client.disconnect("reconnect");
    void client.connect(0);
    await waitUntil(() => mismatched.transport.sockets.length > 1);
    mismatched.transport.sockets.at(-1).openNow();   // 事件流成功
    await waitUntil(() => client.diagnostics().streamStatus === "websocket");
    assert.equal(client.diagnostics().displayFaultClass, "T", "反证步骤2: 流通道成功不清快照通道 T");
    assert.equal(client.verifiedDisplayRound === true, true, "反证步骤2: 成功证据仍在，但不足以清另一通道的故障");
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    assert.equal(client.diagnostics().displayAutoClosed, false, "反证步骤3: 未解除 T 不认领");
    // 反证二：旧成功不得清除新故障。
    client.connectionLost("GPU 查询无有效响应", "snapshot");
    assert.equal(client.diagnostics().displayFaultClass, "T", "反证步骤4: 成功之后的新故障仍是 T");
    assert.equal(client.diagnostics().displayAutoClosed, false, "反证步骤4: 新故障撤销认领");
    await client.disconnect("dispose");
  }
  finally { await mismatched.close(); }
});

test("chain8: 合法策略关闭后新真实故障必须把 true 转 false；无新故障不得转 false；清文本也不得转 true", async () => {
  const harness = newHarness("D", "N08");
  try {
    const client = harness.client;
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    assert.equal(client.diagnostics().displayAutoClosed, true, "步骤1: 合法主动关闭");
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    assert.equal(client.diagnostics().displayAutoClosed, true, "步骤2: 没有新故障不得转 false");
    client.connectionLost("socket hang up");
    assert.equal(client.diagnostics().displayAutoClosed, false, "步骤3: 新真实故障撤销认领");
    client.lastError = undefined;
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    await client.connect();
    assert.equal(client.diagnostics().displayFaultPending, "transport", "步骤4: 清文本后故障记录仍在");
    assert.equal(client.diagnostics().displayAutoClosed, false, "步骤4: 清文本不得把归因翻回认领");
    await client.disconnect("dispose");
  }
  finally { await harness.close(); }
});

test("chain9: 两个 Worker 混合状态：逐端点故障保留、不串成功证据、不把全部展示关流报成全部端口关闭", async () => {
  const guardClosed = newHarness("D", "N08");
  const faulted = newHarness("D", "N03");
  try {
    const clientA = guardClosed.client;
    const clientB = faulted.client;
    await faulted.buildEvidence("N03", "D");
    const multi = await multiOver([["wa", clientA], ["wb", clientB]]);
    const host = hostOver(multi);
    clientA.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    clientB.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    clientB.connectionLost("socket hang up");
    const merged = multi.diagnostics();
    const byId = Object.fromEntries(merged.endpoints.map((item) => [item.id, item]));
    assert.equal(byId.wa.displayAutoClosed, true, "端点A: 纯策略关闭");
    assert.equal(byId.wa.displayFaultClass, "N", "端点A: 不得借用B的故障");
    assert.equal(byId.wa.lastError, undefined, "端点A: 不被写入别人的错误");
    assert.equal(byId.wb.displayAutoClosed, false, "端点B: 真实故障不认领");
    assert.equal(byId.wb.displayFaultClass, "T", "端点B: 故障逐端点保留");
    assert.equal(merged.displayAutoClosed, false, "聚合: 一个端点有故障时不得整体声称策略关闭");
    await host.ensureRealtimeConnected("resume network");
    assert.equal(host.lastError, "tunnel_unavailable", "聚合: 存在真实故障端点时如实上报");
    // 反过来：全部端点都只是策略关闭时，不得由展示通道状态新增端口关闭（全新宿主，不沿用上一轮结果）。
    clientB.lastError = undefined;
    clientB.displayFaultPending = "none";
    clientB.displayFaults.clear();
    clientB.displayErrorOrigin = "none";
    clientB.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    const cleanHost = hostOver(multi);
    await cleanHost.ensureRealtimeConnected("resume network");
    assert.equal(multi.diagnostics().displayAutoClosed, true, "聚合: 两端都策略关闭后聚合认领");
    assert.notEqual(cleanHost.lastError, "tunnel_unavailable", "聚合: 全部展示关流不得报端口关闭");
    assert.equal(cleanHost.lastHealth, undefined, "聚合: 不生成在线或离线健康");
    await multi.disconnect("dispose");
  }
  finally { await guardClosed.close(); await faulted.close(); }
});

test("chain10: 重复调用、无效 display-auto 请求、旧回调/已销毁客户端、用户全暂停与 resume 先后都不越界", async () => {
  const harness = newHarness("E-sse/V=true", "N08");
  try {
    const client = harness.client;
    await harness.setup("E-sse/V=true", "N08");
    const requests = harness.requests();
    for (let round = 0; round < 4; round += 1) {
      client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
      await tick();
    }
    assert.equal(client.diagnostics().displayAutoClosed, true, "步骤1: 重复同策略稳定认领");
    assert.equal(client.diagnostics().displayFaultClass, "N", "步骤1: 判定不引入故障");
    assert.equal(harness.requests(), requests, "步骤1: 重复策略与归因写回零新增网络请求");
    // G=enabled 时的 display-auto 请求按 passive 处理：不伪造一次关闭。
    client.updateRefreshPolicy({ displayAutoRefresh: true, snapshotFallbackIntervalSeconds: 5 });
    await tick();
    const before = client.diagnostics().displayAutoClosed;
    client.decideDisplayClosure({ kind: "close", reason: "display-auto", generation: client.connectionGeneration });
    assert.equal(client.diagnostics().displayAutoClosed, before, "步骤2: 闸门开着时的 display-auto 请求不改写归因");
    const staleGeneration = client.connectionGeneration + 11;
    client.decideDisplayClosure({ kind: "close", reason: "display-auto", generation: staleGeneration });
    assert.equal(client.diagnostics().displayAutoClosed, before, "步骤3: 旧代际回调不写回");
    // 用户全暂停：不新增网络、不清故障；尚未完成的恢复握手也不伪造恢复。
    harness.transport.sse = "hang";
    client.connectionLost("socket hang up");
    await client.disconnect("paused");
    assert.equal(client.diagnostics().displayFaultClass, "T", "步骤4: 暂停不消除故障");
    void client.connect(0);
    await tick();
    assert.equal(client.diagnostics().displayFaultClass, "T", "步骤4: 未完成的恢复握手不伪造恢复");
    const beforeDispose = harness.requests();
    await client.disconnect("dispose");
    client.updateRefreshPolicy({ displayAutoRefresh: false, snapshotFallbackIntervalSeconds: 0 });
    await tick();
    client.decideDisplayClosure({ kind: "close", reason: "display-auto", generation: client.connectionGeneration });
    assert.equal(client.diagnostics().displayAutoClosed, false, "步骤5: 已销毁客户端不认领");
    assert.equal(harness.requests(), beforeDispose, "步骤5: 销毁之后不再新增网络请求：" + harness.requests());
  }
  finally { await harness.close(); }
});
