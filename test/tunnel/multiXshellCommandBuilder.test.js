const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeXshellSetupConfig } = require("../../dist/tunnel/XshellTunnelSetup.js");
const { buildTunnelEndpointRegistry } = require("../../dist/tunnel/TunnelEndpointRegistry.js");
const { buildMultiEndpointXshellTunnelCommands, generateXshellStartAllBatScript } = require("../../dist/tunnel/XshellTunnelCommandBuilder.js");

test("multi endpoint command builder emits only configured Worker tunnel commands", () => {
  const setup = normalizeXshellSetupConfig({
    xshellExePath: "C:\\Program Files\\NetSarang\\Xshell 8\\Xshell.exe",
    hubHost: "hub.local",
    hubUser: "simple",
    workerRealtimeMode: "hub_plus_workers",
    workerTunnels: [{ id: "w1", workerHost: "w1.local", workerUser: "simple", localForwardPort: 18766, enabled: true }],
  });
  const endpoints = buildTunnelEndpointRegistry(setup).endpoints;
  const commands = buildMultiEndpointXshellTunnelCommands(setup, endpoints);
  assert.equal(commands.length, 1);
  assert.match(commands[0].preview.sshCommand, /127\.0\.0\.1:18766:127\.0\.0\.1:18765/);
  const script = generateXshellStartAllBatScript(setup, endpoints);
  assert.doesNotMatch(script,/Hub control tunnel/);
  assert.match(script, /Worker telemetry tunnel/);
});