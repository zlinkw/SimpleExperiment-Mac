const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { HttpTunnelClient } = require("../../dist/tunnel/TunnelClient.js");

test("gpu scheduler traces and live output use Hub Agent APIs", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schemaVersion: 1 }));
  });
  await listen(server);
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: server.address().port, timeoutMs: 1000 }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] }));
  try {
    await client.getGpu();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await client.getGpuHistory({ serverId: "worker a", gpuId: "0/1", start: 100, end: 200, maxPoints: 5000 });
    await client.getScheduler();
    await client.getTraces();
    await client.getLiveOutput("work_dirs/run 1/train.log", 12);
    assert.deepEqual(calls, [
      "/api/gpu",
      "/api/gpu/history?serverId=worker+a&gpuId=0%2F1&start=100&end=200&maxPoints=864",
      "/api/scheduler",
      "/api/traces",
      "/api/live-output?runKey=work_dirs%2Frun+1%2Ftrain.log&since=12",
    ]);
  } finally {
    server.close();
  }
});

test("live output uses its own request budget and explicit user reads work while hidden", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schemaVersion: 1, text: "log" }));
  });
  await listen(server);
  const budget = new RequestBudget({
    ...defaultRequestBudgetConfig,
    maxRequestsPerMinute: 100,
    minIntervalByPurpose: { snapshot: 60_000, manual_refresh: 60_000, live_output: 0 },
    pauseWhenHidden: true,
  });
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: server.address().port, timeoutMs: 1000 }, budget);
  try {
    budget.setHidden(true);
    await assert.rejects(client.getLiveOutput("a.log", 0), (error) => error.purpose === "live_output" && error.decision.reason === "hidden");
    await client.getLiveOutput("a.log", 0, { userInitiated: true });
    await client.getLiveOutput("b.log", 0, { userInitiated: true });
    assert.deepEqual(calls, ["/api/live-output?runKey=a.log&since=0", "/api/live-output?runKey=b.log&since=0"]);
  } finally {
    server.close();
  }
});

test("live output and manual refresh remain available with legacy cooldown settings", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schemaVersion: 1, text: "log" }));
  });
  await listen(server);
  const createClient = () => new HttpTunnelClient(
    { localHost: "127.0.0.1", localPort: server.address().port, timeoutMs: 1000 },
    new RequestBudget({ ...defaultRequestBudgetConfig, maxRequestsPerMinute: 100, minIntervalByPurpose: { snapshot: 60_000, manual_refresh: 60_000, live_output: 0 }, pauseWhenHidden: true }),
  );
  try {
    const first = createClient();
    await first.getResultsSummary("", { userInitiated: true });
    await first.getLiveOutput("run.log", 0, { userInitiated: true });
    const second = createClient();
    await second.getLiveOutput("other.log", 0, { userInitiated: true });
    await second.getResultsSummary("", { userInitiated: true });
    assert.deepEqual(calls, [
      "/api/results/summary", "/api/live-output?runKey=run.log&since=0",
      "/api/live-output?runKey=other.log&since=0", "/api/results/summary",
    ]);
  } finally {
    server.close();
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
