const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const sourcePath = path.join(root, "src/clusterAgentRuntime.legacy.ts");
const fixturePath = path.join(__dirname, "tmux_kill_window_fixture.py");

test("tmux close verifies session:index and protects the Agent window", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  const start = source.indexOf("def kill_tmux_window_response(");
  const end = source.indexOf("\ndef serve_http(", start);
  assert.ok(start > 0 && end > start, "kill_tmux_window_response extract bounds");
  const extracted = source.slice(start, end);
  assert.equal(extracted.includes("cluster_agent"), false);
  assert.equal(extracted.includes("cluster_scheduler"), false);
  const result = spawnSync("python", ["-X", "utf8", fixturePath], {
    input: source,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    cwd: root,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});
