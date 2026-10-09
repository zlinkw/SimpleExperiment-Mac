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
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const api = loaded.exports;
const initialTime = Date.parse('2026-10-08T08:00:00Z');
const projectId = 'test-project';
let serial = 0;
function fixture(states = ['completed', 'failed', 'pending', 'pending', 'pending', 'pending'], id = 'current-plan') {
  const queue = api.enqueuePlan(api.emptyDistributedQueue(), { projectId, planFile: 'plans/model.yaml', revision: 'rev',
    codeFingerprint: 'code', jobs: states.map((_, index) => ({ index, case: index < 3 ? 'bus' : 'pad', seed: 42 + index % 3,
      outputDir: `work_dirs/job${index}/attempts/${id}` })) }, id, new Date(initialTime).toISOString());
  queue.plans[0].jobs.forEach((job, index) => {
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
      experimentIndex: job.index, case: job.case, seed: job.seed, attempt: job.attempt, outputDir: job.outputDir,
      commandId: job.commandId, runKey: job.runKey || job.commandId, workerId: job.workerId, gpuId: job.gpuId,
      status: job.status, finishedAt: job.finishedAt, error: job.error, stopReason: job.stopReason,
    }))) }];
}
function apply(queue, now = initialTime, evidence = snapshots(queue, now), extra = {}) {
  return api.scheduleAutomaticJobRetries(queue, evidence, projectId, { now,
    makeAttemptId: () => `auto-retry-${++serial}`, ...extra });
}
function failed(queue) { return queue.plans[0].jobs[1]; }

test('one exact successful job enables a durable, idempotent 30 second retry', () => {
  const original = fixture();
  api.setDistributedQueueBaseSignature(original, 'disk-signature');
  const queue = apply(original);
  assert.equal(original.plans[0].automaticRetry.healthyAt, undefined, 'input must not mutate');
  assert.equal(failed(original).automaticRetry, undefined);
  assert.equal(queue.plans[0].automaticRetry.healthyReason, 'completed');
  assert.equal(failed(queue).automaticRetry.failureCount, 1);
  assert.equal(Date.parse(failed(queue).automaticRetry.retryAt), initialTime + 30000);
  assert.equal(api.distributedQueueBaseSignature(queue), 'disk-signature');
  assert.equal(apply(queue, initialTime + 1000), queue, 'repeated snapshots do not reset the deadline or increment counts');
  const restarted = JSON.parse(JSON.stringify(queue));
  assert.equal(apply(restarted, initialTime + 29999), restarted);
  const next = apply(restarted, initialTime + 30000);
  assert.equal(failed(next).status, 'pending');
  assert.equal(failed(next).attempt, 2);
  assert.equal(failed(next).workerId, undefined);
  assert.equal(failed(next).commandId, undefined);
  assert.notEqual(failed(next).outputDir, failed(queue).outputDir);
  assert.equal(failed(next).history[0].outputDir, failed(queue).outputDir);
  assert.equal(failed(next).history[0].error, 'RuntimeError: CUDA error: CUBLAS_STATUS_NOT_INITIALIZED');
  assert.equal(failed(next).automaticRetry.failureCount, 1);
  assert.equal(next.plans[0].jobs[0].status, 'completed');
});

test('strictly more than half normally running qualifies and stays qualified after a later failure', () => {
  for (const count of [0, 3, 4]) {
    const queue = fixture(['failed', 'pending', ...Array(count).fill('running'), ...Array(4 - count).fill('queued')]);
    const result = apply(queue);
    assert.equal(Boolean(result.plans[0].automaticRetry.healthyAt), count === 4);
    assert.equal(Boolean(result.plans[0].jobs[0].automaticRetry), count === 4);
    if (count === 4) {
      assert.equal(result.plans[0].automaticRetry.healthyReason, 'majority_running');
      result.plans[0].jobs.slice(2).forEach(job => { job.status = 'failed'; job.finishedAt = new Date(initialTime + 1000).toISOString(); });
      assert.equal(apply(result, initialTime + 1000).plans[0].jobs[2].automaticRetry.failureCount, 1);
    }
  }
  const queue = fixture(['failed', 'pending', 'running', 'running', 'running', 'running']);
  queue.plans[0].jobs[2].error = 'not normal';
  assert.equal(apply(queue).plans[0].automaticRetry.healthyAt, undefined);
  queue.plans[0].jobs[2].error = undefined;
  queue.plans[0].fullPlanJobCount = 8;
  assert.equal(apply(queue).plans[0].automaticRetry.healthyAt, undefined, 'use the full configured count');
});

test('an early failed job waits for a healthy sibling before scheduling', () => {
  const queue = fixture(['queued', 'failed', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(apply(queue), queue);
  queue.plans[0].jobs[0].status = 'completed';
  assert.equal(failed(apply(queue)).automaticRetry.failureCount, 1);
});

test('failure delays are 30/60/120/240 seconds and the fifth total failure is final', () => {
  let queue = fixture(), now = initialTime;
  for (let count = 1; count <= 5; count++) {
    queue = apply(queue, now);
    const retry = failed(queue).automaticRetry;
    assert.equal(retry.failureCount, count);
    if (count === 5) {
      assert.equal(retry.exhausted, true);
      assert.equal(retry.retryAt, undefined);
      assert.equal(apply(queue, now + 1000000), queue);
      assert.equal(failed(queue).status, 'failed');
      assert.equal(failed(queue).attempt, 5);
      assert.equal(failed(queue).history.length, 4);
      break;
    }
    const delay = 30000 * 2 ** (count - 1);
    assert.equal(Date.parse(retry.retryAt) - now, delay);
    assert.equal(apply(queue, now + delay - 1), queue);
    now += delay;
    queue = apply(queue, now);
    assert.equal(failed(queue).status, 'pending');
    Object.assign(failed(queue), { status: 'failed', workerId: 'worker', gpuId: '1', commandId: `command-retry-${count}`,
      runKey: `command-retry-${count}`, finishedAt: new Date(now).toISOString(), error: 'RuntimeError: CUDA error: CUBLAS_STATUS_NOT_INITIALIZED' });
  }
});

test('unknown, stopped, cancelled, stale, mismatched and incomplete failure proofs never requeue', () => {
  const edits = [
    task => { task.status = 'unknown'; }, task => { task.status = 'stopped'; }, task => { task.status = 'cancelled'; },
    task => { task.stopReason = 'user_cancel'; }, task => { task.manualStopType = 'manual'; },
    task => { task.finishedAt = undefined; }, task => { task.seed = 123; }, task => { task.workflowId = 'another-run'; },
    task => { task.codeFingerprint = 'other-code'; }, task => { task.commandId = 'another-command'; },
    task => { task.outputDir = 'different-output'; }, task => { task.identityConflict = true; },
  ];
  for (const edit of edits) {
    const queue = fixture(), evidence = snapshots(queue, initialTime);
    edit(evidence[0].tasks[1]);
    assert.equal(failed(apply(queue, initialTime, evidence)).automaticRetry, undefined);
  }
  const queue = apply(fixture());
  const stale = snapshots(queue, initialTime);
  assert.equal(apply(queue, initialTime + 180001, stale), queue, 'expired terminal proof cannot launch');
  for (const edit of [p => { p.recoveryConflict = 'conflict'; }, p => { p.jobs[1].recallRequested = true; },
    p => { p.jobs[1].recoveryConflict = true; }, p => { p.jobs[1].stopReason = 'manual'; }]) {
    const blocked = fixture(); edit(blocked.plans[0]);
    assert.equal(failed(apply(blocked)).automaticRetry, undefined);
  }
});

test('exit code can prove failure, but absent or successful exit code cannot', () => {
  for (const code of [undefined, 0, 1]) {
    const queue = fixture(), evidence = snapshots(queue, initialTime);
    evidence[0].tasks[1].finishedAt = undefined;
    evidence[0].tasks[1].exitCode = code;
    assert.equal(Boolean(failed(apply(queue, initialTime, evidence)).automaticRetry), code === 1);
  }
});

test('old successes and old abandoned runs do not enable new runs; current legacy run is adopted', () => {
  const old = fixture(), recent = fixture(['queued', 'failed', 'pending', 'pending', 'pending', 'pending'], 'new-plan');
  recent.plans[0].enqueuedAt = new Date(initialTime + 1000).toISOString();
  const combined = { ...recent, plans: [...old.plans, ...recent.plans] };
  const result = apply(combined, initialTime + 1000);
  assert.equal(result.plans[0].jobs[1].automaticRetry, undefined);
  assert.equal(result.plans[1].jobs[1].automaticRetry, undefined);
  const legacy = fixture(['completed', 'failed', 'completed', 'completed', 'completed', 'completed']);
  delete legacy.plans[0].automaticRetry;
  assert.equal(apply(legacy), legacy);
  assert.equal(failed(apply(legacy, initialTime, snapshots(legacy, initialTime), { selectedPlanFile: 'plans/model.yaml' })).automaticRetry.failureCount, 1);
  legacy.plans[0].jobs[5].status = 'running';
  assert.equal(failed(apply(legacy)).automaticRetry.failureCount, 1);
  assert.equal(apply(legacy, initialTime, snapshots(legacy, initialTime), { excludedPlanFiles: ['plans/model.yaml'] }), legacy);
});

test('explicit stop disables scheduled retries durably and keeps other Plans untouched', () => {
  const queue = apply(fixture());
  queue.plans.push({ ...fixture().plans[0], id: 'unrelated', planFile: 'plans/unrelated.yaml' });
  const stopped = api.disableAutomaticJobRetries(queue, 'plans/model.yaml', new Date(initialTime).toISOString());
  assert.equal(failed(stopped).automaticRetry.retryAt, undefined);
  assert.equal(stopped.plans[0].automaticRetry.disabledAt, new Date(initialTime).toISOString());
  assert.equal(stopped.plans[1], queue.plans[1]);
  const restarted = JSON.parse(JSON.stringify(stopped));
  const result = apply(restarted, initialTime + 100000);
  assert.equal(failed(result).status, 'failed');
  assert.equal(failed(result).attempt, 1);
});

test('remote history merge keeps retry count, old failure details and new attempt; success resets the counter', () => {
  const scheduled = apply(fixture()), old = snapshots(scheduled, initialTime + 30000);
  const retried = apply(scheduled, initialTime + 30000, old);
  const reconciled = api.mergeDurableWorkerSnapshots(retried, old, projectId, initialTime + 30000);
  assert.equal(failed(reconciled).status, 'pending');
  assert.equal(failed(reconciled).automaticRetry.failureCount, 1);
  assert.equal(failed(reconciled).history.length, 1);
  assert.equal(failed(reconciled).history[0].error, 'RuntimeError: CUDA error: CUBLAS_STATUS_NOT_INITIALIZED');
  Object.assign(failed(reconciled), { status: 'running', workerId: 'worker', gpuId: '1', commandId: 'second-attempt', runKey: 'second-attempt' });
  const terminal = snapshots(reconciled, initialTime + 60000);
  terminal[0].tasks[1].status = 'completed';
  terminal[0].tasks[1].finishedAt = new Date(initialTime + 60000).toISOString();
  terminal[0].tasks.push(old[0].tasks[1]);
  const merged = api.mergeDurableWorkerSnapshots(reconciled, terminal, projectId, initialTime + 60000);
  const success = apply(merged, initialTime + 60000, terminal);
  assert.equal(failed(success).status, 'completed');
  assert.equal(failed(success).automaticRetry, undefined);
  assert.equal(failed(success).history[0].error, 'RuntimeError: CUDA error: CUBLAS_STATUS_NOT_INITIALIZED');
});

test('attempt ids cannot reuse or escape existing output paths', () => {
  const queue = apply(fixture());
  assert.throws(() => apply(queue, initialTime + 30000, snapshots(queue, initialTime + 30000), { makeAttemptId: () => 'current-plan' }), /already in use/);
  failed(queue).outputDir = '../unsafe/attempts/current-plan';
  assert.throws(() => apply(queue, initialTime + 30000), /directory is invalid/);
});

test('startup majority does not turn a shared project AttributeError into thirty launches', () => {
  let queue = apply(fixture(Array(6).fill('running')));
  assert.equal(queue.plans[0].automaticRetry.healthyReason, 'majority_running');
  queue.plans[0].jobs.forEach(job => Object.assign(job, { status: 'failed', finishedAt: new Date(initialTime + 60000).toISOString(),
    error: "AttributeError: 'JointEncoder' object has no attribute 'encode_token_features'" }));
  queue = apply(queue, initialTime + 60000);
  for (const job of queue.plans[0].jobs) {
    assert.equal(job.automaticRetry.retryAt, undefined);
    assert.equal(job.automaticRetry.failureClass, 'deterministic');
    assert.ok(job.automaticRetry.blockedReason);
    assert.equal(job.attempt, 1); assert.equal(job.history, undefined);
  }
  assert.equal(apply(queue, initialTime + 1000000), queue, 'reload and repeated polls must never create another attempt');
});

for (const [error, failureClass] of [
  ['AttributeError: model has no attribute forward', 'deterministic'],
  ['ModuleNotFoundError: missing_dependency', 'deterministic'],
  ['SyntaxError: invalid syntax', 'deterministic'],
  ['ValueError: invalid configuration', 'deterministic'],
  ['RuntimeError: mat1 and mat2 shapes cannot be multiplied (32x20 and 40x5)', 'deterministic'],
  ['RuntimeError: CUDA error: device-side assert triggered', 'deterministic'],
  ['worker exited with code 1', 'unknown'],
  ['', 'unknown'],
  ['AttributeError: missing member; caused after CUBLAS_STATUS_NOT_INITIALIZED', 'deterministic'],
]) test('a successful sibling does not authorize blind retry: ' + (error || 'no diagnostic'), () => {
  const original=fixture(); failed(original).error=error;
  const queue=apply(original);
  assert.equal(failed(queue).automaticRetry.retryAt,undefined);
  assert.equal(failed(queue).automaticRetry.failureClass,failureClass);
  assert.ok(failed(queue).automaticRetry.blockedReason);
  assert.equal(failed(queue).attempt,1);
  assert.equal(apply(queue,initialTime+1000000),queue);
});

test('an old retry deadline is revoked if fresh evidence identifies a code error', () => {
  const original=apply(fixture());
  const evidence=snapshots(original,initialTime+30000);
  evidence[0].tasks[1].error='TypeError: incompatible model input';
  const queue=apply(original,initialTime+30000,evidence);
  assert.equal(failed(original).automaticRetry.retryAt,new Date(initialTime+30000).toISOString());
  assert.equal(failed(queue).status,'failed'); assert.equal(failed(queue).attempt,1);
  assert.equal(failed(queue).automaticRetry.retryAt,undefined);
  assert.equal(failed(queue).automaticRetry.failureCount,1);
  assert.equal(failed(queue).automaticRetry.failureClass,'deterministic');
});

test('upgrade stops only an unsubmitted unsafe automatic attempt and leaves owned attempts alone', () => {
  const original=apply(apply(fixture()),initialTime+30000);
  const job=failed(original), error='AttributeError: missing method';
  job.automaticRetry.lastError=error; job.history.at(-1).error=error;
  const queue=apply(original,initialTime+30001);
  assert.equal(failed(queue).status,'failed');
  assert.equal(failed(queue).automaticRetry.retryAt,undefined);
  assert.ok(failed(queue).automaticRetry.blockedReason);
  assert.equal(failed(queue).attempt,2); assert.equal(failed(queue).history.length,1);
  assert.equal(failed(queue).commandId,undefined);
  for(const status of ['dispatching','queued','running']) {
    const owned=JSON.parse(JSON.stringify(original));
    Object.assign(failed(owned),{status,workerId:'worker',commandId:'owned-attempt',runKey:'owned-attempt'});
    const result=apply(owned,initialTime+30001);
    assert.equal(failed(result).status,status); assert.equal(failed(result).commandId,'owned-attempt');
  }
});

test('code failures are explained even without a healthy sibling; manual retry is still explicit', () => {
  const original=fixture(Array(6).fill('failed'));
  original.plans[0].jobs.forEach(job=>{job.error='AttributeError: missing method';});
  const blocked=apply(original);
  assert.equal(blocked.plans[0].automaticRetry.healthyAt,undefined);
  assert.ok(blocked.plans[0].jobs.every(job=>job.automaticRetry.blockedReason&&!job.automaticRetry.retryAt));
  const reloaded=JSON.parse(JSON.stringify(blocked));
  assert.equal(apply(reloaded,initialTime+100000),reloaded);
  const manual=api.retryVerifiedJob(reloaded,reloaded.plans[0].id,1,'manual-retry-fixed-code');
  assert.equal(failed(manual).status,'pending');assert.equal(failed(manual).automaticRetry,undefined);
  assert.equal(failed(manual).history.at(-1).error,'AttributeError: missing method');
  assert.equal(failed(apply(manual,initialTime+100001)).status,'pending','manual intent is not an automatic retry');
});

for(const error of ['ConnectionResetError: peer reset the connection','RuntimeError: CUDA initialization error'])
  test('explicit recoverable runtime failure retains bounded retry: '+error,()=>{
    const original=fixture();failed(original).error=error;
    const queue=apply(original);
    assert.equal(failed(queue).automaticRetry.failureClass,'transient');
    assert.equal(failed(queue).automaticRetry.blockedReason,undefined);
    assert.equal(Date.parse(failed(queue).automaticRetry.retryAt),initialTime+30000);
  });

for(const error of ['torch.OutOfMemoryError: CUDA out of memory','CUBLAS_STATUS_ALLOC_FAILED','all CUDA-capable devices are busy or unavailable'])
  test('resource failure returns to the queue even without a successful sibling: '+error,()=>{
    const original=fixture(['queued','failed','pending','pending','pending','pending']);failed(original).error=error;
    const scheduled=apply(original);
    assert.equal(scheduled.plans[0].automaticRetry.healthyAt,undefined);
    assert.equal(failed(scheduled).automaticRetry.failureClass,'resource');
    assert.equal(failed(scheduled).automaticRetry.blockedReason,undefined);
    assert.equal(Date.parse(failed(scheduled).automaticRetry.retryAt),initialTime+30000);
    const waiting=apply(scheduled,initialTime+30000);
    assert.equal(failed(waiting).status,'pending');assert.equal(failed(waiting).attempt,2);
    for(let tick=1;tick<=5;tick++)assert.equal(apply(waiting,initialTime+30000+tick*1000),waiting);
    assert.equal(failed(waiting).automaticRetry.failureCount,1,'waiting for a GPU is not another failed run');
  });

test('resource retries still stop after five actual failures',()=>{
  let queue=fixture(['queued','failed','pending','pending','pending','pending']),now=initialTime;
  for(let count=1;count<=5;count++){
    failed(queue).error='CUDA out of memory';queue=apply(queue,now);
    assert.equal(failed(queue).automaticRetry.failureCount,count);
    if(count===5){assert.equal(failed(queue).automaticRetry.exhausted,true);assert.equal(failed(queue).automaticRetry.retryAt,undefined);break;}
    now+=30000*2**(count-1);queue=apply(queue,now);
    assert.equal(failed(queue).status,'pending');
    Object.assign(failed(queue),{status:'failed',workerId:'worker',commandId:'oom-'+count,runKey:'oom-'+count,finishedAt:new Date(now).toISOString()});
  }
});

test('late verified diagnostics can resolve an unknown failure without incrementing its count or overriding code evidence', () => {
  for(const error of ['', 'AttributeError: missing method']){
    const original=fixture();failed(original).error=error;const stopped=apply(original);
    const evidence=snapshots(stopped,initialTime+1000);
    evidence[0].tasks[1].error='RuntimeError: CUDA initialization error';
    const queue=apply(stopped,initialTime+1000,evidence);
    assert.equal(failed(queue).automaticRetry.failureCount,1);
    if(error) assert.equal(failed(queue).automaticRetry.retryAt,undefined,'positive code evidence still needs manual review');
    else {
      assert.equal(failed(queue).automaticRetry.blockedReason,undefined);
      assert.equal(Date.parse(failed(queue).automaticRetry.retryAt),initialTime+31000);
      assert.equal(apply(queue,initialTime+2000,evidence),queue,'diagnostic refinement cannot restart its backoff');
    }
  }
});
