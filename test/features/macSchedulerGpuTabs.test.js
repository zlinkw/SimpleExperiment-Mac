const test = require('node:test'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const scenario of ['launch', 'hub', 'failed', 'identity', 'stop']) {
  test('compiled scheduler GPU tab contract: ' + scenario, () => {
    const result = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8',
      path.join(__dirname, 'macSchedulerGpuTabs.fixture.py'), scenario],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), { scenario, remoteOperations: 0 });
  });
}
