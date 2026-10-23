const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { MultiEndpointRealtimeClient } = require("../../dist/tunnel/MultiEndpointRealtimeClient.js");
const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");

test("Worker endpoints own allowed controls and file reads; retired Hub receives no requests", async () => {
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
    if(req.url.startsWith("/api/files/list")){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({schemaVersion:1,path:"simple_cluster",entries:[]}));return;}
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
    await assert.rejects(client.postAction("run-plan",{opId:"op-run"}),/WORKER_ACTION_REQUIRED/);
    await assert.rejects(client.postAction("delete-artifacts",{opId:"op-delete"}),/WORKER_ACTION_REQUIRED/);
    await client.postWorkerAction("w1", "stop-worker-task", { opId: "op-stop" });
    await assert.rejects(client.postWorkerAction("w1", "run-plan", { opId: "op-invalid" }), /action not allowed/);
    await client.listRemoteFiles("simple_cluster/state.json");
    assert.deepEqual(hubCalls,[],"historical Hub cannot receive actions or file reads");
    assert.ok(workerCalls.some(url=>url==='/api/actions/stop-worker-task'));
    assert.ok(workerCalls.some(url=>url.startsWith('/api/files/list')));
    assert.equal(workerCalls.some(url=>url==='/api/actions/run-plan'||url==='/api/actions/delete-artifacts'),false);
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
