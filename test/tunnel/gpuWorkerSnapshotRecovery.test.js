const assert = require("node:assert/strict");
const test = require("node:test");
require("../_helpers/registerTsRequire");
const { MultiEndpointRealtimeClient } = require("../../src/tunnel/MultiEndpointRealtimeClient.ts");
const { RealtimeTunnelClient, defaultRealtimeRefreshPolicy } = require("../../src/tunnel/RealtimeTunnelClient.ts");
const { RequestBudget, defaultRequestBudgetConfig } = require("../../src/tunnel/RequestBudget.ts");

const budget = () => new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} });
const policy = { ...defaultRealtimeRefreshPolicy, preferWebSocket: false, fallbackToSse: false, snapshotFallbackIntervalSeconds: 60 };
const gpu = (count, name = "current") => ({ generatedAt: new Date().toISOString(), status: "ok", gpus: Array.from({ length: count }, (_, index) => ({ index, name })) });
const event = (seq, type, payload = {}, generatedAt = new Date().toISOString()) => ({ schemaVersion: 1, seq, type, source: "worker_telemetry", generatedAt, payload });

async function fixture(fn) {
  const requested = [];
  let payload = gpu(4);
  let taskFailure = false;
  let gpuFailurePort = "";
  let useSse = false;
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    const parsed = new URL(url), route = parsed.pathname;
    requested.push(route);
    if (route === "/api/events/sse" && useSse) {
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(event(1, "agent_heartbeat")) + "\n\n"));
        options.signal.addEventListener("abort", () => controller.close(), { once: true });
      } });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (route === "/api/gpu" && parsed.port === gpuFailurePort) return new Response("GPU read failed", { status: 500 });
    const body = route === "/api/gpu" ? payload : route === "/api/worker/tasks" && !taskFailure
      ? { tasks: [{ commandId: "running-1", status: "running" }] } : undefined;
    return new Response(JSON.stringify(body || { error: "worker telemetry does not expose hub control api" }),
      { status: body ? 200 : 404, headers: { "Content-Type": "application/json" } });
  };
  const endpoint = { id: "nwpu3", role: "worker", localHost: "localhost", localPort: 12345 };
  try { await fn({ endpoint, requested, setGpu: value => { payload = value; }, failTasks: () => { taskFailure = true; },
    enableSse: () => { useSse = true; }, failGpu: port => { gpuFailurePort = String(port); } }); }
  finally { global.fetch = previousFetch; }
}

test("SSE bootstrap obtains the current GPU snapshot even when replay contains only a heartbeat", async () => {
  await fixture(async ({ endpoint, requested, enableSse }) => {
    enableSse();
    const client = new RealtimeTunnelClient(endpoint, budget(), { ...policy, fallbackToSse: true });
    try {
      await client.connect();
      assert.equal(client.currentState().gpu.nwpu3?.length, 4);
      assert.equal(client.diagnostics().streamStatus, "sse");
      assert.ok(!requested.includes("/api/snapshot"));
    } finally { await client.disconnect(); }
  });
});

test("one failed Worker refresh preserves other servers and its own last successful sample", async () => {
  await fixture(async ({ endpoint, failGpu, setGpu }) => {
    const client = new MultiEndpointRealtimeClient([endpoint, { ...endpoint, id: "nwpu2", localPort: endpoint.localPort + 1 }], budget, policy);
    try {
      await client.getGpu();
      failGpu(endpoint.localPort);
      setGpu(gpu(3, "other-new"));
      await client.getGpu();
      client.clients.get("nwpu2").acceptEvent(event(1, "agent_heartbeat"));
      assert.equal(client.currentState().gpu.nwpu3.length, 4);
      assert.equal(client.currentState().gpu.nwpu2.length, 3);
      assert.equal(client.currentState().gpu.nwpu2[0].name, "other-new");
    } finally { await client.disconnect(); }
  });
});

test("an empty degraded snapshot reports the sampler reason and a later successful refresh recovers", async () => {
  await fixture(async ({ endpoint, setGpu }) => {
    const client = new RealtimeTunnelClient(endpoint, budget(), policy);
    try {
      setGpu({ ...gpu(0), status: "degraded", error: "GPU query timed out" });
      await client.getGpu();
      assert.deepEqual(client.currentState().gpu.nwpu3, []);
      assert.equal(client.currentState().workerHealth.nwpu3.lastError, "GPU query timed out");
      setGpu(gpu(4));
      await client.getGpu();
      assert.equal(client.currentState().gpu.nwpu3.length, 4);
      assert.equal(client.currentState().workerHealth.nwpu3.lastError, "");
    } finally { await client.disconnect(); }
  });
});

test("Worker polling bootstraps all GPU rows without requesting the Hub snapshot API", async () => {
  await fixture(async ({ endpoint, requested }) => {
    const client = new RealtimeTunnelClient(endpoint, budget(), policy);
    try {
      await client.connect();
      assert.equal(client.currentState().gpu.nwpu3?.length, 4);
      assert.equal(client.currentState().workerTasks.nwpu3?.[0].commandId, "running-1");
      assert.ok(requested.includes("/api/gpu"));
      assert.ok(!requested.includes("/api/snapshot"));
      assert.equal(client.diagnostics().lastError, undefined);
    } finally { await client.disconnect(); }
  });
});

test("manual GPU refresh survives the next heartbeat and another Worker update", async () => {
  await fixture(async ({ endpoint }) => {
    const other = { ...endpoint, id: "nwpu2" };
    const client = new MultiEndpointRealtimeClient([endpoint, other], budget, policy);
    try {
      await client.getGpu();
      assert.equal(client.currentState().gpu.nwpu3?.length, 4);
      const direct = client.clients.get("nwpu3");
      direct.acceptEvent(event(1, "agent_heartbeat"));
      client.clients.get("nwpu2").acceptEvent(event(2, "gpu_snapshot", { gpus: [{ index: 0, name: "other" }] }));
      assert.equal(client.currentState().gpu.nwpu3?.length, 4, "refresh must update the endpoint source used by subsequent merges");
      assert.equal(client.currentState().gpu.nwpu2?.[0].name, "other");
    } finally { await client.disconnect(); }
  });
});

test("Worker GPU snapshot remains available when the task endpoint fails", async () => {
  await fixture(async ({ endpoint, failTasks }) => {
    failTasks();
    const client = new RealtimeTunnelClient(endpoint, budget(), policy);
    try {
      await client.getSnapshot();
      assert.equal(client.currentState().gpu.nwpu3?.length, 4);
    } finally { await client.disconnect(); }
  });
});

test("old replayed GPU events cannot replace a newer HTTP sample, while newer events can", async () => {
  await fixture(async ({ endpoint, setGpu }) => {
    setGpu({ ...gpu(4), generatedAt: "2026-10-10T04:30:00Z" });
    const client = new RealtimeTunnelClient(endpoint, budget(), policy);
    try {
      await client.getGpu();
      client.acceptEvent(event(1, "gpu_snapshot", { gpus: [] }, "2026-10-10T04:29:00Z"));
      assert.equal(client.currentState().gpu.nwpu3?.length, 4);
      assert.equal(client.currentState().lastSeq, 1, "old replay still advances the journal cursor");
      client.acceptEvent(event(2, "gpu_snapshot", { gpus: [{ index: 0, name: "newer" }] }, "2026-10-10T04:31:00Z"));
      assert.equal(client.currentState().gpu.nwpu3?.[0].name, "newer");
    } finally { await client.disconnect(); }
  });
});

test("a late GPU response from a disconnected generation does not mutate current state", async () => {
  const client = new RealtimeTunnelClient({ id: "nwpu3", role: "worker", localHost: "localhost", localPort: 1 }, budget(), policy);
  let finish;
  client.http.getGpu = () => new Promise(resolve => { finish = resolve; });
  const pending = client.getGpu();
  await new Promise(resolve => setImmediate(resolve));
  await client.disconnect();
  finish(gpu(4));
  await pending;
  assert.deepEqual(client.currentState().gpu, {});
});
