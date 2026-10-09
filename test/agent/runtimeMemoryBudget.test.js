const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent runtime prunes terminal in-memory records while keeping active records", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  const script = path.join(__dirname, "runtimeMemoryBudget.fixture.py");
  const run = spawnSync(python, ["-B", "-X", "utf8", script], { cwd: root, encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.uploads, 120);
  assert.equal(result.uploadOld, false);
  assert.equal(result.uploadNew, true);
  assert.equal(result.uploadRunning, true);
  assert.equal(result.results, 240);
  assert.equal(result.resultOld, false);
  assert.equal(result.resultNew, true);
  assert.equal(result.actionKeys, 240);
  assert.equal(result.actionOldActive, true);
  assert.equal(result.actionOldInactive, false);
  assert.equal(result.actionNew, true);
  assert.equal(result.dependencyCache, 32);
  assert.equal(result.dependencyNewest, true);
  assert.equal(result.dependencyOldInactive, false);
  assert.equal(result.dependencyActive, true);
});
