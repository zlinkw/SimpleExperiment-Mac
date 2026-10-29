const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('../_helpers/registerTsRequire');
const D = require('../../src/features/DistributedPlanQueue.ts');
const B = require('../../src/features/GpuMemoryBudget.ts');
const Q = require('../../src/features/GpuQuotaScheduling.ts');
const gpu = (id, used = 0) => ({ index: String(id), name: 'fixture GPU', memoryTotalMb: 80 * 1024, memoryUsedMb: used, processes: [] });
const worker = (rows = [gpu(0), gpu(1)], patch = {}) => {
  const policy = Q.quotaSettings({ gpuJobsPerCard: 4, gpuMinFreeMemoryGb: 2 });
  return { workerId: 'w', online: true, idleGpuAdmission: true, declaredJobPaths: true, codeFingerprint: 'code',
    idleGpuIds: rows.map(row => row.index), gpuSlots: Q.quotaPlacement(rows, new Map(), policy).slots,
    gpuRows: rows, gpuPolicy: policy, gpuBudgetSupported: true, ...patch };
};
function plan(queue, id, count = 4) {
  return D.enqueuePlan(queue, { projectId: 'p', planFile: 'plans/' + id + '.yaml', revision: 'rev', codeFingerprint: 'code', executionMode: 'train',
    jobs: Array.from({ length: count }, (_, index) => ({ index, case: id, seed: index, outputDir: 'work/' + id + index, collectionResultCsv: 'result/' + id + index + '.csv' })) }, id);
}
function allocate(queue, workers = [worker()]) {
  return D.allocateAvailable(queue, workers, { requireIdleGpuAdmission: true, localIdleOnly: true, memoryBudget: B.memoryBudgetAdmission(queue, workers) });
}
function calibrated(queue, planId = 'a', peakMb = 12 * 1024) {
  const p = queue.plans.find(p => p.id === planId), job = p.jobs[0];
  Object.assign(job, { status: 'running', workerId: 'w', gpuId: '0', commandId: 'running-' + planId });
  job.gpuMemoryReservation = { version: 1, group: B.budgetGroup(p, job), hardware: B.budgetHardware('w', gpu(0)), budgetMb: 80 * 1024, probe: true };
  job.gpuMemoryProfile = { ...job.gpuMemoryReservation, commandId: job.commandId, projectId: 'p', peakMb, ready: true, oom: false };
  return queue;
}
function verified(plan,job){
 const V=require('../../src/features/VerifiedCompletion.ts');
 job.status='completed';job.lifecycleProtocol=2;job.verifiedCompletion={schemaVersion:1,identity:V.completionIdentity(plan,job),verifiedAt:'2026-10-29T02:00:00Z',exitCode:0};
}
test('PLAN estimates survive reload and source telemetry loss, then expire only when all declared jobs complete',()=>{
 const queue=calibrated(plan(D.emptyDistributedQueue(),'cached',4),'cached'),p=queue.plans[0];
 p.jobs[0].gpuMemoryProfile.ready=false;verified(p,p.jobs[0]);
 const restored=D.restoreFormalJobQueue(JSON.parse(D.serializeDistributedQueue(queue)));
 assert.equal(restored.plans[0].gpuMemoryEstimates.entries[0].ready,true,'a fully verified short run has observed its complete peak');
 delete restored.plans[0].jobs[0].gpuMemoryProfile;
 const again=D.restoreFormalJobQueue(JSON.parse(D.serializeDistributedQueue(restored)));
 const out=allocate(again,[worker([gpu(0)])]);assert.equal(out.dispatches.length,3);
 assert.ok(out.queue.plans[0].jobs.slice(1).every(j=>!j.gpuMemoryReservation.probe&&j.gpuMemoryReservation.estimate.peakMb===12*1024));
 const pending=out.queue.plans[0];pending.jobs.slice(1).forEach(j=>verified(pending,j));
 assert.equal(JSON.parse(D.serializeDistributedQueue(out.queue)).plans[0].gpuMemoryEstimates,undefined);
 assert.ok(out.queue.plans[0].jobs[0].verifiedCompletion,'completion facts are untouched');
});
test('cached PLAN estimates increase monotonically, keep OOM, and cannot cross runs, cases or hardware',()=>{
 const queue=calibrated(plan(D.emptyDistributedQueue(),'cache',3),'cache');
 const original=B.retainPlanMemoryEstimates(queue.plans[0]);
 const stale=structuredClone(original);stale.gpuMemoryEstimates=undefined;stale.jobs[0].gpuMemoryProfile.peakMb=1;
 assert.equal(B.retainPlanMemoryEstimates(stale,original).gpuMemoryEstimates.entries[0].peakMb,12*1024);
 const merged=D.retainQueueMemoryEstimates({schemaVersion:1,plans:[stale]},{schemaVersion:1,plans:[original]});
 assert.equal(JSON.parse(D.serializeDistributedQueue(merged)).plans[0].gpuMemoryEstimates.entries[0].peakMb,12*1024,'metadata save merges current disk estimates before serialization');
 const lower=structuredClone(original);lower.jobs[0].gpuMemoryProfile.ready=false;
 assert.equal(B.retainPlanMemoryEstimates(lower).gpuMemoryEstimates.entries[0].ready,true);
 lower.jobs[0].gpuMemoryProfile.oom=true;const oom=B.retainPlanMemoryEstimates(lower);
 delete lower.jobs[0].gpuMemoryProfile;lower.gpuMemoryEstimates=oom.gpuMemoryEstimates;
 assert.equal(allocate({schemaVersion:1,plans:[lower]}).dispatches.length,0);assert.equal(oom.gpuMemoryEstimates.entries[0].ready,false);
 for(const field of ['id','revision','codeFingerprint','executionMode','projectId']){
  const other=structuredClone(original);other[field]+='changed';other.jobs.forEach(j=>delete j.gpuMemoryProfile);
  assert.equal(B.retainPlanMemoryEstimates(other,original).gpuMemoryEstimates,undefined,field);
 }
 const otherCase=structuredClone(original);otherCase.jobs.forEach(j=>{j.case='different';delete j.gpuMemoryProfile;});
 assert.equal(B.retainPlanMemoryEstimates(otherCase).gpuMemoryEstimates,undefined);
 const noSource=structuredClone(original);verified(noSource,noSource.jobs[0]);delete noSource.jobs[0].gpuMemoryProfile;
 const otherWorker=worker([gpu(0)],{workerId:'other'});
 const probe=allocate({schemaVersion:1,plans:[noSource]},[otherWorker]);
 assert.equal(probe.dispatches.length,1);assert.equal(probe.queue.plans[0].jobs[1].gpuMemoryReservation.probe,true);
});
test('Worker-local automatic jobs keep memory budgets, quotas and distinct wait reasons with cached estimates',()=>{
 const queue=calibrated(plan(D.emptyDistributedQueue(),'restricted',6),'restricted');
 queue.plans[0].jobs.slice(1).forEach(j=>j.automaticWorkerId='w');
 const rows=[worker([gpu(0,55*1024)]),worker([gpu(0)],{workerId:'other'})];
 const out=allocate(queue,rows);assert.equal(out.dispatches.length,0);
 assert.match(out.queue.plans[0].jobs[1].gpuMemoryWaitReason,/已有 PLAN 显存估计/);
 const freed=allocate(out.queue,[worker([gpu(0)])]);assert.equal(freed.dispatches.length,3);
 assert.ok(freed.dispatches.every(d=>d.workerId==='w'));assert.equal(allocate(freed.queue,[worker([gpu(0)])]).dispatches.length,0);
});
test('different plans probe on separate cards; one unknown group never fans out before calibration', () => {
  const queue = plan(plan(D.emptyDistributedQueue(), 'a'), 'b');
  const out = allocate(queue);
  assert.equal(out.dispatches.length, 2);
  assert.equal(new Set(out.dispatches.map(d => d.planId)).size, 2);
  assert.equal(new Set(out.dispatches.map(d => d.gpuId)).size, 2);
  assert.ok(out.queue.plans.flatMap(p => p.jobs).filter(j => j.status === 'dispatching').every(j => j.gpuMemoryReservation.probe));
  assert.equal(allocate(out.queue).dispatches.length, 0, 'pending starts reserve the whole probe card across rounds');
  assert.ok(queue.plans.every(p => p.jobs.every(j => j.status === 'pending')), 'caller queue is immutable');
});
test('known jobs reserve unallocated peaks across polls and respect exact process attribution', () => {
  const queue = calibrated(plan(D.emptyDistributedQueue(), 'a', 10));
  const row = gpu(0, 12 * 1024);
  row.processes = [{ pid: '1', pluginManaged: true, jobCommandId: 'running-a', jobProjectId: 'p', usedMemoryMb: 12 * 1024 }];
  const out = allocate(queue, [worker([row])]);
  assert.equal(out.dispatches.length, 3, 'probe reservation becomes a measured budget, bounded by four jobs per card');
  assert.equal(allocate(out.queue, [worker([row])]).dispatches.length, 0);
  const tight = gpu(0, 55 * 1024);
  assert.equal(allocate(queue, [worker([tight])]).dispatches.length, 0, 'unknown attribution cannot borrow real used memory');
  row.processes.push({ ...row.processes[0] });
  assert.equal(allocate(queue, [worker([row])]).dispatches.length, 3, 'duplicate process rows never double-credit memory');
});
test('unmeasured configurations retain an empty card; running scouts are never preempted', () => {
  const queue = plan(calibrated(plan(D.emptyDistributedQueue(), 'a', 10)), 'b');
  const out = allocate(queue);
  const scout = out.dispatches.find(d => d.planId === 'b');
  assert.ok(scout); assert.equal(scout.gpuId, '1');
  assert.equal(out.queue.plans[0].jobs[0].commandId, 'running-a');
});
test('OOM, legacy Workers, missing telemetry and full quotas fail closed', () => {
  const queue = calibrated(plan(D.emptyDistributedQueue(), 'a'));
  queue.plans[0].jobs[0].gpuMemoryProfile.oom = true;
  assert.equal(allocate(queue).dispatches.length, 0);
  assert.equal(allocate(plan(D.emptyDistributedQueue(), 'a'), [worker(undefined, { gpuBudgetSupported: false })]).dispatches.length, 0);
  assert.equal(allocate(plan(D.emptyDistributedQueue(), 'a'), [worker([])]).dispatches.length, 0);
  const policy = Q.quotaSettings({}, { gpuJobsPerCard: 4, gpuCardOverrides: { '0': { gpuJobsPerCard: 0 } }, gpuMaxConcurrentCards: 0 });
  assert.equal(allocate(plan(D.emptyDistributedQueue(), 'a'), [worker([gpu(0)], { gpuPolicy: policy, gpuSlots: [] })]).dispatches.length, 0);
});
test('stale command/profile identities cannot grant ready budgets; growth increases every sibling reservation', () => {
  const queue = calibrated(plan(D.emptyDistributedQueue(), 'a', 10));
  queue.plans[0].jobs[0].gpuMemoryProfile.commandId = 'other';
  assert.equal(allocate(queue, [worker([gpu(0)])]).dispatches.length, 0);
  queue.plans[0].jobs[0].gpuMemoryProfile.commandId = 'running-a';
  queue.plans[0].jobs[0].gpuMemoryProfile.peakMb = 60 * 1024;
  assert.equal(allocate(queue, [worker([gpu(0, 10 * 1024)])]).dispatches.length, 0);
  assert.equal(B.budgetEvidence({ version: 1, commandId: 'c', projectId: 'p', group: 'g', hardware: 'h', peakMb: Infinity, ready: true, oom: false }, 'c', 'p'), undefined);
});
test('known work spreads onto free cards before sharing; large jobs retain exclusive capacity', () => {
  const queue = calibrated(plan(D.emptyDistributedQueue(), 'a', 10));
  const out = allocate(queue);
  assert.equal(out.dispatches[0].gpuId, '1');
  const large = calibrated(plan(D.emptyDistributedQueue(), 'large', 3), 'large', 72 * 1024);
  large.plans[0].jobs[0].status = 'completed';
  const single = allocate(large, [worker([gpu(0)])]);
  assert.equal(single.dispatches.length, 1);
  assert.equal(single.queue.plans[0].jobs[1].gpuMemoryReservation.exclusive, true);
});
test('serialization retains reservations and wait reasons; delayed observations cannot lower peaks or erase OOM', () => {
  const out = allocate(plan(D.emptyDistributedQueue(), 'a'));
  const restored = D.restoreFormalJobQueue(JSON.parse(D.serializeDistributedQueue(out.queue)));
  assert.deepEqual(restored.plans[0].jobs[0].gpuMemoryReservation, out.queue.plans[0].jobs[0].gpuMemoryReservation);
  assert.match(restored.plans[0].jobs[1].blockReason, /10 分钟/);
  const prior = calibrated(plan(D.emptyDistributedQueue(), 'a')).plans[0].jobs[0].gpuMemoryProfile;
  assert.equal(B.mergeBudgetEvidence({ ...prior, oom: true }, { ...prior, peakMb: 1 }).oom, true);
  assert.equal(B.mergeBudgetEvidence(prior, { ...prior, peakMb: 1 }).peakMb, prior.peakMb);
});
test('an OOM-paused plan never holds exploration capacity needed by another plan', () => {
  let queue = calibrated(plan(D.emptyDistributedQueue(), 'a', 2));
  queue.plans[0].jobs[0].status = 'completed';
  queue = calibrated(plan(queue, 'b', 2), 'b');
  queue.plans[1].jobs[0].status = 'failed';
  queue.plans[1].jobs[0].gpuMemoryProfile.oom = true;
  const out = allocate(queue, [worker([gpu(0)])]);
  assert.deepEqual(out.dispatches.map(d => d.planId), ['a']);
  assert.equal(out.queue.plans[1].jobs[1].status, 'pending');
});
test('native admission enforces timed observation, restart reservations, quotas, attribution and OOM', () => {
  const run = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8', path.join(__dirname, 'gpuMemoryBudget.fixture.py')],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout || run.error?.message);
  assert.deepEqual(JSON.parse(run.stdout), { timedProbe: true, reservation: true, oom: true });
});
test('real native controller persists probe exclusivity then shares only measured reservations', () => {
  const fixture = path.join(__dirname, 'gpuMemoryBudget.integration.fixture.py');
  const runtime = path.resolve(__dirname, '../../dist/runtime/cluster_agent.py');
  const linux = file => '/mnt/' + file[0].toLowerCase() + file.slice(2).replace(/\\/g, '/');
  const args = process.platform === 'win32'
    ? ['--distribution', process.env.SIMPLE_TEST_WSL_DISTRO || 'Ubuntu-Codex', '--exec', 'python3', linux(fixture), linux(runtime)]
    : [fixture, runtime];
  const run = spawnSync(process.platform === 'win32' ? 'wsl.exe' : 'python3', args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout || run.error?.message);
  assert.deepEqual(JSON.parse(run.stdout), { controller: true, probeExclusive: true, sharedReservations: 3 });
});
