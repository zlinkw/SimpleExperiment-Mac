const test = require("node:test");
const assert = require("node:assert/strict");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { RealtimeTunnelClient } = require("../../dist/tunnel/RealtimeTunnelClient.js");

test("reconnect uses last seq in events URL", async () => {
  const previous = global.WebSocket;
  const urls = [];
  const sockets = [];
  global.WebSocket = class {
    constructor(url) { urls.push(url); sockets.push(this); }
    close() {}
  };
  const client = new RealtimeTunnelClient(
    { localHost: "127.0.0.1", localPort: 18765 },
    new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }),
  );
  try {
    await client.connect(0);
    sockets[0].onmessage({ data: JSON.stringify({ schemaVersion: 1, seq: 9, type: "agent_heartbeat", generatedAt: new Date().toISOString(), source: "hub_agent", payload: {} }) });
    await client.disconnect("reconnect");
    await client.connect(client.currentState().lastSeq);
    assert.match(urls[1], /since=9/);
  } finally {
    await client.disconnect();
    global.WebSocket = previous;
  }
});
