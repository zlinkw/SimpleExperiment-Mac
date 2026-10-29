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
    {AbortController,DispatchHandoffGate:require("../../dist/features/DispatchHandoffGate.js"),workspaceRoot:()=>'project',errorMessage:e=>e.message,compactSensitiveText:s=>String(s).slice(0,240),
     require:()=>({getUpdater:()=>undefined}),syncGpuQuotaPolicies:async()=>({}),
     UiCommandCancelled:require('../../src/core/UiCommandCancelled.ts').UiCommandCancelled, // r50：忠实绑定生产取消类，schedule 失败回调 instanceof 用，不造假类型
     DistributedPlanQueue:Q,fs:fsPromises,path,atomicWriteText,...globals});}

function queueFixture(hostGlobals={},hostNames=['saveDistributedQueue','withQueueWriteResource','tickDistributedQueue','requestDistributedQueueRefresh','scheduleDistributedPostprocess']){
  const storage=fs.mkdtempSync(path.join(os.tmpdir(),'se-stale-'));
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'se-stale-root-'))),project=Q.canonicalProjectId(root); // r17：项目根恒为已解析绝对路径（真实队列文件在项目内受管子树）
  const queue=Q.emptyDistributedQueue();
  const queued=Q.enqueuePlan(queue,{projectId:project,executionMode:'train',planFile:'p.yaml',revision:'r',codeFingerprint:'code',
    jobs:[{index:0,case:'a',seed:1,outputDir:'work/0'},{index:1,case:'b',seed:2,outputDir:'work/1'}]},'p');
  const Host=hostMethods(hostNames,{workspaceRoot:()=>root,...hostGlobals});
  const h=new Host();
  const actionErrors=[],states=[],notes=[];
  Object.assign(h,{context:{globalStorageUri:{fsPath:storage}},manualDispatchInFlight:new Set(),planCleanupHosts:new Map(),
    distributedQueueGeneration:0,distributedPlanStopEpoch:0,planStopClearBatchLease:undefined,
    distributedSubmissionEpochs:new Map(),distributedQueueWritePromise:Promise.resolve(),hostOperationLease:undefined,
    distributedQueueCache:null,distributedQueueRoot:'',distributedQueueDiskSignature:'',distributedQueueStorageDiagnostics:{status:'ready'},
    distributedQueueMetadataWrites:[],detachStaleDistributedTick(){},distributedTickAbort:undefined,distributedQueueTickPromise:undefined,
    taskLifecycleProtocol:2,panelDisposed:false,isRealtimeMode:()=>true,projectTopologyAssessment:()=>({mode:'worker_pool'}),
    codeSyncInFlight:0,planSyncInFlight:0,syncScopeMutationInFlight:0,manualResultSyncCounts:new Map(),
    captureProjectContext:()=>({root}),projectContextIsCurrent:()=>true,queuePlanArtifactSyncStatusCheck(){},postState(){states.push(1);},
    recordActionError(row){actionErrors.push(row);},completedPlanMirrorDiagnostics:{status:'ready'},
    showNativePanelMessage:m=>notes.push(structuredClone(m)), // r50：真实失败通知必须可观察，不空 no-op 绕过
    distributedPostprocessPromise:undefined,distributedPostprocessScope:undefined});
  const file=Q.distributedQueuePath(storage,root);
  return {h,root,project,queued:structuredClone(queued),actionErrors,states,notes,file,
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
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'se-stale-root-'))),project=Q.canonicalProjectId(root); // r17：项目根恒为已解析绝对路径（真实队列文件在项目内受管子树）
  const queued=Q.enqueuePlan(Q.emptyDistributedQueue(),{projectId:project,executionMode:'train',planFile:'p.yaml',revision:'r',codeFingerprint:'code',
    jobs:[{index:0,case:'a',seed:1,outputDir:'work/0'}]},'p');
  const races=[];
  const Host=hostMethods(['saveDistributedQueue','withQueueWriteResource'],{workspaceRoot:()=>root,atomicWriteText:(file,text,options)=>{
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
  h.scheduleDistributedPostprocess(f.root);await settle();
  assert.equal(f.actionErrors.length,0,'自动镜像失败不得进动作错误');
  assert.equal(h.completedPlanMirrorDiagnostics.status,'failed');
  assert.equal(h.completedPlanMirrorDiagnostics.reason,'镜像停止：远端传输忙','原因必须原样保留');
  assert.equal(h.completedPlanMirrorDiagnostics.consecutiveFailures,1);
  assert.equal(f.notes.length,1,'真实自动失败第一次经原生通知恰一次');
  assert.equal(f.notes[0].tone,'error');
  assert.match(f.notes[0].message,/自动产物同步未完成：镜像停止：远端传输忙/,'完整真实原因进通知');
  assert.match(f.notes[0].message,/运行完成状态不变，可在对应 Job 行重新同步/);
  h.scheduleDistributedPostprocess(f.root);await settle();
  assert.equal(h.completedPlanMirrorDiagnostics.consecutiveFailures,2,'持续饥饿计数必须累积可见，不得静默清零');
  assert.equal(f.notes.length,1,'相同原因的持续失败不刷屏');
  mode='ok';h.scheduleDistributedPostprocess(f.root);await settle();
  assert.equal(h.completedPlanMirrorDiagnostics.status,'ready','成功复位只允许来自真实成功');
  assert.equal(f.notes.length,1,'成功本身不产生通知');
  mode='fail';h.scheduleDistributedPostprocess(f.root);await settle();
  assert.equal(f.notes.length,2,'成功复位后同原因真实失败再次通知（去重随诊断复位失效）');
  assert.equal(f.actionErrors.length,0);
});
test('镜像在途时新请求记重扫，完成后恰重扫一次（原语义保留）',async()=>{
  const f=queueFixture();const h=f.h;let runs=0,release,running=new Promise(resolve=>{release=resolve;});
  h.syncCompletedPlanArtifacts=async()=>{runs++;await running;};
  h.scheduleDistributedPostprocess(f.root);
  await new Promise(resolve=>setImmediate(resolve));
  h.scheduleDistributedPostprocess(f.root,true);
  h.scheduleDistributedPostprocess(f.root,false);
  release();await settleAll(h);
  assert.equal(runs,2,'在途期间仅排队一次重扫，完成后恰执行一次');
  async function settleAll(host){for(let i=0;i<50&&host.distributedPostprocessPromise;i+=1)await new Promise(resolve=>setTimeout(resolve,2));await host.distributedPostprocessPromise;}
});
test('诊断负载必须暴露镜像独立状态（面板得以独立展示而非依赖动作错误流）',()=>{
  assert.match(legacySource,/diagnostics\.completedPlanMirror = this\.completedPlanMirrorDiagnostics/);
  assert.ok(!/recordActionError\(\{ command: "completedPlanWorkerMirror"/.test(legacySource),'自动镜像失败不得再走动作错误');
});

// r46 A 集成红灯（父令：A 验收不能止于复刻 commit）：真实 saveDistributedQueue/loadDistributedQueue/
// patchDistributedJob/mergeLatestWorkerVersions 生产方法体 + 真实 atomicWriteText 落盘 + 真实文件 SHA 复制。
// 断言：真实清退保存成功尾及时取消排队等待；被围栏拒绝的真实保存不发成功通知；清退=队列记录不删产物文件；
// 无关真实复制与完成证明落盘、围栏与既有正常行为照旧。测试不手调任何 observer，不做 AST 函数名断言。
// 当前 save 成功尾未通知等待者且 Host.run 无伴跑退出 ⇒ 本用例现为红（results.length 0!==2）。
test('真实清退保存成功尾必须及时结束排队等待；围栏拒绝的保存不叫醒；无关真实复制与完成证明照常落盘',async()=>{
  if(!process.env.LOCALAPPDATA)process.env.LOCALAPPDATA=fs.mkdtempSync(fs.realpathSync(os.tmpdir())+path.sep+'se-clearwake-host-'); // r17 约定：宿主侧注册表落隔离目录，产品路径不变
  const {CompletedJobSyncHost}=require('../../src/extension/CompletedJobSyncHost.ts');
  const {buildScopeStatuses,scopeInventoryPathAllowed}=require('../../src/features/SyncScopeStatus.ts');
  const {planLatestWorkerMerge}=require('../../src/features/SyncLatestMerge.ts');
  const {runSyncScopeBatch}=require('../../src/features/SyncScopeBatch.ts');
  const {ensureProjectSnapshotMigrated}=require('../../src/features/ProjectStatePaths.ts');
  const crypto=require('node:crypto'),sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const tick=async()=>{await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));};
  const storage=fs.mkdtempSync(path.join(os.tmpdir(),'se-clearwake-'));
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'se-clearwake-root-'))),project=Q.canonicalProjectId(root);
  const targets=['a','b','c'].map(id=>({id,host:id+'.invalid',port:2222,user:'u',remotePath:'/safe/project'}));
  const Host=hostMethods(['saveDistributedQueue','withQueueWriteResource','loadDistributedQueue','patchDistributedJob','mergeLatestWorkerVersions'],{workspaceRoot:()=>root,ensureProjectSnapshotMigrated,
    vscode:{workspace:{getConfiguration:()=>({get:(_k,f)=>f})},Uri:{file:x=>x}},scopeInventoryPathAllowed,planLatestWorkerMerge,runSyncScopeBatch,loadSyncHolds:async()=>({}),isLocalCodeOwnedPath:()=>false,
    safeSyncPath:require('../../src/features/SyncResolution.ts').safeSyncPath,workerFpsyncTaskLabel:()=>'',UiCommandCancelled:require('../../src/core/UiCommandCancelled.ts').UiCommandCancelled, // 忠实绑定生产取消类型，不为夹具造假类型
    jobArtifactRunGeneration:require('../../src/features/JobArtifactSyncIdentity.ts').jobArtifactRunGeneration,
    isUnderMachineStatePrefixes:require('../../src/features/ProjectRootMap.ts').isUnderMachineStatePrefixes});
  const h=new Host();
  Object.assign(h,{context:{globalStorageUri:{fsPath:storage}},manualDispatchInFlight:new Set(),planCleanupHosts:new Map(),
    distributedQueueGeneration:0,distributedPlanStopEpoch:0,planStopClearBatchLease:undefined,distributedSubmissionEpochs:new Map(),
    distributedQueueWritePromise:Promise.resolve(),hostOperationLease:undefined,distributedQueueCache:null,distributedQueueRoot:'',
    distributedQueueDiskSignature:'',distributedQueueStorageDiagnostics:{status:'ready'},distributedQueueMetadataWrites:[],
    detachStaleDistributedTick(){},distributedTickAbort:undefined,distributedQueueTickPromise:undefined,postState(){},recordActionError(){},
    workerCodeSyncTargets:()=>targets,enabledWorkerConfigs:()=>targets,sftpServerOptions:row=>row,assertSshTransportIdentities:async()=>{},
    client:{getWorkerTasks:async()=>{throw Error('产物同步不得查询 job 状态');}},
    localMachineStateGuard:()=>({prefixes:[],unknown:false}),targetRootGuard:()=>null,machineStatePrefixesById:()=>[],machineStatePrefixesForTarget:()=>[],
    prepareCodeSyncRootGuards:async(rows)=>({guards:new Map(rows.map(t=>[t,{prefixes:[],unknown:false}])),assertBindingsCurrent:()=>{}})});
  // 真实文件来源与目标（无关复制的实际字节 SHA 验证，不冒称内存字符串即真实 SHA）
  const dirs=Object.fromEntries(targets.map(t=>[t.id,path.join(root,'remote',t.id)]));
  for(const id of Object.keys(dirs))fs.mkdirSync(dirs[id],{recursive:true});
  const files={'work/0/model.pth':'j0-w','work/0/artifact_manifest.json':'{"j":0}','tmp/result/job0.csv':'seed\n0\n','work/1/model.pth':'j1-w','work/1/artifact_manifest.json':'{"j":1}','tmp/result/job1.csv':'seed\n1\n'};
  for(const rel of Object.keys(files)){fs.mkdirSync(path.dirname(path.join(dirs.a,rel)),{recursive:true});fs.writeFileSync(path.join(dirs.a,rel),files[rel]);}
  h.refreshSyncScopeStatus=async(_r,_t,_m,scopes)=>{const workers={};for(const id of Object.keys(dirs)){workers[id]={};for(const rel of Object.keys(files)){const p=path.join(dirs[id],rel);if(fs.existsSync(p))workers[id][rel]={sha256:sha(p),size:fs.statSync(p).size,modifiedAtMs:1};}}return buildScopeStatuses({local:{},workers},'server-server',scopes,new Set(),{entries:{}});};
  h.verifiedSftpProjectInventory=async({source,scopePaths})=>{const out={};for(const rel of scopePaths){const p=path.join(dirs[source.id],rel);if(fs.existsSync(p))out[rel]={sha256:sha(p)};}return {files:out};};
  const transfers=[];
  h.simpleSftpApiCall=async(method,p)=>{transfers.push(p);for(const rel of p.relativePaths){const to=path.join(dirs[p.destination.id],rel);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(dirs[p.source.id],rel),to);}};
  // 队列：两个 completed 协议2 job（enqueue 后按已持久化执行覆盖字段，同 planStopClear 夹具惯例）
  const q0=Q.enqueuePlan(Q.emptyDistributedQueue(),{projectId:project,executionMode:'train_test',planFile:'p.yaml',revision:'r',codeFingerprint:'code',
    jobs:[{index:0,case:'a',seed:1,outputDir:'work/0'},{index:1,case:'b',seed:2,outputDir:'work/1'}]},'p');
  for(const j of q0.plans[0].jobs)Object.assign(j,{status:'completed',lifecycleProtocol:2,workerId:'a',commandId:'command'+j.index,collectionResultCsv:'tmp/result/job'+j.index+'.csv',actualExecutionMode:'train_test'});
  // 真实已完成证明（生产 VerifiedCompletion 契约，同 completedJobAutoRecheckSuppression 有效样本）：
  // 磁盘历史不提供运行时真相，protocol-2 行只有 verifiedCompletion 成立才在 load 归一后保持 completed。
  const {completionIdentity}=require('../../src/features/VerifiedCompletion.ts');
  for(const j of q0.plans[0].jobs)j.verifiedCompletion={schemaVersion:1,identity:completionIdentity(q0.plans[0],j),verifiedAt:'2026-10-14T00:10:00Z',exitCode:0};
  const file=Q.distributedQueuePath(storage,root);
  await fsPromises.mkdir(path.dirname(file),{recursive:true});
  await fsPromises.writeFile(file,Q.serializeDistributedQueue(q0));
  // 定向前置核对（父令）：真实 load 结果逐条件对照资格，失败即输出身份快照而非盲填字段
  const afterLoad=await h.loadDistributedQueue(root);
  const identityRows=afterLoad.plans[0].jobs.map(j=>({index:j.index,status:j.status,lifecycleProtocol:j.lifecycleProtocol,workerId:j.workerId,commandId:j.commandId,unavailable:!!j.unavailable,cleanup:!!j.cleanup,retired:!!j.outputRetiredAt}));
  assert.equal(afterLoad.plans[0].projectId,Q.canonicalProjectId(root),'load 后 plan 身份与 root 一致');
  for(const row of identityRows)assert.ok(row.status==='completed'&&row.lifecycleProtocol===2&&row.workerId&&row.commandId&&!row.unavailable&&!row.cleanup&&!row.retired,'load 归一后必须保留真实完成证明：'+JSON.stringify(identityRows));
  // 无关 job1 的真实复制挂住在 merge 阶段
  const merge=h.mergeLatestWorkerVersions.bind(h);let releaseGate,entered;const started=new Promise(r=>entered=r);
  h.mergeLatestWorkerVersions=async(...args)=>{entered();await new Promise(r=>releaseGate=r);return merge(...args);};
  const active=new CompletedJobSyncHost(h,root,()=>true).run(['.'],{jobs:[{planId:'p',index:1,commandId:'command1'}]});
  let activeFailure;const activeGuarded=active.catch(error=>{activeFailure=error;}); // before-start 失败也捕获，不留悬挂 promise
  await Promise.race([started,activeGuarded]);
  assert.equal(activeFailure,undefined,'无关 job1 必须进入复制屏障；load 资格快照：'+JSON.stringify(identityRows)+(activeFailure?`；active 首败：${activeFailure.message}`:''));
  const results=[];
  const retry=new CompletedJobSyncHost(h,root,()=>true).run(['.'],{force:true,jobs:[{planId:'p',index:0,commandId:'command0'}]}).then(()=>results.push('done'),e=>results.push(e));
  const refresh=new CompletedJobSyncHost(h,root,()=>true).run(['.'],{force:true,verifyOnly:true,jobs:[{planId:'p',index:0,commandId:'command0'}]}).then(()=>results.push('done'),e=>results.push(e));
  await tick();await tick();
  try{
    // 真实保存被围栏拒绝（rename 前、零写入，同本套件既有围栏证明）：不得向等待者发成功通知
    const rejected=await h.saveDistributedQueue(root,undefined,{queueGeneration:99,controlMutation:true,mutateLatest:latest=>({...latest,marker:'stale'})}).then(()=>null,error=>error);
    assert.equal(rejected?.code,'STALE_QUEUE_ROUND','围栏必须先于任何成功通知');
    await tick();await tick();
    assert.equal(results.length,0,'真实保存失败/被围栏拒绝时不得叫醒等待者');
    // 真实清退：生产纯函数 mutateLatest + 真实 save 落盘与成功尾
    const diskQueue=JSON.parse(await fsPromises.readFile(file,'utf8')),planRow=diskQueue.plans[0],job0row=planRow.jobs.find(j=>j.index===0);
    await h.saveDistributedQueue(root,undefined,{controlMutation:true,mutateLatest:latest=>Q.removeConfirmedDistributedPlan(latest,'p.yaml',{jobKeys:new Set([Q.distributedJobControlKey(planRow,job0row)]),deferredIds:new Set(),projectId:project})});
    const cleared=JSON.parse(await fsPromises.readFile(file,'utf8'));
    assert.ok((cleared.clearedJobs||[]).some(row=>row.experimentIndex===0&&row.commandId==='command0'),'清退以队列记录落盘');
    assert.ok(cleared.plans[0].jobs.every(j=>j.index!==0),'清退行已从队列移除');
    await tick();await tick();await tick();
    assert.equal(results.length,2,'真实清退保存成功尾必须及时结束两个排队等待（当前未接线 ⇒ 红）');
    for(const outcome of results){assert.equal(outcome?.name,'UiCommandCancelled','经既有取消通路，不冒充同步出错');assert.match(outcome.message,/清退|替代/);}
    assert.ok(fs.existsSync(path.join(dirs.a,'work/0/model.pth')),'清退是队列记录，绝不删来源产物');
  }finally{
    releaseGate?.();await activeGuarded;
    await Promise.all([retry,refresh]).catch(()=>{});
  }
  const doneQueue=JSON.parse(await fsPromises.readFile(file,'utf8'));
  assert.equal(doneQueue.plans[0].jobs.find(j=>j.index===1).latestArtifactSync.state,'synced','无关 job1 的完成证明经真实 patch 落盘');
  for(const id of ['b','c'])assert.equal(sha(path.join(dirs[id],'work/1/model.pth')),sha(path.join(dirs.a,'work/1/model.pth')),'无关复制目标实际文件 SHA 与来源一致');
  assert.ok(!transfers.some(p=>p.relativePaths.some(rel=>rel.startsWith('work/0'))),'排队等待期间对已清退 job0 零 SFTP 派发');
  assert.equal(h.completedJobSyncRuns.size,0,'单飞登记清空');
});

// SE-412 合并组合接口（本任务提交成功尾 × 上游块B统一派发准入——合并后唯一方法级交叉，
// unifiedDispatchAdmission.test.js 覆盖真实两进程准入互斥，此处不重复进程，只证明融合结构）：
// dispatchAdmission 保存仍穿过"包裹→committed→observer"结构——回执经 committed 原样传出（旧结构会吞为
// undefined）、同一临界区持项目队列+统一双资源；无 admission 的保存返回值与资源列表和旧语义完全一致；
// blocked 域锁前拒绝、STALE 围栏锁内拒绝——都不叫醒观察者、盘上字节零变化。UnifiedDispatchAdmission
// 为真实生产模块；lease 用记录 stub（资源组装由真实 withQueueWriteResource 完成）。
test('combined dispatchAdmission save propagates the receipt through the commit tail, holds both resources, and never wakes observers on rejection',async()=>{
  const UDA=require('../../src/project/UnifiedDispatchAdmission.ts');
  const discovery=fs.mkdtempSync(path.join(os.tmpdir(),'se-412-disc-'));
  const f=queueFixture({UnifiedDispatchAdmission:UDA,API_DISCOVERY_DIR:discovery},['saveDistributedQueue','withQueueWriteResource']);
  await f.seed(f.queued);
  const specs=[],leases=[],woke=[];let domain={active:false,blocked:''};
  const receipt={dispatchAdmission:true,intents:1,approved:[],denied:[],blockers:[]};
  Object.assign(f.h,{hostOperationLease:{run:async(spec,work)=>{specs.push(spec);return work();}},
    distributedQueueCommitObservers:new Set([r=>woke.push(r)]),
    unifiedDomainState:()=>domain,
    withUnifiedAdmissionLease:async(label,fn)=>{leases.push(label);return fn();},
    computeUnifiedDispatchAdmission:async(_r,_current,q)=>({queue:q,receipt})});
  // a) 无 admission：旧保存语义逐项不变（返回值 undefined、仅队列 file 资源、成功尾恰一次叫醒）
  const before=fs.readFileSync(f.file,'utf8');
  const plain=await f.h.saveDistributedQueue(f.root,undefined,{controlMutation:true,mutateLatest:latest=>({...latest,marker:'a'})});
  assert.equal(plain,undefined,'不带 dispatchAdmission 的保存返回值与旧语义一致（undefined）');
  assert.equal(specs.length,1);
  assert.equal(specs[0].resources.length,1,'不带新派发意图只持本项目队列 file 资源（与合并前逐项一致）');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')).marker,'a');
  assert.deepEqual(woke,[f.root],'成功提交尾恰一次叫醒观察者（root 实参）');
  assert.deepEqual(leases,[],'无 admission 不触碰统一事务');
  // b) 域未成立（真实 diffNewDispatchIntents 无新意图）：receipt 保持 undefined、双资源仍全程持有
  let disk=fs.readFileSync(f.file,'utf8');
  const quiet=await f.h.saveDistributedQueue(f.root,undefined,{dispatchAdmission:true,controlMutation:true,mutateLatest:latest=>({...latest,marker:'b'})});
  assert.equal(quiet,undefined,'域未成立时 receipt 仍 undefined、单项目保存行为不变（上游契约）');
  assert.equal(specs[1].resources.length,2,'带新派发意图在同一临界区追加统一派发资源（P0-2 全程覆盖）');
  assert.deepEqual(specs[1].resources[1],UDA.unifiedDispatchResource(discovery),'统一资源目标由真实 unifiedDispatchResource(discovery) 组装');
  assert.deepEqual(leases,['统一派发准入'],'同意事务经真实事务通路进入');
  assert.equal(woke.length,2);
  // c) 域成立：准入回执必须经 committed 结构原样传出（合并关键点：旧包裹若吞返回值此断言即红）
  domain={active:true,blocked:''};
  disk=fs.readFileSync(f.file,'utf8');
  const got=await f.h.saveDistributedQueue(f.root,undefined,{dispatchAdmission:true,controlMutation:true,mutateLatest:latest=>({...latest,marker:'c'})});
  assert.deepEqual(got,receipt,'dispatchAdmission 保存仍返回真实准入回执（ManualDispatchHost/tick 回执过滤依赖）');
  assert.equal(woke.length,3,'回执传播不改变成功尾通知时序（锁外、cache 发布后恰一次）');
  // d) 拒绝路径零副作用：STALE 围栏在锁内拒绝（统一资源已持=全程覆盖），blocked 域锁前拒绝
  const pinned=fs.readFileSync(f.file,'utf8');
  f.h.distributedQueueGeneration=99; // 别处已推进轮次：本请求立刻过期
  const stale=await f.h.saveDistributedQueue(f.root,undefined,{dispatchAdmission:true,controlMutation:true,queueGeneration:1,mutateLatest:latest=>({...latest,marker:'stale'})}).then(()=>null,e=>e);
  assert.equal(stale?.code,'STALE_QUEUE_ROUND','带 admission 的旧轮次仍先过 STALE 围栏');
  assert.equal(specs[specs.length-1].resources.length,2,'统一资源自进入临界区即持有，覆盖拒绝路径');
  domain={active:false,blocked:'登记表不可读'};
  const blocked=await f.h.saveDistributedQueue(f.root,undefined,{dispatchAdmission:true,controlMutation:true,mutateLatest:latest=>({...latest,marker:'blocked'})}).then(()=>null,e=>e);
  assert.match(blocked?.message,/统一派发准入.*登记表不可读/,'损坏域必须拒绝写入，绝不静默兜底放行');
  await new Promise(r=>setImmediate(r));
  assert.equal(fs.readFileSync(f.file,'utf8'),pinned,'STALE/blocked 两笔拒绝盘上字节零变化');
  assert.equal(woke.length,3,'围栏/准入拒绝路径绝不叫醒等待者');
});
