const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  setLoginCommand,
  updateXshellSessionLoginCommand,
} = require("../../dist/tunnel/XshellSessionPatcher.js");

test("xshell login command patch replaces RemoteCommand only", () => {
  const next = setLoginCommand("[CONNECTION]\r\nHost=h\r\nRemoteCommand=\r\nPort=22", "tmux new-session -A -s simple-hub-agent");
  assert.match(next, /RemoteCommand=tmux new-session -A -s simple-hub-agent/);
  assert.match(next, /Host=h/);
});

test("xshell login command update creates backup", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-xsh-"));
  const file = path.join(dir, "hub.xsh");
  await fs.writeFile(file, "[CONNECTION]\r\nRemoteCommand=\r\n");
  const result = await updateXshellSessionLoginCommand(file, "echo simple", { backup: true });
  assert.equal(result.changed, true);
  assert.ok(result.backupPath);
  assert.match(await fs.readFile(file, "utf8"), /RemoteCommand=echo simple/);
  assert.match(await fs.readFile(result.backupPath, "utf8"), /RemoteCommand=/);
});