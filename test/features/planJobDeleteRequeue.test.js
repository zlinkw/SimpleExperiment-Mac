const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),fsNode=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
require('../_helpers/registerTsRequire');
const PulledTaskControl=require('../../src/features/PulledTaskControl.ts');

// 用户最终语义（2026-10-21 返修 #2）：单 job「删除并重新排队」= 先经两次显式确认永久删除该 job 的声明产物
// 并核实源路径不存在（path_absence），然后原卡同一 job 重新入队等待正常资源调度；
// 不建新卡、不原地直接启动；旧回执不能覆盖新执行；只影响所选 job。
// 本回归把 legacy.ts 里真实的 retryPulledJob 方法体原样提取执行（不改一个字符），
// PulledTaskControl/returnPulledJobToLocal 用真实实现；清理服务用与 PlanCleanupHost 同表面的记账适配器
// （真实删除服务链在 planCleanup 等套件已单独覆盖），PlanRunHost 注入探针以证明不得再走 rename 隔离。
// 不启动 VSCode/服务器；不碰任何真实数据。

function extractMethodBody(source,name){
  const at=source.indexOf(name);
  if(at<0) throw Error('METHOD_NOT_FOUND '+name);
  let i=source.indexOf('{',at),depth=0,end=-1;
  for(let j=i;j<source.length;j++){if(source[j]==='{')depth++;else if(source[j]==='}'){depth-=1;if(!depth){end=j;break;}}}
  if(end<0) throw Error('METHOD_UNBALANCED '+name);
  return source.slice(i+1,end);
}
const ts=require('typescript');// 与 confirmedFastDeleteWiring 等既有套件同法：提取真实方法体后经 transpileModule 原样执行（仅去类型，逻辑零改写）。
const legacySource=fsNode.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
const retryBody=ts.transpileModule(extractMethodBody(legacySource,'async retryPulledJob(plan, job, root, isCurrent, anomalyOnly = false) {'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const makeRetry=new Function('fs','path','crypto','PlanCodeScopeHost','PulledTaskControl','vscode','UiCommandCancelled','makeOpId','errorMessage','PlanRunHost',
  'return async function (plan, job, root, isCurrent, anomalyOnly = false) {'+retryBody+'};');

class UiCommandCancelled extends Error {}
function makeWorld({answers=['确认删除（1/2）','永久删除（2/2）'],deleteMode='ok',saveError=null,queueJobCommandId='cmd-old'}={}){
  const root=fsNode.mkdtempSync(path.join(os.tmpdir(),'se-job-delereq-'));
  const planFile='plans/a.yaml';fsNode.mkdirSync(path.join(root,'plans'),{recursive:true});
  const text='mode: train\n';fsNode.writeFileSync(path.join(root,planFile),text);
  const revision=crypto.createHash('sha256').update(text).digest('hex');
  const jobs=[{index:0,case:'c0',seed:1,outputDir:'work_dirs/a0',collectionResultCsv:'work_dirs/a0/m.csv',commandId:'cmd-old',workerId:'w1',lifecycleProtocol:2,status:'completed'},
    {index:1,case:'c1',seed:2,outputDir:'work_dirs/a1',collectionResultCsv:'work_dirs/a1/m.csv',commandId:'cmd-b',workerId:'w1',status:'running'}];
  // 队列侧代际可与 UI 传入的 plan 不同（queueJobCommandId）：身份围栏必须在任何文件操作前拒绝。
  let queue={plans:[{id:'plan-a',projectId:'p-1',planFile,revision,codeFingerprint:'fp-1',
    jobs:jobs.map(job=>({...job,index:job.index===0?0:job.index,commandId:job.index===0?queueJobCommandId:job.commandId}))}],clearedJobs:[]};
  const writes=[]; const cleanupCalls=[]; let deleteExecutions=0; let deleted=false; let inPreviewGate=null;
  // F11：一次性入口闩——真实 mock preview 首次被调用时才 resolve（preview 发生在生产
  // guardKey 占用之后，见 retryPulledJob L13362→L13418），先通知再等待既有 inPreviewGate。
  let previewEnteredFired=false; let resolvePreviewEntered=null;
  const previewEntered=new Promise(resolve=>{resolvePreviewEntered=resolve;});
  const isolateProbes=[]; const answersQueue=[...answers];
  const cleanupHost={
    service:{
      preview:async params=>{cleanupCalls.push({kind:'preview',params:JSON.parse(JSON.stringify(params))});
        if(!previewEnteredFired){previewEnteredFired=true;resolvePreviewEntered();}
        if(inPreviewGate)await inPreviewGate;
        return {token:'tok-del',digest:'dig-del',action:'delete',confirmations:0,scope:{nodes:[{id:'w1'}]},rows:[
          {id:'r0',disposition:deleted?'absent':'delete',type:'directory',relativePath:'work_dirs/a0',node:{id:'w1',host:'h1.example'},absolutePath:'/srv/proj/work_dirs/a0',missing:deleted},
          {id:'r1',disposition:deleted?'absent':'delete',type:'file',relativePath:'work_dirs/a0/m.csv',node:{id:'w1',host:'h1.example'},absolutePath:'/srv/proj/work_dirs/a0/m.csv',missing:deleted}]};},
      confirm:async params=>{cleanupCalls.push({kind:'confirm',phase:params.phase,exactTargets:[...params.exactTargets]});},
    },
    execute:async token=>{cleanupCalls.push({kind:'execute',token});deleteExecutions+=1;
      if(deleteMode==='busy')throw Object.assign(Error('ACTIVE_TRANSFER：配套仍有传输'),{code:'ACTIVE_TRANSFER'});
      const doneRows=rows=>rows.map(row=>({id:row.id,disposition:'delete',type:row.type,relativePath:row.relativePath,node:{id:'w1',host:'h1.example'}}));
      if(deleteMode==='unverified')return {state:'completed',preview:{token:'tok-del',action:'delete',digest:'dig-del',scope:{nodes:[{id:'w1'}]},
        rows:doneRows([{id:'r0',type:'directory',relativePath:'work_dirs/a0'},{id:'r1',type:'file',relativePath:'work_dirs/a0/m.csv'}])},
        targets:{r0:{state:'completed',receipt:{verifiedBy:'path_absence'}},r1:{state:'executing'}}};
      deleted=true;
      return {state:'completed',preview:{token:'tok-del',action:'delete',digest:'dig-del',scope:{nodes:[{id:'w1'}]},
        rows:doneRows([{id:'r0',type:'directory',relativePath:'work_dirs/a0'},{id:'r1',type:'file',relativePath:'work_dirs/a0/m.csv'}])},
        targets:{r0:{state:'completed',receipt:{verifiedBy:'path_absence'}},r1:{state:'completed',receipt:{verifiedBy:'path_absence'}}}};},
  };
  const client={
    posted:[],
    postWorkerAction:async(workerId,action,request)=>{client.posted.push({workerId,action});},
    getWorkerTasks:async()=>({capabilities:{taskLifecycle:2},queryComplete:true,
      tasks:[{commandId:'cmd-old',observation:{lifecycleProtocol:2,commandId:'cmd-old',projectId:'p-1',workerId:'w1',cancelled:true,tmux:null,result:null,execution:'idle',status:'failed',exitCode:1}}]}),
  };
  const host={
    client, manualDispatchInFlight:new Set(),
    loadDistributedQueue:async()=>JSON.parse(JSON.stringify(queue)),
    saveDistributedQueue:async(_root,_queue,options)=>{
      if(saveError)throw saveError instanceof Error?saveError:Error(String(saveError));
      const latest=JSON.parse(JSON.stringify(queue));const next=options.mutateLatest(latest);
      if(next!==latest){queue=next;writes.push(JSON.parse(JSON.stringify(next)));}},
    assertPlanSubmissionWorkers:async()=>{},
    planCleanupHost:()=>cleanupHost,
    postState(){}, recordActionError(row){cleanupCalls.push({kind:'actionError',row});},
    tickDistributedQueue:async()=>{cleanupCalls.push({kind:'tick'});},
  };
  const vscode={window:{showWarningMessage:async()=>answersQueue.shift()||'取消'}};
  const PlanRunHostProbe=class{constructor(){isolateProbes.push('constructed');}async replace(){isolateProbes.push('replace');
    body:{throw Error('MUST_NOT_RENAME_ISOLATE');}}};
  const retry=makeRetry(fs,path,crypto,{resolvePlanExecutionSource:async()=>undefined,verifyLocalPlanSource:async()=>{}},
    PulledTaskControl,vscode,UiCommandCancelled,()=>'op-'+Math.random(),String,PlanRunHostProbe);
  const plan={id:'plan-a',projectId:'p-1',planFile,revision,codeFingerprint:'fp-1',executionMode:'train',jobs:JSON.parse(JSON.stringify(jobs)),planJobCount:2};
  return {root,plan,planFile,host,client,queue:()=>queue,writes,isolateProbes,cleanupCalls,deleteMode:mode=>{deleteMode=mode;},
    deletedCount:()=>deleteExecutions,setPreviewGate:promise=>{inPreviewGate=promise;},previewEntered,
    retry:isCurrent=>retry.call(host,plan,plan.jobs[0],root,isCurrent??(()=>true))};
}

test('删除并重新排队：两次确认→永久删除核实 path_absence→原卡同 job 入队等待调度；绝不 rename 隔离、不直接启动',async()=>{
  const world=makeWorld();
  const result=await world.retry();
  assert.equal(result.status,'queued');
  assert.match(result.message,/永久删除并核实源路径不存在/);
  assert.match(result.message,/等待正常资源调度/);
  assert.deepEqual(world.isolateProbes,[],'用户要求先精确删除，不得再走 rename 隔离（当前候选仍调用 PlanRunHost.replace 即此处红）');
  assert.deepEqual(world.cleanupCalls.filter(row=>row.kind==='confirm').map(row=>row.phase),[1,2],'永久删除必须恰好两次带路径确认');
  assert.deepEqual(world.cleanupCalls.find(row=>row.kind==='preview').params.action,'delete');
  assert.equal(world.cleanupCalls.find(row=>row.kind==='preview').params.job.commandId,'cmd-old','只允许所选 job 的范围');
  assert.equal(world.deletedCount(),1);
  const queue=world.queue();
  assert.equal(queue.plans.length,1,'不新建卡片');
  assert.equal(queue.plans[0].id,'plan-a','原卡保留');
  const job=queue.plans[0].jobs.find(row=>row.index===0);
  assert.equal(job.status,'pending');assert.equal(job.commandId,undefined);
  assert.ok(job.nextCommandId&&job.nextCommandId!=='cmd-old','新执行用新 commandId，旧回执不能覆盖');
  assert.equal(job.outputDir,'work_dirs/a0');
  assert.ok((job.history||[]).some(row=>row.commandId==='cmd-old'&&row.stopReason==='requeue'),'旧代际只进历史');
  const sibling=queue.plans[0].jobs.find(row=>row.index===1);
  assert.equal(sibling.commandId,'cmd-b');assert.equal(sibling.status,'running','兄弟 job 不受影响');
  assert.equal(world.writes.length,1,'入队恰好一次队列事务');
  assert.deepEqual(world.client.posted.map(row=>row.action),['stop-worker-task'],'只允许停止核实类远端动作，不得直接派发启动');
  assert.ok(world.cleanupCalls.some(row=>row.kind==='tick')&&!world.client.posted.some(row=>/dispatch|start/i.test(row.action)),'调度交回正常 tick，不原地启动');
});
test('第一次或第二次确认取消：零删除、零确认、零入队，原卡原样',async()=>{
  for(const answers of [['取消'],['确认删除（1/2）','取消']]){
    const world=makeWorld({answers});
    await assert.rejects(()=>world.retry(),/已取消/);
    assert.equal(world.deletedCount(),0);
    assert.deepEqual(world.cleanupCalls.filter(row=>row.kind==='confirm'),[]);
    assert.deepEqual(world.writes,[],'取消绝不写队列');
    assert.equal(world.queue().plans[0].jobs[0].commandId,'cmd-old');
  }
});
test('删除被真实忙拒绝：显式上抛、零入队、不自动重试',async()=>{
  const world=makeWorld({deleteMode:'busy'});
  await assert.rejects(()=>world.retry(),/ACTIVE_TRANSFER/);
  assert.deepEqual(world.writes,[],'忙/失败必须零入队');
  assert.equal(world.queue().plans[0].jobs[0].commandId,'cmd-old');
});
test('删除未核实 path_absence：不得入队，账本可重试',async()=>{
  const world=makeWorld({deleteMode:'unverified'});
  await assert.rejects(()=>world.retry(),/PERMANENT_DELETE_UNVERIFIED/);
  assert.deepEqual(world.writes,[]);
});
test('删后入队失败可恢复：重试直接入队，零重复删除；双击并发恰一次',async()=>{
  const world=makeWorld({saveError:'STORAGE_WRITE_FAILED'});
  await assert.rejects(()=>world.retry(),/STORAGE_WRITE_FAILED/);
  assert.equal(world.deletedCount(),1);
  assert.deepEqual(world.writes,[],'入队失败时确实未写');
  // 恢复：同一世界再点一次（存储已恢复）——产物已核实不存在，必须零新删除、直接入队。
  world.host.saveDistributedQueue=async(_root,_queue,options)=>{
    const latest=JSON.parse(JSON.stringify(world.queue()));const next=options.mutateLatest(latest);
    if(next!==latest){world.writes.push(JSON.parse(JSON.stringify(next)));world.host.__queue=next;}};
  const original=world.queue.bind(world);let overridden=null;
  world.host.loadDistributedQueue=async()=>JSON.parse(JSON.stringify(overridden||original()));
  const retry2=makeRetry(fs,path,crypto,{resolvePlanExecutionSource:async()=>undefined,verifyLocalPlanSource:async()=>{}},
    PulledTaskControl,{window:{showWarningMessage:async()=>'取消'}},UiCommandCancelled,()=>'op-r2',String,
    class{async replace(){throw Error('MUST_NOT_RENAME_ISOLATE');}});
  world.host.saveDistributedQueue=async(_root,_queue,options)=>{const latest=JSON.parse(JSON.stringify(original()));
    const next=options.mutateLatest(latest);if(next!==latest){overridden=next;world.writes.push(JSON.parse(JSON.stringify(next)));}};
  const result=await retry2.call(world.host,world.plan,world.plan.jobs[0],world.root,()=>true);
  assert.equal(result.status,'queued');
  assert.match(result.message,/已核实不存在/);
  assert.equal(world.deletedCount(),1,'恢复路径零重复删除');
  assert.deepEqual(world.cleanupCalls.filter(row=>row.kind==='confirm').map(row=>row.phase),[1,2],'确认只发生在真实删除那一次');
});
test('并发双击恰一次：在途时第二次显式拒绝',async()=>{
  const world=makeWorld();
  let releaseGate;world.setPreviewGate(new Promise(resolve=>{releaseGate=resolve;}));
  const first=world.retry();
  let firstError=null;const firstTracked=first.then(()=>null,error=>{firstError=error;});
  try{
    // F11 确定性同步：await 真实入口信号（首个 preview 调用发生在生产 guardKey
    // 占用之后，L13362→L13418），再等一次宏任务让出队列；第二调用此时必然看到已占的锁。
    await world.previewEntered;
    await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(()=>world.retry(),/正在执行删除并重新排队/);
  }finally{ releaseGate(); }
  await firstTracked;
  if(firstError)throw firstError;
  assert.equal(world.deletedCount(),1);
});
test('原卡身份不匹配（旧卡/迟到回执代际）：删除前就拒绝，零文件操作',async()=>{
  const world=makeWorld({queueJobCommandId:'cmd-other-generation'});
  await assert.rejects(()=>world.retry(),/任务身份或声明产物路径已变化（字段：[^）]*）；未删除文件/);
  assert.equal(world.deletedCount(),0);
  assert.equal(world.cleanupCalls.filter(row=>row.kind==='preview').length,0,'身份未核实前不得连预览都发起');
  assert.deepEqual(world.writes,[]);
});
