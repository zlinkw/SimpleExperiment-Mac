const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
require('../_helpers/registerTsRequire');
if (!process.env.LOCALAPPDATA) process.env.LOCALAPPDATA = fs.mkdtempSync(require('node:path').join(fs.realpathSync(require('node:os').tmpdir()), 'submission-truth-lease-')); // r17 约定：租约注册表落隔离目录（沙箱 homedir/AppData 只读，产品路径不变）——切片含真实回执释放链
const source = fs.readFileSync('src/extension/legacy.ts', 'utf8');
const tree = ts.createSourceFile('host.ts', source, ts.ScriptTarget.Latest, true);
const cls = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'RealtimeTunnelPanelProvider');
function host(names, globals = {}) {
  const code = 'class Host {' + cls.members.filter(node => names.includes(node.name?.getText(tree))).map(node => node.getText(tree)).join('\n') + '}; Host;';
  return new (vm.runInNewContext(ts.transpileModule(code, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, {process,GpuMemoryBudget:require('../../src/features/GpuMemoryBudget.ts'),GpuQuotaScheduling:require('../../dist/features/GpuQuotaScheduling'),...globals}))();
}
const Q = require('../../src/features/DistributedPlanQueue.ts');
const ExecutionMode = require('../../src/features/PlanExecutionMode.ts');
const globals = { stringField:(row,key)=>row[key] || '', stringArrayField:(row,key)=>Array.isArray(row[key])?row[key]:[],
  numberField:(row,key)=>row[key], booleanField:(row,key)=>row[key], usableSelectionKey:value=>value || '', uniqueStrings:rows=>[...new Set(rows)], taskActionTargetsField:()=>[] };

test('only a provably unsent native preparation can release its original intent, including a stale tick', async()=>{
  const root='/fixture', projectId=Q.canonicalProjectId(root);
  const scope={supportsPlanCodeScope:()=>true,verifyWorkerPlanSource:async()=>{throw Error('source query timeout');}};
  const h=host(['sendDistributedJob','releaseUnsentDistributedJob'],{workspaceRoot:()=>root,DistributedPlanQueue:Q,PlanExecutionMode:ExecutionMode,
    PlanCodeScopeHost:scope,DistributedSchedulingPolicy:require('../../src/features/DistributedSchedulingPolicy.ts'),errorMessage:error=>error.message,
    AgentTmuxPolicy_1:{normalizeRemoteTmuxSessionPrefix:v=>v},vscode:{workspace:{getConfiguration:()=>({get:()=> 'mine'})}}});
  const plan={id:'p',projectId,revision:'r',planFile:'p.yaml',resultPathPolicy:'declared',executionMode:'train_test',jobs:[]};
  const job={index:0,attempt:0,outputDir:'work/a',lifecycleProtocol:2,status:'dispatching',workerId:'w',gpuId:'0',commandId:'original',
    startIntent:{commandId:'original',workerId:'w',gpuId:'0'}};plan.jobs=[job];
  let posts=0, stored={plans:[structuredClone(plan)]}, controls=0;
  Object.assign(h,{client:{postWorkerAction:async()=>{posts++;}},taskLifecycleProtocol:2,distributedQueueGeneration:0,unifiedDomainState:()=>({active:false,blocked:""}),
    lastWorkerProbes:{w:{capabilities:{endpoints:{declaredJobPaths:true,formalJobIdentityEnv:1,gpuQuotaScheduling:1,gpuMemoryBudgetScheduling:1,taskShellEnvironment:1,projectManagedValidation:1}}}},
    submissionWorkerProbes:async()=>h.lastWorkerProbes,workerActionTargets:()=>[{id:'w'}],enabledWorkerConfigs:()=>[],schedulerSettings:()=>({}),
    saveDistributedQueue:async(_,unused,options)=>{assert.equal(options.controlMutation,true);controls++;stored=options.mutateLatest(stored);},postState(){}});
  let failure;try{await h.sendDistributedJob(plan,job,'w','0','original');}catch(error){failure=error;}
  assert.match(failure.message,/source query timeout/);assert.equal(failure.dispatchNotSent,true);assert.equal(posts,0);
  h.distributedQueueGeneration=9;stored.plans[0].jobs[0].status='unknown';stored.plans[0].jobs[0].executionState='missing';
  await h.releaseUnsentDistributedJob(root,plan,job,failure);
  const released=stored.plans[0].jobs[0];assert.equal(released.status,'pending');assert.equal(released.commandId,undefined);
  assert.equal(released.workerId,undefined);assert.equal(released.startIntent,undefined);assert.equal(released.nextCommandId,'original');
  assert.equal(released.executionState,undefined);assert.equal(controls,1);
  await h.releaseUnsentDistributedJob(root,plan,job,Error('POST receipt timeout'));assert.equal(controls,1);
  stored={plans:[structuredClone(plan)]};stored.plans[0].jobs[0].commandId='newer';
  await h.releaseUnsentDistributedJob(root,plan,job,failure);assert.equal(stored.plans[0].jobs[0].commandId,'newer');
  stored={plans:[structuredClone(plan)]};stored.plans[0].jobs[0].executionState='running';
  await h.releaseUnsentDistributedJob(root,plan,job,failure);assert.equal(stored.plans[0].jobs[0].commandId,'original');
  scope.verifyWorkerPlanSource=async()=>({digest:'verified',manifest:{}});
  h.lastWorkerTaskSnapshots=new Map([[root+'\0w',{capabilities:{taskLifecycle:2}}]]);
  let transportError;h.recordActionError=error=>{transportError=error;};
  h.client.postWorkerAction=()=>{posts++;return Promise.reject(Error('POST receipt timeout'));};
  const result=await h.sendDistributedJob(plan,job,'w','0','original');
  assert.equal(result.lifecycleProtocol,2);assert.equal(result.commandId,'original');assert.equal(posts,1);
  assert.equal(transportError.command,'distributedSubmissionTransport');assert.match(transportError.message,/POST receipt timeout/);
  assert.equal(transportError.dispatchNotSent,undefined,'a sent request timeout cannot authorize an automatic requeue');
});

test('the real scheduling tick commits a preparation timeout back to local pending instead of a missing remote task',async()=>{
 const root='/fixture',P=require('../../src/features/DistributedSchedulingPolicy.ts');
 const scope={supportsPlanCodeScope:()=>true,inspectPlanCodeSlots:async()=>{},verifyWorkerPlanSource:async()=>{throw Error('read-only preparation timed out');}};
 const h=host(['tickDistributedQueueCore','sendDistributedJob','releaseUnsentDistributedJob'],{workspaceRoot:()=>root,DistributedPlanQueue:Q,DistributedSchedulingPolicy:P,
  GpuJobOwnership:require('../../src/features/GpuJobOwnership.ts'),PlanExecutionMode:ExecutionMode,PlanCodeScopeHost:scope,errorMessage:error=>error.message,
  AgentTmuxPolicy_1:{normalizeRemoteTmuxSessionPrefix:v=>v},vscode:{workspace:{getConfiguration:()=>({get:()=> 'mine'})}},setInterval,clearInterval});
 let stored=Q.enqueuePlan(Q.emptyDistributedQueue(),{projectId:Q.canonicalProjectId(root),planFile:'p.yaml',revision:'r',codeFingerprint:'code',executionMode:'train_test',
  jobs:[{index:0,case:'bus',seed:42,outputDir:'work/a',collectionResultCsv:'work/a/metrics.csv'}]},'p'),posts=0;
 const endpoints={declaredJobPaths:true,formalJobIdentityEnv:1,gpuQuotaScheduling:1,gpuMemoryBudgetScheduling:1,taskShellEnvironment:1,projectManagedValidation:1};
 Object.assign(h,{taskLifecycleProtocol:2,distributedQueueGeneration:0,distributedPlanStopEpoch:0,distributedLaunchInFlight:new Set(),
  unifiedDomainState:()=>({active:false,blocked:""}), // 块B：夹具根未登记→既有单机派发路径（真实发送法身含守卫）
  distributedNextPostprocessAt:Infinity,distributedNextFailureDetailAt:Infinity,isRealtimeMode:()=>true,workerCodeSyncTargets:()=>[],
  workerActionTargets:()=>[{id:'w',project_dir:'/remote'}],lastWorkerProbes:{w:{status:'ok',capabilities:{endpoints}}},
  lastCodeSyncState:{workerVersions:{w:{fingerprint:'code'}}},enabledWorkerConfigs:()=>[{id:'w'}],schedulerSettings:()=>({}),gpuOwnerConfig:()=>({}),
  submissionWorkerProbes:async()=>h.lastWorkerProbes,queuePlanArtifactSyncStatusCheck(){},recordActionError(){},postState(){},
  readWorkerTaskSnapshotBatch:async()=>[{workerId:'w',queryComplete:true,generatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),
   capabilities:{taskLifecycle:2,durablePlanQueue:true,schemaVersion:1,idleGpuAdmission:true},tasks:[]}],
  client:{getGpu:async()=>({w:[{index:'0',utilizationPercent:0,memoryUsedMb:0,memoryTotalMb:24576,processes:[]}]}),postWorkerAction:async()=>{posts++;}},
  loadDistributedQueue:async()=>structuredClone(stored),saveDistributedQueue:async(_,value,options={})=>{
   stored=options.mutateLatest?options.mutateLatest(stored):structuredClone(value);if(options.controlMutation)h.distributedQueueGeneration++;
  }});
 await h.tickDistributedQueueCore();
 assert.equal(posts,0);assert.equal(stored.plans[0].jobs[0].status,'pending');assert.equal(stored.plans[0].jobs[0].commandId,undefined);
 assert.ok(stored.plans[0].jobs[0].nextCommandId);assert.match(stored.plans[0].jobs[0].blockReason,/尚未发送/);
 assert.equal(h.distributedLaunchInFlight.size,0);
 const save=h.saveDistributedQueue;
 h.saveDistributedQueue=async(...args)=>{if(args[2]?.controlMutation)throw Error('local disk unavailable');return save(...args);};
 await assert.rejects(h.tickDistributedQueueCore(),/local disk unavailable/);
 assert.equal(h.distributedLaunchInFlight.size,0,'failed local publication must drain the launch guard too');
});
test('the real UI request carries the same selected PLAN at both host and wire boundaries', () => {
  const h = host(['actionBody','actionPlanTarget'],globals);
  Object.assign(h,{planFileInput:'plans/current.yaml',selectedPlanId:'plans/other.yaml',selectedRunKeys:new Set(),selectedExperimentIds:new Set(),selectedArchiveKeys:new Set(),selectedTaskUiKeys:new Set(),
    resolveWorkerEndpointId:value=>value,schedulerSettings:()=>({}),workerActionTargets:()=>[]});
  const body=h.actionBody({command:'runPlan',planFile:'plans/current.yaml'});
  assert.equal(body.planFile,'plans/current.yaml');
  assert.equal(body.options.planFile,body.planFile);
});
test('obsolete missing windows do not consume capacity of actual idle cards', () => {
  const old={lifecycleProtocol:2,status:'unknown',executionState:'missing',workerId:'full',gpuId:'0',commandId:'old'};
  const live={...old,commandId:'live',executionState:'running'};
  assert.equal(Q.jobHasLiveExecution(old),false);assert.equal(Q.jobHasLiveExecution(live),true);
  assert.equal(Q.jobHasLiveExecution({...old,executionState:'unknown',statusQueryError:'offline'}),true);
  // This is the production tick's capacity/reservation seam, shared by both dispatch modes.
  const r=Q.activeGpuReservations({plans:[{jobs:[old,live,{...live,manualDispatch:{workerId:'full',gpuId:'0'}}]}]});
  assert.equal(r.activeByWorker.get('full'),1);assert.deepEqual([...r.occupiedGpuIds],['full:0']);
});
test('legacy stop queries use current project identity without editing or replaying the historical job',async()=>{
  let observed;const h=host(['stopDistributedJobForClear'],{workspaceRoot:()=>'/fixture',DistributedPlanQueue:Q,
    makeOpId:()=> 'stop-one',PulledTaskControl:{stopPulledTask:async(client,plan,job)=>{observed={plan,job};return {status:'completed'};}}});
  h.client={};h.projectContextGeneration=1;
  const plan={id:'old',jobs:[]},job={lifecycleProtocol:2,workerId:'w',commandId:'c'};
  await h.stopDistributedJobForClear(plan,job);
  assert.equal(observed.plan.projectId,Q.canonicalProjectId('/fixture'));assert.equal(plan.projectId,undefined);
});
test('the UI-shaped nested PLAN reaches real replacement discovery before an empty-output submission',async()=>{
  const {PlanRunHost}=require('../../src/extension/PlanRunHost.ts');
  const {cleanupRelative}=require('../../src/features/PlanCleanup.ts');
  const root=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'se-ui-replace-'));
  const paths=[],job={index:0,case:'x',seed:42,output_dir:'work_dirs/x',result_csv:'work_dirs/x/test.csv'};
  const h=host(['captureProjectContext','projectContextIsCurrent'],{workspaceRoot:()=>root});
  Object.assign(h,{context:{globalStorageUri:{fsPath:root}},projectContextGeneration:1,projectContextAbortController:new AbortController(),
    effectiveConnectionMode:()=> 'xshell_tunnel_realtime',workerActionTargets:()=>[],lastCodeSyncState:{fingerprint:'code'},
    planCleanupHost:()=>({service:{preview:async request=>{paths.push(cleanupRelative(request.planFile));return {rows:[],blockers:[]};}}})});
  const body={submissionOperationIdLocal:'original',options:{planFile:'plans/current.yaml'},planRevision:'rev'};
  const store=new PlanRunHost(h,root);await store.save(body);
  assert.equal((await store.load('original')).input.planFile,'plans/current.yaml');
  await store.replace({},body,{jobs:[job]});assert.deepEqual(paths,['plans/current.yaml']);
  assert.equal(body.existingOutputChoice,'rerun_all');assert.deepEqual(body.assignedExperimentIndices,[0]);
  await assert.rejects(store.replace({}, {...body,options:{planFile:'plans/other.yaml'}},{jobs:[job]}),/不一致/);
});
