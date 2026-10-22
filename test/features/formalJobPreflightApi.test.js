const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/extension/legacy.ts'), 'utf8');
const ast = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'RealtimeTunnelPanelProvider');
const member = cls.members.find(n => n.name?.getText(ast) === 'apiTaskPreflight').getText(ast);
const code = ts.transpileModule('class Provider {' + member + '}; Provider;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
  const Provider = vm.runInNewContext(code, { workspaceRoot: () => root, makeOpId: () => 'formal-preflight-diagnostic',
    stringField: (params, key) => String(params[key] || ''), DistributedPlanQueue: { canonicalProjectId: () => 'project' } });
  const row = { workerId: 'worker', projectId: 'project', commandId: 'original-command', workflowId: 'original-workflow',
    globalJobId: 'original-workflow:5', experimentIndex: 5, planRevision: 'original-revision', codeFingerprint: 'original-code',
    status: 'failed', neverStarted: true, neverStartedEvidence: 'formal_preflight_rejected' };
  const calls = [], p = new Provider();
  p.client = { postWorkerAction: async (...args) => { calls.push(args); return { operationId: 'formal-preflight-diagnostic' }; },
    getWorkerOperation: async () => ({ payload: { action: 'preflight-worker-task' }, status: 'running' }) };
  p.workerActionTargets = () => [{ id: 'worker' }];
  p.refreshDistributedResultSyncProbes = async () => {};
  p.missingWorkerActionCapabilities = () => [];
  // environmentOnly 现行动作要求 taskShellEnvironment=1（登录 shell 重绑协议），与 executionShellPreflight 各自独立把关。
  p.lastWorkerProbes = { worker: { capabilities: { endpoints: { executionShellPreflight: 1, taskShellEnvironment: 1 } } } };
  p.readWorkerTaskSnapshot = async () => ({ tasks: [row] });
  return { p, row, calls, signal: new AbortController().signal };
}
test('diagnostic API runs the real Worker startup gate without changing the rejected job or launching', () => {
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8',
    path.join(__dirname, 'formalJobPreflightProgress.fixture.py'), 'api'], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const { receipt, callbacks } = JSON.parse(proc.stdout);
  assert.equal(receipt.executionStarted, false);
  assert.equal(receipt.queueChanged, false);
  // 资产核实归项目 hook（project_owned）：正式预检只做结构与身份核实，不再逐资产回调或代为执行项目校验。
  assert.deepEqual(receipt.report.preflight.assetValidationIndices, []);
  assert.equal(receipt.report.preflight.projectValidationExecuted, false);
  assert.equal(receipt.report.preflight.structuralJobCount, 6);
  assert.deepEqual(callbacks, []);
  assert.ok(fs.readFileSync(path.join(root, 'dist/runtime/cluster_scheduler.py'), 'utf8').includes('"assetValidation": "project_owned"'), 'Scheduler 必须显式声明资产核实归属项目 hook');
  assert.ok(receipt.rejections.every(r => /MISMATCH|REQUIRES|size mismatch|hash mismatch/.test(r)), JSON.stringify(receipt));
});
test('Host API sends the frozen original identity exclusively to the dedicated no-launch action', async () => {
  const { p, row, calls, signal } = fixture();
  const frozen = JSON.stringify(row);
  await p.apiTaskPreflight({ workerId: 'worker', commandId: row.commandId }, 'start', signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'preflight-worker-task');
  assert.equal(calls[0][2].targetCommandId, row.commandId);
  assert.equal(calls[0][2].expectedIdentity, row);
  assert.notEqual(calls[0][2].opId, row.commandId);
  assert.equal(JSON.stringify(row), frozen);
});
test('environment-only API verifies the actual child shell without admitting or changing an occupied failed job', async () => {
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8',
    path.join(__dirname, 'formalJobPreflightProgress.fixture.py'), 'api-environment'], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const { receipt, callbacks } = JSON.parse(proc.stdout);
  assert.equal(receipt.report.environmentOnly, true);
  assert.equal(receipt.report.formalJobAdmissionChecked, false);
  assert.equal(receipt.report.shellVerified, true);
  assert.equal(receipt.executionStarted, false);
  assert.equal(receipt.queueChanged, false);
  assert.equal(JSON.parse(receipt.report.identity).commandId, 'owned-command');
  assert.deepEqual(callbacks, []);
  const { p, row, calls, signal } = fixture();
  row.neverStarted = false;
  row.neverStartedEvidence = '';
  await assert.rejects(p.apiTaskPreflight({ workerId: 'worker', commandId: row.commandId }, 'start', signal), /NEVER_STARTED/);
  await p.apiTaskPreflight({ workerId: 'worker', commandId: row.commandId, environmentOnly: true }, 'start', signal);
  assert.equal(calls[0][2].environmentOnly, true);
  p.lastWorkerProbes.worker.capabilities.endpoints.executionShellPreflight = 0;
  await assert.rejects(p.apiTaskPreflight({ workerId: 'worker', commandId: row.commandId, environmentOnly: true }, 'start', signal), /INCOMPATIBLE/);
  await assert.rejects(p.apiTaskPreflight({ workerId: 'worker', commandId: row.commandId, environmentOnly: 'true' }, 'start', signal), /INVALID_ENVIRONMENT/);
  assert.equal(calls.length, 1);
});
test('preflight calls only real provider methods, and a missing configured client blocks before any POST', async () => {
  const members = new Set(cls.members.map(n => n.name?.getText(ast)));
  const method = cls.members.find(n => n.name?.getText(ast) === 'apiTaskPreflight');
  function check(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
      assert.ok(members.has(node.expression.name.text), 'nonexistent Host method: ' + node.expression.name.text);
    }
    ts.forEachChild(node, check);
  }
  check(method);
  const { p, row, calls, signal } = fixture();
  p.client = undefined;
  await assert.rejects(p.apiTaskPreflight({ workerId: 'worker', commandId: row.commandId }, 'start', signal), /CLIENT_UNAVAILABLE/);
  assert.equal(calls.length, 0);
});
test('old Worker capabilities, active jobs and foreign project rows block before any POST', async () => {
  for (const variant of ['old', 'running', 'foreign']) {
    const { p, row, calls, signal } = fixture();
    if (variant === 'old') p.missingWorkerActionCapabilities = () => ['actions.preflight-worker-task'];
    else if (variant === 'running') row.status = 'running';
    else row.projectId = 'foreign';
    await assert.rejects(p.apiTaskPreflight({ workerId: 'worker', commandId: row.commandId }, 'start', signal), /INCOMPATIBLE|REQUIRES|UNAVAILABLE/);
    assert.equal(calls.length, 0);
  }
});
test('status/cancellation are scoped to a verified diagnostic, never to a Scheduler/job stop', async () => {
  const { p, calls, signal } = fixture();
  const params = { workerId: 'worker', operationId: 'formal-preflight-existing' };
  assert.equal((await p.apiTaskPreflight(params, 'status', signal)).status, 'running');
  assert.equal(calls.length, 0);
  await p.apiTaskPreflight(params, 'cancel', signal);
  assert.equal(calls[0][1], 'preflight-worker-task');
  assert.equal(calls[0][2].targetPreflightOperationId, params.operationId);
  p.client.getWorkerOperation = async () => ({ payload: { action: 'run-plan' } });
  await assert.rejects(p.apiTaskPreflight(params, 'cancel', signal), /MISMATCH/);
  assert.equal(calls.length, 1);
});
test('Agent routes advertise and asynchronously dispatch the diagnostic action in Worker mode', () => {
  const agent = fs.readFileSync(path.join(root, 'dist/runtime/cluster_agent.py'), 'utf8');
  assert.ok(agent.includes('"/api/actions/preflight-worker-task"'));
  assert.ok(agent.includes('"preflight-worker-task": True'));
  assert.ok(agent.includes('("validate-plan", "dry-run-plan", "preflight-worker-task", "rebuild-distributed-results")'));
  assert.ok(source.includes('"tasks.preflight":'));
});
