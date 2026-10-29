const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require('../_helpers/registerTsRequire');
const Q = require('../../src/features/DistributedPlanQueue.ts');
const { renderPanelHtml } = require('../../src/ui/PanelHtml.legacy.ts');
const root = path.resolve(__dirname, '../..');
function queue() {
  const q = Q.enqueuePlan(Q.emptyDistributedQueue(), { projectId: Q.canonicalProjectId(root),
    planFile: 'experiments/plans/comparison/aoept.yaml', revision: 'original-revision', codeFingerprint: 'original-code',
    resultPathPolicy: 'declared', executionMode: 'train_test', executionModeSource: 'validation', jobs: [{ index: 2,
      case: 'aoept_bus_p100', seed: 44, outputDir: 'work_dirs/aoept/bus_seed44', collectionResultCsv: 'work_dirs/aoept/bus_seed44/test_results/job_metrics.csv' }] }, 'original-workflow');
  Object.assign(q.plans[0].jobs[0], { status: 'failed', workerId: 'worker', commandId: 'original-command', runKey: 'original-command',
    trustedTerminalStatus: 'failed', error: 'FORMAL_JOB_PREFLIGHT_STALLED', finishedAt: new Date().toISOString(),
    admissionRejection: { code: 'FORMAL_JOB_PREFLIGHT_STALLED', message: 'no progress', rejectedAt: new Date().toISOString() } });
  // 本测试钉 lifecycle-1 durable 恢复链路（停止核实、产物审核、身份围栏）；
  // lifecycle-2 job 的恢复入口走 retryPulledJob，其 PulledTaskControl 语义由 idleGpuDispatchLifecycle 等专测覆盖。
  delete q.plans[0].jobs[0].lifecycleProtocol;
  return q;
}
test('rendered panel exposes explicit formal requeue without attempt and keeps running/history tasks protected', () => {
  const script = [...renderPanelHtml().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
  const start = script.indexOf('const failedRecallButton =');
  const end = script.indexOf('const failedCleanup =', start);
  assert.ok(start > 0 && end > start);
  const render = new Function('job', 'group', 'status', 'escAttr', 'isolationRecoveryButton', script.slice(start, end) + ';return failedRecallButton;');
  const job = { ...queue().plans[0].jobs[0], planId: 'original-workflow' };
  const html = render(job, { planFile: 'experiments/plans/comparison/aoept.yaml' }, 'failed', String);
  assert.match(html, /data-command="recallFailedJob"/);
  assert.doesNotMatch(html, /data-attempt|新建 attempt|移走旧目录/);
  assert.equal(render(job, {}, 'running', String), '');
  assert.equal(render({ ...job, resultPathPolicy: undefined, globalJobId: undefined, attempt: 1 }, {}, 'failed', String), '');
  const dispatchStart = script.indexOf('if (["recallFailedJob", "markJobUnavailable", "restoreJobAvailability"].includes(command))');
  const dispatchEnd = script.indexOf('if (button.dataset.file)', dispatchStart);
  const payload = {};
  new Function('command', 'button', 'payload', script.slice(dispatchStart, dispatchEnd))('recallFailedJob', { dataset: { commandId: job.commandId } }, payload);
  assert.equal(payload.commandId, job.commandId);
  assert.equal('attempt' in payload, false);
});
test('explicit retry keeps formal declarations and old rejection audit but clears the previous command terminal fence', () => {
  const original = queue(), before = structuredClone(original);
  const retried = Q.retryVerifiedJob(original, 'original-workflow', 2, 'explicit-requeue-command');
  const plan = retried.plans[0], job = plan.jobs[0];
  assert.deepEqual(original, before);
  assert.equal(plan.id, before.plans[0].id);
  assert.equal(job.outputDir, before.plans[0].jobs[0].outputDir);
  assert.equal(job.collectionResultCsv, before.plans[0].jobs[0].collectionResultCsv);
  assert.equal(job.globalJobId, 'original-workflow:2');
  assert.equal(job.status, 'pending');
  assert.equal(job.trustedTerminalStatus, undefined);
  assert.equal(job.admissionRejection, undefined);
  assert.equal(job.error, undefined);
  assert.equal(job.history[0].commandId, 'original-command');
  assert.deepEqual(job.history[0].admissionRejection, before.plans[0].jobs[0].admissionRejection);
  Object.assign(job, { status: 'queued', workerId: 'worker', commandId: job.nextCommandId, runKey: job.nextCommandId,
    dispatchAcknowledgedAt: new Date().toISOString() });
  const task = { projectId: plan.projectId, workflowId: plan.id, planFile: plan.planFile, planRevision: plan.revision,
    codeFingerprint: plan.codeFingerprint, experimentIndex: job.index, case: job.case, seed: job.seed, outputDir: job.outputDir,
    collectionResultCsv: job.collectionResultCsv, resultPathPolicy: 'declared', globalJobId: job.globalJobId,
    executionMode: plan.executionMode, mode: plan.executionMode, workerId: 'worker', commandId: job.commandId, runKey: job.runKey,
    planJobCount: 1, fullPlanJobCount: 1, status: 'queued', enqueuedAt: plan.enqueuedAt };
  const merged = Q.mergeDurableWorkerSnapshots(retried, [{ workerId: 'worker', schemaVersion: 1,
    capabilities: { schemaVersion: 1, durablePlanQueue: true }, generatedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(),
    tasks: [task, { ...task, commandId: 'original-command', runKey: 'original-command', status: 'failed' }] }], plan.projectId);
  assert.equal(merged.plans[0].jobs[0].status, 'queued', JSON.stringify(merged));
  assert.equal(merged.plans[0].recoveryConflict, undefined);
  for (const change of [{ status: 'running' }, { collectionResultCsv: 'work_dirs/foreign.csv' }]) {
    const unsafe = Q.mergeDurableWorkerSnapshots(retried, [{ workerId: 'worker', schemaVersion: 1,
      capabilities: { schemaVersion: 1, durablePlanQueue: true }, generatedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(),
      tasks: [task, { ...task, commandId: 'original-command', runKey: 'original-command', status: 'failed', ...change }] }], plan.projectId);
    assert.equal(unsafe.plans[0].jobs[0].status, 'unknown');
  }
});
const source = fs.readFileSync(path.join(root, 'src/extension/legacy.ts'), 'utf8');
const ast = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'RealtimeTunnelPanelProvider');
const method = cls.members.find(n => n.name?.getText(ast) === 'retryDistributedJobFromUi').getText(ast);
const code = ts.transpileModule('class Provider {' + method + '}; Provider;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function host(variant) {
  const Provider = vm.runInNewContext(code, { workspaceRoot: () => root, DistributedPlanQueue: Q,
    makeOpId: () => 'explicit-requeue-command', vscode: { window: { showWarningMessage: async () => variant === 'cancel' ? undefined : variant === 'artifacts' ? '审核遗留文件' : '重新排队' } } });
  const p = new Provider();
  let stored = queue(), ticks = 0;
  const reviews = [];
  const plan = stored.plans[0], job = plan.jobs[0];
  p.captureProjectContext = () => ({});
  p.projectContextIsCurrent = () => true;
  p.loadDistributedQueue = async () => structuredClone(stored);
  p.saveDistributedQueue = async (_root, next) => { stored = next; };
  p.tickDistributedQueue = async () => { ticks++; }; // No production training/GPU/network.
  p.workerCodeSyncTargets = () => [{ id: 'worker' }];
  p.workerActionTargets = () => [{ id: 'worker' }]; // 入口先对动作目标做快照，确认期间判定是否仍为当前。
  p.sftpServerOptions = () => ({ host: 'fixture', user: 'fixture', port: 22, remotePath: '/fixture' });
  p.planCleanupHost = () => ({ openJob: async (...args) => { reviews.push(args); } });
  p.simpleSftpApiCall = async () => ({ files: variant === 'artifacts' ? { 'work_dirs/aoept/bus_seed44/model.pth': 'hash' } : {}, unverifiedFiles: {} });
  p.client = { getWorkerTasks: async () => ({ tasks: [{ projectId: plan.projectId, workflowId: plan.id,
    planFile: plan.planFile, planRevision: plan.revision, codeFingerprint: variant === 'identity' ? 'foreign-code' : plan.codeFingerprint,
    experimentIndex: job.index, case: job.case, seed: job.seed, planJobCount: 1, fullPlanJobCount: 1,
    executionMode: plan.executionMode, mode: plan.executionMode, ...job, status: variant === 'running' ? 'running' : 'failed' }] }) };
  return { p, message: { planId: plan.id, jobIndex: job.index, commandId: job.commandId }, stored: () => stored, ticks: () => ticks, reviews };
}
test('existing formal recovery entry rechecks stopped ownership and empty output before explicit queue changes', async () => {
  const success = host('empty');
  await success.p.retryDistributedJobFromUi(success.message);
  assert.equal(success.stored().plans[0].jobs[0].status, 'pending');
  assert.equal(success.ticks(), 1);
  for (const variant of ['identity', 'running', 'cancel', 'stale']) {
    const h = host(variant), original = structuredClone(h.stored());
    if (variant === 'stale') h.message.commandId = 'stale-command';
    if (variant === 'cancel') await h.p.retryDistributedJobFromUi(h.message);
    else await assert.rejects(h.p.retryDistributedJobFromUi(h.message), /尚未确认|FORMAL_JOB_CONFLICT|commandId/);
    assert.deepEqual(h.stored(), original);
    assert.equal(h.ticks(), 0);
  }
});
test('occupied failed output opens an exact-job read-only review, preserving the queue and all successful jobs', async () => {
  const h = host('artifacts'), before = structuredClone(h.stored());
  const result = await h.p.retryDistributedJobFromUi(h.message);
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'FORMAL_JOB_CONFLICT');
  assert.equal(h.reviews.length, 1);
  assert.deepEqual(structuredClone(h.reviews[0]), [before.plans[0].planFile,
    { workflowId: before.plans[0].id, index: 2, commandId: 'original-command' }]);
  assert.deepEqual(h.stored(), before);
  assert.equal(h.ticks(), 0);
});
test('ownership changing during confirmation blocks requeue and duplicate workflow registration remains protected', async () => {
  const h = host('empty'), before = structuredClone(h.stored());
  let reads = 0;
  h.p.loadDistributedQueue = async () => {
    const q = structuredClone(h.stored());
    if (++reads > 1) Object.assign(q.plans[0].jobs[0], { commandId: 'changed-during-review', runKey: 'changed-during-review' });
    return q;
  };
  await assert.rejects(h.p.retryDistributedJobFromUi(h.message), /身份.*变化/);
  assert.deepEqual(h.stored(), before);
  assert.equal(h.ticks(), 0);
  // 现行重复登记围栏保护尚未派发（pending 且无 command）的重复声明；已终态的 job 不再重复占位。
  const registered = Q.enqueuePlan(Q.emptyDistributedQueue(), before.plans[0], 'original-workflow');
  assert.throws(() => Q.enqueuePlan(registered, before.plans[0], 'another-workflow'), /FORMAL_JOB_CONFLICT/);
});
