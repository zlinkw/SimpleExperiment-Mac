const test = require('node:test'), assert = require('node:assert/strict');
require('../_helpers/registerTsRequire');
const { taskLifecycle, observationMatches } = require('../../src/features/TaskLifecycle.ts');
const base = { lifecycleProtocol:2, commandId:'c', projectId:'p', workerId:'w', observedAt:new Date().toISOString() };

test('explicit runtime errors fail an ended job despite exit zero and complete artifacts', () => {
  const runtimeDiagnostics={schemaVersion:1,commandId:'c',runId:'c',state:'anomalous',count:1,scanComplete:true};
  const result={runId:'c',status:'completed',present:true,verified:true,artifactsComplete:true,exitCode:0};
  const observed=taskLifecycle({...base,result,runtimeDiagnostics,tmux:{dead:true,exitCode:0}});
  assert.equal(observed.status,'failed');assert.equal(observed.exitCode,0);
  assert.equal(observed.execution,'exited');assert.equal(observed.result,'complete');
  assert.equal(taskLifecycle({...base,result,runtimeDiagnostics:{...runtimeDiagnostics,scanComplete:false},tmux:{dead:true,exitCode:0}}).status,'failed');
  assert.equal(taskLifecycle({...base,result,runtimeDiagnostics:{...runtimeDiagnostics,commandId:'old'},tmux:{dead:true,exitCode:0}}).status,'completed');
  assert.equal(taskLifecycle({...base,result,runtimeDiagnostics,tmux:{dead:false,phase:'running'}}).status,'running');
});
test('admitted and starting windows are not running until the task command begins', () => {
  for (const phase of ['queued','bound','admitted','starting'])
    assert.equal(taskLifecycle({...base, tmux:{windowId:'@1',paneId:'%1',dead:false,phase}}).status,'queued', phase);
  assert.equal(taskLifecycle({...base, tmux:{windowId:'@1',paneId:'%1',dead:false}}).status,'unknown');
});
test('pull evidence advances without an acceptance event; ended shell is not success', () => {
  assert.equal(taskLifecycle({...base, tmux:{dead:false, phase:'queued'}}).status,'queued');
  assert.equal(taskLifecycle({...base, tmux:{dead:false, phase:'running'}}).status,'running');
  assert.equal(taskLifecycle({...base, tmux:{dead:true,exitCode:0}}).execution,'exited');
  assert.equal(taskLifecycle({...base, tmux:{dead:true,exitCode:0}}).status,'unknown');
  assert.equal(taskLifecycle({...base, tmux:{dead:true,exitCode:3}}).status,'failed');
});
test('closed window recovers from result; failures and foreign results are not hidden', () => {
  const result={runId:'c',status:'completed',present:true,verified:true};
  assert.equal(taskLifecycle({...base,result}).status,'completed');
  assert.equal(taskLifecycle({...base,result,tmux:{dead:true,exitCode:1}}).status,'failed');
  assert.equal(taskLifecycle({...base,result:{...result,runId:'old'}}).result,'conflict');
  assert.equal(taskLifecycle({...base,result:{...result,present:false}}).status,'unknown');
  assert.equal(taskLifecycle({...base,queryError:'offline',result}).execution,'unknown');
  assert.equal(taskLifecycle(base).status,'unknown');
});
test('unknown exit codes use this run manifest without inventing an execution failure', () => {
  const result={runId:'c',status:'completed',present:true,verified:true};
  for (const exitCode of [undefined,null]) {
    const tmux={windowId:'@102',paneId:'%102',dead:true,phase:'running',exitCode};
    const observed=taskLifecycle({...base,tmux,result});
    assert.equal(observed.execution,'exited'); assert.equal(observed.result,'complete'); assert.equal(observed.status,'completed');
    assert.equal(observed.completionState,'unverified'); assert.equal(observed.exitCode,exitCode);
    for (const evidence of [undefined,{...result,runId:'old'},{...result,present:false},{...result,verified:false},{...result,status:'failed'}]) {
      const value=taskLifecycle({...base,tmux,result:evidence});
      assert.equal(value.execution,'exited');
      assert.equal(value.status,'unknown');
    }
    assert.equal(taskLifecycle({...base,tmux,result,queryError:'offline'}).status,'unknown');
  }
  for (const exitCode of [1,7,-9])
    assert.equal(taskLifecycle({...base,result,tmux:{dead:true,exitCode}}).status,'failed');
});
test('process exit, result completeness and runtime health are independent; old logs never prove clean success',()=>{
  const result={runId:'c',status:'completed',present:true,verified:true};
  const clear={schemaVersion:1,commandId:'c',runId:'c',state:'clear',count:0,scanComplete:true};
  const anomaly={...clear,state:'anomalous',count:1,types:{AttributeError:1},phases:{train:1}};
  const clean=taskLifecycle({...base,result,runtimeDiagnostics:clear,tmux:{dead:true,exitCode:0}});
  assert.equal(clean.completionState,'verified');assert.equal(clean.status,'completed');
  const review=taskLifecycle({...base,result,runtimeDiagnostics:anomaly,tmux:{dead:true,exitCode:0}});
  assert.equal(review.completionState,'review_required');assert.equal(review.exitCode,0);assert.equal(review.result,'complete');
  assert.equal(review.runtimeDiagnostics.phases.train,1);
  assert.equal(taskLifecycle({...base,result,runtimeDiagnostics:{...clear,commandId:'old'}}).completionState,'unverified');
  assert.equal(taskLifecycle({...base,result:{...result,exitCode:7},runtimeDiagnostics:clear}).status,'failed');
  assert.equal(taskLifecycle({...base,result:{...result,exitCode:7},runtimeDiagnostics:clear,tmux:{dead:true,exitCode:null}}).status,'failed');
  const failed=taskLifecycle({...base,result:{...result,status:'failed',artifactsComplete:true,exitCode:7},runtimeDiagnostics:anomaly});
  assert.equal(failed.status,'failed');assert.equal(failed.result,'complete');assert.equal(failed.completionState,'review_required');
});
test('queue refresh corrects the old Worker failure label using current tmux and manifest evidence', () => {
  const Q=require('../../src/features/DistributedPlanQueue.ts');
  const queue={schemaVersion:1,plans:[{id:'wf',projectId:'p',revision:'current',jobs:[{index:0,workerId:'w',commandId:'c',status:'failed'}]}]};
  const snapshot={workerId:'w',fetchedAt:base.observedAt,generatedAt:base.observedAt,capabilities:{taskLifecycle:2},tasks:[{
    commandId:'c',projectId:'p',status:'failed',observation:{...base,tmux:{windowId:'@102',paneId:'%102',dead:true,exitCode:null},
      result:{runId:'c',status:'completed',present:true,verified:true}}}]};
  assert.equal(Q.mergeDurableWorkerSnapshots(queue,[snapshot],'p').plans[0].jobs[0].status,'completed');
  snapshot.tasks[0].observation.tmux.exitCode=7;
  assert.equal(Q.mergeDurableWorkerSnapshots(queue,[snapshot],'p').plans[0].jobs[0].status,'failed');
});
test('live control matching ignores old revision but never another project or command', () => {
  assert.equal(observationMatches(base,base),true);
  assert.equal(observationMatches(base,{...base,projectId:'other'}),false);
  assert.equal(observationMatches(base,{...base,commandId:'other'}),false);
});
test('execution and results remain independent for live, missing, unreadable and conflicting evidence', () => {
  const result={runId:'c',status:'completed',present:true,verified:true};
  const live=taskLifecycle({...base,result,tmux:{dead:false,phase:'unrecognized'}});
  assert.equal(live.execution,'unknown');assert.equal(live.result,'complete');assert.equal(live.status,'unknown');
  const absent=taskLifecycle({...base,result:null,tmux:{dead:true,exitCode:0}});
  assert.equal(absent.result,'incomplete');assert.equal(absent.status,'unknown');
  assert.equal(taskLifecycle({...base,result:null,queryError:'offline'}).result,'unverified');
  const unreadable=taskLifecycle({...base,result,resultQueryError:'read failed',tmux:{dead:true,exitCode:0}});
  assert.equal(unreadable.result,'unverified');assert.equal(unreadable.status,'unknown');
  assert.equal(taskLifecycle({...base,result:{...result,identityMatches:false}}).result,'conflict');
});
test('mismatched live observations cannot preserve an old completed card', () => {
  const Q=require('../../src/features/DistributedPlanQueue.ts');
  const queue={schemaVersion:1,plans:[{id:'wf',projectId:'p',jobs:[{index:0,workerId:'w',commandId:'c',lifecycleProtocol:2,
    status:'completed',executionState:'exited',resultState:'complete'}]}]};
  const snapshot={workerId:'w',fetchedAt:base.observedAt,generatedAt:base.observedAt,capabilities:{taskLifecycle:2},tasks:[{
    commandId:'c',projectId:'p',observation:{...base,workerId:'other',result:{runId:'c',status:'completed',present:true,verified:true}}}]};
  const job=Q.mergeDurableWorkerSnapshots(queue,[snapshot],'p').plans[0].jobs[0];
  assert.equal(job.status,'unknown');assert.equal(job.executionState,'unknown');assert.equal(job.resultState,'unverified');
});
test('real manifest queries and client projection agree for every task mode and changed filesystem evidence', () => {
  const path=require('node:path'),{spawnSync}=require('node:child_process');
  const proc=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',
    path.join(__dirname,'taskManifestEvidence.fixture.py'),path.join(__dirname,'../../src/runtime/TmuxTaskLifecycle.ts')],
    {encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(proc.status,0,proc.stderr||proc.stdout);
  const cases=JSON.parse(proc.stdout);
  for(const item of cases){const state=taskLifecycle(item.observation);
    assert.deepEqual({executionState:state.execution,resultState:state.result,status:state.status},item.expected,item.name);}
  assert.ok(cases.length>=14);
});
test('the real queue merge consumes pulled evidence without a durable receipt or a matching old revision', () => {
  const Q=require('../../src/features/DistributedPlanQueue.ts');
  const queue={schemaVersion:1,plans:[{id:'wf',projectId:'p',revision:'current',jobs:[{index:0,workerId:'w',commandId:'c',status:'dispatching'}]}]};
  const snapshot={workerId:'w',fetchedAt:base.observedAt,generatedAt:base.observedAt,capabilities:{taskLifecycle:2},
    tasks:[{commandId:'c',projectId:'p',planRevision:'old',observation:{...base,tmux:{dead:false,phase:'running'}}}]};
  assert.equal(Q.mergeDurableWorkerSnapshots(queue,[snapshot],'p').plans[0].jobs[0].status,'running');
  snapshot.tasks[0].observation.queryError='query failed';
  assert.equal(Q.mergeDurableWorkerSnapshots(queue,[snapshot],'p').plans[0].jobs[0].status,'unknown');
  assert.equal(queue.plans[0].jobs[0].status,'dispatching');
});
test('live windows rebuild missing local cards; old cached snapshots cannot revive native execution',()=>{
  const Q=require('../../src/features/DistributedPlanQueue.ts'),now=new Date().toISOString();
  const task={workflowId:'wf',globalJobId:'wf:0',experimentIndex:0,commandId:'c',projectId:'p',workerId:'w',planFile:'experiments/plans/p.yaml',
    planRevision:'a'.repeat(64),codeFingerprint:'b'.repeat(64),case:'a',seed:42,outputDir:'work/job',collectionResultCsv:'tmp/result/job.csv',resultPathPolicy:'declared',
    observation:{...base,observedAt:now,tmux:{windowId:'@2',paneId:'%3',dead:false,phase:'running'}}};
  const live={workerId:'w',fetchedAt:now,generatedAt:now,capabilities:{taskLifecycle:2},tasks:[task]};
  const recovered=Q.mergeDurableWorkerSnapshots(Q.emptyDistributedQueue(),[live],'p');
  assert.equal(recovered.plans[0].jobs[0].status,'running');
  const legacy={...live,capabilities:{durablePlanQueue:true,schemaVersion:1}};
  assert.equal(Q.mergeDurableWorkerSnapshots(recovered,[legacy],'p').plans[0].jobs[0].status,'unknown');
  assert.equal(Q.mergeDurableWorkerSnapshots(Q.emptyDistributedQueue(),[{...live,error:'offline'}],'p').plans.length,0);
  const corrupted=JSON.parse(JSON.stringify(recovered));corrupted.plans[0].jobs[0].status='running';
  assert.equal(Q.restoreFormalJobQueue(corrupted).plans[0].jobs[0].status,'unknown');
  const missing=Q.mergeDurableWorkerSnapshots(recovered,[{...live,tasks:[{...task,observation:{...task.observation,tmux:undefined}}]}],'p');
  assert.equal(Q.workerCodeVersionAvailable(missing,'w','new-code'),true);
});
