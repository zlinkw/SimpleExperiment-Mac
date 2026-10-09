const test = require("node:test");
const assert = require("node:assert/strict");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { RealtimeTunnelClient } = require("../../dist/tunnel/RealtimeTunnelClient.js");

test("websocket realtime event updates state", async () => {
  const previous = global.WebSocket;
  const sockets = [];
  global.WebSocket = class {
    constructor(url) { this.url = url; sockets.push(this); }
    close() {}
  };
  const states = [];
  const client = new RealtimeTunnelClient(
    { localHost: "127.0.0.1", localPort: 18765 },
    new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }),
    undefined,
    (state) => states.push(state),
  );
  try {
    await client.connect(0);
    sockets[0].onopen();
    sockets[0].onmessage({ data: JSON.stringify({ schemaVersion: 1, seq: 1, type: "gpu_snapshot", generatedAt: new Date().toISOString(), source: "hub_agent", workerId: "w1", payload: [{ index: 0 }] }) });
    assert.equal(states.at(-1).gpu.w1[0].index, 0);
    assert.match(sockets[0].url, /^ws:\/\/127\.0\.0\.1:18765\/api\/events\?since=0/);
  } finally {
    await client.disconnect();
    global.WebSocket = previous;
  }
});
