const test = require("node:test");
const assert = require("node:assert/strict");

const { migrateLegacyRemoteConfig } = require("../../dist/tunnel/TunnelOnlyPolicy.js");

test("legacy SSH config is ignored and migrated to tunnel warning", () => {
  const result = migrateLegacyRemoteConfig({ sshTransportMode: "oneshot", sshHost: "hub", displayName: "Hub" });
  assert.equal(result.migratedToTunnel, true);
  assert.ok(result.removedFields.includes("sshTransportMode"));
  assert.match(result.warning, /Xshell/);
});
