const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
require('../_helpers/registerTsRequire');
const {PlanRunHost}=require('../../src/extension/PlanRunHost.ts');
const {canonicalProjectId}=require('../../src/features/DistributedPlanQueue.ts');

// 真实业务边界（2026-10-21 15:26–15:35 image_only/qmf/raml）：用户上一批已“终止并清除”旧卡，
// 声明进入 clearedJobs 而磁盘产物仍在。本轮覆盖重跑走真实 PlanRunHost.replace → replaceRunOutputs：
// 预览 → 运行范围确认 → 隔离双确认 → service.execute 完成隔离 → hold 队列围栏 → 提交可继续。
// 基线在 hold 处抛 HOLD_TARGET_NOT_FOUND（隔离已完成、提交被中止）；候选对正式清除证明必须走通。
// 真实不匹配（既无队列声明也无正式清除证明）必须仍失败，且队列一字不写。
// 不启动真实 VSCode/服务器；确认、隔离与写互斥的调用顺序与失败语义由 stub 忠实保留。

function makeHarness(clearedJobsFor){
  const root=path.join(fs.realpathSync(os.tmpdir()),'v15-hold-chain-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(16).slice(2));
  fs.mkdirSync(root,{recursive:true});
  const storage=path.join(root,'storage');
  const project=canonicalProjectId(root);
  const planFile='plans/a.yaml';
  const revision='rev-1', fingerprint='fp-1';
  const formal=(projectArg,planArg)=>({projectId:projectArg,workflowId:'run-old',planFile:planArg,planRevision:revision,
    codeFingerprint:fingerprint,experimentIndex:0,case:'case0',seed:42,resultPathPolicy:'declared',
    outputDir:'work_dirs/a',collectionResultCsv:'work_dirs/a/m.csv',status:'completed',clearedAt:'2026-10-20T18:41:26.440Z'});
  let queue={plans:[],clearedJobs:clearedJobsFor(project,planFile,revision,fingerprint,formal)};
  const writes=[]; const calls=[];
  const preview={token:'tok-a',digest:'digest-a',action:'isolate',scope:undefined,
    rows:[{disposition:'isolate',type:'directory',absolutePath:'/srv/proj/work_dirs/a',
      node:{id:'w1',kind:'remote',host:'h1.example',port:22,user:'u'}}],
    blockers:[],verifiedOnly:false,expiresAt:Date.now()+60000,confirmations:0};
  const host={
    context:{globalStorageUri:{fsPath:storage}},
    planCleanupHost:()=>({
      // ports.execute 真实接线走 cleanup.execute(token)，不是 service.execute。
      execute:async()=>{calls.push('execute');return {state:'completed',pendingNodes:[]};},
      service:{
      preview:async()=>{calls.push('preview');return preview;},
      confirm:async(payload)=>{calls.push('confirm:'+payload.phase);},
      preflightConfirmed:async()=>{calls.push('preflight');},
      status:async()=>({state:'completed'}),
      execute:async()=>{calls.push('execute');return {state:'completed',pendingNodes:[]};},
      assertIsolatedSourcesAbsent:async()=>{calls.push('verify');},
    }}),
    workerActionTargets:()=>[],
    effectiveConnectionMode:()=>'realtime',
    captureProjectContext:()=>({root}),
    projectContextIsCurrent:(context)=>context.root===root,
    lastCodeSyncState:{fingerprint},
    localDistributedCodeFingerprint:async()=>fingerprint,
    refreshLocalPlanMetadataForAction:(body)=>{body.planRevision=revision;},
    stampPlanRevision:()=>{},
    assertPlanSubmissionWorkers:async()=>{},
    askRunConfirmation:async(payload)=>{calls.push('ask:'+payload.phase);return payload.phase===1?'rerun_all':'isolate_and_run';},
    saveDistributedQueue:async(rootArg,queueArg,options)=>{
      // 与真实 saveDistributedQueue mutateLatest 合同一致：事务内读最新、变异；抛错即整笔未写。
      const latest=JSON.parse(JSON.stringify(queue));
      const next=options.mutateLatest(latest);
      if(next!==latest){queue=next;writes.push(JSON.parse(JSON.stringify(next)));}
      calls.push('queue-write');
    },
  };
  const body={planFile,planRevision:revision,submissionOperationIdLocal:'op-chain',options:{planFile},
    runReplacement:{},reportPlanStageLocal:()=>{}};
  const validation={jobs:[{index:0,case:'case0',seed:42,output_dir:'work_dirs/a',result_csv:'work_dirs/a/m.csv'}],execution_mode:'train'};
  return {project,planFile,storage,root,writes,calls,clearedJobs:queue.clearedJobs,
    run:()=>new PlanRunHost(host,root).replace({planFile},body,validation),body};
}

test('no declaration and no cleared proof: isolation completes, hold still fails and the queue is never written',async()=>{
  const h=makeHarness(()=>[]);
  await assert.rejects(h.run(),/HOLD_TARGET_NOT_FOUND/,'真实缺失必须继续显式失败（保持既有安全语义）');
  assert.deepEqual(h.writes,[],'失败不得写入队列');
  assert.ok(h.calls.includes('execute')&&h.calls.includes('verify'),'失败前隔离确已完成——这正是用户当次产物被移走而任务未提交的实况');
});

test('incomplete or foreign cleared records never exempt the real chain',async()=>{
  for(const bad of [
    ()=>[{}],
    (project,planFile,revision,fingerprint,formal)=>[{...formal(project,planFile),projectId:'not-the-project'}],
    (project,planFile,revision,fingerprint,formal)=>[{...formal(project,planFile),resultPathPolicy:undefined}],
    (project,planFile,revision,fingerprint,formal)=>[{...formal(project,planFile),clearedAt:undefined}],
    (project,planFile,revision,fingerprint,formal)=>[{...formal(project,planFile),activeReceiptObservedAt:'2026-10-21T00:00:00Z'}],
    (project,planFile,revision,fingerprint,formal)=>[{...formal(project,planFile),planFile:'plans/other.yaml'}],
    (project,planFile,revision,fingerprint,formal)=>[{...formal(project,planFile),collectionResultCsv:'other.csv'}],
  ]){
    const h=makeHarness(bad);
    await assert.rejects(h.run(),/HOLD_TARGET_NOT_FOUND/,'未知/不完整/他项目/非正式清除记录不得豁免');
    assert.deepEqual(h.writes,[],'非正式记录失败同样不得写队列');
  }
});

test('formal same-project same-plan cleared record lets the real replacement chain reach submission state',async()=>{
  const h=makeHarness((project,planFile,revision,fingerprint,formal)=>[formal(project,planFile)]);
  await h.run();
  assert.ok(h.calls.includes('execute')&&h.calls.includes('verify'),'隔离必须先于 hold 完成');
  assert.ok(h.calls.includes('queue-write'),'hold 必须真实到达队列事务');
  // 真实合同：normalizeHoldTargets 总返回新对象（identity 变即写盘），但免围栏不得伪造声明——
  // 落盘内容必须与原队列逐字段相等（plans 仍空、clearedJobs 原样、无 retired 标记）。
  assert.equal(h.writes.length,1);
  assert.deepEqual(h.writes[0],{plans:[],clearedJobs:h.clearedJobs},'写盘内容必须与原队列逐字段相等');
  assert.equal(h.body.existingOutputChoice,'rerun_all');
  assert.deepEqual(h.body.assignedExperimentIndices,[0],'准入 job 范围保持完整，提交可继续');
  assert.deepEqual(h.body.distributedSkipJobIndices,[]);
  assert.equal(h.body.runReplacement.done,true,'真实链走到 done，不再被 HOLD 中止');
  // 恢复记录必须真实落盘（提交崩溃后可继续），供后续查询/重放使用。
  const submissionsRoot=path.join(h.storage,'run-submissions');
  const submissions=fs.readdirSync(submissionsRoot).flatMap(dir=>fs.readdirSync(path.join(submissionsRoot,dir)));
  assert.equal(submissions.length,1);
});
