const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const source = fs.readFileSync(path.join(root, "src/clusterSchedulerRuntime.legacy.ts"), "utf8");
const fixture = path.join(__dirname, "scheduler_atomic_write_fixture.py");

test("scheduler state writes atomically and removes only its failed staging file", () => {
  const result = spawnSync("python", ["-X", "utf8", fixture], {
    input: source,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    cwd: root,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.match(result.stdout, /scheduler atomic write ok/);
});
