const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
require('../_helpers/registerTsRequire');
const {PlanRunHost}=require('../../src/extension/PlanRunHost.ts');
const {PlanSubmissionBatch}=require('../../src/features/PlanSubmissionBatch.ts');
const {canonicalProjectId}=require('../../src/features/DistributedPlanQueue.ts');

// 批次实况（2026-10-21 18:13–18:20，12 PLAN 批次）：带旧产物的 PLAN 在批次共享的 serial("outputs")
// 道上执行完整隔离链（两次确认+逐 job 执行+核验+hold），后续 PLAN 的确认与提交全部排队；
// 一次慢隔离（传输忙快照/远端往返）把整批提交拖成分钟级。
// 用户要求：提交只做经审核的精确目录 rename 隔离并证明源路径已释放，然后继续原并发派发；
// 本批初始冻结的全部 PLAN 完成派发准入后，隔离产物的独立删除审核才开始。
// 本回归驱动真实生产入口 PlanRunHost.replace + 真实 PlanSubmissionBatch（真实 lanes/once/verify 语义），
// 并按 legacy.ts 当前实际接线选择形态：基线把整条隔离链包进 batch.serial("outputs")，
// 候选只把对话确认经 confirmGateLocal 送进该道。交互确认仍全局串行（一次只有一个确认页），
// 但重机械链不得占住别的 PLAN 的提交。不启动真实 VSCode/服务器；
// stubs 忠实保留 mutateLatest、确认相位与失败语义。
const legacySource=fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
const PRODUCTION_WRAPS_WHOLE_CHAIN=/batch\.serial\("outputs",\s*confirmOutputs\)/.test(legacySource);

function makeWorld({secondExisting=false}={}){
  const root=path.join(fs.realpathSync(os.tmpdir()),'v15-dispatch-first-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(16).slice(2));
  fs.mkdirSync(root,{recursive:true});
  const storage=path.join(root,'storage');
  const digest=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
  const plans=[
    {planFile:'plans/with-outputs.yaml',revision:'',jobs:[{index:0,case:'caseA',seed:1,output_dir:'work_dirs/a',result_csv:'work_dirs/a/m.csv'}],existing:true,token:'tok-a'},
    {planFile:'plans/clean.yaml',revision:'',jobs:[{index:0,case:'caseC',seed:3,output_dir:'work_dirs/c',result_csv:'work_dirs/c/m.csv'}],existing:secondExisting,token:'tok-c'},
  ];
  for(const plan of plans){
    fs.mkdirSync(path.join(root,path.dirname(plan.planFile)),{recursive:true});
    fs.writeFileSync(path.join(root,plan.planFile),'name: '+plan.planFile+'\n');
    plan.revision=digest(fs.readFileSync(path.join(root,plan.planFile),'utf8'));
  }
  const events=[];
  let releaseAExecute,rejectAExecute;
  const aExecuteGate=new Promise((resolve,reject)=>{releaseAExecute=resolve;rejectAExecute=reject;});
  let queue={plans:plans.filter(plan=>plan.existing).map(plan=>({id:'wf-'+plan.planFile,
    jobs:plan.jobs.map(job=>({index:job.index,outputDir:job.output_dir,collectionResultCsv:job.result_csv}))})),clearedJobs:[]};
  const writes=[]; let codeSyncCalls=0; let isolatedDeletes=0; let failAExecute=false;
  const fingerprint='fp-batch';
  const host={
    context:{globalStorageUri:{fsPath:storage}},
    localDistributedCodeFingerprint:async()=>fingerprint,
    ensureCodeReadyForRun:async()=>{codeSyncCalls+=1;await new Promise(setImmediate);
      host.lastCodeSyncState={fingerprint,workerVersions:{w1:{fingerprint}}};},
    lastCodeSyncState:{fingerprint,workerVersions:{w1:{fingerprint}}},
    enabledWorkerConfigs:()=>[{id:'w1'}],
    captureProjectContext:()=>({root}),
    projectContextIsCurrent:context=>context.root===root,
    workerActionTargets:()=>[{id:'w1',host:'h1.example',port:22,user:'u',project_dir:'/srv/proj'}],
    effectiveConnectionMode:()=>'realtime',
    askRunConfirmation:async payload=>{events.push('ask:'+payload.phase+':'+payload.planFile);
      await new Promise(resolve=>setImmediate(resolve)); return payload.phase===1?'rerun_all':'isolate_and_run';},
    refreshLocalPlanMetadataForAction:body=>{const plan=plans.find(row=>row.planFile===body.planFile);
      if(plan)body.planRevision=plan.revision;},
    stampPlanRevision:()=>{}, assertPlanSubmissionWorkers:async()=>{},
    saveDistributedQueue:async(_root,_queue,options)=>{
      // 与真实 mutateLatest 合同一致：事务内读最新、变异；抛错即整笔未写。
      const latest=JSON.parse(JSON.stringify(queue));
      const next=options.mutateLatest(latest);
      if(next!==latest){queue=next;writes.push(JSON.parse(JSON.stringify(next)));}
      events.push('queue-write');},
  };
  host.planCleanupHost=()=>({
    execute:async token=>{
      if(token==='tok-a'){events.push('execute-start:tok-a');await aExecuteGate;
        if(failAExecute){events.push('execute-fail:tok-a');throw Error('ISOLATE_TARGET_CONFLICT');}
        events.push('execute-done:tok-a');}
      else events.push('execute-done:'+token);
      return {state:'completed',pendingNodes:[]};},
    service:{
      preview:async params=>{events.push('preview:'+params.planFile);
        const plan=plans.find(row=>row.planFile===params.planFile)||plans[0];
        return {token:plan.token,digest:'digest-'+plan.token,action:'isolate',scope:undefined,
          rows:plan.existing?[{disposition:'isolate',type:'directory',absolutePath:'/srv/proj/'+plan.jobs[0].output_dir,
            node:{id:'w1',kind:'remote',host:'h1.example',port:22,user:'u'}}]:[],
          blockers:[],verifiedOnly:false,expiresAt:Date.now()+60000,confirmations:0};},
      confirm:async()=>{events.push('confirm');},
      preflightConfirmed:async()=>{events.push('preflight');},
      status:async token=>{if(token==='tok-a'&&failAExecute)throw Error('ISOLATE_TARGET_CONFLICT');return {state:'completed'};},
      execute:async()=>({state:'completed',pendingNodes:[]}),
      assertIsolatedSourcesAbsent:async()=>{events.push('verify');},
      isolatedDeletePreview:async()=>{isolatedDeletes+=1;throw Error('批次内不得启动隔离区永久删除');},
    },
  });
  return {root,storage,plans,events,writes,host,queue:()=>queue,codeSync:()=>codeSyncCalls,
    isolatedDeletes:()=>isolatedDeletes,
    releaseAExecute:()=>releaseAExecute(),failAExecute:()=>{failAExecute=true;releaseAExecute();}};
}

async function drivePlan(world,batch,plan){
  // 只驱动生产真实形态：legacy 恒以 confirmGateLocal 注入批次对话道（由接线钉固定，不再由本测试
  // 按源码正则自选形态——被测源码不得自证）。prepareCode 走批次 once 道，机械链在对话道之外。
  const body={planFile:plan.planFile,planRevision:plan.revision,runReplacement:{},options:{planFile:plan.planFile},
    submissionOperationIdLocal:'op-'+plan.planFile,reportPlanStageLocal:()=>{},
    confirmGateLocal:work=>batch.serial('outputs',work)};
  await batch.prepareCode(body);
  const chain=async()=>{
    await new PlanRunHost(world.host,world.root).replace({planFile:plan.planFile},body,
      {jobs:plan.jobs,execution_mode:'train'});
    world.events.push('enqueue:'+plan.planFile);
    return body;};
  return chain();
}
const completesBy=(promise,ms)=>Promise.race([promise.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),ms))]);

test('a plan whose isolation is held never blocks another plan of the same batch from confirming and dispatching',async()=>{
  const world=makeWorld();
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    const taskA=drivePlan(world,batch,world.plans[0]);
    for(let i=0;i<200 && !world.events.includes('execute-start:tok-a');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(world.events.includes('execute-start:tok-a'),'A 必须已到达隔离执行');
    const taskB=drivePlan(world,batch,world.plans[1]);
    const done=await completesBy(taskB,1500);
    assert.ok(done,'B 的确认与提交不得排在 A 的隔离执行之后（当前批次慢的根因）');
    assert.ok(world.events.includes('preview:plans/clean.yaml'),'B 的产物预览必须在 A 隔离未完时已进行');
    world.releaseAExecute();
    await taskA;
    const events=world.events;
    assert.ok(events.indexOf('enqueue:plans/with-outputs.yaml')>events.indexOf('execute-done:tok-a'),'A 自己的隔离完成仍必须先于 A 的提交');
    assert.equal(world.codeSync(),1,'整批代码同步恰好一次，派发重排不得重复');
    assert.equal(world.isolatedDeletes(),0,'批次内绝不启动隔离区永久删除');
  }finally{world.releaseAExecute();await batch.close();}
});
test('interactive confirmations of different plans stay globally serialized while their mechanical chains overlap',async()=>{
  const world=makeWorld({secondExisting:true}); // 两个 PLAN 都有旧产物
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    let inDialog=0,maxDialog=0;
    const original=world.host.askRunConfirmation;
    world.host.askRunConfirmation=async payload=>{inDialog+=1;maxDialog=Math.max(maxDialog,inDialog);
      try{return await original(payload);}finally{inDialog-=1;}};
    const taskA=drivePlan(world,batch,world.plans[0]);
    for(let i=0;i<200 && !world.events.includes('execute-start:tok-a');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    const taskB=drivePlan(world,batch,world.plans[1]);
    const done=await completesBy(taskB,1500);
    world.releaseAExecute();
    const bodies=await Promise.all([taskA,taskB]);
    assert.ok(done,'B 的确认与隔离不得排在 A 的隔离执行之后');
    assert.equal(maxDialog,1,'同一时刻至多一个确认页（审核语义不变）');
    assert.ok(world.events.filter(row=>row.startsWith('ask:')).length>=4);
    assert.deepEqual(bodies.map(body=>body.existingOutputChoice),['rerun_all','rerun_all']);
  }finally{world.releaseAExecute();await batch.close();}
});
test('a failing isolation never cancels or delays the other plan, keeps the failure detail and never starts a permanent delete',async()=>{
  const world=makeWorld();
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    const taskA=drivePlan(world,batch,world.plans[0]).then(()=>null,error=>error);
    for(let i=0;i<200 && !world.events.includes('execute-start:tok-a');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    const taskB=drivePlan(world,batch,world.plans[1]);
    const done=await completesBy(taskB,1500);
    assert.ok(done,'B 不受 A 慢隔离影响');
    world.failAExecute();
    const error=await taskA;
    assert.ok(error&&/ISOLATE_TARGET_CONFLICT/.test(String(error.message||error)),'失败细节必须原样保留并上抛');
    assert.ok(world.events.includes('preview:plans/clean.yaml'),'B 不受 A 失败影响');
    assert.equal(world.isolatedDeletes(),0,'失败后隔离区保持原样，绝不起永久删除');
  }finally{world.failAExecute();await batch.close();}
});
test('production wiring: only the interactive confirmation block takes the batch dialog lane, the mechanical chain does not hold it',()=>{
  // 接线钉（诚实标注为源码钉，不执行扩展宿主）：
  // legacy 批次路径必须把批次对话道作为 confirmGateLocal 传入，且不再用 serial("outputs") 包整条隔离链；
  // PlanRunHost 必须透传 confirmGateLocal 给 replaceRunOutputs 的 ports.interactive；
  // replaceRunOutputs 只在两段对话/精确确认块上进对话道，机械链（预览/隔离执行/核验/hold）在道外。
  assert.ok(!PRODUCTION_WRAPS_WHOLE_CHAIN,'legacy 不得再用 batch.serial("outputs", confirmOutputs) 包整条隔离链');
  assert.match(legacySource,/confirmGateLocal\s*=\s*\(?\s*work\s*\)?\s*=>\s*batch\.serial\("outputs",\s*work\)/,'批次确认道必须经 confirmGateLocal 注入');
  const runHost=fs.readFileSync(path.resolve(__dirname,'../../src/extension/PlanRunHost.ts'),'utf8');
  assert.match(runHost,/interactive:\s*work\s*=>\s*\(body\.confirmGateLocal\s*\|\|/,'PlanRunHost 必须透传 confirmGateLocal 给 replaceRunOutputs');
  const replacement=fs.readFileSync(path.resolve(__dirname,'../../src/features/PlanRunReplacement.ts'),'utf8');
  assert.equal((replacement.match(/await gate\(async \(\)/g)||[]).length,2,'两段对话/精确确认块必须显式经对话道执行');
  assert.ok(replacement.indexOf('await ports.beforeDelete()')>replacement.lastIndexOf('await gate(async ()'),'机械链（beforeDelete 起）必须在对话道之外继续');
  // 过期轮次：两处围栏都必须原地附上 STALE_QUEUE_ROUND 码（构造只用 Error 本身，供沙箱化回归直接提取），
  // 自动 tick 噪声被抑制但围栏保留（fence 行为由两处构造+throw 计数钉住）。
  assert.equal((legacySource.match(/stale\.code = "STALE_QUEUE_ROUND";\s*\n?\s*throw stale;/g)||[]).length,2,'两处过期轮次围栏都必须带码并抛出');
  assert.ok((legacySource.match(/error\?\.code === "STALE_QUEUE_ROUND"/g)||[]).length>=8,'自动 tick 捕获点必须统一降噪');
  assert.equal((legacySource.match(/throw staleQueueRoundError\(\)/g)||[]).length,0,'围栏不得依赖沙箱不可见的模块级 helper');
  // 整批派发准入之后才浮出隔离区独立删除审核提示；提示只说入口，绝不自动删除、绝不称已运行。
  assert.match(legacySource,/planIsolatedReplacementsLocal\.set\(operationId/,'旧产物隔离事实必须按 operationId 记录');
  const batchHost=fs.readFileSync(path.resolve(__dirname,'../../src/extension/SelectedPlanBatchHost.ts'),'utf8');
  assert.ok(batchHost.indexOf('isolatedMap instanceof Map')>batchHost.indexOf('await Promise.all(Array.from({ length: Math.min(4'),'审核提示必须排在全部并发派发链完成之后');
  assert.match(batchHost,/永久删除不会自动开始/);
  assert.match(batchHost,/运行状态以任务卡片实时查询为准/);
});
