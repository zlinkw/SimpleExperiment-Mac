const test = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path"), { spawnSync } = require("node:child_process");
test("POSIX Worker retires exact young logs in one parent-guarded batch", {
  skip: process.platform === "win32" ? "POSIX Worker filesystem executable is verified in Linux" : false,
}, () => {
  const result = spawnSync("python3", ["-B", "-X", "utf8",
    path.join(__dirname, "../fixtures/cache-retention-batch.py"),
    path.join(__dirname, "../../src/clusterAgentRuntime.legacy.ts")],
    { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, youngLogs: true, batch: true, parentGuard: true });
});
