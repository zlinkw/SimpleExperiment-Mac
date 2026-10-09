const test = require("node:test");
const assert = require("node:assert/strict");

const { buildXshellTunnelCommand } = require("../../dist/tunnel/XshellTunnelCommandBuilder.js");

const base = {
  xshellExePath: "C:\\Program Files\\NetSarang\\Xshell 8\\Xshell.exe",
  hubHost: "hub.example.edu",
  hubUser: "simple user",
  hubSshPort: 2222,
  localForwardHost: "127.0.0.1",
  localForwardPort: 18766,
  remoteAgentHost: "127.0.0.1",
  remoteAgentPort: 18767,
  launchMode: "open_xshell_exec",
  realtimeEnabled: true,
  fileTransferEnabled: true,
  keepWindowVisible: true,
  useNewTab: true,
  autoStartTunnelOnExtensionActivation: false,
  autoTestTunnelAfterStart: true,
  authMethod: "password",
};

test("xshell command builder defaults to password login even when key path is known", () => {
  const preview = buildXshellTunnelCommand({ ...base, privateKeyPath: "C:\\Users\\ZLK\\keys\\id_ed25519" });
  assert.match(preview.sshCommand, /-L 127\.0\.0\.1:18766:127\.0\.0\.1:18767/);
  assert.match(preview.sshCommand, /-p 2222/);
  assert.match(preview.sshCommand, /"simple user@hub\.example\.edu"/);
  assert.doesNotMatch(preview.sshCommand, / -i /);
  assert.doesNotMatch(preview.sshCommand, /id_ed25519/);
  assert.doesNotMatch(preview.sshCommand, /StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/);
});

test("xshell command builder uses quoted key only for key login", () => {
  const preview = buildXshellTunnelCommand({ ...base, authMethod: "key", privateKeyPath: "C:\\Users\\ZLK\\keys\\id_ed25519" });
  assert.match(preview.sshCommand, /-i "C:\\\\Users\\\\ZLK\\\\keys\\\\id_ed25519"/);
  assert.match(preview.redactedSshCommand, /id_ed25519/);
  assert.doesNotMatch(preview.redactedSshCommand, /C:\\Users\\ZLK\\keys/);
});

test("xshell command builder uses explicit host before ssh alias", () => {
  const preview = buildXshellTunnelCommand({ ...base, sshConfigAlias: "my-hub" });
  assert.match(preview.sshCommand, /hub\.example\.edu/);
  assert.doesNotMatch(preview.sshCommand, / my-hub$/);
});

test("xshell command builder uses ssh alias when host fields are missing", () => {
  const preview = buildXshellTunnelCommand({ ...base, hubHost: "", hubUser: "", sshConfigAlias: "my-hub" });
  assert.match(preview.sshCommand, / my-hub$/);
});

test("xshell command builder can launch saved Xshell session file only", () => {
  const preview = buildXshellTunnelCommand({ ...base, launchMode: "open_saved_session", savedSessionRunner: "xshell", savedSessionPath: "D:\\sessions\\simple-hub.xsh" });
  assert.deepEqual(preview.args, ["D:\\sessions\\simple-hub.xsh"]);
  assert.match(preview.shellCommand, /simple-hub\.xsh/);
  assert.doesNotMatch(preview.shellCommand, / -L | -i | -p /);
});

test("xshell command builder rejects host key bypass args", () => {
  assert.throws(() => buildXshellTunnelCommand({ ...base, extraSshArgs: ["StrictHostKeyChecking=no"] }), /host key|不允许/);
});
