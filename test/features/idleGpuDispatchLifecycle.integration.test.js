const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname,'../..');
const original = require.extensions['.ts'];
require.extensions['.ts'] = (loaded, filename) => loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText,filename);
const DistributedPlanQueue = require('../../src/features/DistributedPlanQueue.ts');
const DistributedSchedulingPolicy = require('../../src/features/DistributedSchedulingPolicy.ts');
const GpuJobOwnership = require('../../src/features/GpuJobOwnership.ts');
const PlanExecutionMode = require('../../src/features/PlanExecutionMode.ts');
const GpuQuotaScheduling = require('../../src/features/GpuQuotaScheduling.ts');
const PlanCodeScopeHost = require('../../src/extension/PlanCodeScopeHost.ts');
// tick 引用 AgentTmuxPolicy_1（会话前缀核实），必须在 .ts 解析钩子窗口内加载真实模块。
const AgentTmuxPolicy_1 = require('../../src/tunnel/AgentTmuxPolicy.ts');
require.extensions['.ts'] = original;
const source = fs.readFileSync(path.join(root,'src/extension/legacy.ts'),'utf8');
const proofHelperSource = source.match(/^function durableCodeProofRequestFields\([\s\S]*?^\}/m)?.[0];
assert.ok(proofHelperSource, 'missing production durable code proof request helper');
const durableCodeProofRequestFields = new Function(`${proofHelperSource}\nreturn durableCodeProofRequestFields;`)();
// 现行协议（taskLifecycle=2）：队列 job 的身份核实只认 Worker 主动查询快照里的结构化观察；
// durable schemaVersion:1 旧回执不再是 lifecycle-2 job 的状态来源（merge 会直接忽略并标记未知）。
const canonicalProject = DistributedPlanQueue.canonicalProjectId(root);
function v2Observation(commandId,workerId,state){const at=new Date().toISOString();const timing={requestedAt:at,networkStartedAt:at,receivedAt:at};
  return {commandId,projectId:canonicalProject,workerId,lifecycleProtocol:2,observedAt:at,evidence:{execution:{...timing},artifacts:{...timing},logs:{...timing}},
    ...(state==='completed'?{tmux:{windowId:'1',paneId:'1.1',dead:true,exitCode:0},result:{runId:commandId,status:'completed',present:true,verified:true,artifactsComplete:true,exitCode:0}}:{}),
    ...(state==='failed'?{tmux:{windowId:'1',paneId:'1.1',dead:true,exitCode:1}}:{}),
    ...(state==='running'?{tmux:{windowId:'1',paneId:'1.1',dead:false,phase:'running'}}:{}),
    ...(state==='queued'?{tmux:{windowId:'1',paneId:'1.1',dead:false,phase:'queued'}}:{}),
  };
}
function v2Task(plan,job,workerId,state,extra={}){const commandId=extra.commandId??job.commandId;
  return {projectId:canonicalProject,workflowId:plan.id,globalJobId:plan.id+':'+job.index,planFile:plan.planFile,planRevision:plan.revision,codeFingerprint:plan.codeFingerprint,
    resultPathPolicy:'declared',experimentIndex:job.index,case:job.case,seed:job.seed,attempt:job.attempt??0,outputDir:job.outputDir,collectionResultCsv:job.collectionResultCsv,
    planJobCount:plan.planJobCount??plan.jobs.length,enqueuedAt:plan.enqueuedAt,commandId,workerId,gpuId:String(extra.gpuId??job.gpuId??''),status:state,
    observation:v2Observation(commandId,workerId,extra.observationState??state),...(extra.task||{})};
}
function v2Snapshot(workerId,tasks){const at=new Date().toISOString();return {workerId,generatedAt:at,fetchedAt:at,queryComplete:true,
  capabilities:{taskLifecycle:2,durablePlanQueue:true,idleGpuAdmission:true,declaredJobPaths:true,schemaVersion:1,actionEndpoints:{"stop-worker-task-exact-pane":true,"stop-worker-task-formal-identity":true,"stop-worker-task-formal-no-attempt":true}},tasks};}
function provider(names, extra={}) {
  const ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);
  const cls=ast.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='RealtimeTunnelPanelProvider');
  const code='class Provider {'+cls.members.filter(node=>names.includes(node.name?.getText(ast))).map(node=>node.getText(ast)).join('\n')+'}; Provider;';
  return vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
    {DistributedPlanQueue,DistributedSchedulingPolicy,GpuJobOwnership,PlanExecutionMode,GpuQuotaScheduling,
      PlanCodeScopeHost,AgentTmuxPolicy_1,
      durableCodeProofRequestFields,workspaceRoot:()=>root,setInterval,clearInterval,
      mapLimited:async(rows,_limit,callback)=>Promise.all(rows.map(callback)),errorMessage:error=>error.message,...extra});
}
test('G1 actual host tick only dispatches idle NWPU3, persists identity before RPC, and explicitly hosts opt-in queue',async()=>{
  const Provider=provider(['tickDistributedQueueCore']);const p=new Provider();
  p.distributedQueueGeneration=0;p.distributedPlanStopEpoch=0;p.distributedNextFailureDetailAt=Infinity;
  p.distributedNextPostprocessAt=Infinity;p.distributedLaunchInFlight=new Set();
  p.isRealtimeMode=()=>true;p.projectTopologyAssessment=()=>({mode:'worker_pool'});
  p.workerCodeSyncTargets=()=>[];p.workerActionTargets=()=>[{id:'nwpu3'},{id:'nwpu5'}];
  p.lastWorkerProbes={nwpu3:{status:'ok',capabilities:{endpoints:{declaredJobPaths:true,formalJobIdentityEnv:1,taskShellEnvironment:1,projectManagedValidation:1,gpuQuotaScheduling:1}}},nwpu5:{status:'ok',capabilities:{endpoints:{declaredJobPaths:true,formalJobIdentityEnv:1,taskShellEnvironment:1,projectManagedValidation:1,gpuQuotaScheduling:1}}}};
  p.lastCodeSyncState={workerVersions:{nwpu3:{fingerprint:'f'},nwpu5:{fingerprint:'f'}}};
  p.enabledWorkerConfigs=()=>[{id:'nwpu3',workerUser:'alice'},{id:'nwpu5',workerUser:'alice'}];
  p.schedulerSettings=()=>({gpuIdleUtilThreshold:5,gpuIdleMemThresholdMb:200});p.gpuOwnerConfig=()=>({currentUser:'alice'});
  p.recordActionError=()=>{};p.postState=()=>{};p.scheduleDistributedPostprocess=()=>{};p.queuePlanArtifactSyncStatusCheck=()=>{};
  let manifestBuilds=0;p.buildDistributedJobCodeManifest=async()=>{manifestBuilds++;return {};};
  p.readWorkerTaskSnapshot=async workerId=>({workerId,generatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),
    capabilities:{durablePlanQueue:true,idleGpuAdmission:true,declaredJobPaths:true,schemaVersion:1,actionEndpoints:{"stop-worker-task-exact-pane":true,"stop-worker-task-formal-identity":true,"stop-worker-task-formal-no-attempt":true}},tasks:[]});
  let releaseSnapshots;const snapshotGate=new Promise(resolve=>{releaseSnapshots=resolve;});let gpuReadStarted=false;
  p.readWorkerTaskSnapshotBatch=async workerIds=>{await snapshotGate;return Promise.all(workerIds.map(p.readWorkerTaskSnapshot));};
  // 内存配额准入（Windows 0.5.400 同源）：空闲卡按 free = total-used ≥ gpuMinFreeMemoryGb 判定。
  p.client={getGpu:async()=>{gpuReadStarted=true;return {nwpu3:[{index:'0',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]}],
    nwpu5:[{index:'0',utilizationPercent:99,memoryUsedMb:5000,memoryTotalMb:8192,processes:[{username:'alice'}]}]};}};
  let stored;let calls=[];
  p.loadDistributedQueue=async()=>JSON.parse(JSON.stringify(stored));
  p.saveDistributedQueue=async(_root,value)=>{stored=JSON.parse(JSON.stringify(value));};
  p.sendDistributedJob=async(plan,job,workerId,gpuId,commandId)=>{
    assert.equal(stored.plans[0].jobs.find(row=>row.index===job.index).commandId,commandId,'identity must precede remote write');
    calls.push({workerId,gpuId,commandId});
    return {projectId:plan.projectId,workflowId:plan.id,planRevision:plan.revision,codeFingerprint:plan.codeFingerprint,resultPathPolicy:plan.resultPathPolicy,globalJobId:job.globalJobId,collectionResultCsv:job.collectionResultCsv,
      planJobCount:plan.planJobCount,planFile:plan.planFile,experimentIndex:job.index,case:job.case,seed:job.seed,attempt:job.attempt,
      outputDir:job.outputDir,runKey:commandId,commandId,workerId,gpuId:gpuId??'',status:'queued',durableAccepted:true};
  };
  const make=mode=>DistributedPlanQueue.enqueuePlan(DistributedPlanQueue.emptyDistributedQueue(),{
    projectId:DistributedPlanQueue.canonicalProjectId(root),schedulingMode:mode,planFile:'p.yaml',revision:'r',codeFingerprint:'f',
    jobs:[0,1].map(index=>({index,case:'bus',seed:index,outputDir:`runs/${index}`,collectionResultCsv:(`runs/${index}`)+"/metrics.csv"}))},'p');
  stored=make('local_idle');const initialTick=p.tickDistributedQueueCore();
  for(let attempt=0;attempt<10&&!gpuReadStarted;attempt++)await new Promise(setImmediate);
  assert.equal(gpuReadStarted,true,'GPU and task snapshots must start in the same initial dispatch window');
  releaseSnapshots();await initialTick;
  assert.equal(manifestBuilds,1,'all jobs in one Plan dispatch share a single local manifest build');
  assert.equal(calls.length,1,`G1 busy NWPU5 must receive no default dispatch; queue=${JSON.stringify(stored)}`);assert.equal(calls[0].workerId,'nwpu3');assert.equal(calls[0].gpuId,'0');
  assert.equal(stored.plans[0].jobs[1].workerId,undefined);
  stored=make('server_prequeue');calls=[];
  p.distributedSubmissionTimings=new Map([['p',{operationId:'submit',clickStartedAt:Date.now()-100}]]);
  p.localOperations={submit:{timings:{clickToFirstAcceptedJobMs:0}}};
  const timingEvents=[];
  p.recordPlanSubmissionTimingByOperation=(_id,key,value)=>{
    timingEvents.push(key);p.localOperations.submit.timings[key]=value;
  };
  const send = p.sendDistributedJob;
  let releaseFirst;
  const firstReceipt = new Promise(resolve => { releaseFirst = resolve; });
  p.sendDistributedJob = async (...args) => {
    const receipt = await send(...args);
    if (args[1].index === 0) await firstReceipt;
    return receipt;
  };
  // 现契约：opt-in 预队列批次同样消费已核实的空闲 GPU 配额槽位（hosted 无槽位分发已被移除）；
  // NWPU3 第二张空闲卡被核实后，同批两个 job 才能并行派发，各自绑定自己的卡。
  p.client.getGpu=async()=>({nwpu3:[{index:'0',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]},
    {index:'1',utilizationPercent:0,memoryUsedMb:9,memoryTotalMb:40960,processes:[]}],
    nwpu5:[{index:'0',utilizationPercent:99,memoryUsedMb:5000,memoryTotalMb:8192,processes:[{username:'alice'}]}]});
  const dispatching = p.tickDistributedQueueCore();
  try {
    for (let attempt = 0; attempt < 10 && calls.length < 2; attempt++) await new Promise(setImmediate);
    assert.equal(calls.length, 2, 'a slow first receipt must not block the second dispatch');
    for (let attempt = 0; attempt < 10 && stored.plans[0].jobs[1].status !== 'queued'; attempt++) await new Promise(setImmediate);
    assert.equal(stored.plans[0].jobs[1].status, 'queued', 'a fast receipt must be persisted while another Worker is still responding');
    assert.equal(stored.plans[0].jobs[0].status, 'dispatching', 'the delayed request remains owned and cannot be falsely acknowledged');
    assert.ok(p.distributedLaunchInFlight.has(DistributedPlanQueue.distributedJobControlKey(stored.plans[0],stored.plans[0].jobs[0])),'safe retry must still see the exact delayed formal command as in flight');
    assert.ok(p.localOperations.submit.timings.clickToFirstAcceptedJobMs>=100,'first acceptance is timed before the slow receipt returns');
    assert.equal(timingEvents.includes('dispatchMs'),false,'batch completion has not yet happened');
  } finally { releaseFirst(); }
  await dispatching;
  assert.equal(calls.length,2);assert.deepEqual(calls.map(row=>row.workerId).sort(),['nwpu3','nwpu3'],
    'a shared login cannot add the foreign occupied NWPU5 GPU to our hosted share');
  assert.equal(manifestBuilds,2,'the second Plan tick also builds only one shared manifest');
  assert.deepEqual(calls.map(row=>row.gpuId).sort(),['0','1'],'each hosted job rides its own verified idle card');
  assert.ok(stored.plans[0].jobs.every(row=>row.status==='queued'));
  assert.equal(timingEvents.filter(key=>key==='clickToFirstAcceptedJobMs').length,1);
  assert.ok(timingEvents.includes('dispatchMs'),'batch timing survives removing the first-acceptance tracker');
  assert.equal(p.distributedLaunchInFlight.size,0);
});

function durableTickFixture() {
  let attemptSerial = 0;
  const Provider=provider(['tickDistributedQueueCore'], { makeOpId: () => `auto-retry-host-${++attemptSerial}` });const p=new Provider();
  p.distributedQueueGeneration=0;p.distributedPlanStopEpoch=0;p.distributedNextFailureDetailAt=Infinity;
  p.distributedNextPostprocessAt=Infinity;p.distributedLaunchInFlight=new Set();
  p.isRealtimeMode=()=>true;p.projectTopologyAssessment=()=>({mode:'worker_pool'});p.workerCodeSyncTargets=()=>[];
  p.workerActionTargets=()=>[{id:'a'},{id:'b'}];p.lastWorkerProbes={a:{status:'ok',capabilities:{endpoints:{declaredJobPaths:true,formalJobIdentityEnv:1,taskShellEnvironment:1,projectManagedValidation:1,gpuQuotaScheduling:1}}},b:{status:'ok',capabilities:{endpoints:{declaredJobPaths:true,formalJobIdentityEnv:1,taskShellEnvironment:1,projectManagedValidation:1,gpuQuotaScheduling:1}}}};
  p.lastCodeSyncState={workerVersions:{a:{fingerprint:'f'},b:{fingerprint:'f'}}};
  p.enabledWorkerConfigs=()=>[{id:'a'},{id:'b'}];p.schedulerSettings=()=>({});p.gpuOwnerConfig=()=>({});
  p.recordActionError=()=>{};p.postState=()=>{};p.scheduleDistributedPostprocess=()=>{};p.queuePlanArtifactSyncStatusCheck=()=>{};
  p.buildDistributedJobCodeManifest=async()=>({});
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>v2Snapshot(workerId,[]));
  // 每张空闲卡提供一个配额槽位；同批并行度受“已核实空闲卡数”约束是现行契约。
  p.client={getGpu:async()=>({a:[{index:'0',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]},
    {index:'1',utilizationPercent:0,memoryUsedMb:9,memoryTotalMb:40960,processes:[]}],
    b:[{index:'0',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]},
    {index:'1',utilizationPercent:0,memoryUsedMb:9,memoryTotalMb:40960,processes:[]}]})};
  let stored=DistributedPlanQueue.enqueuePlan(DistributedPlanQueue.emptyDistributedQueue(),{
    projectId:DistributedPlanQueue.canonicalProjectId(root),schedulingMode:'server_prequeue',planFile:'p.yaml',revision:'r',codeFingerprint:'f',
    jobs:[0,1].map(index=>({index,case:'bus',seed:index,outputDir:`runs/${index}`,collectionResultCsv:(`runs/${index}`)+"/metrics.csv"}))},'p');
  p.loadDistributedQueue=async()=>JSON.parse(JSON.stringify(stored));
  p.saveDistributedQueue=async(_root,value)=>{stored=JSON.parse(JSON.stringify(value));};
  const receipt=(plan,job,workerId,_gpuId,commandId)=>({projectId:plan.projectId,workflowId:plan.id,planRevision:plan.revision,
    codeFingerprint:plan.codeFingerprint,resultPathPolicy:plan.resultPathPolicy,globalJobId:job.globalJobId,collectionResultCsv:job.collectionResultCsv,planJobCount:plan.planJobCount,planFile:plan.planFile,experimentIndex:job.index,case:job.case,
    seed:job.seed,attempt:job.attempt,outputDir:job.outputDir,runKey:commandId,commandId,workerId,gpuId:String(_gpuId??''),status:'queued',durableAccepted:true});
  return {p,receipt,stored:()=>stored};
}

function queuedMigrationFixture() {
  const fixture = durableTickFixture(), {p, receipt, stored} = fixture;
  const plan = stored().plans[0]; plan.schedulingMode = 'local_idle';
  plan.jobs.forEach((job, index) => Object.assign(job, { status: index ? 'queued' : 'completed', workerId: 'a',
    gpuId: index ? '0' : '1', commandId: `original-${index}`, runKey: `original-${index}`,
    outputDir: `work/job${index}`, ...(index ? {} : { finishedAt: new Date().toISOString() }) }));
  plan.jobs[1].automaticRetry = {failureCount:1,failedAttempt:0,lastError:'CUDA failure'};
  // 投机迁移/排队释放 RPC 只服务旧版本插件留下的 lifecycle-1 durable 队列；
  // lifecycle-2 任务由 Worker 拥有，宿主绝不投机迁移（由下方独立用例钉住）。
  plan.jobs.forEach(job => { delete job.lifecycleProtocol; });
  p.readWorkerTaskSnapshotBatch = async ids => ids.map(workerId => ({workerId, generatedAt:new Date().toISOString(),
    fetchedAt:new Date().toISOString(),capabilities:{durablePlanQueue:true,idleGpuAdmission:true,declaredJobPaths:true,schemaVersion:1,actionEndpoints:{"stop-worker-task-exact-pane":true,"stop-worker-task-formal-identity":true,"stop-worker-task-formal-no-attempt":true}},
    tasks:stored().plans.flatMap(plan => plan.jobs.filter(job => job.workerId === workerId).map(job => ({
      ...receipt(plan,job,workerId,job.gpuId,job.commandId),gpuId:job.gpuId,enqueuedAt:plan.enqueuedAt,
      status:job.status,finishedAt:job.finishedAt}))) }));
  const cancelled=[], sent=[];
  p.withRemoteActionResource=async (_id,_action,_request,work)=>work();
  p.client.postWorkerAction=async (_id,_action,request)=>{
    cancelled.push(request.targetCommandId);
    return {...request,status:'cancelled',stopReason:'requeue',durableAccepted:true,durableReleased:true,
      neverStarted:true,neverStartedEvidence:'durable_queued_row',finishedAt:new Date().toISOString()};
  };
  p.sendDistributedJob=async (...args)=>{sent.push({workerId:args[2],gpuId:args[3],attempt:args[1].attempt});
    return {...receipt(...args),gpuId:args[3]};};
  return {...fixture,cancelled,sent};
}

test('local queued job on its own idle GPU is not cancelled and redispatched every tick',async()=>{
  const {p,stored,cancelled,sent}=queuedMigrationFixture();
  const before=stored().plans[0].jobs[1].commandId;
  for(let tick=0;tick<5;tick++)await p.tickDistributedQueueCore();
  assert.equal(cancelled.length,0,'a second idle Worker must not interrupt an admitted task on an idle owner GPU');
  assert.equal(sent.length,0);
  assert.equal(stored().plans[0].jobs[1].attempt,0);
  assert.equal(stored().plans[0].jobs[1].commandId,before);
});

test('a lifecycle-2 queued task is never speculatively released or migrated even when its owner GPU looks busy',async()=>{
  const {p,stored,cancelled,sent}=queuedMigrationFixture();
  const plan=stored().plans[0];
  plan.jobs.forEach(job=>{job.lifecycleProtocol=2;});
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>v2Snapshot(workerId,workerId==='a'
    ?plan.jobs.map(job=>v2Task(plan,job,workerId,job.status==='completed'?'completed':'queued')):[]));
  p.client.getGpu=async()=>({a:[{index:'0',utilizationPercent:99,memoryUsedMb:23000,memoryTotalMb:24576,processes:[]},
    {index:'1',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]}],
    b:[{index:'0',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]}]});
  await p.tickDistributedQueueCore();
  for(let tick=0;tick<4;tick++)await p.tickDistributedQueueCore();
  // lifecycle-2 契约：排队任务由 Worker 拥有，宿主不投机发起 stop-worker-task 释放，也不迁移到其他 Worker。
  assert.equal(cancelled.length,0,'the host never speculates a release RPC for a lifecycle-2 queued task');
  assert.equal(sent.length,0);
  const job=stored().plans[0].jobs[1];
  assert.equal(job.status,'queued','Worker 主动查询确认排队状态必须原样保留');
  assert.equal(job.workerId,'a');assert.equal(job.gpuId,'0');
  assert.equal(job.commandId,'original-1');assert.equal(job.attempt,0);
  assert.equal(job.automaticRetry.failureCount,1,'排队核实不得改写既有失败记账');
});

test('a verified busy owner GPU migrates once to the selected destination instead of the original Worker',async()=>{
  const {p,stored,cancelled,sent}=queuedMigrationFixture();
  p.client.getGpu=async()=>({a:[{index:'0',utilizationPercent:99,memoryUsedMb:23000,memoryTotalMb:24576,processes:[]},
    {index:'1',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]}],
    b:[{index:'0',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]}]});
  await p.tickDistributedQueueCore();
  assert.deepEqual(sent.map(row=>row.workerId),['b'],'release destination must survive normal case/seed affinity allocation');
  for(let tick=0;tick<4;tick++)await p.tickDistributedQueueCore();
  assert.equal(cancelled.length,1);assert.equal(sent.length,1);
  assert.equal(stored().plans[0].jobs[1].workerId,'b');
  assert.equal(stored().plans[0].jobs[1].attempt,0);
  assert.equal(stored().plans[0].jobs[1].automaticRetry.failureCount,1);
});

test('a queued-task release needs owner-GPU evidence, and a Worker refusal to release keeps the original identity',async()=>{
  // 遥测认不出 job 所在卡（缺该 index）→ 宿主不发起任何释放。
  const {p,stored,cancelled,sent}=queuedMigrationFixture();
  p.client.getGpu=async()=>({a:[{index:'1',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]}],
    b:[{index:'0',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]}]});
  await p.tickDistributedQueueCore();
  assert.equal(cancelled.length,0,'owner GPU 无法从遥测中识别时不得释放');
  assert.equal(sent.length,0);
  assert.equal(stored().plans[0].jobs[1].commandId,'original-1');
  // 认得出卡但拿不到内存数字：现行配额契约允许宿主尝试释放（空闲与否由内存配额判定），
  // 真实释放必须由 Worker 的精确 never-started 证明把关；Worker 拒绝时原身份原样保留。
  const refusal=queuedMigrationFixture();
  refusal.p.client.getGpu=async()=>({a:[{index:'0'}],
    b:[{index:'0',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]}]});
  refusal.p.client.postWorkerAction=async(_id,_action,request)=>({...request,commandId:request.targetCommandId,status:'running',durableReleased:false});
  await refusal.p.tickDistributedQueueCore();
  const job=refusal.stored().plans[0].jobs[1];
  assert.equal(refusal.sent.length,0,'Worker 未出具释放证明时绝不重新派发');
  assert.equal(job.commandId,'original-1');assert.equal(job.workerId,'a');assert.equal(job.status,'running');
});

test('a release racing a Worker start retains the original command without dispatching another attempt',async()=>{
  const {p,stored,sent}=queuedMigrationFixture();
  p.client.getGpu=async()=>({a:[{index:'0',utilizationPercent:99,memoryUsedMb:23000,memoryTotalMb:24576,processes:[]}],
    b:[{index:'0',utilizationPercent:0,memoryUsedMb:7,memoryTotalMb:40960,processes:[]}]});
  p.client.postWorkerAction=async(_id,_action,request)=>({...request,commandId:request.targetCommandId,status:'running',durableReleased:false});
  await p.tickDistributedQueueCore();
  const job=stored().plans[0].jobs[1];
  assert.equal(job.status,'running');assert.equal(job.commandId,'original-1');assert.equal(job.attempt,0);
  assert.equal(job.reassignmentWorkerId,undefined);assert.equal(sent.length,0);
});

test('unconfirmed command reconciliation keeps unknown stable and never auto-redispatches the command',async()=>{
  const {p,stored}=durableTickFixture();
  const plan=stored().plans[0];plan.schedulingMode='local_idle';
  Object.assign(plan.jobs[0],{status:'completed',workerId:'a',gpuId:'1',commandId:'completed-command',runKey:'completed-command'});
  Object.assign(plan.jobs[1],{status:'unknown',workerId:'a',gpuId:'0',commandId:'unconfirmed-command',
    runKey:'unconfirmed-command',outputDir:'work/job1'});
  // Worker 主动查询能核实 completed-command，但队列里查不到 unconfirmed-command。
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>v2Snapshot(workerId,workerId==='a'
    ?[v2Task(stored().plans[0],stored().plans[0].jobs[0],'a','completed')]:[]));
  let calls=0;const statuses=[];
  const save=p.saveDistributedQueue;p.saveDistributedQueue=async (...args)=>{statuses.push(args[1].plans[0].jobs[1].status);await save(...args);};
  p.sendDistributedJob=async()=>{calls++;throw new Error('receipt not yet available');};
  for(let tick=0;tick<4;tick++)await p.tickDistributedQueueCore();
  // lifecycle-2 契约：未确认命令只做只读核对；远端未发现任务时保留原命令，绝不自动重新派发。
  assert.equal(calls,0,'an unconfirmed lifecycle-2 command must never be auto-redispatched by the tick');
  assert.equal(statuses.includes('dispatching'),false,'unverified ownership never flashes dispatching');
  assert.equal(statuses.every(s=>s==='unknown'),true,'unverified ownership stays unknown across ticks');
  const job=stored().plans[0].jobs[1];
  assert.equal(job.commandId,'unconfirmed-command');
  assert.equal(job.attempt,0);
  assert.match(String(job.blockReason||''),/远端未发现该任务|未自动重新派发/,'未核实任务必须给出只读核对的明确原因');
  assert.equal(stored().plans[0].jobs[0].status,'completed','已核实完成的任务不受未确认邻居影响');
});

test('task snapshot grace uses only a recently verified cache while a slow fresh request continues',async()=>{
  const Provider=provider(['readWorkerTaskSnapshotBatch'],{setTimeout,clearTimeout});const p=new Provider();
  let release;const slow=new Promise(resolve=>{release=resolve;});p.readWorkerTaskSnapshot=()=>slow;
  const cache={workerId:'a',generatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),queryComplete:true,
    capabilities:{taskLifecycle:2,schemaVersion:1},tasks:[{commandId:'verified-command'}]};
  p.cachedWorkerTaskSnapshot=()=>cache;
  try {
    const result=await p.readWorkerTaskSnapshotBatch(['a'],{graceMs:0});
    assert.equal(result[0].error,undefined,'normal polling latency must not erase a recent authoritative snapshot');
    assert.equal(result[0].tasks[0].commandId,'verified-command');
    assert.equal(result[0].fetchedAt,cache.fetchedAt,'cache age must not be fabricated as a fresh read');
    assert.equal(result[0].refreshPending,true,'缓存只是慢查询期间的过渡视图，必须标记待刷新');
    // PROGRESS_FRESHNESS_MS=20_000：超过窗口的缓存不得再冒充待刷新的权威快照。
    cache.fetchedAt=cache.generatedAt=new Date(Date.now()-21_000).toISOString();
    const expired=await p.readWorkerTaskSnapshotBatch(['a'],{graceMs:0});
    assert.equal(expired[0].pending,true);assert.equal(expired[0].tasks.length,0);
    assert.equal(expired[0].refreshPending,undefined,'expired ownership must remain unverified, never a pending refresh');
    cache.fetchedAt=cache.generatedAt=new Date().toISOString();cache.error='disconnected';
    const failed=await p.readWorkerTaskSnapshotBatch(['a'],{graceMs:0});
    assert.equal(failed[0].error,'disconnected','缓存中的真实错误必须原样上报，不能被待刷新状态掩盖');
    assert.equal(failed[0].refreshPending,undefined,'错误快照不得标记为待刷新的核实视图');
  } finally {release(cache);}
});

test('formal partial failure retains completed jobs and the lifecycle-2 host never mints new attempts', async () => {
  const {p,stored}=durableTickFixture();const plan=stored().plans[0];
  plan.jobs.forEach((job,index)=>Object.assign(job,{status:index?'failed':'completed',workerId:'a',gpuId:'0',
    commandId:'old-'+index,runKey:'old-'+index,finishedAt:new Date().toISOString(),
    ...(index?{error:'RuntimeError: CUDA error: CUBLAS_STATUS_NOT_INITIALIZED'}:{})}));
  const paths=plan.jobs.map(job=>job.outputDir);
  // Worker 主动查询给出结构化终态观察：退出码 0+产物核实 → completed；退出码 1+错误原文 → failed。
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>v2Snapshot(workerId,workerId==='a'
    ?plan.jobs.map(job=>v2Task(plan,job,workerId,job.status==='failed'?'failed':'completed',
      job.status==='failed'?{task:{error:job.error,finishedAt:job.finishedAt}}:{})):[]));
  let sent=0;p.sendDistributedJob=async()=>{sent++;throw Error('unexpected execution');};
  for(let i=0;i<4;i++)await p.tickDistributedQueueCore();
  assert.equal(sent,0);
  assert.equal(stored().plans[0].jobs[0].status,'completed');
  assert.equal(stored().plans[0].jobs[0].resultState,'complete','完成状态必须由产物观察核实');
  const failed=stored().plans[0].jobs[1];assert.equal(failed.status,'failed');assert.equal(failed.attempt,0);
  assert.match(String(failed.error),/CUBLAS_STATUS_NOT_INITIALIZED/,'失败原因必须保留自 Worker 观察');
  // lifecycle-2 宿主取消了自动重试排期（旧 FORMAL_JOB_CONFLICT blockedReason 只服务 lifecycle-1 历史队列）：
  // 失败 job 保持原命令与原路径，重跑必须经显式审核入口。
  assert.equal(failed.automaticRetry?.retryAt,undefined,'lifecycle-2 宿主不得排期任何自动重试');
  assert.equal(failed.commandId,'old-1');
  assert.deepEqual(stored().plans[0].jobs.map(job=>job.outputDir),paths,'审核前不得生成新的 attempts 路径');
});

test('formal resource failure cannot auto rerun when code or GPU availability changes', async () => {
  const {p,stored}=durableTickFixture();const plan=stored().plans[0];plan.schedulingMode='local_idle';
  plan.jobs.forEach((job,index)=>Object.assign(job,{status:index?'failed':'completed',workerId:'a',gpuId:String(index),
    commandId:'old-'+index,runKey:'old-'+index,finishedAt:new Date().toISOString(),
    ...(index?{error:'torch.OutOfMemoryError: CUDA out of memory'}:{})}));
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>v2Snapshot(workerId,workerId==='a'
    ?plan.jobs.map(job=>v2Task(plan,job,workerId,job.status==='failed'?'failed':'completed',
      {gpuId:job.gpuId,...(job.status==='failed'?{task:{error:job.error,finishedAt:job.finishedAt}}:{})})):[]));
  let sends=0;p.sendDistributedJob=async()=>{sends++;throw Error('unexpected execution');};
  for(const fingerprint of ['different-code','f']){
    p.lastCodeSyncState.workerVersions={a:{fingerprint},b:{fingerprint}};
    await p.tickDistributedQueueCore();
  }
  assert.equal(sends,0,'代码或 GPU 可用性变化都不能让终态 OOM 失败自动重跑');
  const failed=stored().plans[0].jobs[1];assert.equal(failed.status,'failed');
  assert.equal(failed.automaticRetry?.retryAt,undefined,'lifecycle-2 宿主不排期任何自动重试');
  assert.equal(failed.attempt,0);assert.equal(failed.commandId,'old-1');
  assert.equal(stored().plans[0].jobs[0].status,'completed');
});

test('startup failure is visible through live observations and never starts a new formal job automatically', async () => {
  const {p,stored}=durableTickFixture();const plan=stored().plans[0];
  plan.jobs.forEach((job,index)=>Object.assign(job,{status:'running',workerId:'a',gpuId:'0',commandId:'startup-'+index,runKey:'startup-'+index}));
  let phase='running';
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>v2Snapshot(workerId,workerId==='a'
    ?plan.jobs.map(job=>v2Task(plan,job,workerId,phase,phase==='failed'?{task:{error:'AttributeError: missing method',finishedAt:new Date().toISOString()}}:{})):[]));
  let sends=0;p.sendDistributedJob=async()=>{sends++;};await p.tickDistributedQueueCore();
  // 现行观察窗口以 Worker 主动查询为准：running 阶段必须原样可见（healthyReason 属于 lifecycle-1 排期记账）。
  assert.deepEqual(stored().plans[0].jobs.map(job=>job.status),['running','running'],'启动阶段必须原样可见');
  assert.equal(stored().plans[0].jobs.every(job=>job.executionState==='running'),true);
  phase='failed';
  for(let i=0;i<4;i++)await p.tickDistributedQueueCore();assert.equal(sends,0);
  for(const job of stored().plans[0].jobs){assert.equal(job.status,'failed');assert.equal(job.attempt,0);
    assert.equal(job.automaticRetry?.retryAt,undefined,'lifecycle-2 宿主不得自动启动新的正式 job');
    assert.match(String(job.error),/AttributeError|退出码/);}
});

test('historical unsubmitted retry from an older plugin remains read-only with its original evidence', async () => {
  const {p,stored}=durableTickFixture();const plan=stored().plans[0];delete plan.resultPathPolicy;
  Object.assign(plan.jobs[0],{status:'completed',workerId:'a',commandId:'success',runKey:'success'});
  Object.assign(plan.jobs[1],{status:'pending',attempt:2,outputDir:'work/job1/attempts/auto-retry-old',resultPathPolicy:undefined,
    automaticRetry:{failureCount:1,failedAttempt:1,lastError:'AttributeError: missing method'},
    history:[{status:'failed',attempt:1,outputDir:'work/job1/attempts/old',workerId:'a',commandId:'old-failure',error:'AttributeError: missing method'}]});
  const before=JSON.stringify(plan.jobs[1]);let sent=0;p.sendDistributedJob=async()=>{sent++;};
  for(let i=0;i<3;i++)await p.tickDistributedQueueCore();assert.equal(sent,0);
  assert.equal(JSON.stringify(stored().plans[0].jobs[1]),before);
});

test('actual Host tick dispatches two code versions to independent verified Workers in one tick',async()=>{
  const {p,receipt,stored}=durableTickFixture();
  p.lastCodeSyncState.workerVersions.b.fingerprint='g';
  await p.saveDistributedQueue(root,DistributedPlanQueue.enqueuePlan(stored(),{
    projectId:DistributedPlanQueue.canonicalProjectId(root),schedulingMode:'server_prequeue',planFile:'next.yaml',revision:'r2',codeFingerprint:'g',
    jobs:[0,1].map(index=>({index,case:'pad',seed:index,outputDir:`next/${index}`,collectionResultCsv:(`next/${index}`)+"/metrics.csv"}))},'next'));
  const sent=[];
  p.sendDistributedJob=async(...args)=>{sent.push({plan:args[0].id,worker:args[2]});return receipt(...args);};
  await p.tickDistributedQueueCore();
  assert.deepEqual(sent,[{plan:'p',worker:'a'},{plan:'p',worker:'a'},{plan:'next',worker:'b'},{plan:'next',worker:'b'}]);
  assert.ok(stored().plans.every(plan=>plan.jobs.every(job=>job.status==='queued')));
  assert.equal(p.distributedLaunchInFlight.size,0);
});

test('code upload holds only new allocation while the actual Host tick still records old terminal receipts',async()=>{
  const {p,receipt,stored}=durableTickFixture();
  const plan=stored().plans[0],job=plan.jobs[0];
  Object.assign(job,{status:'running',workerId:'a',commandId:DistributedPlanQueue.durableCommandId(plan,job,'a')});
  // 代码上传期间，Worker 主动查询的终态观察仍必须被记录（v2 结构化核实）。
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>v2Snapshot(workerId,workerId==='a'
    ?[v2Task(stored().plans[0],stored().plans[0].jobs[0],'a','completed',{task:{finishedAt:new Date().toISOString()}})]:[]));
  p.codeSyncInFlight=1;let sends=0;p.sendDistributedJob=async()=>{sends++;};
  await p.tickDistributedQueueCore();
  assert.equal(stored().plans[0].jobs[0].status,'completed');
  assert.equal(stored().plans[0].jobs[1].status,'pending');
  assert.equal(stored().plans[0].jobs[1].workerId,undefined);
  assert.equal(sends,0);
});
test('receipt writes stay serialized and a failed commit drains every dispatched RPC before the tick rejects',async()=>{
  const {p,receipt,stored}=durableTickFixture();let release;const slow=new Promise(resolve=>{release=resolve;});
  let slowSent=false;let exited=false;let receiptWriteReached=false;let activeWrites=0;let maxWrites=0;
  const save=p.saveDistributedQueue;
  p.saveDistributedQueue=async(...args)=>{
    activeWrites++;maxWrites=Math.max(maxWrites,activeWrites);
    try { if(args[1].plans[0].jobs.some(job=>job.status==='queued')){receiptWriteReached=true;throw new Error('disk write denied');}await save(...args); }
    finally {activeWrites--;}
  };
  p.sendDistributedJob=async(...args)=>{if(args[1].index===0){slowSent=true;await slow;exited=true;}return receipt(...args);};
  let finished=false;const tick=p.tickDistributedQueueCore().then(()=>{finished=true;return null;},error=>{finished=true;return error;});
  try {
    for(let i=0;i<20&&!receiptWriteReached;i++)await new Promise(setImmediate);
    assert.equal(slowSent,true);assert.equal(receiptWriteReached,true);
    assert.equal(finished,false,'a failed local commit cannot release tick ownership while another RPC is still pending');
    assert.ok(stored().plans[0].jobs.every(job=>job.status==='dispatching'),'failed publication retains the last committed owners');
  } finally {release();}
  const error=await tick;assert.match(error.message,/disk write denied/);assert.equal(exited,true);assert.equal(maxWrites,1);
  assert.equal(p.distributedLaunchInFlight.size,0);
});
test('a late receipt after stop/generation change cannot save or publish the old run',async()=>{
  const {p,receipt,stored}=durableTickFixture();let release;const gate=new Promise(resolve=>{release=resolve;});let calls=0;let posts=0;
  p.postState=()=>posts++;
  p.sendDistributedJob=async(...args)=>{calls++;await gate;return receipt(...args);};
  const tick=p.tickDistributedQueueCore();
  try {
    for(let i=0;i<20&&calls<2;i++)await new Promise(setImmediate);
    assert.equal(calls,2);p.distributedQueueGeneration++;const before=JSON.stringify(stored());
    release();await tick;assert.equal(JSON.stringify(stored()),before);assert.equal(posts,0);
  } finally {release();await tick;}
});
test('G1 actual RPC envelope distinguishes local GPU admission from durable hosted prequeue', async () => {
  const Provider=provider(['buildDistributedJobCodeManifest','sendDistributedJob'], {vscode:{workspace:{getConfiguration:()=>({get:(_key,value)=>value})},Uri:{file:value=>value}},
    loadSyncHolds:async()=>[],buildLocalCodeManifest:async()=>({}),filterHeldFiles:manifest=>manifest,fingerprintFromManifest:()=> 'f'});
  const p=new Provider();p.distributedQueueGeneration=0;p.distributedPlanStopEpoch=0;
  p.context={globalStorageUri:{fsPath:'cache'}};p.localCodeManifestCacheFile=()=> 'cache';
  p.workerActionTargets=()=>[{id:'w',condaEnv:'env'}];p.enabledWorkerConfigs=()=>[{id:'w',gpuIdleUtilThreshold:0,maxConcurrentGpus:1}];
  p.schedulerSettings=()=>({gpuIdleUtilThreshold:5,gpuIdleMemThresholdMb:200,workerActionMinIntervalMs:500});
  p.withRemoteActionResource=async(_worker,_action,_request,callback)=>callback();let sent;
  p.client={postWorkerAction:async(_worker,_action,request)=>{sent=request;return {status:'queued'};}};
  const plan={id:'p',projectId:'project',planFile:'p.yaml',revision:'r',codeFingerprint:'f',enqueuedAt:'date',planJobCount:1,schedulingMode:'server_prequeue',executionMode:'train',resultPathPolicy:'declared'};
  const job={index:0,case:'bus',seed:42,attempt:0,outputDir:'runs/0',collectionResultCsv:'runs/0/metrics.csv',globalJobId:'p:0'};
  p.lastWorkerProbes={w:{capabilities:{endpoints:{declaredJobPaths:true,formalJobIdentityEnv:1,taskShellEnvironment:1,projectManagedValidation:1,gpuQuotaScheduling:1}}}};
  await p.sendDistributedJob(plan,job,'w',undefined,'same-command');
  assert.equal(sent.schedulingMode,'server_prequeue');assert.equal(sent.requireIdleGpu,false);assert.equal(Object.hasOwn(sent,'gpuId'),false);
  assert.equal(sent.lifecycleProtocol,2,'正式派发一律携带 lifecycle-2 协议标识');
  // 配额契约接管准入：旧的 maxConcurrentGpus 与利用率阈值不再下发，改为逐卡内存配额。
  assert.equal(sent.options.maxConcurrentGpus,0);assert.equal(sent.options.gpuIdleUtilThreshold,undefined);
  assert.equal(sent.options.gpuQuotaScheduling,1);assert.equal(sent.options.gpuJobsPerCard,1);assert.equal(sent.options.gpuMinFreeMemoryGb,22);
  assert.equal(sent.opId,'same-command');
  plan.schedulingMode='local_idle';await p.sendDistributedJob(plan,job,'w','0','new-command');
  assert.equal(sent.schedulingMode,'local_idle');assert.equal(sent.requireIdleGpu,true);assert.equal(sent.gpuId,'0');
});
const agentSource=fs.readFileSync(path.join(root,'src/clusterAgentRuntime.legacy.ts'),'utf8');
function definition(name){const start=agentSource.indexOf(`\ndef ${name}(`)+1;assert.ok(start>0,name);
  const end=agentSource.indexOf('\ndef ',start+1);return agentSource.slice(start,end<0?undefined:end);}
function python(script){const file=path.join(os.tmpdir(),`simpleex-lifecycle-${process.pid}-${Date.now()}.py`);fs.writeFileSync(file,script,'utf8');
  {const run=spawnSync(process.env.PYTHON||'python',['-X','utf8',file],{encoding:'utf8',timeout:10000,windowsHide:true});
    assert.equal(run.status,0,run.stderr||run.error?.message);return JSON.parse(run.stdout.trim());}}
test('G2 real Agent idle admission guard rejects a competing process and untrusted telemetry',()=>{
  const proc=spawnSync(process.env.PYTHON||'python',['-B','-X','utf8',path.join(__dirname,'macFormalIdentity.fixture.py'),'gpu-admission'],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(proc.status,0,proc.stderr||proc.error?.message);const result=JSON.parse(proc.stdout.trim());
  assert.deepEqual(result,['gpu_busy','gpu_busy'],'G2 admission must reject occupied or unknown GPU');
});
test('G3 actual task API syncs exit evidence into durable ledger immediately, with mode and terminal metadata',()=>{
  const fields=agentSource.match(/^DURABLE_PLAN_IDENTITY_FIELDS\s*=\s*\([\s\S]*?^\)/m)[0];
  const result=python(`import json, threading\nSCHEMA_VERSION=1\nWORKER_TASK_SNAPSHOT_LOCK=threading.RLock()\nINACTIVITY_ACTIONS_LOCK=threading.RLock()\nINACTIVITY_ACTIONS={}\nLIVE_CLEANUP_ACTIONS={}\n${fields}\ndef now_iso(): return '2026-09-29T00:00:00Z'\n${['durable_plan_value','durable_plan_identity','durable_plan_public_identity','durable_plan_same_identity','durable_plan_task_status','sync_durable_plan_task_rows','durable_plan_public_task','active_cleanup_operations','api_worker_tasks'].map(definition).join('\n')}\nROW={key:'x' for key in DURABLE_PLAN_IDENTITY_FIELDS}\nROW.update({'status':'running','planJobCount':1,'enqueuedAt':now_iso(),'schedulingMode':'server_prequeue','gpuId':''})\nTASK=dict(ROW)\nLEDGER={'jobs':[ROW]}\ndef path_for(*args): return ''\ndef read_json(*args): return {'tasks':[TASK]}\ndef read_durable_plan_queue(*args): return LEDGER\ndef write_durable_plan_queue(root,data): pass\ndef read_runtime_json_cached(*args): return None\ndef formal_job_path_capable(*args): return True\ndef reconcile_worker_task_exit_codes(root): TASK.update({'status':'completed','exitCode':0,'finishedAt':now_iso()})\nprint(json.dumps(api_worker_tasks('')['tasks'][0]))\n`);
  assert.equal(result.status,'completed','G3 exit evidence must supersede durable running during same API call');
  assert.equal(result.exitCode,0);assert.ok(result.finishedAt);assert.equal(result.schedulingMode,'server_prequeue');
});
test('G4 automatic postprocess schedules only Worker mirroring and package/lock/runtime versions match',async()=>{
  const Provider=provider(['scheduleDistributedPostprocess']);const p=new Provider();let calls=0;
  p.syncDistributedJobArtifacts=()=>calls++;p.rebuildDistributedResults=()=>calls++;
  p.isRealtimeMode=()=>true;p.projectTopologyAssessment=()=>({mode:'worker_pool'});
  p.captureProjectContext=()=>({root});p.projectContextIsCurrent=()=>true;
  let mirrors=0;p.syncCompletedPlanArtifacts=async()=>mirrors++;p.queuePlanArtifactSyncStatusCheck=()=>{};p.postState=()=>{};
  p.scheduleDistributedPostprocess(root,true);await p.distributedPostprocessPromise;
  assert.equal(mirrors,1);assert.equal(calls,0,'G4 no automatic raw result download or publication');
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  assert.match(version,/^\d+\.\d+\.\d+$/);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8')).version,version);
  assert.match(fs.readFileSync(path.join(root,'src/runtime/RuntimeManifest.ts'),'utf8'),new RegExp(`CURRENT_RUNTIME_VERSION = "${version.replaceAll('.','\\.')}"`));
});
