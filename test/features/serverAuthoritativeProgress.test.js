const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const original = require.extensions['.ts'];
require.extensions['.ts'] = (loaded, filename) => loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText, filename);
const queue = require('../../src/features/DistributedPlanQueue.ts');
const policy = require('../../src/features/DistributedSchedulingPolicy.ts');
const { LatestSnapshotWriter } = require('../../src/core/LatestSnapshotWriter.ts');
require.extensions['.ts'] = original;
const now = Date.now();
const iso = new Date(now).toISOString();
function intent() {
  const result = queue.enqueuePlan(queue.emptyDistributedQueue(), {projectId:'project',schedulingMode:'server_prequeue',
    planFile:'p.yaml',revision:'r',codeFingerprint:'f',jobs:[0,1].map(index=>({index,case:'bus',seed:42+index,outputDir:`runs/${index}`}))},'p',iso);
  return policy.allocateServerPrequeue(result,[{workerId:'a',online:true,weight:1,codeFingerprint:'f'},
    {workerId:'b',online:true,weight:1,codeFingerprint:'f'}]).queue;
}
function snapshot(plan, job, status='running', overrides={}) {
  return {workerId:job.workerId,generatedAt:iso,fetchedAt:iso,capabilities:{durablePlanQueue:true,schemaVersion:1},tasks:[{
    projectId:plan.projectId,workflowId:plan.id,planFile:plan.planFile,planRevision:plan.revision,
    codeFingerprint:plan.codeFingerprint,planJobCount:plan.planJobCount,enqueuedAt:plan.enqueuedAt,
    experimentIndex:job.index,attempt:job.attempt,case:job.case,seed:job.seed,outputDir:job.outputDir,
    commandId:job.commandId,runKey:job.commandId,workerId:job.workerId,status,schedulingMode:plan.schedulingMode,
    ...(status==='completed'?{finishedAt:iso}:{}),}],...overrides};
}
test('all-server projection immediately supersedes local running, while one failed server only fences its own jobs', () => {
  const input = intent(); const plan=input.plans[0]; plan.jobs.forEach(job=>job.status='running');
  const snapshots=plan.jobs.map((job,index)=>snapshot(plan,job,index===0?'completed':'running'));
  const projected=policy.serverAuthoritativeProgress(input,snapshots,'project',now);
  assert.deepEqual(projected[0].jobs.map(job=>job.status),['completed','running']);
  assert.deepEqual(input.plans[0].jobs.map(job=>job.status),['running','running']);
  const partial=policy.serverAuthoritativeProgress(input,[snapshots[0],{...snapshots[1],error:'disconnected'}],'project',now);
  assert.deepEqual(partial[0].jobs.map(job=>job.status),['completed','unknown']);
  assert.equal(partial[0].jobs[1].commandId,plan.jobs[1].commandId);
  const expired=policy.serverAuthoritativeProgress(input,snapshots,'project',now+5001);
  assert.ok(expired[0].jobs.every(job=>job.status==='unknown'));
});
test('a poll predating a verified dispatch receipt does not undo queued status, but newer or untrusted evidence does', () => {
  const input=intent(), plan=input.plans[0], job=plan.jobs[0];
  job.status='queued';job.dispatchAcknowledgedAt=iso;job.lastDispatchAttemptAt=iso;
  const before=snapshot(plan,job,'queued',{tasks:[],generatedAt:new Date(now-100).toISOString(),fetchedAt:new Date(now-100).toISOString()});
  const other=snapshot(plan,plan.jobs[1]);
  const project=owner=>policy.serverAuthoritativeProgress(input,[owner,other],'project',now+1000)[0].jobs[0];
  assert.equal(project(before).status,'queued');
  assert.equal(project({...before,fetchedAt:new Date(now+1).toISOString()}).status,'unknown','newer empty poll is unresolved ownership');
  assert.equal(project({...before,error:'disconnected'}).status,'unknown');
  assert.equal(project({...before,fetchedAt:new Date(now-6000).toISOString()}).status,'unknown');
  const mismatch=snapshot(plan,job,'running');mismatch.tasks[0].seed++;
  assert.equal(project(mismatch).status,'unknown','receipt grace cannot hide conflicting identity');
  assert.equal(policy.serverAuthoritativeProgress(input,[before,other],'project',now+11000)[0].jobs[0].status,'unknown');
  job.status='dispatching';assert.equal(project(before).status,'dispatching');
  job.status='unknown';assert.equal(project(before).status,'unknown','unconfirmed RPC never fabricates an accepted state');
});
test('cold restart rebuilds hosted identities across servers without duplicate jobs or fabricated completion', () => {
  const input=intent(); const plan=input.plans[0]; const snapshots=plan.jobs.map(job=>snapshot(plan,job,'completed'));
  let restored=queue.emptyDistributedQueue();
  for(let index=0;index<3;index++) restored={...restored,plans:policy.serverAuthoritativeProgress(restored,snapshots,'project',now)};
  assert.equal(restored.plans.length,1); assert.equal(restored.plans[0].jobs.length,2);
  assert.equal(restored.plans[0].schedulingMode,'server_prequeue');
  assert.equal(restored.plans[0].remoteAcceptedJobCount,2);
  assert.deepEqual(restored.plans[0].jobs.map(job=>job.commandId),plan.jobs.map(job=>job.commandId));
  assert.equal(policy.serverAuthoritativeProgress(input,[],'project',now)[0].jobs[0].status,'unknown');
});
test('known unassigned local intent remains waiting rather than missing server state', () => {
  const input=intent(); const plan=input.plans[0];
  Object.assign(plan.jobs[1],{status:'pending',workerId:undefined,commandId:undefined,runKey:undefined});
  const projected=policy.serverAuthoritativeProgress(input,[snapshot(plan,plan.jobs[0])],'project',now)[0];
  assert.equal(projected.jobs[1].status,'pending'); assert.equal(projected.recoveryMissingCount,0);
});
test('hosted unbound GPU receives its first authoritative GPU without false identity conflict', () => {
  const input=intent(); const plan=input.plans[0]; const job=plan.jobs[0]; job.gpuId='';job.status='queued';
  const remote=snapshot(plan,job);remote.tasks[0].gpuId='0';
  assert.equal(queue.remoteTaskMatchesJob(plan,job,remote.tasks[0]),true);
  const bound=policy.serverAuthoritativeProgress(input,[remote,snapshot(plan,plan.jobs[1])],'project',now)[0];
  assert.equal(bound.jobs[0].gpuId,'0');assert.equal(bound.jobs[0].status,'running');assert.equal(bound.jobs[0].recoveryConflict,undefined);
  remote.tasks[0].gpuId='1';assert.equal(queue.remoteTaskMatchesJob(bound,bound.jobs[0],remote.tasks[0]),false);
  plan.schedulingMode='local_idle';assert.equal(queue.remoteTaskMatchesJob(plan,job,remote.tasks[0]),false);
});

test('fresh matching receipts clear a resolved code-proof block without erasing retry provenance', () => {
  const input=intent(), plan=input.plans[0], job=plan.jobs[0];
  const error='code-sync proof identity mismatch or stale runtime generation';
  Object.assign(job,{status:'queued',error,automaticRetry:{failureCount:1,failedAttempt:1,lastError:'CUDA failure'},
    history:[{attempt:1,status:'failed',commandId:'original',outputDir:'runs/original',error:'CUDA failure'}]});
  const other=snapshot(plan,plan.jobs[1]);
  const project=owner=>policy.serverAuthoritativeProgress(input,[owner,other],'project',now)[0].jobs[0];
  for(const status of ['queued','running','completed']) {
    const result=project(snapshot(plan,job,status));
    assert.equal(result.status,status);assert.equal(result.error,undefined);
    assert.equal(result.commandId,job.commandId);assert.equal(result.attempt,job.attempt);
    assert.deepEqual(result.automaticRetry,job.automaticRetry);assert.deepEqual(result.history,job.history);
  }
  const stillBlocked=snapshot(plan,job,'queued');stillBlocked.tasks[0].error=error;
  assert.equal(project(stillBlocked).error,error,'current server rejection remains visible');
  const missingError=snapshot(plan,job,'queued');
  assert.equal(project({...missingError,error:'disconnected'}).error,error);
  assert.equal(project({...missingError,fetchedAt:new Date(now-6000).toISOString()}).error,error);
  const mismatch=snapshot(plan,job,'queued');mismatch.tasks[0].seed++;
  assert.equal(project(mismatch).error,error);
  job.status='failed';job.trustedTerminalStatus='failed';job.error='CUDA failure';
  assert.equal(project(snapshot(plan,job,'failed')).error,'CUDA failure','terminal failure evidence is preserved');
});

function providerMethods(names, extra={}) {
  const source=fs.readFileSync(require.resolve('../../src/extension/legacy.ts'),'utf8');
  const ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);
  const cls=ast.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='RealtimeTunnelPanelProvider');
  const code='class Provider {'+cls.members.filter(node=>names.includes(node.name?.getText(ast))).map(node=>node.getText(ast)).join('\n')+'}; Provider;';
  return vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,
    {AbortController,setTimeout,clearTimeout,workspaceRoot:()=>'/project',mapLimited:async(rows,_limit,callback)=>Promise.all(rows.map(callback)),...extra});
}
test('actual provider read-only progress lane publishes a fast server while dispatch and another server stay pending', async () => {
  const Provider=providerMethods(['refreshServerPlanProgress']); const provider=new Provider();
  provider.distributedQueueRoot='/project';provider.distributedQueueCache={plans:[{}]};provider.isRealtimeMode=()=>true;
  provider.workerActionTargets=()=>[{id:'fast'},{id:'slow'}];provider.postState=()=>{};
  let release;let fast=false;let calls=0;
  const slow=new Promise(resolve=>release=resolve);
  provider.distributedQueueTickPromise=new Promise(()=>{});
  provider.readWorkerTaskSnapshot=async id=>{calls++;if(id==='slow')await slow;else fast=true;};
  const first=provider.refreshServerPlanProgress(); const second=provider.refreshServerPlanProgress();
  await Promise.resolve();assert.equal(fast,true);assert.equal(calls,2);
  release();await Promise.all([first,second]);assert.equal(provider.progressRefreshPromise,undefined);
});

test('automatic progress polling ignores terminal history and targets only live ownership', async () => {
  const Provider=providerMethods(['refreshServerPlanProgress'], { DistributedSchedulingPolicy: policy });
  const provider=new Provider();
  provider.distributedQueueRoot='/project'; provider.isRealtimeMode=()=>true;
  provider.workerActionTargets=()=>[{id:'a'},{id:'b'},{id:'c'}];
  provider.postState=()=>{};
  const calls=[]; provider.readWorkerTaskSnapshot=async id=>calls.push(id);
  provider.distributedQueueCache={plans:Array.from({length:28},()=>({jobs:[{status:'completed',workerId:'a'}]}))};
  for(let tick=0;tick<30;tick++) await provider.refreshServerPlanProgress({automatic:true});
  assert.deepEqual(calls,[]);
  provider.distributedQueueCache.plans.push({jobs:[{status:'queued',workerId:'b'},{status:'pending'}]});
  provider.distributedQueueCache.plans.push({planJobCount:2,recoveryMissingCount:1,jobs:[0,1].map(index=>({
    index,attempt:1,status:'completed',trustedTerminalStatus:'completed',workerId:'a',commandId:`old-${index}`,
    outputDir:`runs/${index}`,case:'bus',seed:index}))});
  await provider.refreshServerPlanProgress({automatic:true});
  assert.deepEqual(calls,['b'],'obsolete missing counters on complete receipt sets must not keep polling every Worker');
  calls.length=0;
  await provider.refreshServerPlanProgress();
  assert.deepEqual(calls,['a','b','c'], 'explicit refresh still reconciles all workers');
});

test('automatic progress still probes uncertain ownership and recall, but not retired history', () => {
  const workers=['a','b'];
  assert.deepEqual(policy.progressRefreshWorkerIds({plans:[{jobs:[{status:'unknown'}]}]}, workers),workers);
  assert.deepEqual(policy.progressRefreshWorkerIds({plans:[{recoveryMissingCount:1,jobs:[]}]},workers),workers);
  assert.deepEqual(policy.progressRefreshWorkerIds({plans:[{jobs:[{status:'failed',workerId:'b',recallRequested:true}]}]},workers),['b']);
  assert.deepEqual(policy.progressRefreshWorkerIds({plans:[{jobs:[{status:'completed',workerId:'a',outputRetiredAt:iso}]}]},workers),[]);
});
test('actual snapshot reader deduplicates fresh reads, publishes immediately and invalidates cached running on failure', async () => {
  const Provider=providerMethods(['readWorkerTaskSnapshot','refreshWorkerTaskSnapshot','storeWorkerTaskSnapshot','queueWorkerTaskSnapshotPersistence','workerTaskSnapshotWriters'],{
    LatestSnapshotWriter,
    workerTaskSnapshotPayload:row=>row,workerTaskLooksRunning:row=>row.status==='running',RequestBudget_1:{RequestBudgetDeniedError:class extends Error{}},
    noteWorkerTaskPlanStatus() {},
  });
  const provider=new Provider();provider.workerTaskRequests=new Map();provider.lastWorkerTaskSnapshots=new Map();
  provider.noteWorkerTaskPlanStatus=()=>{};
  provider.workerTaskSnapshotDiskCache=new Map();provider.workerTaskPlanStatusSignatures=new Map();
  provider.cachedWorkerTaskSnapshot=(_worker,_root,key)=>provider.lastWorkerTaskSnapshots.get(key);
  let releaseDisk; const diskGate=new Promise(resolve=>{releaseDisk=resolve;});
  provider.writeWorkerTaskSnapshot=async()=>diskGate;let posts=0;provider.postState=()=>posts++;
  let count=0;let release;const response=new Promise(resolve=>release=resolve);
  provider.client={getWorkerTasks:async()=>{count++;return response;}};
  const a=provider.readWorkerTaskSnapshot('w',{fresh:true}), b=provider.readWorkerTaskSnapshot('w',{fresh:true});
  release({schemaVersion:1,generatedAt:iso,capabilities:{durablePlanQueue:true,schemaVersion:1},tasks:[{status:'running'}]});
  let returned=false; const readers=Promise.all([a,b]).then(()=>{returned=true;});
  try {
    for(let attempt=0;attempt<10&&!returned;attempt++) await new Promise(setImmediate);
    assert.equal(returned,true,'a received task snapshot must not wait for the local cache file lease/write');
  } finally { releaseDisk(); await readers; }
  assert.equal(count,1);assert.equal(posts,1);
  provider.client.getWorkerTasks=async()=>{throw new Error('offline');};
  const failed=await provider.readWorkerTaskSnapshot('w',{fresh:true});
  assert.equal(failed.error,'Worker task snapshot unavailable');
  assert.equal(provider.lastWorkerTaskSnapshots.get('/project\u0000w').error,failed.error);assert.equal(posts,2);
});

test('snapshot cache persistence retains only one active and one latest snapshot per Worker, then releases idle writers',async()=>{
  const Provider=providerMethods(['queueWorkerTaskSnapshotPersistence','workerTaskSnapshotWriters'],{LatestSnapshotWriter});
  const p=new Provider();p.client={};let release;const gate=new Promise(resolve=>{release=resolve;});const written=[];
  p.writeWorkerTaskSnapshot=async(id,_root,row)=>{written.push([id,row.seq]);if(id==='a'&&row.seq===0)await gate;};
  p.queueWorkerTaskSnapshotPersistence('a','/project',{seq:0});await new Promise(setImmediate);
  const writer=p.workerTaskSnapshotWriters.get('/project\u0000a');
  for(let seq=1;seq<=1000;seq++)p.queueWorkerTaskSnapshotPersistence('a','/project',{seq});
  p.queueWorkerTaskSnapshotPersistence('b','/project',{seq:7});
  assert.equal(writer.writer.pendingCount,1);assert.equal(p.workerTaskSnapshotWriters.size,2);
  const drains=[...p.workerTaskSnapshotWriters.values()].map(row=>row.active);release();await Promise.all(drains);
  assert.deepEqual(written.filter(([id])=>id==='a'),[['a',0],['a',1000]]);
  assert.deepEqual(written.filter(([id])=>id==='b'),[['b',7]],'a blocked Worker cache cannot discard another Worker');
  assert.equal(p.workerTaskSnapshotWriters.size,0,'idle writer keys do not accumulate across polling cycles');
});
test('optional snapshot write failure, changed client/workspace and disposal cannot overwrite later snapshots or leak writers',async()=>{
  let currentRoot='/project';
  const Provider=providerMethods(['queueWorkerTaskSnapshotPersistence','workerTaskSnapshotWriters'],{LatestSnapshotWriter,workspaceRoot:()=>currentRoot});
  const p=new Provider();p.client={};let writes=0;
  p.writeWorkerTaskSnapshot=async()=>{writes++;throw new Error('cache busy');};
  p.queueWorkerTaskSnapshotPersistence('w','/project',{});await new Promise(setImmediate);
  assert.equal(writes,1);assert.equal(p.workerTaskSnapshotWriters.size,0,'write rejection is contained and can be retried');
  p.writeWorkerTaskSnapshot=async()=>{writes++;};
  p.queueWorkerTaskSnapshotPersistence('w','/project',{});p.client={};await new Promise(setImmediate);
  assert.equal(writes,1,'queued evidence belongs to its original client');
  p.queueWorkerTaskSnapshotPersistence('w','/project',{});currentRoot='/other';await new Promise(setImmediate);
  assert.equal(writes,1,'an old workspace request cannot publish into a new context');
  currentRoot='/project';p.queueWorkerTaskSnapshotPersistence('w','/project',{});p.panelDisposed=true;await new Promise(setImmediate);
  assert.equal(writes,1);assert.equal(p.workerTaskSnapshotWriters.size,0);
});
