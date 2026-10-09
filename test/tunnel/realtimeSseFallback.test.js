const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { RealtimeTunnelClient, defaultRealtimeRefreshPolicy } = require("../../dist/tunnel/RealtimeTunnelClient.js");

test("SSE fallback receives realtime event", async () => {
  const previous = global.WebSocket;
  global.WebSocket = undefined;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/events/sse")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ schemaVersion: 1, seq: 2, type: "scheduler_snapshot", generatedAt: new Date().toISOString(), source: "hub_agent", payload: { schedulerStates: [{ runKey: "r1" }] } })}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  await listen(server);
  const states = [];
  const client = new RealtimeTunnelClient(
    { localHost: "127.0.0.1", localPort: server.address().port },
    new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }),
    { ...defaultRealtimeRefreshPolicy, preferWebSocket: true, fallbackToSse: true, fallbackToPolling: false },
    (state) => states.push(state),
  );
  try {
    await client.connect(0);
    await delay(30);
    assert.equal(states.at(-1).schedulerStates[0].runKey, "r1");
  } finally {
    await client.disconnect();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await delay(20);
    global.WebSocket = previous;
  }
});

test("capability false skips websocket and connects directly to SSE", async () => {
  const previous = global.WebSocket;
  let websocketAttempts = 0;
  let sseResponse;
  global.WebSocket = class {
    constructor() { websocketAttempts += 1; }
    close() {}
  };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/events/sse")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sseResponse = res;
      res.write(`data: ${JSON.stringify({ schemaVersion: 1, seq: 3, type: "scheduler_snapshot", generatedAt: new Date().toISOString(), source: "hub_agent", payload: { schedulerStates: [{ runKey: "cap-sse" }] } })}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  await listen(server);
  const states = [];
  const client = new RealtimeTunnelClient(
    {
      localHost: "127.0.0.1",
      localPort: server.address().port,
      capabilities: { endpoints: { websocketEvents: false, sseEvents: true } },
    },
    new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }),
    { ...defaultRealtimeRefreshPolicy, preferWebSocket: true, fallbackToSse: true, fallbackToPolling: false, uiBatchMs: 10 },
    (state) => states.push(state),
  );
  try {
    await client.connect(0);
    await waitFor(() => states.at(-1)?.schedulerStates?.[0]?.runKey === "cap-sse");
    assert.equal(websocketAttempts, 0);
    assert.equal(client.diagnostics().streamStatus, "sse");
    assert.equal(states.at(-1).schedulerStates[0].runKey, "cap-sse");
  } finally {
    await client.disconnect();
    sseResponse?.end();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await delay(20);
    global.WebSocket = previous;
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("timed out waiting for SSE state");
}
