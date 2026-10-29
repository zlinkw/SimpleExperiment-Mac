const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript'), vm = require('node:vm');
require('../_helpers/registerTsRequire');
const W = require('../../src/features/WorkerProgressQuery.ts');
const TaskQuery = require('../../src/features/WorkerTaskQuery.ts');
const P = require('../../src/features/DistributedSchedulingPolicy.ts');
const { cleanupDigest } = require('../../src/features/PlanCleanup.ts');
const { completionIdentity, hasVerifiedCompletion } = require('../../src/features/VerifiedCompletion.ts');
test('low traffic stops queue network rounds only after every declared job is really confirmed',()=>{
 const plan={id:'p',projectId:'project',planJobCount:72,jobs:Array.from({length:72},(_,index)=>({index,status:'completed',commandId:'c'+index,workerId:'w',outputDir:'work/'+index}))};
 for(const job of plan.jobs)job.verifiedCompletion={schemaVersion:1,identity:completionIdentity(plan,job),verifiedAt:'2026-10-29T00:00:00Z',exitCode:0};
 const queue={schemaVersion:1,plans:[plan]};assert.equal(P.lowTrafficQueueNeedsObservation(queue),false);
 const changed=structuredClone(queue);changed.plans[0].jobs[0].verifiedCompletion=undefined;
 assert.equal(P.lowTrafficQueueNeedsObservation(changed),true,'status text cannot end observation');
 for(const field of ['stopIntent','recallRequested']){const pending=structuredClone(queue);pending.plans[0].jobs[0][field]=true;assert.equal(P.lowTrafficQueueNeedsObservation(pending),true);}
 assert.equal(P.lowTrafficQueueNeedsObservation({...queue,deferred:[{status:'pending'}]}),true);
 assert.equal(P.lowTrafficQueueNeedsObservation({schemaVersion:1,plans:[{...plan,planJobCount:73}]}),true);
});
const now = Date.now(), iso = n => new Date(n).toISOString();
const immediate = () => new Promise(setImmediate);

function fixtures(time = now) {
  const job = (index, caseName, seed, status, commandId, extra = {}) => ({
    index, case: caseName, seed, lifecycleProtocol: 2, status, workerId: 'w', commandId, outputDir: 'work/' + commandId, ...extra });
  const solid = job(0, 'a', 1, 'completed', 'solid');
  const stopping = job(4, 'e', 5, 'completed', 'recall', { recallRequested: true });
  const plan1 = { id: 'plan1', projectId: 'p', planFile: 'one.yaml', revision: 'r', codeFingerprint: 'f', enqueuedAt: iso(time - 50000),
    resultPathPolicy: 'declared', planJobCount: 4, jobs: [solid, job(1, 'b', 2, 'running', 'run'),
      job(2, 'c', 3, 'unknown', 'unk'), job(3, 'd', 4, 'failed', 'fail')] };
  const plan2 = { id: 'plan2', projectId: 'p', planFile: 'two.yaml', revision: 'r', codeFingerprint: 'f', enqueuedAt: iso(time - 40000),
    resultPathPolicy: 'declared', planJobCount: 1, jobs: [stopping] };
  const queue = { schemaVersion: 1, plans: [plan1, plan2] };
  const proof = (plan, target) => ({ schemaVersion: 1, identity: completionIdentity(plan, target), verifiedAt: iso(time - 60000), exitCode: 0 });
  solid.verifiedCompletion = proof(plan1, solid);
  stopping.verifiedCompletion = proof(plan2, stopping);
  assert.equal(hasVerifiedCompletion(plan1, solid), true);
  assert.equal(hasVerifiedCompletion(plan2, stopping), true, 'the stopping fixture proof must bind its real owning plan');
  const row = commandId => ({ projectId: 'p', workerId: 'w', commandId, outputDir: 'work/' + commandId,
    observation: { lifecycleProtocol: 2, commandId, projectId: 'p', workerId: 'w', observedAt: iso(time),
      evidence: { execution: { networkStartedAt: iso(time), receivedAt: iso(time) } }, tmux: { dead: true, exitCode: 0 } } });
  const inventory = () => ({ schemaVersion: 1, executionOnly: true, queryComplete: true, generatedAt: iso(time),
    capabilities: { taskLifecycle: 2, durablePlanQueue: true, schemaVersion: 1 },
    tasks: ['solid', 'run', 'unk', 'fail', 'recall'].map(row) });
  return { queue, plan1, plan2, solid, stopping, inventory, row };
}

test('automatic query selection never re-observes a solidified completion but keeps every live or stopping identity', () => {
  const f = fixtures();
  const ids = options => TaskQuery.workerTaskQueries(f.queue, 'w', options).map(q => q.commandId).sort();
  const automatic = ids({ excludeVerifiedCompleted: true });
  assert.equal(automatic.includes('solid'), false, 'solidified exit-0 completion must not receive automatic progress/log/artifact rechecks');
  for (const live of ['run', 'unk', 'fail', 'recall']) assert.equal(automatic.includes(live), true, live + ' must stay observable');
  const manual = ids({});
  for (const all of ['solid', 'run', 'unk', 'fail', 'recall']) assert.equal(manual.includes(all), true, 'manual exact checks still query every identity');
});

test('a solidified job leaves automatic observation only while final; production recall then unknown transitions restore it', () => {
  const f = fixtures();
  const automatic = () => TaskQuery.workerTaskQueries(f.queue, 'w', { excludeVerifiedCompleted: true }).map(q => q.commandId);
  const finalised = f.stopping;
  delete finalised.recallRequested; // production path: the verified completion first sits final
  assert.equal(automatic().includes('recall'), false, 'a final verified completion receives no automatic rechecks');
  finalised.recallRequested = true; // the user then requests recall/cleanup of its outputs
  assert.equal(hasVerifiedCompletion(f.plan2, finalised), true, 'the recall intent alone never revokes the solid proof');
  assert.equal(automatic().includes('recall'), true, 'a stopping or cleanup intent stays under automatic observation');
  assert.equal(TaskQuery.workerTaskQueries(f.queue, 'w', {}).map(q => q.commandId).includes('recall'), true, 'manual checks also cover it');
  finalised.status = 'unknown'; // a newer observation reports uncertainty
  assert.equal(automatic().includes('recall'), true, 'uncertain status is queried again immediately');
  const hot = structuredClone(f.queue);
  hot.plans[0].jobs = [structuredClone(hot.plans[0].jobs[0]), structuredClone(hot.plans[1].jobs[0])];
  hot.plans[1].jobs[0].status = 'completed'; hot.plans[1].jobs[0].recallRequested = true;
  const staleSnapshot = { workerId: 'w', fetchedAt: iso(now - 30000), queryComplete: true, tasks: [] };
  assert.deepEqual(P.progressRefreshWorkerIds(hot, ['w'], [staleSnapshot]), ['w'],
    'the recall transition keeps its Worker hot for observation even with the real bound proof');
});

test('a solidified completion releases its Worker from automatic freshness hotness while unverified completion stays hot', () => {
  const f = fixtures();
  const settled = structuredClone(f.queue); settled.plans.pop();
  settled.plans[0].jobs = [settled.plans[0].jobs[0], settled.plans[0].jobs[3]]; // solidified + terminal failed only
  const staleSnapshot = { workerId: 'w', fetchedAt: iso(now - 30000), queryComplete: true,
    tasks: [{ ...f.solid, projectId: 'p', observation: { runtimeDiagnostics: { schemaVersion: 1, commandId: 'solid', runId: 'solid', state: 'scanning', count: 0, scanComplete: false } } }] };
  assert.deepEqual(P.progressRefreshWorkerIds(settled, ['w'], [staleSnapshot]), [],
    'solidified completion with a stale snapshot must not keep the Worker hot');
  const unverified = structuredClone(settled); delete unverified.plans[0].jobs[0].verifiedCompletion;
  assert.deepEqual(P.progressRefreshWorkerIds(unverified, ['w'], [staleSnapshot]), ['w'],
    'a completion without solid proof must keep its hotness until artifacts confirm it');
  assert.deepEqual(P.progressRefreshWorkerIds(f.queue, ['w'], [staleSnapshot]), ['w'],
    'a confirmed completion with a recall request still stays under observation');
});

test('progress observation lanes skip solidified identities even while their dead pane is still in the execution inventory', async () => {
  const f = fixtures();
  const batches = [];
  const client = { getWorkerTasks: async (_, options) => {
    batches.push(options.queries.map(q => q.commandId));
    return { queryComplete: true, resultsOnly: true, metadataOnly: true, capabilities: { taskLifecycle: 2, schemaVersion: 1 },
      tasks: options.queries.map(q => ({ ...q, observation: { lifecycleProtocol: 2, commandId: q.commandId, projectId: 'p',
        workerId: 'w', observedAt: iso(now), result: { runId: q.commandId, status: 'completed', present: true, verified: true,
        artifactsComplete: true }, runtimeDiagnostics: { schemaVersion: 1, commandId: q.commandId, runId: q.commandId,
        state: 'clear', count: 0, bytesRead: 4096, totalBytes: 4096, scanComplete: true } } })) };
  } };
  const execution = { generatedAt: iso(now), tasks: f.inventory().tasks };
  const snapshot = await W.queryWorkerProgress(client, 'w', [], execution, { deferDiagnostics: true, excludeVerified: new Set(['p:solid']) });
  assert.equal(batches.flat().includes('solid'), false, 'no artifact or log batch may name the solidified job');
  for (const live of ['run', 'unk', 'fail', 'recall']) assert.equal(batches.flat().includes(live), true, live + ' still receives observation');
  assert.ok(snapshot.tasks.some(task => task.commandId === 'solid'), 'the inventory row itself stays published for display');
  const withoutExclusion = [];
  await W.queryWorkerProgress({ getWorkerTasks: async (_, options) => {
    withoutExclusion.push(options.queries.map(q => q.commandId));
    return { queryComplete: true, resultsOnly: true, metadataOnly: true, tasks: options.queries.map(q => ({ ...q, observation: { result: { runId: q.commandId } } })) };
  } }, 'w', [], execution, { deferDiagnostics: true });
  assert.equal(withoutExclusion.flat().includes('solid'), true, 'manual rounds keep the pre-existing full observation behaviour');
});

function providerHarness(f, client) {
  const source = fs.readFileSync(require.resolve('../../src/extension/legacy.ts'), 'utf8');
  const ast = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'RealtimeTunnelPanelProvider');
  const names = ['readWorkerTaskSnapshot', 'refreshWorkerTaskSnapshot', 'refreshServerPlanProgress'];
  const code = 'class Provider {' + cls.members.filter(node => names.includes(node.name?.getText(ast))).map(node => node.getText(ast)).join('\n') + '}; Provider;';
  const Provider = vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText,
    { AbortController, setTimeout, clearTimeout, workspaceRoot: () => '/project', mapLimited: async (rows, _limit, callback) => Promise.all(rows.map(callback)),
      cleanupDigest, WorkerTaskQuery: TaskQuery, WorkerProgressQuery: W, DistributedSchedulingPolicy: P,
      workerTaskSnapshotPayload: value => value, workerTaskLooksRunning: task => task.status === 'running',
      RequestBudget_1: { RequestBudgetDeniedError: class extends Error {} }, errorMessage: error => String(error?.message || error),
      hasVerifiedCompletion });
  const provider = new Provider(), published = [], cache = new Map();
  provider.workerTaskRequests = new Map();
  provider.workerTaskSnapshotRevision = 0;
  provider.loadDistributedQueue = async () => f.queue;
  provider.cachedWorkerTaskSnapshot = (_id, _root, key) => cache.get(key);
  provider.storeWorkerTaskSnapshot = (key, value) => { cache.set(key, value); published.push(value); provider.workerTaskSnapshotRevision++; };
  provider.noteWorkerTaskPlanStatus = () => {};
  provider.postState = () => {};
  provider.distributedQueueRoot = '/project';
  provider.distributedQueueCache = f.queue;
  provider.isRealtimeMode = () => true;
  provider.workerActionTargets = () => [{ id: 'w' }];
  provider.client = { clients: new Map([['w', { progressGeneration: 0 }]]), getWorkerTasks: (id, options) => client.getWorkerTasks(id, options) };
  return { provider, published };
}

function observationClient(f, behaviour = {}) {
  const state = { executions: 0, observationBatches: [], logBatches: [], executionGate: behaviour.executionGate };
  state.getWorkerTasks = async (_workerId, options) => {
    if (options.executionOnly) {
      state.executions++;
      if (state.executionGate) await state.executionGate;
      return f.inventory();
    }
    if (options.diagnosticsOnly) {
      state.logBatches.push(options.queries.map(q => q.commandId));
      if (behaviour.hangLogs) return new Promise(() => {});
      return { queryComplete: true, diagnosticsOnly: true, tasks: options.queries.map(q => ({ ...q,
        observation: { runtimeDiagnostics: { schemaVersion: 1, commandId: q.commandId, runId: q.commandId, state: 'clear', count: 0, bytesRead: 4096, totalBytes: 4096, scanComplete: true } } })) };
    }
    state.observationBatches.push(options.queries.map(q => q.commandId));
    return { queryComplete: true, resultsOnly: true, metadataOnly: true, capabilities: { taskLifecycle: 2, schemaVersion: 1 },
      tasks: options.queries.map(q => ({ ...q, observation: { lifecycleProtocol: 2, commandId: q.commandId, projectId: 'p',
        workerId: 'w', observedAt: iso(now), result: { runId: q.commandId, status: 'completed', present: true, verified: true, artifactsComplete: true } } })) };
  };
  return state;
}

test('one automatic round fetches the real execution inventory once for warm-up, full and tick readers', async () => {
  const f = fixtures();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const client = observationClient(f, { executionGate: gate });
  const { provider } = providerHarness(f, client);
  const warm = provider.readWorkerTaskSnapshot('w', { fresh: true, executionOnly: true });
  const full = provider.readWorkerTaskSnapshot('w', { fresh: true, excludeVerifiedCompleted: true });
  const tick = provider.readWorkerTaskSnapshot('w', { fresh: true, executionOnly: true });
  await immediate();
  release();
  await Promise.all([warm, full, tick]);
  assert.equal(client.executions, 1, 'concurrent helpers in one round must share exactly one live tmux inventory RPC');
  assert.equal(client.observationBatches.flat().includes('solid'), false);
  assert.equal(client.observationBatches.flat().includes('run'), true);
  await provider.readWorkerTaskSnapshot('w', { fresh: true, executionOnly: true });
  assert.equal(client.executions, 2, 'a new round must fetch a fresh inventory instead of reusing the old cache');
});
test('real low-traffic Host defers running details, but still verifies exited tasks and honors manual refresh',async()=>{
 const f=fixtures(),base=f.inventory;
 f.inventory=()=>{const value=base();value.tasks.find(t=>t.commandId==='run').observation.tmux={dead:false,phase:'running'};return value;};
 const client=observationClient(f),{provider}=providerHarness(f,client);provider.lowTrafficMode=true;
 await provider.readWorkerTaskSnapshot('w',{fresh:true,excludeVerifiedCompleted:true});await immediate();
 assert.equal(client.observationBatches.flat().includes('run'),false);assert.equal(client.logBatches.flat().includes('run'),false);
 assert.equal(client.observationBatches.flat().includes('fail'),true,'real exits still need result verification');
 client.observationBatches.length=0;await provider.readWorkerTaskSnapshot('w',{fresh:true});
 assert.equal(client.observationBatches.flat().includes('run'),true,'manual detail refresh remains immediate');
});

test('solidified jobs receive zero job-specific queries across repeated automatic rounds', async () => {
  const f = fixtures();
  const client = observationClient(f);
  const { provider } = providerHarness(f, client);
  for (let round = 0; round < 4; round++) {
    await provider.refreshServerPlanProgress({ automatic: true });
    assert.equal(client.observationBatches.flat().includes('solid'), false, 'round ' + round + ' must not re-observe the solidified job');
    assert.equal(client.logBatches.flat().includes('solid'), false, 'round ' + round + ' must not re-scan the solidified log');
    for (const live of ['run', 'unk', 'fail', 'recall']) assert.equal(client.observationBatches.flat().includes(live), true);
    assert.equal(client.executions >= round + 1, true, 'global execution inventory monitoring keeps running every round');
    client.observationBatches.length = 0; client.logBatches.length = 0;
  }
});

test('a manual exact check is never coalesced behind the filtered automatic round and still observes the solidified job', async () => {
  const f = fixtures();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const client = observationClient(f, { executionGate: gate });
  const { provider } = providerHarness(f, client);
  const automatic = provider.readWorkerTaskSnapshot('w', { fresh: true, excludeVerifiedCompleted: true });
  await immediate();
  const manual = provider.readWorkerTaskSnapshot('w', { fresh: true });
  await immediate();
  release();
  await Promise.all([automatic, manual]);
  const solidBatches = client.observationBatches.filter(batch => batch.includes('solid'));
  assert.equal(solidBatches.length >= 1, true, 'the manual round must re-observe the exact solidified identity');
  assert.equal(client.executions, 1, 'manual and automatic rounds still share the one live inventory RPC');
});

test('a hung log scan cannot block artifact publication or the execution channel used by scheduling and precise stop', async () => {
  const f = fixtures();
  const client = observationClient(f, { hangLogs: true });
  const { provider, published } = providerHarness(f, client);
  const round = provider.readWorkerTaskSnapshot('w', { fresh: true, excludeVerifiedCompleted: true });
  await round;
  assert.ok(published.some(snapshot => snapshot.tasks?.some(task => task.observation?.result?.verified === true)),
    'artifact lanes publish while the deferred log reader stays hung');
  const inventoriesBefore = client.executions;
  await provider.readWorkerTaskSnapshot('w', { fresh: true, executionOnly: true });
  assert.equal(client.executions, inventoriesBefore + 1, 'the scheduling/stop execution channel keeps polling while logs hang');
  assert.equal(client.logBatches.flat().includes('solid'), false, 'even the background log queue must not re-scan the solidified identity');
});

test('clearing the solid proof (manual counter-evidence path) immediately re-admits automatic observation', () => {
  const f = fixtures();
  delete f.solid.verifiedCompletion;
  assert.equal(hasVerifiedCompletion(f.queue.plans[0], f.solid), false);
  const automatic = TaskQuery.workerTaskQueries(f.queue, 'w', { excludeVerifiedCompleted: true }).map(q => q.commandId);
  assert.equal(automatic.includes('solid'), true, 'after genuine counter-evidence revokes the proof the job is queried again');
});

// Faithful to the real read chain: TunnelClient.legacy.ts routes a call without any
// mode flag and empty queries to GET /api/worker/tasks, and a protocol-2 agent answers
// via task_query(root, []), which observes exactly the current tmux inventory rows.
function semanticFallbackClient(f, mode) {
  const state = { executions: 0, fullWorkerReads: 0, namedQueries: [], observationBatches: [], logBatches: [] };
  const observed = rows => rows.map(row => ({ ...row, observation: { ...row.observation, result: { runId: row.commandId,
    status: 'completed', present: true, verified: true, artifactsComplete: true } } }));
  state.getWorkerTasks = async (_workerId, options) => {
    if (options.executionOnly) {
      state.executions++;
      if (mode === 'inventoryFail') throw new Error('tmux inventory unavailable');
      return mode === 'emptyTasks' ? { ...f.inventory(), tasks: [] } : f.inventory();
    }
    if (options.diagnosticsOnly) {
      state.logBatches.push(options.queries.map(q => q.commandId));
      return { queryComplete: true, tasks: options.queries.map(q => ({ ...q, observation: { runtimeDiagnostics: { schemaVersion: 1,
        commandId: q.commandId, runId: q.commandId, state: 'clear', count: 0, bytesRead: 4096, totalBytes: 4096, scanComplete: true } } })) };
    }
    if (options.observationOnly) {
      state.observationBatches.push(options.queries.map(q => q.commandId));
      return { queryComplete: true, resultsOnly: true, metadataOnly: true, capabilities: { taskLifecycle: 2, schemaVersion: 1 },
        tasks: options.queries.map(q => ({ ...q, observation: { lifecycleProtocol: 2, commandId: q.commandId, projectId: 'p',
          workerId: 'w', observedAt: iso(now), result: { runId: q.commandId, status: 'completed', present: true, verified: true, artifactsComplete: true } } })) };
    }
    state.fullWorkerReads++;
    state.namedQueries.push((options.queries || []).map(q => q.commandId));
    // task_query(root, queries): observations for every current inventory row plus the selectors.
    const rows = mode === 'emptyTasks' ? [] : f.inventory().tasks;
    return { schemaVersion: 1, queryComplete: true, generatedAt: iso(now), capabilities: { taskLifecycle: 2, durablePlanQueue: true, schemaVersion: 1 },
      tasks: observed(rows), cleanupExecutors: [], queryErrors: [] };
  };
  return state;
}

test('an inventory failure in an automatic protocol-2 round ends honestly without any worker-wide read', async () => {
  const f = fixtures();
  f.queue.plans[0].jobs = [f.solid]; f.queue.plans[1].jobs = []; // only the solidified identity remains on this Worker
  const client = semanticFallbackClient(f, 'inventoryFail');
  const { provider } = providerHarness(f, client);
  const snapshot = await provider.refreshWorkerTaskSnapshot('w', '/project', '/project\u0000w', { excludeVerifiedCompleted: true });
  assert.equal(client.executions, 1, 'the automatic round first attempts exactly one live inventory');
  assert.equal(client.fullWorkerReads, 0, 'no legacy worker-wide task_query may substitute: the real agent answers it with manifest and dead-pane log reads for every row, including solidified completions');
  assert.equal(client.observationBatches.length, 0, 'no job-specific artifact lane runs at all');
  assert.equal(client.logBatches.length, 0, 'no job-specific log scan runs at all');
  assert.ok(snapshot.error, 'the round reports an honest unknown instead of a wide-scan freshness');
  assert.equal(f.solid.verifiedCompletion.exitCode, 0, 'the solid proof is untouched by the failed round');
});

test('an inventory failure does not let the automatic round wide-scan live identities as substitutes', async () => {
  const f = fixtures();
  const client = semanticFallbackClient(f, 'inventoryFail');
  const { provider } = providerHarness(f, client);
  const snapshot = await provider.refreshWorkerTaskSnapshot('w', '/project', '/project\u0000w', { excludeVerifiedCompleted: true });
  assert.equal(client.fullWorkerReads, 0, 'a non-empty selector list must not ride the selected_only=false read, which scans every row server-side');
  assert.equal(client.observationBatches.length, 0, 'this round ends honestly; live observation retries on the next round');
  assert.equal(client.namedQueries.flat().includes('solid'), false);
  assert.ok(snapshot.error, 'the failure is reported, not hidden');
});

test('a valid but empty automatic round ends on the execution frame without a wide read or fabricated rows', async () => {
  const f = fixtures();
  f.queue.plans[0].jobs = [f.solid]; f.queue.plans[1].jobs = []; // only the solidified identity remains
  const client = semanticFallbackClient(f, 'emptyTasks');
  const { provider } = providerHarness(f, client);
  const snapshot = await provider.refreshWorkerTaskSnapshot('w', '/project', '/project\u0000w', { excludeVerifiedCompleted: true });
  assert.equal(client.executions, 1);
  assert.equal(client.observationBatches.length, 0, 'no artifact lane names any job');
  assert.equal(client.logBatches.length, 0);
  assert.equal(client.fullWorkerReads, 0, 'the empty-inventory round must not issue the legacy wide read');
  assert.equal(snapshot.tasks.length, 0, 'an honest empty inventory is not backfilled with finished jobs');
  assert.equal(f.solid.verifiedCompletion.exitCode, 0, 'the solid proof is untouched by the empty round');
  const second = await provider.refreshWorkerTaskSnapshot('w', '/project', '/project\u0000w', { excludeVerifiedCompleted: true });
  assert.equal(second.tasks.length, 0, 'a repeated round stays honest without re-querying the solidified identity');
  assert.equal(client.fullWorkerReads, 0, 'still no worker-wide read in any round');
});

test('an empty inventory with live jobs on the same Worker lanes only the live identities', async () => {
  const f = fixtures();
  const client = semanticFallbackClient(f, 'emptyTasks');
  const { provider } = providerHarness(f, client);
  const snapshot = await provider.refreshWorkerTaskSnapshot('w', '/project', '/project\u0000w', { excludeVerifiedCompleted: true });
  assert.equal(client.fullWorkerReads, 0, 'live selectors keep the round inside the lane path, no worker-wide fallback needed');
  const allObserved = [...client.observationBatches, ...client.logBatches].flat();
  assert.equal(allObserved.includes('solid'), false, 'no lane or log read ever names the solidified job');
  for (const live of ['run', 'unk', 'fail', 'recall']) assert.equal(allObserved.includes(live), true, live + ' keeps its observation');
  assert.equal(snapshot.tasks.some(task => task.commandId === 'solid'), false, 'a vanished pane is not fabricated back into the snapshot');
});

test('manual reads still observe the solidified identity exactly once per full round', async () => {
  const f = fixtures();
  const client = observationClient(f, {});
  const { provider } = providerHarness(f, client);
  await provider.readWorkerTaskSnapshot('w', { fresh: true });
  const solidObservation = client.observationBatches.filter(batch => batch.includes('solid'));
  assert.equal(solidObservation.length >= 1, true, 'the manual full read observes the solidified job');
  assert.equal(solidObservation.flat().filter(id => id === 'solid').length, 1, 'and only one job-specific lane read names it');
});

test('refreshServerPlanProgress only filters the automatic full read, never the inventory or manual rounds', async () => {
  const f = fixtures();
  const calls = [];
  const client = observationClient(f);
  const { provider } = providerHarness(f, client);
  provider.readWorkerTaskSnapshot = async (_id, options = {}) => { calls.push(options); return {}; };
  await provider.refreshServerPlanProgress({ automatic: true });
  assert.equal(calls.some(call => call.executionOnly === true && call.excludeVerifiedCompleted === undefined), true,
    'execution inventory polling stays unfiltered global monitoring');
  assert.equal(calls.some(call => !call.executionOnly && call.excludeVerifiedCompleted === true), true,
    'automatic full reads carry the solidified exclusion');
  calls.length = 0;
  await provider.refreshServerPlanProgress();
  assert.equal(calls.some(call => !call.executionOnly && call.excludeVerifiedCompleted === false), true,
    'manual progress refresh keeps observing solidified identities');
});
