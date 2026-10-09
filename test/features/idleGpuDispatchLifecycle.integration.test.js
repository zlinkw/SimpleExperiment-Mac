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
require.extensions['.ts'] = original;
const source = fs.readFileSync(path.join(root,'src/extension/legacy.ts'),'utf8');
const proofHelperSource = source.match(/^function durableCodeProofRequestFields\([\s\S]*?^\}/m)?.[0];
assert.ok(proofHelperSource, 'missing production durable code proof request helper');
const durableCodeProofRequestFields = new Function(`${proofHelperSource}\nreturn durableCodeProofRequestFields;`)();
function provider(names, extra={}) {
  const ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);
  const cls=ast.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='RealtimeTunnelPanelProvider');
  const code='class Provider {'+cls.members.filter(node=>names.includes(node.name?.getText(ast))).map(node=>node.getText(ast)).join('\n')+'}; Provider;';
  return vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
    {DistributedPlanQueue,DistributedSchedulingPolicy,durableCodeProofRequestFields,workspaceRoot:()=>root,setInterval,clearInterval,
      mapLimited:async(rows,_limit,callback)=>Promise.all(rows.map(callback)),errorMessage:error=>error.message,...extra});
}
test('G1 actual host tick only dispatches idle NWPU3, persists identity before RPC, and explicitly hosts opt-in queue',async()=>{
  const Provider=provider(['tickDistributedQueueCore']);const p=new Provider();
  p.distributedQueueGeneration=0;p.distributedPlanStopEpoch=0;p.distributedNextFailureDetailAt=Infinity;
  p.distributedNextPostprocessAt=Infinity;p.distributedLaunchInFlight=new Set();
  p.isRealtimeMode=()=>true;p.projectTopologyAssessment=()=>({mode:'worker_pool'});
  p.workerCodeSyncTargets=()=>[];p.workerActionTargets=()=>[{id:'nwpu3'},{id:'nwpu5'}];
  p.lastWorkerProbes={nwpu3:{status:'ok'},nwpu5:{status:'ok'}};
  p.lastCodeSyncState={workerVersions:{nwpu3:{fingerprint:'f'},nwpu5:{fingerprint:'f'}}};
  p.enabledWorkerConfigs=()=>[{id:'nwpu3',workerUser:'alice'},{id:'nwpu5',workerUser:'alice'}];
  p.schedulerSettings=()=>({gpuIdleUtilThreshold:5,gpuIdleMemThresholdMb:200});p.gpuOwnerConfig=()=>({currentUser:'alice'});
  p.recordActionError=()=>{};p.postState=()=>{};p.scheduleDistributedPostprocess=()=>{};p.queuePlanArtifactSyncStatusCheck=()=>{};
  let manifestBuilds=0;p.buildDistributedJobCodeManifest=async()=>{manifestBuilds++;return {};};
  p.readWorkerTaskSnapshot=async workerId=>({workerId,generatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),
    capabilities:{durablePlanQueue:true,idleGpuAdmission:true,schemaVersion:1},tasks:[]});
  let releaseSnapshots;const snapshotGate=new Promise(resolve=>{releaseSnapshots=resolve;});let gpuReadStarted=false;
  p.readWorkerTaskSnapshotBatch=async workerIds=>{await snapshotGate;return Promise.all(workerIds.map(p.readWorkerTaskSnapshot));};
  p.client={getGpu:async()=>{gpuReadStarted=true;return {nwpu3:[{index:'0',utilizationPercent:0,memoryUsedMb:7,processes:[]}],
    nwpu5:[{index:'0',utilizationPercent:99,memoryUsedMb:5000,processes:[{username:'alice'}]}]};}};
  let stored;let calls=[];
  p.loadDistributedQueue=async()=>JSON.parse(JSON.stringify(stored));
  p.saveDistributedQueue=async(_root,value)=>{stored=JSON.parse(JSON.stringify(value));};
  p.sendDistributedJob=async(plan,job,workerId,gpuId,commandId)=>{
    assert.equal(stored.plans[0].jobs.find(row=>row.index===job.index).commandId,commandId,'identity must precede remote write');
    calls.push({workerId,gpuId,commandId});
    return {projectId:plan.projectId,workflowId:plan.id,planRevision:plan.revision,codeFingerprint:plan.codeFingerprint,
      planJobCount:plan.planJobCount,planFile:plan.planFile,experimentIndex:job.index,case:job.case,seed:job.seed,attempt:job.attempt,
      outputDir:job.outputDir,runKey:commandId,commandId,workerId,gpuId:gpuId??'',status:gpuId===undefined?'queued':'running',durableAccepted:true};
  };
  const make=mode=>DistributedPlanQueue.enqueuePlan(DistributedPlanQueue.emptyDistributedQueue(),{
    projectId:DistributedPlanQueue.canonicalProjectId(root),schedulingMode:mode,planFile:'p.yaml',revision:'r',codeFingerprint:'f',
    jobs:[0,1].map(index=>({index,case:'bus',seed:index,outputDir:`runs/${index}`}))},'p');
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
  const dispatching = p.tickDistributedQueueCore();
  try {
    for (let attempt = 0; attempt < 10 && calls.length < 2; attempt++) await new Promise(setImmediate);
    assert.equal(calls.length, 2, 'a slow first receipt must not block the second dispatch');
    for (let attempt = 0; attempt < 10 && stored.plans[0].jobs[1].status !== 'queued'; attempt++) await new Promise(setImmediate);
    assert.equal(stored.plans[0].jobs[1].status, 'queued', 'a fast receipt must be persisted while another Worker is still responding');
    assert.equal(stored.plans[0].jobs[0].status, 'dispatching', 'the delayed request remains owned and cannot be falsely acknowledged');
    assert.ok(p.distributedLaunchInFlight.has('p\u00000\u00001'),'safe retry must still see the delayed launch as in flight');
    assert.ok(p.localOperations.submit.timings.clickToFirstAcceptedJobMs>=100,'first acceptance is timed before the slow receipt returns');
    assert.equal(timingEvents.includes('dispatchMs'),false,'batch completion has not yet happened');
  } finally { releaseFirst(); }
  await dispatching;
  assert.equal(calls.length,2);assert.deepEqual(calls.map(row=>row.workerId).sort(),['nwpu3','nwpu5']);
  assert.equal(manifestBuilds,2,'the second Plan tick also builds only one shared manifest');
  assert.ok(calls.every(row=>row.gpuId===undefined));assert.ok(stored.plans[0].jobs.every(row=>row.status==='queued'));
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
  p.workerActionTargets=()=>[{id:'a'},{id:'b'}];p.lastWorkerProbes={a:{status:'ok'},b:{status:'ok'}};
  p.lastCodeSyncState={workerVersions:{a:{fingerprint:'f'},b:{fingerprint:'f'}}};
  p.enabledWorkerConfigs=()=>[{id:'a'},{id:'b'}];p.schedulerSettings=()=>({});p.gpuOwnerConfig=()=>({});
  p.recordActionError=()=>{};p.postState=()=>{};p.scheduleDistributedPostprocess=()=>{};p.queuePlanArtifactSyncStatusCheck=()=>{};
  p.buildDistributedJobCodeManifest=async()=>({});
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>({workerId,generatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),
    capabilities:{durablePlanQueue:true,idleGpuAdmission:true,schemaVersion:1},tasks:[]}));
  p.client={getGpu:async()=>({a:[{index:'0',utilizationPercent:0,memoryUsedMb:7,processes:[]}],
    b:[{index:'0',utilizationPercent:0,memoryUsedMb:7,processes:[]}]})};
  let stored=DistributedPlanQueue.enqueuePlan(DistributedPlanQueue.emptyDistributedQueue(),{
    projectId:DistributedPlanQueue.canonicalProjectId(root),schedulingMode:'server_prequeue',planFile:'p.yaml',revision:'r',codeFingerprint:'f',
    jobs:[0,1].map(index=>({index,case:'bus',seed:index,outputDir:`runs/${index}`}))},'p');
  p.loadDistributedQueue=async()=>JSON.parse(JSON.stringify(stored));
  p.saveDistributedQueue=async(_root,value)=>{stored=JSON.parse(JSON.stringify(value));};
  const receipt=(plan,job,workerId,_gpuId,commandId)=>({projectId:plan.projectId,workflowId:plan.id,planRevision:plan.revision,
    codeFingerprint:plan.codeFingerprint,planJobCount:plan.planJobCount,planFile:plan.planFile,experimentIndex:job.index,case:job.case,
    seed:job.seed,attempt:job.attempt,outputDir:job.outputDir,runKey:commandId,commandId,workerId,gpuId:'',status:'queued',durableAccepted:true});
  return {p,receipt,stored:()=>stored};
}

function queuedMigrationFixture() {
  const fixture = durableTickFixture(), {p, receipt, stored} = fixture;
  const plan = stored().plans[0]; plan.schedulingMode = 'local_idle';
  plan.jobs.forEach((job, index) => Object.assign(job, { status: index ? 'queued' : 'completed', workerId: 'a',
    gpuId: index ? '0' : '1', commandId: `original-${index}`, runKey: `original-${index}`,
    outputDir: `work/job${index}/attempts/original-run`, ...(index ? {} : { finishedAt: new Date().toISOString() }) }));
  plan.jobs[1].automaticRetry = {failureCount:1,failedAttempt:0,lastError:'CUDA failure'};
  p.readWorkerTaskSnapshotBatch = async ids => ids.map(workerId => ({workerId, generatedAt:new Date().toISOString(),
    fetchedAt:new Date().toISOString(),capabilities:{durablePlanQueue:true,idleGpuAdmission:true,schemaVersion:1},
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
  assert.equal(stored().plans[0].jobs[1].attempt,1);
  assert.equal(stored().plans[0].jobs[1].commandId,before);
});

test('a verified busy owner GPU migrates once to the selected destination instead of the original Worker',async()=>{
  const {p,stored,cancelled,sent}=queuedMigrationFixture();
  p.client.getGpu=async()=>({a:[{index:'0',utilizationPercent:99,memoryUsedMb:23000,processes:[]},
    {index:'1',utilizationPercent:0,memoryUsedMb:7,processes:[]}],
    b:[{index:'0',utilizationPercent:0,memoryUsedMb:7,processes:[]}]});
  await p.tickDistributedQueueCore();
  assert.deepEqual(sent.map(row=>row.workerId),['b'],'release destination must survive normal case/seed affinity allocation');
  for(let tick=0;tick<4;tick++)await p.tickDistributedQueueCore();
  assert.equal(cancelled.length,1);assert.equal(sent.length,1);
  assert.equal(stored().plans[0].jobs[1].workerId,'b');
  assert.equal(stored().plans[0].jobs[1].attempt,2);
  assert.equal(stored().plans[0].jobs[1].automaticRetry.failureCount,1);
});

test('unknown or missing owner GPU telemetry cannot trigger a queued-task release',async()=>{
  for(const row of [{index:'0'}, {index:'1',utilizationPercent:0,memoryUsedMb:7,processes:[]}]) {
    const {p,cancelled,sent}=queuedMigrationFixture();
    p.client.getGpu=async()=>({a:[row],b:[{index:'0',utilizationPercent:0,memoryUsedMb:7,processes:[]}]});
    await p.tickDistributedQueueCore();assert.equal(cancelled.length,0);assert.equal(sent.length,0);
  }
});

test('a release racing a Worker start retains the original command without dispatching another attempt',async()=>{
  const {p,stored,sent}=queuedMigrationFixture();
  p.client.getGpu=async()=>({a:[{index:'0',utilizationPercent:99,memoryUsedMb:23000,processes:[]}],
    b:[{index:'0',utilizationPercent:0,memoryUsedMb:7,processes:[]}]});
  p.client.postWorkerAction=async(_id,_action,request)=>({...request,commandId:request.targetCommandId,status:'running',durableReleased:false});
  await p.tickDistributedQueueCore();
  const job=stored().plans[0].jobs[1];
  assert.equal(job.status,'running');assert.equal(job.commandId,'original-1');assert.equal(job.attempt,1);
  assert.equal(job.reassignmentWorkerId,undefined);assert.equal(sent.length,0);
});

test('unconfirmed command reconciliation keeps unknown stable and backs off repeated RPCs',async()=>{
  const {p,stored}=durableTickFixture();
  const plan=stored().plans[0];plan.schedulingMode='local_idle';
  Object.assign(plan.jobs[0],{status:'completed',workerId:'a',gpuId:'1',commandId:'completed-command'});
  Object.assign(plan.jobs[1],{status:'unknown',workerId:'a',gpuId:'0',commandId:'unconfirmed-command',
    outputDir:'work/job1/attempts/original-run'});
  let calls=0;const statuses=[];
  const save=p.saveDistributedQueue;p.saveDistributedQueue=async (...args)=>{statuses.push(args[1].plans[0].jobs[1].status);await save(...args);};
  p.sendDistributedJob=async()=>{calls++;throw new Error('receipt not yet available');};
  for(let tick=0;tick<4;tick++)await p.tickDistributedQueueCore();
  assert.equal(calls,1,'same command recovery must not hammer the Worker every tick');
  assert.equal(statuses.includes('dispatching'),false,'unverified ownership stays unknown while reconciliation is attempted');
  assert.equal(stored().plans[0].jobs[1].commandId,'unconfirmed-command');
  assert.equal(stored().plans[0].jobs[1].attempt,1);
});

test('task snapshot grace uses only a recently verified cache while a slow fresh request continues',async()=>{
  const Provider=provider(['readWorkerTaskSnapshotBatch'],{setTimeout,clearTimeout});const p=new Provider();
  let release;const slow=new Promise(resolve=>{release=resolve;});p.readWorkerTaskSnapshot=()=>slow;
  const cache={workerId:'a',generatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),
    capabilities:{durablePlanQueue:true,schemaVersion:1},tasks:[{commandId:'verified-command'}]};
  p.cachedWorkerTaskSnapshot=()=>cache;
  try {
    const result=await p.readWorkerTaskSnapshotBatch(['a'],{graceMs:0});
    assert.equal(result[0].error,undefined,'normal polling latency must not erase a recent authoritative snapshot');
    assert.equal(result[0].tasks[0].commandId,'verified-command');
    assert.equal(result[0].fetchedAt,cache.fetchedAt,'cache age must not be fabricated as a fresh read');
    cache.fetchedAt=cache.generatedAt=new Date(Date.now()-6000).toISOString();
    const expired=await p.readWorkerTaskSnapshotBatch(['a'],{graceMs:0});
    assert.equal(expired[0].pending,true);assert.equal(expired[0].tasks.length,0);
    assert.ok(expired[0].error,'expired ownership must remain unverified');
    cache.fetchedAt=cache.generatedAt=new Date().toISOString();cache.error='disconnected';
    const failed=await p.readWorkerTaskSnapshotBatch(['a'],{graceMs:0});
    assert.ok(failed[0].error);assert.equal(failed[0].tasks.length,0);
  } finally {release(cache);}
});

test('actual Host tick adopts an existing partial failure, persists backoff and dispatches only the due failed job', async () => {
  const {p, receipt, stored} = durableTickFixture();
  const queue = stored(), plan = queue.plans[0];
  delete plan.automaticRetry;
  plan.jobs.forEach((job, index) => Object.assign(job, { status: index === 0 ? 'completed' : 'failed', workerId: 'a',
    commandId: `old-command-${index}`, runKey: `old-command-${index}`,
    outputDir: `work/job${index}/attempts/old-attempt`, finishedAt: new Date().toISOString(),
    ...(index === 1 ? { error: 'RuntimeError: CUDA error: CUBLAS_STATUS_NOT_INITIALIZED' } : {}) }));
  p.resolveSelectedPlanFile = () => 'p.yaml';
  const tasks = plan.jobs.map(job => ({...receipt(plan, job, 'a', undefined, job.commandId),
    enqueuedAt: plan.enqueuedAt, status: job.status, finishedAt: job.finishedAt, error: job.error}));
  p.readWorkerTaskSnapshotBatch = async ids => ids.map(workerId => ({workerId, generatedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(), capabilities:{durablePlanQueue:true,idleGpuAdmission:true,schemaVersion:1},
    tasks: workerId === 'a' ? tasks : []}));
  const sent=[];
  p.sendDistributedJob=async(...args)=>{sent.push(args[1].index);return receipt(...args);};
  p.localPlanMetadata = { plans: [], archivedPlans: [{ originalFile: 'p.yaml', planFile: '_archived/p.yaml' }] };
  await p.tickDistributedQueueCore();
  assert.equal(stored().plans[0].jobs[1].automaticRetry, undefined, 'archived original Plan is not revived');
  p.localPlanMetadata.plans = [{ planFile: 'p.yaml' }];
  await p.tickDistributedQueueCore();
  assert.equal(stored().plans[0].jobs[1].status, 'failed');
  assert.equal(stored().plans[0].jobs[1].automaticRetry.failureCount, 1);
  assert.equal(sent.length, 0, 'no launch during backoff');
  stored().plans[0].jobs[1].automaticRetry.retryAt = new Date(Date.now() - 1).toISOString();
  await p.tickDistributedQueueCore();
  assert.deepEqual(sent, [1]);
  assert.equal(stored().plans[0].jobs[0].status, 'completed');
  assert.equal(stored().plans[0].jobs[1].status, 'queued');
  assert.equal(stored().plans[0].jobs[1].attempt, 2);
  assert.equal(stored().plans[0].jobs[1].history[0].error, 'RuntimeError: CUDA error: CUBLAS_STATUS_NOT_INITIALIZED');
  assert.equal(stored().plans[0].jobs[1].automaticRetry.failureCount, 1);
  assert.notEqual(stored().plans[0].jobs[1].commandId, 'old-command-1');
});

test('actual Host resource retry waits for matching Worker code and fresh idle GPU admission without counting waits as failures', async () => {
  const {p, receipt, stored} = durableTickFixture();
  const plan = stored().plans[0];
  plan.schedulingMode = 'local_idle';
  plan.jobs.forEach((job,index) => Object.assign(job, {status:index ? 'failed':'completed', workerId:'a',gpuId:String(index),
    commandId:`old-${index}`,runKey:`old-${index}`,outputDir:`work/job${index}/attempts/old-attempt`,finishedAt:new Date().toISOString(),
    ...(index ? {error:'torch.OutOfMemoryError: CUDA out of memory'} : {})}));
  const tasks = plan.jobs.map(job => ({...receipt(plan,job,'a',undefined,job.commandId),gpuId:job.gpuId,
    enqueuedAt:plan.enqueuedAt,status:job.status,finishedAt:job.finishedAt,error:job.error}));
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>({workerId,generatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),
    capabilities:{durablePlanQueue:true,idleGpuAdmission:true,schemaVersion:1},tasks:workerId==='a'?tasks:[]}));
  const sent=[];p.sendDistributedJob=async(...args)=>{sent.push(args[1].index);return {...receipt(...args),gpuId:args[3]};};
  await p.tickDistributedQueueCore();
  assert.equal(stored().plans[0].jobs[1].automaticRetry.failureClass,'resource');
  stored().plans[0].jobs[1].automaticRetry.retryAt=new Date(Date.now()-1).toISOString();
  p.lastCodeSyncState.workerVersions={a:{fingerprint:'different-code'},b:{fingerprint:'different-code'}};
  await p.tickDistributedQueueCore();
  assert.equal(stored().plans[0].jobs[1].status,'pending');assert.equal(sent.length,0);
  p.lastCodeSyncState.workerVersions={a:{fingerprint:'f'},b:{fingerprint:'f'}};
  p.client.getGpu=async()=>({a:[{index:'0',utilizationPercent:99,memoryUsedMb:23000,processes:[]}],
    b:[{index:'0',utilizationPercent:99,memoryUsedMb:23000,processes:[]}]});
  await p.tickDistributedQueueCore();assert.equal(sent.length,0);
  await p.tickDistributedQueueCore();assert.equal(sent.length,0);
  assert.equal(stored().plans[0].jobs[1].automaticRetry.failureCount,1);
  assert.equal(stored().plans[0].jobs[1].attempt,2);
  p.client.getGpu=async()=>({a:[{index:'0',utilizationPercent:0,memoryUsedMb:7,processes:[]}],
    b:[{index:'0',utilizationPercent:0,memoryUsedMb:7,processes:[]}]});
  await p.tickDistributedQueueCore();assert.deepEqual(sent,[1]);
});

test('actual Host tick never dispatches retries after startup majority fails with a project AttributeError', async () => {
  const {p,receipt,stored}=durableTickFixture();
  const plan=stored().plans[0];
  plan.jobs.forEach((job,index)=>Object.assign(job,{status:'running',workerId:'a',commandId:`startup-${index}`,runKey:`startup-${index}`}));
  const tasks=plan.jobs.map(job=>({...receipt(plan,job,'a',undefined,job.commandId),enqueuedAt:plan.enqueuedAt,status:'running'}));
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>({workerId,generatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),
    capabilities:{durablePlanQueue:true,idleGpuAdmission:true,schemaVersion:1},tasks:workerId==='a'?tasks:[]}));
  const sent=[];p.sendDistributedJob=async(...args)=>{sent.push(args[1].index);return receipt(...args);};
  await p.tickDistributedQueueCore();
  assert.equal(stored().plans[0].automaticRetry.healthyReason,'majority_running');
  tasks.forEach(task=>Object.assign(task,{status:'failed',finishedAt:new Date().toISOString(),error:'AttributeError: encoder has no attribute encode_token_features'}));
  for(let tick=0;tick<4;tick++)await p.tickDistributedQueueCore();
  assert.equal(sent.length,0);
  for(const job of stored().plans[0].jobs){assert.equal(job.status,'failed');assert.equal(job.attempt,1);
    assert.equal(job.automaticRetry.failureClass,'deterministic');assert.equal(job.automaticRetry.retryAt,undefined);assert.ok(job.automaticRetry.blockedReason);}
});

test('actual Host blocks an unsafe unsubmitted retry retained by the previous plugin version', async () => {
  const {p,receipt,stored}=durableTickFixture(); const plan=stored().plans[0];
  Object.assign(plan.jobs[0],{status:'completed',workerId:'a',commandId:'success',runKey:'success',finishedAt:new Date().toISOString()});
  Object.assign(plan.jobs[1],{status:'pending',attempt:2,outputDir:'work/job1/attempts/auto-retry-old',
    automaticRetry:{failureCount:1,failedAttempt:1,lastError:'AttributeError: missing method'},
    history:[{status:'failed',attempt:1,outputDir:'work/job1/attempts/old',workerId:'a',commandId:'old-failure',error:'AttributeError: missing method'}]});
  const tasks=[{...receipt(plan,plan.jobs[0],'a',undefined,'success'),enqueuedAt:plan.enqueuedAt,status:'completed',finishedAt:plan.jobs[0].finishedAt}];
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>({workerId,generatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),
    capabilities:{durablePlanQueue:true,idleGpuAdmission:true,schemaVersion:1},tasks:workerId==='a'?tasks:[]}));
  const sent=[];p.sendDistributedJob=async(...args)=>{sent.push(args[1].index);return receipt(...args);};
  for(let tick=0;tick<3;tick++)await p.tickDistributedQueueCore();
  assert.equal(sent.length,0);assert.equal(stored().plans[0].jobs[1].status,'failed');
  assert.equal(stored().plans[0].jobs[1].attempt,2);assert.equal(stored().plans[0].jobs[1].history.length,1);
  assert.match(stored().plans[0].jobs[1].automaticRetry.blockedReason,/尚未派发/);
});

test('actual Host tick dispatches two code versions to independent verified Workers in one tick',async()=>{
  const {p,receipt,stored}=durableTickFixture();
  p.lastCodeSyncState.workerVersions.b.fingerprint='g';
  await p.saveDistributedQueue(root,DistributedPlanQueue.enqueuePlan(stored(),{
    projectId:DistributedPlanQueue.canonicalProjectId(root),schedulingMode:'server_prequeue',planFile:'next.yaml',revision:'r2',codeFingerprint:'g',
    jobs:[0,1].map(index=>({index,case:'pad',seed:index,outputDir:`next/${index}`}))},'next'));
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
  const terminal={...receipt(plan,job,'a',undefined,job.commandId),enqueuedAt:plan.enqueuedAt,status:'completed',finishedAt:new Date().toISOString()};
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>({workerId,generatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),
    capabilities:{durablePlanQueue:true,idleGpuAdmission:true,schemaVersion:1},tasks:workerId==='a'?[terminal]:[]}));
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
  const plan={id:'p',projectId:'project',planFile:'p.yaml',revision:'r',codeFingerprint:'f',enqueuedAt:'date',planJobCount:1,schedulingMode:'server_prequeue'};
  const job={index:0,case:'bus',seed:42,attempt:1,outputDir:'runs/0'};
  await p.sendDistributedJob(plan,job,'w',undefined,'same-command');
  assert.equal(sent.schedulingMode,'server_prequeue');assert.equal(sent.requireIdleGpu,false);assert.equal(Object.hasOwn(sent,'gpuId'),false);
  assert.equal(sent.options.maxConcurrentGpus,1);assert.equal(sent.options.gpuIdleUtilThreshold,0);assert.equal(sent.opId,'same-command');
  plan.schedulingMode='local_idle';await p.sendDistributedJob(plan,job,'w','0','new-command');
  assert.equal(sent.schedulingMode,'local_idle');assert.equal(sent.requireIdleGpu,true);assert.equal(sent.gpuId,'0');
});
const agentSource=fs.readFileSync(path.join(root,'src/clusterAgentRuntime.legacy.ts'),'utf8');
function definition(name){const start=agentSource.indexOf(`\ndef ${name}(`)+1;assert.ok(start>0,name);
  const end=agentSource.indexOf('\ndef ',start+1);return agentSource.slice(start,end<0?undefined:end);}
function python(script){const file=path.join(os.tmpdir(),`simpleex-lifecycle-${process.pid}-${Date.now()}.py`);fs.writeFileSync(file,script,'utf8');
  try {const run=spawnSync(process.env.PYTHON||'python',['-X','utf8',file],{encoding:'utf8',timeout:10000,windowsHide:true});
    assert.equal(run.status,0,run.stderr||run.error?.message);return JSON.parse(run.stdout.trim());}
  finally {fs.unlinkSync(file);}}
test('G2 real Agent idle admission guard rejects a competing process and untrusted telemetry',()=>{
  const result=python(`import json, math\nGPU_IDLE_UTIL_THRESHOLD=5\nGPU_IDLE_MEM_THRESHOLD_MB=200\nDISTRIBUTED_GPU_RESERVATIONS={}\ndef read_json(*args): return {}\ndef path_for(*args): return ''\ndef read_durable_plan_queue(*args): return {'jobs':[]}\ndef gpu_row_id(row): return str(row['gpuId'])\ndef gpu_row_busy(*args,**kwargs): return False\n${definition('_durable_gpu_busy_reason')}\nrow={'gpuId':'0','utilizationPercent':0,'memoryUsedMb':7,'processes':[{'pid':7}]}\nprint(json.dumps([_durable_gpu_busy_reason('', '0', 'c', [row]),_durable_gpu_busy_reason('', '0', 'c', [{'gpuId':'0'}])]))\n`);
  assert.deepEqual(result,['gpu_busy','gpu_busy'],'G2 admission must reject occupied or unknown GPU');
});
test('G3 actual task API syncs exit evidence into durable ledger immediately, with mode and terminal metadata',()=>{
  const fields=agentSource.match(/^DURABLE_PLAN_IDENTITY_FIELDS\s*=\s*\([\s\S]*?^\)/m)[0];
  const result=python(`import json, threading\nSCHEMA_VERSION=1\nWORKER_TASK_SNAPSHOT_LOCK=threading.RLock()\n${fields}\ndef now_iso(): return '2026-09-29T00:00:00Z'\n${['durable_plan_value','durable_plan_identity','durable_plan_same_identity','durable_plan_task_status','sync_durable_plan_task_rows','durable_plan_public_task','api_worker_tasks'].map(definition).join('\n')}\nROW={key:'x' for key in DURABLE_PLAN_IDENTITY_FIELDS}\nROW.update({'status':'running','planJobCount':1,'enqueuedAt':now_iso(),'schedulingMode':'server_prequeue','gpuId':''})\nTASK=dict(ROW)\nLEDGER={'jobs':[ROW]}\ndef path_for(*args): return ''\ndef read_json(*args): return {'tasks':[TASK]}\ndef read_durable_plan_queue(*args): return LEDGER\ndef write_durable_plan_queue(root,data): pass\ndef read_runtime_json_cached(*args): return None\ndef reconcile_worker_task_exit_codes(root): TASK.update({'status':'completed','exitCode':0,'finishedAt':now_iso()})\nprint(json.dumps(api_worker_tasks('')['tasks'][0]))\n`);
  assert.equal(result.status,'completed','G3 exit evidence must supersede durable running during same API call');
  assert.equal(result.exitCode,0);assert.ok(result.finishedAt);assert.equal(result.schedulingMode,'server_prequeue');
});
test('G4 automatic postprocess stays inert and package/lock/runtime versions match',()=>{
  const Provider=provider(['scheduleDistributedPostprocess']);const p=new Provider();let calls=0;
  p.syncDistributedJobArtifacts=()=>calls++;p.rebuildDistributedResults=()=>calls++;
  p.scheduleDistributedPostprocess(root,true);assert.equal(calls,0,'G4 no automatic result transfer');
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  assert.match(version,/^\d+\.\d+\.\d+$/);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8')).version,version);
  assert.match(fs.readFileSync(path.join(root,'src/runtime/RuntimeManifest.ts'),'utf8'),new RegExp(`CURRENT_RUNTIME_VERSION = "${version.replaceAll('.','\\.')}"`));
});
