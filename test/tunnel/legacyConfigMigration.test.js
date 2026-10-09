const test = require("node:test");
const assert = require("node:assert/strict");

const { assertTunnelOnlyMode, migrateLegacyRemoteConfig, removeLegacyRemoteFields } = require("../../dist/tunnel/TunnelOnlyPolicy.js");

test("legacy remote config fields are removed or ignored", () => {
  const cleaned = removeLegacyRemoteFields({
    sshTransportMode: "controlmaster",
    sshMaxConcurrentCommands: 4,
    controlMaster: true,
    persistentShell: true,
    workerRefresh: true,
    displayName: "Hub",
    host: "hub.example.edu",
  });
  assert.deepEqual(cleaned.value, { displayName: "Hub", host: "hub.example.edu" });
  assert.equal(cleaned.removedFields.includes("sshTransportMode"), true);
  assert.equal(cleaned.removedFields.includes("persistentShell"), true);
  const migrated = migrateLegacyRemoteConfig(cleaned.value);
  assert.equal(migrated.migratedToTunnel, true);
  assert.match(migrated.warning, /Xshell 本地隧道/);
  assert.doesNotThrow(() => assertTunnelOnlyMode("xshell_tunnel_realtime"));
  assert.doesNotThrow(() => assertTunnelOnlyMode("offline_import"));
  assert.throws(() => assertTunnelOnlyMode("direct_ssh"), /已移除/);
});
