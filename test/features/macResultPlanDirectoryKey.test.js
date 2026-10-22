const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

function layout(platform) {
  const filename = path.join(root, 'dist/results/ResultLayout.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, process: { platform }, require: createRequire(filename),
  }, { filename });
  return module.exports;
}

test('Mac result directories distinguish legal leaf spaces, case and Unicode bytes', () => {
  const api = layout('darwin');
  const plans = ['A.yaml', 'A.yaml ', ' A.yaml', 'a.yaml', 'é.yaml', 'e\u0301.yaml']
    .map(name => 'experiments/Plans 中文 /' + name);
  const keys = plans.map(api.planDirectoryKey);
  assert.equal(new Set(keys.map(key => key.toLowerCase())).size, plans.length);
  const child = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8',
    path.join(__dirname, 'macResultIdentity.fixture.py'), path.join(root, 'dist/runtime/cluster_agent.py'), JSON.stringify(plans)],
  { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.deepEqual(JSON.parse(child.stdout), { keys, remoteOperations: 0 });
});

test('Mac directory identity rejects malformed paths before normalization', () => {
  const api = layout('darwin');
  for (const plan of ['./a.yaml', 'a//b.yaml', 'a/../b.yaml', 'a\\b.yaml', '/a.yaml', 'C:/a.yaml', 'a\n.yaml', 12])
    assert.throws(() => api.planDirectoryKey(plan));
});

test('Windows compatibility branch keeps the frozen normalization behavior', () => {
  const api = layout('win32');
  assert.equal(api.planDirectoryKey('./a.yaml'), api.planDirectoryKey('a.yaml'));
  assert.equal(api.planDirectoryKey('a.yaml '), api.planDirectoryKey('a.yaml'));
});
