const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeXshellSetupConfig } = require("../../dist/tunnel/XshellTunnelSetup.js");

test("legacy worker tunnel config migrates to worker telemetry fields", () => {
  const setup = normalizeXshellSetupConfig({
    workerRealtimeMode: "hub_plus_workers",
    workerTunnels: [{
      id: "worker-a",
      hubHost: "10.0.0.2",
      hubUser: "simple",
      hubSshPort: 22,
      localForwardPort: 18766,
      remoteAgentPort: 18765,
      enabled: true,
    }],
  });
  assert.equal(setup.workerTelemetryMode, "hub_plus_worker_telemetry");
  assert.equal(setup.workerTunnels[0].workerHost, "10.0.0.2");
  assert.equal(setup.workerTunnels[0].workerUser, "simple");
  assert.equal(setup.workerTunnels[0].remoteTelemetryPort, 18765);
  assert.ok(setup.ports.assignments.some((item) => item.endpointId === "worker-a"));
  assert.equal(setup.realtime.connectWorkersOnStartup, true);
});