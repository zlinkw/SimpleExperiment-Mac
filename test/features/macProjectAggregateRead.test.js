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
for (const scenario of ['workflow', 'paths', 'metadata', 'rows', 'archive', 'snapshots', 'legacy', 'budget']) {
  test('isolated actual checked project table producer and reader: ' + scenario, () => {
    const directory = path.join(root, 'release-artifacts', 'Agent 项目聚合读取 ' + scenario + ' ' + randomUUID()); fs.mkdirSync(directory, { recursive: true });
    const result = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8', path.join(__dirname, 'macProjectAggregateRead.fixture.py'), scenario,
      path.join(root, 'dist/runtime/cluster_agent.py'), directory], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const out = JSON.parse(result.stdout);
    assert.equal(out.scenario, scenario); assert.equal(out.passed, true); assert.equal(out.remoteOperations, 0); assert.equal(out.archiveMutations, 0);
    assert.equal(out.publicationExecutorsInvoked, false); assert.equal(out.capturedPublicationsOnly, true);
    for (const value of out.planKeys || []) assert.equal(value.key, layout.planDirectoryKey(value.plan));
    if (out.planKeys) assert.equal(new Set(out.planKeys.map(value => value.key)).size, out.planKeys.length);
    for (const output of out.csvs || []) {
      const csv = tables.readCsv(output.text);
      assert.equal(csv.header[0], 'plan_file'); assert.ok(csv.rows.length);
      for (const row of csv.rows) assert.ok(out.plans.includes(row[0]));
      if (output.path.endsWith('BUS/project_final.csv')) {
        assert.equal(csv.rows.length, 2);
        for (const row of csv.rows) assert.ok(Math.abs(Number(row[csv.header.indexOf('accuracy_mean')]) - .7) < 1e-12);
      }
    }
  });
}
