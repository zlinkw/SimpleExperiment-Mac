const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { HttpTunnelClient } = require("../../dist/tunnel/TunnelClient.js");

test("tunnel client only talks to localhost API with token and coalesces snapshot", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url, token: req.headers["x-simple-agent-token"] });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") return res.end(JSON.stringify({ state: "agent_ok", agentVersion: "t", checkedAt: new Date().toISOString() }));
    if (req.url === "/api/snapshot") {
      setTimeout(() => res.end(JSON.stringify({ schemaVersion: 1, schedulerStates: [] })), 20);
      return;
    }
    if (req.url === "/api/actions/parse-results" && req.method === "POST") return res.end(JSON.stringify({ ok: true }));
    res.statusCode = 404;
    res.end("{}");
  });
  await listen(server);
  const port = server.address().port;
  const budget = new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] });
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: port, token: "secret", timeoutMs: 1000 }, budget);
  try {
    const health = await client.getHealth({ userInitiated: true });
    assert.equal(health.state, "agent_ok");
    await Promise.all([client.getSnapshot(), client.getSnapshot()]);
    assert.equal(calls.filter((item) => item.url === "/api/snapshot").length, 1);
    assert.equal(calls.every((item) => item.token === "secret"), true);
    await assert.rejects(() => client.postAction("parse-results", {}), /opId/);
    assert.deepEqual(await client.postAction("parse-results", { opId: "op-1" }), { ok: true });
  } finally {
    server.close();
  }
});

test("tunnel client requires an endpoint host", () => {
  const budget = new RequestBudget(defaultRequestBudgetConfig);
  assert.throws(() => new HttpTunnelClient({ localHost: "", localPort: 18765 }, budget), /host is required/);
});

test("failed Agent action exposes the complete structured reason instead of truncating the envelope", async () => {
  const reason = "action failed: Failure is not the validation-only test-access guard; manual review required";
  const server = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schemaVersion: 1, opId: "recover-training-1791552998153-ev2a7d",
      operationId: "2019fab2e674e090f60aa759cf5087d9", action: "retry-worker-task", status: "failed", message: reason }));
  });
  await listen(server);
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: server.address().port, timeoutMs: 1000 },
    new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] }));
  try {
    await assert.rejects(() => client.postAction("retry-worker-task", { opId: "recover-preview" }), error => {
      assert.match(error.message, /HTTP 500/);
      assert.ok(error.message.includes(reason), error.message);
      assert.equal(error.message.includes('"schemaVersion"'), false);
      return true;
    });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("distributed result rebuild may finish beyond the short telemetry timeout", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    setTimeout(() => res.end(JSON.stringify({ status: "completed", outputPaths: ["simple_cluster/results/distributed_preview.json"] })), 60);
  });
  await listen(server);
  const budget = new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] });
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: server.address().port,
    token: "secret", timeoutMs: 10 }, budget);
  try {
    const result = await client.postAction("rebuild-distributed-results", { opId: "rebuild-test" });
    assert.equal(result.status, "completed");
  } finally {
    server.close();
  }
});

test("configured request timeout aborts stalled tunnel actions", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    setTimeout(() => res.end(JSON.stringify({ ok: true })), 80);
  });
  await listen(server);
  const budget = new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] });
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: server.address().port, timeoutMs: 1000 }, budget);
  try {
    await assert.rejects(() => client.executeRequestJson("/api/actions/parse-results", "parse_results",
      { opId: "stalled-parse" }, { method: "POST", userInitiated: true, timeoutMs: 10 }), /10 毫秒无有效响应/);
  } finally {
    server.close();
  }
});

test("coalesced reads survive one caller cancelling and cancel when last subscriber leaves", async () => {
  let calls = 0;
  let lastRequestClosed;
  const closed = new Promise((resolve) => { lastRequestClosed = resolve; });
  const server = http.createServer((req, res) => {
    calls += 1;
    req.on("close", () => { if (req.aborted) lastRequestClosed(); });
    if (req.url !== "/api/snapshot") { res.statusCode = 404; return res.end("{}"); }
    setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ schemaVersion: 1, schedulerStates: [] })); }, 80);
  });
  await listen(server);
  const budget = new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] });
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: server.address().port, timeoutMs: 1000 }, budget);
  try {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = client.getSnapshot({ signal: firstController.signal });
    const second = client.getSnapshot({ signal: secondController.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    firstController.abort();
    await assert.rejects(first, (error) => error.name === "AbortError");
    assert.equal((await second).schemaVersion, 1);
    assert.equal(budget.snapshot().coalescedRequests, 1);

    const finalController = new AbortController();
    const finalRead = client.getSnapshot({ signal: finalController.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    finalController.abort();
    await assert.rejects(finalRead, (error) => error.name === "AbortError");
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("request was not cancelled")), 500))]);
    assert.equal(calls, 2);
  } finally {
    server.close();
  }
});

test("closing cache review aborts its read-only preview POST without replaying it", async () => {
  let calls = 0;
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const server = http.createServer((req, _res) => {
    assert.equal(req.url, "/api/actions/preview-cache-cleanup");
    calls++;
    started();
  });
  await listen(server);
  const budget = new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] });
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: server.address().port, timeoutMs: 1000 }, budget);
  const controller = new AbortController();
  try {
    const preview = client.postAction("preview-cache-cleanup", { opId: "preview-cancel-test" }, { signal: controller.signal });
    await requestStarted;
    controller.abort();
    await assert.rejects(preview, error => error.name === "AbortError");
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
