const test = require("node:test");
const assert = require("node:assert/strict");

const { localBaseUrl, normalizeTunnelGatewayConfig } = require("../../dist/tunnel/TunnelGateway.js");
const { normalizeXshellSetupConfig } = require("../../dist/tunnel/XshellTunnelSetup.js");

test("custom realtime local and remote forward ports work", () => {
  const tunnel = normalizeTunnelGatewayConfig({ localPort: 20111, remotePort: 20112 });
  const setup = normalizeXshellSetupConfig({ localForwardPort: 20111, remoteAgentPort: 20112 });
  assert.equal(localBaseUrl(tunnel), "http://127.0.0.1:20111");
  assert.equal(setup.localForwardPort, 20111);
  assert.equal(setup.remoteAgentPort, 20112);
});
