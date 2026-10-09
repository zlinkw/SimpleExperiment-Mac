const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = 'C:/project';
const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/legacy.ts'), 'utf8');
const original = require.extensions['.ts'];
require.extensions['.ts'] = (loaded, filename) => loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const queueApi = require('../../src/features/DistributedPlanQueue.ts');
require.extensions['.ts'] = original;

function provider(names, extra = {}) {
  const ast = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'RealtimeTunnelPanelProvider');
  const code = 'class Provider {' + cls.members.filter((node) => names.includes(node.name?.getText(ast))).map((node) => node.getText(ast)).join('\n') + '}; Provider;';
  return vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { DistributedPlanQueue: queueApi, workspaceRoot: () => root, makeOpId: (kind) => `${kind}-12345678`,
      errorMessage: (error) => error.message, vscode: { window: { showInformationMessage: () => undefined } }, ...extra });
}
function snapshot(plan, job, status = 'queued', aliases = false, extra = {}) {
  const now = new Date().toISOString();
  return { workerId: job.workerId, generatedAt: now, fetchedAt: now,
    capabilities: { durablePlanQueue: true, queuedJobRecall: true, schemaVersion: 1 }, tasks: [{
      ...(aliases ? { commandId: job.commandId, planId: plan.id, plan: plan.planFile, caseName: job.case }
        : { projectId: plan.projectId, workflowId: plan.id, planFile: plan.planFile, planRevision: plan.revision,
          codeFingerprint: plan.codeFingerprint, planJobCount: plan.planJobCount, experimentIndex: job.index,
          runKey: job.runKey || job.commandId, case: job.case }),
      seed: job.seed, attempt: job.attempt, outputDir: job.outputDir, workerId: job.workerId,
      commandId: job.commandId, gpuId: job.gpuId, status, ...extra,
    }] };
}
function releaseReceipt(request, legacy = false) {
  return { ...request, status: 'cancelled', stopReason: 'requeue', durableReleased: true,
    durableAccepted: !legacy, legacyReleased: legacy, neverStarted: true,
    neverStartedEvidence: legacy ? 'worker_command_queued' : 'durable_queued_row' };
}
function providerState(stored) {
  const Provider = provider(['recallPlanToLocalQueueFromUi', 'processDistributedRecall']);
  const instance = new Provider();
  instance.distributedQueueGeneration = 0;
  instance.distributedRecallInFlight = new Set();
  instance.distributedQueueTickPromise = undefined;
  instance.distributedTickAbort = undefined;
  instance.detachStaleDistributedTick = () => undefined;
  instance.postState = () => undefined;
  instance.tickDistributedQueue = async () => undefined;
  instance.loadDistributedQueue = async () => structuredClone(stored.value);
  instance.saveDistributedQueue = async (_root, next) => { stored.value = structuredClone(next); };
  instance.withRemoteActionResource = async (_worker, _action, _request, action) => action();
  return instance;
}

test('lost release ACK retains durable intent and restart replays the same operation id', async () => {
  const stamp = new Date().toISOString();
  let queue = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), { projectId: queueApi.canonicalProjectId(root),
    schedulingMode: 'server_prequeue', planFile: 'plans/recall.yaml', revision: 'r1', codeFingerprint: 'f1',
    jobs: [0, 1].map((index) => ({ index, case: `case-${index}`, seed: 40 + index,
      outputDir: `runs/${index}/attempts/old-run` })) }, 'plan-recall', stamp);
  const plan = queue.plans[0];
  const [queued, running] = plan.jobs;
  Object.assign(queued, { status: 'queued', workerId: 'worker-a', commandId: 'target-command-0001', runKey: 'target-command-0001', gpuId: '' });
  Object.assign(running, { status: 'running', workerId: 'worker-a', commandId: 'running-command-0002', runKey: 'running-command-0002', gpuId: '0' });
  const stored = { value: queue };
  const p = providerState(stored);
  p.tickDistributedQueue = async () => p.processDistributedRecall(root, plan.id, queued.index, p.distributedQueueGeneration);
  let calls = [];
  p.readWorkerTaskSnapshot = async () => snapshot(plan, queued);
  p.client = { postWorkerAction: async (_worker, _action, request) => { calls.push(request); throw new Error('lost ACK'); } };
  await p.recallPlanToLocalQueueFromUi({ planId: plan.id, planFile: plan.planFile });
  let persisted = stored.value.plans[0];
  const operationId = persisted.jobs[0].recallOperationId;
  assert.ok(operationId);
  assert.equal(persisted.schedulingMode, 'local_idle');
  assert.equal(persisted.localDispatchOverride, true);
  assert.equal(persisted.jobs[0].status, 'unknown');
  assert.equal(persisted.jobs[0].recallRequested, true);
  assert.equal(persisted.jobs[0].workerId, 'worker-a');
  assert.equal(persisted.jobs[1].status, 'running');
  assert.equal(calls.length, 1);

  const pRestart = providerState(stored);
  pRestart.distributedQueueGeneration = p.distributedQueueGeneration;
  pRestart.readWorkerTaskSnapshot = async () => snapshot(plan, queued);
  pRestart.client = { postWorkerAction: async (_worker, _action, request) => {
    calls.push(request);
    return releaseReceipt({ ...request, targetCommandId: queued.commandId });
  } };
  await pRestart.processDistributedRecall(root, plan.id, queued.index, pRestart.distributedQueueGeneration);
  persisted = stored.value.plans[0];
  assert.equal(calls[1].opId, operationId, 'the restart must replay the saved operation id');
  assert.equal(persisted.jobs[0].status, 'pending');
  assert.equal(persisted.jobs[0].attempt, 2);
  assert.equal(persisted.jobs[0].outputDir, 'runs/0/attempts/distributed-attempt-12345678');
  assert.equal(persisted.jobs[0].workerId, undefined);
  assert.equal(persisted.jobs[1].status, 'running');
});

test('a projectless all-legacy queue recalls one job while a running legacy sibling remains reconcilable to completion', async () => {
  const plan = { id: 'old-plan-id', planFile: 'plans/old.yaml', revision: 'legacy-r', codeFingerprint: 'legacy-f',
    enqueuedAt: new Date().toISOString(), schedulingMode: 'server_prequeue', jobs: [{ index: 4, case: 'old-case', seed: 8,
      outputDir: 'runs/historical', attempt: 1, status: 'queued', workerId: 'worker-old', commandId: 'old-command-1234', runKey: 'old-command-1234' },
    { index: 5, case: 'still-running', seed: 9, outputDir: 'runs/legacy-running', attempt: 1, status: 'running',
      workerId: 'worker-old', commandId: 'old-running-5678', runKey: 'old-running-5678', gpuId: '0' }] };
  const job = plan.jobs[0];
  const sibling = plan.jobs[1];
  const stored = { value: { schemaVersion: 1, plans: [plan] } };
  const p = providerState(stored);
  const calls = [];
  p.readWorkerTaskSnapshot = async () => snapshot(plan, job, 'queued', true);
  p.client = { postWorkerAction: async (_worker, _action, request) => {
    calls.push(request);
    return releaseReceipt({ ...request, targetCommandId: job.commandId }, true);
  } };
  await p.recallPlanToLocalQueueFromUi({ planId: plan.id, planFile: plan.planFile, jobIndex: job.index });
  const current = stored.value.plans[0];
  assert.equal(calls.length, 1);
  assert.equal(current.schedulingMode, 'server_prequeue', 'single-job recall keeps unrelated hosted policy');
  assert.equal(current.localDispatchOverride, undefined);
  assert.ok(current.projectId, 'released historical Plan enters the current durable queue');
  assert.equal(current.jobs[0].status, 'pending');
  assert.equal(current.jobs[0].localQueueOnly, true);
  assert.equal(current.jobs[0].outputDir, 'runs/historical/attempts/distributed-attempt-12345678');
  assert.equal(current.jobs[1].status, 'running');
  assert.equal(queueApi.hasLegacyOwnership(current.jobs[1]), true,
    'the promoted Plan must preserve the old worker identity as an assigned legacy job');
  const completedLegacyReceipt = { commandId: sibling.commandId, workerId: sibling.workerId, planId: plan.id,
    plan: plan.planFile, caseName: sibling.case, status: 'completed' };
  assert.equal(queueApi.historicalRecallTaskMatchesJob(current, current.jobs[1], completedLegacyReceipt), true,
    'a later legacy completion must still match the untouched historical identity');
  const fresh = new Date().toISOString();
  const recovered = queueApi.mergeDurableWorkerSnapshots(stored.value, [{ workerId: sibling.workerId,
    generatedAt: fresh, fetchedAt: fresh, capabilities: { durablePlanQueue: true, schemaVersion: 1 },
    tasks: [completedLegacyReceipt] }], current.projectId);
  assert.equal(recovered.plans[0].jobs[1].status, 'completed', 'the server projection updates a promoted legacy sibling immediately');
  const stale = new Date(Date.now() - 6000).toISOString();
  const staleProjection = queueApi.mergeDurableWorkerSnapshots(stored.value, [{ workerId: sibling.workerId,
    generatedAt: stale, fetchedAt: stale, capabilities: { durablePlanQueue: true, schemaVersion: 1 },
    tasks: [completedLegacyReceipt] }], current.projectId, Date.now(), 5000);
  assert.equal(staleProjection.plans[0].jobs[1].status, 'unknown', 'expired historical evidence cannot preserve a running display');
  assert.match(source, /filter\(\(\{ plan, job \}\) => !plan\.projectId \|\| DistributedPlanQueue\.hasLegacyOwnership\(job\)\)/,
    'the tick reconciler must continue polling legacy-owned jobs after Plan promotion');
});

test('restart reconciles a persisted cancelled requeue tombstone only with its complete never-started proof', async () => {
  const stamp = new Date().toISOString();
  const queue = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), { projectId: queueApi.canonicalProjectId(root),
    schedulingMode: 'local_idle', localDispatchOverride: true, planFile: 'plans/tombstone.yaml', revision: 'r1',
    codeFingerprint: 'f1', jobs: [{ index: 0, case: 'case', seed: 3, outputDir: 'runs/case/attempts/old' }] },
  'tombstone-plan', stamp);
  const plan = queue.plans[0];
  const job = plan.jobs[0];
  Object.assign(job, { status: 'unknown', workerId: 'worker-a', commandId: 'target-command-tombstone',
    runKey: 'target-command-tombstone', recallRequested: true, recallOperationId: 'saved-operation-1234', reassignmentPending: true });
  const stored = { value: queue };
  const p = providerState(stored);
  const tombstone = releaseReceipt({ projectId: plan.projectId, workflowId: plan.id, planFile: plan.planFile,
    planRevision: plan.revision, codeFingerprint: plan.codeFingerprint, planJobCount: plan.planJobCount,
    experimentIndex: job.index, case: job.case, seed: job.seed, attempt: job.attempt, outputDir: job.outputDir,
    workerId: job.workerId, gpuId: job.gpuId, runKey: job.runKey, commandId: job.commandId,
    targetCommandId: job.commandId, opId: job.recallOperationId });
  p.readWorkerTaskSnapshot = async () => snapshot(plan, job, 'cancelled', false, tombstone);
  let rpcCalls = 0;
  p.client = { postWorkerAction: async () => { rpcCalls++; throw new Error('tombstone should settle locally'); } };
  await p.processDistributedRecall(root, plan.id, job.index, 0);
  const released = stored.value.plans[0].jobs[0];
  assert.equal(rpcCalls, 0);
  assert.equal(released.status, 'pending');
  assert.equal(released.attempt, 2);
  assert.equal(released.recallRequested, undefined);
});

test('a partial historical requeue snapshot replays the saved operation to obtain the full proof', async () => {
  const plan = { id: 'legacy-replay', planFile: 'plans/old.yaml', revision: 'rev-old', codeFingerprint: 'old-f',
    jobs: [{ index: 0, case: 'old', seed: 42, attempt: 1, outputDir: 'runs/old', status: 'unknown',
      workerId: 'worker-old', gpuId: '0', commandId: 'legacy-replay-command', recallRequested: true,
      recallOperationId: 'persisted-recall-1234', reassignmentPending: true }] };
  const job = plan.jobs[0];
  const stored = { value: { schemaVersion: 1, plans: [plan] } };
  const p = providerState(stored);
  p.readWorkerTaskSnapshot = async () => snapshot(plan, job, 'cancelled', true, { stopReason: 'requeue' });
  let calls = 0;
  p.client = { postWorkerAction: async (_worker, _action, request) => {
    calls++;
    assert.equal(request.operationId, 'persisted-recall-1234');
    return { workflowId: plan.id, planFile: plan.planFile, planRevision: plan.revision,
      case: job.case, seed: job.seed, attempt: job.attempt, outputDir: job.outputDir,
      workerId: job.workerId, gpuId: job.gpuId, commandId: job.commandId, targetCommandId: job.commandId,
      status: 'cancelled', stopReason: 'requeue', durableReleased: true, legacyReleased: true,
      neverStarted: true, neverStartedEvidence: 'worker_task_queued' };
  } };
  await p.processDistributedRecall(root, plan.id, job.index, 0);
  assert.equal(calls, 1);
  assert.equal(stored.value.plans[0].jobs[0].status, 'pending');
  assert.equal(stored.value.plans[0].jobs[0].attempt, 2);
});

test('historical pending receipts can be recalled through the Agent queued-only release', async () => {
  const plan = { id: 'legacy-pending', planFile: 'plans/pending.yaml', revision: 'rev-old', codeFingerprint: 'old-f',
    jobs: [{ index: 0, case: 'old', seed: 42, attempt: 1, outputDir: 'runs/pending', status: 'queued',
      workerId: 'worker-old', gpuId: '0', commandId: 'legacy-pending-command' }] };
  const job = plan.jobs[0];
  const stored = { value: { schemaVersion: 1, plans: [plan] } };
  const p = providerState(stored);
  p.readWorkerTaskSnapshot = async () => snapshot(plan, job, 'pending', true);
  let calls = 0;
  p.client = { postWorkerAction: async (_worker, _action, request) => {
    calls++;
    return { ...releaseReceipt(request, true), neverStartedEvidence: 'worker_task_pending' };
  } };
  await p.recallPlanToLocalQueueFromUi({ planId: plan.id, planFile: plan.planFile, jobIndex: job.index });
  assert.equal(calls, 1, 'historical pending must reach the queued-only Agent recall');
  assert.equal(stored.value.plans[0].jobs[0].status, 'pending');
  assert.equal(stored.value.plans[0].jobs[0].attempt, 2);
});
