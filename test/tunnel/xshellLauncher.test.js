const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  buildForwardCommand,
  buildXshellArgs,
  buildXshellPreview,
  generateBatScript,
  generatePs1Script,
  validateXshellExecutable,
} = require("../../dist/tunnel/XshellTunnelLauncher.js");
const { normalizeXshellSetupConfig } = require("../../dist/tunnel/XshellTunnelSetup.js");

test("xshell launcher builds visible local forwarding command with custom ports", () => {
  const config = normalizeXshellSetupConfig({
    xshellExePath: "C:\\Program Files\\NetSarang\\Xshell 8\\Xshell.exe",
    hubHost: "hub.example.edu",
    hubUser: "simple",
    hubSshPort: 2222,
    localForwardPort: 20001,
    remoteAgentPort: 20002,
  });
  const command = buildForwardCommand(config);
  assert.match(command, /127\.0\.0\.1:20001:127\.0\.0\.1:20002/);
  assert.match(command, /-p 2222/);
  assert.doesNotMatch(command, /password|StrictHostKeyChecking=no/i);
  assert.deepEqual(buildXshellArgs(config)[0], "-newtab");
  assert.match(buildXshellPreview(config), /Xshell\.exe/);
  assert.match(generateBatScript(config), /LOCAL_PORT=20001/);
  assert.match(generatePs1Script(config), /20002/);
});

test("xshell executable validation only accepts Xshell.exe files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-xshell-"));
  const exe = path.join(dir, "Xshell.exe");
  const other = path.join(dir, "other.exe");
  await fs.writeFile(exe, "");
  await fs.writeFile(other, "");
  assert.equal(await validateXshellExecutable(exe), true);
  assert.equal(await validateXshellExecutable(other), false);
});

