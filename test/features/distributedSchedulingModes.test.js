const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const path = require('node:path');
const original = require.extensions['.ts'];
require.extensions['.ts'] = (loaded, filename) => loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const queue = require('../../src/features/DistributedPlanQueue.ts');
const policy = require('../../src/features/DistributedSchedulingPolicy.ts');
require.extensions['.ts'] = original;
function plan(mode, id = 'plan', fingerprint = 'f', count = 20) {
  return queue.enqueuePlan(queue.emptyDistributedQueue(), { schedulingMode: mode,
    projectId: 'project', planFile: `${id}.yaml`, revision: 'r', codeFingerprint: fingerprint,
    jobs: Array.from({ length: count }, (_, index) => ({ index, case: 'bus', seed: index, outputDir: `runs/${id}/${index}` })) }, id);
}
const gpu = (index, processes = [], util = processes.length ? 95 : 0) => ({ index, utilizationPercent: util,
  memoryUsedMb: processes.length ? 1500 : 7, processCount: processes.length, processes });

test('default local mode never preassigns occupied NWPU5 and reserves each idle NWPU3 GPU once', () => {
  assert.equal(policy.schedulingMode(undefined), 'local_idle');
  assert.equal(policy.schedulingMode('bad'), 'local_idle');
  const input = plan('local_idle');
  const workers = [{ workerId: 'nwpu3', online: true, codeFingerprint: 'f', idleGpuAdmission: true, idleGpuIds: ['0','1','2'] },
    { workerId: 'nwpu5', online: true, codeFingerprint: 'f', idleGpuAdmission: true, idleGpuIds: [] }];
  const next = queue.allocateAvailable(input, workers, { requireIdleGpuAdmission: true, localIdleOnly: true });
  assert.equal(next.dispatches.length, 3);
  assert.ok(next.dispatches.every((row) => row.workerId === 'nwpu3'));
  assert.equal(new Set(next.dispatches.map((row) => row.gpuId)).size, 3);
  assert.equal(next.queue.plans[0].jobs.filter((row) => !row.workerId && !row.commandId).length, 17);
  assert.equal(policy.allocateServerPrequeue(input, [{workerId:'nwpu5',online:true,weight:2,codeFingerprint:'f'}]).dispatches.length, 0);
});

test('prequeue weights count idle plus own GPU once, excluding mixed or unknown owners and enforcing capacity', () => {
  const owner = { currentUser: 'alice', myProcessMatchMode: 'username' };
  const rows = [gpu(0), gpu(1,[{username:'alice'},{username:'alice'}]), gpu(2,[{username:'bob'}]),
    gpu(3,[{username:'alice'},{username:'bob'}]), gpu(4,[{}])];
  assert.equal(policy.prequeueGpuWeight(rows, 5, 200, owner), 2);
  assert.equal(policy.prequeueGpuWeight(rows, 5, 200, owner, '', 1), 1);
  assert.equal(policy.prequeueGpuWeight([gpu(0,[{username:'remoteuser'}])], 5, 200, {}, 'remoteuser'), 1);
  assert.equal(policy.prequeueGpuWeight([{...gpu(0),memoryUsedMb:undefined}], 5, 200, owner), 0);
  assert.equal(policy.prequeueGpuWeight([{...gpu(0,[{username:'alice'}]),processCount:2}], 5, 200, owner), 0);
  for (const mode of ['both','command_contains']) {
    const byCommand={currentUser:'alice',myCommandKeywords:['train.py'],myProcessMatchMode:mode};
    assert.equal(policy.prequeueGpuWeight([gpu(0,[{username:'bob',command:'python train.py'}])],5,200,byCommand),0);
    assert.equal(policy.prequeueGpuWeight([gpu(0,[{command:'python train.py'}])],5,200,byCommand),0);
    assert.equal(policy.prequeueGpuWeight([gpu(0,[{username:'alice',command:'python train.py'},{username:'bob',command:'python train.py'}])],5,200,byCommand),0);
  }
});

test('hosted prequeue persists 3:2 ownership without GPUs; restart never duplicates or moves accepted identities', () => {
  const workers = [{workerId:'nwpu3',online:true,weight:3,codeFingerprint:'f'},
    {workerId:'nwpu5',online:true,weight:2,codeFingerprint:'f'}];
  const input = plan('server_prequeue');
  assert.equal(queue.allocateAvailable(input, [{workerId:'nwpu3',online:true,idleGpuAdmission:true,idleGpuIds:['0'],codeFingerprint:'f'}],
    {requireIdleGpuAdmission:true,localIdleOnly:true}).dispatches.length, 0);
  const allocated = policy.allocateServerPrequeue(input, workers);
  assert.equal(allocated.dispatches.length, 20);
  assert.equal(allocated.dispatches.filter((row) => row.workerId === 'nwpu3').length, 12);
  assert.equal(allocated.dispatches.filter((row) => row.workerId === 'nwpu5').length, 8);
  assert.ok(allocated.queue.plans[0].jobs.every((row) => row.gpuId === undefined && row.commandId));
  const restored = JSON.parse(JSON.stringify(allocated.queue));
  const before = restored.plans[0].jobs.map((row) => [row.workerId,row.commandId,row.attempt,row.outputDir]);
  assert.equal(policy.allocateServerPrequeue(restored, workers.map((row) => ({...row,weight:10}))).dispatches.length, 0);
  assert.deepEqual(restored.plans[0].jobs.map((row) => [row.workerId,row.commandId,row.attempt,row.outputDir]), before);
  assert.deepEqual(restored.plans[0].prequeueWeights, {nwpu3:3,nwpu5:2});
});

test('hosted allocation gates online/fingerprint independently per Worker', () => {
  const first = plan('server_prequeue', 'first', 'a', 1);
  const second = plan('server_prequeue', 'second', 'b', 1);
  const both = {...first,plans:[...first.plans,...second.plans]};
  assert.equal(policy.allocateServerPrequeue(first, [{workerId:'w',online:false,weight:3,codeFingerprint:'a'}]).dispatches.length, 0);
  const result = policy.allocateServerPrequeue(both, [{workerId:'a',online:true,weight:3,codeFingerprint:'a'},
    {workerId:'b',online:true,weight:3,codeFingerprint:'b'}]);
  assert.equal(result.dispatches.length, 2);
  assert.equal(result.dispatches[0].planId, 'first');
  assert.equal(result.queue.plans[1].jobs[0].workerId, 'b');
  const busy = {...both, plans: both.plans.map(row => ({...row, jobs: row.jobs.map(job => ({...job}))}))};
  Object.assign(busy.plans[0].jobs[0], {status:'running', workerId:'b', commandId:'old'});
  assert.equal(policy.allocateServerPrequeue(busy, [{workerId:'b',online:true,weight:3,codeFingerprint:'b'}]).dispatches.length, 0);
});
