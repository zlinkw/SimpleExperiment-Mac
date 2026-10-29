const { test, assert, path, spawnSync, run } = require("./formalJobPreflightFailure.support.cjs");

test('real inactivity, repeated phase heartbeats and decreasing counters reject before training', () => {
  for (const variant of ['stall', 'heartbeat', 'decreasing']) {
    const result = run(variant);
    console.log(JSON.stringify({variant, elapsed:result.elapsedVirtualSeconds, inactivity:result.inactivityDurations}));
    assert.equal(result.watchdogReady, true, "the real fixture probe must start before virtual watchdog time advances");
    assert.equal(result.receipt.neverStarted, true);
    assert.match(result.receipt.error || result.receipt.message, /无真实进展/);
    assert.ok(result.elapsedVirtualSeconds < 90, JSON.stringify(result));
  }
});
test('cancel, child failure, invalid stdout JSON and identity rejection never enter training', () => {
  for (const [variant, message] of [['cancel', /FORMAL_JOB_PREFLIGHT_CANCELLED.*取消/], ['exit', /ACTUAL_PREFLIGHT_EXIT_7/],
    ['mixed', /JSON|Expecting value/], ['identity', /IDENTITY|globalJobId/]]) {
    const result = run(variant);
    assert.equal(result.receipt.neverStarted, true);
    assert.match(result.receipt.error || result.receipt.message, message);
  }
});
