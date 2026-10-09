const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Queue = require('../../dist/features/DistributedPlanQueue');
const PlanExecutionMode = require('../../dist/features/PlanExecutionMode');
const PlanBuilder = require('../../dist/features/PlanBuilder');
const Policy = require('../../dist/features/DistributedSchedulingPolicy');
const source = fs.readFileSync(require.resolve('../../dist/extension/legacy'), 'utf8');
const root = 'C:/mode-project';
function method(start, end, scope = {}) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return vm.runInNewContext('({' + source.slice(from, to) + '})', {
    PlanExecutionMode, DistributedPlanQueue: Queue, PlanBuilder_1: PlanBuilder,
    workspaceRoot: () => root, makeOpId: () => 'distributed-plan-mode',
    operationResultPlanFile: body => body.planFile, planValidationFromResult: result => result.validation,
    DistributedSchedulingPolicy: { schedulingMode: value => value || 'local_idle' },
    durableCodeProofRequestFields: () => ({}), safeWorkspacePlanPath: (_, file) => file,
    planDirSafe: () => 'experiments/plans', ...scope,
  });
}
function host(queue = Queue.emptyDistributedQueue()) {
  const owner = { queue, distributedQueueGeneration: 0, context: { globalStorageUri: { fsPath: 'C:/storage' } },
    lastCodeSyncState: { fingerprint: 'code', workerVersions: { worker: { codeSyncProofId: 'proof' } } },
    lastWorkerProbes: { worker: { capabilities: { actionEndpoints: { 'register-code-sync-proof': true } } } },
    workerActionTargets: () => [{ id: 'worker', condaEnv: 'env' }], enabledWorkerConfigs: () => [],
    schedulerSettings: () => ({}), loadDistributedQueue: async () => owner.queue,
    saveDistributedQueue: async (_, value) => { owner.queue = value; }, postState() {},
    withRemoteActionResource: (_, __, ___, work) => work(),
    client: { postWorkerAction: async (_, __, request) => request },
  };
  return owner;
}
for (const mode of ['train', 'test', 'train_test']) test('validated mode survives persistence, dispatch and manual retry: ' + mode, async () => {
  const owner = host();
  const enqueue = method('async enqueueDistributedPlan(', 'detachStaleDistributedTick(');
  await enqueue.enqueueDistributedPlan.call(owner, { planFile: 'experiments/plans/mode.yaml', planRevision: 'rev' },
    { validation: { execution_mode: mode, jobs: [{ index: 0, case: 'case', seed: 42, output_dir: 'work/job' }] } }, true);
  owner.queue = JSON.parse(JSON.stringify(owner.queue));
  let plan = owner.queue.plans[0], job = plan.jobs[0];
  assert.equal(plan.executionMode, mode);
  const send = method('async sendDistributedJob(', 'async tickDistributedQueueCore(').sendDistributedJob;
  const request = await send.call(owner, plan, job, 'worker', '0', 'command');
  assert.equal(request.mode, mode); assert.equal(request.executionMode, mode); assert.equal(request.options.mode, mode);
  job.status = 'failed';
  owner.queue = Queue.retryVerifiedJob(owner.queue, plan.id, 0, 'manual-attempt');
  plan = owner.queue.plans[0]; job = plan.jobs[0];
  assert.equal((await send.call(owner, plan, job, 'worker', '0', 'retry-command')).mode, mode);
  const task = { ...request, commandId: 'command', runKey: 'command', workerId: 'worker', status: 'completed' };
  const now = Date.now(), at = new Date(now).toISOString();
  const restored = Queue.mergeDurableWorkerSnapshots(Queue.emptyDistributedQueue(), [{ workerId: 'worker',
    generatedAt: at, fetchedAt: at, capabilities: { durablePlanQueue: true, schemaVersion: 1 }, tasks: [task] }], request.projectId, now);
  assert.equal(restored.plans[0].executionMode, mode);
});
test('unverified mode never reaches Worker; changed PLAN cannot restore an old mode', async () => {
  const owner = host();
  const send = method('async sendDistributedJob(', 'async tickDistributedQueueCore(').sendDistributedJob;
  owner.client.postWorkerAction = () => { throw new Error('must not dispatch'); };
  await assert.rejects(send.call(owner, {}, {}, 'worker', '0', 'command'), /unverified/);
  const text = 'mode: train\r\n';
  const revision = crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(PlanExecutionMode.modeFromMatchingPlan(revision, text, 'train'), 'train');
  assert.equal(PlanExecutionMode.modeFromMatchingPlan(revision, 'mode: test\n', 'test'), undefined);
});
test('loading legacy queue restores matching mode without restarting or changing active receipts', async () => {
  const text = 'suite: mode\nmode: train\nbase_config: configs/base.yaml\nseeds: [42]\ncases:\n  - case: case\n';
  const revision = crypto.createHash('sha256').update(text).digest('hex');
  const queue = Queue.enqueuePlan(Queue.emptyDistributedQueue(), { planFile: 'experiments/plans/mode.yaml', revision,
    codeFingerprint: 'code', jobs: [{ index: 0, case: 'case', seed: 42, outputDir: 'work/job/attempts/run' }] }, 'run');
  Object.assign(queue.plans[0].jobs[0], { status: 'running', workerId: 'worker', commandId: 'active', actualExecutionMode: 'train_test' });
  const original = JSON.stringify(queue), owner = host(queue);
  const load = method('async loadDistributedQueue(', 'async withQueueWriteResource(', {
    fs: { readFile: async file => file.endsWith('.json') ? original : text },
  }).loadDistributedQueue;
  const restored = await load.call(owner, root);
  assert.equal(restored.plans[0].executionMode, 'train');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.plans[0].jobs)), queue.plans[0].jobs);
  assert.equal(original, JSON.stringify(queue));
  // A changed PLAN must fence only new work, retaining the original running receipt.
  const missing = method('async loadDistributedQueue(', 'async withQueueWriteResource(', {
    fs: { readFile: async file => file.endsWith('.json') ? original : text.replace('mode: train', 'mode: test') },
  }).loadDistributedQueue;
  const unverified = await missing.call(host(queue), root);
  assert.equal(unverified.plans[0].executionModeBlocked, true);
  assert.equal(unverified.plans[0].jobs[0].status, 'running');
  unverified.plans[0].schedulingMode = 'server_prequeue';
  unverified.plans[0].jobs.push({ index: 1, case: 'case', seed: 43, attempt: 1, status: 'pending', outputDir: 'work/other' });
  assert.equal(Queue.allocateAvailable(unverified, [{ workerId: 'other', idleGpuIds: ['0'], online: true, codeFingerprint: 'code' }]).dispatches.length, 0);
  assert.equal(Policy.allocateServerPrequeue(unverified, [{ workerId: 'other', online: true, codeFingerprint: 'code', weight: 1 }]).dispatches.length, 0);
  assert.equal(Queue.pinnedRetryPlanAllowed(unverified.plans[0]), false);
  assert.equal(Queue.hostedRetryCandidates(unverified.plans[0]).length, 0);
  const invalidText = text.replace('mode: train', 'mode: invalid');
  const invalidQueue = JSON.parse(original);
  invalidQueue.plans[0].revision = crypto.createHash('sha256').update(invalidText).digest('hex');
  const invalidLoad = method('async loadDistributedQueue(', 'async withQueueWriteResource(', {
    fs: { readFile: async file => file.endsWith('.json') ? JSON.stringify(invalidQueue) : invalidText },
  }).loadDistributedQueue;
  assert.equal((await invalidLoad.call(host(invalidQueue), root)).plans[0].executionModeBlocked, true);
});
test('automatic resource retry retains validated train mode across reassignment', () => {
  const now = Date.now(), at = new Date(now).toISOString(), projectId = 'project';
  let queue = Queue.enqueuePlan(Queue.emptyDistributedQueue(), { projectId, planFile: 'plans/train.yaml', revision: 'rev',
    executionMode: 'train', codeFingerprint: 'code', jobs: [{ index: 0, case: 'case', seed: 42, outputDir: 'work/job/attempts/run' }] }, 'run', at);
  const job = queue.plans[0].jobs[0]; Object.assign(job, { status: 'failed', workerId: 'worker', commandId: 'old', runKey: 'old',
    error: 'CUDA out of memory', finishedAt: at, trustedTerminalStatus: 'failed' });
  const task = { projectId, planFile: 'plans/train.yaml', planRevision: 'rev', codeFingerprint: 'code', workflowId: 'run',
    experimentIndex: 0, case: 'case', seed: 42, attempt: 1, outputDir: job.outputDir, commandId: 'old', runKey: 'old',
    workerId: 'worker', planJobCount: 1, status: 'failed', finishedAt: at, error: job.error };
  const snapshot = n => [{ workerId: 'worker', generatedAt: new Date(n).toISOString(), fetchedAt: new Date(n).toISOString(),
    capabilities: { durablePlanQueue: true, schemaVersion: 1 }, tasks: [task] }];
  queue = Queue.scheduleAutomaticJobRetries(queue, snapshot(now), projectId, { now, makeAttemptId: () => 'auto-attempt' });
  queue = Queue.scheduleAutomaticJobRetries(queue, snapshot(now + 30000), projectId, { now: now + 30000, makeAttemptId: () => 'auto-attempt' });
  assert.equal(queue.plans[0].executionMode, 'train'); assert.equal(queue.plans[0].jobs[0].attempt, 2);
  const reassigned = Queue.allocateAvailable(queue, [{ workerId: 'other', idleGpuIds: ['0'], online: true, codeFingerprint: 'code' }]);
  assert.equal(reassigned.dispatches[0].workerId, 'other'); assert.equal(reassigned.queue.plans[0].executionMode, 'train');
});
test('confirmed training recovery survives a lost Host receipt, rejecting changed proof identity', () => {
  const now = Date.now(), at = new Date(now).toISOString(), projectId = 'project';
  const queue = Queue.enqueuePlan(Queue.emptyDistributedQueue(), { projectId, planFile: 'plans/train.yaml', revision: 'rev',
    executionMode: 'train', codeFingerprint: 'code', jobs: [{ index: 0, case: 'case', seed: 42, outputDir: 'work/job/attempts/run' }] }, 'run', at);
  const plan = queue.plans[0], job = plan.jobs[0];
  Object.assign(job, { status: 'failed', trustedTerminalStatus: 'failed', workerId: 'worker', commandId: 'command', runKey: 'command' });
  const task = { projectId, planFile: plan.planFile, planRevision: 'rev', codeFingerprint: 'code', workflowId: 'run',
    experimentIndex: 0, case: 'case', seed: 42, attempt: 1, outputDir: job.outputDir, commandId: 'command', runKey: 'command',
    workerId: 'worker', planJobCount: 1, enqueuedAt: at, status: 'completed', executionMode: 'train', mode: 'train', finishedAt: at, error: '',
    originalExecution: { status: 'failed', exitCode: 1, mode: 'train_test', error: 'Validation-only tuning cannot access test patients' },
    trainingRecovery: { kind: 'validation_adapter_checkpoint', projectId, planFile: plan.planFile, planRevision: 'rev', codeFingerprint: 'code',
      workflowId: 'run', experimentIndex: 0, case: 'case', seed: 42, attempt: 1, outputDir: job.outputDir, commandId: 'command',
      workerId: 'worker', confirmedAt: at, metricSplit: 'val', checkpointPath: job.outputDir + '/best_model.pth',
      sha256: Object.fromEntries(['best_model.pth', 'config.yaml', 'config_snapshot.yaml', 'metrics_summary.csv', 'artifact_manifest.json',
        'checkpoint_manifest.json'].map(name => [job.outputDir + '/' + name, 'a'.repeat(64)])) } };
  const merge = receipt => Queue.mergeDurableWorkerSnapshots(queue, [{ workerId: 'worker', generatedAt: at, fetchedAt: at,
    capabilities: { durablePlanQueue: true, schemaVersion: 1 }, tasks: [receipt] }], projectId, now);
  const recovered = merge(task).plans[0].jobs[0];
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.trustedTerminalStatus, 'completed');
  assert.equal(recovered.actualExecutionMode, 'train_test'); assert.equal(recovered.originalExecution.exitCode, 1);
  for (const changed of [{ seed: 44 }, { outputDir: 'other/attempt' }, { confirmedAt: undefined }, { metricSplit: 'test' }])
    assert.notEqual(merge({ ...task, trainingRecovery: { ...task.trainingRecovery, ...changed } }).plans[0].jobs[0].status, 'completed');
  assert.equal(queue.plans[0].jobs[0].status, 'failed');
});
test('training recovery requires confirmation for the unchanged job and current project', async () => {
  for (const scenario of ['confirm', 'cancel', 'project-switch', 'new-attempt']) {
    const queue = Queue.enqueuePlan(Queue.emptyDistributedQueue(), { projectId: 'project', planFile: 'plans/train.yaml', revision: 'rev',
      executionMode: 'train', codeFingerprint: 'code', jobs: [{ index: 0, case: 'case', seed: 42, outputDir: 'work/job/attempts/run' }] }, 'run');
    const job = queue.plans[0].jobs[0];
    Object.assign(job, { status: 'failed', workerId: 'worker', commandId: 'command', runKey: 'command', actualExecutionMode: 'train_test',
      error: 'Validation-only tuning cannot access test patients' });
    const owner = host(queue); let current = true, confirmations = 0;
    const task = { projectId: 'project', workflowId: 'run', planFile: 'plans/train.yaml', planRevision: 'rev', codeFingerprint: 'code',
      planJobCount: 1, experimentIndex: 0, case: job.case, seed: job.seed, attempt: job.attempt, outputDir: job.outputDir,
      commandId: job.commandId, runKey: job.runKey, workerId: job.workerId, status: 'failed', finishedAt: 'done', error: job.error };
    owner.captureProjectContext = () => ({}); owner.projectContextIsCurrent = () => current;
    owner.saveDistributedQueue = async (_, __, options) => { owner.queue = options.mutateLatest(owner.queue); };
    owner.client.getWorkerTasks = async () => ({ tasks: [task] });
    owner.client.postWorkerAction = async (_, __, request) => {
      assert.equal(request.recoverTrainingOnly, true); assert.equal(request.targetCommandId, 'command');
      if (request.confirm) { confirmations++; return { recovered: true, trainingRecovery: { metricSplit: 'val' } }; }
      return { preview: true, evidenceSignature: 'verified' };
    };
    const retry = method('async retryDistributedJobFromUi(', 'async recallPlanToLocalQueueFromUi(', {
      vscode: { window: { showWarningMessage: async () => {
        assert.equal(confirmations, 0);
        if (scenario === 'project-switch') current = false;
        if (scenario === 'new-attempt') owner.queue = JSON.parse(JSON.stringify(owner.queue)), owner.queue.plans[0].jobs[0].attempt++;
        return scenario === 'cancel' ? undefined : '恢复训练完成';
      } } },
    }).retryDistributedJobFromUi;
    const outcome = await retry.call(owner, { planId: 'run', jobIndex: 0 });
    assert.equal(confirmations, scenario === 'confirm' ? 1 : 0);
    assert.equal(owner.queue.plans[0].jobs[0].status, scenario === 'confirm' ? 'completed' : 'failed');
    assert.equal(outcome.status, scenario === 'confirm' ? 'completed' : 'cancelled');
    assert.match(outcome.message, scenario === 'confirm' ? /已核验并恢复训练完成/ : /已取消/);
  }
});
test('isolated Worker modes and reviewed training recovery reject unsafe evidence', () => {
  const proc = spawnSync('python', ['-B', '-X', 'utf8', path.join(__dirname, 'distributedPlanExecutionMode.fixture.py')],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  assert.deepEqual(JSON.parse(proc.stdout), { modes: ['train', 'test', 'train_test'], recovery: 'verified', rejected: 14 });
});
