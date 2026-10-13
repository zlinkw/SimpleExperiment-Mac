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
test('real Worker admission accepts asset progress beyond the previous fixed ten-second budget', () => {
  const result = run('grow');
  assert.equal(result.receipt.durableAccepted, true, JSON.stringify(result));
  assert.ok(result.elapsedVirtualSeconds > 10);
  assert.ok(result.progressCount > 1);
  assert.equal(result.executionStarted, false);
});
test('real Worker only-index preflight checks one asset callback but all Plan paths', () => {
  for (const variant of ['fast', 'pad']) {
    const result = run(variant);
    assert.equal(result.receipt.durableAccepted, true, JSON.stringify(result));
    assert.deepEqual(result.callbacks, [variant === 'pad' ? 3 : 0]);
  }
  const shared = run('duplicate');
  assert.equal(shared.receipt.neverStarted, true);
  assert.match(shared.receipt.error || shared.receipt.message, /share one execution CSV/);
});
