const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { HttpTunnelClient } = require("../../dist/tunnel/TunnelClient.js");

test("runtime deploy restart self-check diagnostics and debug bundle use Hub Agent API", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/diagnostics") return res.end(JSON.stringify({ schemaVersion: 1 }));
    if (req.url === "/api/audit/tail") return res.end(JSON.stringify({ schemaVersion: 1, tail: "" }));
    res.end(JSON.stringify({ schemaVersion: 1, opId: "op", accepted: true, operationId: "operation-op" }));
  });
  await listen(server);
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: server.address().port, timeoutMs: 1000 }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] }));
  try {
    await client.postAction("deploy-runtime", { opId: "op-deploy" });
    await client.postAction("restart-agent", { opId: "op-restart" });
    await client.postAction("self-check", { opId: "op-self" });
    await client.postAction("create-debug-bundle", { opId: "op-debug" });
    await client.postAction("create-offline-bundle", { opId: "op-offline" });
    await client.getDiagnostics();
    await client.getAuditTail();
    assert.deepEqual(calls, [
      "/api/actions/deploy-runtime",
      "/api/actions/restart-agent",
      "/api/actions/self-check",
      "/api/actions/create-debug-bundle",
      "/api/actions/create-offline-bundle",
      "/api/diagnostics",
      "/api/audit/tail",
    ]);
  } finally {
    server.close();
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}