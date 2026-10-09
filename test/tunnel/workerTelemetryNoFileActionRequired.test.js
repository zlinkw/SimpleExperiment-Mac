const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { MultiEndpointRealtimeClient } = require("../../dist/tunnel/MultiEndpointRealtimeClient.js");
const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");

test("worker telemetry endpoints receive only bounded worker actions and no file operations", async () => {
  const hubCalls = [];
  const workerCalls = [];
  const hub = http.createServer((req, res) => {
    hubCalls.push(req.url);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Connection", "close");
    if (req.url.startsWith("/api/actions/")) return res.end(JSON.stringify({ accepted: true }));
    if (req.url.startsWith("/api/files/list")) return res.end(JSON.stringify({ schemaVersion: 1, path: "simple_cluster", entries: [] }));
    res.end("{}");
  });
  const worker = http.createServer((req, res) => {
    workerCalls.push(req.url);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Connection", "close");
    res.end("{}");
  });
  await Promise.all([listen(hub), listen(worker)]);
  const client = new MultiEndpointRealtimeClient([
    { id: "hub", role: "hub", localHost: "127.0.0.1", localPort: hub.address().port },
    { id: "w1", role: "worker", localHost: "127.0.0.1", localPort: worker.address().port },
  ], () => new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] }));
  try {
    await client.postAction("run-plan", { opId: "op-run" });
    await client.postAction("delete-artifacts", { opId: "op-delete" });
    await client.postWorkerAction("w1", "stop-worker-task", { opId: "op-stop" });
    await assert.rejects(client.postWorkerAction("w1", "run-plan", { opId: "op-invalid" }), /action not allowed/);
    await client.listRemoteFiles("simple_cluster/state.json");
    assert.ok(hubCalls.some((url) => url === "/api/actions/run-plan"));
    assert.ok(hubCalls.some((url) => url === "/api/actions/delete-artifacts"));
    assert.ok(hubCalls.some((url) => url.startsWith("/api/files/list")));
    assert.ok(workerCalls.some((url) => url === "/api/actions/stop-worker-task"));
    assert.equal(workerCalls.some((url) => url === "/api/actions/run-plan" || url.startsWith("/api/files/")), false);
    assert.equal(hubCalls.some((url) => url === "/api/actions/stop-worker-task"), false);
  } finally {
    await Promise.all([closeServer(hub), closeServer(worker)]);
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
