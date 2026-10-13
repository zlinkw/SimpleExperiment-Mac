const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let cached;

module.exports = function productionWorkerTelemetryCapabilities() {
  if (!cached) {
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
      ['-B', '-X', 'utf8', path.join(__dirname, 'workerTelemetryCapabilities.py')],
      { cwd: path.join(__dirname, '../..'), encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
    cached = JSON.parse(result.stdout);
  }
  return structuredClone(cached);
};
