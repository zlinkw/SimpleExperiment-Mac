const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");

const { normalizeTunnelGatewayConfig } = require("../../dist/tunnel/TunnelGateway.js");
const {
  normalizeXshellSetupConfig,
  validateXshellSetupConfig,
  workerTunnelToXshellSetupConfig,
} = require("../../dist/tunnel/XshellTunnelSetup.js");
const { recommendAvailableLocalPort } = require("../../dist/tunnel/XshellTunnelLauncher.js");

test("xshell realtime setup defaults to realtime and file transfer", () => {
  const tunnel = normalizeTunnelGatewayConfig({});
  const setup = normalizeXshellSetupConfig({});
  assert.equal(tunnel.connectionMode, "xshell_tunnel_realtime");
  assert.equal(tunnel.allowStreaming, true);
  assert.equal(setup.realtimeEnabled, true);
  assert.equal(setup.fileTransferEnabled, true);
  assert.equal(setup.hubSshPort, 22);
  assert.equal(setup.autoStartTunnelOnExtensionActivation, false);
  assert.equal(setup.autoTestTunnelAfterStart, true);
  assert.equal(setup.authMethod, "password");
  assert.equal(setup.workerRealtimeMode, "hub_only");
  assert.deepEqual(setup.workerTunnels, []);
});

test("unsupported connection mode normalizes to xshell mode", () => {
  const tunnel = normalizeTunnelGatewayConfig({ connectionMode: "unsupported_transport" });
  assert.equal(tunnel.connectionMode, "xshell_tunnel_realtime");
});

test("hub display name is normalized and preserved", () => {
  const setup = normalizeXshellSetupConfig({ hubDisplayName: "  调度 Hub  " });
  assert.equal(setup.hubDisplayName, "调度 Hub");
  const blank = normalizeXshellSetupConfig({ hubDisplayName: "   " });
  assert.equal(blank.hubDisplayName, undefined);
});

test("ssh login port 22 is valid but tunnel ports stay high range", () => {
  const setup = normalizeXshellSetupConfig({ hubSshPort: 22, localForwardPort: 22, remoteAgentPort: 22 });
  assert.equal(setup.hubSshPort, 22);
  assert.equal(setup.localForwardPort, 18765);
  assert.equal(setup.remoteAgentPort, 18765);
});

test("occupied local port gets recommended replacement", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const occupied = server.address().port;
  try {
    const recommended = await recommendAvailableLocalPort(occupied);
    assert.notEqual(recommended, occupied);
    assert.ok(recommended >= 1024 && recommended <= 65535);
  } finally {
    server.close();
  }
});

test("worker realtime tunnels are normalized for local aggregation", () => {
  const setup = normalizeXshellSetupConfig({
    workerRealtimeMode: "hub_plus_workers",
    workerTunnels: [{
      id: "NWPU 5",
      hubHost: "10.0.0.5",
      hubUser: "simple",
      hubSshPort: 22,
      localForwardHost: "127.0.0.1",
      localForwardPort: 18800,
      remoteAgentHost: "127.0.0.1",
      remoteAgentPort: 18765,
      enabled: true,
    }],
  });
  assert.equal(setup.workerRealtimeMode, "hub_plus_workers");
  assert.equal(setup.workerTunnels[0].id, "nwpu-5");
  assert.equal(setup.workerTunnels[0].authMethod, "password");
  assert.equal(setup.workerTunnels[0].localForwardHost, "127.0.0.1");
  assert.equal(setup.workerTunnels[0].remoteAgentHost, "127.0.0.1");
});

test("duplicate worker aliases and stale assignments are removed", () => {
  const setup = normalizeXshellSetupConfig({
    workerRealtimeMode: "hub_plus_workers",
    workerTelemetryMode: "hub_plus_worker_telemetry",
    workerTunnels: [
      { id: "5", displayName: "5", workerHost: "nwpu5", workerUser: "simple", localForwardPort: 18765, remoteTelemetryPort: 18765, enabled: true },
      { id: "nwpu5", displayName: "nwpu5", workerHost: "nwpu5", workerUser: "simple", localForwardPort: 18766, remoteTelemetryPort: 18765, enabled: true },
      { id: "nwpu2", displayName: "nwpu2", workerHost: "nwpu2", workerUser: "simple", localForwardPort: 18768, remoteTelemetryPort: 18765, enabled: true },
    ],
    ports: {
      workerLocalPortRange: { start: 18766, end: 18999 },
      preserveExistingAssignments: true,
      assignments: [
        { endpointId: "hub", role: "hub_control", remoteHostLabel: "hub", localForwardHost: "127.0.0.1", localForwardPort: 18768, remoteBindHost: "127.0.0.1", remoteServicePort: 18765, assignedAt: "t", source: "manual" },
        { endpointId: "5", role: "worker_telemetry", remoteHostLabel: "nwpu5", localForwardHost: "127.0.0.1", localForwardPort: 18765, remoteBindHost: "127.0.0.1", remoteServicePort: 18765, assignedAt: "t", source: "manual" },
        { endpointId: "nwpu5", role: "worker_telemetry", remoteHostLabel: "nwpu5", localForwardHost: "127.0.0.1", localForwardPort: 18766, remoteBindHost: "127.0.0.1", remoteServicePort: 18765, assignedAt: "t", source: "manual" },
      ],
    },
  });
  assert.deepEqual(setup.workerTunnels.map((worker) => worker.id), ["nwpu5", "nwpu2"]);
  assert.deepEqual(setup.ports.assignments.map((item) => item.endpointId), ["hub", "nwpu5", "nwpu2"]);
  assert.equal(setup.workerTunnels[0].localForwardPort, 18766);
});

test("single endpoint launch configs clear worker telemetry mode", () => {
  const base = normalizeXshellSetupConfig({
    xshellExePath: "C:\\Program Files\\NetSarang\\Xshell 8\\Xshell.exe",
    hubHost: "10.0.0.1",
    hubUser: "simple",
    workerRealtimeMode: "hub_plus_workers",
    workerTelemetryMode: "hub_plus_worker_telemetry",
    workerTunnels: [{
      id: "nwpu5",
      hubHost: "10.0.0.5",
      hubUser: "simple",
      localForwardHost: "127.0.0.1",
      localForwardPort: 18766,
      remoteAgentHost: "127.0.0.1",
      remoteAgentPort: 18765,
      enabled: true,
    }],
  });

  const hubOnly = normalizeXshellSetupConfig({
    ...base,
    workerRealtimeMode: "hub_only",
    workerTelemetryMode: "hub_only",
    workerTunnels: [],
  });
  const workerOnly = workerTunnelToXshellSetupConfig(base, base.workerTunnels[0]);

  for (const setup of [hubOnly, workerOnly]) {
    assert.equal(setup.workerRealtimeMode, "hub_only");
    assert.equal(setup.workerTelemetryMode, "hub_only");
    assert.deepEqual(setup.workerTunnels, []);
    assert.deepEqual(validateXshellSetupConfig(setup), []);
  }
});
