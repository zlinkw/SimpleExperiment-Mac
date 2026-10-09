const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeClusterSnapshots, mergeRealtimeStates } = require("../../dist/tunnel/MultiEndpointRealtimeClient.js");
const { MultiEndpointRealtimeClient } = require("../../dist/tunnel/MultiEndpointRealtimeClient.js");
const { createRealtimeState, applyRealtimeEvent } = require("../../dist/tunnel/RealtimeEventReducer.js");
const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");

test("multi endpoint snapshots merge hub scheduler and worker gpu", () => {
  const snapshot = mergeClusterSnapshots([
    {
      endpoint: { id: "hub", role: "hub", localHost: "127.0.0.1", localPort: 18765 },
      snapshot: { generatedAt: "2026-01-01T00:00:00Z", gpu: { hub: [{ index: 0 }] }, schedulerStates: [{ runKey: "r1" }] },
    },
    {
      endpoint: { id: "w1", role: "worker", localHost: "127.0.0.1", localPort: 18766 },
      snapshot: { generatedAt: "2026-01-01T00:00:01Z", gpu: { hub: [{ index: 1 }] } },
    },
  ]);
  assert.equal(snapshot.generatedAt, "2026-01-01T00:00:01Z");
  assert.equal(snapshot.gpu.hub[0].index, 0);
  assert.equal(snapshot.gpu.w1[0].index, 1);
  assert.equal(snapshot.schedulerStates[0].runKey, "r1");
});

test("multi endpoint realtime state remaps worker default gpu key", () => {
  const hubState = applyRealtimeEvent(createRealtimeState(), {
    schemaVersion: 1,
    seq: 1,
    type: "gpu_snapshot",
    generatedAt: "2026-01-01T00:00:00Z",
    source: "hub_agent",
    workerId: "hub",
    payload: { gpus: [{ index: 0 }] },
  });
  const workerState = applyRealtimeEvent(createRealtimeState(), {
    schemaVersion: 1,
    seq: 1,
    type: "gpu_snapshot",
    generatedAt: new Date().toISOString(),
    source: "worker_telemetry",
    payload: { gpus: [{ index: 1 }] },
  });
  workerState.lastHeartbeatAt = new Date().toISOString();
  const state = mergeRealtimeStates([
    { endpoint: { id: "hub", role: "hub", localHost: "127.0.0.1", localPort: 18765 }, state: hubState },
    { endpoint: { id: "w1", role: "worker", localHost: "127.0.0.1", localPort: 18766 }, state: workerState },
  ]);
  assert.equal(state.gpu.hub[0].index, 0);
  assert.equal(state.gpu.w1[0].index, 1);
  assert.equal(state.gpu.w1[0].workerDirect, true);
  assert.equal(state.lastSeq, 1);
});

test("multi endpoint client exposes protected log key forwarding", () => {
  const client = new MultiEndpointRealtimeClient([], () => { throw new Error("no endpoint budget expected"); });
  assert.doesNotThrow(() => client.setProtectedLogKeys(["run-1", "run-1", ""]));
});

test("multi endpoint client snapshots endpoint configuration at construction", () => {
  const endpoints = [
    { id: "w1", role: "worker", displayName: "Worker 1", localHost: "127.0.0.1", localPort: 18766 },
  ];
  const client = new MultiEndpointRealtimeClient(endpoints, () => new RequestBudget(defaultRequestBudgetConfig));
  endpoints[0].role = "hub";
  endpoints.push({ id: "w2", role: "worker", localHost: "127.0.0.1", localPort: 18767 });

  assert.deepEqual(client.diagnostics().endpoints.map(({ id, role }) => ({ id, role })), [
    { id: "w1", role: "worker" },
  ]);
});

test("multi endpoint request budgets share the global slot while preserving per-worker capacity", async () => {
  const endpoints = ["worker-a", "worker-b", "worker-c"].map((id, index) => ({
    id, role: "worker", localHost: "127.0.0.1", localPort: 18766 + index,
  }));
  const budgets = new Map();
  const client = new MultiEndpointRealtimeClient(endpoints, (endpoint) => {
    const budget = new RequestBudget(defaultRequestBudgetConfig);
    budgets.set(endpoint.id, budget);
    return budget;
  });
  const started = [];
  const release = new Map();
  const pending = [];
  for (const endpoint of endpoints) {
    const budget = budgets.get(endpoint.id);
    for (let index = 0; index < 4; index += 1) {
      const name = `${endpoint.id}-${index}`;
      pending.push(budget.run("snapshot", () => new Promise((resolve) => { started.push(name); release.set(name, resolve); })));
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 8);
  assert.equal(budgets.get("worker-a").snapshot().inFlight, 4);
  assert.equal(budgets.get("worker-b").snapshot().inFlight, 4);
  assert.equal(budgets.get("worker-c").snapshot().queued, 4);
  assert.equal(client.budgetSnapshots()["worker-c"].globalInFlight, 8);

  const released = new Set(["worker-a-0"]);
  release.get("worker-a-0")("released");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 9);
  assert.ok(started.includes("worker-c-0"));
  while (released.size < pending.length) {
    for (const [name, finish] of release) {
      if (released.has(name)) continue;
      released.add(name);
      finish("released");
    }
    if (released.size < pending.length) await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(pending);
});
