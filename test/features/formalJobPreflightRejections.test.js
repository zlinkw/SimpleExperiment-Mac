const { test, assert, path, spawnSync, run } = require("./formalJobPreflightFailure.support.cjs");

test('cancel, child failure, invalid stdout JSON and identity rejection never enter training', () => {
  for (const [variant, message] of [['cancel', /取消/], ['exit', /ACTUAL_PREFLIGHT_EXIT_7/],
    ['mixed', /JSON|Expecting value/], ['identity', /IDENTITY|globalJobId/]]) {
    const result = run(variant);
    assert.equal(result.receipt.neverStarted, true);
    assert.match(result.receipt.error || result.receipt.message, message);
  }
});
