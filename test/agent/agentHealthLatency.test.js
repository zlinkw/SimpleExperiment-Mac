const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("cold and stale Agent health stays responsive and shares one dependency check", () => {
  const run = spawnSync("python", ["-X", "utf8", path.join(__dirname, "agentHealthLatency.fixture.py"),
    path.join(__dirname, "../../dist/runtime/cluster_agent.py")], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  const measured = JSON.parse(run.stdout.trim());
  assert.ok(measured.coldMs < 150, JSON.stringify(measured));
  assert.equal(measured.coldCalls, 1);
  assert.equal(measured.coldPending, true);
  assert.equal(measured.warmReady, true);
  assert.ok(measured.staleMs < 100, JSON.stringify(measured));
  assert.equal(measured.stalePending, true);
  assert.equal(measured.changedPending, true);
  assert.equal(measured.changedOk, null);
  assert.equal(measured.fileIdentityChanged, true);
  assert.equal(measured.envIdentityChanged, true);
});
