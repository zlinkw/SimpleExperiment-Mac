const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { RealtimeTunnelClient } = require("../../dist/tunnel/RealtimeTunnelClient.js");

test("journal gap triggers snapshot recovery", async () => {
  const previous = global.WebSocket;
  const sockets = [];
  global.WebSocket = class {
    constructor() { sockets.push(this); }
    close() {}
  };
  const server = http.createServer((req, res) => {
    if (req.url === "/api/snapshot") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ schemaVersion: 1, schedulerStates: [{ runKey: "snap" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await listen(server);
  const states = [];
  const client = new RealtimeTunnelClient(
    { localHost: "127.0.0.1", localPort: server.address().port },
    new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }),
    undefined,
    (state) => states.push(state),
  );
  try {
    await client.connect(0);
    sockets[0].onmessage({ data: JSON.stringify({ payload: { code: "journal_gap", reason: "slow_consumer", snapshotRequired: true } }) });
    await delay(30);
    assert.equal(states.at(-1).lastKnownGood.schedulerStates[0].runKey, "snap");
    assert.equal(states.at(-1).warnings.includes("bad event schema"), false);
  } finally {
    await client.disconnect();
    server.close();
    global.WebSocket = previous;
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
