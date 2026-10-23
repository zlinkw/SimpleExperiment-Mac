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
module.exports={test,assert,path,spawnSync,run};
