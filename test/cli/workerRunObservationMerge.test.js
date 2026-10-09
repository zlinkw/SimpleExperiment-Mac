const assert = require("node:assert/strict");
const test = require("node:test");
const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");

function observation(id) {
  return {
    run_id: id,
    plan: "experiments/plans/shared.yaml",
    status: "running",
    worker: { id: "worker-a", host: "127.0.0.1" },
    tmux: { session: "gpu-0", window: "gpu-0:1", pane: "gpu-0:1.0" },
    stage: "run",
    progress: null,
    gpu: { id: "0", memory: "", utilization: "" },
    config: { path: "", experiment_case: "", seed: "", model: "", dataset: "" },
    log: "",
    updated_at: "2026-09-23T01:00:00Z",
  };
}

test("runtime observations merge by run id, never by a shared Plan", async () => {
  const old = {
    id: "run-100",
    run_id: "run-100",
    type: "worker_run",
    status: "success",
    plan: "experiments/plans/shared.yaml",
    source: "history",
    raw: {},
  };
  const rows = new Map([[old.id, old]]);
  await applyRuntimeObservations(rows, [observation("run-200")]);
  assert.equal(rows.get("run-100"), old);
  assert.equal(old.status, "success");
  assert.equal(rows.get("run-200")?.status, "running");
  assert.equal(rows.size, 2);

  await applyRuntimeObservations(rows, [observation("run-100")]);
  assert.equal(rows.get("run-100")?.status, "success");
  assert.equal(rows.get("run-100")?.source, "history");
  assert.equal(rows.get("run-100")?.raw.runtimeRunId, "run-100");
  assert.equal(rows.size, 2);
});
