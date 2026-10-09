const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "../..");
for (const runtimePath of ["src/clusterAgentRuntime.legacy.ts", "dist/runtime/cluster_agent.py"]) {
  test(`tmux close reaches the HTTP handler in Worker and Hub modes: ${runtimePath}`, () => {
    const result = spawnSync("python", ["-X", "utf8", path.join(__dirname, "tmux_close_http_fixture.py")], {
      input: fs.readFileSync(path.join(root, runtimePath), "utf8"),
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      cwd: root,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok: Worker and Hub HTTP cleanup/);
  });
}
