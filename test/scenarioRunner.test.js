const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { OperationQueue } = require("../dist/core/OperationQueue.js");
const { normalizeSimpleError } = require("../dist/core/ErrorModel.js");
const { ClusterStore } = require("../dist/state/ClusterStore.js");
const { selectOperationLoading } = require("../dist/state/StateSelectors.js");
const { redactForDebugBundle } = require("../dist/ui/UiStateMapper.js");
const { runScenario } = require("../dist/testing/ScenarioRunner.js");

test("operation queue prioritizes manual, coalesces refresh, and locks write keys", async () => {
  const queue = new OperationQueue();
  const order = [];
  await Promise.all([
    queue.enqueue({ id: "sync", type: "sync", priority: "background", exclusiveKeys: ["write"], run: async () => { order.push("sync-start"); await new Promise((r) => setTimeout(r, 10)); order.push("sync-end"); } }),
    queue.enqueue({ id: "delete", type: "delete", priority: "manual", exclusiveKeys: ["write"], targetKeys: ["row1"], run: async () => { order.push("delete"); } }),
    queue.enqueue({ id: "refresh1", type: "refresh", priority: "realtime", coalesceKey: "refresh", run: async () => { order.push("refresh"); } }),
    queue.enqueue({ id: "refresh2", type: "refresh", priority: "realtime", coalesceKey: "refresh", run: async () => { order.push("refresh2"); } }),
  ]);
  assert.deepEqual(order, ["sync-start", "refresh", "sync-end", "delete"]);
  assert.equal(queue.snapshot().some((item) => item.status === "coalesced"), true);
});

test("cluster store reducer keeps terminal completed over older running", () => {
  const store = new ClusterStore();
  store.dispatch({ type: "scheduler/eventsReceived", source: "stream", seq: 10, payload: [{ runKey: "r", sessionId: "s", status: "completed" }] });
  store.dispatch({ type: "scheduler/eventsReceived", source: "snapshot", seq: 9, payload: [{ runKey: "r", sessionId: "s", status: "running" }] });
  assert.equal(store.getState().schedulerStates[0].status, "completed");
  store.dispatch({ type: "operations/updated", operations: [{ id: "op", type: "delete", priority: "manual", status: "running", targetServers: [], targetKeys: ["row"], exclusiveKeys: [] }] });
  assert.equal(selectOperationLoading(store.getState(), "row"), true);
});

test("scenario runner covers five cluster recovery scenarios", async () => {
  const dir = path.join(__dirname, "..", "scenarios");
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const scenario = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const { store } = await runScenario(scenario);
    const state = store.getState();
    assert.equal(typeof state, "object");
    if (scenario.steps.some((step) => step.action === "agentEvent")) {
      assert.equal(typeof state.agent.status, "string");
    }
  }
});

test("error model and debug bundle redaction are stable", () => {
  assert.equal(normalizeSimpleError(new Error("ssh timeout")).code, "TUNNEL_TIMEOUT");
  const redacted = redactForDebugBundle({ token: "abc", identityFile: "C:/Users/a/.ssh/id_rsa", nested: { password: "secret" } });
  assert.equal(redacted.token, "<redacted>");
  assert.equal(redacted.identityFile, "id_rsa");
  assert.equal(redacted.nested.password, "<redacted>");
});
