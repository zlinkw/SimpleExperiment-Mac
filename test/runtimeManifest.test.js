const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildExpectedRuntimeManifest,
  runtimeNeedsDeploy,
  sha256Text,
  verifyRuntimeHashes,
} = require("../dist/runtime/RuntimeManifest.js");

test("runtime manifest verification preserves literal component statuses", () => {
  const expected = buildExpectedRuntimeManifest("0.2.0", "0.3.0", [{
    component: "hub_agent",
    version: "0.3.0",
    remotePath: "runtime/hub_agent.py",
    content: "print('ready')\n",
  }]);

  const ok = verifyRuntimeHashes({ "runtime/hub_agent.py": sha256Text("print('ready')\n") }, expected, "2026-07-22T00:00:00.000Z");
  assert.equal(ok.ok, true);
  assert.equal(ok.components[0].status, "ok");
  assert.equal(runtimeNeedsDeploy(expected, expected), false);

  const missing = verifyRuntimeHashes({}, expected, "2026-07-22T00:00:00.000Z");
  assert.equal(missing.ok, false);
  assert.equal(missing.components[0].status, "missing");

  const mismatch = verifyRuntimeHashes({ "runtime/hub_agent.py": "wrong" }, expected, "2026-07-22T00:00:00.000Z");
  assert.equal(mismatch.components[0].status, "hash_mismatch");
});
