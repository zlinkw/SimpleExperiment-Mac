const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('real Worker launch-message preflight leaves project science callbacks to the project', () => {
  const proc = spawnSync('python', ['-B', '-X', 'utf8', path.join(__dirname, 'formalJobPreflightProgress.fixture.py'), 'fast'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.receipt.durableAccepted, true);
  assert.deepEqual(result.callbacks, [], 'plugin startup must not invoke validate_result_paths');
  assert.equal(result.executionStarted, false);
});

test('actual collection keeps custom metrics without implicitly evaluating scientific claims', () => {
  const proc = spawnSync('python', ['-B', '-X', 'utf8', path.join(__dirname, 'projectManagedSummary.fixture.py')], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  assert.equal(JSON.parse(proc.stdout).scientificCalls, 0);
});

test('completed-output verification uses the actual writer hashes and rejects changed metrics without a launch', () => {
  const proc = spawnSync('python', ['-B', '-X', 'utf8', path.join(__dirname, 'formalJobPreflightProgress.fixture.py'), 'api-completed'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.receipt.report.completed, true);
  assert.equal(result.receipt.changedResultRejected, true);
  assert.equal(result.executionStarted, false);
  assert.deepEqual(result.callbacks, []);
});
