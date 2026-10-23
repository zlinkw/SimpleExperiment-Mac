const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
test('invalid identities, stale controls, bound traceback and seven portable synthetic PLAN launch contracts', () => {
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8',
    path.join(__dirname, 'formalIdentityContract.fixture.py')],
    { cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  assert.deepEqual(JSON.parse(proc.stdout.trim()), { ok: true, plans: 7, pressure: 18, reference: 2, messages: 20 });
});
test('old Worker capability blocks before saving/submitting a formal job', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/extension/legacy.ts'), 'utf8');
  const ast = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'RealtimeTunnelPanelProvider');
  const methods = cls.members.filter(node => ['enqueueDistributedPlan', 'sendDistributedJob'].includes(node.name?.getText(ast)));
  const Provider = vm.runInNewContext(ts.transpileModule('class Provider {' + methods.map(node => node.getText(ast)).join('\n') + '};Provider;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { WorkflowBinding:require("../../dist/features/WorkflowWorkspaceBinding"), workspaceRoot:()=>path.resolve(__dirname,"../..") });
  const p = new Provider();
  p.workerActionTargets = () => [{ id: 'old-worker' }];
  p.lastWorkerProbes = { 'old-worker': { capabilities: { endpoints: { declaredJobPaths: true } } } };
  p.loadDistributedQueue = () => { throw Error('old protocol must not save a submission'); };
  await assert.rejects(p.enqueueDistributedPlan({}, {}), /WORKER_PROTOCOL_INCOMPATIBLE/);
  await assert.rejects(p.sendDistributedJob({ resultPathPolicy: 'declared' }, { outputDir: 'work/job' }, 'old-worker', '0', 'cmd'), /WORKER_PROTOCOL_INCOMPATIBLE/);
});
