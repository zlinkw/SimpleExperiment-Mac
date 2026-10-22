const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');
require('../_helpers/registerTsRequire');
const Q = require('../../src/features/DistributedPlanQueue.ts');
const { collectPlanCleanupEvidence } = require('../../src/features/PlanCleanupEvidence.ts');
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-failed-job-review-'));
  const planFile = 'experiments/plans/p.yaml', text = 'mode: train_test\nbase_config: configs/p.yaml\n';
  await fs.mkdir(path.join(root, 'experiments/plans'), { recursive: true });
  await fs.mkdir(path.join(root, 'configs'), { recursive: true });
  await fs.writeFile(path.join(root, planFile), text, 'utf8');
  await fs.writeFile(path.join(root, 'configs/p.yaml'), 'seed: 42\n', 'utf8');
  const plan = { id: 'workflow', projectId: Q.canonicalProjectId(root), planFile, revision: crypto.createHash('sha256').update(text).digest('hex'),
    codeFingerprint: 'b'.repeat(64), resultPathPolicy: 'declared', executionMode: 'train_test', planJobCount: 2, fullPlanJobCount: 2,
    jobs: [0, 1].map(index => ({ index, case: 'case' + index, seed: 42, globalJobId: 'workflow:' + index,
      outputDir: 'work_dirs/formal/job' + index, collectionResultCsv: 'tmp/result/job' + index + '.csv', resultPathPolicy: 'declared',
      commandId: 'command' + index, workerId: 'worker', status: index === 0 ? 'completed' : 'failed', finishedAt: new Date().toISOString() })) };
  const tasks = plan.jobs.map(job => ({ ...job, projectId: plan.projectId, workflowId: plan.id, planFile,
    planRevision: plan.revision, codeFingerprint: plan.codeFingerprint, experimentIndex: job.index, planJobCount: 2, fullPlanJobCount: 2,
    mode: plan.executionMode, executionMode: plan.executionMode, runKey: job.commandId }));
  return { root, plan, input: { root, planFile, job: { workflowId: plan.id, index: 1, commandId: 'command1' },
    queue: { schemaVersion: 1, plans: [plan] }, ledger: { schemaVersion: 2, entries: {} }, nodes: [
      { id: 'local', kind: 'local', root }, { id: 'worker', kind: 'remote', root: '/verified/project' }],
    snapshots: [{ workerId: 'worker', tasks, generatedAt: new Date().toISOString() }] } };
}
test('formal failed-job review selects only its exact current output and CSV, with no attempt, PLAN, config or successful sibling', async () => {
  const { input, plan } = await fixture();
  const before = structuredClone(input.queue);
  const scope = await collectPlanCleanupEvidence(input);
  assert.deepEqual(scope.job, input.job);
  assert.deepEqual(scope.blockers, []);
  assert.deepEqual(scope.candidates.map(row => row.relativePath).sort(), ['tmp/result/job1.csv', 'work_dirs/formal/job1']);
  assert.equal(scope.candidates.every(row => row.expectedOwner.globalJobId === 'workflow:1'), true);
  assert.equal(scope.candidates.some(row => 'attempt' in row.expectedOwner), false);
  assert.equal(scope.candidates.every(row => row.expectedOwner.planRevision === plan.revision), true);
  assert.deepEqual(input.queue, before);
});
test('stale selection, active/foreign receipt, sibling overlap and referenced checkpoints cannot authorize job cleanup', async () => {
  for (const variant of ['stale', 'running', 'foreign', 'overlap', 'reference', 'shared-csv']) {
    const { input, plan } = await fixture();
    if (variant === 'stale') input.job.commandId = 'old-command';
    if (variant === 'running') input.snapshots[0].tasks[1].status = 'running';
    if (variant === 'foreign') input.snapshots[0].tasks[1].codeFingerprint = 'foreign';
    if (variant === 'overlap') plan.jobs[0].outputDir = plan.jobs[1].outputDir;
    if (variant === 'reference') plan.jobs[0].checkpointSource = { checkpoint_path: plan.jobs[1].outputDir + '/model.pth' };
    if (variant === 'shared-csv') plan.jobs[0].collectionResultCsv = plan.jobs[1].collectionResultCsv;
    if (variant === 'stale') await assert.rejects(collectPlanCleanupEvidence(input), /身份完整/);
    else {
      const scope = await collectPlanCleanupEvidence(input);
      assert.ok(scope.blockers.length || scope.candidates.some(row => row.protectedReason || row.dependencies.length), variant);
    }
  }
});
test('job cleanup indexes only that failed job; successful jobs and the PLAN/sync ledger remain available', async () => {
  const { input, plan, root } = await fixture();
  const source = await fs.readFile(path.join(__dirname, '../../src/extension/PlanCleanupHost.ts'), 'utf8');
  const ast = ts.createSourceFile('host.ts', source, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'PlanCleanupHost');
  const method = cls.members.find(node => node.name?.getText(ast) === 'updateIndexes').getText(ast);
  const Provider = vm.runInNewContext(ts.transpileModule('class Provider {' + method + '};Provider;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { cleanupError: require('../../src/features/PlanCleanup.ts').cleanupError,
      replacementLifecycleJob: require('../../src/features/PlanOutputReplacement.ts').replacementLifecycleJob });
  const provider = new Provider(), before = structuredClone(input.queue);
  provider.root = root; provider.assertWorkspace = () => {};
  let stored, ledgerCalls = 0;
  provider.host = { loadDistributedQueue: async () => structuredClone(input.queue), saveDistributedQueue: async (_root, value) => { stored = value; },
    updatePlanSyncLedger: async () => { ledgerCalls++; }, postState() {} };
  const operation = { id: 'job-review', pendingNodes: [], preview: { action: 'move', scope: { runIds: ['workflow'], job: input.job }, rows: [
    { id: 'exact', node: { id: 'worker' }, absolutePath: '/verified/project/work_dirs/formal/job1' }] }, targets: { exact: { state: 'completed' } } };
  await provider.updateIndexes(operation, false);
  assert.deepEqual(structuredClone(stored.plans[0].jobs[0]), before.plans[0].jobs[0]);
  assert.equal(stored.plans[0].cleanup, undefined);
  assert.equal(stored.plans[0].jobs[1].cleanup.operationId, 'job-review');
  assert.equal(ledgerCalls, 0);
  plan.jobs[1].commandId = 'changed-command';
  await assert.rejects(provider.updateIndexes(operation, false), /JOB_SCOPE_CHANGED/);
});
test('partial job cleanup blocks requeue; complete manual cleanup keeps its audit and clears only the selected job fence', async () => {
  const { input, plan } = await fixture();
  plan.jobs[1].cleanup = { operationId: 'review-operation', state: 'partial', completedTargets: [], pendingNodes: ['offline-worker'] };
  assert.throws(() => Q.retryVerifiedJob(input.queue, plan.id, 1, 'new-control-command'), /verified stopped/);
  plan.jobs[1].cleanup.state = 'archived'; plan.jobs[1].cleanup.pendingNodes = [];
  const retried = Q.retryVerifiedJob(input.queue, plan.id, 1, 'new-control-command');
  assert.deepEqual(retried.plans[0].jobs[0], plan.jobs[0]);
  assert.equal(retried.plans[0].cleanup, undefined);
  assert.equal(retried.plans[0].jobs[1].cleanup, undefined);
  assert.equal(retried.plans[0].jobs[1].history.at(-1).cleanupOperationId, 'review-operation');
  assert.equal(retried.plans[0].jobs[1].outputDir, plan.jobs[1].outputDir);
});
