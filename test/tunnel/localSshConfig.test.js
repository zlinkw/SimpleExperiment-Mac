const test = require("node:test");
const assert = require("node:assert/strict");

const { parseLocalSshConfig } = require("../../dist/tunnel/LocalSshConfig.js");

test("local ssh config parser extracts familiar server fields", () => {
  const servers = parseLocalSshConfig(`
Host campus-hub
  HostName 10.12.34.56
  User simple
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host *
  User ignored
`, "C:/Users/ZLK/.ssh/config");
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "campus-hub");
  assert.equal(servers[0].hostName, "10.12.34.56");
  assert.equal(servers[0].user, "simple");
  assert.equal(servers[0].port, 2222);
  assert.match(servers[0].identityFile, /id_ed25519$/);
});
