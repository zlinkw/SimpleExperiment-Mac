require('../_helpers/registerTsRequire');
const test = require('node:test'), assert = require('node:assert/strict');
const { preparePlanSafeRetry } = require('../../src/features/PlanSafeRetry.ts');
const Queue = require('../../src/features/DistributedPlanQueue.ts');
const planFile = 'experiments/plans/one.yaml';
function fixture(status = 'running') {
  const job = { index: 0, case: 'case-a', seed: 1, attempt: 1, status, workerId: 'worker-a', commandId: 'command-old',
    outputDir: 'work_dirs/one/attempts/run-old', gpuId: '0' };
  const plan = { id: 'run-old', planFile, revision: 'r', codeFingerprint: 'fp', enqueuedAt: '2026-01-01', jobs: [job] };
  let queue = { schemaVersion: 1, plans: [plan, { ...plan, id: 'other-run', planFile: 'experiments/plans/other.yaml', jobs: [{ ...job, commandId: 'other-command' }] }] };
  let remoteStatus = status, stops = 0, modal = 0, sameProject = true;
  const host = {
    captureProjectContext: () => ({ root: 'C:/project' }), projectContextIsCurrent: () => sameProject,
    reconcileStalePlanRunOperations: async () => {}, longRunningPlanRunOperations: () => [],
    loadDistributedQueue: async () => Queue.cloneDistributedQueue(queue),
    saveDistributedQueue: async (_root, _q, options) => { queue = options.mutateLatest(queue); },
    client: { getWorkerTasks: async () => ({ tasks: [{ ...job, workflowId: plan.id, planFile, planRevision: 'r', status: remoteStatus, experimentIndex: 0 }] }) },
    distributedLaunchInFlight: new Set(), distributedQueueGeneration: 1, detachStaleDistributedTick() {},
    boundedPromise: work => work(), postState() {},
    stopDistributedJobForClear: async (p, j) => { assert.equal(p.id, 'run-old'); assert.equal(j.commandId, 'command-old'); stops++; remoteStatus = 'cancelled'; },
  };
  const run = (yes = true) => preparePlanSafeRetry(host, planFile, async () => { modal++; return yes; }, () => Error('user cancelled'));
  return { host, run, get queue() { return queue; }, get stops() { return stops; }, get modal() { return modal; },
    setRemote: status => { remoteStatus = status; }, switchProject: () => { sameProject = false; } };
}

test('failed/cancelled history never blocks or needs stop confirmation', async () => {
  for (const status of ['failed', 'cancelled', 'completed']) {
    const f = fixture(status); await f.run(); assert.equal(f.modal, 0); assert.equal(f.stops, 0);
    assert.equal(f.queue.plans[0].jobs[0].outputDir, 'work_dirs/one/attempts/run-old');
  }
});
test('complete local terminal receipts remain rerunnable when a partial snapshot leaves an old missing count', async () => {
  const f = fixture('completed');
  const plan = f.queue.plans[0];
  plan.planJobCount = 6; plan.remoteAcceptedJobCount = 3; plan.recoveryMissingCount = 3;
  plan.jobs = Array.from({ length: 6 }, (_, index) => ({ ...plan.jobs[0], index, seed: 42 + index,
    commandId: `complete-${index}`, trustedTerminalStatus: 'completed' }));
  assert.equal(await f.run(), false);
  assert.equal(f.modal, 0); assert.equal(f.stops, 0);
  assert.equal(f.queue.plans[1].jobs[0].status, 'completed');
  f.queue.plans[1].jobs[0].status = 'running';
  assert.equal(await f.run(), false, 'another Plan is allowed to keep running while this Plan proceeds to submission');
  assert.equal(f.queue.plans[1].jobs[0].status, 'running');
});

test('partial or contradictory recovery still blocks even when some historical jobs finished', async () => {
  for (const variant of ['partial', 'duplicate-index', 'missing-identity', 'unknown-job', 'conflict', 'unknown-count', 'missing-attempt', 'older-terminal', 'terminal-disagreement']) {
    const f = fixture('completed'), plan = f.queue.plans[0];
    plan.planJobCount = 6; plan.recoveryMissingCount = 3;
    plan.jobs = Array.from({ length: 6 }, (_, index) => ({ ...plan.jobs[0], index, commandId: `complete-${index}` }));
    if (variant === 'partial') plan.jobs.splice(3);
    if (variant === 'duplicate-index') plan.jobs[5].index = 4;
    if (variant === 'missing-identity') delete plan.jobs[5].commandId;
    if (variant === 'unknown-job') plan.jobs[5].status = 'unknown';
    if (variant === 'conflict') plan.jobs[5].recoveryConflict = true;
    if (variant === 'unknown-count') delete plan.planJobCount;
    if (variant === 'missing-attempt') delete plan.jobs[5].attempt;
    if (variant === 'older-terminal') plan.jobs.push({ ...plan.jobs[5], attempt: 2, status: 'unknown', commandId: 'newer-unverified' });
    if (variant === 'terminal-disagreement') plan.jobs[5].trustedTerminalStatus = 'failed';
    await assert.rejects(f.run(), /未核实/);
    assert.equal(f.modal, 0); assert.equal(f.stops, 0);
  }
});
test('active same Plan needs one confirmation, exact stop receipt then permits submission; history stays', async () => {
  const f = fixture(); await f.run(); assert.equal(f.modal, 1); assert.equal(f.stops, 1);
  assert.equal(f.queue.plans.length, 2); assert.equal(f.queue.plans[0].jobs[0].status, 'cancelled');
  assert.equal(f.queue.plans[1].jobs[0].status, 'running'); assert.equal(f.host.distributedPlanStopEpoch, 0);
});
test('declining stop leaves old job running', async () => {
  const f = fixture(); await assert.rejects(f.run(false), /user cancelled/);
  assert.equal(f.stops, 0); assert.equal(f.queue.plans[0].jobs[0].status, 'running');
});
test('stale running row with exact remote failure/completion reconciles without modal', async () => {
  for (const status of ['failed', 'completed']) {
    const f = fixture(); f.setRemote(status); await f.run();
    assert.equal(f.modal, 0); assert.equal(f.stops, 0); assert.equal(f.queue.plans[0].jobs[0].status, status);
  }
});
test('unknown remote, missing identity or failed stop cannot reach submission', async () => {
  for (const failure of ['network', 'missing', 'stop']) {
    const f = fixture();
    if (failure === 'network') f.host.client.getWorkerTasks = async () => { throw Error('offline'); };
    if (failure === 'missing') f.host.client.getWorkerTasks = async () => ({ tasks: [] });
    if (failure === 'stop') f.host.stopDistributedJobForClear = async () => { throw Error('no receipt'); };
    await assert.rejects(f.run()); assert.equal(f.queue.plans[0].jobs[0].status, 'running');
  }
});
test('unassigned pending jobs stop locally; in-flight launches and project switches remain protected', async () => {
  const f = fixture('pending'); delete f.queue.plans[0].jobs[0].workerId; delete f.queue.plans[0].jobs[0].commandId;
  await f.run(); assert.equal(f.stops, 0); assert.equal(f.queue.plans[0].jobs[0].status, 'cancelled');
  const g = fixture(); g.host.distributedLaunchInFlight.add('run-old\0' + '0\0' + '1');
  await assert.rejects(g.run(), /启动回执/); assert.equal(g.stops, 0);
  const h = fixture(); h.host.stopDistributedJobForClear = async () => h.switchProject();
  await assert.rejects(h.run(), /项目已切换/); assert.equal(h.queue.plans[0].jobs[0].status, 'running');
});

test('scheduler stop must confirm exact operation and absence of active evidence', async () => {
  const f = fixture('completed');
  const row = { operationId: 'scheduler-old', planFile, status: 'running', reconcileEvidenceActive: true };
  f.host.longRunningPlanRunOperations = () => [row]; f.host.runOperationWorkerId = () => 'worker-a';
  f.host.stopExperimentRouted = async request => {
    assert.equal(request.operationId, 'scheduler-old');
    return { ok: false, matchedOperations: ['scheduler-old'], remainingActiveEvidence: ['live task'] };
  };
  await assert.rejects(f.run(), /未确认停止/); assert.equal(f.modal, 1);
});

test('fresh reconciliation replaces an old outcomePending marker; unverified network failures still block', async () => {
  const f = fixture('completed');
  const row = { operationId: 'scheduler-old', planFile, status: 'running', outcomePending: true, reconcileEvidenceActive: true };
  f.host.longRunningPlanRunOperations = () => [row];
  await assert.rejects(f.run(), /状态尚未确认/); assert.equal(f.modal, 0);
  f.host.reconcileStalePlanRunOperations = async () => ({ checked: ['scheduler-old'] });
  f.host.runOperationWorkerId = () => 'worker-a';
  f.host.stopExperimentRouted = async () => ({ ok: true, matchedOperations: ['scheduler-old'], remainingActiveEvidence: [] });
  await f.run(); assert.equal(f.modal, 1);
});

test('a new same-Plan run appearing during stop is never stopped or silently replaced', async () => {
  const f = fixture();
  f.host.stopDistributedJobForClear = async () => {
    f.queue.plans.push({ ...f.queue.plans[0], id: 'new-foreign-run', jobs: [{ ...f.queue.plans[0].jobs[0], commandId: 'foreign-command' }] });
  };
  await assert.rejects(f.run(), /又出现未结束任务/);
  assert.equal(f.queue.plans.at(-1).jobs[0].status, 'running');
});

test('post-stop checks recognize exact exit receipts despite an obsolete recovery counter', async () => {
  const f = fixture();
  f.queue.plans[0].planJobCount = 1;
  const stop = f.host.stopDistributedJobForClear;
  f.host.stopDistributedJobForClear = async (plan, job) => {
    await stop(plan, job);
    f.queue.plans[0].recoveryMissingCount = 1;
  };
  assert.equal(await f.run(), true);
  assert.equal(f.modal, 1); assert.equal(f.stops, 1);
  assert.equal(f.queue.plans[0].jobs[0].status, 'cancelled');
  assert.equal(f.queue.plans[1].jobs[0].status, 'running');
});
