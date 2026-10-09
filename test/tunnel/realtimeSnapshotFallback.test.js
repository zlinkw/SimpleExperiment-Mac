const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { readSource } = require("../_helpers/sourceReader");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { RealtimeTunnelClient, defaultRealtimeRefreshPolicy } = require("../../dist/tunnel/RealtimeTunnelClient.js");

test("snapshot fallback keeps lastKnownGood", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/snapshot") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ schemaVersion: 1, gpu: { w1: [{ index: 0 }] }, schedulerStates: [], experimentTraces: [] }));
      return;
    }
    res.writeHead(404).end();
  });
  await listen(server);
  const states = [];
  const client = new RealtimeTunnelClient(
    { localHost: "127.0.0.1", localPort: server.address().port },
    new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }),
    { ...defaultRealtimeRefreshPolicy, preferWebSocket: false, fallbackToSse: false, fallbackToPolling: true, snapshotFallbackIntervalSeconds: 60 },
    (state) => states.push(state),
  );
  try {
    await client.connect(0);
    assert.equal(states.at(-1).lastKnownGood.gpu.w1[0].index, 0);
  } finally {
    await client.disconnect();
    server.close();
  }
});

test("snapshot fallback respects a bounded configured interval and does not overlap", () => {
  const source = readSource("src/tunnel/RealtimeTunnelClient.ts");
  assert.doesNotMatch(source, /setInterval\(\(\) => void this\.refreshSnapshot/);
  assert.match(source, /scheduleSnapshotFallbackPoll\(\)/);
  assert.match(source, /snapshotFallbackDelayMs\(\)/);
  const c = new RealtimeTunnelClient({ localHost: "localhost", localPort: 1 }, new RequestBudget(), { ...defaultRealtimeRefreshPolicy, snapshotFallbackIntervalSeconds: 0.5 });
  assert.equal(c.snapshotFallbackDelayMs(), 5000);
  c.policy.snapshotFallbackIntervalSeconds = 15;
  assert.equal(c.snapshotFallbackDelayMs(), 15000);
  assert.match(source, /if \(this.snapshotInFlight\) return this.snapshotInFlight/);
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
