const test = require("node:test");
const assert = require("node:assert/strict");

const { buildXshellSavedSessionPreview } = require("../../dist/tunnel/XshellSessionLauncher.js");
const { normalizeXshellSetupConfig } = require("../../dist/tunnel/XshellTunnelSetup.js");

test("xshell agent session preview opens saved xsh file only", () => {
  const preview = buildXshellSavedSessionPreview({
    exePath: "C:\\Program Files\\NetSarang\\Xshell 8\\Xshell.exe",
    sessionPath: "D:\\sessions\\simple-hub-agent.xsh",
    displayName: "Hub Agent",
  });
  assert.match(preview, /Xshell\.exe/);
  assert.match(preview, /simple-hub-agent\.xsh/);
  assert.doesNotMatch(preview, / -L | -i | -p |cluster_agent|tmux/);
});

test("agent session paths survive setup normalization", () => {
  const config = normalizeXshellSetupConfig({
    agentSessionPath: "D:\\sessions\\simple-hub-agent.xsh",
    workerTunnels: [{
      id: "nwpu5",
      hubHost: "nwpu5",
      hubUser: "simple",
      hubSshPort: 22,
      localForwardHost: "127.0.0.1",
      localForwardPort: 18766,
      remoteAgentHost: "127.0.0.1",
      remoteAgentPort: 18765,
      agentSessionPath: "D:\\sessions\\simple-nwpu5-agent.xsh",
      enabled: true,
    }],
  });
  assert.equal(config.agentSessionPath, "D:\\sessions\\simple-hub-agent.xsh");
  assert.equal(config.workerTunnels[0].agentSessionPath, "D:\\sessions\\simple-nwpu5-agent.xsh");
});