const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

const { removeLegacyRemoteFields } = require("../../dist/tunnel/TunnelOnlyPolicy.js");

test("active transport sources exclude direct process runners while migration removes legacy fields", () => {
  for (const relative of [
    "src/extension.ts",
    "src/tunnel/TunnelClient.ts",
    "src/tunnel/RealtimeTunnelClient.ts",
    "src/tunnel/MultiEndpointRealtimeClient.ts",
    "src/tunnel/FileTransferClient.ts",
  ]) {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(text, /(?:from|require\()\s*["'](?:node:)?child_process/, relative);
    for (const item of ["RemoteExecutionService", "RemoteFileStore", "writeRemoteBase64", "runSsh("]) {
      assert.equal(text.includes(item), false, `${item} in ${relative}`);
    }
  }

  const migrated = removeLegacyRemoteFields({ sshHost: "host", scpMode: "legacy", rsyncArgs: [], keep: true });
  assert.deepEqual(migrated.value, { keep: true });
  assert.deepEqual(migrated.removedFields.sort(), ["rsyncArgs", "scpMode", "sshHost"]);
});
