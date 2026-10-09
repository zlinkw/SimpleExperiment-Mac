const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const original = require.extensions['.ts'];
require.extensions['.ts'] = (loaded, filename) => loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const queueApi = require('../../src/features/DistributedPlanQueue.ts');
const policy = require('../../src/features/DistributedSchedulingPolicy.ts');
require.extensions['.ts'] = original;

const now = Date.now();
const stamp = new Date(now).toISOString();
function hostedPlan(count = 2) {
  const enqueued = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {
    projectId: 'project', schedulingMode: 'server_prequeue', planFile: 'plans/queue.yaml', revision: 'rev-1',
    codeFingerprint: 'fingerprint', jobs: Array.from({ length: count }, (_, index) => ({ index, case: `case-${index}`, seed: 20 + index, outputDir: `runs/${index}` })),
  }, 'workflow-1', stamp);
  return policy.allocateServerPrequeue(enqueued, [{ workerId: 'worker-a', online: true, weight: 2, codeFingerprint: 'fingerprint' }]).queue;
}
function exact(plan, job, overrides = {}) {
  return { projectId: plan.projectId, workflowId: plan.id, planFile: plan.planFile, planRevision: plan.revision, enqueuedAt: plan.enqueuedAt,
    codeFingerprint: plan.codeFingerprint, planJobCount: plan.planJobCount, experimentIndex: job.index,
    case: job.case, seed: job.seed, attempt: job.attempt, outputDir: job.outputDir,
    workerId: job.workerId, gpuId: job.gpuId, commandId: job.commandId, targetCommandId: job.commandId, runKey: job.runKey || job.commandId,
    status: 'cancelled', stopReason: 'requeue', durableAccepted: true, durableReleased: true,
    neverStarted: true, neverStartedEvidence: 'durable_queued_row', ...overrides };
}

test('a recalled hosted job stays out of server assignment and can enter local idle dispatch by itself', () => {
  let queue = hostedPlan();
  const plan = queue.plans[0];
  const selected = plan.jobs[0];
  Object.assign(selected, { status: 'queued', localQueueOnly: true, recallRequested: true });
  plan.jobs[1].status = 'pending';
  const hosted = policy.allocateServerPrequeue(queue, [{ workerId: 'worker-b', online: true, weight: 1, codeFingerprint: 'fingerprint' }]);
  assert.equal(hosted.dispatches.length, 0);
  assert.equal(hosted.queue.plans[0].jobs[1].status, 'pending');
  selected.recallRequested = false;
  Object.assign(selected, { status: 'pending', workerId: undefined, gpuId: undefined, commandId: undefined, runKey: undefined });
  const local = queueApi.allocateAvailable(queue, [{ workerId: 'worker-local', online: true, idleGpuIds: ['0'], codeFingerprint: 'fingerprint', idleGpuAdmission: true }],
    { requireIdleGpuAdmission: true, localIdleOnly: true });
  assert.deepEqual(local.dispatches.map((row) => row.jobIndex), [0]);
  assert.equal(local.queue.plans[0].jobs[1].status, 'pending');
  const localPlan = local.queue.plans[0];
  const merged = queueApi.mergeDurableWorkerSnapshots(local.queue, [{ workerId: 'worker-local',
    generatedAt: stamp, fetchedAt: stamp, capabilities: { durablePlanQueue: true, schemaVersion: 1 },
    tasks: [exact(localPlan, localPlan.jobs[0], { status: 'queued', schedulingMode: 'local_idle' })] }], 'project', now);
  assert.equal(merged.plans[0].schedulingMode, 'server_prequeue',
    'one recalled local job must not overwrite the unrelated hosted Plan policy');
});

test('hosted retries ignore recalls and local-only jobs while pinned local attempts keep their idle-GPU retry path', () => {
  const queue = hostedPlan(3);
  const plan = queue.plans[0];
  const [ordinary, recalled, localOnly] = plan.jobs;
  Object.assign(ordinary, { status: 'unknown' });
  Object.assign(recalled, { status: 'unknown', recallRequested: true });
  Object.assign(localOnly, { status: 'unknown', localQueueOnly: true, gpuId: '0' });
  assert.equal(queueApi.hostedRetryCandidates(plan).length, 1);
  assert.equal(queueApi.hostedRetryCandidates(plan)[0], ordinary);
  assert.equal(queueApi.pinnedRetryPlanAllowed(plan), true);
  const retry = queueApi.retryPinnedDispatch(queue, plan.id, localOnly.index, {
    workerId: localOnly.workerId, generatedAt: stamp, fetchedAt: stamp,
    capabilities: { durablePlanQueue: true, idleGpuAdmission: true, schemaVersion: 1 }, tasks: [],
  }, [localOnly.gpuId], now);
  assert.ok(retry, 'the local-only job retains its original pinned GPU retry');
});

test('server recovery preserves local Plan and job recall intent across restart-shaped merges', () => {
  const queue = hostedPlan();
  const plan = queue.plans[0];
  const job = plan.jobs[0];
  Object.assign(plan, { schedulingMode: 'local_idle', localDispatchOverride: true });
  Object.assign(job, { status: 'queued', localQueueOnly: true, recallRequested: true, recallOperationId: 'recall-op-12345678' });
  const snapshot = { workerId: job.workerId, generatedAt: stamp, fetchedAt: stamp,
    capabilities: { durablePlanQueue: true, queuedJobRecall: true, schemaVersion: 1 },
    tasks: [{ ...exact(plan, job, { status: 'queued', stopReason: undefined, durableAccepted: undefined, durableReleased: undefined }) }],
  };
  const merged = queueApi.mergeDurableWorkerSnapshots(queue, [snapshot], 'project', now).plans[0];
  assert.equal(merged.schedulingMode, 'local_idle');
  assert.equal(merged.localDispatchOverride, true);
  assert.equal(merged.jobs[0].localQueueOnly, true);
  assert.equal(merged.jobs[0].recallRequested, true);
  assert.equal(merged.jobs[0].recallOperationId, 'recall-op-12345678');
});

test('only an exact release proof creates a fresh attempt and historical output paths gain an attempts segment', () => {
  const queue = hostedPlan();
  const plan = queue.plans[0];
  const job = plan.jobs[0];
  Object.assign(job, { status: 'unknown', localQueueOnly: true, recallRequested: true, reassignmentPending: true });
  const proof = exact(plan, job);
  for (const key of ['projectId', 'codeFingerprint', 'experimentIndex', 'runKey']) {
    assert.equal(queueApi.isExactQueuedReleaseProof(plan, job, { ...proof, [key]: undefined }), false,
      'modern durable proof must carry its complete identity: ' + key);
  }
  assert.throws(() => queueApi.releaseQueuedForReassignment(queue, plan.id, job.index,
    { ...proof, workerId: 'other-worker' }, 'attempt-next-1234'));
  const released = queueApi.releaseQueuedForReassignment(queue, plan.id, job.index, proof, 'attempt-next-1234');
  const next = released.plans[0].jobs[0];
  assert.equal(next.status, 'pending');
  assert.equal(next.attempt, job.attempt + 1);
  assert.equal(next.outputDir, `${job.outputDir}/attempts/attempt-next-1234`);
  assert.equal(next.workerId, undefined);
  assert.equal(next.commandId, undefined);
  assert.equal(next.localQueueOnly, true);
  assert.equal(next.recallRequested, undefined);
  assert.equal(next.history.at(-1).commandId, job.commandId);
  assert.throws(() => queueApi.nextAttemptOutputDir('D:/runs/old-output', 'attempt-next-5678'));
  assert.throws(() => queueApi.nextAttemptOutputDir('/home/user/runs/old-output', 'attempt-next-5678'));
  assert.throws(() => queueApi.nextAttemptOutputDir('..\\outside\\old-output', 'attempt-next-5678'));
});

test('legacy release proof accepts historical aliases only when the target, plan, and worker match', () => {
  const plan = { id: 'legacy-workflow', planFile: 'plans/old.yaml', revision: 'old-rev', codeFingerprint: 'f',
    schedulingMode: 'server_prequeue', jobs: [{ index: 3, case: 'case-old', seed: 9, attempt: 1,
      outputDir: 'runs/old-output', status: 'queued', workerId: 'worker-a', commandId: 'legacy-command' }] };
  const job = plan.jobs[0];
  job.reassignmentPending = true;
  const proof = { legacyReleased: true, durableReleased: true, neverStarted: true,
    neverStartedEvidence: 'worker_command_queued', status: 'cancelled', stopReason: 'requeue', targetCommandId: job.commandId,
    planId: plan.id, workflowId: plan.id, plan: plan.planFile, planFile: plan.planFile, planRevision: plan.revision,
    codeFingerprint: plan.codeFingerprint, planJobCount: plan.jobs.length, experimentIndex: job.index,
    runKey: job.commandId, caseName: job.case, seed: job.seed, attempt: job.attempt, outputDir: job.outputDir, workerId: job.workerId };
  assert.equal(queueApi.isExactQueuedReleaseProof(plan, job, proof), true);
  const historicalProof = { ...proof };
  for (const key of ['codeFingerprint', 'planJobCount', 'experimentIndex', 'runKey']) delete historicalProof[key];
  assert.equal(queueApi.isExactQueuedReleaseProof(plan, job, historicalProof), true,
    'actual historical Agent receipt may lack modern metadata');
  assert.equal(queueApi.isExactQueuedReleaseProof(plan, job, { ...historicalProof, planRevision: undefined }), false);
  assert.equal(queueApi.isExactQueuedReleaseProof(plan, job, { ...historicalProof, experimentIndex: job.index + 1 }), false);
  assert.equal(queueApi.isExactQueuedReleaseProof(plan, job, { ...proof, planId: 'other-workflow' }), false);
  const released = queueApi.releaseQueuedForReassignment({ schemaVersion: 1, plans: [plan] }, plan.id, job.index,
    proof, 'attempt-legacy-1234');
  assert.equal(released.plans[0].jobs[0].outputDir, 'runs/old-output/attempts/attempt-legacy-1234');
});
