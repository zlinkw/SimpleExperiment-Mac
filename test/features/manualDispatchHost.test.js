const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
function fixture(){
 const picks={showQuickPick:async()=>undefined};
 const file=path.resolve('dist/extension/ManualDispatchHost.js'),loaded=new Module(file,module);loaded.filename=file;loaded.paths=Module._nodeModulePaths(path.dirname(file));
 const requireBase=loaded.require.bind(loaded);loaded.require=id=>id==='vscode'?{window:picks,workspace:{workspaceFolders:[{uri:{fsPath:'project'}}]}}:requireBase(id);loaded._compile(fs.readFileSync(file,'utf8'),file);
 let sync=0,queries=0;const h={client:{getGpu:async()=>({w:[{index:0,utilizationPercent:100,excluded:true}]}),getWorkerTasks:async()=>{queries++;return {capabilities:{taskLifecycle:2}}}},enabledWorkerConfigs:()=>[{id:'w'},{id:'b'}],
  assertExecutionWorkersReady(){},assertExecutionAgentProjectsReady(){},workerActionTargets:()=>[],ensureCodeReadyForRun:async()=>sync++,captureProjectContext:()=>({}),
  manualDispatchInFlight:new Set(),postState(){},tickDistributedQueue(){},loadDistributedQueue:async()=>({plans:[]}),
  lastCodeSyncState:{fingerprint:'hash'},lastWorkerTaskSnapshots:new Map()};
 return {host:new loaded.exports.ManualDispatchHost(h,'project'),h,picks,get sync(){return sync},get queries(){return queries}};
}
test('actual manual Host accepts a busy excluded visible GPU, preserves sync and queries every Worker',async()=>{
 const f=fixture();await f.host.ports().prepare({codeFingerprint:'hash',jobs:[{manualDispatch:{workerId:'w',gpuId:'0',stage:'preparing'}}]});
 assert.equal(f.sync,1);assert.equal(f.queries,2);
});
test('manual selection pauses automatic dispatch before opening pickers and resumes after cancellation',async()=>{
 const f=fixture();f.picks.showQuickPick=async()=>{assert.equal(f.h.manualDispatchInFlight.size,1);return undefined;};
 const result=await f.host.dispatch({workflowId:'p',indices:[0],expectedCommands:{0:''}},true);
 assert.equal(result.status,'cancelled');assert.equal(f.h.manualDispatchInFlight.size,0);
});
test('health client replacement is harmless, but an actual endpoint change still cancels manual dispatch',()=>{
 const f=fixture();let target={id:'w',local_agent_url:'http://configured:1234',project_dir:'/project'};
 f.h.workerActionTargets=()=>[target];const ports=f.host.ports();
 f.h.client={};assert.doesNotThrow(()=>ports.assertCurrent());
 target={...target,local_agent_url:'http://changed:2345'};assert.throws(()=>ports.assertCurrent(),/连接/);
});
test('manual preparation uses the shared actively queried snapshot instead of overwriting it with an undated response',async()=>{
 const f=fixture();let reads=0;f.h.readWorkerTaskSnapshot=async(id,options)=>{assert.equal(options.fresh,true);reads++;};
 await f.host.ports().prepare({codeFingerprint:'hash',jobs:[{manualDispatch:{workerId:'w',gpuId:'0',stage:'preparing'}}]});
 assert.equal(reads,2);assert.equal(f.queries,0);assert.equal(f.h.lastWorkerTaskSnapshots.size,0);
});
test('unknown Worker and invisible GPU fail before sync, stopping or deletion',async()=>{
 const f=fixture();await assert.rejects(f.host.dispatch({confirm:true,workflowId:'p',indices:[0],workerId:'missing',gpuId:'0'}),/未启用|不存在/);
 await assert.rejects(f.host.ports().prepare({jobs:[{manualDispatch:{workerId:'w',gpuId:'99',stage:'preparing'}}]}),/GPU 不可见/);assert.equal(f.sync,0);assert.equal(f.queries,0);
});
test('actual GPU picker offers Worker-local automatic dispatch even when no GPU snapshot is available',async()=>{
 const f=fixture();let queue={plans:[{id:'p',revision:'r',codeFingerprint:'hash',resultPathPolicy:'declared',executionMode:'train',jobs:[
  {index:0,case:'c',seed:1,attempt:0,status:'pending',outputDir:'work/c',collectionResultCsv:'result/c.csv'}]}]},picks=0;
 f.h.loadDistributedQueue=async()=>structuredClone(queue);f.h.saveDistributedQueue=async(_,next)=>{queue=structuredClone(next);};
 f.h.lastWorkerProbes={w:{status:'ok',capabilities:{endpoints:{manualDispatch:1}}}};
 f.h.client.getGpu=async()=>{throw Error('GPU query unavailable');};
 f.h.sendDistributedJob=async()=>assert.fail('automatic placement must wait for normal budget admission');
 f.host.review=async()=>true;
 f.picks.showQuickPick=async rows=>{picks++;if(picks===1)return rows.find(row=>row.id==='w');
  assert.equal(rows.length,1);assert.equal(rows[0].label,'此服务器自动派发');return rows[0];};
 const result=await f.host.dispatch({workflowId:'p',indices:[0],expectedCommands:{0:''}},true);
 assert.equal(result.status,'submitted');assert.equal(picks,2);assert.equal(f.sync,1);assert.equal(f.queries,2);
 const job=queue.plans[0].jobs[0];assert.equal(job.automaticWorkerId,'w');assert.equal(job.manualDispatch,undefined);assert.equal(job.commandId,undefined);
});

// r82（0.5.414）接线钉（诚实标注为源码钉，行为面由 manualJobDispatch/serverQueueDispatch 行为用例承载）：
// 现场缺陷之一正是 Host.review 只回 assignedExperimentIndices，runReplacement.blocked 里的准入排除在
// 派发层不可见，被阻断 job 又被当普通未完成 job 处理。413 上红。
test('r82 red wiring pin: Host.review must surface the structured isolation block, not only accepted indices',()=>{
 const src=fs.readFileSync(path.resolve('src/extension/ManualDispatchHost.ts'),'utf8');
 assert.match(src,/runReplacement[\s\S]{0,400}blocked|blocked:[\s\S]{0,200}stage/,'review 必须把 replaceRunOutputs 的结构化 blocked 透传给派发层');
 assert.match(src,/accepted/,'接受子集与阻断集合必须成对返回（{accepted, blocked}），取消仍返回 false');
});

test('actual Host cancels an unacknowledged original command and actively verifies the fence before a new placement',async()=>{
 const f=fixture(),events=[];let cancelled=false,sends=0;
 let queue={plans:[{id:'p',projectId:'project-id',planFile:'plans/p.yaml',revision:'revision',codeFingerprint:'hash',executionMode:'train_test',resultPathPolicy:'declared',
  jobs:[{index:0,attempt:0,status:'unknown',workerId:'b',commandId:'original',case:'c',seed:42,outputDir:'work/job',collectionResultCsv:'tmp/job.csv'}]}]};
 f.h.loadDistributedQueue=async()=>structuredClone(queue);f.h.saveDistributedQueue=async(_,next)=>{queue=structuredClone(next);};
 f.h.lastWorkerProbes={w:{status:'ok',capabilities:{endpoints:{manualDispatch:1}}},b:{status:'ok'}};
 f.h.client.postWorkerAction=async(worker,action,payload)=>{
  assert.equal(worker,'b');assert.equal(action,'stop-worker-task');assert.equal(payload.targetCommandId,'original');
  assert.equal(payload.stopBoundary,'local_command');cancelled=true;events.push('cancel');throw Error('stop response lost');
 };
 f.h.client.getWorkerTasks=async(worker,options)=>{
  if(!options?.queries)return {capabilities:{taskLifecycle:2}};
  assert.equal(worker,'b');assert.equal(options.queries[0].commandId,'original');events.push(cancelled?'verified-cancelled':'missing');
  return {queryComplete:true,capabilities:{taskLifecycle:2},tasks:[{observation:{lifecycleProtocol:2,commandId:'original',workerId:'b',projectId:'project-id',cancelled,observedAt:new Date().toISOString()}}]};
 };
 f.host.review=async()=>{assert.equal(cancelled,true);assert.equal(events.at(-1),'verified-cancelled');events.push('review');return true;};
 f.h.sendDistributedJob=async(plan,job,worker,gpu,command)=>{assert.equal(worker,'w');assert.equal(gpu,'0');assert.notEqual(command,'original');assert.equal(events.at(-1),'review');sends++;events.push('send');};
 const result=await f.host.dispatch({confirm:true,workflowId:'p',indices:[0],workerId:'w',gpuId:'0',expectedCommands:{0:'original'},stopRunning:true});
 assert.equal(result.status,'submitted');assert.equal(sends,1);assert.ok(events.indexOf('verified-cancelled')<events.indexOf('review'));
 assert.equal(queue.plans[0].jobs[0].manualDispatch.stage,'sent');
});
