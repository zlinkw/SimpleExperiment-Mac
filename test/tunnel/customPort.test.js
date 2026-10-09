const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeTunnelGatewayConfig, localBaseUrl } = require("../../dist/tunnel/TunnelGateway.js");
const { normalizeXshellSetupConfig } = require("../../dist/tunnel/XshellTunnelSetup.js");

test("custom local and remote forwarding ports are preserved and bounded", () => {
  const tunnel = normalizeTunnelGatewayConfig({ localPort: 21001, remotePort: 21002 });
  assert.equal(tunnel.localPort, 21001);
  assert.equal(tunnel.remotePort, 21002);
  assert.equal(localBaseUrl(tunnel), "http://127.0.0.1:21001");

  const setup = normalizeXshellSetupConfig({ localForwardPort: 22001, remoteAgentPort: 22002 });
  assert.equal(setup.localForwardPort, 22001);
  assert.equal(setup.remoteAgentPort, 22002);

  assert.equal(normalizeTunnelGatewayConfig({ localPort: 80 }).localPort, 18765);
});
