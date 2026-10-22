const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const original = require.extensions['.ts'];
require.extensions['.ts'] = (loaded, filename) => loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const Queue = require('../../src/features/DistributedPlanQueue.ts');
const Policy = require('../../src/features/DistributedSchedulingPolicy.ts');
const Ownership = require('../../src/features/GpuJobOwnership.ts');
const Modes = require('../../src/features/PlanExecutionMode.ts');
require.extensions['.ts'] = original;
const source = fs.readFileSync(path.join(root, 'src/extension/legacy.ts'), 'utf8');
const ast = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'RealtimeTunnelPanelProvider');
const tick = cls.members.find(node => node.name?.getText(ast) === 'tickDistributedQueueCore').getText(ast);
const code = ts.transpileModule('class Provider {' + tick + '}; Provider;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const projectId = Queue.canonicalProjectId(root);
let agentReceipt;

test('real Scheduler conflict travels through Agent action, durable audit, snapshot and duplicate admission without GPU work', () => {
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8',
    path.join(__dirname, 'preflightDispatchRejection.fixture.py'), projectId],
    { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const report = JSON.parse(proc.stdout.trim());
  assert.equal(report.ok, true);
  agentReceipt = report.receipt;
});

function fixture(initial = true, compatibility = true) {
  const Provider = vm.runInNewContext(code, { DistributedPlanQueue: Queue, DistributedSchedulingPolicy: Policy,
    GpuQuotaScheduling: require('../../dist/features/GpuQuotaScheduling'),
    PlanCodeScopeHost: require('../../dist/extension/PlanCodeScopeHost'),
    GpuJobOwnership: Ownership, PlanExecutionMode: Modes, workspaceRoot: () => root,
    mapLimited: async (rows, _limit, fn) => Promise.all(rows.map(fn)), errorMessage: error => error.message,
    makeOpId: () => 'generated-command', setInterval, clearInterval });
  const p = new Provider();
  Object.assign(p, { distributedQueueGeneration: 0, distributedPlanStopEpoch: 0, distributedLaunchInFlight: new Set(),
    distributedNextFailureDetailAt: Infinity, distributedNextPostprocessAt: Infinity, lastWorkerProbes: { worker: {
      status: 'ok', capabilities: { endpoints: { declaredJobPaths: true, formalJobIdentityEnv: 1, taskShellEnvironment: 1, projectManagedValidation: 1 } } } },
    lastCodeSyncState: { workerVersions: { worker: { fingerprint: agentReceipt.codeFingerprint } } } });
  p.isRealtimeMode = () => true;
  p.projectTopologyAssessment = () => ({ mode: 'worker_pool' });
  p.workerCodeSyncTargets = () => [];
  p.workerActionTargets = () => [{ id: 'worker' }];
  p.enabledWorkerConfigs = () => [{ id: 'worker' }];
  p.schedulerSettings = () => ({});
  p.gpuOwnerConfig = () => ({});
  p.recordActionError = () => {};
  p.postState = () => {};
  p.scheduleDistributedPostprocess = () => {};
  p.queuePlanArtifactSyncStatusCheck = () => {};
  p.buildDistributedJobCodeManifest = async () => ({});
  p.readWorkerTaskSnapshotBatch = async () => [{ workerId: 'worker', generatedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(),
    capabilities: { durablePlanQueue: true, idleGpuAdmission: true, schemaVersion: 1 }, tasks: [] }];
  p.client = { getGpu: async () => ({ worker: [0, 1].map(index => ({ index: String(index), utilizationPercent: 0,
    memoryTotalMb: 48 * 1024, memoryUsedMb: 7, processes: [] })) }) };
  let stored = Queue.enqueuePlan(Queue.emptyDistributedQueue(), { projectId, planFile: agentReceipt.planFile,
    revision: agentReceipt.planRevision, codeFingerprint: agentReceipt.codeFingerprint, executionMode: 'train_test',
    resultPathPolicy: 'declared', schedulingMode: 'local_idle', jobs: [42, 43].map((seed, index) => ({ index, case: 'case', seed,
      outputDir: agentReceipt.outputDir.replace('seed42', 'seed' + seed),
      collectionResultCsv: agentReceipt.collectionResultCsv.replace('seed42', 'seed' + seed) })) }, agentReceipt.workflowId);
  if(compatibility) stored.plans[0].jobs.forEach(job => { delete job.lifecycleProtocol; }); // This suite exercises persisted v1 durable receipts.
  // Persisted v1 receipts exercise the v1 reconciliation path; newly enqueued jobs retain protocol 2.
  if (!initial) stored.plans[0].jobs.forEach((job, index) => Object.assign(job, {
    status: 'unknown', workerId: 'worker', gpuId: String(index), commandId: index ? 'second-command' : agentReceipt.commandId,
    runKey: index ? 'second-command' : agentReceipt.commandId,
  }));
  const receipts = [];
  p.loadDistributedQueue = async () => Queue.restoreFormalJobQueue(JSON.parse(Queue.serializeDistributedQueue(stored)));
  p.saveDistributedQueue = async (_root, value) => { stored = JSON.parse(JSON.stringify(value)); };
  p.sendDistributedJob = async (plan, job, workerId, gpuId, commandId) => {
    const receipt = { ...agentReceipt, commandId, runKey: commandId, workerId, gpuId, experimentIndex: job.index,
      case: job.case, seed: job.seed, globalJobId: job.globalJobId, outputDir: job.outputDir, collectionResultCsv: job.collectionResultCsv };
    receipts.push(receipt);
    return receipt;
  };
  return { p, stored: () => stored, receipts };
}

test('initial Host dispatch resolves both rejections immediately and never resubmits them on later ticks', async () => {
  const { p, stored, receipts } = fixture();
  await p.tickDistributedQueueCore();
  assert.equal(receipts.length, 2);
  for (const job of stored().plans[0].jobs) {
    assert.equal(job.status, 'failed');
    assert.equal(job.admissionRejection.code, 'FORMAL_JOB_CONFLICT');
    assert.equal(job.trustedTerminalStatus, 'failed');
  }
  for (let i = 0; i < 3; i++) await p.tickDistributedQueueCore();
  assert.equal(receipts.length, 2);
  assert.equal(Queue.distributedSubmissionDisposition(stored().plans[0]).durableAccepted, false);
  const submission = Queue.distributedSubmissionProgress({ ...Queue.distributedSubmissionResult(stored().plans[0]), enqueued: true, localQueued: true });
  assert.equal(submission.status, 'failed');
  assert.equal(submission.waiting, false);
});

test('old unknown commands reconcile using the same identities and survive reload as failed without retries', async () => {
  const { p, stored, receipts } = fixture(false);
  await p.tickDistributedQueueCore();
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].commandId, agentReceipt.commandId);
  assert.ok(stored().plans[0].jobs.every(job => job.status === 'failed'));
  const reloaded = Queue.restoreFormalJobQueue(JSON.parse(Queue.serializeDistributedQueue(stored())));
  const merged = Queue.mergeDurableWorkerSnapshots(reloaded, [{ workerId: 'worker', generatedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(), capabilities: { durablePlanQueue: true, schemaVersion: 1 }, tasks: receipts }], projectId);
  assert.ok(merged.plans[0].jobs.every(job => job.status === 'failed' && job.admissionRejection));
  assert.equal(merged.plans[0].remoteAcceptedJobCount, 0);
  assert.equal(merged.plans[0].recoveryMissingCount, 0);
  await p.tickDistributedQueueCore();
  assert.equal(receipts.length, 2);
});

test('foreign or incomplete rejection evidence cannot turn uncertain ownership into a failure', () => {
  const { stored } = fixture(false);
  const queue = stored(), plan = queue.plans[0], job = plan.jobs[0];
  for (const change of [{ commandId: 'foreign' }, { workerId: 'foreign' }, { collectionResultCsv: 'tmp/result/other.csv' },
    { executionMode: 'train' }, { globalJobId: 'foreign:0' }, { neverStarted: false }, { neverStartedEvidence: undefined },
    { errorCode: undefined }, { finishedAt: undefined }]) {
    const receipt = { ...agentReceipt, ...change };
    assert.equal(Queue.applyPreflightRejectedDispatch(queue, plan, job, receipt), queue);
    const merged = Queue.mergeDurableWorkerSnapshots(queue, [{ workerId: 'worker', generatedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(), capabilities: { durablePlanQueue: true, schemaVersion: 1 }, tasks: [receipt] }], projectId);
    assert.equal(merged.plans[0].jobs[0].status, 'unknown');
  }
});

test('lost rejection response recovers from a fresh durable snapshot even when GPUs are now busy', async () => {
  const { p, stored } = fixture(false);
  const plan = stored().plans[0];
  const tasks = plan.jobs.map(job => ({ ...agentReceipt, commandId: job.commandId, runKey: job.runKey,
    gpuId: job.gpuId, experimentIndex: job.index, seed: job.seed, globalJobId: job.globalJobId,
    outputDir: job.outputDir, collectionResultCsv: job.collectionResultCsv }));
  p.readWorkerTaskSnapshotBatch = async () => [{ workerId: 'worker', generatedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(), capabilities: { durablePlanQueue: true, idleGpuAdmission: true, schemaVersion: 1 }, tasks }];
  p.client.getGpu = async () => ({ worker: [0, 1].map(index => ({ index: String(index), utilizationPercent: 99,
    memoryUsedMb: 20000, processes: [] })) });
  p.sendDistributedJob = () => { throw Error('snapshot recovery must not resend commands'); };
  await p.tickDistributedQueueCore();
  assert.ok(stored().plans[0].jobs.every(job => job.status === 'failed' && job.admissionRejection));
  assert.equal(stored().plans[0].jobs[0].commandId, agentReceipt.commandId);
});

test('plain HTTP failures stay unknown and busy GPU rejection remains local pending', async () => {
  for (const kind of ['http', 'busy']) {
    const { p, stored } = fixture();
    p.sendDistributedJob = async (plan, job, workerId, gpuId, commandId) => {
      if (kind === 'http') throw Error('Hub Agent HTTP 500: FORMAL_JOB_CONFLICT');
      return { ...agentReceipt, commandId, runKey: commandId, workerId, gpuId, experimentIndex: job.index, seed: job.seed,
        globalJobId: job.globalJobId, outputDir: job.outputDir, collectionResultCsv: job.collectionResultCsv,
        reason: 'gpu_busy', status: 'pending', neverStartedEvidence: undefined };
    };
    await p.tickDistributedQueueCore();
    assert.ok(stored().plans[0].jobs.every(job => job.status === (kind === 'http' ? 'unknown' : 'pending')));
    assert.ok(stored().plans[0].jobs.every(job => !job.admissionRejection));
  }
});

 test('native rejected-start evidence cannot substitute for a subsequent current task query',async()=>{
  const {p,stored,receipts}=fixture(true,false);await p.tickDistributedQueueCore();assert.equal(receipts.length,2);
  assert.ok(stored().plans[0].jobs.every(job=>job.lifecycleProtocol===2&&job.status==='failed'));
  const identities=stored().plans[0].jobs.map(job=>job.commandId);
  await p.tickDistributedQueueCore();
  assert.equal(receipts.length,2);assert.deepEqual(stored().plans[0].jobs.map(job=>job.commandId),identities);
  assert.ok(stored().plans[0].jobs.every(job=>job.lifecycleProtocol===2&&job.status==='unknown'&&job.statusQueryError));
 });
