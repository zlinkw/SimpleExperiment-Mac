const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
function bashPath() {
  if (process.platform !== 'win32') return '/bin/bash';
  const git = spawnSync('where.exe', ['git'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  const bash = path.join(path.dirname(path.dirname(git.stdout.trim().split(/\r?\n/)[0])), 'bin/bash.exe');
  assert.ok(fs.existsSync(bash), 'a real local Git Bash is required');
  return bash;
}
for (const variant of ['prefix', 'python', 'missing']) test('real clean task shell: ' + variant + ', without a conda CLI', () => {
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8',
    path.join(__dirname, 'executionShellPreflight.fixture.py'), bashPath(), variant,
    ...(variant === 'missing' ? ['scheduler'] : [])], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const results = JSON.parse(proc.stdout);
  for (const [component, result] of Object.entries(results)) {
    if (variant === 'missing') { assert.notEqual(result.returncode, 0, component); assert.doesNotMatch(result.stdout, /"selected"/); }
    else { assert.equal(result.returncode, 0, component + ': ' + JSON.stringify(result)); assert.ok(JSON.parse(result.stdout).selected); }
  }
});
