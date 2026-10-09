const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeXshellSetupConfig } = require("../../dist/tunnel/XshellTunnelSetup.js");
const { buildTunnelEndpointRegistry } = require("../../dist/tunnel/TunnelEndpointRegistry.js");

test("endpoint registry represents Hub and Workers with stable roles", () => {
  const setup = normalizeXshellSetupConfig({
    hubHost: "hub.local",
    hubUser: "simple",
    workerRealtimeMode: "hub_plus_workers",
    workerTunnels: [{ id: "w1", workerHost: "w1.local", workerUser: "simple", localForwardPort: 18766, remoteTelemetryPort: 18765, enabled: true }],
  });
  const registry = buildTunnelEndpointRegistry(setup);
  assert.equal(registry.hub.role, "hub_control");
  assert.equal(registry.workers[0].role, "worker_telemetry");
  assert.equal(registry.workers[0].tunnel.localPort, 18766);
  assert.ok(registry.hub.api.expectedCapabilities.includes("endpoints.actions"));
  assert.ok(registry.workers[0].api.expectedCapabilities.includes("endpoints.workerTasks"));
});
