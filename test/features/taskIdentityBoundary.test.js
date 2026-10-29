const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('real extracted stop and acceptance functions reject changed identities and unconfirmed cancellation', () => {
  const result = spawnSync(process.env.PYTHON || 'python', ['-X', 'utf8', path.join(__dirname, 'taskIdentityBoundary.fixture.py')], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
