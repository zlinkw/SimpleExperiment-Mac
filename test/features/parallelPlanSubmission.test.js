const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),ts=require('typescript');
require('../_helpers/registerTsRequire');
const {runSelectedPlans,runAllPlans}=require('../../src/extension/SelectedPlanBatchHost.ts');
const {PlanSubmissionBatch,planSubmissionBatchFor}=require('../../src/features/PlanSubmissionBatch.ts');
const Queue=require('../../src/features/DistributedPlanQueue.ts');
const source=fs.readFileSync(path.join(__dirname,'../../src/extension/legacy.ts'),'utf8'),ast=ts.createSourceFile('extension.ts',source,ts.ScriptTarget.Latest,true),methods=new Map();
function visit(node){if(ts.isMethodDeclaration(node))methods.set(node.name.getText(ast),node);ts.forEachChild(node,visit)}visit(ast);
function method(name,globals){const code=ts.transpileModule('class Host{'+methods.get(name).getText(ast)+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(globals),code+';return Host.prototype.'+name)(...Object.values(globals));}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('concurrent preflight barrier timed out')),1500)})]);}finally{clearTimeout(timer)}}
function fixture(count=8){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'se-parallel-plans-')),context={root};fs.mkdirSync(path.join(root,'plans'));
 const plans=Array.from({length:count},(_,i)=>{const text='mode: train_test\ncase: '+i+'\n',planFile='plans/'+i+'.yaml';fs.writeFileSync(path.join(root,planFile),text,'utf8');return {planFile,revision:crypto.createHash('sha256').update(text).digest('hex')};});
 const calls={sync:0,adapter:0,sftp:0,git:0,validate:[],outputs:[],enqueue:[],metadata:[],ticks:0,active:0,max:0,outputActive:0,outputMax:0,enterActive:0,enterMax:0};
 let release;const firstWave=new Promise(resolve=>release=resolve);
 const h={context:{globalStorageUri:{fsPath:root}},client:{},projectContextGeneration:1,localPlanMetadata:{plans,detectedProject:{}},localOperations:{},code:'same-code',
  captureProjectContext:()=>context,projectContextIsCurrent:value=>value===context&&!h.changed,effectiveConnectionMode:()=> 'worker_pool',
  workerActionTargets:()=>[{id:'a',host:'a',project_dir:'/project'},{id:'b',host:'b',project_dir:'/project'}],enabledWorkerConfigs:()=>[{id:'a'},{id:'b'}],
  refreshLocalPlanMetadataForAction:async body=>{calls.metadata.push(body?.planFile||'all')},distributedPlanEligible:()=>true,
  localDistributedCodeFingerprint:async()=>{await turn();return h.code},
  actionBody:message=>({planFile:message.planFile,workspace:root,options:{planFile:message.planFile}}),planSubmissionBatchFor,
  planSubmissionOperationId:message=>'plan-submit-'+message.clientActionId,
  stampPlanRevision:body=>{body.planRevision=plans.find(plan=>plan.planFile===body.planFile).revision},
  localPlanForActionBody:body=>plans.find(plan=>plan.planFile===body.planFile),resolveWorkerEndpointId:()=>'',
  assertRetryPlanContext(){},ensureManualStopReason:async()=>{},assertPlanTopologyReady(){},assertPlanLocalConfigFiles:async()=>{},
  selectDistributedPlanPrimary:async body=>{body.schedulerOwnerWorkerId='a'},assertExecutionWorkersReady(){},assertExecutionAgentProjectsReady(){},assertPlanNotAlreadyActive:async()=>{},
  syncProjectAdapterRulesToAgents:async()=>{calls.adapter++;await turn();return []},ensureSimpleSftpReadyForSetup:async()=>{calls.sftp++;await turn();return true},
  collectRunGitProvenance:async()=>{calls.git++;await turn();return {repositoryRoot:root,branch:'master',localCommit:'a'.repeat(40),githubCommit:'a'.repeat(40),originUrl:'https://example.invalid/repo'}},
  submissionStillCurrent:()=>true,distributedCodeVersionHold:async()=>undefined,waitForPlanSubmission:async(_,work)=>work(),
  ensureCodeReadyForRun:async()=>{calls.sync++;await turn();if(h.syncError)throw Error('sync failed');h.lastCodeSyncState={fingerprint:h.code,workerVersions:{a:{fingerprint:h.code},b:{fingerprint:h.code}}}},
  planValidationCacheKey:body=>body.planFile,planSchedulerWorkerId:body=>body.schedulerOwnerWorkerId,
  runPlanPreflight:async body=>{calls.validate.push(body.planFile);calls.active++;calls.max=Math.max(calls.max,calls.active);if(calls.validate.length===Math.min(4,count))release();
   try{await bounded(firstWave);if(h.badPlan===body.planFile)throw Error('invalid PLAN '+body.planFile);return {validation:{jobs:[{index:0,case:body.planFile,seed:42,output_dir:h.overlap?'work/shared':'work/'+body.planFile.split('/')[1]}],existing:[],execution_mode:'train_test'}}}finally{calls.active--}},
  assertPlanSubmissionWorkers:async(body,value)=>{assert.equal(value.validation.jobs[0].case,body.planFile)},
  // 新契约的忠实 stub：历史/队列读取等机械段在道外并发；对话段必须经 legacy 注入的批次对话道，
  // 这里对 body.confirmGateLocal 的真实存在与串行效果做端到端校验（经真实 runAllPlans/runSelectedPlans 路径，不只是源码钉）。
  confirmDistributedPlanExistingOutputs:async(_,body)=>{calls.enterActive++;calls.enterMax=Math.max(calls.enterMax,calls.enterActive);calls.outputs.push(body.planFile);await turn();
   assert.equal(typeof body.confirmGateLocal,'function','批路径必须经 confirmGateLocal 注入批次对话道');
   await body.confirmGateLocal(async()=>{calls.outputActive++;calls.outputMax=Math.max(calls.outputMax,calls.outputActive);await turn();calls.outputActive--;});
   calls.enterActive--;if(h.beforeEnqueue)await h.beforeEnqueue(body)},
  assertExecutionCondaEnvReady(){},reportPlanStage(){},legacySourceFreezeWorkerNames(){return [];},recordPlanSubmissionTiming(){},recordPlanSubmissionTimingByOperation(){},
  finishPlanSubmissionProgress:(message,status,detail)=>{h.localOperations[h.planSubmissionOperationId(message)]={status,message:detail}},
  tickDistributedQueue:async()=>{calls.ticks++;if(h.tickError)throw Error('dispatch query unavailable')},queue:Queue.emptyDistributedQueue()};
 const globals={WorkerPreparation:require('../../src/features/WorkerPreparation.ts').WorkerPreparation,
  PlanRunHost:class{async save(){}},workspaceRoot:()=>root,WorkflowBinding:{bindWorkflowWorkspace:()=>({root}),assertWorkflowContext(){},assertPlanSeedContract(){},assertWorkflowWorkspace(){}},
  PLAN_SUBMISSION_COMMANDS:new Set(['runPlan']),PLAN_PREFLIGHT_COMMANDS:new Set(),actionCommandMap:{runPlan:'run-plan'},directWorkerActionMap:{},
  assertSingleProjectWorkspace(){},pluginProjectAdapterRules:()=>({entry:'train.py'}),operationResultPlanFile:body=>body.planFile,
  projectOutputGateReason:()=>'',LENIENT_RUN:false,stringField:(value,key)=>value[key]||'',stringArrayField:()=>[],uniqueStrings:value=>value,usableSelectionKey:()=>'',
  preparePlanSafeRetry:async()=>false,makeOpId:()=>crypto.randomUUID(),isUiCommandCancelled:()=>false,errorMessage:error=>error.message,setTimeout,
  DistributedPlanQueue:Queue,fs:fsp,path,crypto,atomicWriteText:async(file,text)=>{await fsp.mkdir(path.dirname(file),{recursive:true});await fsp.writeFile(file,text,'utf8')}};
 h.recordRunGitProvenance=method('recordRunGitProvenance',globals);
 h.finishDistributedPlanSubmission=method('finishDistributedPlanSubmission',globals);
 const core=method('runActionCommandCore',globals);
 h.runActionCommand=async(command,message)=>{h.localOperations[h.planSubmissionOperationId(message)]={status:'running'};await core.call(h,command,message)};
 h.enqueueDistributedPlan=async(body,value,skipTick)=>{
  assert.equal(skipTick,true);assert.equal(Object.getOwnPropertyDescriptor(body,'submissionBatchLocal').enumerable,false);
  const current=h.queue;await turn();
  h.queue=Queue.enqueuePlan(current,{planFile:body.planFile,revision:body.planRevision,codeFingerprint:h.code,
   executionMode:'train_test',jobs:value.validation.jobs.map(job=>({index:job.index,case:job.case,seed:job.seed,outputDir:job.output_dir}))},body.planFile);
  calls.enqueue.push(body.planFile);return {enqueued:true,localQueued:true,pendingCount:1};
 };
 return {h,plans,calls,root,context};
}
test('both batch entries overlap real per-PLAN submissions, sync once and keep every distinct validation/job',async()=>{
 for(const all of [false,true]){
  const {h,plans,calls,root}=fixture();const result=await(all?runAllPlans(h,{}):runSelectedPlans(h,{planFiles:plans.map(plan=>plan.planFile)}));
  assert.equal(result.status,'completed',result.message);assert.equal(calls.max,4);assert.equal(calls.sync,1);assert.equal(calls.adapter,1);assert.equal(calls.sftp,1);assert.equal(calls.git,1);
  assert.equal(calls.validate.length,8);assert.equal(new Set(calls.validate).size,8);
  assert.equal(calls.outputMax,1,'对话段同一时刻至多一个（审核语义不变）');
  assert.ok(calls.enterMax>1,'历史确认的机械段必须能并发（慢批次根因修复）');
  assert.ok(calls.ticks>=1&&calls.ticks<=8);assert.equal(h.queue.plans.length,8);
  assert.deepEqual(new Set(h.queue.plans.map(plan=>plan.jobs[0].case)),new Set(plans.map(plan=>plan.planFile)));
  assert.equal(calls.metadata.filter(value=>value==='all').length,1);for(const plan of plans)assert.equal(calls.metadata.filter(value=>value===plan.planFile).length,1);
  const dir=path.join(root,'simple_cluster/runs/git_provenance',new Date().toISOString().slice(0,10)),files=fs.readdirSync(dir);assert.equal(files.length,8);
  assert.equal(new Set(files.map(file=>JSON.parse(fs.readFileSync(path.join(dir,file),'utf8')).planFile)).size,8);
 }
});
test('one invalid PLAN never borrows another validation and stops the next wave while preserving accepted plans',async()=>{
 const {h,calls}=fixture();h.badPlan='plans/1.yaml';const result=await runAllPlans(h,{});
 assert.equal(result.status,'failed');assert.deepEqual(result.remaining,['plans/4.yaml','plans/5.yaml','plans/6.yaml','plans/7.yaml']);
 assert.equal(calls.validate.length,4);assert.equal(h.queue.plans.length,3);assert.ok(!calls.enqueue.includes(h.badPlan));assert.ok(calls.ticks>=1&&calls.ticks<=3);
});
test('a failed shared upload fails all in-flight plans before validation and does not retry or enter the next wave',async()=>{
 const {h,calls}=fixture();h.syncError=true;const result=await runAllPlans(h,{});
 assert.equal(result.status,'failed');assert.equal(calls.sync,1);assert.equal(calls.validate.length,0);assert.equal(h.queue.plans.length,0);assert.equal(result.remaining.length,4);
});
test('code changes after validation prevent enqueue even though all prepared workers held the old fingerprint',async()=>{
 const {h,calls}=fixture(4);h.beforeEnqueue=async()=>{h.code='changed-code'};
 const result=await runAllPlans(h,{});assert.equal(result.status,'failed');assert.equal(calls.validate.length,4);assert.equal(h.queue.plans.length,0);assert.match(result.message,/代码|同步范围/);
});
test('a PLAN excluded from the shared fingerprint is still reread before enqueue',async()=>{
 const {h,root}=fixture(4);h.beforeEnqueue=async body=>{await fsp.writeFile(path.join(root,body.planFile),'changed PLAN\n','utf8')};
 const result=await runAllPlans(h,{});assert.equal(result.status,'failed');assert.equal(h.queue.plans.length,0);assert.match(result.message,/PLAN 已修改/);
});
test('overlapping output declarations cannot race past the serialized queue admission',async()=>{
 const {h,calls}=fixture(4);h.overlap=true;const result=await runAllPlans(h,{});
 assert.equal(result.status,'failed');assert.equal(h.queue.plans.length,1);assert.equal(calls.enqueue.length,1);assert.equal(calls.validate.length,4);
});
test('dispatch query failure keeps every accepted plan and reports the actual queue state',async()=>{
 const {h}=fixture(4);h.tickError=true;const result=await runAllPlans(h,{});assert.equal(result.status,'completed');assert.equal(h.queue.plans.length,4);assert.match(result.message,/派发查询未完成/);
});
test('batch evidence cannot survive disposal, another batch, or a changed workspace',async()=>{
 const {h,context,plans}=fixture(1);let changed=false;
 const batch=new PlanSubmissionBatch(h,context,plans,()=>{if(changed)throw Error('workspace changed')});await batch.start();
 let reads=0;assert.equal(await batch.once('probe',async()=>++reads),1);assert.equal(await batch.once('probe',async()=>++reads),1);
 changed=true;await assert.rejects(async()=>batch.once('probe',async()=>++reads),/workspace/);changed=false;await batch.close();await assert.rejects(async()=>batch.once('probe',async()=>++reads),/已结束/);
 const next=new PlanSubmissionBatch(h,context,plans,()=>{});assert.equal(await next.once('probe',async()=>++reads),2);await next.close();
});
test('closing a batch drains actual confirmation work and rejects waiting work before releasing its boundary',async()=>{
 const {h,context,plans}=fixture(1),batch=new PlanSubmissionBatch(h,context,plans,()=>{});let release,entered;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const active=batch.serial('outputs',async()=>{entered();await gate;return 'finished'});await started;
 let ran=false;const queued=batch.serial('outputs',async()=>{ran=true});
 const outcomes=Promise.allSettled([active,queued]);let closed=false;const closing=batch.close().then(()=>closed=true);
 await turn();assert.equal(closed,false);assert.equal(ran,false);release();await bounded(closing);await outcomes;assert.equal(closed,true);assert.equal(ran,false);
});

test('real batch Worker selection spreads preflights independently of identical idle-GPU rankings',async()=>{
 const {h,context,plans}=fixture(4),batch=new PlanSubmissionBatch(h,context,plans,()=>{}),chosen=[];
 const select=method('selectDistributedPlanPrimary',{RequestBudget_1:{RequestBudgetDeniedError:class extends Error{}}});
 const workers=['a','b','c','d'];h.client.getGpu=async()=>({});h.localWorkerAvailabilityRows=()=>workers.map(workerId=>({workerId,availableGpuIds:['0','1']}));
 h.availabilityPushTtlSeconds=()=>30;h.schedulerSettings=()=>({});h.lastWorkerProbes=Object.fromEntries(workers.map(id=>[id,{status:'ok'}]));h.stampWorkerPoolManualTarget=(body,id)=>body.worker=id;
 for(const plan of plans)chosen.push(await select.call(h,{planFile:plan.planFile,submissionBatchLocal:batch}));
 assert.deepEqual(chosen,workers);await batch.close();
});
test('a slow PLAN and a slow dispatch query cannot hold all later authorized PLAN submissions',async()=>{
 const {h,plans,calls}=fixture(8),run=h.runActionCommand;let release;
 const gate=new Promise(resolve=>release=resolve);h.tickDistributedQueue=()=>new Promise(()=>{});
 h.runPlanPreflight=async body=>{calls.validate.push(body.planFile);return {validation:{jobs:[{index:0,case:body.planFile,seed:42,output_dir:'work/'+body.planFile.split('/')[1]}],existing:[],execution_mode:'train_test'}};};
 h.runActionCommand=async(command,message)=>{if(message.planFile===plans[0].planFile)await gate;return run(command,message)};
 const pending=runAllPlans(h,{});await new Promise(resolve=>setTimeout(resolve,250));
 const advanced=calls.validate.includes(plans[4].planFile);release();const result=await bounded(pending);
 assert.equal(advanced,true,'a free submission slot must advance before the slow sibling ends');assert.equal(result.status,'completed');
});
test('a delayed original validation remains unknown and never becomes a failed PLAN or a repeated submission',async()=>{
 const {h,plans}=fixture(6),run=h.runActionCommand,attempts=[];
 h.runActionCommand=async(command,message)=>{attempts.push(message.planFile);if(message.planFile===plans[1].planFile){h.localOperations[h.planSubmissionOperationId(message)]={status:'queued',message:'执行结果待确认 operationId=original'};throw Object.assign(Error('delayed'),{name:'UiCommandRemotePending'});}return run(command,message);};
 const result=await runAllPlans(h,{});assert.equal(result.status,'submitted');assert.equal(attempts.length,6);assert.equal(new Set(attempts).size,6);assert.equal(result.rows.find(row=>row.planFile===plans[1].planFile).status,'unknown');
 assert.equal(h.localOperations[result.rows.find(row=>row.planFile===plans[1].planFile).operationId].status,'queued');
});
