const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../../src/features/DistributedPlanQueue.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded.require = Module.createRequire(path.join(__dirname, '../../dist/features/DistributedPlanQueue.js'));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const api = loaded.exports;
const initialTime = Date.parse('2026-10-08T08:00:00Z');
const projectId = 'test-project';
let serial = 0;
function fixture(states = ['completed', 'failed', 'pending', 'pending', 'pending', 'pending'], id = 'current-plan', compatibility = true) {
  const queue = api.enqueuePlan(api.emptyDistributedQueue(), { projectId, planFile: 'plans/model.yaml', revision: 'rev',
    codeFingerprint: 'code', jobs: states.map((_, index) => ({ index, case: index < 3 ? 'bus' : 'pad', seed: 42 + index % 3,
      outputDir: `work_dirs/job${index}`, collectionResultCsv: `tmp/result/job${index}/metrics.csv` })) }, id, new Date(initialTime).toISOString());
  queue.plans[0].jobs.forEach((job, index) => {
    // This suite's historical health annotations operate on persisted declared v1 rows.
    if (compatibility) delete job.lifecycleProtocol;
    job.status = states[index];
    if (states[index] !== 'pending') Object.assign(job, { workerId: 'worker', gpuId: String(index),
      commandId: `command-${index}-${job.attempt}`, runKey: `command-${index}-${job.attempt}` });
    if (['completed', 'failed'].includes(job.status)) job.finishedAt = new Date(initialTime).toISOString();
    if (job.status === 'failed') job.error = 'RuntimeError: CUDA error: CUBLAS_STATUS_NOT_INITIALIZED';
  });
  return queue;
}
function snapshots(queue, now) {
  return [{ workerId: 'worker', generatedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(),
    capabilities: { durablePlanQueue: true, schemaVersion: 1, idleGpuAdmission: true },
    tasks: queue.plans.flatMap(plan => plan.jobs.filter(job => job.commandId).map(job => ({
      projectId, workflowId: plan.id, planRevision: plan.revision, planFile: plan.planFile, codeFingerprint: plan.codeFingerprint,
      planJobCount: plan.planJobCount, fullPlanJobCount: plan.fullPlanJobCount, enqueuedAt: plan.enqueuedAt,
      resultPathPolicy: plan.resultPathPolicy, globalJobId: job.globalJobId, collectionResultCsv: job.collectionResultCsv, experimentIndex: job.index, case: job.case, seed: job.seed,
      ...(job.attempt ? { attempt: job.attempt } : {}), outputDir: job.outputDir,
      commandId: job.commandId, runKey: job.runKey || job.commandId, workerId: job.workerId, gpuId: job.gpuId,
      status: job.status, finishedAt: job.finishedAt, error: job.error, stopReason: job.stopReason,
    }))) }];
}
function apply(queue, now = initialTime, evidence = snapshots(queue, now), extra = {}) {
  return api.scheduleAutomaticJobRetries(queue, evidence, projectId, { now,
    makeAttemptId: () => `auto-retry-${++serial}`, ...extra });
}
function failed(queue) { return queue.plans[0].jobs[1]; }

test('new protocol-2 jobs keep all health/retry metadata unchanged under historical retry policy', () => {
  const q = fixture(undefined, 'native-protocol-2', false), before = JSON.stringify(q);
  assert.ok(q.plans[0].jobs.every(job => job.lifecycleProtocol === 2));
  assert.equal(apply(q), q); assert.equal(JSON.stringify(q), before);
  assert.equal(serial, 0); assert.ok(q.plans[0].jobs.every(job => !job.automaticRetry));
});

test('a successful sibling records health but never authorizes automatic formal execution', () => {
  const original = fixture(), before=JSON.stringify(original);
  api.setDistributedQueueBaseSignature(original,'disk-signature');
  const result=apply(original);
  assert.equal(JSON.stringify(original),before);
  assert.equal(result.plans[0].automaticRetry.healthyReason,'completed');
  assert.equal(api.distributedQueueBaseSignature(result),'disk-signature');
  assertBlocked(result,original);
  assert.equal(apply(result,initialTime+1000),result);
  const reloaded=JSON.parse(JSON.stringify(result));
  assert.equal(apply(reloaded,initialTime+86400000),reloaded);
});
function assertBlocked(result,original){
  const job=failed(result), old=failed(original);
  assert.equal(job.status,'failed');assert.equal(job.attempt,0);
  assert.equal(job.outputDir,old.outputDir);assert.equal(job.globalJobId,old.globalJobId);
  assert.equal(job.commandId,old.commandId);assert.equal(job.history,undefined);
  assert.equal(job.automaticRetry.retryAt,undefined);
  assert.match(job.automaticRetry.blockedReason,/FORMAL_JOB_CONFLICT/);
  assert.equal(serial,0,'automatic policy must never mint a command or attempt id');
}
for(const error of [
  'AttributeError: missing forward','ModuleNotFoundError: missing dependency','SyntaxError: invalid syntax',
  'ValueError: invalid input','mat1 and mat2 shapes cannot be multiplied','CUDA error: device-side assert triggered',
  'CUDA out of memory','CUBLAS_STATUS_ALLOC_FAILED','all CUDA-capable devices are busy or unavailable',
  'CUBLAS_STATUS_NOT_INITIALIZED','ConnectionResetError: peer reset','worker exited with code 1','',
])test('formal failure remains review-only: '+(error||'no diagnostic'),()=>{
  const original=fixture(['queued','failed','pending','pending','pending','pending']);failed(original).error=error;
  const blocked=apply(original);assert.equal(blocked.plans[0].automaticRetry.healthyAt,undefined);
  assertBlocked(blocked,original);assert.equal(apply(blocked,initialTime+86400000),blocked);
});
test('only exact fresh successful evidence records health; no evidence can create a retry',()=>{
  const edits=[t=>{t.status='unknown'},t=>{t.seed=999},t=>{t.workflowId='foreign'},
    t=>{t.commandId='foreign'},t=>{t.outputDir='foreign'},t=>{t.globalJobId='foreign'},
    t=>{delete t.resultPathPolicy},t=>{t.identityConflict=true},t=>{t.manualStopType='manual'},t=>{t.stopReason='manual'}];
  for(const edit of edits){const original=fixture(),e=snapshots(original,initialTime);edit(e[0].tasks[0]);
    const result=apply(original,initialTime,e);assert.equal(result.plans[0].automaticRetry.healthyAt,undefined);assertBlocked(result,original);}
  const original=fixture(),e=snapshots(original,initialTime);
  assert.equal(apply(original,initialTime+180001,e).plans[0].automaticRetry.healthyAt,undefined);
});
test('majority health uses the full configured count and survives later failure without launching',()=>{
  for(const count of [0,3,4]){const original=fixture(['failed','pending',...Array(count).fill('running'),...Array(4-count).fill('queued')]);
    const result=apply(original);assert.equal(Boolean(result.plans[0].automaticRetry.healthyAt),count===4);
    assert.ok(result.plans[0].jobs[0].automaticRetry.blockedReason);
    if(count===4){result.plans[0].jobs.slice(2).forEach(j=>{j.status='failed'});
      const later=apply(result,initialTime+1000);assert.equal(later.plans[0].automaticRetry.healthyReason,'majority_running');
      assert.ok(later.plans[0].jobs.filter(j=>j.status==='failed').every(j=>!j.automaticRetry.retryAt));}
  }
  const q=fixture(['failed','pending','running','running','running','running']);q.plans[0].fullPlanJobCount=8;
  assert.equal(apply(q).plans[0].automaticRetry.healthyAt,undefined);
});
test('historical retry deadlines and attempt output remain read-only after upgrade',()=>{
  const q=fixture();delete q.plans[0].resultPathPolicy;
  for(const j of q.plans[0].jobs){j.attempt=1;j.outputDir+='/attempts/old';}
  failed(q).automaticRetry={failureCount:1,retryAt:new Date(initialTime+30000).toISOString()};
  const before=JSON.stringify(q);assert.equal(apply(q,initialTime+86400000),q);assert.equal(JSON.stringify(q),before);
  assert.throws(()=>api.retryVerifiedJob(q,q.plans[0].id,1,'manual-new-command'),/HISTORICAL_ATTEMPT_READ_ONLY/);
  assert.equal(api.allocateAvailable(q,[{workerId:'worker',online:true,declaredJobPaths:true,idleGpuIds:['9']}]).dispatches.length,0);
});
test('explicit stop, recovery conflict and excluded Plan preserve intent without scheduling',()=>{
  for(const edit of [p=>{p.automaticRetry.disabledAt='stopped'},p=>{p.recoveryConflict='conflict'}]){
    const q=fixture();edit(q.plans[0]);const before=JSON.stringify(q);assert.equal(apply(q),q);assert.equal(JSON.stringify(q),before);}
  const q=fixture();assert.equal(apply(q,initialTime,snapshots(q,initialTime),{excludedPlanFiles:['plans/model.yaml']}),q);
  const stopped=api.disableAutomaticJobRetries(apply(q),'plans/model.yaml');assert.equal(apply(stopped),stopped);
});
test('completed exact receipt clears an old retry deadline; foreign receipt retains evidence',()=>{
  const q=fixture();q.plans[0].jobs[1].status='completed';failed(q).automaticRetry={failureCount:2,retryAt:'old-deadline'};
  const evidence=snapshots(q,initialTime),foreign=structuredClone(evidence);foreign[0].tasks[1].globalJobId='foreign';
  assert.equal(failed(apply(q,initialTime,foreign)).automaticRetry.retryAt,'old-deadline');
  assert.equal(failed(apply(q,initialTime,evidence)).automaticRetry,undefined);
});
test('explicit verified manual retry keeps formal directory and records the previous failure',()=>{
  const q=fixture();failed(q).error='fixed manually after review';
  const next=api.retryVerifiedJob(q,q.plans[0].id,1,'manual-fixed-command');
  assert.equal(failed(next).status,'pending');assert.equal(failed(next).attempt,0);
  assert.equal(failed(next).outputDir,failed(q).outputDir);assert.equal(failed(next).globalJobId,failed(q).globalJobId);
  assert.equal(failed(next).nextCommandId,'manual-fixed-command');assert.equal(failed(next).commandId,undefined);
  assert.equal(failed(next).history.at(-1).error,failed(q).error);assert.equal(failed(q).status,'failed');
});
test('failure classification remains diagnostic and cannot authorize formal automatic retry',()=>{
  for(const [error,expected]of [['AttributeError: missing','deterministic'],['CUDA out of memory','resource'],
    ['CUBLAS_STATUS_NOT_INITIALIZED','transient'],['worker exited','unknown']]){
    assert.equal(api.classifyAutomaticJobFailure(error).failureClass,expected);
    const q=fixture();failed(q).error=error;assertBlocked(apply(q),q);
  }
});
