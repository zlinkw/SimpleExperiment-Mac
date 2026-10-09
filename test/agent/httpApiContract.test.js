const test = require("node:test");
const assert = require("node:assert/strict");

const { CLUSTER_AGENT_RUNTIME } = require("../../dist/clusterAgentRuntime.js");

test("hub agent runtime exposes localhost HTTP API contract", () => {
  for (const route of [
    "/api/health",
    "/api/snapshot",
    "/api/gpu",
    "/api/gpu/history",
    "/api/scheduler",
    "/api/traces",
    "/api/results/summary",
    "/api/diagnostics",
    "/api/audit/tail",
    "/api/actions/run-plan",
    "/api/actions/stop-experiment",
    "/api/actions/parse-results",
    "/api/actions/refresh-results",
    "/api/actions/self-check",
  ]) {
    assert.match(CLUSTER_AGENT_RUNTIME, new RegExp(route.replace(/[/-]/g, (ch) => `\\${ch}`)));
  }
  assert.match(CLUSTER_AGENT_RUNTIME, /bind_host = str\(getattr\(args, "host", ""\) or "127\.0\.0\.1"\)\.strip\(\)/);
  assert.match(CLUSTER_AGENT_RUNTIME, /BoundedThreadingHTTPServer\(\(bind_host, int\(args\.port\)\), Handler\)/);
  assert.match(CLUSTER_AGENT_RUNTIME, /X-Simple-Agent-Token/);
  assert.match(CLUSTER_AGENT_RUNTIME, /"gpuHistory": True/);
  assert.match(CLUSTER_AGENT_RUNTIME, /query_gpu_history\(root, server_id, gpu_id, start, end, max_points\)/);
  assert.doesNotMatch(CLUSTER_AGENT_RUNTIME, /ControlMaster|ControlPath/);
});
