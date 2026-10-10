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
for (const scenario of ['request', 'receipt', 'paths', 'selection', 'rows', 'policy', 'snapshots', 'aggregate', 'summary']) {
  test('isolated actual Agent Plan parser and compiled table identity: ' + scenario, () => {
    const directory = path.join(root, 'release-artifacts', 'Agent 结果解析 ' + scenario + ' ' + randomUUID()); fs.mkdirSync(directory, { recursive: true });
    const result = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8', path.join(__dirname, 'macAgentParseResults.fixture.py'), scenario,
      path.join(root, 'dist/runtime/cluster_agent.py'), directory], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const out = JSON.parse(result.stdout); assert.equal(out.scenario, scenario); assert.equal(out.passed, true); assert.equal(out.remoteOperations, 0);
    for (const receipt of out.receipts || []) {
      assert.equal(receipt.planFile, out.plan); assert.equal(receipt.selectedPlanId, out.plan); assert.equal(receipt.planRevision, ' revision ');
      assert.equal(receipt.summaryPath, 'simple_cluster/results/by_plan/' + layout.planDirectoryKey(out.plan) + '/summary.json');
    }
    for (const summary of out.summaries || []) {
      const key = layout.planDirectoryKey(summary.planFile);
      assert.equal(summary.summaryPath, 'simple_cluster/results/by_plan/' + key + '/summary.json');
      if (summary.rawResultCsvPath) {
        const registry = tables.updateRegistry(tables.emptyTableRegistry(), summary, summary.planFile);
        assert.ok(Object.hasOwn(registry.plans, summary.planFile));
        const registered = tables.registeredPlanSummary(registry, summary.planFile);
        if (registry.plans[summary.planFile].records.length) assert.equal(registered.planFile, summary.planFile);
        else assert.equal(registered, undefined);
      } else {
        assert.throws(() => tables.updateRegistry(tables.emptyTableRegistry(), summary, summary.planFile), /逐 seed 原始记录/);
      }
      assert.throws(() => tables.updateRegistry(tables.emptyTableRegistry(), summary, summary.planFile + ' '));
      for (const record of summary.results) {
        assert.equal(record.planFile, summary.planFile); assert.equal(record.provenance.planFile, summary.planFile);
        assert.ok(summary.sources.includes(record.sourceFiles[0].path));
      }
    }
    if (scenario === 'snapshots') { assert.equal(out.events, 0); assert.equal(out.writes, 0); }
  });
}
