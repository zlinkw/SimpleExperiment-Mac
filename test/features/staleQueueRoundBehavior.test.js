const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsPromises=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
require('../_helpers/registerTsRequire');
const Q=require('../../src/features/DistributedPlanQueue.ts');
const {atomicWriteText}=require('../../src/state/StateStore.ts');

// 返修 #4（2026-10-21）：STALE_QUEUE_ROUND 的围栏必须有行为级证据，而不是源码计数——
// 旧轮次必须在任何磁盘提交前被拒绝（派发先写队列再发送，写被拒即无孤儿派发）、最新队列零覆盖；
// 下一有效轮次必须以磁盘最新为准推进；其它错误必须照旧记录（降噪不得吞持续饥饿）。
// 本套件把 legacy 真实方法体（saveDistributedQueue / withQueueWriteResource / tickDistributedQueue /
// requestDistributedQueueRefresh / scheduleDistributedPostprocess）原样提取执行，
// 用真实 DistributedPlanQueue 序列化与真实 atomicWriteText（生产同一先 temp→beforeRename→rename 顺序）。
// 不启动 VSCode/服务器，不触任何真实项目数据；全部写盘都在 mkdtemp 沙箱内。

const legacySource=fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
const ast=ts.createSourceFile('host.ts',legacySource,ts.ScriptTarget.Latest,true);
function hostMethods(names,globals={}){let cls;function visit(n){if(ts.isClassDeclaration(n)&&n.name?.text==='RealtimeTunnelPanelProvider')cls=n;ts.forEachChild(n,visit)}visit(ast);
  const members=cls.members.filter(n=>names.includes(n.name?.getText(ast)));assert.equal(members.length,names.length,names.join(','));
  return vm.runInNewContext(ts.transpileModule('class Host{'+members.map(n=>n.getText(ast)).join('\n')+'};Host',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
    {AbortController,workspaceRoot:()=>'project',errorMessage:e=>e.message,compactSensitiveText:s=>String(s).slice(0,240),
     require:()=>({getUpdater:()=>undefined}),syncGpuQuotaPolicies:async()=>({}),
     DistributedPlanQueue:Q,fs:fsPromises,path,atomicWriteText,...globals});}

function queueFixture(){
  const storage=fs.mkdtempSync(path.join(os.tmpdir(),'se-stale-'));
  const root='project',project=Q.canonicalProjectId(root);
  const queue=Q.emptyDistributedQueue();
  const queued=Q.enqueuePlan(queue,{projectId:project,executionMode:'train',planFile:'p.yaml',revision:'r',codeFingerprint:'code',
    jobs:[{index:0,case:'a',seed:1,outputDir:'work/0'},{index:1,case:'b',seed:2,outputDir:'work/1'}]},'p');
  const Host=hostMethods(['saveDistributedQueue','withQueueWriteResource','tickDistributedQueue','requestDistributedQueueRefresh','scheduleDistributedPostprocess']);
  const h=new Host();
  const actionErrors=[],states=[];
  Object.assign(h,{context:{globalStorageUri:{fsPath:storage}},manualDispatchInFlight:new Set(),planCleanupHosts:new Map(),
    distributedQueueGeneration:0,distributedPlanStopEpoch:0,planStopClearBatchLease:undefined,
    distributedSubmissionEpochs:new Map(),distributedQueueWritePromise:Promise.resolve(),hostOperationLease:undefined,
    distributedQueueCache:null,distributedQueueRoot:'',distributedQueueDiskSignature:'',distributedQueueStorageDiagnostics:{status:'ready'},
    distributedQueueMetadataWrites:[],detachStaleDistributedTick(){},distributedTickAbort:undefined,distributedQueueTickPromise:undefined,
    taskLifecycleProtocol:2,panelDisposed:false,isRealtimeMode:()=>true,projectTopologyAssessment:()=>({mode:'worker_pool'}),
    codeSyncInFlight:0,planSyncInFlight:0,syncScopeMutationInFlight:0,manualResultSyncCounts:new Map(),
    captureProjectContext:()=>({root}),projectContextIsCurrent:()=>true,queuePlanArtifactSyncStatusCheck(){},postState(){states.push(1);},
    recordActionError(row){actionErrors.push(row);},completedPlanMirrorDiagnostics:{status:'ready'},
    distributedPostprocessPromise:undefined,distributedPostprocessScope:undefined});
  const file=Q.distributedQueuePath(storage,root);
  return {h,root,project,queued:structuredClone(queued),actionErrors,states,file,
    async seed(q){await fsPromises.mkdir(path.dirname(file),{recursive:true});await fsPromises.writeFile(file,Q.serializeDistributedQueue(q));}};
}

test('旧轮次写入在磁盘提交前被拒：文件字节零变化、无临时残留、其它写者最新内容不被覆盖',async()=>{
  const f=queueFixture();
  await f.seed(f.queued);
  const before=await fsPromises.readFile(f.file,'utf8');
  hBump(f);
  const stale=await f.h.saveDistributedQueue(f.root,undefined,{queueGeneration:0,controlMutation:true,mutateLatest:latest=>({
    ...latest,plans:latest.plans.map(plan=>({...plan,jobs:plan.jobs.map(job=>({...job,status:'failed',error:'旧轮次误写'}))}))})}).then(()=>null,error=>error);
  assert.equal(stale?.code,'STALE_QUEUE_ROUND','旧 generation 必须带码被拒');
  const after=await fsPromises.readFile(f.file,'utf8');
  assert.equal(after,before,'旧轮次绝不可覆盖磁盘上的最新队列');
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)).filter(name=>name.endsWith('.tmp')),[],'不得留下临时文件');
});
function hBump(f){f.h.distributedQueueGeneration=1;} // 新一轮已在别处赢得 generation：旧轮次的 options.queueGeneration 立刻过期

test('检查-变更不原子：预检通过、rename 前 generation 变化同样必须拒绝且零写入（真实 atomicWriteText 顺序）',async()=>{
  const storage=fs.mkdtempSync(path.join(os.tmpdir(),'se-stale-race-'));
  const root='project',project=Q.canonicalProjectId(root);
  const queued=Q.enqueuePlan(Q.emptyDistributedQueue(),{projectId:project,executionMode:'train',planFile:'p.yaml',revision:'r',codeFingerprint:'code',
    jobs:[{index:0,case:'a',seed:1,outputDir:'work/0'}]},'p');
  const races=[];
  const Host=hostMethods(['saveDistributedQueue','withQueueWriteResource'],{atomicWriteText:(file,text,options)=>{
    races.push('pre-rename');if(options?.beforeRename)options.beforeRename=wrapBefore(options.beforeRename);return atomicWriteText(file,text,options);}});
  function wrapBefore(inner){return async()=>{races.push('generation-moved');h.distributedQueueGeneration=1;await inner();};}
  const h=new Host();
  Object.assign(h,{context:{globalStorageUri:{fsPath:storage}},manualDispatchInFlight:new Set(),planCleanupHosts:new Map(),
    distributedQueueGeneration:0,distributedPlanStopEpoch:0,planStopClearBatchLease:undefined,distributedSubmissionEpochs:new Map(),
    distributedQueueWritePromise:Promise.resolve(),hostOperationLease:undefined,distributedQueueCache:null,distributedQueueRoot:'',
    distributedQueueDiskSignature:'',distributedQueueStorageDiagnostics:{status:'ready'},distributedQueueMetadataWrites:[],
    detachStaleDistributedTick(){},postState(){}});
  const file=Q.distributedQueuePath(storage,root);
  await fsPromises.mkdir(path.dirname(file),{recursive:true});
  await fsPromises.writeFile(file,Q.serializeDistributedQueue(queued));
  const before=await fsPromises.readFile(file,'utf8');
  const stale=await h.saveDistributedQueue(root,undefined,{queueGeneration:0,controlMutation:true,mutateLatest:latest=>({...latest,marker:'stale-write'})}).then(()=>null,error=>error);
  assert.equal(stale?.code,'STALE_QUEUE_ROUND');
  assert.deepEqual(races,['pre-rename','generation-moved'],'拒绝必须发生在 rename 之前的再检查');
  assert.equal(await fsPromises.readFile(file,'utf8'),before,'rename 前被拒也必须零覆盖');
});

test('有效轮次正常推进磁盘最新；随后旧轮次仍被拒（围栏不因一次成功而放松）',async()=>{
  const f=queueFixture();
  await f.seed(f.queued);
  const latest=(await Q.restoreFormalJobQueue(JSON.parse(await fsPromises.readFile(f.file,'utf8'))));
  await f.h.saveDistributedQueue(f.root,undefined,{queueGeneration:0,controlMutation:true,mutateLatest:queue=>({
    ...queue,plans:queue.plans.map(plan=>({...plan,jobs:plan.jobs.map(job=>job.index===0?{...job,status:'running',workerId:'w',commandId:'c0'}:job)}))})});
  const committed=JSON.parse(await fsPromises.readFile(f.file,'utf8'));
  assert.equal(committed.plans[0].jobs[0].commandId,'c0','有效轮次必须以磁盘最新为基推进并落盘');
  assert.equal(committed.plans[0].jobs[0].workerId,'w');
  assert.notEqual(committed.plans[0].jobs[0].status,'pending','状态推进已提交（无观测的 running 被生产规范化为待核实，不是丢写）');
  assert.equal(committed.plans[0].jobs[1].status,'pending','无关 job 保留');
  void latest;
  hBump(f);
  const stale=await f.h.saveDistributedQueue(f.root,undefined,{queueGeneration:0,controlMutation:true,mutateLatest:queue=>({...queue,marker:'late'})}).then(()=>null,error=>error);
  assert.equal(stale?.code,'STALE_QUEUE_ROUND');
  assert.equal(JSON.parse(await fsPromises.readFile(f.file,'utf8')).marker,undefined);
});

test('自动 tick 包装：STALE 轮次静默、其它错误照旧上报（降噪不得吞持续饥饿）',async()=>{
  const f=queueFixture();const h=f.h;
  for(const [code,expected] of [[{code:'STALE_QUEUE_ROUND'},0],[null,1]]){
    h.tickDistributedQueueCore=async()=>{const error=code?Object.assign(Error('过期调度轮次，已拒绝写入队列'),code):Error('Worker 离线');
      throw error;};
    h.requestDistributedQueueRefresh();
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  }
  assert.equal(f.actionErrors.length,1,'恰一条：STALE 静默，真实错误必须记录');
  assert.match(f.actionErrors[0].message,/Worker 离线/);
});
test('过期轮次不会造成孤儿派发：真实 tickDistributedQueueCore 的写队列被 STALE 拒绝后，send 恰为零',async()=>{
  // 真实核心链（同 dispatchWake 生产形状夹具）：空闲 GPU + pending job 本应触发一次派发；
  // 写队列（把 commandId 落到队列）被 STALE 拒绝后，sendDistributedJob 必须一次都不发生。
  const Host2=hostMethods(['tickDistributedQueueCore'],{setInterval,clearInterval,DistributedPlanQueue:Q,
    DistributedSchedulingPolicy:require('../../src/features/DistributedSchedulingPolicy.ts'),GpuQuotaScheduling:require('../../src/features/GpuQuotaScheduling.ts'),
    GpuJobOwnership:require('../../src/features/GpuJobOwnership.ts'),PlanCodeScopeHost:{supportsPlanCodeScope:()=>false,inspectPlanCodeSlots:async()=>{}}});
  const h2=new Host2();const project=Q.canonicalProjectId('project');
  let stored=Q.enqueuePlan(Q.emptyDistributedQueue(),{projectId:project,executionMode:'train',planFile:'p.yaml',revision:'r',codeFingerprint:'code',
    jobs:[{index:0,case:'a',seed:1,outputDir:'work/0'}]},'p');
  Object.assign(stored.plans[0].jobs[0],{lifecycleProtocol:2,status:'pending'});
  const sends=[],saveAttempts=[];
  Object.assign(h2,{taskLifecycleProtocol:2,distributedQueueGeneration:0,distributedPlanStopEpoch:0,distributedNextFailureDetailAt:Infinity,distributedNextPostprocessAt:Infinity,
    distributedLaunchInFlight:new Set(),isRealtimeMode:()=>true,workerCodeSyncTargets:()=>[],workerActionTargets:()=>[{id:'w',project_dir:'/project'}],
    lastWorkerProbes:{w:{status:'ok',capabilities:{endpoints:{declaredJobPaths:true,formalJobIdentityEnv:1,taskShellEnvironment:1}}}},
    lastCodeSyncState:{workerVersions:{w:{fingerprint:'code'}}},enabledWorkerConfigs:()=>[{id:'w',gpuQuotaConfigured:true,gpuJobsPerCard:1,gpuCardOverrides:{}}],
    schedulerSettings:()=>({}),recordActionError(){},postState(){},queuePlanArtifactSyncStatusCheck(){},scheduleDistributedPostprocess(){},
    buildDistributedJobCodeManifest:async()=>({}),loadDistributedQueue:async()=>structuredClone(stored),
    saveDistributedQueue:async(_root,_q,options)=>{saveAttempts.push(options?.controlMutation?'control-mutation':'other');
      const next=options.mutateLatest(structuredClone(stored));
      if(next!==stored){const stale=Object.assign(Error('过期调度轮次，已拒绝写入队列'),{code:'STALE_QUEUE_ROUND'});throw stale;}return stored;},
    readWorkerTaskSnapshotBatch:async()=>[{workerId:'w',queryComplete:true,executionOnly:true,capabilities:{schemaVersion:1,durablePlanQueue:true,taskLifecycle:2,idleGpuAdmission:true},tasks:[]}],
    client:{getGpu:async()=>({w:[{index:0,memoryTotalMb:100*1024,memoryUsedMb:0}]})},// 空闲卡：正常轮次本应派发这个 pending job
    sendDistributedJob:async()=>{sends.push('sent');return {lifecycleProtocol:2};}});
  const tickError=await h2.tickDistributedQueueCore(0,new AbortController().signal).catch(error=>error);
  assert.ok(saveAttempts.length>=1,'派发链确实走到了写队列（否则本用例是空证）；tickError='+(tickError&&tickError.message));
  assert.deepEqual(sends,[],'写队列被 STALE 拒绝后不得有任何派发发送（零孤儿派发）');
});

test('completedPlanWorkerMirror：自动镜像失败进独立诊断并保留连续失败计数，不再刷动作错误；成功即复位',async()=>{
  const f=queueFixture();const h=f.h;let mode='fail';
  h.syncCompletedPlanArtifacts=async()=>{if(mode==='fail')throw Error('镜像停止：远端传输忙');};
  const settle=async()=>{for(let i=0;i<50&&h.distributedPostprocessPromise;i+=1)await new Promise(resolve=>setTimeout(resolve,2));await h.distributedPostprocessPromise;};
  h.scheduleDistributedPostprocess('project');await settle();
  assert.equal(f.actionErrors.length,0,'自动镜像失败不得进动作错误');
  assert.equal(h.completedPlanMirrorDiagnostics.status,'failed');
  assert.equal(h.completedPlanMirrorDiagnostics.reason,'镜像停止：远端传输忙','原因必须原样保留');
  assert.equal(h.completedPlanMirrorDiagnostics.consecutiveFailures,1);
  h.scheduleDistributedPostprocess('project');await settle();
  assert.equal(h.completedPlanMirrorDiagnostics.consecutiveFailures,2,'持续饥饿计数必须累积可见，不得静默清零');
  mode='ok';h.scheduleDistributedPostprocess('project');await settle();
  assert.equal(h.completedPlanMirrorDiagnostics.status,'ready','成功复位只允许来自真实成功');
  assert.equal(f.actionErrors.length,0);
});
test('镜像在途时新请求记重扫，完成后恰重扫一次（原语义保留）',async()=>{
  const f=queueFixture();const h=f.h;let runs=0,release,running=new Promise(resolve=>{release=resolve;});
  h.syncCompletedPlanArtifacts=async()=>{runs++;await running;};
  h.scheduleDistributedPostprocess('project');
  await new Promise(resolve=>setImmediate(resolve));
  h.scheduleDistributedPostprocess('project',true);
  h.scheduleDistributedPostprocess('project',false);
  release();await settleAll(h);
  assert.equal(runs,2,'在途期间仅排队一次重扫，完成后恰执行一次');
  async function settleAll(host){for(let i=0;i<50&&host.distributedPostprocessPromise;i+=1)await new Promise(resolve=>setTimeout(resolve,2));await host.distributedPostprocessPromise;}
});
test('诊断负载必须暴露镜像独立状态（面板得以独立展示而非依赖动作错误流）',()=>{
  assert.match(legacySource,/diagnostics\.completedPlanMirror = this\.completedPlanMirrorDiagnostics/);
  assert.ok(!/recordActionError\(\{ command: "completedPlanWorkerMirror"/.test(legacySource),'自动镜像失败不得再走动作错误');
});
