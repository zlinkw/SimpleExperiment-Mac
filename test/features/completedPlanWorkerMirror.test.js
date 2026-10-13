const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const queueApi = require('../../dist/features/DistributedPlanQueue.js');
const hash = 'a'.repeat(64), root = 'C:/project';
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const text = fs.readFileSync(path.join(__dirname, '../../src/extension/legacy.ts'), 'utf8');
  const ast = ts.createSourceFile('host.ts', text, ts.ScriptTarget.Latest, true);
  const host = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'RealtimeTunnelPanelProvider');
  const names = new Set(['scheduleDistributedPostprocess', 'syncCompletedPlanArtifacts', 'verifyCompletedJobMirrorOwner',
    'syncDistributedJobArtifacts', 'distributedOutputHashes', 'queueCompletedPlanArtifactSync']);
  const body = host.members.filter(node => node.name && names.has(node.name.getText(ast))).map(node => node.getText(ast)).join('\n');
  const sandbox = {
    Buffer, Date, AbortSignal, PlanArtifactSyncStatus: require('../../dist/features/PlanArtifactSyncStatus.js'),
    PlanArtifactSync: require('../../dist/features/PlanArtifactSync.js'), DistributedPlanQueue: queueApi,
    PlanOutputRetention: require('../../dist/features/PlanOutputRetention.js'),
    collectDistributedJobArtifacts: require('../../dist/features/DistributedJobArtifacts.js').collectDistributedJobArtifacts,
    workerFpsyncTaskLabel: () => 'Plan 完成产物同步', workspaceRoot: () => root,
    errorMessage: error => String(error.message || error),
    loadSyncHolds: async () => f.holds, isSyncHeld: require('../../dist/features/SyncResolution.js').isSyncHeld,
    mapLimited: async (rows, limit, work) => { for (const row of rows) await work(row); },
  };
  vm.runInNewContext(ts.transpileModule(`class Host { ${body} }\nthis.Host = Host;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox);
  const p = new sandbox.Host();
  const plan = { id: 'run', projectId: queueApi.canonicalProjectId(root), planFile: 'experiments/plans/formal.yaml',
    revision: 'revision', codeFingerprint: 'code', resultPathPolicy: 'declared', fullPlanJobCount: 2,
    enqueuedAt: '2026-10-12T00:00:00Z', executionMode: 'train_test', jobs: [0, 1].map(index => ({
      index, case: `case${index}`, seed: 42, globalJobId: `run:${index}`, commandId: `command${index}`,
      workerId: `w${index + 1}`, status: 'completed', resultPathPolicy: 'declared', attempt: 0,
      outputDir: `work_dirs/formal/job${index}`, collectionResultCsv: `tmp/result/formal/job${index}.csv`,
      actualExecutionMode: 'train_test',
    })) };
  const state = { schemaVersion: 1, plans: [plan] }, inventory = { w1: {}, w2: {}, w3: {} }, owners = {};
  for (const job of plan.jobs) {
    const owner = { schemaVersion: 1, workflowId: plan.id, commandId: job.commandId, globalJobId: job.globalJobId,
      planRevision: plan.revision, codeFingerprint: plan.codeFingerprint, index: job.index, case: job.case, seed: job.seed,
      outputDir: job.outputDir, collectionResultCsv: job.collectionResultCsv, mode: 'train_test', state: 'completed' };
    owners[`${job.outputDir}/formal_job_owner.json`] = owner;
    for (const file of ['formal_job_owner.json', 'config.yaml', 'metrics_summary.csv', 'best_model.pth', 'stdout.log']) {
      inventory[job.workerId][`${job.outputDir}/${file}`] = { sha256: hash };
    }
    inventory[job.workerId][job.collectionResultCsv] = { sha256: hash };
    inventory[job.workerId][`${job.outputDir}/worker.pid`] = { sha256: hash };
  }
  const f = { p, state, inventory, owners, holds: {}, transfers: [], reads: [], errors: [], checks: 0, changed: undefined };
  Object.assign(p, {
    context: { globalStorageUri: { fsPath: 'C:/plugin' } }, projectContextGeneration: 1, client: {},
    lastWorkerProbes: { w1: { status: 'ok' }, w2: { status: 'ok' }, w3: { status: 'ok' } },
    localPlanMetadata: { plans: [{ planFile: plan.planFile, revision: plan.revision, jobCount: 2 }] },
    isRealtimeMode: () => true, projectTopologyAssessment: () => ({ mode: 'worker_pool' }),
    captureProjectContext: () => ({ root, generation: p.projectContextGeneration }),
    projectContextIsCurrent: ctx => ctx.generation === p.projectContextGeneration,
    workerCodeSyncTargets: () => ['w1', 'w2', 'w3'].map(id => ({ id })),
    distributedProjectContract: () => ({ fragmentPaths: ['config.yaml', 'metrics_summary.csv'],
      requiredPaths: ['config.yaml', 'metrics_summary.csv', 'best_model.pth'] }),
    planOutputRetentionMode: () => 'latest-complete',
    loadDistributedQueue: async () => queueApi.cloneDistributedQueue(state),
    sftpServerOptions: target => ({ id: target.id }),
    simpleSftpCapability: async () => ({ features: { projectInventoryStdinScopes: true } }),
    verifiedSftpProjectInventory: async ({ source, scopePaths, relativePath, recursive }) => {
      f.reads.push({ workerId: source.id, scopePaths, relativePath });
      return { files: Object.fromEntries(Object.entries(inventory[source.id]).filter(([file]) =>
        (scopePaths || [relativePath]).some(scope => file === scope || recursive && file.startsWith(scope + '/')))) };
    },
    downloadMetricMemoryBatch: async (_ctx, _client, batch) => ({ metricFiles: batch.entries.map(entry => {
      assert.ok(entry.remotePath.endsWith('/formal_job_owner.json'), 'only bounded owner proof enters local memory');
      assert.equal(entry.sha256, hash);
      return { remotePath: entry.remotePath, sha256: hash, text: JSON.stringify(owners[entry.remotePath]) };
    }) }),
    assertSshTransportIdentities: async () => { f.changed?.(); },
    simpleSftpApiCall: async (method, params) => {
      assert.equal(method, 'sync.serverToServerFpsync', 'no download, cleanup, code upload or training');
      assert.equal(params.directory, undefined); assert.equal(params.deleteOnly, undefined);
      f.transfers.push({ source: params.source.id, destination: params.destination.id, paths: [...params.relativePaths] });
      for (const file of params.relativePaths) inventory[params.destination.id][file] = { ...inventory[params.source.id][file] };
    },
    patchDistributedJob: async (_root, id, index, _attempt, patch) => {
      const job = state.plans.find(plan => plan.id === id).jobs.find(job => job.index === index);
      for (const [key, value] of Object.entries(patch)) {
        if (key.startsWith('replace')) continue;
        job[key] = Array.isArray(value) && !patch[`replace${key[0].toUpperCase()}${key.slice(1)}`]
          ? [...new Set([...(job[key] || []), ...value])] : value;
      }
    },
    recordActionError: row => f.errors.push(row), postState() {},
    queuePlanArtifactSyncStatusCheck: () => f.checks++,
  });
  f.run = async () => { p.scheduleDistributedPostprocess(root, true); await p.distributedPostprocessPromise; await turn(); };
  return f;
}

test('a complete formal Plan mirrors all job outputs and declared CSVs between Workers once', async () => {
  const f = fixture();
  await f.run();
  assert.ok(f.transfers.length > 0, 'completed Plan must trigger Worker-to-Worker transfers');
  for (const job of f.state.plans[0].jobs) for (const worker of ['w1', 'w2', 'w3']) {
    assert.ok(job.mirroredWorkerIds.includes(worker));
    assert.equal(f.inventory[worker][job.collectionResultCsv]?.sha256, hash);
    assert.equal(f.inventory[worker][`${job.outputDir}/best_model.pth`]?.sha256, hash);
  }
  assert.ok(f.transfers.every(row => row.paths.every(file => !file.endsWith('.pid'))));
  const status = require('../../dist/features/PlanArtifactSyncStatus.js').assessPlanArtifactSync(f.state.plans[0], ['w1', 'w2', 'w3'],
    new Map(Object.entries(f.inventory).map(([id, files]) => [id, Object.fromEntries(Object.entries(files).map(([file, value]) => [file, value.sha256]))])),
    ['config.yaml', 'metrics_summary.csv', 'best_model.pth']);
  assert.equal(status.status, 'synced', 'worker PID/lock/exit state is excluded from both transfer and status comparison');
  const count = f.transfers.length, reads = f.reads.length;
  await f.run();
  assert.equal(f.transfers.length, count); assert.equal(f.reads.length, reads);
  assert.deepEqual(f.errors, []);
});

test('one finished job, failed jobs and unavailable jobs do not trigger Plan mirroring', async () => {
  for (const status of ['running', 'failed', 'cancelled', 'unknown']) {
    const f = fixture(); f.state.plans[0].jobs[1].status = status;
    await f.run(); assert.equal(f.transfers.length, 0); assert.equal(f.reads.length, 0);
  }
});

test('offline destinations stay pending through restart and finish automatically after reconnect', async () => {
  const f = fixture(); f.p.lastWorkerProbes.w3.status = 'timeout';
  await f.run();
  assert.ok(f.transfers.length > 0);
  assert.ok(f.state.plans[0].jobs.every(job => !job.mirroredWorkerIds.includes('w3')));
  f.p.distributedPostprocessPromise = undefined;
  f.p.lastWorkerProbes.w3.status = 'ok';
  await f.run();
  assert.ok(f.state.plans[0].jobs.every(job => job.mirroredWorkerIds.includes('w3')));
});

test('cached mirror flags without formal owner evidence are reverified instead of treated as success', async () => {
  const f = fixture();
  f.state.plans[0].jobs.forEach(job => { job.mirroredWorkerIds = ['w1', 'w2', 'w3']; job.artifacts = {}; });
  await f.run();
  assert.ok(f.transfers.length > 0);
  assert.ok(f.state.plans[0].jobs.every(job => job.artifacts[`${job.outputDir}/formal_job_owner.json`] === hash));
});

test('destination conflicts and wrong source ownership never overwrite files', async () => {
  const f = fixture(); const job = f.state.plans[0].jobs[0];
  f.owners[`${job.outputDir}/formal_job_owner.json`].commandId = 'another-job';
  f.inventory.w3[`${job.outputDir}/best_model.pth`] = { sha256: 'b'.repeat(64) };
  await assert.rejects(f.run(), /FORMAL_JOB_MIRROR_OWNER_MISMATCH/);
  await turn();
  assert.ok(f.errors.length > 0, 'ownership rejection must remain visible');
  assert.ok(f.transfers.every(row => row.paths.every(file => !file.startsWith(job.outputDir + '/'))));
  assert.equal(f.inventory.w3[`${job.outputDir}/best_model.pth`].sha256, 'b'.repeat(64));
});

test('content conflicts remain pending without overwriting another completed formal directory', async () => {
  const f = fixture(), job = f.state.plans[0].jobs[0];
  const file = `${job.outputDir}/best_model.pth`;
  f.inventory.w3[file] = { sha256: 'b'.repeat(64) };
  await assert.rejects(f.run(), /FORMAL_JOB_MIRROR_CONFLICT/);
  await turn();
  assert.equal(f.inventory.w3[file].sha256, 'b'.repeat(64));
  assert.ok(job.artifactRetryAfter); assert.match(job.artifactError, /CONFLICT/);
  const reads = f.reads.length;
  await f.run(); assert.equal(f.reads.length, reads, 'durable retry deadline prevents tight loops');
});

test('busy transfers coalesce completion events without starting parallel mirror jobs', async () => {
  const f = fixture(); let release;
  const original = f.p.simpleSftpApiCall;
  f.p.simpleSftpApiCall = async (...args) => { await new Promise(resolve => { release = resolve; }); return original(...args); };
  f.p.scheduleDistributedPostprocess(root, true);
  const first = f.p.distributedPostprocessPromise;
  while (!release) await turn();
  await f.p.queueCompletedPlanArtifactSync({ status: 'completed' });
  f.p.scheduleDistributedPostprocess(root, true);
  assert.equal(f.p.distributedPostprocessPromise, first);
  f.p.simpleSftpApiCall = original; release();
  await first; await turn(); await f.p.distributedPostprocessPromise; await turn();
  assert.deepEqual(f.errors, []);
  assert.ok(f.state.plans[0].jobs.every(job => ['w1', 'w2', 'w3'].every(id => job.mirroredWorkerIds.includes(id))));
});

test('source or project identity changes, cleanup holds and old attempts block automatic copying', async () => {
  for (const variant of ['cleanup', 'project', 'hold', 'attempt']) {
    const f = fixture(), plan = f.state.plans[0];
    if (variant === 'cleanup') plan.cleanup = { state: 'partial' };
    if (variant === 'project') plan.projectId = 'foreign-project';
    if (variant === 'hold') f.holds[`${plan.jobs[0].outputDir}/best_model.pth`] = { directory: false };
    if (variant === 'attempt') plan.jobs[0].outputDir += '/attempts/old';
    if (variant === 'hold') await assert.rejects(f.run(), /PLAN_MIRROR_HELD/);
    else await f.run();
    assert.equal(f.transfers.length, 0, variant);
  }
  const f = fixture(); f.changed = () => { f.state.plans[0].jobs[0].status = 'running'; };
  await assert.rejects(f.run(), /PLAN_MIRROR_IDENTITY_CHANGED/);
  assert.equal(f.transfers.length, 0, 'fresh pre-transfer check rejects a newly active writer');
  const changed = fixture();
  changed.changed = () => { changed.p.workerCodeSyncTargets = () => ['w1', 'w2', 'w3'].map(id => ({ id, remotePath: '/different-project' })); };
  await assert.rejects(changed.run(), /PLAN_MIRROR_CONTEXT_CHANGED/);
  assert.equal(changed.transfers.length, 0, 'changing server roots invalidates the frozen transfer scope');
});

test('advancing local PLAN metadata cannot rewrite a completed run or suppress its immutable mirror', async () => {
  const f = fixture(); f.p.localPlanMetadata.plans[0].revision = 'new';
  await f.run();
  assert.ok(f.transfers.length > 0);
  assert.equal(f.state.plans[0].revision, 'revision');
  assert.ok(f.transfers.every(row => row.paths.every(file => file.startsWith('work_dirs/formal/') || file.startsWith('tmp/result/formal/'))));
});

test('another registered writer of any owned path blocks automatic mirroring', async () => {
  const f = fixture(), other = structuredClone(f.state.plans[0]);
  other.id = 'foreign'; other.planFile = 'experiments/plans/foreign.yaml';
  other.jobs.forEach(job => { job.status = 'running'; job.commandId += '-other'; });
  f.state.plans.push(other);
  await assert.rejects(f.run(), /FORMAL_JOB_MIRROR_PATH_CONFLICT/);
  assert.equal(f.transfers.length, 0);
});

test('train-only jobs mirror validation/checkpoint artifacts without a test CSV', async () => {
  const f = fixture(), plan = f.state.plans[0]; plan.executionMode = 'train';
  for (const job of plan.jobs) {
    job.actualExecutionMode = 'train';
    const owner = f.owners[`${job.outputDir}/formal_job_owner.json`];
    owner.mode = 'train'; owner.state = 'training_completed';
    delete f.inventory[job.workerId][job.collectionResultCsv];
  }
  await f.run();
  assert.ok(f.transfers.length > 0);
  assert.ok(f.transfers.every(row => row.paths.every(file => !file.startsWith('tmp/result/'))));
});
