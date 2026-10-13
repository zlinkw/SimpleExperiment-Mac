const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('real stdlib interpreter probes preserve per-job identity; invalid metadata, overflow and timeout reject and reap', () => {
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8',
    path.join(__dirname, 'executionShellEnvironment.fixture.py')], { cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const { receipts, failures } = JSON.parse(proc.stdout);
  assert.equal(receipts.length, 2);
  assert.equal(failures.length, 5);
  assert.notEqual(receipts[0].identity, receipts[1].identity);
  assert.ok(failures.some(message => /exceeds limit/.test(message)));
  assert.ok(failures.some(message => /timed out/.test(message)));
});
