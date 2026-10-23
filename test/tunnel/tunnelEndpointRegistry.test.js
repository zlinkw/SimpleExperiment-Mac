const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeXshellSetupConfig } = require("../../dist/tunnel/XshellTunnelSetup.js");
const { buildTunnelEndpointRegistry } = require("../../dist/tunnel/TunnelEndpointRegistry.js");

test("endpoint registry keeps only Worker roles even with historical Hub configuration", () => {
  const setup = normalizeXshellSetupConfig({
    hubHost: "hub.local",
    hubUser: "simple",
    workerRealtimeMode: "hub_plus_workers",
    workerTunnels: [{ id: "w1", workerHost: "w1.local", workerUser: "simple", localForwardPort: 18766, remoteTelemetryPort: 18765, enabled: true }],
  });
  const registry = buildTunnelEndpointRegistry(setup);
  assert.equal(registry.hub,undefined);
  assert.deepEqual(registry.endpoints.map(row=>row.id),["w1"]);
  assert.equal(registry.workers[0].role, "worker_telemetry");
  assert.equal(registry.workers[0].tunnel.localPort, 18766);
  assert.ok(registry.endpoints.every(row=>row.role!=="hub_control"));
  assert.ok(registry.workers[0].api.expectedCapabilities.includes("endpoints.workerTasks"));
});
