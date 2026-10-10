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
const scope = compiled('dist/mac/ResultSummaryScope.js');
for (const scenario of ['workflow', 'paths', 'fresh', 'archive', 'identity', 'snapshots', 'inputs', 'legacy']) {
  test('isolated actual checked Agent Plan analysis and compiled summary: ' + scenario, () => {
    const directory = path.join(root, 'release-artifacts', 'Agent 分析读取 ' + scenario + ' ' + randomUUID()); fs.mkdirSync(directory, { recursive: true });
    const result = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8', path.join(__dirname, 'macPlanAnalysisRead.fixture.py'), scenario,
      path.join(root, 'dist/runtime/cluster_agent.py'), directory], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const out = JSON.parse(result.stdout);
    assert.equal(out.passed, true); assert.equal(out.remoteOperations, 0); assert.equal(out.archiveMutations, 0);
    assert.equal(out.capturedPublicationsOnly, true); assert.equal(out.publicationExecutorsInvoked, false);
    for (const item of out.planKeys || []) assert.equal(item.key, layout.planDirectoryKey(item.plan));
    if (out.summary) {
      const summary = scope.scopeMacResultSummary(out.summary, out.report.planFile);
      assert.equal(summary.statisticsResultCount, out.report.resultCount);
      assert.equal(summary.statisticsPath, out.report.path);
      const registry = tables.updateRegistry(tables.emptyTableRegistry(), summary, out.report.planFile);
      const registered = tables.registeredPlanSummary(registry, out.report.planFile);
      assert.equal(registered.planFile, out.report.planFile); assert.equal(registered.results.length, 2);
      const foreign = scope.scopeMacResultSummary(out.summary, out.report.planFile.trim());
      assert.equal(foreign.resultCount, 0); assert.equal(foreign.statisticsPath, undefined);
    }
  });
}
