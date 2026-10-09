const test = require("node:test");
const assert = require("node:assert/strict");

const { RequestBudget, RequestBudgetCoordinator, RequestBudgetDeniedError, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { defaultTunnelGatewayConfig, normalizeTunnelGatewayConfig, refreshProfiles, requestBudgetConfigFromTunnel } = require("../../dist/tunnel/TunnelGateway.js");

test("legacy quotas and cooldowns no longer reject requests; explicit pause and hidden remain", async () => {
  const budget = new RequestBudget({
    ...defaultRequestBudgetConfig,
    maxRequestsPerMinute: 2,
    minIntervalByPurpose: { health: 0, snapshot: 50, manual_refresh: 10 },
  });

  await budget.run("health", async () => "ok");
  budget.config.minIntervalByPurpose.health = 50;
  for (let index = 0; index < 150; index++) {
    assert.equal(await budget.run("health", async () => "ok"), "ok");
  }
  budget.config.minIntervalByPurpose.health = 0;

  budget.setHidden(true);
  await assert.rejects(() => budget.run("snapshot", async () => "blocked"), /hidden/);

  budget.pauseAll();
  await assert.rejects(() => budget.run("snapshot", async () => "blocked", { userInitiated: true }), /paused/);
  await assert.doesNotReject(() => budget.run("health", async () => "ok", { userInitiated: true }));

  const snapshot = budget.snapshot();
  assert.equal(snapshot.paused, true);
  assert.ok(snapshot.deniedLastMinute >= 2);
});

test("events are enabled by default for realtime tunnel", async () => {
  const budget = new RequestBudget(defaultRequestBudgetConfig);
  assert.equal(await budget.run("events", async () => "ok"), "ok");
});

test("offline purposes remain disabled and resume restores allowed requests", async () => {
  const budget = new RequestBudget({ ...defaultRequestBudgetConfig, disabledPurposes: ["file_transfer"] });
  await assert.rejects(() => budget.run("file_transfer", async () => "blocked", { userInitiated: true }),
    (error) => error instanceof RequestBudgetDeniedError && error.decision.reason === "offline");
  budget.pauseAll();
  await assert.rejects(() => budget.run("stop", async () => "blocked", { userInitiated: true }), /paused/);
  budget.resume();
  assert.equal(await budget.run("stop", async () => "ok", { userInitiated: true }), "ok");
  assert.equal(budget.snapshot().lastDeniedReason, undefined);
});

test("dispatch, reconciliation and stop do not wait behind an unfinished request", async () => {
  const budget = new RequestBudget({ ...defaultRequestBudgetConfig, maxRequestsPerMinute: 1,
    maxConcurrentRequests: 1, minIntervalByPurpose: { run_plan: 60_000 } });
  await budget.run("run_plan", async () => "validated");
  budget.setHidden(true);
  let release;
  const first = budget.run("job_dispatch", () => new Promise((resolve) => { release = resolve; }));
  try {
    const calls = ["job_dispatch", "job_reconcile", "stop"].map((purpose) => budget.run(purpose, async () => purpose, { userInitiated: true }));
    const completed = await Promise.race([Promise.all(calls), new Promise((resolve) => setTimeout(() => resolve("blocked"), 100))]);
    assert.deepEqual(completed, ["job_dispatch", "job_reconcile", "stop"]);
  } finally { release("first"); await first; }
  assert.equal(budget.snapshot().requestsLastMinute, 5);
  budget.pauseAll();
  await assert.rejects(() => budget.run("job_dispatch", async () => "blocked"), /paused/);
});

test("worker task reconciliation still reads Agent tasks when the polling quota is exhausted", async () => {
  const http = require("node:http");
  const { HttpTunnelClient } = require("../../dist/tunnel/TunnelClient.js");
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/api/worker/tasks");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ schemaVersion: 1, tasks: [{ commandId: "existing-job", status: "running" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const budget = new RequestBudget({ ...defaultRequestBudgetConfig, maxRequestsPerMinute: 1,
      maxConcurrentRequests: 1, minIntervalByPurpose: {} });
    await budget.run("health", async () => "ok");
    budget.setHidden(true);
    const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: server.address().port }, budget);
    const snapshot = await client.getWorkerTasks();
    assert.deepEqual(snapshot.tasks.map((task) => task.commandId), ["existing-job"]);
    assert.equal(budget.snapshot().requestsLastMinute, 2);
    budget.pauseAll();
    await assert.rejects(() => client.getWorkerTasks(), /paused/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("request budget rolling counters expire allowed and denied events together", async () => {
  const realNow = Date.now;
  let now = Date.parse("2026-07-26T00:00:00.000Z");
  Date.now = () => now;
  try {
    const budget = new RequestBudget({
      ...defaultRequestBudgetConfig,
      maxRequestsPerMinute: 10,
      minIntervalByPurpose: {},
    });
    await budget.run("health", async () => "ok");
    budget.setHidden(true);
    assert.equal(budget.decide("snapshot").allowed, false);
    assert.deepEqual(
      (({ requestsLastMinute, deniedLastMinute, lastAllowedAt }) => ({ requestsLastMinute, deniedLastMinute, lastAllowedAt }))(budget.snapshot()),
      { requestsLastMinute: 1, deniedLastMinute: 1, lastAllowedAt: "2026-07-26T00:00:00.000Z" },
    );

    now += 60_001;
    assert.deepEqual(
      (({ requestsLastMinute, deniedLastMinute, lastAllowedAt }) => ({ requestsLastMinute, deniedLastMinute, lastAllowedAt }))(budget.snapshot()),
      { requestsLastMinute: 0, deniedLastMinute: 0, lastAllowedAt: undefined },
    );
  } finally {
    Date.now = realNow;
  }
});

test("request budget avoids rescanning or shifting the rolling event window", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../../src/tunnel/RequestBudget.ts"), "utf8");
  assert.match(source, /private eventStart = 0/);
  assert.match(source, /private allowedEventCount = 0/);
  assert.match(source, /private deniedEventCount = 0/);
  assert.doesNotMatch(source, /this\.events\.shift\(\)|this\.events\.filter\(|\[\.\.\.this\.events\]\.reverse\(\)/);
});

test("request diagnostics keep only bounded event samples and time buckets", async () => {
  const budget = new RequestBudget(defaultRequestBudgetConfig);
  for (let index = 0; index < 1000; index += 1) await budget.run("health", async () => undefined);
  assert.ok(budget.events.length - budget.eventStart <= 256);
  assert.ok(budget.eventBuckets.length - budget.eventBucketStart <= 61);
  assert.ok(budget.events.length <= 600);
  assert.ok(budget.eventBuckets.length <= 100);
  assert.equal(budget.snapshot().requestsLastMinute, 1000);
});

test("shared coordinator enforces per-worker and global request and transfer limits", async () => {
  const coordinator = new RequestBudgetCoordinator({
    maxConcurrentRequestsPerWorker: 2,
    maxConcurrentRequestsGlobal: 3,
    maxConcurrentTransfersPerWorker: 1,
    maxConcurrentTransfersGlobal: 2,
    maxConcurrentEmergencyRequests: 1,
    maxQueuedRequests: 12,
  });
  const makeBudget = (scope) => {
    const budget = new RequestBudget(defaultRequestBudgetConfig);
    budget.attachCoordinator(coordinator, scope);
    return budget;
  };
  const firstWorker = makeBudget("worker-a");
  const secondWorker = makeBudget("worker-b");
  const started = [];
  const release = new Map();
  const work = (name, budget, purpose = "snapshot") => budget.run(purpose, () => new Promise((resolve) => {
    started.push(name);
    release.set(name, resolve);
  }));

  const pending = [
    work("a1", firstWorker), work("a2", firstWorker), work("b1", secondWorker), work("b2", secondWorker),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a1", "a2", "b1"]);
  assert.equal(firstWorker.snapshot().inFlight, 2);
  assert.equal(secondWorker.snapshot().queued, 1);
  assert.equal(coordinator.globalInFlight, 3);

  release.get("a1")("a1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a1", "a2", "b1", "b2"]);
  for (const finish of release.values()) finish("done");
  await Promise.all(pending);

  const transferA = work("ta1", firstWorker, "file_transfer");
  const transferAQueued = work("ta2", firstWorker, "file_transfer");
  const transferB = work("tb1", secondWorker, "file_transfer");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.slice(-2), ["ta1", "tb1"]);
  assert.equal(firstWorker.snapshot().queued, 1);
  assert.equal(firstWorker.snapshot().transferInFlight, 2);
  release.get("ta1")("done");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.at(-1), "ta2");
  release.get("ta2")("done");
  release.get("tb1")("done");
  await Promise.all([transferA, transferAQueued, transferB]);
});

test("stop and reconciliation use reserved capacity; queued reads honor cancellation", async () => {
  const coordinator = new RequestBudgetCoordinator({
    maxConcurrentRequestsPerWorker: 1,
    maxConcurrentRequestsGlobal: 1,
    maxConcurrentTransfersPerWorker: 1,
    maxConcurrentTransfersGlobal: 1,
    maxConcurrentEmergencyRequests: 1,
    maxQueuedRequests: 4,
  });
  const budget = new RequestBudget(defaultRequestBudgetConfig);
  budget.attachCoordinator(coordinator, "worker");
  let releaseNormal;
  const normal = budget.run("snapshot", () => new Promise((resolve) => { releaseNormal = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  let staleReadStarted = false;
  const staleRead = budget.run("snapshot", async () => { staleReadStarted = true; }, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(budget.snapshot().queued, 1);
  controller.abort();
  await assert.rejects(staleRead, (error) => error.name === "AbortError");
  assert.equal(budget.snapshot().queued, 0);
  assert.equal(staleReadStarted, false);

  const stop = budget.run("stop", async () => "stopped", { userInitiated: true });
  assert.equal(await stop, "stopped");
  assert.equal(budget.snapshot().emergencyInFlight, 0);
  releaseNormal("done");
  await normal;
  assert.ok(budget.snapshot().queueWaitMsLast >= 0);
  budget.noteCoalescedRequest();
  budget.noteRetry();
  assert.equal(budget.snapshot().coalescedRequests, 1);
  assert.equal(budget.snapshot().retries, 1);
});

test("tunnel gateway defaults and realtime refresh policy match the current contract", () => {
  assert.deepEqual(defaultRequestBudgetConfig.minIntervalByPurpose, {});
  assert.equal(defaultRequestBudgetConfig.maxRequestsPerMinute, 0);
  assert.equal(defaultTunnelGatewayConfig.healthCheckIntervalSeconds, 30);
  assert.equal(defaultTunnelGatewayConfig.snapshotPollIntervalSeconds, 30);
  assert.equal(defaultTunnelGatewayConfig.maxRequestsPerMinute, 0);
  assert.equal(refreshProfiles.realtime.health, 5);
  assert.equal(refreshProfiles.realtime.snapshot, 30);
  assert.equal(refreshProfiles.balanced.health, 10);
  assert.equal(refreshProfiles.balanced.snapshot, 60);

  const normalized = normalizeTunnelGatewayConfig({ healthCheckIntervalSeconds: 5, snapshotPollIntervalSeconds: 30 });
  assert.equal(normalized.healthCheckIntervalSeconds, 5);
  assert.equal(normalized.snapshotPollIntervalSeconds, 30);

  const budgetConfig = requestBudgetConfigFromTunnel(normalized);
  assert.deepEqual(budgetConfig.minIntervalByPurpose, {});
});
