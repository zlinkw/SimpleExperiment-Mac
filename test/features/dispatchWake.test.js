const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
require('../_helpers/registerTsRequire');
const Q=require('../../src/features/DistributedPlanQueue.ts'),{ownExecutionExited}=require('../../src/features/DispatchWake.ts');
const source=fs.readFileSync('src/extension/legacy.ts','utf8'),ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true);
function hostMethods(names,globals={}){let cls;function visit(n){if(ts.isClassDeclaration(n)&&n.name?.text==='RealtimeTunnelPanelProvider')cls=n;ts.forEachChild(n,visit)}visit(ast);
 const members=cls.members.filter(n=>names.includes(n.name?.getText(ast)));assert.equal(members.length,names.length);
 return vm.runInNewContext(ts.transpileModule('class Host{'+members.map(n=>n.getText(ast)).join('\n')+'};Host',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
 {AbortController,workspaceRoot:()=> 'project',require:()=>({getUpdater:()=>undefined}),errorMessage:e=>e.message,...globals});}
function fixture(){const project=Q.canonicalProjectId('project'),queue={schemaVersion:1,plans:[{id:'p',projectId:project,jobs:[
 {index:0,lifecycleProtocol:2,status:'running',executionState:'running',workerId:'w',gpuId:'0',commandId:'c'},{index:1,status:'pending'}]}]};
 const snapshot={workerId:'w',queryComplete:true,fetchedAt:new Date().toISOString(),capabilities:{schemaVersion:1,durablePlanQueue:true,taskLifecycle:2},tasks:[{commandId:'c',projectId:project,
 observation:{lifecycleProtocol:2,commandId:'c',workerId:'w',projectId:project,tmux:{windowId:'@1',paneId:'%1',dead:true,exitCode:0},resultQueryError:'still checking outputs'}}]};return {project,queue,snapshot};}
test('own window exit wakes immediately while artifacts remain unverified; other tasks and failures cannot wake it',()=>{
 const {project,queue,snapshot}=fixture();assert.equal(ownExecutionExited(undefined,snapshot,queue,project),true);
 assert.equal(ownExecutionExited(snapshot,snapshot,queue,project),false,'one exit is not a permanent polling loop');
 const before=structuredClone(snapshot);before.tasks[0].observation.tmux.dead=false;assert.equal(ownExecutionExited(before,snapshot,queue,project),true);
 for(const change of [s=>s.error='offline',s=>s.queryComplete=false,s=>s.tasks[0].observation.executionQueryError='unknown',s=>s.tasks[0].observation.projectId='foreign',s=>s.tasks[0].observation.commandId='foreign']){
  const copy=structuredClone(snapshot);change(copy);assert.equal(ownExecutionExited(undefined,copy,queue,project),false);}
 queue.plans[0].jobs[1].workerId='w';assert.equal(ownExecutionExited(undefined,snapshot,queue,project),false);
});
test('an exit observed during an in-flight tick schedules exactly one immediate follow-up without overlap',async()=>{
 const Host=hostMethods(['requestDistributedQueueRefresh','tickDistributedQueue']),h=new Host();
 Object.assign(h,{manualDispatchInFlight:new Set(),planCleanupHosts:new Map(),distributedPlanStopEpoch:0,distributedQueueGeneration:0,recordActionError(){}});
 let calls=0,active=0,max=0,release;const gate=new Promise(resolve=>release=resolve);
 h.tickDistributedQueueCore=async()=>{calls++;max=Math.max(max,++active);if(calls===1)await gate;active--;};
 const first=h.tickDistributedQueue();await new Promise(setImmediate);h.requestDistributedQueueRefresh();h.requestDistributedQueueRefresh();
 assert.equal(calls,1);release();await first;await new Promise(setImmediate);assert.equal(calls,2);assert.equal(max,1);
 h.distributedPlanStopEpoch=1;h.requestDistributedQueueRefresh();await new Promise(setImmediate);assert.equal(calls,2,'stop intent always wins');
});
test('the active-query publication wakes scheduling without depending on push or artifact completion',()=>{
 const Host=hostMethods(['storeWorkerTaskSnapshot'],{ownExecutionExited,DistributedPlanQueue:Q}),h=new Host(),f=fixture();let wakes=0;
 Object.assign(h,{lastWorkerTaskSnapshots:new Map(),workerTaskSnapshotDiskCache:new Map(),distributedQueueRoot:'project',distributedQueueCache:f.queue,
 noteWorkerTaskPlanStatus(){},requestDistributedQueueRefresh(){wakes++},queueWorkerTaskSnapshotPersistence(){}});
 h.storeWorkerTaskSnapshot('project\0w',f.snapshot);assert.equal(wakes,1);
 h.storeWorkerTaskSnapshot('project\0w',f.snapshot);assert.equal(wakes,1);
});
test('actual native tick fills every newly free quota slot from current execution reads while artifact queries remain slow',async()=>{
 const Host=hostMethods(['tickDistributedQueueCore'],{setInterval,clearInterval,DistributedPlanQueue:Q,
  DistributedSchedulingPolicy:require('../../src/features/DistributedSchedulingPolicy.ts'),GpuQuotaScheduling:require('../../src/features/GpuQuotaScheduling.ts'),GpuMemoryBudget:require('../../src/features/GpuMemoryBudget.ts'),
  GpuJobOwnership:require('../../src/features/GpuJobOwnership.ts'),PlanCodeScopeHost:{supportsPlanCodeScope:()=>false,inspectPlanCodeSlots:async()=>{}}});
 const h=new Host(),project=Q.canonicalProjectId('project'),sent=[];
 let stored=Q.enqueuePlan(Q.emptyDistributedQueue(),{projectId:project,executionMode:'train_test',schedulingMode:'server_prequeue',planFile:'p.yaml',revision:'r',codeFingerprint:'code',
  jobs:Array.from({length:15},(_,index)=>({index,case:'a',seed:index,outputDir:'work/'+index}))},'p');
 Object.assign(stored.plans[0].jobs[0],{lifecycleProtocol:2,status:'running',executionState:'running',workerId:'w',gpuId:'0',commandId:'original'});
 let exited=false;
 Object.assign(h,{taskLifecycleProtocol:2,distributedQueueGeneration:0,distributedPlanStopEpoch:0,distributedNextFailureDetailAt:Infinity,distributedNextPostprocessAt:Infinity,
  distributedLaunchInFlight:new Set(),isRealtimeMode:()=>true,workerCodeSyncTargets:()=>[],workerActionTargets:()=>[{id:'w',project_dir:'/project'}],
  lastWorkerProbes:{w:{status:'ok',capabilities:{endpoints:{declaredJobPaths:true,formalJobIdentityEnv:1,taskShellEnvironment:1,gpuMemoryBudgetScheduling:1}}}},lastCodeSyncState:{workerVersions:{w:{fingerprint:'code'}}},
  enabledWorkerConfigs:()=>[{id:'w',gpuQuotaConfigured:true,gpuJobsPerCard:1,gpuCardOverrides:{'1':{gpuJobsPerCard:6}}}],schedulerSettings:()=>({}),
  recordActionError(){},postState(){},queuePlanArtifactSyncStatusCheck(){},scheduleDistributedPostprocess(){},buildDistributedJobCodeManifest:async()=>({}),
  loadDistributedQueue:async()=>structuredClone(stored),saveDistributedQueue:async(_root,q)=>{stored=structuredClone(q)},
  readWorkerTaskSnapshotBatch:async(ids,options)=>{assert.equal(options.executionOnly,true,'dispatch must not await full artifact/log reads');return [{workerId:'w',fetchedAt:new Date().toISOString(),generatedAt:new Date().toISOString(),queryComplete:true,
   capabilities:{schemaVersion:1,durablePlanQueue:true,taskLifecycle:2,idleGpuAdmission:true},executionOnly:true,tasks:[{commandId:'original',projectId:project,workerId:'w',gpuId:'0',
    observation:{lifecycleProtocol:2,commandId:'original',workerId:'w',projectId:project,observedAt:new Date().toISOString(),tmux:{windowId:'@1',paneId:'%1',dead:exited,exitCode:exited?0:null,phase:'running'}}}]}]},
  client:{getGpu:async()=>({w:[0,1].map(index=>({index,memoryTotalMb:100*1024,memoryUsedMb:exited?0:99*1024}))})},
  sendDistributedJob:async(plan,job,workerId,gpuId,commandId)=>{assert.equal(stored.plans[0].jobs[job.index].commandId,commandId);sent.push({index:job.index,gpuId});return {lifecycleProtocol:2}}});
 await h.tickDistributedQueueCore();assert.equal(sent.length,0);
 const budget=require('../../src/features/GpuMemoryBudget.ts'),p=stored.plans[0],j=p.jobs[0];
 j.gpuMemoryProfile={version:1,commandId:'original',projectId:project,group:budget.budgetGroup(p,j),hardware:budget.budgetHardware('w',{memoryTotalMb:100*1024,memoryUsedMb:0}),peakMb:1024,ready:true,oom:false};
 exited=true;await h.tickDistributedQueueCore();assert.equal(sent.length,7);assert.equal(sent.filter(j=>j.gpuId==='0').length,1);assert.equal(sent.filter(j=>j.gpuId==='1').length,6);
 assert.equal(stored.plans[0].jobs[0].commandId,'original');assert.equal(stored.plans[0].jobs[0].executionState,'exited');assert.notEqual(stored.plans[0].jobs[0].status,'completed','freeing a GPU never claims verified results');
 assert.equal(stored.plans[0].jobs.filter(j=>j.status==='pending'&&!j.workerId).length,7);
});
