const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeGpuRow, normalizeServerGpu, percent } = require("../../dist/ui/WebviewRenderState.js");

test("gpu normalize accepts hub agent field aliases", () => {
  const row = normalizeGpuRow({
    gpu_index: 1,
    gpu_name: "RTX 4090",
    memory_used_mb: 12000,
    memory_total_mb: 24000,
    gpu_util: 88,
    temperature_gpu: 71,
    procs: [{ pid: 1 }, { pid: 2 }],
    run_key: "run-a",
  });
  assert.equal(row.index, "1");
  assert.equal(row.name, "RTX 4090");
  assert.equal(row.memoryPercent, 50);
  assert.equal(row.utilizationPercent, 88);
  assert.equal(row.processCount, 2);
  assert.equal(row.runKey, "run-a");
});

test("gpu normalize supports multi server and multi gpu payloads", () => {
  const server = normalizeServerGpu("worker-1", {
    worker_id: "w1",
    status: "degraded",
    updated_at: "2026-07-01T00:00:00Z",
    gpus: [{ id: "0", used: 1, total: 2 }, { id: "1", used: 2, total: 4 }],
  });
  assert.equal(server.serverId, "worker-1");
  assert.equal(server.workerId, "w1");
  assert.equal(server.status, "degraded");
  assert.equal(server.gpuCount, 2);
  assert.equal(percent(2, 4), 50);
});
