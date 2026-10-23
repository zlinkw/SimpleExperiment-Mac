const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../_helpers/registerTsRequire');
const api=require('../../src/features/DistributedPlanQueue.ts');
const now=Date.parse('2026-10-08T08:00:00Z');
function fixture(states) {
  const queue=api.enqueuePlan(api.emptyDistributedQueue(),{projectId:'project',planFile:'plans/model.yaml',revision:'rev',codeFingerprint:'code',executionMode:'train',
    jobs:states.map((_,index)=>({index,case:'case',seed:42+index,outputDir:`work_dirs/job${index}`,collectionResultCsv:`results/job${index}.csv`}))},'current',new Date(now).toISOString());
  queue.plans[0].jobs.forEach((job,index)=>Object.assign(job,{status:states[index],...(states[index]==='pending'?{}:{workerId:'worker',gpuId:String(index),commandId:'command-'+index,runKey:'command-'+index}),
    ...(['completed','failed'].includes(states[index])?{finishedAt:new Date(now).toISOString()}:{}),...(states[index]==='failed'?{error:'CUDA out of memory',exitCode:1}:{})}));
  return queue;
}
// The former automatic-attempt tests described the retired launch protocol.
// For protocol 2 every scenario must preserve the original command and output;
// active server observations, manual recall and two-confirmation cleanup own
// subsequent decisions. A healthy sibling never grants permission to rerun.
const cases=[
 ['a completed sibling', ['completed','failed','pending']],
 ['a running majority', ['running','running','failed']],
 ['an early failure without a healthy sibling', ['failed','pending','pending']],
 ['all resource failures', ['failed','failed','failed']],
 ['unknown ownership', ['unknown','failed','pending']],
 ['cancelled siblings', ['cancelled','failed','pending']],
 ['a deterministic shared code error', ['failed','failed','failed'],q=>q.plans[0].jobs.forEach(j=>j.error="AttributeError: missing encode_token_features")],
 ['an old persisted retry deadline', ['completed','failed'],q=>q.plans[0].jobs[1].automaticRetry={failureCount:4,retryAt:new Date(now-1).toISOString()}],
 ['a manual stop', ['completed','failed'],q=>q.plans[0].jobs[1].stopReason='user'],
 ['unchanged failure history', ['completed','failed'],q=>q.plans[0].jobs[1].history=[{attempt:0,status:'failed',outputDir:'work_dirs/prior',commandId:'prior',error:'old failure'}]],
 ['a stale snapshot', ['completed','failed'],undefined,'stale'],
 ['a foreign project snapshot', ['completed','failed'],undefined,'foreign'],
 ['a restarted desktop', ['completed','failed']],
 ['a missing exit code', ['completed','failed'],q=>delete q.plans[0].jobs[1].exitCode],
 ['zero exit with incomplete artifacts', ['completed','unknown'],q=>q.plans[0].jobs[1].exitCode=0],
 ['all five historical failures', ['completed','failed'],q=>q.plans[0].jobs[1].automaticRetry={failureCount:5,failedAttempt:0}],
];
for(const [name,states,change,kind] of cases)test('protocol 2 never allocates an automatic attempt after '+name,()=>{
  const queue=fixture(states);change?.(queue);api.setDistributedQueueBaseSignature(queue,'disk-baseline');const before=structuredClone(queue);api.setDistributedQueueBaseSignature(before,'disk-baseline');
  const snapshot={workerId:'worker',capabilities:{taskLifecycle:2,idleGpuAdmission:true},queryComplete:true,
    fetchedAt:new Date(kind==='stale'?now-600000:now).toISOString(),generatedAt:new Date(now).toISOString(),
    tasks:queue.plans[0].jobs.map(j=>({...j,projectId:kind==='foreign'?'foreign':'project',workflowId:'current',experimentIndex:j.index}))};
  for(const delay of [0,30000,60000,120000,240000,1000000]) {
    const result=api.scheduleAutomaticJobRetries(queue,[snapshot],'project',{now:now+delay,selectedPlanFile:'plans/model.yaml',makeAttemptId:()=>assert.fail('no automatic allocation')});
    assert.equal(result,queue);assert.deepEqual(queue,before);assert.equal(api.distributedQueueBaseSignature(queue),'disk-baseline');
  }
});
test('old attempt records remain read-only after reload, including past success and retry deadlines',()=>{
  const queue=fixture(['completed','failed']);delete queue.plans[0].resultPathPolicy;
  for(const j of queue.plans[0].jobs){delete j.lifecycleProtocol;j.attempt=1;j.outputDir+='/attempts/legacy';}
  const before=structuredClone(queue);const result=api.scheduleAutomaticJobRetries(queue,[],'project',{now:now+1000000,selectedPlanFile:'plans/model.yaml',makeAttemptId:()=>assert.fail('legacy history cannot allocate')});
  assert.equal(result,queue);assert.deepEqual(queue,before);
});
test('explicitly disabling old retry metadata is durable and leaves unrelated Plans untouched',()=>{
  const queue=fixture(['completed','failed']);const other=structuredClone(queue.plans[0]);other.id='other';other.planFile='plans/other.yaml';queue.plans.push(other);
  const disabled=api.disableAutomaticJobRetries(queue,'plans/model.yaml',new Date(now).toISOString());
  assert.equal(disabled.plans[0].automaticRetry.disabledAt,new Date(now).toISOString());assert.deepEqual(disabled.plans[1],other);
  assert.equal(queue.plans[0].automaticRetry.disabledAt,undefined);
});
