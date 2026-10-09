const test = require("node:test");
const assert = require("node:assert/strict");

const { CLUSTER_SCHEDULER_RUNTIME } = require("../dist/clusterSchedulerRuntime.js");

test("scheduler runtime records dispatch probes and wait reasons", () => {
  assert.match(CLUSTER_SCHEDULER_RUNTIME, /def probe_idle_gpus/);
  assert.match(CLUSTER_SCHEDULER_RUNTIME, /"dispatch_probe"/);
  assert.match(CLUSTER_SCHEDULER_RUNTIME, /"scheduler_wait_reason"/);
  assert.match(CLUSTER_SCHEDULER_RUNTIME, /no_idle_gpu_from_hub_probe/);
});

test("scheduler runtime does not silently finish with all experiments pending", () => {
  assert.match(CLUSTER_SCHEDULER_RUNTIME, /no_dispatch_error_cycles = 0/);
  assert.match(CLUSTER_SCHEDULER_RUNTIME, /if no_dispatch_error_cycles >= 2:/);
  assert.match(CLUSTER_SCHEDULER_RUNTIME, /while queue:[\s\S]*failed\.append\(\{"experiment_index": queue\.popleft\(\)/);
  assert.match(CLUSTER_SCHEDULER_RUNTIME, /write_current_state\(reason\)/);
  assert.match(CLUSTER_SCHEDULER_RUNTIME, /Hub 调度器仍有排队实验但没有任何派发/);
  assert.match(CLUSTER_SCHEDULER_RUNTIME, /write_current_state\(final_error\)/);
  assert.match(CLUSTER_SCHEDULER_RUNTIME, /terminal_status = "failed" if final_error or failed_count else "completed"/);
  assert.doesNotMatch(CLUSTER_SCHEDULER_RUNTIME, /Hub scheduler exited with pending experiments and no dispatch/);
});
