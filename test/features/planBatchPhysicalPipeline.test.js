const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsPromises=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),ts=require('typescript');
require('../_helpers/registerTsRequire');
const Q=require('../../src/features/DistributedPlanQueue.ts');
const {atomicWriteText}=require('../../src/state/StateStore.ts');
const {runSelectedPlans}=require('../../src/extension/SelectedPlanBatchHost.ts');
const {PlanSubmissionBatch,planSubmissionBatchFor}=require('../../src/features/PlanSubmissionBatch.ts');
const {PlanRunHost}=require('../../src/extension/PlanRunHost.ts');
const {PlanCleanup,cleanupDigest}=require('../../dist/features/PlanCleanup.js');

// 返修 #5（2026-10-21）：批次派发必须以真实入口驱动，被测源码的形态布尔不得自证。
// 链路全部真实：runSelectedPlans → 真实 PlanSubmissionBatch（真实 lanes/once/verify）→
// 真实 PlanRunHost.replace → 真实 PlanCleanup 服务（dist 产物）→ 可信物理隔离适配器：
// SimpleSFTP 后端由沙箱内真实文件系统实现——预览看真实 stat、执行做真实 rename 进 clean_dir、
// 删除做真实 unlink；隔离能力旗标与生产契约同形。队列写入用 legacy 真实 saveDistributedQueue
// （提取执行，真实 distributedQueueWritePromise 串链 + 真实 atomicWriteText），证明 outputs 道收窄后
// 冲突写入互斥仍成立（并发控制事务零丢更新）。不连任何真实主机，绝不删真实数据。

const legacySource=fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
const ast=ts.createSourceFile('host.ts',legacySource,ts.ScriptTarget.Latest,true);
function legacyMethods(names,globals={}){let cls;function visit(n){if(ts.isClassDeclaration(n)&&n.name?.text==='RealtimeTunnelPanelProvider')cls=n;ts.forEachChild(n,visit)}visit(ast);
  const members=cls.members.filter(n=>names.includes(n.name?.getText(ast)));assert.equal(members.length,names.length,names.join(','));
  return vm.runInNewContext(ts.transpileModule('class Host{'+members.map(n=>n.getText(ast)).join('\n')+'};Host',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
    {AbortController,DispatchHandoffGate:require("../../dist/features/DispatchHandoffGate.js"),errorMessage:e=>e.message,compactSensitiveText:s=>String(s).slice(0,240),require:()=>({getUpdater:()=>undefined}),syncGpuQuotaPolicies:async()=>({}),
     DistributedPlanQueue:Q,fs:fsPromises,path,atomicWriteText,...globals});}

const PLAN_A={planFile:'plans/a.yaml',dir:'work_dirs/a0',csv:'work_dirs/a0/m.csv',case:'ca',seed:1};
const PLAN_B={planFile:'plans/b.yaml',dir:'work_dirs/b0',csv:'work_dirs/b0/m.csv',case:'cb',seed:2};

async function world(){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'se-batch-real-'));
  const storage=path.join(root,'storage');const serverRoot=path.join(root,'server');
  const plans=[PLAN_A,PLAN_B];const revisions={};
  for(const plan of plans){
    fs.mkdirSync(path.join(root,path.dirname(plan.planFile)),{recursive:true});
    const text='name: '+plan.planFile+'\n';fs.writeFileSync(path.join(root,plan.planFile),text);
    revisions[plan.planFile]=crypto.createHash('sha256').update(text).digest('hex');
    fs.mkdirSync(path.join(serverRoot,plan.dir),{recursive:true});
    fs.writeFileSync(path.join(serverRoot,plan.dir,'out.txt'),'payload-'+plan.case);
    fs.writeFileSync(path.join(serverRoot,plan.dir,'m.csv'),'a,b\n1,2\n');
  }
  const node={id:'w1',kind:'remote',root:serverRoot,host:'h1.example',port:22,user:'u'};
  const records=new Map();const stats={moves:0,deletes:0,preflights:0};
  let isolatedDeletePreviewCalls=0;
  const sftp=async(method,params)=>{
    if(method==='files.cleanup.isolationParentsPreview')return{ok:true,eligible:false,targets:[]}; // This legacy fixture has no empty-parent capability.
    const abs=relative=>path.join(serverRoot,relative);
    if(method==='files.cleanup.preview'){
      const targets=[];
      for(const row of params.targets){
        if(!(await fsPromises.stat(abs(row.relativePath)).catch(()=>null)))throw Object.assign(Error('MISSING_TARGET'),{code:'ENOENT'});
        const content=await fsPromises.readFile(abs(row.relativePath)).catch(()=>null);
        targets.push(Object.assign({},row,{absolutePath:node.root+'/'+row.relativePath,
          fingerprint:'fp-'+crypto.createHash('sha256').update(content||row.relativePath).digest('hex').slice(0,16),
          contentFingerprint:'cf-'+row.relativePath,device:'dev-1',inode:'ino-'+row.relativePath.length,size:10,inventory:[]}));
      }
      const token=cleanupDigest([params.node.id,params.targets.map(row=>row.relativePath),records.size]).slice(0,48);
      const record={token,digest:cleanupDigest(targets),rootIdentity:{path:node.root},targets,confirmations:0,node:params.node,action:params.action,
        safety:{batchPreviewCapacity:4096,isolateFast:1,requiredInputGuard:1,registeredIsolationDeletion:1,subtreeSingleWriter:1}};
      records.set(token,record);return JSON.parse(JSON.stringify(record));
    }
    if(method==='files.cleanup.inspect'){
      const stat=await fsPromises.stat(abs(params.target.relativePath)).catch(()=>null);
      return {target:{type:params.target.type,absolutePath:node.root+'/'+params.target.relativePath,missing:!stat,size:10,
        fingerprint:'fp-'+params.target.relativePath}};}
    const row=records.get(params.token);assert.ok(row,'preview 必须先于任何后端动作');
    if(method==='files.cleanup.status')return JSON.parse(JSON.stringify(row));
    if(method==='files.cleanup.confirm'){row.confirmations=params.phase;return {ok:true};}
    if(method==='files.cleanup.preflight'){stats.preflights+=1;return {ok:true};}
    if(method==='files.cleanup.verify')return {ok:true};
    if(method==='files.cleanup.settle'){const target=row.targets[params.index];
      const exists=await fsPromises.stat(abs(target.relativePath)).catch(()=>null);
      return {ok:true,state:exists?'pending':'completed',receipt:{contentFingerprint:target.contentFingerprint}};}
    if(method==='files.cleanup.execute'){
      assert.ok(row.confirmations,'执行前必须已有确认相位');
      const target=row.targets[params.index];
      if(row.action==='isolate'){const dest=abs(target.destination);await fsPromises.mkdir(path.dirname(dest),{recursive:true});
        await fsPromises.rename(abs(target.relativePath),dest);stats.moves+=1;
        return {ok:true,receipt:{source:target.relativePath,destination:target.destination,contentFingerprint:target.contentFingerprint}};}
      if(await fsPromises.stat(abs(target.relativePath)).catch(()=>null)) require("../_helpers/retainFixtureTarget.cjs")(serverRoot,abs(target.relativePath),target.type); stats.deletes+=1;
      return {ok:true,receipt:{source:target.relativePath,contentFingerprint:target.contentFingerprint}};}
    throw Error('ADAPTER_REFUSES_'+method);};
  const scopes=new Map(plans.map(plan=>[plan.planFile,{projectId:Q.canonicalProjectId(root),planKey:'owner',planFile:plan.planFile,planHash:'h-'+plan.case,
    runIds:['run-'+plan.case],revision:'frozen',nodes:[node],blockers:[],
    candidates:[{nodeId:'w1',relativePath:plan.dir,type:'directory',category:'专用产物',owners:['owner'],
      evidence:['exact job / attempt / command registration'],dependencies:[]}]}]));
  const service=new PlanCleanup({storageRoot:storage,collect:async(planFile,opts)=>{
    const scope=JSON.parse(JSON.stringify(scopes.get(String(planFile))||scopes.get(PLAN_A.planFile)));
    const job=opts&&opts.job;scope.job=job?{workflowId:job.workflowId,index:job.index,commandId:job.commandId,purpose:job.purpose}:undefined;
    if(job&&job.manifest){const wanted=new Set(job.manifest.declarations.flatMap(d=>[d.output_dir,d.result_csv].filter(Boolean)));
      scope.candidates=scope.candidates.filter(candidate=>wanted.has(candidate.relativePath));}
    return scope;},sftp,updateIndexes:async()=>{},restoreGate:async()=>{}});
  const originalIsolatedDeletePreview=service.isolatedDeletePreview.bind(service);
  service.isolatedDeletePreview=async(...args)=>{isolatedDeletePreviewCalls+=1;return originalIsolatedDeletePreview(...args);};

  const Host=legacyMethods(['saveDistributedQueue','withQueueWriteResource']);
  const h=new Host();
  const projectRoot=root,queueFile=Q.distributedQueuePath(storage,projectRoot);
  Object.assign(h,{context:{globalStorageUri:{fsPath:storage}},workspaceRootValue:projectRoot,
    distributedQueueGeneration:0,distributedPlanStopEpoch:0,planStopClearBatchLease:undefined,distributedSubmissionEpochs:new Map(),
    distributedQueueWritePromise:Promise.resolve(),hostOperationLease:undefined,distributedQueueCache:null,distributedQueueRoot:'',
    distributedQueueDiskSignature:'',distributedQueueStorageDiagnostics:{status:'ready'},distributedQueueMetadataWrites:[],
    detachStaleDistributedTick(){},postState(){},recordActionError(row){throw Error('队列写入失败：'+row.message);}});
  const dialogs={active:0,maxActive:0,prompts:[]};
  let preparationChecks=0;
  Object.assign(h,{
    localPlanMetadata:{plans:plans.map(plan=>({planFile:plan.planFile,revision:revisions[plan.planFile]}))},
    captureProjectContext:()=>({root:projectRoot}),projectContextIsCurrent:()=>true,
    refreshLocalPlanMetadataForAction:(current)=>{if(current&&current.planFile)current.planRevision=revisions[current.planFile]||current.planRevision;},
    stampPlanRevision:()=>{},distributedPlanEligible:()=>true,
    localDistributedCodeFingerprint:async()=> 'fp-batch',lastCodeSyncState:{fingerprint:'fp-batch',workerVersions:{w1:{fingerprint:'fp-batch'}}},
    enabledWorkerConfigs:()=>[{id:'w1'}],ensureCodeReadyForRun:async()=>{},
    workerActionTargets:()=>[{id:'w1',kind:'remote',host:'h1.example',port:22,user:'u',project_dir:serverRoot}],
    effectiveConnectionMode:()=>'realtime',
    planCleanupHost:()=>({service,execute:async id=>service.execute(id)}),
    askRunConfirmation:async payload=>{dialogs.active+=1;dialogs.maxActive=Math.max(dialogs.maxActive,dialogs.active);
      dialogs.prompts.push(payload.planFile+':'+payload.phase);
      try{await new Promise(resolve=>setTimeout(resolve,20));return payload.phase===1?'rerun_all':'isolate_and_run';}finally{dialogs.active-=1;}},
    assertPlanSubmissionWorkers:async()=>{preparationChecks+=1;},
    planSubmissionOperationId:message=>'plan-submit-'+message.clientActionId,
    localOperations:{},tickDistributedQueue:async()=>{},
    async runActionCommand(command,message){
      assert.equal(command,'runPlan');
      const batch=planSubmissionBatchFor(message);assert.ok(batch instanceof PlanSubmissionBatch,'批绑定必须来自真实 runSelectedPlans');
      const plan=plans.find(row=>row.planFile===message.planFile);
      const body={planFile:plan.planFile,planRevision:revisions[plan.planFile],options:{planFile:plan.planFile},runReplacement:{},
        submissionOperationIdLocal:'op-'+plan.planFile,reportPlanStageLocal:()=>{},
        confirmGateLocal:work=>batch.serial('outputs',work)};
      await batch.prepareCode(body);
      await new PlanRunHost(h,projectRoot).replace({planFile:plan.planFile},body,
        {execution_mode:'train',jobs:[{index:0,case:plan.case,seed:plan.seed,output_dir:plan.dir,result_csv:plan.csv}]});
      assert.deepEqual(body.assignedExperimentIndices,[0]);
      const saved=h.saveDistributedQueue.bind(h);
      await saved(projectRoot,undefined,{controlMutation:true,mutateLatest:queue=>Q.enqueuePlan(queue,{
        projectId:Q.canonicalProjectId(projectRoot),planFile:plan.planFile,revision:body.planRevision,codeFingerprint:'fp-batch',
        executionMode:'train',jobs:[{index:0,case:plan.case,seed:plan.seed,outputDir:plan.dir,collectionResultCsv:plan.csv}]},'run-'+plan.planFile)});
      h.localOperations[h.planSubmissionOperationId(message)]={status:'queued',message:'已入队'};
    }});
  await fsPromises.mkdir(path.dirname(queueFile),{recursive:true});
  await fsPromises.writeFile(queueFile,Q.serializeDistributedQueue(
    Q.restoreFormalJobQueue(plans.reduce((queue,plan)=>({...queue,plans:[...queue.plans,{id:'seed-'+plan.case,projectId:Q.canonicalProjectId(projectRoot),planFile:plan.planFile,
      revision:'frozen',codeFingerprint:'fp-batch',jobs:[{index:0,status:'completed',lifecycleProtocol:2,commandId:'old-'+plan.case,
        outputDir:plan.dir,collectionResultCsv:plan.csv}]}]}),Q.emptyDistributedQueue()))));
  return {h,root,projectRoot,storage,serverRoot,revisions,queueFile,stats,dialogs,
    planCount:()=>JSON.parse(fs.readFileSync(queueFile,'utf8')).plans.length,
    queueDisk:()=>Q.restoreFormalJobQueue(JSON.parse(fs.readFileSync(queueFile,'utf8'))),
    isolatedDeletes:()=>isolatedDeletePreviewCalls,
    exists:(...parts)=>fs.existsSync(path.join(serverRoot,...parts)),
    cleanupCalls:stats};
}

test('真实批次链：两个 PLAN 并发走完 runSelectedPlans→PlanSubmissionBatch→PlanRunHost.replace→真实 PlanCleanup→物理 rename 进 clean_dir；队列并发写零丢更新；批次内零隔离区删除',async()=>{
  const w=await world();
  const report=await runSelectedPlans(w.h,{planFiles:[PLAN_A.planFile,PLAN_B.planFile]});
  if(report.status!=='completed')console.log('DIAG_ROWS',JSON.stringify(report.rows));
  assert.equal(report.status,'completed');
  // 物理隔离事实：源目录必须真实不存在，产物必须真实落在 clean_dir 下（不是记账桩）
  for(const plan of [PLAN_A,PLAN_B]){
    assert.equal(w.exists(plan.dir),false,plan.dir+' 源路径必须已被真实 rename 释放');
    const clean=path.join(w.serverRoot,'clean_dir');
    const walk=entries=>entries.flatMap(entry=>fs.readdirSync(entry,{withFileTypes:true}).flatMap(dirent=>{
      const full=path.join(entry,dirent.name);return dirent.isDirectory()?walk([full]):[full];}));
    const moved=walk([clean]).filter(file=>path.relative(clean,file).split(path.sep).join('/').endsWith('/'+plan.dir+'/out.txt'));
    assert.equal(moved.length,1,'每个 PLAN 的产物应唯一落进 clean_dir 且只落一次');
    assert.match(fs.readFileSync(moved[0],'utf8'),/payload-/);
  }
  assert.equal(w.stats.moves,2,'物理 rename 恰两次（每 PLAN 一次）');
  assert.equal(w.stats.deletes,0,'批次内绝不发生物理删除');
  assert.equal(w.isolatedDeletes(),0,'批次内绝不启动隔离区永久删除预览');
  // 队列互斥：种子 2 卡 + 新入队 2 卡全部在盘——两个并发控制事务零丢更新
  const disk=w.queueDisk();
  assert.equal(disk.plans.length,4,'两写者的计划都必须存在（真实 distributedQueueWritePromise 互斥）');
  const enqueued=disk.plans.filter(plan=>plan.id.startsWith('run-'));
  assert.equal(enqueued.length,2);
  const retired=disk.plans.filter(plan=>plan.id.startsWith('seed-'));
  assert.equal(retired.length,2);
  assert.ok(retired.every(plan=>plan.jobs[0].outputRetiredAt),'hold 退役标记必须真实写入队列磁盘');
  assert.ok(enqueued.every(plan=>plan.jobs[0].status==='pending'&&plan.jobs[0].commandId===undefined));
  // 对话语义：两个 PLAN 各一次确认页且全局并发 ≤1（真实批次 outputs 道）
  assert.deepEqual(w.dialogs.prompts.sort(),['plans/a.yaml:1','plans/a.yaml:2','plans/b.yaml:1','plans/b.yaml:2'],'两 PLAN 各经范围与精确路径两段确认');
  assert.equal(w.dialogs.maxActive,1);
});
test('同一 PLAN 目标被并发修改时真实写链拒绝而非静默覆盖：过期轮次写被拒且磁盘零变化',async()=>{
  const w=await world();
  const before=await fsPromises.readFile(w.queueFile,'utf8');
  w.h.distributedQueueGeneration=1;
  const stale=await w.h.saveDistributedQueue(w.projectRoot,undefined,{queueGeneration:0,controlMutation:true,
    mutateLatest:queue=>({...queue,plans:[]})}).then(()=>null,error=>error);
  assert.equal(stale?.code,'STALE_QUEUE_ROUND');
  assert.equal(await fsPromises.readFile(w.queueFile,'utf8'),before);
});
