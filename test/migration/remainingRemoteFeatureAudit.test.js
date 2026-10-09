const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("remaining remote feature audit is migrated to tunnel-only sources", () => {
  const legacySources = [
    "src/services/RemoteExecutionService.ts",
    "src/services/RuntimeService.ts",
    "src/runtime/RuntimeManager.ts",
    "src/remote/RemoteFileStore.ts",
    "src/test/fakes/FakeRemoteCommandRunner.ts",
  ];
  const cleanup = fs.readFileSync(path.join(root, "docs/manual-cleanup-candidates.md"), "utf8");
  for (const file of legacySources) {
    if (fs.existsSync(path.join(root, file))) {
      assert.equal(cleanup.includes("`" + file + "`"), true, `${file} must stay on the manual cleanup list`);
    }
  }

  const text = readSource("src/extension.ts");
  for (const oldName of ["RemoteExecutionService", "RuntimeManager", "RemoteFileStore", "FakeRemoteCommandRunner", "writeRemoteBase64"]) {
    assert.equal(text.includes(oldName), false, `${oldName} still wired into the active extension`);
  }
});
