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

function makeWorld({secondExisting=false,busyLedger=false,externalBusyBefore=false,previewBarrier=false,holdDialogPhase2=false,gateAWorkerPreparation=false,bSaveBarrier=false}={}){
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
  // r75 opt-in：A 停在 beforeDelete 的 worker 准备长链（无计忙、无写段、不占对话道）——证明该慢链
  // 与机械/对话资源互不占用；默认 false 时 body 不注入该回调，原有世界逐字节同行为。
  let releaseAWorkerPreparation;
  const aWorkerGate=new Promise(resolve=>{releaseAWorkerPreparation=resolve;});
  // r75b 父 seam：B 在"真实预检完成、进入确认之前"的本地 save（读锁已释放、不占对话道）可控暂停；
  // 仅 bSaveBarrier 世界由 drivePlan 实例级包装启用，默认所有场景 drivePlan 不包 save、逐字节不变。
  let releaseBSave;
  const bSaveGate=new Promise(resolve=>{releaseBSave=resolve;});
  // r71 模拟配套 SimpleSFTP 的全实例忙账（真实 currentTransferBusySnapshot 忽略 node/root；r70 回执
  // files.cleanup.execute running/hashing readOnlyObserver=false selfAttempt=false 计忙，preview/inspect
  // 属生产证明 observer）。仅 busyLedger 世界启用，默认世界与原有用例逐字节同行为。
  const sftpBusy={transfers:externalBusyBefore?[{id:'ext-upload-workspace',status:'running',operation:'upload.workspace',phase:'transfer',readOnlyObserver:false,selfAttempt:false}]:[]};
  const blockingBusy=()=>sftpBusy.transfers.some(row=>row.readOnlyObserver!==true&&row.selfAttempt!==true);
  const busyReject=()=>{const blocking=sftpBusy.transfers.filter(row=>row.readOnlyObserver!==true&&row.selfAttempt!==true);
    const error=Error('SimpleSFTP files.cleanup.preview：[ACTIVE_TRANSFER]');
    return Object.assign(error,{apiCode:2010,code:'ACTIVE_TRANSFER',apiData:{code:'ACTIVE_TRANSFER',busy:{
      schemaVersion:1,observedAt:new Date().toISOString(),instanceId:'fake-0.2.110:63892',busy:true,
      activeTransferCount:sftpBusy.transfers.length,blockingTransferCount:blocking.length,
      activeTransfers:sftpBusy.transfers.map(row=>({id:row.id,status:row.status,operation:row.operation,phase:row.phase,
        readOnlyObserver:row.readOnlyObserver===true,selfAttempt:row.selfAttempt===true})),
      observerTransferCount:sftpBusy.transfers.length-blocking.length,
      uploadOperationCount:0,uploadOperations:[],uploadQueueCount:0,uploadQueues:{count:0,keyHashes:[]}}}});};
  let previewEnteredCount=0,releaseFirstPreview=null,releaseDialog=null;
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
      if(holdDialogPhase2&&payload.phase!==1){events.push('dialog-held:'+payload.planFile);
        await new Promise(resolve=>{releaseDialog=resolve;});events.push('dialog-released:'+payload.planFile);}
      else await new Promise(resolve=>setImmediate(resolve));
      return payload.phase===1?'rerun_all':'isolate_and_run';},
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
      if(token==='tok-a'){events.push('execute-start:tok-a');
        if(busyLedger)sftpBusy.transfers.push({id:'transfer-cleanup-execute-a',status:'running',operation:'files.cleanup.execute',phase:'hashing',readOnlyObserver:false,selfAttempt:false});
        try{await aExecuteGate;
          if(failAExecute){events.push('execute-fail:tok-a');throw Error('ISOLATE_TARGET_CONFLICT');}
          events.push('execute-done:tok-a');}
        finally{if(busyLedger)sftpBusy.transfers=sftpBusy.transfers.filter(row=>row.id!=='transfer-cleanup-execute-a');}}
      else events.push('execute-done:'+token);
      return {state:'completed',pendingNodes:[]};},
    service:{
      prepareEmptyParentCleanup:async()=>[],confirmEmptyParentCleanup:async()=>{},
      preview:async params=>{events.push('preview:'+params.planFile);
        if(busyLedger&&blockingBusy()){events.push('preview-busy-reject:'+params.planFile);throw busyReject();}
        if(previewBarrier){previewEnteredCount+=1;events.push('preview-enter:'+params.planFile);
          if(previewEnteredCount===1)await new Promise(resolve=>{releaseFirstPreview=resolve;setTimeout(resolve,800);});
          else if(releaseFirstPreview)releaseFirstPreview();
          events.push('preview-resumed:'+params.planFile);}
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
    isolatedDeletes:()=>isolatedDeletes,sftpBusy:()=>sftpBusy.transfers.map(row=>({...row})),
    aWorkerGate:gateAWorkerPreparation?aWorkerGate:undefined,
    bSaveGate:bSaveBarrier?bSaveGate:undefined,
    releaseAExecute:()=>releaseAExecute(),failAExecute:()=>{failAExecute=true;releaseAExecute();},
    releaseDialog:()=>{if(releaseDialog)releaseDialog();},
    releaseAWorkerPreparation:()=>releaseAWorkerPreparation(),releaseBSave:()=>releaseBSave()};
}

async function drivePlan(world,batch,plan){
  // 只驱动生产真实形态：legacy 恒以 confirmGateLocal 注入批次对话道、以 isolationGateLocal 注入同批
  // 隔离读写协调道（两行均由接线钉固定，不再由本测试按源码正则自选形态——被测源码不得自证）。
  // prepareCode 走批次 once 道，机械链在对话道之外；协调道只覆盖隔离机械 I/O 临界段。
  const body={planFile:plan.planFile,planRevision:plan.revision,runReplacement:{},options:{planFile:plan.planFile},
    submissionOperationIdLocal:'op-'+plan.planFile,reportPlanStageLocal:()=>{},
    confirmGateLocal:work=>batch.serial('outputs',work),
    isolationGateLocal:(kind,work)=>batch.isolation(kind,async()=>{await batch.verify(body);return work();})};
  if(world.aWorkerGate&&plan===world.plans[0])body.awaitWorkerPreparationLocal=()=>world.aWorkerGate;
  await batch.prepareCode(body);
  const chain=async()=>{
    const runHost=new PlanRunHost(world.host,world.root);
    // r75b 实例级 opt-in：仅本 world 的 B 包装"预检已建、choice 未选"的首次本地 save（原 save 照常
    // 先执行，随后暂停于 bSaveGate；该点不持机械读锁与对话道）。默认 world 不注入，行为逐字节不变。
    if(world.bSaveGate&&plan===world.plans[1]){
      const originalSave=runHost.save.bind(runHost);let saveBarrierUsed=false;
      runHost.save=async(saveBody)=>{await originalSave(saveBody);
        if(!saveBarrierUsed&&saveBody.runReplacement?.previews?.length&&!saveBody.runReplacement.choice){
          saveBarrierUsed=true;world.events.push('save-barrier:plans/clean.yaml');await world.bSaveGate;}};
    }
    await runHost.replace({planFile:plan.planFile},body,{jobs:plan.jobs,execution_mode:'train'});
    world.events.push('enqueue:'+plan.planFile);
    return body;};
  return chain();
}

test('a plan whose isolation is held never blocks another plan of the same batch from confirming and dispatching',async()=>{
  const world=makeWorld();
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    const taskA=drivePlan(world,batch,world.plans[0]);
    for(let i=0;i<200 && !world.events.includes('execute-start:tok-a');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(world.events.includes('execute-start:tok-a'),'A 必须已到达隔离执行');
    const taskB=drivePlan(world,batch,world.plans[1]).then(()=>({done:true}),error=>({done:false,error}));
    const early=await Promise.race([taskB,new Promise(resolve=>setTimeout(()=>resolve({done:'pending'}),50))]);
    assert.equal(early.done,'pending','协调语义：B 的读段排在 A 自有写临界段之后正确等待（不冲撞、不被忙拒），不再要求无守卫直接通过（父 r71b 裁定映射）');
    world.releaseAExecute();
    const settled=await Promise.race([taskB,new Promise(resolve=>setTimeout(()=>resolve({done:'pending'}),1500))]);
    assert.equal(settled.done,true,'A 自有临界段一释放，B 必须正确、及时继续并提交完成（"及时继续+不冲撞"替代"忙窗内已预检"字面）：'+String(settled.error?.apiData?.code||settled.error?.message||'pending'));
    assert.ok(world.events.includes('preview:plans/clean.yaml'),'B 的预检在临界段释放后完成');
    await taskA;
    const events=world.events;
    assert.ok(events.indexOf('enqueue:plans/with-outputs.yaml')>events.indexOf('execute-done:tok-a'),'A 自己的隔离完成仍必须先于 A 的提交');
    assert.equal(world.codeSync(),1,'整批代码同步恰好一次，派发重排不得重复');
    assert.equal(world.isolatedDeletes(),0,'批次内绝不启动隔离区永久删除');
  }finally{world.releaseAExecute();await batch.close();}
});
test('对话道与机械/计忙段互不占用：A execute 挂起计忙期间双产物 B 完成两段确认，B 写段排 A 释放之后，maxDialog=1',async()=>{
  // 父 r75b seam（"无法确定构造"判定已被父裁定不成立，按此实现原契约）：replaceRunOutputs 预检完成后
  // 有一处本地 save（previews 已建、choice 未选；机械读锁已释放、不持对话道），drivePlan 实例级包装
  // 该 save ⇒ 确定构造"B 预检完成、确认未开始"；A 进 execute 计忙后释放 B save ⇒ B 两段确认必须在
  // A execute 仍挂起时完成（阻整条机械于 outputs 的实现在此红）；B 自己的写预检/execute 必须排在 A
  // 临界段释放之后（故意 pending，不当成功）。worker 准备不占资源仍由"A 停 worker 时 B 完成预检"体现。
  const world=makeWorld({secondExisting:true,busyLedger:true,gateAWorkerPreparation:true,bSaveBarrier:true}); // 两个 PLAN 都有旧产物
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    let inDialog=0,maxDialog=0;
    const original=world.host.askRunConfirmation;
    world.host.askRunConfirmation=async payload=>{inDialog+=1;maxDialog=Math.max(maxDialog,inDialog);
      try{return await original(payload);}finally{inDialog-=1;}};
    const taskA=drivePlan(world,batch,world.plans[0]).then(body=>({done:true,body}),error=>({done:false,error}));
    for(let i=0;i<200 && !world.events.includes('ask:2:plans/with-outputs.yaml');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(world.events.includes('ask:2:plans/with-outputs.yaml'),'A 必须已完成两段对话并停在 worker 准备长链');
    assert.deepEqual(world.sftpBusy(),[],'worker 准备无计忙段，不得已有忙账');
    assert.equal(world.events.filter(row=>row==='preflight').length,0,'beforeDelete 在写临界段之外（粒度钉：此时未发生任何 preflight）');
    const taskB=drivePlan(world,batch,world.plans[1]).then(body=>({done:true,body}),error=>({done:false,error}));
    for(let i=0;i<200 && !world.events.includes('save-barrier:plans/clean.yaml');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(world.events.includes('preview:plans/clean.yaml')&&world.events.includes('save-barrier:plans/clean.yaml'),
      'B 真实预检完成且确认前本地 save 已落盘（读锁已释放），停在对话之前');
    assert.ok(!world.events.some(row=>String(row).endsWith(':plans/clean.yaml')&&String(row).startsWith('ask:')),'B 尚未开始任何确认');
    world.releaseAWorkerPreparation();
    for(let i=0;i<200 && !world.events.includes('execute-start:tok-a');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(world.sftpBusy().some(row=>row.operation==='files.cleanup.execute'&&row.readOnlyObserver===false),
      'A 已进计忙段（execute 非 observer 真实在途）');
    const busyStart=world.events.indexOf('execute-start:tok-a');
    world.releaseBSave();
    for(let i=0;i<200 && !world.events.includes('ask:2:plans/clean.yaml');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(world.events.indexOf('ask:1:plans/clean.yaml')>busyStart,'B 的两段确认必须开始于 A 进入计忙段之后（对话道不被机械链占用）');
    assert.ok(world.sftpBusy().some(row=>row.operation==='files.cleanup.execute'),'B 确认推进期间 A execute 仍挂起、忙账仍在');
    const bPending=await Promise.race([taskB,new Promise(resolve=>setTimeout(()=>resolve({done:'pending'}),50))]);
    assert.equal(bPending.done,'pending','B 自己的写预检/execute 必须排 A 释放之后，不得期待 B 此时整个提交完成（故意 pending 不计成功）');
    assert.equal(world.events.filter(row=>row==='preflight').length,1,'B 尚未发生任何写段 RPC（preflight 仍只有 A 自己的 1 次）');
    world.releaseAExecute();
    const settledB=await taskB;const settledA=await taskA;
    assert.equal(settledB.done,true,'A 释放后 B 必须完成：'+String(settledB.error?.apiData?.code||settledB.error?.message||''));
    assert.equal(settledA.done,true,'A 释放后必须完成：'+String(settledA.error?.message||''));
    assert.ok(world.events.lastIndexOf('preflight')>busyStart,'临界顺序：B 的写预检发生在 A 计忙段之后（FIFO 排队证据）');
    assert.ok(world.events.indexOf('ask:2:plans/clean.yaml')<world.events.indexOf('execute-done:tok-a'),'B 确认在 A execute 完成前已就绪（对话未被计忙悬挂）');
    assert.equal(settledB.body.existingOutputChoice,'rerun_all','B 双产物确认结果保持既有语义');
    assert.equal(settledA.body.existingOutputChoice,'rerun_all');
    assert.ok(!world.events.some(row=>String(row).startsWith('preview-busy-reject:')),'全程零忙拒');
    assert.equal(maxDialog,1,'同一时刻至多一个确认页（审核语义不变）');
    assert.ok(world.events.filter(row=>row.startsWith('ask:')).length>=4);
    assert.equal(world.codeSync(),1,'整批代码同步恰好一次');
    assert.equal(world.isolatedDeletes(),0,'批次内绝不启动隔离区永久删除');
  }finally{world.releaseAWorkerPreparation();world.releaseBSave();world.releaseAExecute();await batch.close();}
});
test('a failing isolation never cancels or delays the other plan, keeps the failure detail and never starts a permanent delete',async()=>{
  const world=makeWorld();
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    const taskA=drivePlan(world,batch,world.plans[0]).then(()=>null,error=>error);
    for(let i=0;i<200 && !world.events.includes('execute-start:tok-a');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    const taskB=drivePlan(world,batch,world.plans[1]).then(()=>({done:true}),error=>({done:false,error}));
    const early=await Promise.race([taskB,new Promise(resolve=>setTimeout(()=>resolve({done:'pending'}),50))]);
    assert.equal(early.done,'pending','协调语义：B 在 A 临界段内正确等待（done 判定时点按父裁定移到失败释放之后，不再要求缺守卫假世界直接通过）');
    world.failAExecute();
    const error=await taskA;
    assert.ok(error&&/ISOLATE_TARGET_CONFLICT/.test(String(error.message||error)),'失败细节必须原样保留并上抛');
    const settled=await Promise.race([taskB,new Promise(resolve=>setTimeout(()=>resolve({done:'pending'}),1500))]);
    assert.equal(settled.done,true,'A 失败保留细节并释放临界段后，B 必须独立成功：'+String(settled.error?.apiData?.code||settled.error?.message||'pending'));
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
  // r75 协调接线钉：legacy 必须以 isolationGateLocal 注入同批读写协调道（与本测试 drivePlan 同表面），
  // 获准后段体前必须先过既有 batch.verify(body)（排队窗口内 PLAN/代码变化不得带旧声明继续），
  // PlanRunHost 必须透传给 replaceRunOutputs 的 ports.isolation；缺任一条则生产路径无协调/无 freshness 契约。
  assert.match(legacySource,/body\.isolationGateLocal\s*=\s*\(\s*kind:\s*"read"\s*\|\s*"write",\s*work:\s*\(\)\s*=>\s*Promise<any>\s*\)\s*=>\s*batch\.isolation\(kind,\s*async\s*\(\)\s*=>\s*\{\s*await batch\.verify\(body\);\s*return work\(\); \}\)/,'同批隔离读写协调必须经 isolationGateLocal 注入且获准后先 verify 最新声明');
  assert.match(runHost,/isolation:\s*body\.isolationGateLocal/,'PlanRunHost 必须透传 isolationGateLocal 给 replaceRunOutputs');
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

// ─────────────────────────────────────────────────────────────────────────────────────
// r71 同批隔离机械 I/O 互挡回归（docs/agent-tasks/batch-isolation-coordination-20261025/plan.md）。
// 事实：SimpleSFTP currentTransferBusySnapshot 忽略 node/root 全实例计忙（r70 回执 r70a3-receipt-brief
// 与 r70-snapshot-3b019da9.json：files.cleanup.execute running/hashing，readOnlyObserver=false，
// selfAttempt=false 计忙；preview/inspect 属生产证明 observer 不互挡；uploadOperations=[] 排除外部上传）。
// 当前并发契约允许 A 的 execute 机械段与 B 的新预检重叠，r69 现场 B 因此被全实例忙拒绝。以下用例仍走
// 真实生产入口（PlanSubmissionBatch + PlanRunHost.replace + replaceRunOutputs ports），世界仅新增
// opt-in 观测参数；busy 封套按 r70 真实 schemaVersion:1 形状构造，不做自报 operation 名豁免。
// 协调要求（r73b/r74 已实施）：只等同一活批已知自有隔离临界段；外部忙、跨批、读读并行与对话道语义原样。
// 前两个用例在旧码（无协调）上红（r72/r73 复验 RUN_OUTPUTS_TRANSFER_BUSY），带协调接线后必须绿；
// 后四个是防过度修正护栏；末尾另有协调生命周期用例。
test('旧码红：A 隔离执行忙窗内 B 新预检被全实例忙拒；协调后 B 只等自有临界段并成功提交',async()=>{
  const world=makeWorld({busyLedger:true});
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    const taskA=drivePlan(world,batch,world.plans[0]);
    for(let i=0;i<200&&!world.events.includes('execute-start:tok-a');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(world.events.includes('execute-start:tok-a'),'A 必须已进入隔离 execute 机械段');
    const taskB=drivePlan(world,batch,world.plans[1]).then(()=>({ok:true}),error=>({ok:false,error}));
    await new Promise(resolve=>setTimeout(resolve,50));
    world.releaseAExecute();
    const settled=await Promise.race([taskB,new Promise(resolve=>setTimeout(()=>resolve({ok:'pending'}),1500))]);
    assert.equal(settled.ok,true,'B 应只在同批自有临界段上等待后成功；当前被拒：'+String(settled.error?.apiData?.code||settled.error?.message||'pending'));
    assert.ok(!world.events.some(row=>String(row).startsWith('preview-busy-reject:')),'协调后的 B 不得撞上交叉忙拒');
    assert.ok(world.events.includes('enqueue:plans/clean.yaml'),'B 成功走完成提交');
    await taskA;
    assert.equal(world.isolatedDeletes(),0,'批次内绝不启动隔离区永久删除');
  }finally{world.releaseAExecute();await batch.close();}
});
test('旧码红（失败路径）：A 执行失败并释放忙账后 B 预检成功，不携带残留忙',async()=>{
  const world=makeWorld({busyLedger:true});
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    const taskA=drivePlan(world,batch,world.plans[0]).then(()=>null,error=>error);
    for(let i=0;i<200&&!world.events.includes('execute-start:tok-a');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(world.events.includes('execute-start:tok-a'));
    const taskB=drivePlan(world,batch,world.plans[1]).then(()=>({ok:true}),error=>({ok:false,error}));
    await new Promise(resolve=>setTimeout(resolve,50));
    world.failAExecute();
    const settledB=await Promise.race([taskB,new Promise(resolve=>setTimeout(()=>resolve({ok:'pending'}),1500))]);
    const errorA=await taskA;
    assert.ok(errorA&&/ISOLATE_TARGET_CONFLICT/.test(String(errorA.message||errorA)),'A 的失败细节必须原样上抛');
    assert.equal(settledB.ok,true,'A 的临界段失败释放后 B 必须成功；当前被拒：'+String(settledB.error?.apiData?.code||settledB.error?.message||'pending'));
    assert.ok(!world.events.some(row=>String(row).startsWith('preview-busy-reject:')),'失败释放不得留下残留忙账');
    assert.deepEqual(world.sftpBusy(),[],'fake 忙账必须在 finally 清空');
  }finally{world.failAExecute();await batch.close();}
});
test('护栏：无计忙段时两 Plan 预检仍读读并行（协调不得退化为整批串行）',async()=>{
  const world=makeWorld({previewBarrier:true});
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    const taskA=drivePlan(world,batch,world.plans[0]);
    const taskB=drivePlan(world,batch,world.plans[1]);
    for(let i=0;i<300&&!(world.events.includes('preview-enter:plans/with-outputs.yaml')&&world.events.includes('preview-enter:plans/clean.yaml'));i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    const enters=world.events.filter(row=>String(row).startsWith('preview-enter:'));
    assert.equal(enters.length,2,'两 Plan 预检都必须发生');
    const first=enters[0].slice('preview-enter:'.length),second=enters[1].slice('preview-enter:'.length);
    assert.ok(world.events.indexOf('preview-resumed:'+first)>world.events.indexOf(enters[1]),
      second+' 的预检必须发生在 '+first+' 的预检仍在途期间（读读重叠：首先进入者被 barrier 挂起未返回）');
    world.releaseAExecute();
    const settled=await Promise.race([Promise.all([taskA,taskB]).then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),3000))]);
    assert.ok(settled,'释放自有临界段后两链必须完成（barrier 与协调不得互锁）');
  }finally{world.releaseAExecute();await batch.close();}
});
test('护栏：外部真实 upload 忙仍原样即时 fail-closed 拒绝，协调绝不盲等外部传输',async()=>{
  const world=makeWorld({busyLedger:true,externalBusyBefore:true});
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    const taskB=drivePlan(world,batch,world.plans[1]);
    const settled=await Promise.race([taskB.then(()=>({ok:true}),error=>({ok:false,error})),new Promise(resolve=>setTimeout(()=>resolve({ok:'pending'}),1500))]);
    assert.equal(settled.ok,false,'外部忙必须照旧拒绝，不得被本批协调等待或豁免');
    assert.match(String(settled.error?.apiData?.code||settled.error?.apiData?.detail||settled.error?.message||''),/RUN_OUTPUTS_TRANSFER_BUSY/,'外部忙归因保持可重试的传输忙语义');
    assert.ok(world.events.includes('preview-busy-reject:plans/clean.yaml'),'忙拒绝证据在事件流可见（及时失败而非挂起）');
    assert.deepEqual(world.events.filter(row=>/^(execute|confirm|hold|queue-write)/.test(String(row))),[],'忙时零执行零确认零队列写');
  }finally{await batch.close();}
});
test('护栏：跨批预检不共享本批协调豁免，忙窗内仍 fail-closed 拒绝',async()=>{
  const world=makeWorld({busyLedger:true});
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  const plansOther=[{planFile:'plans/other-batch.yaml',revision:'',jobs:[{index:0,case:'caseD',seed:4,output_dir:'work_dirs/d',result_csv:'work_dirs/d/m.csv'}],existing:false,token:'tok-d'}];
  fs.mkdirSync(path.join(world.root,'plans'),{recursive:true});
  fs.writeFileSync(path.join(world.root,'plans/other-batch.yaml'),'name: plans/other-batch.yaml\n');
  plansOther[0].revision=crypto.createHash('sha256').update(fs.readFileSync(path.join(world.root,'plans/other-batch.yaml'),'utf8')).digest('hex');
  const batch2=new PlanSubmissionBatch(world.host,{root:world.root},plansOther,()=>{},()=>{});
  try{
    await batch.start();await batch2.start();
    const taskA=drivePlan(world,batch,world.plans[0]);
    for(let i=0;i<200&&!world.events.includes('execute-start:tok-a');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(world.events.includes('execute-start:tok-a'));
    const taskC=drivePlan(world,batch2,plansOther[0]);
    const settled=await Promise.race([taskC.then(()=>({ok:true}),error=>({ok:false,error})),new Promise(resolve=>setTimeout(()=>resolve({ok:'pending'}),1500))]);
    assert.equal(settled.ok,false,'另一批的预检不得被本批协调代等或豁免');
    assert.ok(world.events.includes('preview-busy-reject:plans/other-batch.yaml'),'跨批撞上忙窗必须照旧留下忙拒证据');
    assert.match(String(settled.error?.apiData?.code||''),/RUN_OUTPUTS_TRANSFER_BUSY/);
    world.releaseAExecute();
    await taskA;
  }finally{world.releaseAExecute();await batch.close();await batch2.close();}
});
test('护栏：人工精确路径确认(phase2)被挂起期间不持机械资源——同批他 Plan 预检提交照常完成',async()=>{
  const world=makeWorld({busyLedger:true,holdDialogPhase2:true});
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    const taskA=drivePlan(world,batch,world.plans[0]);
    for(let i=0;i<300&&!world.events.includes('dialog-held:plans/with-outputs.yaml');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(world.events.includes('dialog-held:plans/with-outputs.yaml'),'A 必须停在 phase2 精确路径确认（此时写段未开始，忙账为空）');
    assert.deepEqual(world.sftpBusy(),[],'phase2 确认在 beforeDelete/preflight/execute 之前，不得已有计忙段');
    const taskB=drivePlan(world,batch,world.plans[1]);
    const settled=await Promise.race([taskB.then(()=>({ok:true}),error=>({ok:false,error})),new Promise(resolve=>setTimeout(()=>resolve({ok:'pending'}),1500))]);
    assert.equal(settled.ok,true,'A 仅在等人：B 的预检与提交不得被排队（人工 ask 绝不持机械锁；协调若把写锁提到确认前将在此红）：'+String(settled.error?.apiData?.code||settled.error?.message||'pending'));
    assert.ok(world.events.includes('enqueue:plans/clean.yaml'));
    world.releaseDialog();
    world.releaseAExecute(); // A 释放确认后必进 execute 门；显式先释放再收链（finally 仍幂等兜底），避免用例末尾等待 finally 才释放的 gate
    await taskA;
  }finally{world.releaseDialog();world.releaseAExecute();await batch.close();}
});

test('协调生命周期：FIFO 后到不越队、获准即抛错必须释放、close 全量结算在途并拒绝排队',async()=>{
  // r74 父审两缺口的行为钉（直接驱动生产原语 PlanSubmissionBatch.isolation/close，不新增进程）：
  // ①FIFO——写占用时读者与后写者按队列序获准，读者不得越过队首写者；②排队获准瞬间上下文变化⇒
  // work 不执行、占用经 finally 归零、后续合理清退不悬挂；③close 先拒未获准等待（不运行 work），
  // 再等待已入 work 的完整生命周期，不得提前结算。
  let ctxInvalid=false;
  const world=makeWorld();
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{if(ctxInvalid)throw Error('CTX_CHANGED_DURING_WAIT');},()=>{});
  try{
    await batch.start();
    let releaseW1;const w1Gate=new Promise(resolve=>{releaseW1=resolve;});
    const order=[];
    const w1=batch.isolation('write',async()=>{order.push('w1');await w1Gate;order.push('w1-end');});
    const r1=batch.isolation('read',async()=>{order.push('r1');});
    const w2=batch.isolation('write',async()=>{order.push('w2');});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(order,['w1'],'写占用期间读者与后写者都必须在队上');
    releaseW1();
    await Promise.all([w1,r1,w2]);
    assert.deepEqual(order,['w1','w1-end','r1','w2'],'FIFO：按到达序结算，r1 与其后 w2 不得互相越过');
    let releaseW3;const w3Gate=new Promise(resolve=>{releaseW3=resolve;});
    const w3=batch.isolation('write',async()=>{await w3Gate;});
    let r4Ran=false;
    const r4=batch.isolation('read',async()=>{r4Ran=true;}).then(()=>null,error=>error);
    await new Promise(resolve=>setImmediate(resolve));
    ctxInvalid=true;releaseW3();
    const r4err=await r4;
    assert.match(String(r4err?.message||r4err),/CTX_CHANGED_DURING_WAIT/,'排队获准瞬间上下文变化必须拒绝，绝不运行 work');
    assert.equal(r4Ran,false,'被拒的调用不得产生任何机械 I/O');
    ctxInvalid=false;
    let r5Ran=false;await batch.isolation('read',async()=>{r5Ran=true;});
    assert.ok(r5Ran,'异常释放后活计数归零，队列不得泄漏或悬挂');
    let releaseWork;const workGate=new Promise(resolve=>{releaseWork=resolve;});
    const inFlight=batch.isolation('write',async()=>{await workGate;}).catch(()=>{});
    let queuedRan=false;
    const queued=batch.isolation('read',async()=>{queuedRan=true;}).then(()=>null,error=>error);
    await new Promise(resolve=>setImmediate(resolve));
    let closeDone=false;const closing=batch.close().then(()=>{closeDone=true;});
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(closeDone,false,'已入 work 未结算时 close 不得提前完成（rename 在途不得被当作已结算）');
    releaseWork();
    await closing;await inFlight;
    const queuedErr=await queued;
    assert.equal(queuedRan,false,'close 时仍在排队的调用绝不运行 work');
    assert.match(String(queuedErr?.message||queuedErr),/本批提交已结束/,'排队调用被 close 显式拒绝，不悬挂');
  }finally{try{await batch.close();}catch{/* 幂等兜底 */}}
});

// ── r82（0.5.414）：运行选择与安全准入分离 —— 派发路径接线回归 ──────────────────────
// 现场（GPT 计划 r80 锚点）：replaceRunOutputs 已把隔离失败 job 排除出准入（PlanRunHost.ts:216-219），
// 但 legacy.ts 两处 rerun_all 处理又把排除表清空/忽略（:8269-8270、:13423），队列没有独立隔离门槛，
// 被阻断 job 仍照常派发，远端 cluster_agent.py:7310 FORMAL_JOB_CONFLICT 退出 1、训练未启动。
// 修复契约：blocked 独立于 distributedSkipJobIndices；入队保留可见的 pending+marker；派发四条路径过滤；
// 最终发送前按最新持久状态再核。以下在 413 上必须红，修复后转绿。
test('r82 red wiring pins: rerun_all 不得清空安全排除；入队选择走共享 planDispatchSelection；占用核查豁免含阻断 job',()=>{
  assert.equal(/=== "rerun_all"\)\s*\n\s*body\.distributedSkipJobIndices = \[\];/.test(legacySource),false,
    '8269-8270 的 rerun_all 无条件清空安全排除结果必须删除（用户选择=想全跑，只有安全准入者可派发）');
  assert.equal(/existingOutputChoice !== "rerun_missing" \? \[\]/.test(legacySource),false,
    '13423 的"非补跑即清空"必须改为共享选择函数；隔离阻断不得随 rerun_all 蒸发');
  assert.match(legacySource,/planDispatchSelection\(/,'入队必须经 DistributedPlanQueue.planDispatchSelection 统一划分 可执行/隔离暂停/有意跳过');
  assert.match(legacySource,/runReplacement[\s\S]{0,200}blocked[\s\S]{0,160}assertLaunchObservations|launchObservationExempt/,'占用核查豁免集必须显式包含隔离阻断 job（本轮不派发故不核查，且豁免是显式决定而非清空排除表的副作用）');
});
test('r82 red: planDispatchSelection keeps blocked jobs visible-unlaunchable in both rerun_all and rerun_missing; user skips stay skipped',()=>{
  const {planDispatchSelection}=require('../../src/features/DistributedPlanQueue.ts');
  assert.equal(typeof planDispatchSelection,'function','必须提供共享选择函数（提交体→队列→派发同一事实源）');
  const validation={jobs:[0,1,2].map(index=>({index,case:'case'+index,seed:index,output_dir:'work/job'+index,result_csv:'tmp/r'+index+'.csv'}))};
  const bodyBase=()=>({existingOutputChoice:'rerun_all',distributedSkipJobIndices:[],
    runReplacement:{flow:'isolate',choice:'rerun_all',blocked:[{index:1,reason:'nwpu3：ACTIVE_TRANSFER SimpleSFTP files.cleanup.execute：[ACTIVE_TRANSFER]',stage:'execute',code:'ACTIVE_TRANSFER'}]}});
  for(const choice of ['rerun_all','rerun_missing']){
    const body=bodyBase();body.existingOutputChoice=choice;if(choice==='rerun_missing')body.distributedSkipJobIndices=[2];
    const s=planDispatchSelection(validation,body);
    assert.ok(!s.launchableJobs.some(job=>Number(job.index)===1),'隔离未完成的 job 绝不进入可派发选择（两路一致）');
    assert.ok(s.selectedJobs.some(job=>Number(job.index)===1),'阻断 job 必须仍入队（可见、待处理），不得静默消失');
    const marker=s.blockedMarkers.get(1);assert.ok(marker,'隔离阻断 job 必须带 marker');assert.equal(marker.stage,'execute');assert.equal(marker.code,'ACTIVE_TRANSFER');
    assert.equal(marker.declarationKey,'work/job1');assert.ok(marker.observedAt);
    // r84 机械修（父裁定）：原式 !(…)===choice==='rerun_missing' 因 === 左结合恒为 false（4/4 组合复现，见 block2-stage-brief.md r84 节），与实现对错无关。
    // 期望方向逐字不变：rerun_missing 时 job2 不入队；rerun_all 时 job2 入选（此前"沿用完成"的 job 重新回流，仍受隔离门槛约束）。
    const job2Selected = s.selectedJobs.some(job => Number(job.index) === 2);
    assert.equal(job2Selected, choice !== 'rerun_missing',
      '有意跳过（rerun_missing 沿用完成）不入队；rerun_all 时 job2 是正常可执行');
    assert.ok(!(s.userSkipped.has(1)),'隔离失败绝不得计作"沿用完成/有意跳过"');
    if(choice==='rerun_missing')assert.ok(s.launchableJobs.some(job=>Number(job.index)===0),'补跑路：未跳过的干净 job 可派发');
    else assert.ok(s.launchableJobs.some(job=>Number(job.index)===2),'全跑路：未阻断的干净 job 可派发');
  }
});

test('排队窗口的既有 freshness 契约：等待期间 PLAN 被修改，获准后先经 batch.verify 拒绝，零下游 RPC 且名额释放',async()=>{
  // r75 父裁定：写/读段可能等他 Plan 临界段数秒，等待中用户改 PLAN/代码时，beforeDelete 的核对已过时；
  // legacy isolationGateLocal 在获准后、段体前复用既有 batch.verify(body)（不 memo、不放宽、长准备不入锁）。
  // 既有 verify 在"提交入口"的覆盖由 planRunRecovery 等承载；本用例只钉新增排队窗口这一新边界。
  const world=makeWorld();
  const batch=new PlanSubmissionBatch(world.host,{root:world.root},world.plans,()=>{},()=>{});
  try{
    await batch.start();
    const taskA=drivePlan(world,batch,world.plans[0]);
    for(let i=0;i<200&&!world.events.includes('execute-start:tok-a');i+=1)await new Promise(resolve=>setTimeout(resolve,5));
    const taskB=drivePlan(world,batch,world.plans[1]).then(()=>({done:true}),error=>({done:false,error}));
    await new Promise(resolve=>setTimeout(resolve,50));
    fs.writeFileSync(path.join(world.root,'plans/clean.yaml'),'name: plans/clean.yaml\n# modified during queue wait\n');
    world.releaseAExecute();
    const settled=await Promise.race([taskB,new Promise(resolve=>setTimeout(()=>resolve({done:'pending'}),1500))]);
    assert.equal(settled.done,false,'排队期间 PLAN 已修改的调用必须被既有 verify 契约拒绝，绝不带旧声明继续');
    assert.match(String(settled.error?.message||''),/PLAN 已修改/,'失败原因必须是既有"PLAN 已修改，请重新提交本批"契约文案：'+String(settled.error?.message||settled.error?.apiData?.code||''));
    assert.ok(!world.events.includes('preview:plans/clean.yaml'),'拒绝发生在任何下游预检 RPC 之前（零机械 I/O）');
    assert.equal(world.events.filter(row=>row==='preflight').length,1,'B 不得发生任何 preflight 写段 RPC（仅 A 自己的 1 次）');
    await taskA;
    let ran=false;await batch.isolation('read',async()=>{ran=true;});
    assert.ok(ran,'被拒调用经隔离生命周期 finally 释放名额，队列不得泄漏悬挂');
    assert.equal(world.isolatedDeletes(),0,'失败批次内绝不起永久删除');
  }finally{world.releaseAExecute();await batch.close();}
});
