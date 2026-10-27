const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
test('Mac formal shell identity, environment isolation and exact failure diagnostics preserve historical outputs', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8', path.join(__dirname, 'macFormalIdentity.fixture.py')],
    { cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { ok: true });
});

test('old Worker declared paths alone cannot save or submit a new formal job', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/extension/legacy.ts'), 'utf8');
  const ast = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'RealtimeTunnelPanelProvider');
  const methods = cls.members.filter(node => ['enqueueDistributedPlan', 'sendDistributedJob'].includes(node.name?.getText(ast)));
  // 工作区绑定只做直通桩：本测试只钉旧协议 Worker 在动作目标快照后立即被协议门禁拒绝，绑定语义由 WorkflowBinding 专测覆盖。
  const Provider = vm.runInNewContext(ts.transpileModule('class Provider {' + methods.map(node => node.getText(ast)).join('\n') + '};Provider;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { workspaceRoot: () => '/fixture-project', WorkflowBinding: { bindWorkflowWorkspace: () => ({}), assertPlanSeedContract: () => {}, assertWorkflowWorkspace: () => {}, assertWorkflowContext: () => {} } });
  const p = new Provider();
  p.workerActionTargets = () => [{ id: 'old-worker' }];
  p.lastWorkerProbes = { 'old-worker': { capabilities: { endpoints: { declaredJobPaths: true } } } };
  p.loadDistributedQueue = () => { throw Error('old protocol must not save a submission'); };
  // 统一域判定与本用例无关（它只看登记表），取生产同款“无登记表”结果，避免把门禁当成被测试对象。
  p.unifiedDomainState = () => ({ active: false, blocked: '' });
  await assert.rejects(p.enqueueDistributedPlan({}, {}), /WORKER_PROTOCOL_INCOMPATIBLE/);
  await assert.rejects(p.sendDistributedJob({ resultPathPolicy: 'declared' }, { outputDir: 'work/job' }, 'old-worker', '0', 'cmd'), /WORKER_PROTOCOL_INCOMPATIBLE/);
});
