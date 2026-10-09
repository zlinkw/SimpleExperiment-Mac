const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { HttpTunnelClient } = require("../../dist/tunnel/TunnelClient.js");

test("run stop retry reproduce validate dry-run use action API", async () => {
  const calls = [];
  const server = actionServer(calls);
  await listen(server);
  const client = tunnelClient(server.address().port);
  try {
    for (const action of ["run-plan", "stop-experiment", "retry-experiment", "reproduce-plan", "validate-plan", "dry-run-plan"]) {
      const result = await client.postAction(action, { opId: `op-${action}`, options: {} });
      assert.equal(result.accepted, true);
    }
    assert.deepEqual(calls, [
      "/api/actions/run-plan",
      "/api/actions/stop-experiment",
      "/api/actions/retry-experiment",
      "/api/actions/reproduce-plan",
      "/api/actions/validate-plan",
      "/api/actions/dry-run-plan",
    ]);
  } finally {
    server.close();
  }
});

test("stop reaches HTTP while validation is pending despite legacy concurrency settings", async () => {
  let releaseValidation;
  let validationReceived;
  const received = new Promise((resolve) => { validationReceived = resolve; });
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/actions/validate-plan") {
      releaseValidation = () => res.end(JSON.stringify({ schemaVersion: 1, accepted: true }));
      validationReceived();
    } else {
      res.end(JSON.stringify({ schemaVersion: 1, accepted: true }));
    }
  });
  await listen(server);
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: server.address().port, timeoutMs: 1000 },
    new RequestBudget({ ...defaultRequestBudgetConfig, maxRequestsPerMinute: 1, maxConcurrentRequests: 1,
      minIntervalByPurpose: { run_plan: 60_000, stop: 60_000 } }));
  const validation = client.postAction("validate-plan", { opId: "validation" });
  try {
    await received;
    assert.equal((await client.postAction("stop-experiment", { opId: "stop" })).accepted, true);
  } finally {
    releaseValidation?.();
    await validation;
    await new Promise((resolve) => server.close(resolve));
  }
});

function actionServer(calls) {
  return http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schemaVersion: 1, opId: "op", accepted: true, operationId: "operation-op" }));
  });
}

function tunnelClient(port) {
  return new HttpTunnelClient({ localHost: "127.0.0.1", localPort: port, timeoutMs: 1000 }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] }));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
