const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { OperationQueue } = require("../../dist/core/OperationQueue.js");
const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { HttpTunnelClient } = require("../../dist/tunnel/TunnelClient.js");

test("operation queue runs tunnel API actions only", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, host: req.socket.localAddress });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schemaVersion: 1, opId: "op-run", accepted: true, operationId: "run-plan-op-run" }));
  });
  await listen(server);
  const port = server.address().port;
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: port, timeoutMs: 1000 }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] }));
  const queue = new OperationQueue();
  try {
    await queue.enqueue({
      id: "run-plan",
      type: "run_plan",
      priority: "manual",
      targetKeys: ["plan"],
      run: async () => {
        await client.postAction("run-plan", { opId: "op-run", options: {} });
      },
    });
    assert.deepEqual(calls.map((item) => item.url), ["/api/actions/run-plan"]);
    assert.equal(calls[0].host, "127.0.0.1");
  } finally {
    server.close();
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}