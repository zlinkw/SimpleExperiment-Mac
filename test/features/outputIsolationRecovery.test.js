const test=require('node:test'),assert=require('node:assert/strict');
require('../_helpers/registerTsRequire');
const Q=require('../../src/features/DistributedPlanQueue.ts');
const R=require('../../src/features/OutputIsolationRecovery.ts');
const {OutputIsolationRecoveryHost,queueOutputIsolationRecovery}=require('../../src/extension/OutputIsolationRecoveryHost.ts');
const {verifyDeclaredTargetsOnNodes}=require('../../src/extension/PlanCleanupTargetVerification.ts');

function fixture(){
 let now=100000,busy='busy',state='absent',queue={schemaVersion:1,plans:[{id:'plan',projectId:'project',planFile:'plans/p.yaml',revision:'rev',codeFingerprint:'code',resultPathPolicy:'declared',jobs:[
  {index:0,case:'bus',seed:42,status:'pending',outputDir:'work/0',collectionResultCsv:'results/0.csv',outputIsolationBlocked:{reason:'SimpleSFTP files.cleanup.execute：[ACTIVE_TRANSFER]',stage:'execute',declarationKey:'work/0',observedAt:'initial'}},
  {index:1,case:'pad',seed:42,status:'completed',outputDir:'work/1',commandId:'completed-command',workerId:'w',artifacts:{preserved:true}}]}]};
 const calls=[];let onInspect;
 const ports={now:()=>now,load:async()=>structuredClone(queue),save:async mutate=>{queue=mutate(queue)},assertCurrent(){},
  busy:async()=>{calls.push('busy');return{state:busy}},inspect:async()=>{calls.push('inspect');await onInspect?.();return{state}}};
 return {ports,calls,get queue(){return queue},advance(){now+=31000},idle(){busy='idle'},state(value){state=value},onInspect(fn){onInspect=fn}};
}
test('busy transfer followed by fresh absence automatically requeues only the unstarted job, including across reload',async()=>{
 const f=fixture(),done=structuredClone(f.queue.plans[0].jobs[1]);
 await R.refreshOutputIsolation(f.ports);assert.deepEqual(f.calls,['busy']);
 assert.equal(f.queue.plans[0].jobs[0].outputIsolationBlocked.recovery.state,'waiting_transfer');
 const restored=Q.restoreFormalJobQueue(JSON.parse(Q.serializeDistributedQueue(f.queue)));
 assert.ok(restored.plans[0].jobs[0].outputIsolationBlocked);
 f.idle();f.advance();const outcomes=await R.refreshOutputIsolation(f.ports);
 assert.equal(outcomes[0].state,'resumed');assert.equal(f.queue.plans[0].jobs[0].outputIsolationBlocked,undefined);
 assert.equal(f.queue.plans[0].jobs[0].status,'pending');assert.equal(f.queue.plans[0].jobs[0].localQueueOnly,true);
 assert.deepEqual(f.queue.plans[0].jobs[1],done);assert.deepEqual(f.calls,['busy','busy','inspect']);
});
test('existing outputs require review; unknown filesystem answers preserve the dispatch gate and retry',async()=>{
 for(const [state,expected] of [['present','review_required'],['unknown','unknown']]){
  const f=fixture();f.idle();f.state(state);await R.refreshOutputIsolation(f.ports);
  assert.equal(f.queue.plans[0].jobs[0].outputIsolationBlocked.recovery.state,expected);
  assert.equal(Q.allocateAvailable(f.queue,[{workerId:'w',online:true,codeFingerprint:'code',declaredJobPaths:true,idleGpuIds:['0']}]).dispatches.length,0);
  assert.deepEqual(f.calls,['busy','inspect']);await R.refreshOutputIsolation(f.ports);assert.deepEqual(f.calls,['busy','inspect']);
  f.advance();f.state('absent');await R.refreshOutputIsolation(f.ports);assert.equal(f.queue.plans[0].jobs[0].outputIsolationBlocked,undefined);
 }
});
test('completion, a new command or changed declarations during recheck cannot be overwritten by late absence',async()=>{
 for(const mutate of [j=>j.status='completed',j=>j.commandId='new-command',j=>j.outputDir='work/changed']){
  const f=fixture();f.idle();f.onInspect(()=>mutate(f.queue.plans[0].jobs[0]));
  const result=await R.refreshOutputIsolation(f.ports);assert.equal(result.length,0);assert.ok(f.queue.plans[0].jobs[0].outputIsolationBlocked);
 }
});
test('permanent path conflicts and mixed blockers never enter automatic transfer-busy recovery',async()=>{
 const f=fixture(),j=f.queue.plans[0].jobs[0];j.outputIsolationBlocked.code='PREVIEW_EXPIRED';
 await R.refreshOutputIsolation(f.ports);assert.deepEqual(f.calls,[]);
 j.outputIsolationBlocked.code='ACTIVE_TRANSFER';j.outputIsolationBlocked.codes=['ACTIVE_TRANSFER','PROTECTED'];
 await R.refreshOutputIsolation(f.ports);assert.deepEqual(f.calls,[]);
});
test('the native presence verifier requires explicit absence for every enabled node and external CSV',async()=>{
 const nodes=[{id:'local',kind:'local',root:'/local'},{id:'w',kind:'remote',root:'/remote'}],calls=[];
 const ctx={assertWorkspace(){},currentNode:id=>nodes.find(n=>n.id===id),host:{simpleSftpApiCall:async(method,p)=>{
  assert.equal(method,'files.cleanup.inspect');assert.equal(p.presenceOnly,true);calls.push(p.node.id+':'+p.target.relativePath);
  return {target:p.node.id==='w'&&p.target.type==='file'?{missing:false}:{missing:true}};
 }}};
 const result=await verifyDeclaredTargetsOnNodes(ctx,{nodes,declared:[{relativePath:'work/0',type:'directory'},{relativePath:'results/0.csv',type:'file'}]});
 assert.equal(result.verdicts.length,4);assert.equal(result.verdicts.filter(r=>r.state==='present').length,1);
 assert.deepEqual(calls,['local:work/0','local:results/0.csv','w:work/0','w:results/0.csv']);
 ctx.host.simpleSftpApiCall=async()=>({target:{}});
 assert.ok((await verifyDeclaredTargetsOnNodes(ctx,{nodes,declared:[{relativePath:'work/0',type:'directory'}]})).verdicts.every(r=>r.state==='error'));
});
test('real background host shares an in-flight check and does not replay any cleanup mutation',async()=>{
 const f=fixture(),root=process.cwd();f.queue.plans[0].projectId=Q.canonicalProjectId(root);
 let unblock;const wait=new Promise(r=>unblock=r),calls=[];
 const h={captureProjectContext:()=>({root}),projectContextIsCurrent:()=>true,workerCodeSyncTargets:()=>[{id:'w',remotePath:'/project'}],
  loadDistributedQueue:f.ports.load,saveDistributedQueue:async(_root,_q,options)=>f.ports.save(options.mutateLatest),postState(){},requestDistributedQueueRefresh(){calls.push('wake')},
  simpleSftpApiCall:async(method)=>{calls.push(method);await wait;return{ok:true,instanceId:'active',busy:{schemaVersion:1,busy:false}}},
  planCleanupHost:()=>({inspectPendingOutputTargets:async()=>{calls.push('inspect');return{state:'absent'}}})};
 const first=queueOutputIsolationRecovery(h,root),second=queueOutputIsolationRecovery(h,root);assert.equal(first,second);unblock();await first;
 assert.deepEqual(calls,['transfers.list','inspect','wake']);assert.equal(f.queue.plans[0].jobs[0].outputIsolationBlocked,undefined);
});

test('explicit review owns the job until confirmation ends; background rechecks and stale approvals cannot release it',async()=>{
 const Module=require('node:module'),original=Module._load;
 try { for(const outcome of ['accepted','changed','cancelled']){
  const f=fixture(),root=process.cwd(),calls=[];f.queue.plans[0].projectId=Q.canonicalProjectId(root);
  let entered,approve;const ready=new Promise(r=>entered=r),approval=new Promise(r=>approve=r);
  Module._load=function(request,parent,...args){
   if(request==='./ManualDispatchHost'&&parent?.filename.endsWith('OutputIsolationRecoveryHost.ts'))return {ManualDispatchHost:class{
    async review(plan,jobs){assert.equal(jobs.length,1);assert.equal(jobs[0].index,0);entered();await approval;return outcome==='cancelled'?false:{accepted:[0]};}
   }};
   return original.call(this,request,parent,...args);
  };
  const h={captureProjectContext:()=>({root}),projectContextIsCurrent:()=>true,workerCodeSyncTargets:()=>[{id:'w',remotePath:'/project'}],
   loadDistributedQueue:f.ports.load,saveDistributedQueue:async(_root,_q,options)=>f.ports.save(options.mutateLatest),postState(){},requestDistributedQueueRefresh(){calls.push('wake')},
   simpleSftpApiCall:async()=>{calls.push('busy');return{ok:true,instanceId:'active',busy:{schemaVersion:1,busy:false}}},
   planCleanupHost:()=>({inspectPendingOutputTargets:async()=>({state:'present'})})};
  const pending=new OutputIsolationRecoveryHost(h,root).fromUi({planId:'plan',planFile:'plans/p.yaml',jobIndex:0});await ready;
  await queueOutputIsolationRecovery(h,root);assert.deepEqual(calls,['busy']);assert.ok(f.queue.plans[0].jobs[0].outputIsolationBlocked);
  if(outcome==='changed')f.queue.plans[0].jobs[0].commandId='replaced-command';
  approve();const result=await pending;
  assert.equal(result.status,outcome==='accepted'?'queued':outcome);
  if(outcome==='accepted'){assert.equal(f.queue.plans[0].jobs[0].outputIsolationBlocked,undefined);assert.deepEqual(calls,['busy','wake']);}
  else assert.ok(f.queue.plans[0].jobs[0].outputIsolationBlocked);
  assert.equal(f.queue.plans[0].jobs[1].status,'completed');
 }}finally{Module._load=original;}
});
