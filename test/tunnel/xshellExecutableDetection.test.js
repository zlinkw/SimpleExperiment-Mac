const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { XshellIntegration } = require("../../dist/tunnel/XshellTunnelIntegration.js");

test("xshell executable detection accepts configured Xshell.exe", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-xshell-"));
  const exe = path.join(dir, "Xshell.exe");
  await fs.writeFile(exe, "");
  const integration = new XshellIntegration({ configuredPath: exe });
  const found = await integration.findExecutable();
  const validation = await integration.validateExecutable(exe);
  assert.equal(found.found, true);
  assert.equal(found.source, "configured");
  assert.equal(validation.ok, true);
});

test("xshell executable detection rejects wrong basename", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-xshell-"));
  const exe = path.join(dir, "ssh.exe");
  await fs.writeFile(exe, "");
  const validation = await new XshellIntegration().validateExecutable(exe);
  assert.equal(validation.ok, false);
  assert.equal(validation.extensionOk, false);
});