const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module'), { spawnSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
function compiled(relative, overrides = {}) {
  const filename = path.join(root, relative), module = { exports: {} }, localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, process: { platform: 'darwin' },
    require: id => Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id) }, { filename });
  return module.exports;
}
const layout = compiled('dist/results/ResultLayout.js');
const tables = compiled('dist/results/ProjectResultTables.js', { './ResultLayout': layout });
for (const scenario of ['plans', 'legacy', 'revision', 'keys', 'decisions', 'cache', 'snapshots', 'parser']) {
  test('isolated actual read-only Agent archive evidence: ' + scenario, () => {
    const directory = path.join(root, 'release-artifacts', 'Agent 归档证据读取 ' + scenario + ' ' + randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    const result = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8', path.join(__dirname, 'macArchiveEvidenceRead.fixture.py'), scenario,
      path.join(root, 'dist/runtime/cluster_agent.py'), directory], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const out = JSON.parse(result.stdout);
    assert.equal(out.scenario, scenario); assert.equal(out.passed, true); assert.equal(out.remoteOperations, 0); assert.equal(out.archiveMutations, 0);
    if (out.planKeys) {
      assert.equal(new Set(out.planKeys.map(value => value.key)).size, out.planKeys.length);
      for (const value of out.planKeys) assert.equal(value.key, layout.planDirectoryKey(value.plan));
    }
    if (out.summary) {
      const summary = out.summary;
      assert.equal(summary.summaryPath, 'simple_cluster/results/by_plan/' + layout.planDirectoryKey(summary.planFile) + '/summary.json');
      const registry = tables.updateRegistry(tables.emptyTableRegistry(), summary, summary.planFile);
      assert.equal(tables.registeredPlanSummary(registry, summary.planFile).planFile, summary.planFile);
      assert.throws(() => tables.updateRegistry(tables.emptyTableRegistry(), summary, summary.planFile.trim()));
      assert.equal(summary.finalResultCount, 2); assert.equal(summary.finalResults.length, 2);
    }
    if (scenario === 'snapshots') { assert.equal(out.events, 0); assert.equal(out.writes, 0); }
  });
}
