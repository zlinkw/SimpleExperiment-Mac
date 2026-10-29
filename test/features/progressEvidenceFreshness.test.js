const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript'), vm = require('node:vm');
require('../_helpers/registerTsRequire');
const W = require('../../src/features/WorkerProgressQuery.ts');
const Q = require('../../src/features/DistributedPlanQueue.ts');
const P = require('../../src/features/DistributedSchedulingPolicy.ts');
const commandId = '12a6bad01552b615bb3401b85abea391';
const at = n => new Date(n).toISOString();
function method(name, globals, file = 'src/extension/legacy.ts') {
 const source = fs.readFileSync(file, 'utf8');
 const ast = ts.createSourceFile('host.ts', source, ts.ScriptTarget.Latest, true);
 let found;
 function visit(n) { if (ts.isMethodDeclaration(n) && n.name.getText(ast) === name) found = n; ts.forEachChild(n, visit); }
 visit(ast); assert.ok(found);
 return vm.runInNewContext(ts.transpileModule('class H {' + found.getText(ast) + '}; H.prototype.' + name,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, globals);
}
function fixture(now) {
 const query = { lifecycleProtocol: 2, commandId, projectId: 'p', workerId: 'w', outputDir: 'work/c' };
 const observation = { ...query, observedAt: at(now - 33000), tmux: { dead: true, exitCode: 0, phase: 'running', windowId: '@115', paneId: '%115' } };
 const task = { ...query, observation };
 const snapshot = { workerId: 'w', queryComplete: true, capabilities: { taskLifecycle: 2 }, generatedAt: at(now - 33000), fetchedAt: at(now), tasks: [task] };
 const queue = { plans: [{ id: 'plan', projectId: 'p', jobs: [{ ...query, index: 0, status: 'unknown' }] }] };
 return { query, task, snapshot, queue };
}
test('real host publishes execution and artifacts while logs wait, even with a full cached round', async () => {
 let now = Date.now(); const f = fixture(now), published = [];
 const cached = { ...f.snapshot, fetchedAt: at(now - 19000) };
 let release; const blocked = new Promise(resolve => { release = resolve; });
 const controller = new AbortController();
 const client = { getWorkerTasks: async (_, o) => {
  if (o.executionOnly) { now += 1000; return { ...f.snapshot, executionOnly: true }; }
  if (o.diagnosticsOnly) return blocked;
  now += 1000;
  return { ...f.snapshot, resultsOnly: true, metadataOnly: true, tasks: [{ ...f.task, observation: {
   ...f.task.observation, result: { runId: commandId, status: 'completed', present: true, verified: true, artifactsComplete: true }
  } }] };
 } };
 const globals = { Date: class extends Date { static now() { return now; } }, workspaceRoot: () => '/project', WorkerProgressQuery: W,
  WorkerTaskQuery: { workerTaskQueries: () => [f.query] }, workerTaskSnapshotPayload: x => x,
  errorMessage: e => e.message, RequestBudget_1: { RequestBudgetDeniedError: class extends Error {} } };
 const host = { client, loadDistributedQueue: async () => f.queue, cachedWorkerTaskSnapshot: () => cached,
  storeWorkerTaskSnapshot(_, value) { published.push(value); }, postState() {} };
 const pending = method('refreshWorkerTaskSnapshot', globals).call(host, 'w', '/project', 'key', { signal: controller.signal });
 try {
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
  assert.ok(published.some(s => s.tasks.some(t => t.observation?.result?.verified)),
   'cached age is 21000ms > 20000ms while this round already received execution and complete artifacts; logs must not gate publication');
 } finally {
  controller.abort(Object.assign(Error('test log deadline'), { code: 'TASK_QUERY_TIMEOUT' }));
  release({ queryComplete: true, tasks: [] }); await pending;
 }
});
test('execution expiry preserves independently fresh artifacts and does not infer failure or missing metrics', () => {
 const now = Date.now(), f = fixture(now);
 f.task.observation.result = { runId: commandId, status: 'completed', present: true, verified: true, artifactsComplete: true };
 f.task.observation.evidence = { execution: { networkStartedAt: at(now - 21000), receivedAt: at(now - 21000) },
  artifacts: { networkStartedAt: at(now - 1000), receivedAt: at(now - 500) } };
 const job = P.serverAuthoritativeProgress(f.queue, [f.snapshot], 'p', now)[0].jobs[0];
 assert.equal(job.executionState, 'unknown'); assert.equal(job.status, 'unknown');
 assert.equal(job.resultState, 'complete'); assert.match(job.statusQueryError, /过期/);
});
test('remote clock skew cannot expire a fresh protocol 2 observation', () => {
 const now = Date.now(), f = fixture(now);
 for (const skew of [-3600000, 3600000]) {
  f.snapshot.generatedAt = f.task.observation.observedAt = at(now + skew);
  assert.equal(P.serverAuthoritativeProgress(f.queue, [f.snapshot], 'p', now)[0].jobs[0].executionState, 'exited');
 }
});
test('log expiry retains artifacts and known runtime failures without certifying clean completion', () => {
 const now = Date.now(), f = fixture(now), stamp = age => ({ networkStartedAt: at(now - age), receivedAt: at(now - age) });
 f.task.observation.result = { runId: commandId, status: 'completed', present: true, verified: true, artifactsComplete: true };
 f.task.observation.evidence = { execution: stamp(1000), artifacts: stamp(500), logs: stamp(21000) };
 for (const count of [0, 1]) {
  f.task.observation.runtimeDiagnostics = { schemaVersion: 1, commandId, runId: commandId, count, state: count ? 'anomalous' : 'clear', scanComplete: true };
  const job = P.serverAuthoritativeProgress(f.queue, [f.snapshot], 'p', now)[0].jobs[0];
  assert.equal(job.status, count ? 'failed' : 'completed'); assert.equal(job.resultState, 'complete'); assert.equal(job.executionState, 'exited');
  assert.equal(job.completionState, count ? 'review_required' : 'unverified'); assert.equal(job.statusQueryError, undefined);
 }
});
test('late log receipts merge into current execution without reviving an older run or older metadata', () => {
 const { mergeProgressSnapshot } = require('../../src/features/WorkerProgressEvidence.ts');
 const now = Date.now(), f = fixture(now), stamp = n => ({ networkStartedAt: at(n), receivedAt: at(n + 10) });
 const old = structuredClone(f.snapshot), current = structuredClone(f.snapshot);
 old.fetchedAt = at(now - 1000); current.fetchedAt = at(now);
 old.tasks[0].observation.evidence = { execution: stamp(now - 1000), artifacts: stamp(now - 900), logs: stamp(now - 500) };
 old.tasks[0].observation.result = { runId: commandId, present: true, verified: true, artifactsComplete: true, status: 'completed' };
 old.tasks[0].observation.runtimeDiagnostics = { schemaVersion: 1, commandId, runId: commandId, count: 1, scanComplete: true, state: 'anomalous' };
 current.tasks[0].observation.evidence = { execution: stamp(now), artifacts: stamp(now) };
 current.tasks[0].observation.tmux.exitCode = 7;
 current.tasks[0].observation.resultQueryError = 'current metadata offline';
 const merged = mergeProgressSnapshot(current, old);
 assert.equal(merged.fetchedAt, current.fetchedAt); assert.equal(merged.tasks[0].observation.tmux.exitCode, 7);
 assert.equal(merged.tasks[0].observation.resultQueryError, 'current metadata offline');
 assert.equal(merged.tasks[0].completionState, 'review_required'); assert.equal(merged.tasks[0].status, 'failed');
 assert.equal(merged.tasks[0].observation.evidence.execution, current.tasks[0].observation.evidence.execution);
 const other = structuredClone(old); other.tasks[0].commandId = 'other-run'; other.tasks[0].observation.commandId = 'other-run';
 assert.equal(mergeProgressSnapshot(current, other).tasks.find(t => t.commandId === commandId).observation.runtimeDiagnostics, undefined);
});
test('deferred slow logs do not keep the round open, and concurrent refreshes share the same diagnostic request', async () => {
 const f = fixture(Date.now()), snapshots = [];
 let release, logs = 0; const wait = new Promise(resolve => { release = resolve; });
 const client = { getWorkerTasks: async (_, o) => {
  if (o.diagnosticsOnly) { logs++; return wait; }
  return { ...f.snapshot, resultsOnly: true, metadataOnly: true, tasks: [{ ...f.task, observation: { ...f.task.observation,
   result: { runId: commandId, status: 'completed', present: true, verified: true, artifactsComplete: true } } }] };
 } };
 try {
  for (let i = 0; i < 3; i++) {
   const result = await W.queryWorkerProgress(client, 'w', [f.query], f.snapshot, { deferDiagnostics: true, onSnapshot: s => snapshots.push(s) });
   assert.equal(result.tasks[0].resultState, 'complete'); assert.equal(result.diagnosticsPending, true);
  }
  assert.equal(logs, 1); assert.ok(snapshots.length >= 3);
 } finally { release({ queryComplete: true, tasks: [] }); await new Promise(setImmediate); }
});
test('blocked raw logs cannot queue metadata or execution even with ordinary concurrency one', async () => {
 const { RequestBudget, defaultRequestBudgetConfig } = require('../../src/tunnel/RequestBudget.ts');
 const budget = new RequestBudget({ ...defaultRequestBudgetConfig, maxConcurrentRequestsPerWorker: 1, maxConcurrentRequestsGlobal: 1 });
 let release, entered = false; const wait = new Promise(resolve => { release = resolve; });
 const log = budget.run('task_diagnostics', async () => { entered = true; await wait; });
 try {
  await new Promise(setImmediate); assert.equal(entered, true);
  assert.equal(await budget.run('manual_refresh', async () => 'metadata'), 'metadata');
  assert.equal(await budget.run('job_reconcile', async () => 'execution'), 'execution');
 } finally { release(); await log; }
});
test('actual transport records time after queue admission and never trusts remote timing fields', async () => {
 let now = Date.now(), admit;
 const queued = new Promise(resolve => { admit = resolve; });
 const globals = { Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }, AbortController, Buffer,
  localBaseUrl: () => 'http://localhost', ProgressInactivity: class { dispose() {} },
  readBoundedResponseText: async () => JSON.stringify({ queryComplete: true, localQueryTiming: { networkStartedAt: 'forged' } }),
  fetch: async () => ({ ok: true }) };
 const fn = method('executeRequestJson', globals, 'src/tunnel/TunnelClient.legacy.ts');
 const host = { endpoint: {}, headers: () => ({}), budget: { run: async (_, work) => { await queued; return work(); } } };
 const started = now, pending = fn.call(host, '/api/worker/tasks/query', 'manual_refresh', {}, { method: 'POST' });
 now += 21000; admit(); const result = await pending;
 assert.equal(Date.parse(result.localQueryTiming.requestedAt), started);
 assert.equal(Date.parse(result.localQueryTiming.networkStartedAt), now);
 assert.equal(Date.parse(result.localQueryTiming.receivedAt), now);
 assert.equal(result.localQueryTiming.requestBytes, 2);
 assert.ok(result.localQueryTiming.responseBytes > 0);
});
test('an old connection successful response is rejected after reconnect', async () => {
 const fn = method('getWorkerTasks', {}, 'src/tunnel/RealtimeTunnelClient.legacy.ts');
 let release; const response = new Promise(resolve => { release = resolve; });
 const host = { connectionGeneration: 1, disposed: false, http: { getWorkerTasks: () => response },
  coalescedRead: (_, __, operation) => operation() };
 const pending = fn.call(host); host.connectionGeneration++; release({ tasks: [] });
 await assert.rejects(pending, e => e.code === 'CONNECTION_GENERATION_CHANGED');
 host.http.getWorkerTasks = async () => 'current'; assert.equal(await fn.call(host), 'current');
});
test('repeated execution/metadata refresh preserves PLAN counts while logs stay unavailable', async () => {
 const { summarizePlanStatuses } = require('../../src/features/PanelPlanStatusSummary.ts');
 const f = fixture(Date.now()); f.queue.plans[0].planFile = 'p.yaml';
 let current;
 for (let i = 0; i < 24; i++) {
  const local = Date.now() + i * 2000, stamp = { networkStartedAt: at(local), receivedAt: at(local) };
  const live = structuredClone(f.snapshot); live.fetchedAt = at(local);
  live.tasks[0].observation.evidence = { execution: stamp, artifacts: stamp };
  live.tasks[0].observation.result = { runId: commandId, status: 'completed', present: true, verified: true, artifactsComplete: true };
  current = W.mergeProgressSnapshot(current, live);
  const distributedPlans = P.serverAuthoritativeProgress(f.queue, [current], 'p', local);
  const [summary] = summarizePlanStatuses({ plans: [{ file: 'p.yaml', jobCount: 1 }], distributedPlans, topologyMode: 'worker_pool' });
  assert.equal(distributedPlans[0].jobs[0].resultState, 'complete');
  assert.equal(summary.completedCount, 1); assert.equal(summary.failedCount, 0);
  assert.equal(distributedPlans[0].jobs[0].completionState, 'unverified');
 }
});
test('missing CORIM command stays unknown with a current negative manifest observation', async () => {
 const now = Date.now(), f = fixture(now), missing = { ...f.query, commandId: '77f6cf6556334e6ab3f2a5d9bf5f57d1' };
 const live = { ...f.snapshot, tasks: [] };
 const result = await W.queryWorkerProgress({ getWorkerTasks: async () => ({ resultsOnly: true, metadataOnly: true, queryComplete: true,
  capabilities: { taskLifecycle: 2 }, tasks: [{ ...missing, observation: { lifecycleProtocol: 2, commandId: missing.commandId,
   projectId: 'p', workerId: 'w', result: null } }] }) }, 'w', [missing], live);
 const queue = { plans: [{ projectId: 'p', jobs: [{ ...missing, index: 0, status: 'unknown' }] }] };
 const job = P.serverAuthoritativeProgress(queue, [result], 'p', Date.now())[0].jobs[0];
 assert.equal(job.status, 'unknown'); assert.equal(job.executionState, 'missing'); assert.equal(job.resultState, 'incomplete');
 assert.equal(job.statusQueryError, undefined); assert.ok(result.tasks[0].observation.evidence.execution);
});
test('client replacement does not queue a fresh caller behind an old shared request', async () => {
 const controller = new AbortController(), oldClient = {}, newClient = {};
 const shared = { client: oldClient, controller, promise: new Promise(() => {}) };
 const requests = new Map([['/project\0w:tasks0digest', shared]]);
 const host = { client: newClient, workerTaskRequests: requests, refreshWorkerTaskSnapshot: async () => 'new-generation' };
 const fn = method('readWorkerTaskSnapshot', { AbortController, setTimeout, clearTimeout, workspaceRoot: () => '/project', cleanupDigest: () => 'digest' });
 assert.equal(await fn.call(host, 'w'), 'new-generation'); assert.equal(controller.signal.aborted, true);
 assert.equal(requests.size, 0);
});
test('partial metadata error and expired artifacts do not alter a real nonzero native exit', () => {
 const now = Date.now(), f = fixture(now), stamp = n => ({ networkStartedAt: at(n), receivedAt: at(n) });
 f.task.observation.tmux.exitCode = 7;
 f.task.observation.result = null;
 f.task.observation.evidence = { execution: stamp(now), artifacts: stamp(now - 21000) };
 const job = P.serverAuthoritativeProgress(f.queue, [f.snapshot], 'p', now)[0].jobs[0];
 assert.equal(job.status, 'failed'); assert.equal(job.exitCode, 7); assert.equal(job.resultState, 'unverified');
});
test('memory timing report retains exact observation ages and never upgrades missing evidence', () => {
 const now = Date.now(), f = fixture(now);
 f.task.observation.evidence = { execution: { requestedAt: at(now - 30000), networkStartedAt: at(now - 21000), receivedAt: at(now - 1000) },
  artifacts: { networkStartedAt: at(now - 500), receivedAt: at(now - 100) } };
 const [trace] = W.progressEvidenceReport([f.snapshot], now, 20000);
 assert.equal(trace.evidence.execution.ageMs, 21000); assert.equal(trace.evidence.execution.expired, true);
 assert.equal(trace.evidence.artifacts.ageMs, 500); assert.equal(trace.evidence.artifacts.expired, false);
 assert.equal(trace.evidence.logs.available, false); assert.equal(trace.evidence.logs.expired, true);
});
test('late logs cannot clear a newer failed query whose evidence timestamp was deliberately retained', () => {
 const now = Date.now(), f = fixture(now);
 const current = { ...f.snapshot, progressRequestStartedAt: at(now), error: 'new connection unavailable' };
 const late = { ...f.snapshot, progressRequestStartedAt: at(now - 15000), diagnosticsPending: false };
 assert.equal(W.mergeProgressSnapshot(current, late).error, 'new connection unavailable');
});
test('a metadata deadline marks the affected cached artifact unknown without forging a network observation', async () => {
 const f = fixture(Date.now()), controller = new AbortController();
 f.task.observation.result = { runId: commandId, status: 'completed', present: true, verified: true, artifactsComplete: true };
 let release; const blocked = new Promise(resolve => { release = resolve; });
 const pending = W.queryWorkerProgress({ getWorkerTasks: async () => blocked }, 'w', [f.query], f.snapshot, { signal: controller.signal });
 await new Promise(setImmediate); controller.abort(Object.assign(Error('queued metadata deadline'), { code: 'TASK_QUERY_TIMEOUT' }));
 const result = await pending; release({ queryComplete: true, tasks: [] });
 const job = P.serverAuthoritativeProgress(f.queue, [result], 'p', Date.now())[0].jobs[0];
 assert.equal(job.resultState, 'unverified'); assert.equal(job.executionState, 'exited'); assert.equal(job.status, 'unknown');
 assert.equal(result.tasks[0].observation.evidence.artifacts.failed, true);
 assert.equal(result.tasks[0].observation.evidence.artifacts.networkStartedAt, undefined);
});
test('a later log failure retains already observed run exceptions for review', async () => {
 const f = fixture(Date.now());
 f.task.observation.runtimeDiagnostics = { schemaVersion: 1, commandId, runId: commandId, count: 2, scanComplete: true, state: 'anomalous' };
 const result = await W.queryWorkerProgress({ getWorkerTasks: async (_, o) => {
  if (o.diagnosticsOnly) throw Error('log disconnected');
  return { ...f.snapshot, resultsOnly: true, metadataOnly: true, tasks: [{ ...f.task, observation: { ...f.task.observation,
   result: { runId: commandId, status: 'completed', present: true, verified: true, artifactsComplete: true } } }] };
 } }, 'w', [f.query], f.snapshot);
 assert.equal(result.tasks[0].completionState, 'review_required'); assert.equal(result.tasks[0].runtimeDiagnostics.count, 2);
 assert.equal(result.tasks[0].successful, false);
});
test('publication timing is stable for reused evidence and changes only for new observations', () => {
 const f = fixture(Date.now()), timing = { networkStartedAt: at(Date.now()), receivedAt: at(Date.now()) };
 f.task.observation.evidence = { execution: timing };
 const host = { lastWorkerTaskSnapshots: new Map(), workerTaskSnapshotDiskCache: new Map(), noteWorkerTaskPlanStatus() {} };
 const store = method('storeWorkerTaskSnapshot', {});
 store.call(host, 'key', f.snapshot);
 const first = host.lastWorkerTaskSnapshots.get('key').tasks[0].observation.evidence.execution.publishedAt;
 const next = structuredClone(f.snapshot); next.tasks[0].observation.evidence.execution.publishedAt = 'forged';
 store.call(host, 'key', next);
 assert.equal(host.lastWorkerTaskSnapshots.get('key').tasks[0].observation.evidence.execution.publishedAt, first);
});

test('continuous execution polling is not coalesced behind a blocked metadata round', async () => {
 let release, inventories = 0, metadata = 0;
 const blocked = new Promise(resolve => { release = resolve; });
 const host = { distributedQueueRoot: 'project', distributedQueueCache: { plans: [{}] }, isRealtimeMode: () => true,
  workerActionTargets: () => [{ id: 'w' }], postState() {}, readWorkerTaskSnapshot: async (_, options) => {
   if (options.executionOnly) { inventories++; return {}; }
   metadata++; return blocked;
  } };
 const refresh = method('refreshServerPlanProgress', { AbortController, workspaceRoot: () => 'project', DistributedSchedulingPolicy: P });
 const first = refresh.call(host); await new Promise(setImmediate);
 const second = refresh.call(host); await new Promise(setImmediate);
 assert.equal(metadata, 1); assert.equal(inventories, 2);
 release({}); await Promise.all([first, second]);
});

test('failed execution-only observations keep independently verified artifact and log lanes', async () => {
 const f = fixture(Date.now()), stamp = { networkStartedAt: at(Date.now()), receivedAt: at(Date.now()) };
 f.snapshot.tasks[0].observation.evidence = { execution: stamp, artifacts: stamp, logs: stamp };
 f.snapshot.tasks[0].observation.result = { runId: commandId, status: 'completed', present: true, verified: true, artifactsComplete: true };
 f.snapshot.tasks[0].observation.runtimeDiagnostics = { schemaVersion: 1, commandId, runId: commandId, state: 'clear', count: 0, scanComplete: true };
 let stored;
 const host = { client: { getWorkerTasks: async () => { throw Error('execution request unavailable'); } },
  loadDistributedQueue: async () => f.queue, cachedWorkerTaskSnapshot: () => f.snapshot,
  storeWorkerTaskSnapshot: (_, s) => { stored = s; }, postState() {} };
 await method('refreshWorkerTaskSnapshot', { workspaceRoot: () => '/project', WorkerProgressQuery: W,
  workerTaskSnapshotPayload: x => x, errorMessage: e => e.message, RequestBudget_1: { RequestBudgetDeniedError: class extends Error {} } })
  .call(host, 'w', '/project', 'key', { executionOnly: true });
 const obs = require('../../src/features/WorkerProgressEvidence.ts').freshTaskObservation(stored, stored.tasks[0], {}, Date.now(), 20000);
 const state = require('../../src/features/TaskLifecycle.ts').taskLifecycle(obs);
 assert.equal(state.execution, 'unknown'); assert.equal(state.result, 'complete'); assert.equal(state.completionState, 'verified');
 assert.equal(stored.tasks[0].observation.evidence.execution.failed, true);
 assert.equal(stored.tasks[0].observation.evidence.artifacts.networkStartedAt, stamp.networkStartedAt);
});
