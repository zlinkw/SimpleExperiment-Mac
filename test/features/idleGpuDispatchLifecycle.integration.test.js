const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const ts=require('typescript'),{spawnSync}=require('node:child_process');
require('../_helpers/registerTsRequire');
const root=path.resolve(__dirname,'../..');
const DistributedPlanQueue=require('../../src/features/DistributedPlanQueue.ts');
const DistributedSchedulingPolicy=require('../../src/features/DistributedSchedulingPolicy.ts');
const GpuQuotaScheduling=require('../../src/features/GpuQuotaScheduling.ts');
const GpuJobOwnership=require('../../src/features/GpuJobOwnership.ts');
const PlanExecutionMode=require('../../src/features/PlanExecutionMode.ts');
const PlanCodeScopeHost=require('../../src/extension/PlanCodeScopeHost.ts');
const AgentTmuxPolicy_1=require('../../src/tunnel/AgentTmuxPolicy.ts');
const source=fs.readFileSync(path.join(root,'src/extension/legacy.ts'),'utf8');
const helper=source.match(/^function durableCodeProofRequestFields\([\s\S]*?^\}/m)?.[0];assert.ok(helper);
const durableCodeProofRequestFields=new Function(`${helper}\nreturn durableCodeProofRequestFields;`)();
// 2026-10-23 Windows 整文件 20s 门禁返修：本文件 21 案例约 23 次调用 provider()，每次都对 2.18MB legacy.ts
// 重新 createSourceFile+transpile——重复解析是已证实的可消除成本（Linux 等价基线 duration_ms 5329→1486）；
// Windows 原全文件 20s 超时是否由此触发尚未证实：单案例 Windows 诊断 299ms/exit0 仅说明单案例不必挂起，
// 原超时证据保留，最终余量以最终原 20s 门禁为准。修复＝fixture 编译缓存：AST 解析提升到模块级只解析一次，编译产物按 names 集合缓存；
// 同一 names 集合的源码切片、成员数量断言与编译输出逐字节一致，vm 沙箱仍每次新建（extra 上下文可异），
// 案例名/参数/断言零删减，语义完全等价。
const ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);
const providerCompiled=new Map();
function provider(names,extra={}) {
  const key=JSON.stringify(names);
  let code=providerCompiled.get(key);
  if(code===undefined) {
    const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='RealtimeTunnelPanelProvider');
    const members=cls.members.filter(n=>names.includes(n.name?.getText(ast)));
    assert.equal(members.length,names.length);
    code=ts.transpileModule('class Provider {'+members.map(n=>n.getText(ast)).join('\n')+'};Provider;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    providerCompiled.set(key,code);
  }
  return vm.runInNewContext(code,
    {...require('../_helpers/nativeHostScope'),DistributedPlanQueue,DistributedSchedulingPolicy,GpuJobOwnership,PlanExecutionMode,durableCodeProofRequestFields,workspaceRoot:()=>root,setInterval,clearInterval,
      mapLimited:async(rows,_limit,callback)=>Promise.all(rows.map(callback)),errorMessage:error=>error.message,...extra});
}

const endpoints={declaredJobPaths:true,formalJobIdentityEnv:1,taskShellEnvironment:1,projectManagedValidation:1,gpuQuotaScheduling:1,gpuMemoryBudgetScheduling:1};
function gpu(id,free=24){return {index:String(id),memoryTotalMb:32768,memoryFreeMb:free*1024,memoryUsedMb:(32-free)*1024,utilizationPercent:free<22?99:0,processes:[]};}
function nativeFixture(options={}){
  const projectRoot=options.projectRoot||root;
  const Provider=provider(options.methods||['tickDistributedQueueCore'],options.context||{}),p=new Provider(),remote={a:[],b:[]},sent=[],errors=[];
  let queue=DistributedPlanQueue.enqueuePlan(DistributedPlanQueue.emptyDistributedQueue(),{projectId:DistributedPlanQueue.canonicalProjectId(projectRoot),
    schedulingMode:'local_idle',planFile:'p.yaml',revision:'r',codeFingerprint:'f',executionMode:'train',
    jobs:[0,1].map(index=>({index,case:'bus',seed:index,outputDir:'runs/'+index,collectionResultCsv:'tmp/result/'+index+'.csv'}))},'p');
  let builds=0,gpus={a:[gpu(0)],b:[gpu(0)]};
  Object.assign(p,{taskLifecycleProtocol:2,distributedQueueGeneration:0,distributedPlanStopEpoch:0,distributedNextFailureDetailAt:Infinity,
    unifiedDomainState:()=>({active:false,blocked:""}), // 块B：夹具根未登记 → 既有单机派发/发送路径（含真实 send 法身用例）
    distributedNextPostprocessAt:Infinity,distributedLaunchInFlight:new Set(),distributedNextProbeAt:0,lastWorkerProbes:{a:{status:'ok',capabilities:{endpoints}},b:{status:'ok',capabilities:{endpoints}}},
    lastCodeSyncState:{workerVersions:{a:{fingerprint:'f'},b:{fingerprint:'f'}}},workerActionTargets:()=>[{id:'a'},{id:'b'}],workerCodeSyncTargets:()=>[],
    enabledWorkerConfigs:()=>[{id:'a'},{id:'b'}],schedulerSettings:()=>({}),gpuOwnerConfig:()=>({}),isRealtimeMode:()=>true,
    projectTopologyAssessment:()=>({mode:'worker_pool'}),recordActionError:e=>errors.push(e),postState(){},scheduleDistributedPostprocess(){},
    queuePlanArtifactSyncStatusCheck(){},detachStaleDistributedTick(){},buildDistributedJobCodeManifest:async()=>{builds++;return {};},
    loadDistributedQueue:async()=>structuredClone(queue),saveDistributedQueue:async(_root,value,options)=>{
      if(options?.mutateLatest) queue=options.mutateLatest(structuredClone(queue));
      else { assert.ok(value,'fixture requires an explicit queue or mutateLatest');queue=structuredClone(value); }
    },
    client:{getGpu:async()=>gpus,postWorkerAction:async()=>{throw Error('unexpected stop/post');}},
  });
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(workerId=>({workerId,queryComplete:true,generatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),
    capabilities:{taskLifecycle:2,durablePlanQueue:true,idleGpuAdmission:true,schemaVersion:1},tasks:structuredClone(remote[workerId]||[])}));
  const ack=(plan,job,workerId,gpuId,commandId)=>({lifecycleProtocol:2,status:'unknown',commandId});
  p.sendDistributedJob=async(...args)=>{const j=queue.plans.find(x=>x.id===args[0].id).jobs.find(x=>x.index===args[1].index);
    assert.equal(j.commandId,args[4],'identity must persist before RPC');assert.equal(j.workerId,args[2]);
    sent.push({plan:args[0].id,index:args[1].index,worker:args[2],gpu:args[3],commandId:args[4]});return ack(...args);};
  function publish(index,status,planId='p'){
    const plan=queue.plans.find(x=>x.id===planId),j=plan.jobs.find(x=>x.index===index),at=new Date().toISOString();
    assert.ok(j.workerId&&j.commandId);const dead=['failed','completed'].includes(status);
    const observation={lifecycleProtocol:2,commandId:j.commandId,projectId:plan.projectId,workerId:j.workerId,observedAt:at,
      tmux:{dead,phase:dead?'running':status,windowId:'@'+index,paneId:'%'+index,...(dead?{exitCode:status==='failed'?1:0}:{})},
      result:dead?{runId:j.commandId,status,present:true,verified:true,identityMatches:true,artifactsComplete:status==='completed',exitCode:status==='failed'?1:0}:null,
      runtimeDiagnostics:{schemaVersion:1,runId:j.commandId,commandId:j.commandId,state:'clear',count:0,scanComplete:true}};
    const task={commandId:j.commandId,projectId:plan.projectId,workerId:j.workerId,outputDir:j.outputDir,collectionResultCsv:j.collectionResultCsv,
      codeFingerprint:plan.codeFingerprint,observation};
    remote[j.workerId]=[...(remote[j.workerId]||[]).filter(x=>x.commandId!==j.commandId),task];
  }
  function own(index,status){const j=queue.plans[0].jobs[index];Object.assign(j,{status,workerId:'a',gpuId:String(index),commandId:'original-'+index,runKey:'original-'+index});publish(index,status);}
  return {p,sent,errors,ack,publish,own,remote,stored:()=>queue,setGpu:x=>{gpus=x;},builds:()=>builds};
}
function queuedFixture(){const f=nativeFixture();f.own(0,'completed');f.own(1,'queued');return f;}

test('G1 real native tick persists identity and admits only a Worker with current GPU quota evidence',async()=>{
  const f=nativeFixture();f.setGpu({a:[gpu(0)],b:[gpu(0,16)]});
  let gpuStarted=false,release;const gate=new Promise(r=>{release=r;}),read=f.p.readWorkerTaskSnapshotBatch;
  f.p.readWorkerTaskSnapshotBatch=async ids=>{await gate;return read(ids);};
  const get=f.p.client.getGpu;f.p.client.getGpu=async()=>{gpuStarted=true;return get();};
  const tick=f.p.tickDistributedQueueCore();try{for(let i=0;i<20&&!gpuStarted;i++)await new Promise(setImmediate);assert.equal(gpuStarted,true);}
  finally{release();await tick;}
  assert.equal(f.builds(),1);assert.equal(f.sent.length,1);assert.equal(f.sent[0].worker,'a');assert.equal(f.sent[0].gpu,'0');
  assert.equal(f.stored().plans[0].jobs[0].status,'unknown','POST does not prove startup');
  assert.equal(f.stored().plans[0].jobs[1].workerId,undefined);
  const hosted=nativeFixture();hosted.stored().plans[0].schedulingMode='server_prequeue';hosted.setGpu({a:[gpu(0)],b:[gpu(0,16)]});
  await hosted.p.tickDistributedQueueCore();assert.equal(hosted.sent.length,1,'pool admission still uses current quota for historical hosted preferences');
});
test('a native queued command keeps its original allocation over repeated ticks',async()=>{
  const f=queuedFixture(),before=f.stored().plans[0].jobs[1].commandId;for(let i=0;i<4;i++)await f.p.tickDistributedQueueCore();
  assert.equal(f.sent.length,0);assert.equal(f.stored().plans[0].jobs[1].commandId,before);assert.equal(f.stored().plans[0].jobs[1].attempt,0);
});
test('busy owner GPU telemetry never automatically cancels and migrates an accepted native command',async()=>{
  const f=queuedFixture();let stops=0;f.p.client.postWorkerAction=async()=>stops++;f.setGpu({a:[gpu(1,1)],b:[gpu(0)]});
  for(let i=0;i<3;i++)await f.p.tickDistributedQueueCore();
  const job=f.stored().plans[0].jobs[1];assert.equal(stops,0);assert.equal(f.sent.length,0);assert.equal(job.workerId,'a');
  assert.equal(job.commandId,'original-1');assert.equal(job.attempt,0);assert.equal(job.automaticRetry,undefined);
});
test('unknown or missing GPU telemetry cannot authorize a native queued-task release',async()=>{
  for(const a of [[{index:'0'}],[]]){const f=queuedFixture();let stops=0;f.p.client.postWorkerAction=async()=>stops++;
    f.setGpu({a,b:[gpu(0)]});await f.p.tickDistributedQueueCore();assert.equal(stops,0);assert.equal(f.sent.length,0);}
});
test('a fresh Worker start supersedes queued metadata without a second command or release',async()=>{
  const f=queuedFixture();f.publish(1,'running');await f.p.tickDistributedQueueCore();const j=f.stored().plans[0].jobs[1];
  assert.equal(j.status,'running');assert.equal(j.commandId,'original-1');assert.equal(j.attempt,0);
  assert.equal(j.reassignmentWorkerId,undefined);assert.equal(f.sent.length,0);
});
test('unconfirmed native commands remain unknown and never resend the original POST',async()=>{
  const f=nativeFixture();f.own(0,'completed');f.own(1,'running');f.remote.a=[];const command=f.stored().plans[0].jobs[1].commandId;
  for(let i=0;i<4;i++)await f.p.tickDistributedQueueCore();
  assert.equal(f.sent.length,0);assert.equal(f.stored().plans[0].jobs[1].status,'unknown');
  assert.equal(f.stored().plans[0].jobs[1].commandId,command);assert.equal(f.stored().plans[0].jobs[1].attempt,0);
});
test('snapshot grace preserves the age of fresh evidence and rejects expired or failed cache authority',async()=>{
  const Provider=provider(['readWorkerTaskSnapshotBatch'],{setTimeout,clearTimeout}),p=new Provider();let release;
  const slow=new Promise(r=>{release=r;});p.readWorkerTaskSnapshot=()=>slow;
  const at=new Date().toISOString(),cache={workerId:'a',queryComplete:true,generatedAt:at,fetchedAt:at,capabilities:{taskLifecycle:2},tasks:[{commandId:'verified'}]};
  p.cachedWorkerTaskSnapshot=()=>cache;
  try{
    const fresh=await p.readWorkerTaskSnapshotBatch(['a'],{graceMs:0});assert.equal(fresh[0].tasks[0].commandId,'verified');assert.equal(fresh[0].fetchedAt,at);
    cache.fetchedAt=cache.generatedAt=new Date(Date.now()-60000).toISOString();
    const expired=await p.readWorkerTaskSnapshotBatch(['a'],{graceMs:0});assert.equal(expired[0].pending,true);assert.equal(expired[0].tasks.length,0);
    cache.error='offline';const failed=await p.readWorkerTaskSnapshotBatch(['a'],{graceMs:0});
    assert.equal(failed[0].error,'offline');assert.equal(DistributedPlanQueue.hasFreshDurableSnapshot(failed[0]),false);
  }finally{release(cache);}
});
test('partial native failure keeps its completed sibling and never creates an automatic attempt',async()=>{
  const f=nativeFixture();f.own(0,'completed');f.own(1,'failed');
  f.p.localPlanMetadata={plans:[],archivedPlans:[{originalFile:'p.yaml'}]};await f.p.tickDistributedQueueCore();
  f.p.localPlanMetadata.plans=[{planFile:'p.yaml'}];for(let i=0;i<3;i++)await f.p.tickDistributedQueueCore();
  const p=f.stored().plans[0];assert.equal(p.jobs[0].status,'completed');assert.equal(p.jobs[1].status,'failed');
  assert.equal(p.jobs[1].attempt,0);assert.equal(p.jobs[1].automaticRetry,undefined);assert.equal(p.jobs[1].commandId,'original-1');assert.equal(f.sent.length,0);
});
test('GPU or code availability changes cannot silently retry a failed native command',async()=>{
  const f=nativeFixture();f.own(0,'completed');f.own(1,'failed');f.stored().plans[0].jobs[1].error='CUDA out of memory';
  f.p.lastCodeSyncState.workerVersions={a:{fingerprint:'other'},b:{fingerprint:'other'}};await f.p.tickDistributedQueueCore();
  f.p.lastCodeSyncState.workerVersions={a:{fingerprint:'f'},b:{fingerprint:'f'}};f.setGpu({a:[gpu(0,1)],b:[gpu(0,1)]});await f.p.tickDistributedQueueCore();
  f.setGpu({a:[gpu(0)],b:[gpu(0)]});await f.p.tickDistributedQueueCore();
  const j=f.stored().plans[0].jobs[1];assert.equal(j.status,'failed');assert.equal(j.attempt,0);assert.equal(j.automaticRetry,undefined);assert.equal(f.sent.length,0);
});
test('majority native startup failure never changes command generations or automatically dispatches retries',async()=>{
  const f=nativeFixture();f.own(0,'running');f.own(1,'running');await f.p.tickDistributedQueueCore();
  f.publish(0,'failed');f.publish(1,'failed');for(let i=0;i<3;i++)await f.p.tickDistributedQueueCore();
  for(const j of f.stored().plans[0].jobs){assert.equal(j.status,'failed');assert.equal(j.commandId,'original-'+j.index);assert.equal(j.attempt,0);assert.equal(j.automaticRetry,undefined);}
  assert.equal(f.sent.length,0);
});
test('actual send rejects an unsafe historical attempt before any Worker POST',async()=>{
  const f=nativeFixture(),Provider=provider(['sendDistributedJob']),send=new Provider().sendDistributedJob;
  const p=f.stored().plans[0],j=p.jobs[1];Object.assign(j,{attempt:2,outputDir:'runs/1/attempts/old',history:[{status:'failed',commandId:'old'}]});
  let posts=0;f.p.client.postWorkerAction=async()=>posts++;
  await assert.rejects(send.call(f.p,p,j,'a','0','new'),/HISTORICAL_ATTEMPT_READ_ONLY/);
  assert.equal(posts,0);assert.equal(j.attempt,2);assert.equal(j.history.length,1);assert.equal(p.jobs[0].status,'pending');
});
test('two code versions dispatch only to their independently verified Workers under explicit quota',async()=>{
  const f=nativeFixture();f.p.schedulerSettings=()=>({gpuJobsPerCard:2});f.p.lastCodeSyncState.workerVersions.b.fingerprint='g';
  await f.p.saveDistributedQueue(root,DistributedPlanQueue.enqueuePlan(f.stored(),{projectId:DistributedPlanQueue.canonicalProjectId(root),
    schedulingMode:'local_idle',planFile:'next.yaml',revision:'r2',codeFingerprint:'g',executionMode:'train',
    jobs:[0,1].map(index=>({index,case:'pad',seed:index,outputDir:'next/'+index,collectionResultCsv:'tmp/result/next'+index+'.csv'}))},'next'));
  await f.p.tickDistributedQueueCore();
  assert.deepEqual(f.sent.map(x=>({plan:x.plan,worker:x.worker})),[{plan:'p',worker:'a'},{plan:'next',worker:'b'}]);
  assert.ok(f.stored().plans.every(p=>p.jobs.filter(j=>j.status==='unknown').length===1 && p.jobs.filter(j=>j.status==='pending').length===1), 'each unmeasured configuration must retain its other job locally');
  assert.ok(f.stored().plans.every(p=>p.jobs.find(j=>j.status==='unknown').gpuMemoryReservation.probe));
  assert.equal(f.p.distributedLaunchInFlight.size,0);
});
test('code upload holds allocation while native completion is still observed and persisted',async()=>{
  const f=nativeFixture();f.own(0,'running');f.publish(0,'completed');f.p.codeSyncInFlight=1;
  await f.p.tickDistributedQueueCore();assert.equal(f.stored().plans[0].jobs[0].status,'completed');
  assert.equal(f.stored().plans[0].jobs[1].status,'pending');assert.equal(f.stored().plans[0].jobs[1].workerId,undefined);assert.equal(f.sent.length,0);
});
test('receipt commits stay serialized and a failed commit drains outstanding RPCs before rejection',async()=>{
  const f=nativeFixture();let release;const gate=new Promise(r=>{release=r;}),save=f.p.saveDistributedQueue;
  let inflight=0,max=0,commitFailed=false,slowDone=false,calls=0;
  f.p.saveDistributedQueue=async(r,q)=>{inflight++;max=Math.max(max,inflight);try{
    if(q.plans[0].jobs.some(j=>j.status==='unknown')&&!commitFailed){commitFailed=true;throw Error('commit failure');}
    await new Promise(setImmediate);await save(r,q);
  }finally{inflight--;}};
  f.p.sendDistributedJob=async(...args)=>{calls++;if(args[1].index===1){await gate;slowDone=true;}return f.ack(...args);};
  const tick=f.p.tickDistributedQueueCore();let settled=false;const outcome=tick.then(()=>{settled=true;return null;},e=>{settled=true;return e;});
  try{for(let i=0;i<40&&calls<2;i++)await new Promise(setImmediate);assert.equal(calls,2);assert.equal(commitFailed,false,'native ACK is not a per-job runtime fact');assert.equal(settled,false);}
  finally{release();}
  const error=await outcome;assert.match(error.message,/commit failure/);assert.equal(commitFailed,true);assert.equal(slowDone,true);assert.equal(max,1);
});
test('late native receipt after a generation change cannot save or publish the old run',async()=>{
  const f=nativeFixture();let release;const gate=new Promise(r=>{release=r;});let calls=0,posts=0;
  f.p.postState=()=>posts++;f.p.sendDistributedJob=async(...args)=>{calls++;await gate;return f.ack(...args);};
  const tick=f.p.tickDistributedQueueCore();
  try{for(let i=0;i<40&&calls<2;i++)await new Promise(setImmediate);assert.equal(calls,2);f.p.distributedQueueGeneration++;
    const before=JSON.stringify(f.stored());release();await tick;assert.equal(JSON.stringify(f.stored()),before);assert.equal(posts,0);
  }finally{release();await tick;}
});
test('G1 actual native RPC preserves mode, quota and explicit GPU admission while returning only unknown',async()=>{
  const Provider=provider(['sendDistributedJob']),p=new Provider(),F='f'.repeat(64);const sent=[];
  Object.assign(p,{distributedQueueGeneration:0,distributedPlanStopEpoch:0,unifiedDomainState:()=>({active:false,blocked:""}),workerActionTargets:()=>[{id:'w',condaEnv:'env'}],enabledWorkerConfigs:()=>[{id:'w'}],
    schedulerSettings:()=>({}),lastWorkerProbes:{w:{capabilities:{endpoints,actionEndpoints:{'register-code-sync-proof':true}}}},
    lastWorkerTaskSnapshots:new Map([[root+'\u0000w',{capabilities:{taskLifecycle:2}}]]),
    lastCodeSyncState:{workerVersions:{w:{fingerprint:F,manifestDigest:F,codeSyncProofId:'a'.repeat(64)}}},
    client:{postWorkerAction:async(_w,_a,q)=>{sent.push(q);return {status:'queued'};}}});
  const plan={id:'p',projectId:'project',planFile:'p.yaml',revision:'r',codeFingerprint:F,enqueuedAt:'date',planJobCount:1,jobs:[{}],resultPathPolicy:'declared',schedulingMode:'server_prequeue',executionMode:'train'};
  const job={index:0,case:'bus',seed:42,attempt:0,lifecycleProtocol:2,outputDir:'runs/0',collectionResultCsv:'tmp/result/0.csv',globalJobId:'p:0'};
  assert.equal((await p.sendDistributedJob(plan,job,'w',undefined,'same-command')).status,'unknown');
  assert.equal(sent[0].schedulingMode,'server_prequeue');assert.equal(sent[0].requireIdleGpu,false);assert.equal(Object.hasOwn(sent[0],'gpuId'),false);
  assert.equal(sent[0].options.gpuQuotaScheduling,1);assert.equal(sent[0].options.maxConcurrentGpus,0);assert.equal(sent[0].opId,'same-command');
  plan.schedulingMode='local_idle';await p.sendDistributedJob(plan,job,'w','0','new-command');
  assert.equal(sent[1].requireIdleGpu,true);assert.equal(sent[1].gpuId,'0');assert.equal(sent[1].mode,'train');
});
const agentSource=fs.readFileSync(path.join(root,'src/clusterAgentRuntime.legacy.ts'),'utf8');
function definition(name){const start=agentSource.indexOf(`\ndef ${name}(`)+1;assert.ok(start>0,name);
  const end=agentSource.indexOf('\ndef ',start+1);return agentSource.slice(start,end<0?undefined:end);}
// 2026-10-23 G2/G3 交付返修（父矩阵证据：同字节 -c 55.5/58.2ms vs 文件入口 484.8/426.1ms，stdout 逐字节等价；
// Windows 原 10s 超时未稳定复现，不宣称根因，本改动仅消除已实测的文件入口开销）：
// 执行交付改 python -X utf8 -c <script>，原 .py 仍写出保留取证；解释器/环境/10s/windowsHide/真实 status
// 与全部 21 案例断言原样，不 import/exec 完整 runtime。
function python(script){const file=path.join(os.tmpdir(),`simpleex-lifecycle-${process.pid}-${Date.now()}.py`);fs.writeFileSync(file,script,'utf8');
  try {const run=spawnSync(process.env.PYTHON||'python',['-X','utf8','-c',script],{encoding:'utf8',timeout:10000,windowsHide:true});
    assert.equal(run.status,0,run.stderr||run.error?.message);return JSON.parse(run.stdout.trim());}
  finally { /* Preserve bounded probe. */ }}
test('G2 real Agent idle admission guard rejects a competing process and untrusted telemetry',()=>{
  const result=python(`import json, math\nGPU_IDLE_UTIL_THRESHOLD=5\nGPU_IDLE_MEM_THRESHOLD_MB=200\nDISTRIBUTED_GPU_RESERVATIONS={}\ndef read_json(*args): return {}\ndef active_cleanup_operations(root): return []\ndef formal_job_path_capable(root): return True\ndef path_for(*args): return ''\ndef read_durable_plan_queue(*args): return {'jobs':[]}\ndef gpu_row_id(row): return str(row['gpuId'])\ndef gpu_row_busy(*args,**kwargs): return False\n${definition('_durable_gpu_busy_reason')}\nrow={'gpuId':'0','utilizationPercent':0,'memoryUsedMb':7,'processes':[{'pid':7}]}\nprint(json.dumps([_durable_gpu_busy_reason('', '0', 'c', [row]),_durable_gpu_busy_reason('', '0', 'c', [{'gpuId':'0'}])]))\n`);
  assert.deepEqual(result,['gpu_busy','gpu_busy'],'G2 admission must reject occupied or unknown GPU');
});
test('G3 actual task API syncs exit evidence into durable ledger immediately, with mode and terminal metadata',()=>{
  const fields=agentSource.match(/^DURABLE_PLAN_IDENTITY_FIELDS\s*=\s*\([\s\S]*?^\)/m)[0];
  const result=python(`import json, threading\nSCHEMA_VERSION=1\nWORKER_TASK_SNAPSHOT_LOCK=threading.RLock()\n${fields}\ndef now_iso(): return '2026-09-29T00:00:00Z'\n${['durable_plan_value','durable_plan_identity','durable_plan_same_identity','durable_plan_public_identity','durable_plan_task_status','sync_durable_plan_task_rows','durable_plan_public_task','api_worker_tasks'].map(definition).join('\n')}\nROW={key:'x' for key in DURABLE_PLAN_IDENTITY_FIELDS}\nROW.update({'status':'running','planJobCount':1,'enqueuedAt':now_iso(),'schedulingMode':'server_prequeue','gpuId':''})\nTASK=dict(ROW)\nLEDGER={'jobs':[ROW]}\ndef path_for(*args): return ''\ndef read_json(*args): return {'tasks':[TASK]}\ndef read_durable_plan_queue(*args): return LEDGER\ndef write_durable_plan_queue(root,data): pass\ndef read_runtime_json_cached(*args): return None\ndef active_cleanup_operations(root): return []\ndef formal_job_path_capable(root): return True\ndef reconcile_worker_task_exit_codes(root): TASK.update({'status':'completed','exitCode':0,'finishedAt':now_iso()})\nprint(json.dumps(api_worker_tasks('')['tasks'][0]))\n`);
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

// Merged 2026-10-23 (integration-latest): feature 侧两个独立新契约（GPU 读取与任务快照并行、server_prequeue 设置本地派发）与 native 套件互补，连同其所需 fixture 保留；其余 feature 重命名案例与 latest native 套件一一对应，语义由 native 套件承载（映射见 .audit/integration-latest/report.md）。
const capabilities={taskLifecycle:2,durablePlanQueue:true,idleGpuAdmission:true,schemaVersion:1};
function snapshot(workerId,tasks=[]) {const time=new Date().toISOString();return {workerId,capabilities,queryComplete:true,generatedAt:time,fetchedAt:time,tasks};}
function fixture() {
  const Provider=provider(['tickDistributedQueueCore']);const p=new Provider();
  Object.assign(p,{taskLifecycleProtocol:2,distributedQueueGeneration:0,distributedPlanStopEpoch:0,distributedNextFailureDetailAt:Infinity,
    distributedNextPostprocessAt:Infinity,distributedLaunchInFlight:new Set()});
  p.isRealtimeMode=()=>true;p.projectTopologyAssessment=()=>({mode:'worker_pool'});p.workerCodeSyncTargets=()=>[];
  p.workerActionTargets=()=>[{id:'a'},{id:'b'}];p.enabledWorkerConfigs=()=>[{id:'a'},{id:'b'}];
  p.lastWorkerProbes={a:{status:'ok',capabilities:{endpoints}},b:{status:'ok',capabilities:{endpoints}}};
  p.lastCodeSyncState={workerVersions:{a:{fingerprint:'f'},b:{fingerprint:'f'}}};p.schedulerSettings=()=>({});p.gpuOwnerConfig=()=>({});
  const errors=[],calls=[],observed=new Map();let saves=0,posts=0,manifests=0;
  p.recordActionError=e=>errors.push(e);p.postState=()=>posts++;p.scheduleDistributedPostprocess=()=>{};p.queuePlanArtifactSyncStatusCheck=()=>{};
  p.buildDistributedJobCodeManifest=async()=>{manifests++;return {};};
  p.readWorkerTaskSnapshotBatch=async ids=>ids.map(id=>snapshot(id,observed.get(id)||[]));
  p.client={getGpu:async()=>({a:[{index:'0',utilizationPercent:0,memoryTotalMb:24576,memoryUsedMb:7,processes:[]}],
    b:[{index:'0',utilizationPercent:99,memoryTotalMb:24576,memoryUsedMb:5000,processes:[{username:'foreign'}]}]})};
  const input=id=>({projectId:DistributedPlanQueue.canonicalProjectId(root),executionMode:'train',planFile:id+'.yaml',revision:'r',codeFingerprint:'f',
    jobs:[0,1].map(index=>({index,case:'bus',seed:index,outputDir:`runs/${id}/${index}`,collectionResultCsv:`results/${id}-${index}.csv`}))});
  let stored=DistributedPlanQueue.enqueuePlan(DistributedPlanQueue.emptyDistributedQueue(),input('p'),'p');
  p.loadDistributedQueue=async()=>structuredClone(stored);p.saveDistributedQueue=async(_r,value)=>{saves++;stored=structuredClone(value);};
  p.sendDistributedJob=async(plan,job,workerId,gpuId,commandId)=>{
    assert.equal(stored.plans.find(x=>x.id===plan.id).jobs[job.index].commandId,commandId,'persist exact identity before RPC');
    calls.push({plan:plan.id,index:job.index,workerId,gpuId,commandId});return {lifecycleProtocol:2,commandId,status:'accepted'};
  };
  function task(job,status='running',plan=stored.plans[0]) {
    const observation={lifecycleProtocol:2,projectId:plan.projectId,workerId:job.workerId,commandId:job.commandId,observedAt:new Date().toISOString(),result:null,
      tmux:{windowId:'@'+(job.index+1),paneId:'%'+(job.index+1),dead:['failed','completed'].includes(status),
        ...(['failed','completed'].includes(status)?{exitCode:status==='failed'?1:0}:{phase:status==='queued'?'bound':'running'})}};
    if(status==='completed')observation.result={runId:job.commandId,status:'completed',present:true,verified:true,identityMatches:true,artifactsComplete:true,exitCode:0};
    return {...job,lifecycleProtocol:2,workflowId:plan.id,projectId:plan.projectId,experimentIndex:job.index,planFile:plan.planFile,
      planRevision:plan.revision,codeFingerprint:plan.codeFingerprint,planJobCount:plan.planJobCount,status,observation};
  }
  function bind(index=0,status='unknown') {const job=stored.plans[0].jobs[index];Object.assign(job,{status,workerId:'a',gpuId:'0',commandId:'original-'+index,runKey:'original-'+index});return job;}
  function retireOther() {const job=stored.plans[0].jobs[1];Object.assign(job,{status:'cancelled',commandId:'cancelled-1',workerId:'a'});observed.set('a',[{...task(job),observation:{...task(job).observation,tmux:undefined,cancelled:true}}]);}
  return {p,calls,errors,observed,input,task,bind,retireOther,stored:()=>stored,counts:()=>({saves,posts,manifests})};
}


test('GPU read starts while task snapshots are still pending',async()=>{
  const f=fixture();let release,started=false;const gate=new Promise(r=>release=r),read=f.p.readWorkerTaskSnapshotBatch;
  f.p.readWorkerTaskSnapshotBatch=async ids=>{await gate;return read(ids);};const gpu=f.p.client.getGpu;
  f.p.client.getGpu=async()=>{started=true;return gpu();};const tick=f.p.tickDistributedQueueCore();
  try{for(let i=0;i<50&&!started;i++)await new Promise(setImmediate);assert.equal(started,true);}finally{release();await tick;}
});

test('saved server_prequeue settings keep new unassigned jobs local',async()=>{
  const f=fixture();f.stored().plans[0].schedulingMode='server_prequeue';await f.p.tickDistributedQueueCore();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].gpuId,'0');assert.equal(f.stored().plans[0].localDispatchOverride,true);
});

// The normal native-tick fixture used to replace scheduleDistributedPostprocess with a no-op.
// Keep production tick -> completion scheduler -> per-job merge -> SHA receipt connected here;
// only Worker execution and the network transport are synthetic, inside a private project.
test('native completion ticks mirror every interleaved job across plans once with real file SHA and no training replay',async()=>{
  const projectRoot=fs.mkdtempSync(path.join(os.tmpdir(),'se-plan-job-chain-'));
  const {CompletedJobSyncHost}=require('../../src/extension/CompletedJobSyncHost.ts');
  const {buildScopeStatuses,scopeInventoryPathAllowed}=require('../../src/features/SyncScopeStatus.ts');
  const {planLatestWorkerMerge}=require('../../src/features/SyncLatestMerge.ts');
  const {runSyncScopeBatch}=require('../../src/features/SyncScopeBatch.ts');
  const {loadSyncHolds,safeSyncPath}=require('../../src/features/SyncResolution.ts');
  const {jobArtifactRunGeneration}=require('../../src/features/JobArtifactSyncIdentity.ts');
  const {isUnderMachineStatePrefixes}=require('../../src/features/ProjectRootMap.ts');
  const {normalizeMirrorScopePaths}=require('../../src/features/ProjectMirror.ts');
  const f=nativeFixture({projectRoot,methods:['tickDistributedQueueCore','scheduleDistributedPostprocess',
    'syncCompletedPlanArtifacts','mergeLatestWorkerVersions','patchDistributedJob'],context:{
    workspaceRoot:()=>projectRoot,CompletedJobSyncHost,scopeInventoryPathAllowed,planLatestWorkerMerge,runSyncScopeBatch,
    loadSyncHolds,safeSyncPath,path,jobArtifactRunGeneration,isUnderMachineStatePrefixes,normalizeMirrorScopePaths,
    vscode:{workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback})},Uri:{file:value=>value}},
    isLocalCodeOwnedPath:()=>false,workerFpsyncTaskLabel:()=>'',UiCommandCancelled:class extends Error{},
  }});
  const p=f.p,targets=['a','b','c'].map(id=>({id,host:id+'.invalid',port:2222,user:'synthetic',remotePath:'/synthetic/'+id}));
  const locations=Object.fromEntries(targets.map(t=>[t.id,path.join(projectRoot,'synthetic-workers',t.id)]));
  for(const dir of Object.values(locations))fs.mkdirSync(dir,{recursive:true});
  const crypto=require('node:crypto'),sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  function inventory(id){const result={};function walk(dir,rel=''){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name),key=rel?rel+'/'+entry.name:entry.name;
      if(entry.isDirectory())walk(file,key);else {const st=fs.statSync(file);result[key]={sha256:sha(file),size:st.size,modifiedAtMs:st.mtimeMs};}
    }
  }walk(locations[id]);return result;}
  // Remove the old own-property no-op so this case actually exercises the production scheduler.
  delete p.scheduleDistributedPostprocess;
  Object.assign(p,{context:{globalStorageUri:{fsPath:path.join(projectRoot,'synthetic-old-storage')}},
    captureProjectContext:()=>({root:projectRoot}),projectContextIsCurrent:ctx=>ctx.root===projectRoot,
    workerCodeSyncTargets:()=>targets,enabledWorkerConfigs:()=>targets,sftpServerOptions:row=>row,
    localMachineStateGuard:()=>({prefixes:[],unknown:false}),targetRootGuard:()=>null,
    machineStatePrefixesById:()=>[],machineStatePrefixesForTarget:()=>[],assertSshTransportIdentities:async()=>{},
    prepareCodeSyncRootGuards:async rows=>({guards:new Map(rows.map(t=>[t,{prefixes:[],unknown:false}])),assertBindingsCurrent:()=>{}}),
    refreshSyncScopeStatus:async()=>buildScopeStatuses({local:{},workers:Object.fromEntries(targets.map(t=>[t.id,inventory(t.id)]))},'server-server',['.'],new Set(),{entries:{}}),
    verifiedSftpProjectInventory:async({source})=>({files:inventory(source.id)}),
  });
  p.lastWorkerProbes.c={status:'ok',capabilities:{endpoints}};
  const transfers=[];
  p.simpleSftpApiCall=async(method,request)=>{
    assert.equal(method,'sync.serverToServerFpsync');assert.ok(request.retentionKey);assert.ok(request.generation);
    transfers.push(structuredClone(request));
    for(const rel of request.relativePaths){const dest=path.join(locations[request.destination.id],rel);
      fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(locations[request.source.id],rel),dest);}
    return {ok:true};
  };
  const second=DistributedPlanQueue.enqueuePlan(f.stored(),{projectId:DistributedPlanQueue.canonicalProjectId(projectRoot),
    schedulingMode:'local_idle',planFile:'q.yaml',revision:'r',codeFingerprint:'f',executionMode:'train',
    jobs:[0,1].map(index=>({index,case:'bus',seed:index,outputDir:'runs/q/'+index,collectionResultCsv:'tmp/q/'+index+'.csv'}))},'q');
  Object.assign(f.stored(),second);
  f.own(0,'running');f.own(1,'queued');
  for(const job of f.stored().plans.find(row=>row.id==='q').jobs){Object.assign(job,{status:'queued',workerId:'b',gpuId:String(job.index),commandId:'q-'+job.index,runKey:'q-'+job.index});f.publish(job.index,'queued','q');}
  const expected=[];
  function complete(planId,index){const job=f.stored().plans.find(row=>row.id===planId).jobs.find(row=>row.index===index);
    const rel=job.outputDir+'/model.pth',bytes=planId+'-'+index+'-real-artifact';
    fs.mkdirSync(path.dirname(path.join(locations[job.workerId],rel)),{recursive:true});fs.writeFileSync(path.join(locations[job.workerId],rel),bytes);
    expected.push({planId,index,rel,bytes});f.publish(index,'completed',planId);
  }
  async function tick(){await p.tickDistributedQueueCore();if(p.distributedPostprocessPromise)await p.distributedPostprocessPromise;await new Promise(setImmediate);}
  complete('p',0);await tick();assert.equal(transfers.length,2,'the first job syncs while other jobs are not complete');
  f.publish(1,'running','p');complete('q',0);await tick();assert.equal(transfers.length,4,'another plan completion is not lost');
  complete('p',1);complete('q',1);await tick();
  assert.equal(transfers.length,8,'each of four jobs has exactly two other Worker destinations');
  for(const item of expected){const job=f.stored().plans.find(row=>row.id===item.planId).jobs.find(row=>row.index===item.index);
    assert.equal(job.status,'completed');assert.equal(job.latestArtifactSync.state,'synced');
    for(const t of targets)assert.equal(fs.readFileSync(path.join(locations[t.id],item.rel),'utf8'),item.bytes);
    assert.equal(new Set(targets.map(t=>sha(path.join(locations[t.id],item.rel)))).size,1);
    assert.equal(transfers.filter(t=>t.relativePaths.includes(item.rel)).length,2);
  }
  await tick();assert.equal(transfers.length,8,'repeated completion observations never copy the same content again');
  assert.equal(f.sent.length,0,'observing and syncing completed jobs never restarts their training');
  assert.deepEqual(f.errors,[]);
});

// r49 返修 3：完成态与后台同步失败必须分离——真实 tick 触发生产 scheduleDistributedPostprocess，
// 同步体（syncCompletedPlanArtifacts 入口）可控地保持真实 pending；队列完成状态照常发布且不被后续
// tick 阻塞；释放为真实失败后，仅 diagnostics/原生通知记录错误，绝不改写运行完成状态。
test('a pending automatic sync keeps completed queue state separate and its real failure lands only in diagnostics plus one native notice',async()=>{
  const f=nativeFixture({methods:['tickDistributedQueueCore','scheduleDistributedPostprocess'],context:{
    UiCommandCancelled:class UiCommandCancelled extends Error{constructor(message='操作已取消。',code='USER_CANCELLED'){super(message);this.name='UiCommandCancelled';this.code=code;}},
  }});
  delete f.p.scheduleDistributedPostprocess; // 与 G4 同一配方：去掉 own-property no-op，走生产调度成员
  const notes=[];let startedCalls=0,releaseSync;
  const pending=new Promise((_resolve,reject)=>{releaseSync=()=>reject(Error('mirror storage write failed'));});
  let started;const startedSignal=new Promise(r=>started=r);
  Object.assign(f.p,{captureProjectContext:()=>({}),projectContextIsCurrent:()=>true,
    showNativePanelMessage:m=>notes.push(structuredClone(m)),
    syncCompletedPlanArtifacts:async()=>{startedCalls++;started();await pending;}});
  // :170 同配方让 tick 真实"观察"到完成事件（开场即 completed 无 newTerminal，生产不会调度）
  f.own(0,'running');f.publish(0,'completed');f.own(1,'running');
  await f.p.tickDistributedQueueCore();
  assert.equal(f.stored().plans[0].jobs[0].status,'completed','真实完成事件经 tick 落盘后队列完成状态照常发布');
  assert.ok(f.p.distributedPostprocessPromise,'真实生产 schedule 登记了后台同步 promise，不是 no-op');
  await startedSignal;
  assert.equal(startedCalls,1,'后台同步体真实启动且恰好一次');
  assert.equal(f.stored().plans[0].jobs[0].status,'completed','完成状态不等待后台同步');
  assert.equal(notes.length,0,'pending 期间零通知');
  await f.p.tickDistributedQueueCore(); // 同步在途期间再次 tick：不阻塞、不重复派发
  assert.equal(startedCalls,1,'在途 promise 未被重复派发（生产 single-promise 守卫生效）');
  assert.equal(f.stored().plans[0].jobs[0].status,'completed');
  const promise=f.p.distributedPostprocessPromise;
  releaseSync();
  await assert.rejects(promise,/mirror storage write failed/,'释放为生产 distributedPostprocessPromise 的真实失败');
  assert.equal(f.p.distributedPostprocessPromise,undefined,'在途 promise 照常清空');
  assert.equal(f.p.completedPlanMirrorDiagnostics?.status,'failed','失败仅落 diagnostics');
  assert.equal(f.p.completedPlanMirrorDiagnostics.consecutiveFailures,1);
  assert.match(f.p.completedPlanMirrorDiagnostics.reason,/mirror storage write failed/);
  assert.equal(notes.length,1,'真实外层失败恰一条原生通知');
  assert.match(notes[0].message,/自动产物同步未完成：mirror storage write failed/);
  assert.match(notes[0].message,/运行完成状态不变，可在对应 Job 行重新同步/);
  assert.equal(f.stored().plans[0].jobs[0].status,'completed','同步失败绝不改写运行完成状态（完成态分离）');
});

// r50 已证源码分支 + r53 去重上下文隔离（父审核 r53-main-review-blocked.json）：外层失败回调既不把旧
// scope 的普通 Error 弹进切换后的新项目，也不能让"从未提示过/属另一 scope"的同 reason 失败压掉当前
// 项目首条真提示。capture/match 用生产同事实 {root,generation}（仅标量，不存 signal/client）。
// 双场景矩阵：A 未提示（原 r50 断言全保留）与 A 已实际提示 → 切 B → B 首条同 reason 必恰 1 条
// → B 同 scope 连续再失败（第二、三轮）总提示不追加、key 在被抑制轮中保留 → 成功 ready 后同错可再提示。
// 旧码（全局 reason 去重、无 scope）在"B 首错"一步必红：Native 先用旧生产 0e6ea0e4 跑本 suite 留真实红。
test('notice suppression is scoped to the context that actually received it across a workspace switch',async()=>{
 for(const aNoticedBeforeSwitch of [false,true]){
  const f=nativeFixture({methods:['tickDistributedQueueCore','scheduleDistributedPostprocess'],context:{
    UiCommandCancelled:class UiCommandCancelled extends Error{constructor(message='操作已取消。',code='USER_CANCELLED'){super(message);this.name='UiCommandCancelled';this.code=code;}},
  }});
  delete f.p.scheduleDistributedPostprocess;
  const notes=[];const ctx={root:'projectA',generation:1};const REASON='同步已停止：项目、连接或清理操作已变化。';
  let mode=aNoticedBeforeSwitch?'fail':'pending',releaseSync,started,startedSignal=new Promise(r=>{started=r;});
  Object.assign(f.p,{captureProjectContext:()=>({root:ctx.root,generation:ctx.generation}),
    projectContextIsCurrent:c=>c.root===ctx.root&&c.generation===ctx.generation,
    showNativePanelMessage:m=>notes.push(structuredClone(m)),
    syncCompletedPlanArtifacts:async()=>{if(mode==='pending'){started();await new Promise(r=>{releaseSync=r;});throw Error(REASON);}if(mode==='fail')throw Error(REASON);}});
  f.own(0,'running');f.publish(0,'completed');f.own(1,'running');
  await f.p.tickDistributedQueueCore();
  const settle=async p=>{await p.catch(()=>{});await new Promise(setImmediate);};
  if(aNoticedBeforeSwitch){
    await settle(f.p.distributedPostprocessPromise);
    assert.equal(notes.length,1,'A scope 首条真实故障恰一次原生提示');
    mode='pending';startedSignal=new Promise(r=>{started=r;});
    f.p.scheduleDistributedPostprocess(root,true); // A 第二轮同 reason 失败：已提示过，切走前也不再刷屏
  }
  const stalePromise=f.p.distributedPostprocessPromise;assert.ok(stalePromise,'旧项目后台同步已真实开始');
  await startedSignal;
  ctx.generation++; // 工作区切换：A 捕获的 generation 不再匹配
  const promise=stalePromise;
  releaseSync();
  await settle(promise);
  assert.equal(notes.length,aNoticedBeforeSwitch?1:0,'旧 scope 的错误（无论此前是否提示过）绝不向切换后的新项目追加原生提示（B 契约：仅当前项目真故障才弹）');
  assert.equal(f.p.completedPlanMirrorDiagnostics?.status,'failed','诊断记录不受上下文守卫影响，照常保留');
  assert.equal(f.p.completedPlanMirrorDiagnostics.reason,REASON,'原因原样保留');
  assert.equal(f.p.distributedPostprocessPromise,undefined,'在途 promise 照常清空');
  const baseline=aNoticedBeforeSwitch?1:0;
  mode='fail'; // B scope（新 generation）首条同 reason 失败：旧码在此被全局去重吞掉 ⇒ 旧码反证必红
  f.p.scheduleDistributedPostprocess(root,true);await settle(f.p.distributedPostprocessPromise);
  assert.equal(notes.length,baseline+1,'B scope 首条同 reason 真失败必恰一次提示（旧 scope 未提示/已提示都绝不压制新项目）');
  assert.match(notes.at(-1).message,/自动产物同步未完成/);
  f.p.scheduleDistributedPostprocess(root,true);await settle(f.p.distributedPostprocessPromise);
  f.p.scheduleDistributedPostprocess(root,true);await settle(f.p.distributedPostprocessPromise);
  assert.equal(notes.length,baseline+1,'B scope 同 reason 连续第二、三轮失败总提示仍不追加');
  const scopeKey=JSON.stringify([ctx.root,ctx.generation]);
  assert.ok((f.p.completedPlanMirrorDiagnostics.notifiedScopes||[]).some(s=>s===scopeKey),
    '去重标记只登记真实弹过的捕获 scope（root+generation 标量），且在被抑制的后续轮中保留');
  mode='ok';f.p.scheduleDistributedPostprocess(root,true);await settle(f.p.distributedPostprocessPromise);
  assert.equal(f.p.completedPlanMirrorDiagnostics.status,'ready','成功复位保留');
  mode='fail';f.p.scheduleDistributedPostprocess(root,true);await settle(f.p.distributedPostprocessPromise);
  assert.equal(notes.length,baseline+2,'ready 复位后同 reason 再失败可再次提示');
 }
});
