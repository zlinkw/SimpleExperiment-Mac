const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto');
require('../_helpers/registerTsRequire');
const H=require('../../src/extension/PlanCodeScopeHost.ts'),Q=require('../../src/features/DistributedPlanQueue.ts'),P=require('../../src/features/DistributedSchedulingPolicy.ts');
test('actual Python scope ignores generated files and unrelated plans, but verifies imported source and inherited config',()=>{
 const r=require('node:child_process').spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',path.join(__dirname,'planCodeScope.fixture.py'),path.resolve('src/runtime/PlanCodeScope.ts')],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(r.status,0,r.stderr||r.stdout);assert.equal(JSON.parse(r.stdout).files,13);
});
const hash=content=>crypto.createHash('sha256').update(content).digest('hex');
const source=()=>{const manifest={'plans/p.yaml':{size:4,sha256:hash('plan')},'train.py':{size:4,sha256:hash('code')}};return {manifest,digest:hash(JSON.stringify(Object.entries(manifest).map(([k,v])=>[k,v])))};};
function fixture(){const s=source(),plan={id:'p',projectId:'project',revision:hash('plan'),codeFingerprint:'old-global',planFile:'plans/p.yaml',resultPathPolicy:'declared',executionMode:'train_test',jobs:[{index:0,status:'pending',case:'a',seed:42,attempt:0,outputDir:'work/a',collectionResultCsv:'tmp/a.csv'}]};let calls=0;
 const host={workerActionTargets:()=>[{id:'w'}],lastWorkerProbes:{w:{status:'ok',capabilities:{endpoints:{planCodeScope:1}}}},client:{getWorkerPlanCodeScope:async(_,r)=>{calls++;return {ok:true,compatible:true,readOnly:true,...r,executionSource:s};}}};return {host,plan,s,get calls(){return calls}};}

test('different Plan source checks share a per-Worker read lane and cancelled queued reads never reach the server',async()=>{
 const f=fixture(),calls=[];let release;
 const held=new Promise(resolve=>release=resolve);
 f.host.client.getWorkerPlanCodeScope=async(worker,query)=>{calls.push(query.planFile);if(query.planFile==='plans/p.yaml')await held;
  const manifest={[query.planFile]:{size:4,sha256:query.planRevision}};
  return{ok:true,compatible:true,readOnly:true,...query,executionSource:{manifest,digest:H.planExecutionSourceDigest(manifest)}};};
 const first=H.resolvePlanExecutionSource(f.host,f.plan);await new Promise(setImmediate);
 const controller=new AbortController(),second=H.resolvePlanExecutionSource(f.host,{...f.plan,id:'second',planFile:'plans/second.yaml'},controller.signal);
 const cancelled=assert.rejects(second,/cancel|abort/i);await new Promise(setImmediate);const before=[...calls];controller.abort();
 release();await first;await cancelled;
 assert.deepEqual(before,['plans/p.yaml']);assert.deepEqual(calls,['plans/p.yaml']);
});
test('a queued Plan source check keeps its network deadline until actual request admission',async t=>{
 const {RequestBudget,defaultRequestBudgetConfig}=require('../../src/tunnel/RequestBudget.ts');
 const {HttpTunnelClient}=require('../../src/tunnel/TunnelClient.ts');
 const budget=new RequestBudget({...defaultRequestBudgetConfig,maxConcurrentRequestsGlobal:1,maxConcurrentRequestsPerWorker:1});
 const f=fixture(),http=new HttpTunnelClient({localHost:'localhost',localPort:1},budget);
 let release,settled=false,fetches=0,stall=false;
 const occupied=budget.run('manual_refresh',()=>new Promise(resolve=>release=resolve),{userInitiated:true});
 await new Promise(setImmediate);
 t.mock.timers.enable({apis:['setTimeout','Date']});
 t.mock.method(AbortSignal,'timeout',ms=>{const controller=new AbortController();setTimeout(()=>controller.abort(new DOMException('deadline expired','TimeoutError')),ms);return controller.signal;});
 t.mock.method(global,'fetch',async(_url,options)=>{fetches++;assert.equal(options.signal.aborted,false);
  if(stall)return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  const query=JSON.parse(options.body);return new Response(JSON.stringify({ok:true,compatible:true,readOnly:true,...query,executionSource:f.s}));});
 f.host.client.getWorkerPlanCodeScope=(_worker,query,options)=>http.getPlanCodeScope(query,options);
 const pending=H.resolvePlanExecutionSource(f.host,f.plan);pending.then(()=>settled=true,()=>settled=true);
 try{
  await new Promise(setImmediate);t.mock.timers.tick(15001);await new Promise(setImmediate);
  assert.equal(fetches,0);assert.equal(settled,false,'time in the request queue must not expire an unstarted network request');
  release();await occupied;assert.deepEqual(await pending,f.s);assert.equal(fetches,1);
  stall=true;
  let ended=false;const stalledRead=H.verifyWorkerPlanSource(f.host,'w',f.plan);stalledRead.then(()=>ended=true,()=>ended=true);
  const timedOut=assert.rejects(stalledRead,/20 秒无有效响应/);
  await new Promise(setImmediate);t.mock.timers.tick(15001);await new Promise(setImmediate);
  assert.equal(ended,false,'the user-approved source check remains active beyond the former 15-second deadline');
  t.mock.timers.tick(5000);await timedOut;
  assert.equal(fetches,2,'an admitted stalled request retains its existing network inactivity limit');
 }finally{release();await occupied;await pending.catch(()=>{});}
});

test('caller cancellation still removes a queued Plan source check without sending it',async()=>{
 const {RequestBudget,defaultRequestBudgetConfig}=require('../../src/tunnel/RequestBudget.ts');
 const {HttpTunnelClient}=require('../../src/tunnel/TunnelClient.ts');
 const budget=new RequestBudget({...defaultRequestBudgetConfig,maxConcurrentRequestsGlobal:1,maxConcurrentRequestsPerWorker:1});
 const f=fixture(),http=new HttpTunnelClient({localHost:'localhost',localPort:1},budget),controller=new AbortController();let release;
 const occupied=budget.run('manual_refresh',()=>new Promise(resolve=>release=resolve),{userInitiated:true});await new Promise(setImmediate);
 f.host.client.getWorkerPlanCodeScope=(_worker,query,options)=>http.getPlanCodeScope(query,options);
 const pending=H.resolvePlanExecutionSource(f.host,f.plan,controller.signal);const rejected=assert.rejects(pending,/abort|cancel/i);
 controller.abort(new Error('cancel source check'));await rejected;release();await occupied;
 assert.equal(f.plan.executionSource,undefined);
});
test('fresh per-plan evidence permits idle dispatch despite unrelated whole-project versions',async()=>{
 const f=fixture(),workers=[{workerId:'w',online:true,idleGpuIds:['0'],declaredJobPaths:true,idleGpuAdmission:true,codeFingerprint:'new-global'}],queue={schemaVersion:1,plans:[f.plan]};
 await H.inspectPlanCodeSlots(f.host,queue,workers);assert.equal(f.calls,2);assert.deepEqual(workers[0].compatiblePlans,['p']);
 const a=Q.allocateAvailable(queue,workers,{requireIdleGpuAdmission:true,localIdleOnly:true});assert.equal(a.dispatches.length,1);assert.equal(a.dispatches[0].workerId,'w');assert.equal(a.queue.plans[0].codeFingerprint,'old-global');
 f.plan.schedulingMode='server_prequeue';assert.equal(P.allocateServerPrequeue(queue,workers.map(w=>({...w,weight:1}))).dispatches.length,1);
 await H.verifyWorkerPlanSource(f.host,'w',f.plan);assert.equal(f.calls,3,'the launch boundary queries again instead of reusing a result');
});
test('a rejected or offline source is never authorized by an otherwise matching project fingerprint',async()=>{
 const f=fixture();f.host.client.getWorkerPlanCodeScope=async()=>{throw Error('mounted code changed: train.py');};
 const workers=[{workerId:'w',online:true,idleGpuIds:['0'],declaredJobPaths:true,idleGpuAdmission:true,codeFingerprint:'old-global'}],queue={schemaVersion:1,plans:[f.plan]};
 await H.inspectPlanCodeSlots(f.host,queue,workers);assert.equal(Q.allocateAvailable(queue,workers,{requireIdleGpuAdmission:true}).dispatches.length,0);
 assert.match(Q.allocateAvailable(queue,workers).queue.plans[0].jobs[0].blockReason,/train.py/);
});
test('local confirmation checks only the frozen source paths and rejects real changes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'simpleex-source-local-'));fs.mkdirSync(path.join(root,'plans'));fs.writeFileSync(path.join(root,'plans/p.yaml'),'plan','utf8');fs.writeFileSync(path.join(root,'train.py'),'code','utf8');
 const s=source();await H.verifyLocalPlanSource(root,s);fs.writeFileSync(path.join(root,'results.csv'),'new results','utf8');await H.verifyLocalPlanSource(root,s);
 fs.writeFileSync(path.join(root,'train.py'),'bad!','utf8');await assert.rejects(H.verifyLocalPlanSource(root,s),/PLAN_SOURCE_CHANGED.*train.py/);
});
test('automatic preparation filters results and cache before hashing while manual transfer input remains intact',()=>{
 const manifest={'train.py':{size:1},'configs/a.yaml':{size:2},'experiments/results/a.json':{size:3},'work_dirs/a/job_config.yaml':{size:4},'utils/__pycache__/a.pyc':{size:5},'models/.cache/x.json':{size:6},'artifacts/model_cache/model.pt':{size:7}};
 const filtered=H.runSourceManifest(manifest);assert.deepEqual(Object.keys(filtered),['train.py','configs/a.yaml','artifacts/model_cache/model.pt']);assert.equal(Object.keys(manifest).length,7);
 const text=fs.readFileSync('src/extension/legacy.ts','utf8');const start=text.indexOf('async function buildLocalCodeManifest('),end=text.indexOf('async function listLocalCodePaths(',start),fn=text.slice(start,end);
 assert.ok(fn.indexOf('options.executionOnly')<fn.indexOf('hashLocalCodeFiles('));
});
test('one slow source query does not hold the idle Worker which has already verified its inputs',async()=>{
 const f=fixture();f.host.workerActionTargets=()=>[{id:'w'},{id:'slow'}];f.host.lastWorkerProbes.slow={status:'ok',capabilities:{endpoints:{planCodeScope:1}}};
 const base=f.host.client.getWorkerPlanCodeScope;let release;
 f.host.client.getWorkerPlanCodeScope=async(id,r)=>id==='slow'&&r.executionSource?await new Promise(resolve=>{release=()=>resolve({ok:true,compatible:true,readOnly:true,...r});}):base(id,r);
 const workers=['w','slow'].map(workerId=>({workerId,online:true,idleGpuIds:['0'],declaredJobPaths:true,idleGpuAdmission:true,codeFingerprint:'new-global'}));
 await H.inspectPlanCodeSlots(f.host,{plans:[f.plan]},workers);assert.deepEqual(workers[0].compatiblePlans,['p']);assert.equal(workers[1].compatiblePlans,undefined);
 assert.equal(Q.allocateAvailable({schemaVersion:1,plans:[f.plan]},workers).dispatches[0].workerId,'w');release();
});

test('a completed source read is consumed by the next queue round before its refresh expires',async t=>{
 const f=fixture();f.plan.executionSource=f.s;
 let release;f.host.client.getWorkerPlanCodeScope=(_worker,r)=>new Promise(resolve=>{release=()=>resolve({ok:true,compatible:true,readOnly:true,...r,executionSource:f.s});});
 const workers=()=>[{workerId:'w',online:true,idleGpuIds:['0'],declaredJobPaths:true,idleGpuAdmission:true,codeFingerprint:'new-global'}];
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const first=workers(),pending=H.inspectPlanCodeSlots(f.host,{plans:[f.plan]},first);
 await new Promise(setImmediate);t.mock.timers.tick(350);await pending;
 assert.equal(Q.allocateAvailable({schemaVersion:1,plans:[f.plan]},first).dispatches.length,0);
 release();await new Promise(setImmediate);t.mock.timers.tick(2500);
 const next=workers(),round=H.inspectPlanCodeSlots(f.host,{plans:[f.plan]},next);
 await new Promise(setImmediate);t.mock.timers.tick(350);await round;
 assert.deepEqual(next[0].compatiblePlans,['p'],'a successful unread result must survive until a queue round adopts it');
 assert.equal(Q.allocateAvailable({schemaVersion:1,plans:[f.plan]},next).dispatches.length,1);
 f.host.client.getWorkerPlanCodeScope=async()=>{throw Error('PLAN_SOURCE_CHANGED: train.py');};
 await assert.rejects(H.verifyWorkerPlanSource(f.host,'w',f.plan),/PLAN_SOURCE_CHANGED/,'the final launch check must still reject source changed after the background observation');
});

test('background source refresh gates new starts without replacing memory or output-isolation wait reasons',async()=>{
 const f=fixture();f.plan.executionSource=f.s;
 const memoryReason='等待自动显存观察（连续 10 分钟）、预算余量或用户并行配额；未派发';
 f.plan.jobs[0].blockReason=memoryReason;
 f.plan.jobs.push({...f.plan.jobs[0],index:1,outputIsolationBlocked:{reason:'ACTIVE_TRANSFER'},blockReason:'旧产物隔离未完成'});
 let release;f.host.client.getWorkerPlanCodeScope=(_worker,r)=>new Promise(resolve=>{release=()=>resolve({ok:true,compatible:true,readOnly:true,...r,executionSource:f.s});});
 const workers=[{workerId:'w',online:true,idleGpuIds:['0'],declaredJobPaths:true,idleGpuAdmission:true,codeFingerprint:'new-global'}];
 await H.inspectPlanCodeSlots(f.host,{plans:[f.plan]},workers);
 const blocked=Q.allocateAvailable({schemaVersion:1,plans:[f.plan]},workers);
 assert.equal(blocked.dispatches.length,0);assert.equal(blocked.queue.plans[0].jobs[0].blockReason,memoryReason);
 assert.equal(blocked.queue.plans[0].jobs[1].blockReason,'旧产物隔离未完成');
 release();await new Promise(setImmediate);
});

test('a delayed source failure is consumed and reported instead of being replaced by another background read',async t=>{
 const f=fixture();f.plan.executionSource=f.s;let rejectRead;
 f.host.client.getWorkerPlanCodeScope=()=>new Promise((_resolve,reject)=>{rejectRead=reject;});
 const workers=()=>[{workerId:'w',online:true,idleGpuIds:['0'],declaredJobPaths:true,idleGpuAdmission:true,codeFingerprint:'old-global'}];
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const first=H.inspectPlanCodeSlots(f.host,{plans:[f.plan]},workers());
 await new Promise(setImmediate);t.mock.timers.tick(350);await first;
 rejectRead(Error('PLAN_SOURCE_CHANGED: configs/model.yaml'));await new Promise(setImmediate);t.mock.timers.tick(2500);
 const next=workers(),round=H.inspectPlanCodeSlots(f.host,{plans:[f.plan]},next);
 await new Promise(setImmediate);t.mock.timers.tick(350);await round;
 const allocation=Q.allocateAvailable({schemaVersion:1,plans:[f.plan]},next);
 assert.equal(allocation.dispatches.length,0);assert.match(allocation.queue.plans[0].jobs[0].blockReason,/configs\/model.yaml/);
});
