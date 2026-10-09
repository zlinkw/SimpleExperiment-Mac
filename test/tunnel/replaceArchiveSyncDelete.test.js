const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { HttpTunnelClient } = require("../../dist/tunnel/TunnelClient.js");

test("archive sync delete operations use Hub Agent action API", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Connection", "close");
    res.end(JSON.stringify({ schemaVersion: 1, opId: "op", accepted: true, operationId: "operation-op" }));
  });
  await listen(server);
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: server.address().port, timeoutMs: 1000 }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] }));
  try {
    for (const action of ["archive-artifacts", "sync-artifacts", "complete-three-way", "delete-artifacts", "reconcile-deletions"]) {
      await client.postAction(action, { opId: `op-${action}`, targets: [] });
    }
    assert.deepEqual(calls, [
      "/api/actions/archive-artifacts",
      "/api/actions/sync-artifacts",
      "/api/actions/complete-three-way",
      "/api/actions/delete-artifacts",
      "/api/actions/reconcile-deletions",
    ]);
  } finally {
    await closeServer(server);
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
