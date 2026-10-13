const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
for (const mode of ['gpu', 'ordinary']) test('real existing tmux server forwards isolated formal identity: ' + mode, () => {
  const fixture = path.join(__dirname, 'formalIdentityTmux.fixture.py');
  const mounted = fixture.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/mnt/' + drive.toLowerCase());
  const args = process.platform === 'win32' ? ['--distribution', process.env.SIMPLE_TEST_WSL_DISTRO || 'Ubuntu-Codex',
    '--exec', '/usr/bin/python3', '-B', mounted, mode] : ['-B', fixture, mode];
  const proc = spawnSync(process.platform === 'win32' ? 'wsl.exe' : 'python3', args,
    { cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || String(proc.error));
  const report = JSON.parse(proc.stdout.trim());
  assert.equal(report.ok, true);
  assert.equal(report.reports.length, 2);
});
