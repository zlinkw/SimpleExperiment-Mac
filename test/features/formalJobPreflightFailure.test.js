const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function run(variant) {
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8',
    path.join(__dirname, 'formalJobPreflightProgress.fixture.py'), variant], {
    cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || String(proc.error));
  return JSON.parse(proc.stdout.trim());
}
test('real inactivity, repeated phase heartbeats and decreasing counters reject before training', () => {
  for (const variant of ['stall', 'heartbeat', 'decreasing']) {
    const result = run(variant);
    assert.equal(result.receipt.neverStarted, true);
    assert.match(result.receipt.error || result.receipt.message, /无真实进展/);
    assert.ok(result.elapsedVirtualSeconds < 90);
  }
});
test('cancel, child failure, invalid stdout JSON and identity rejection never enter training', () => {
  for (const [variant, message] of [['cancel', /取消/], ['exit', /ACTUAL_PREFLIGHT_EXIT_7/],
    ['mixed', /JSON|Expecting value/], ['identity', /IDENTITY|globalJobId/]]) {
    const result = run(variant);
    assert.equal(result.receipt.neverStarted, true);
    assert.match(result.receipt.error || result.receipt.message, message);
  }
});
