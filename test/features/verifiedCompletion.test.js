const test = require('node:test'), assert = require('node:assert/strict');
require('../_helpers/registerTsRequire');
const Q = require('../../src/features/DistributedPlanQueue.ts');
const P = require('../../src/features/DistributedSchedulingPolicy.ts');
const { summarizePlanStatuses } = require('../../src/features/PanelPlanStatusSummary.ts');
const now = Date.now(), iso = n => new Date(n).toISOString();
function fixture() {
 const job = { index: 0, lifecycleProtocol: 2, status: 'unknown', workerId: 'w', commandId: 'c', outputDir: 'work/c', collectionResultCsv: 'work/c/test.csv' };
 const queue = { schemaVersion: 1, plans: [{ id: 'plan', projectId: 'p', planFile: 'p.yaml', resultPathPolicy: 'declared', jobs: [job] }] };
 const timing = { networkStartedAt: iso(now), receivedAt: iso(now) };
 const observation = { lifecycleProtocol: 2, commandId: 'c', projectId: 'p', workerId: 'w', observedAt: iso(now),
  evidence: { execution: timing, artifacts: timing, logs: timing }, tmux: { dead: true, exitCode: 0, phase: 'running' },
  result: { runId: 'c', identityMatches: true, status: 'completed', present: true, verified: true, artifactsComplete: true },
  runtimeDiagnostics: { schemaVersion: 1, commandId: 'c', runId: 'c', state: 'clear', count: 0, scanComplete: true } };
 const snapshot = { workerId: 'w', fetchedAt: iso(now), queryComplete: true, capabilities: { taskLifecycle: 2 },
  tasks: [{ ...job, projectId: 'p', observation }] };
 return { queue, snapshot };
}
const project = (queue, snapshots, time = now) => ({ ...queue, plans: P.serverAuthoritativeProgress(queue, snapshots, 'p', time) });
test('only exact clean completion creates a compact persistent confirmation', () => {
 const f = fixture(), complete = project(f.queue, [f.snapshot]);
 const proof = complete.plans[0].jobs[0].verifiedCompletion;
 assert.equal(proof.schemaVersion, 1); assert.equal(proof.verifiedAt, iso(now));
 const serialized = Q.serializeDistributedQueue(complete), restored = Q.restoreFormalJobQueue(JSON.parse(serialized));
 assert.equal(restored.plans[0].jobs[0].status, 'completed'); assert.deepEqual(restored.plans[0].jobs[0].verifiedCompletion, proof);
 assert.equal(restored.plans[0].jobs[0].lastObservedAt, undefined, 'confirmation never invents a fresh observation');
 assert.equal(serialized.includes('evidence'), false); assert.equal(serialized.includes('tmux'), false);
});
test('expiry, disconnect, failed rechecks, empty inventories and missing responses keep confirmed completion and PLAN counts', () => {
 const f = fixture(), complete = project(f.queue, [f.snapshot]);
 const proof = structuredClone(complete.plans[0].jobs[0].verifiedCompletion);
 for (const snapshots of [[f.snapshot], [{ ...f.snapshot, error: 'offline' }], [], [{ ...f.snapshot, tasks: [] }]]) {
  const next = project(complete, snapshots, now + 3600000), job = next.plans[0].jobs[0];
  assert.equal(job.status, 'completed'); assert.equal(job.resultState, 'complete'); assert.equal(job.completionState, 'verified');
  assert.equal(job.statusQueryError, undefined); assert.deepEqual(job.verifiedCompletion, proof);
  const [summary] = summarizePlanStatuses({ plans: [{ file: 'p.yaml', jobCount: 1 }], distributedPlans: next.plans, topologyMode: 'worker_pool' });
  assert.equal(summary.completedCount, 1); assert.equal(summary.failedCount, 0);
 }
});
test('unverified artifacts or logs, failed exit and an unrelated run cannot establish confirmation', () => {
 for (const alter of [o => o.runtimeDiagnostics.scanComplete = false, o => o.runtimeDiagnostics.count = 1,
  o => o.result.verified = false, o => o.tmux.exitCode = 7, o => o.result.runId = 'other']) {
  const f = fixture(); alter(f.snapshot.tasks[0].observation);
  assert.equal(project(f.queue, [f.snapshot]).plans[0].jobs[0].verifiedCompletion, undefined);
 }
});
test('new positive artifact defects revoke confirmation; failed or ambiguous reads do not', () => {
 const f = fixture(), complete = project(f.queue, [f.snapshot]);
 for (const defect of ['missing', 'bad-size', 'wrong-run', 'failed-read', 'ambiguous-null']) {
  const fresh = structuredClone(f.snapshot), t = iso(now + 1000), obs = fresh.tasks[0].observation;
  fresh.fetchedAt = t; for (const lane of Object.keys(obs.evidence)) obs.evidence[lane] = { networkStartedAt: t, receivedAt: t };
  if (defect === 'missing') { obs.result = null; obs.artifactIssue = 'missing_or_invalid_manifest'; }
  if (defect === 'bad-size') { obs.result.present = false; obs.result.artifactsComplete = false; }
  if (defect === 'wrong-run') obs.result.runId = 'other';
  if (defect === 'failed-read') { obs.result = undefined; obs.resultQueryError = 'NFS unavailable'; }
  if (defect === 'ambiguous-null') obs.result = null;
  const job = project(complete, [fresh], now + 1000).plans[0].jobs[0];
  if (['failed-read', 'ambiguous-null'].includes(defect)) { assert.equal(job.status, 'completed'); assert.ok(job.verifiedCompletion); }
  else { assert.equal(job.status, 'unknown'); assert.equal(job.verifiedCompletion, undefined); }
 }
});
test('a new real nonzero exit or observed exception remains visible and releases the clean confirmation', () => {
 for (const kind of ['exit', 'exception']) {
  const f = fixture(), complete = project(f.queue, [f.snapshot]), fresh = structuredClone(f.snapshot), t = iso(now + 1000);
  fresh.fetchedAt = t; const obs = fresh.tasks[0].observation;
  for (const lane of Object.keys(obs.evidence)) obs.evidence[lane] = { networkStartedAt: t, receivedAt: t };
  if (kind === 'exit') obs.tmux.exitCode = 7;
  else { obs.runtimeDiagnostics.count = 1; obs.runtimeDiagnostics.state = 'anomalous'; }
  const projected = project(complete, [fresh], now + 1000), job = projected.plans[0].jobs[0];
  assert.equal(job.verifiedCompletion, undefined); assert.equal(job.status, 'failed');
  const [summary]=summarizePlanStatuses({plans:[{file:'p.yaml',jobCount:1}],distributedPlans:projected.plans,topologyMode:'worker_pool'});
  assert.equal(summary.status,'failed');assert.equal(summary.completedCount,0);assert.equal(summary.failedCount,1);
  if (kind === 'exception') assert.equal(job.completionState, 'review_required');
 }
});
test('confirmed facts do not cross command, Worker or output boundaries, and late old defects cannot revoke them', () => {
 const f = fixture(), complete = project(f.queue, [f.snapshot]);
 for (const [field, value] of [['commandId', 'other'], ['workerId', 'other'], ['outputDir', 'work/new']]) {
  const changed = structuredClone(complete); changed.plans[0].jobs[0][field] = value;
  const restored = Q.restoreFormalJobQueue(JSON.parse(Q.serializeDistributedQueue(changed)));
  assert.equal(restored.plans[0].jobs[0].verifiedCompletion, undefined); assert.equal(restored.plans[0].jobs[0].status, 'unknown');
 }
 const late = structuredClone(f.snapshot); late.tasks[0].observation.result.present = false;
 assert.equal(project(complete, [late], now + 1000).plans[0].jobs[0].status, 'completed');
});
test('confirmation updates touch only existing exact jobs and have a stable no-op path', () => {
 const f = fixture(), next = Q.updateVerifiedCompletions(f.queue, f.snapshot, 'p', now);
 assert.ok(next.plans[0].jobs[0].verifiedCompletion); assert.equal(Q.updateVerifiedCompletions(next, f.snapshot, 'p', now + 1000), undefined);
 assert.equal(Q.updateVerifiedCompletions({ schemaVersion: 1, plans: [] }, f.snapshot, 'p', now), undefined);
});
test('a fresh response for the same command cannot confirm different declared artifact paths', () => {
 for (const field of ['outputDir', 'collectionResultCsv']) {
  const f = fixture(); f.queue.plans[0].jobs[0][field] = 'work/other';
  const job = project(f.queue, [f.snapshot]).plans[0].jobs[0];
  assert.equal(job.status, 'unknown'); assert.equal(job.verifiedCompletion, undefined);
 }
});
