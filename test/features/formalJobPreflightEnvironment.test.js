const { test, assert, path, spawnSync, run } = require("./formalJobPreflightProgress.support.cjs");

test('real Worker startup verifies formal ownership without an automatic environment or science probe', () => {
  const result = run('no-environment');
  assert.equal(result.receipt.durableAccepted, true, JSON.stringify(result));
  assert.deepEqual(result.callbacks, []);
  assert.equal(result.executionStarted, false);
});
