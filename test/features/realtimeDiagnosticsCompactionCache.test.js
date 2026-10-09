const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");
const { RealtimeTunnelClient } = require("../../dist/tunnel/RealtimeTunnelClient.js");
const { MultiEndpointRealtimeClient } = require("../../dist/tunnel/MultiEndpointRealtimeClient.js");
const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function endpoint(id = "hub") {
  return { id, role: id === "hub" ? "hub" : "worker", displayName: id, localHost: "127.0.0.1", localPort: id === "hub" ? 18765 : 18766 };
}

function loadCompactors() {
  const sandbox = {
    EMPTY_REALTIME_DIAGNOSTICS_FOR_WEBVIEW: Object.freeze({}),
    realtimeDiagnosticsForWebviewCache: new WeakMap(),
    realtimeDiagnosticsForPostGateCache: new WeakMap(),
    sensitiveCalls: 0,
    endpointCalls: 0,
    objectRecord(value) {
      return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    },
    firstStringFieldForWebview(item, ...keys) {
      for (const key of keys) if (typeof item[key] === "string" && item[key].trim()) return item[key].trim();
      return undefined;
    },
    firstNumberFieldForWebview(item, ...keys) {
      for (const key of keys) {
        const value = Number(item[key]);
        if (Number.isFinite(value) && item[key] !== "") return Math.trunc(value);
      }
      return undefined;
    },
    compactSensitiveText(value, limit) {
      sandbox.sensitiveCalls += 1;
      return String(value || "").slice(0, limit);
    },
    dropUndefined(record) {
      return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
    },
    compactRealtimeEndpointForWebview(item) {
      sandbox.endpointCalls += 1;
      return { id: item.id, lastSeq: item.lastSeq, lastHeartbeatAt: item.lastHeartbeatAt };
    },
    compactRealtimeEndpointForPostGate(item) {
      sandbox.endpointCalls += 1;
      return { id: item.id, streamStatus: item.streamStatus };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("compactRealtimeDiagnosticsForWebview"),
    extractFunction("compactRealtimeDiagnosticsForPostGate"),
    "this.compactWebview = compactRealtimeDiagnosticsForWebview;",
    "this.compactPostGate = compactRealtimeDiagnosticsForPostGate;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("single endpoint diagnostics reuse unchanged scalar state", () => {
  const client = new RealtimeTunnelClient(endpoint(), {});
  const first = client.diagnostics();

  assert.strictEqual(client.diagnostics(), first);
  client.status = "websocket";
  const connected = client.diagnostics();
  assert.notStrictEqual(connected, first);
  assert.equal(connected.streamStatus, "websocket");
  client.state.lastSeq = 4;
  assert.notStrictEqual(client.diagnostics(), connected);
});

test("multi endpoint diagnostics reuse child snapshots and invalidate on one endpoint", () => {
  const client = new MultiEndpointRealtimeClient([endpoint("hub"), endpoint("worker-a")], () => new RequestBudget(defaultRequestBudgetConfig));
  const first = client.diagnostics();

  assert.strictEqual(client.diagnostics(), first);
  const worker = client.clients.get("worker-a");
  worker.status = "websocket";
  const changed = client.diagnostics();
  assert.notStrictEqual(changed, first);
  assert.equal(changed.endpoints.find((item) => item.id === "worker-a").streamStatus, "websocket");
  assert.strictEqual(client.diagnostics(), changed);
});

test("realtime Webview and post gate compactors cache independently", () => {
  const sandbox = loadCompactors();
  const diagnostics = {
    streamStatus: "websocket",
    lastSeq: 9,
    lastHeartbeatAt: "2026-07-30T00:00:00Z",
    reconnectCount: 2,
    lastError: "temporary",
    endpoints: [{ id: "hub", streamStatus: "websocket", lastSeq: 9, lastHeartbeatAt: "2026-07-30T00:00:00Z" }],
  };
  const webview = sandbox.compactWebview(diagnostics);
  const postGate = sandbox.compactPostGate(diagnostics);
  const calls = { endpoint: sandbox.endpointCalls, sensitive: sandbox.sensitiveCalls };

  assert.strictEqual(sandbox.compactWebview(diagnostics), webview);
  assert.strictEqual(sandbox.compactPostGate(diagnostics), postGate);
  assert.deepEqual({ endpoint: sandbox.endpointCalls, sensitive: sandbox.sensitiveCalls }, calls);
  assert.equal(webview.lastSeq, 9);
  assert.equal(webview.lastHeartbeatAt, "2026-07-30T00:00:00Z");
  assert.equal(postGate.lastSeq, undefined);
  assert.equal(postGate.lastHeartbeatAt, undefined);
  assert.notStrictEqual(sandbox.compactWebview({ ...diagnostics }), webview);
});

test("realtime compactors preserve endpoint limits and shared empty fallback", () => {
  const sandbox = loadCompactors();
  const diagnostics = { endpoints: Array.from({ length: 85 }, (_, index) => ({ id: `worker-${index}` })) };

  assert.equal(sandbox.compactWebview(diagnostics).endpoints.length, 80);
  assert.equal(sandbox.compactWebview(diagnostics).endpointCount, 85);
  assert.strictEqual(sandbox.compactWebview(undefined), sandbox.EMPTY_REALTIME_DIAGNOSTICS_FOR_WEBVIEW);
  assert.strictEqual(sandbox.compactPostGate(undefined), sandbox.EMPTY_REALTIME_DIAGNOSTICS_FOR_WEBVIEW);
});
