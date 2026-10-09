const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const scenario of ['physical', 'agent', 'changed', 'revision', 'jobs', 'attempt', 'key', 'enqueue']) {
  test('compiled Agent/scheduler retains exact POSIX launch paths: ' + scenario, () => {
    const result = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8',
      path.join(__dirname, 'macPlanLaunchPaths.fixture.py'), scenario],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), { scenario, passed: true, remoteOperations: 0 });
  });
}
