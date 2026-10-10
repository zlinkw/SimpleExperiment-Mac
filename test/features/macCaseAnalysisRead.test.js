const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module'), { spawnSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
function compiled(relative) {
  const filename = path.join(root, relative), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, process: { platform: 'darwin' }, require: createRequire(filename) }, { filename });
  return module.exports;
}
const layout = compiled('dist/results/ResultLayout.js'), scope = compiled('dist/mac/ResultOperationScope.js');
for (const scenario of ['workflow', 'paths', 'ownership', 'fresh', 'identity', 'snapshots', 'inputs', 'legacy']) {
  test('isolated actual checked Agent case actions and compiled receipt: ' + scenario, () => {
    const directory = path.join(root, 'release-artifacts', 'Agent 样本读取 ' + scenario + ' ' + randomUUID()); fs.mkdirSync(directory, { recursive: true });
    const result = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8', path.join(__dirname, 'macCaseAnalysisRead.fixture.py'), scenario,
      path.join(root, 'dist/runtime/cluster_agent.py'), directory], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const out = JSON.parse(result.stdout);
    assert.equal(out.passed, true); assert.equal(out.remoteOperations, 0); assert.equal(out.archiveMutations, 0);
    assert.equal(out.capturedPublicationsOnly, true); assert.equal(out.publicationExecutorsInvoked, false);
    assert.equal(out.actualCaseExportChecked, true);
    for (const item of out.planKeys || []) assert.equal(item.key, layout.planDirectoryKey(item.plan));
    for (const receipt of out.receipts || []) {
      const own = scope.scopeMacResultOperation(receipt, out.report.planFile);
      assert.equal(own.payloads.length, 2);
      assert.equal(own.payloads[0].planRevision, out.report.planRevision);
      assert.equal(own.payloads[1].planFile, out.report.planFile);
      const report = own.payloads[1].caseLevel || own.payloads[1].leakageCheck || own.payloads[1].subgroupAnalysis || own.payloads[1].caseAnalysis;
      assert.equal(report.caseCount, 2); assert.equal(report.resultPathIdentity, 'posix-v1');
      assert.ok(report.path.includes(layout.planDirectoryKey(out.report.planFile)));
      if (receipt.action === 'export-case-analysis') assert.equal(own.payloads[1].caseAnalysisPath, report.path);
      assert.equal(scope.scopeMacResultOperation(receipt, out.report.planFile.trim()).payloads.length, 0);
    }
  });
}
