const { test, assert, path, spawnSync, run } = require("./formalJobPreflightProgress.support.cjs");

test('real Worker only-index preflight checks all Plan paths without project science', () => {
  for (const variant of ['fast', 'pad']) {
    const result = run(variant);
    assert.equal(result.receipt.durableAccepted, true, JSON.stringify(result));
    assert.deepEqual(result.callbacks, []);
  }
  const shared = run('duplicate');
  assert.equal(shared.receipt.neverStarted, true);
  assert.match(shared.receipt.error || shared.receipt.message, /share one execution CSV/);
});
