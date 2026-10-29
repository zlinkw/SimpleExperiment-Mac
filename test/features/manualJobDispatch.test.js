const test=require('node:test'),assert=require('node:assert/strict');
const {dispatchManualJobs,dispatchReadyManualJobs}=require('../../dist/features/ManualJobDispatch');
function fixture(){let q={plans:[{id:'p',planFile:'experiments/plans/p.yaml',revision:'rev',codeFingerprint:'hash',executionMode:'train_test',resultPathPolicy:'declared',jobs:[0,1].map(index=>({index,attempt:0,status:'pending',case:'case'+index,seed:42,outputDir:'work/job'+index,collectionResultCsv:'tmp/result/'+index+'.csv'}))}]};
 let online=true,allow=true,supported=true,count=0,send=0,stop=0,prepare=0;
 const ports={load:async()=>structuredClone(q),save:async value=>{q=structuredClone(value)},assertCurrent(){},online:()=>online,supports:()=>supported,newCommandId:()=> 'command'+(++count),
  prepare:async()=>{prepare++},stop:async()=>{stop++},review:async()=>allow,send:async()=>{send++;throw Error('response lost')},tick:()=>dispatchReadyManualJobs(ports)};
 return {ports,get q(){return q},get sends(){return send},get stops(){return stop},get preparations(){return prepare},offline:()=>online=false,cancel:()=>allow=false,old:()=>supported=false};}
const request={workflowId:'p',indices:[0,1],workerId:'worker',gpuId:'0',stopRunning:true,expectedCommands:{0:'',1:''}};
test('automatic GPU selection persists only the Worker and waits in the normal allocator across reloads',async()=>{
 const f=fixture(),Queue=require('../../dist/features/DistributedPlanQueue');
 const result=await dispatchManualJobs(f.ports,{...request,gpuId:undefined,gpuSelection:'automatic'});
 assert.equal(result.fallbackToAutomatic,false);assert.equal(f.sends,0);assert.equal(f.preparations,1);
 const restored=Queue.restoreFormalJobQueue(JSON.parse(Queue.serializeDistributedQueue(f.q)));
 assert.ok(restored.plans[0].jobs.every(j=>j.automaticWorkerId==='worker'&&!j.workerId&&!j.commandId&&!j.manualDispatch));
 const rows=[{workerId:'worker',online:true,declaredJobPaths:true,idleGpuIds:[]},
  {workerId:'other',online:true,declaredJobPaths:true,idleGpuIds:['9','10']}];
 assert.equal(Queue.allocateAvailable(restored,rows).dispatches.length,0,'idle cards on another Worker cannot take selected jobs');
 rows[0].idleGpuIds=['2','3'];const selected=Queue.allocateAvailable(restored,rows);
 assert.equal(selected.dispatches.length,2);assert.ok(selected.dispatches.every(d=>d.workerId==='worker'));
 assert.deepEqual(selected.dispatches.map(d=>d.gpuId),['2','3']);
 const remaining=require('../../dist/features/ServerQueueDispatch');assert.equal(remaining.remainingQueueJobs(restored.plans[0]).length,0);
 f.offline();await f.ports.save(restored);await dispatchReadyManualJobs(f.ports);
 assert.ok(f.q.plans[0].jobs.every(j=>j.automaticWorkerId==='worker'));assert.equal(f.sends,0);
});
test('automatic placement preserves isolation and completion guards; explicit cards replace its Worker constraint',async()=>{
 const f=fixture();f.ports.review=async()=>({accepted:[1],blocked:[{index:0,reason:'transfer busy',stage:'execute',code:'ACTIVE_TRANSFER'}]});
 await dispatchManualJobs(f.ports,{...request,gpuId:undefined,gpuSelection:'automatic'});
 assert.equal(f.sends,0);assert.equal(f.q.plans[0].jobs[0].automaticWorkerId,'worker');assert.ok(f.q.plans[0].jobs[0].outputIsolationBlocked);
 assert.equal(f.q.plans[0].jobs[1].automaticWorkerId,'worker');
 f.ports.review=async()=>true;await dispatchManualJobs(f.ports,{...request,indices:[1]});
 assert.equal(f.q.plans[0].jobs[1].automaticWorkerId,undefined);assert.equal(f.sends,1);
 const q=await f.ports.load();q.plans[0].jobs[0].status='completed';await f.ports.save(q);
 await assert.rejects(dispatchManualJobs(f.ports,{...request,indices:[0],gpuId:undefined,gpuSelection:'automatic'}),/已完成/);
});
test('automatic selection cannot hide a conflicting GPU or silently change to a different offline Worker',async()=>{
 const f=fixture();await assert.rejects(dispatchManualJobs(f.ports,{...request,gpuSelection:'automatic'}),/不能同时/);
 f.offline();await assert.rejects(dispatchManualJobs(f.ports,{...request,gpuId:undefined,gpuSelection:'automatic'}),/未连接/);
 assert.equal(f.sends,0);assert.equal(f.preparations,0);
});
test('manual batch places different jobs on the same GPU once; response loss/reload cannot resend',async()=>{
 const f=fixture();await dispatchManualJobs(f.ports,request);assert.equal(f.sends,2);
 assert.ok(f.q.plans[0].jobs.every(j=>j.gpuId==='0'&&j.manualDispatch.stage==='sent'));assert.notEqual(f.q.plans[0].jobs[0].commandId,f.q.plans[0].jobs[1].commandId);
 f.offline();await dispatchReadyManualJobs(f.ports);assert.equal(f.sends,2);assert.ok(f.q.plans[0].jobs.every(j=>j.workerId==='worker'));
 await assert.rejects(dispatchManualJobs(f.ports,request),/已变化|尚未核实/);assert.equal(f.sends,2);
});
test('offline before send returns to automatic queue without sending or preserving a manual reservation',async()=>{
 const f=fixture();f.offline();f.ports.review=async()=>assert.fail('offline unsent jobs must not be trapped by remote file inspection');const r=await dispatchManualJobs(f.ports,request);assert.equal(r.fallbackToAutomatic,true);assert.equal(f.sends,0);assert.equal(f.preparations,0);
 assert.ok(f.q.plans[0].jobs.every(j=>j.status==='pending'&&!j.workerId&&!j.manualDispatch));
});
test('cancelled review stops the batch before any new launch and releases only the local reservation',async()=>{
 const f=fixture();f.cancel();const r=await dispatchManualJobs(f.ports,request);assert.equal(r.status,'cancelled');assert.equal(f.sends,0);assert.ok(f.q.plans[0].jobs.every(j=>!j.manualDispatch));
});
test('old Worker and completed jobs are rejected before stopping or reviewing outputs',async()=>{
 const f=fixture();f.old();await assert.rejects(dispatchManualJobs(f.ports,request),/更新/);assert.equal(f.stops,0);assert.equal(f.preparations,0);
 const q=await f.ports.load();q.plans[0].jobs[0].status='completed';await f.ports.save(q);await assert.rejects(dispatchManualJobs(f.ports,request),/已完成/);
});
test('running job is stopped before output review, then uses original mode and a fresh execution command',async()=>{
 const f=fixture(),q=await f.ports.load();Object.assign(q.plans[0].jobs[0],{status:'running',workerId:'old',commandId:'old-command',executionState:'running'});await f.ports.save(q);
 await dispatchManualJobs(f.ports,{...request,indices:[0],expectedCommands:{0:'old-command'}});assert.equal(f.stops,1);assert.equal(f.sends,1);
 const j=f.q.plans[0].jobs[0];assert.equal(j.actualExecutionMode,'train_test');assert.notEqual(j.commandId,'old-command');assert.equal(j.outputDir,'work/job0');
});
test('real queue serialization retains sent placement and offline notices without replaying either launch',async()=>{
 const Queue=require('../../dist/features/DistributedPlanQueue'),f=fixture();await dispatchManualJobs(f.ports,request);
 await f.ports.save(Queue.restoreFormalJobQueue(JSON.parse(Queue.serializeDistributedQueue(f.q))));
 await dispatchReadyManualJobs(f.ports);assert.equal(f.sends,2);assert.ok(f.q.plans[0].jobs.every(j=>j.manualDispatch.stage==='sent'));
 const offline=fixture();offline.offline();await dispatchManualJobs(offline.ports,request);
 const restored=Queue.restoreFormalJobQueue(JSON.parse(Queue.serializeDistributedQueue(offline.q)));
 assert.match(restored.plans[0].jobs[0].manualDispatchNotice,/自动派发/);
});
test('train, test and train_test keep their declared execution mode and checkpoint source',async()=>{
 for(const mode of ['train','test','train_test']){
  const f=fixture(),q=await f.ports.load();q.plans[0].executionMode=mode;q.plans[0].jobs[0].checkpointSource={path:'checkpoint/frozen.pt',sha256:'a'.repeat(64)};await f.ports.save(q);
  await dispatchManualJobs(f.ports,{...request,indices:[0]});
  assert.equal(f.q.plans[0].jobs[0].actualExecutionMode,mode);assert.equal(f.q.plans[0].jobs[0].checkpointSource.path,'checkpoint/frozen.pt');
 }
});
test('missing-only confirmation dispatches only its selected subset, including after reload',async()=>{
 const f=fixture();f.ports.review=async()=>[1];const result=await dispatchManualJobs(f.ports,request);
 assert.deepEqual(result.indices,[1]);assert.equal(f.sends,1);assert.equal(f.q.plans[0].jobs[0].retainExistingOutputs,true);
 const Queue=require('../../dist/features/DistributedPlanQueue');const restored=Queue.restoreFormalJobQueue(JSON.parse(Queue.serializeDistributedQueue(f.q)));
 assert.equal(restored.plans[0].jobs[0].status,'cancelled');
});

test('explicit stop-then-dispatch fences uncertain original requests before review or a new launch',async()=>{
 for(const status of ['dispatching','unknown']){
  const f=fixture(),q=await f.ports.load();Object.assign(q.plans[0].jobs[0],{status,workerId:'old',commandId:'old-command'});await f.ports.save(q);
  let release,entered,reviewed=false;
  const stopping=new Promise(resolve=>{entered=resolve;});
  f.ports.stop=async(plan,job)=>{assert.equal(job.commandId,'old-command');assert.equal(job.workerId,'old');entered();await new Promise(resolve=>{release=resolve;});};
  f.ports.review=async()=>{reviewed=true;return true;};
  const pending=dispatchManualJobs(f.ports,{...request,indices:[0],expectedCommands:{0:'old-command'}});
  await stopping;assert.equal(f.sends,0);assert.equal(reviewed,false);assert.equal(f.q.plans[0].jobs[0].commandId,'old-command');
  release();await pending;
  assert.equal(reviewed,true);assert.equal(f.sends,1);assert.notEqual(f.q.plans[0].jobs[0].commandId,'old-command');
 }
});

test('uncertain requests cannot be replaced without explicit stop or when the exact stop is unverified',async()=>{
 const f=fixture(),q=await f.ports.load();Object.assign(q.plans[0].jobs[0],{status:'unknown',workerId:'old',commandId:'old-command'});await f.ports.save(q);
 const selected={...request,indices:[0],expectedCommands:{0:'old-command'}};
 await assert.rejects(dispatchManualJobs(f.ports,{...selected,stopRunning:false}),/尚未核实/);assert.equal(f.sends,0);assert.equal(f.preparations,0);
 f.ports.stop=async()=>{throw Error('ORIGINAL_WORKER_QUERY_FAILED');};
 f.ports.review=async()=>assert.fail('unverified stop cannot proceed to output review');
 await assert.rejects(dispatchManualJobs(f.ports,selected),/ORIGINAL_WORKER_QUERY_FAILED/);
 assert.equal(f.sends,0);assert.equal(f.q.plans[0].jobs[0].commandId,'old-command');assert.equal(f.q.plans[0].jobs[0].manualDispatch,undefined);
});

test('missing original command or server identity cannot authorize a replacement launch',async()=>{
 for(const status of ['dispatching','running','queued','unknown'])for(const missing of ['workerId','commandId']){
  const f=fixture(),q=await f.ports.load();Object.assign(q.plans[0].jobs[0],{status,workerId:'old',commandId:'old-command'});delete q.plans[0].jobs[0][missing];await f.ports.save(q);
  await assert.rejects(dispatchManualJobs(f.ports,{...request,indices:[0],expectedCommands:{0:q.plans[0].jobs[0].commandId||''}}),/身份缺失/);
  assert.equal(f.sends,0);assert.equal(f.stops,0);assert.equal(f.preparations,0);
 }
});

// ── r82（0.5.414）：手动派发链的隔离阻断契约（413 上红）──────────────────────────
// review 现在可返回 {accepted, blocked}；被阻断 job 保留为可见 pending+outputIsolationBlocked，
// 绝不借用 retainExistingOutputs（那是用户主动保留语义）；只有接受（隔离完成且核验通过）才事务性清标。
test('r82 red: review blocking one job by isolation marks it visibly-unlaunchable, never as user-retained',async()=>{
 const f=fixture();f.ports.review=async()=>({accepted:[1],blocked:[{index:0,reason:'nwpu3：ACTIVE_TRANSFER SimpleSFTP files.cleanup.execute：[ACTIVE_TRANSFER]',stage:'execute',code:'ACTIVE_TRANSFER'}]});
 const r=await dispatchManualJobs(f.ports,request);assert.deepEqual(r.indices,[1]);assert.equal(f.sends,1);
 const j0=f.q.plans[0].jobs[0];
 assert.ok(j0.outputIsolationBlocked,'被阻断 job 必须带独立 job 级阻断字段');
 assert.equal(j0.outputIsolationBlocked.code,'ACTIVE_TRANSFER');assert.equal(j0.outputIsolationBlocked.stage,'execute');
 assert.notEqual(j0.retainExistingOutputs,true,'隔离失败不得伪装成"用户保留已有产物"');
 assert.match(j0.blockReason,/隔离未完成|重新审核/);
});
// r83 返修：拆开短路——接受清标、ready 清扫、序列化投影各自独立成用例，任一红不再遮蔽其余断言的复现机会。
test('r82 red: acceptance clears a prior marker transactionally',async()=>{
 const g=fixture(),gq=await g.ports.load();
 gq.plans[0].jobs[1].outputIsolationBlocked={reason:'上轮传输忙',stage:'execute',code:'ACTIVE_TRANSFER',declarationKey:'work/job1',observedAt:'2026-10-26T03:13:15.000Z'};
 await g.ports.save(gq);g.ports.review=async()=>({accepted:[0,1],blocked:[]});
 await dispatchManualJobs(g.ports,request);
 assert.equal(g.q.plans[0].jobs[1].outputIsolationBlocked,undefined,'用户走既有审核路径、隔离完成且核验通过后，随同一次 save 解除');
 assert.equal(g.sends,2);
});
test('r82 red: the ready sweep never sends or loses a blocked job',async()=>{
 const f=fixture(),q=await f.ports.load();
 Object.assign(q.plans[0].jobs[0],{localQueueOnly:true,nextCommandId:'ready-command',manualDispatch:{workerId:'worker',gpuId:'0',stage:'ready'},
  outputIsolationBlocked:{reason:'隔离未完成',stage:'execute',code:'ACTIVE_TRANSFER',declarationKey:'work/job0',observedAt:'2026-10-26T03:13:15.000Z'}});
 await f.ports.save(q);await dispatchReadyManualJobs(f.ports);
 assert.equal(f.sends,0,'ready 清扫必须先核最新持久状态的阻断，绝不发送');
 assert.equal(f.q.plans[0].jobs[0].manualDispatch.stage,'ready','阻断只暂停派发，不吞掉用户已确认的排队意图之外的新副作用');
 assert.ok(f.q.plans[0].jobs[0].outputIsolationBlocked);
});
test('r82 red: serialize/restore projection keeps the block marker and re-projects its explanation',()=>{
 const Queue=require('../../dist/features/DistributedPlanQueue');
 const queue={schemaVersion:1,plans:[{id:'p',projectId:'project',planFile:'p.yaml',revision:'r',codeFingerprint:'f',enqueuedAt:'2026-10-26T03:13:15.000Z',
  resultPathPolicy:'declared',jobs:[{index:0,case:'c',seed:1,attempt:0,outputDir:'work/job0',status:'pending',lifecycleProtocol:2,
  manualDispatch:{workerId:'worker',gpuId:'0',stage:'ready'},
  outputIsolationBlocked:{reason:'隔离未完成',stage:'execute',code:'ACTIVE_TRANSFER',declarationKey:'work/job0',observedAt:'2026-10-26T03:13:15.000Z'}}]}]};
 const restored=Queue.restoreFormalJobQueue(JSON.parse(Queue.serializeDistributedQueue(queue)));
 assert.ok(restored.plans[0].jobs[0].outputIsolationBlocked,'序列化/恢复投影不得抹掉阻断字段');
 assert.match(restored.plans[0].jobs[0].blockReason,/旧产物隔离未完成/,'重载后必须能重新解释为何未启动（blockReason 投影）');
});

test('block B: unified admission denial rewinds the ready job at save and consumes no POST',async()=>{
 const f=fixture(),q0=await f.ports.load();
 Object.assign(q0.plans[0].jobs[0],{localQueueOnly:true,nextCommandId:'ready-command',
  manualDispatch:{workerId:'worker',gpuId:'0',stage:'ready',origin:'server_queue',batchId:'b1'}});
 await f.ports.save(q0);
 const saveOptions=[];
 const originalSave=f.ports.save; // fixture 的 q 是闭包私有：必须委托原 save 落盘，绝不能在测试里隐式创建 global q。
 f.ports.save=async(value,options)=>{saveOptions.push(options||null);
  // 模拟保存端统一准入：先在调用方队列上原地剥回（与 syncDeniedIntentsInPlace 一致），再落盘并回传回执。
  const job=value.plans[0].jobs.find(j=>j.commandId==='ready-command');
  if(job&&options&&options.dispatchAdmission){Object.assign(job,{status:'pending',workerId:undefined,gpuId:undefined,commandId:undefined,
   runKey:undefined,startIntent:undefined,nextCommandId:'ready-command',manualDispatch:{...job.manualDispatch,stage:'ready'},
   blockReason:'统一派发等待配额：GPU 0 配额已满（1/1）'});
   await originalSave(value);
   return {dispatchAdmission:true,intents:1,approved:[],denied:[{planId:'p',jobIndex:0,attempt:0,commandId:'ready-command',
    workerId:'worker',gpuId:'0',manual:true,reason:'服务器 worker:22 GPU 0 的每卡配额已满（1/1）；留在本地队列等待。'}],blockers:[]};}
  await originalSave(value);
  return undefined;};
 await dispatchReadyManualJobs(f.ports);
 assert.equal(f.sends,0,'被统一准入拒绝的手动意图绝不 POST');
 assert.ok(saveOptions.some(o=>o&&o.dispatchAdmission===true),'ready→sent 的身份持久化必须经由统一准入保存');
 const job=f.q.plans[0].jobs[0];
 assert.equal(job.status,'pending');assert.equal(job.manualDispatch.stage,'ready');
 assert.equal(job.manualDispatch.gpuId,'0','保留用户所选服务器/GPU');
 assert.equal(job.nextCommandId,'ready-command','同命令重试不换新身份');
 assert.match(job.blockReason,/统一派发等待配额/);
 assert.equal(typeof globalThis.q,'undefined','覆盖 save 不得泄漏隐式 global q');
 // 无回执（旧宿主 fake）时行为不变：正常发送。
 const g=fixture(),qg=await g.ports.load();
 Object.assign(qg.plans[0].jobs[0],{localQueueOnly:true,nextCommandId:'plain-command',manualDispatch:{workerId:'worker',gpuId:'0',stage:'ready'}});
 await g.ports.save(qg);
 await dispatchReadyManualJobs(g.ports);
 assert.equal(g.sends,1);
 assert.equal(g.q.plans[0].jobs[0].manualDispatch.stage,'sent');
});
