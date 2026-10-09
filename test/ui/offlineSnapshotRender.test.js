const test = require("node:test");
const assert = require("node:assert/strict");

const { selectWebviewStateFields } = require("../../dist/ui/WebviewRenderState.js");

test("offline snapshot supplies gpu scheduler and traces when realtime is empty", () => {
  const fields = selectWebviewStateFields({
    realtimeState: { gpu: {}, schedulerStates: [], experimentTraces: [], logs: {}, operations: {}, fileTransfers: {} },
    offlineSnapshot: {
      gpu: { w1: [{ index: 0 }] },
      schedulerStates: [{ runKey: "run-1", status: "completed" }],
      experimentTraces: [{ runKey: "run-1", status: "archived" }],
    },
  });
  assert.equal(fields.gpu.w1[0].index, 0);
  assert.equal(fields.schedulerStates[0].runKey, "run-1");
  assert.equal(fields.experimentTraces[0].status, "archived");
});

test("last snapshot is used before offline snapshot", () => {
  const fields = selectWebviewStateFields({
    lastSnapshot: { gpu: { live: [{ index: 1 }] } },
    offlineSnapshot: { gpu: { offline: [{ index: 2 }] } },
  });
  assert.equal(fields.gpu.live[0].index, 1);
  assert.equal(fields.gpu.offline, undefined);
});