const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), syncFs=require('node:fs'), path=require('node:path'), os=require('node:os'), vm=require('node:vm'), crypto=require('node:crypto');
const queueApi=require('../../dist/features/DistributedPlanQueue');
const {HostOperationLeaseManager}=require('../../dist/core/HostOperationLease');
const source=syncFs.readFileSync(require.resolve('../../dist/extension/legacy.js'),'utf8');
function methods(from,to) { const a=source.indexOf(from),b=source.indexOf(to,a);assert.ok(a>=0&&b>a);return source.slice(a,b); }
test('cross-window queue writes merge fresh disk state and reject duplicate Plans',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'queue-resource-evidence-'));
  const context={DistributedPlanQueue:queueApi,fs,fsNode:syncFs,path,process,crypto,workspaceRoot:()=> 'D:/project',UiCommandRemotePending:class extends Error {},
    StateStore_1:require('../../dist/state/StateStore'),errorMessage:error=>String(error?.message||error),compactSensitiveText:value=>String(value||'').slice(0,240)};
  vm.createContext(context);
  vm.runInContext('this.operations={'+methods('async withQueueWriteResource(root, work)','async patchDistributedJob(').replace(/}\s+async saveDistributedQueue/,'}, async saveDistributedQueue')+'};',context);
  const host=id=>({ ...context.operations,hostOperationLease:new HostOperationLeaseManager({leasePath:path.join(root,'legacy.json'),windowId:id}),
    context:{globalStorageUri:{fsPath:root}},distributedQueueWritePromise:Promise.resolve(),distributedQueueRoot:'D:/project',distributedQueueCache:queueApi.emptyDistributedQueue(),
    distributedQueueGeneration:0,detachStaleDistributedTick:()=>undefined });
  const input=(name,id)=>queueApi.enqueuePlan(queueApi.emptyDistributedQueue(),{planFile:'plans/'+name+'.yaml',revision:'r',codeFingerprint:'c',jobs:[{index:0,case:'bus',seed:1,outputDir:'work/'+name}]},id);
  const a=host('a'),b=host('b');await Promise.all([a.saveDistributedQueue('D:/project',input('a','a'),{appendPlanId:'a'}),b.saveDistributedQueue('D:/project',input('b','b'),{appendPlanId:'b'})]);
  const file=queueApi.distributedQueuePath(root,'D:/project');const disk=JSON.parse(await fs.readFile(file,'utf8'));
  assert.deepEqual(disk.plans.map(row=>row.planFile).sort(),['plans/a.yaml','plans/b.yaml']);
  await assert.rejects(b.saveDistributedQueue('D:/project',input('a','duplicate'),{appendPlanId:'duplicate'}),/阻止重复提交/);
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).plans.length,2);
  await assert.rejects(a.saveDistributedQueue('D:/project',a.distributedQueueCache),/另一窗口已更新/);
});
test('preflight bypasses locks; start and stop lock only their output directory',async()=>{
  const context={path,workspaceRoot:()=> 'D:/project',operationResultPlanFile:body=>body.planFile};vm.createContext(context);
  vm.runInContext('this.operations={'+methods('async withRemoteActionResource(workerId, action, body, work)','async postTunnelAction(')+'};',context);
  let calls=0,record;
  const host={...context.operations,setupConfig:{workerTunnels:[{id:'worker',workerHost:'EXAMPLE.COM',workerSshPort:2222}]},expectedWorkerAgentProjectRoot:()=>'/remote/project',
    hostOperationLease:{run:async(input,work)=>{calls++;record=input;return work();}}};
  for(const action of ['validate-plan','dry-run-plan','stop-scheduler-operation','cancel-operation']) assert.equal(await host.withRemoteActionResource('worker',action,{},async()=>42),42);
  assert.equal(calls,0);
  await host.withRemoteActionResource('worker','start-worker-task',{planFile:'plans/a.yaml',outputDir:'work/a'},async()=>42);
  assert.equal(record.resources[0].server,'example.com:2222');
  assert.equal(record.resources.length,1);assert.equal(record.resources[0].target,'/remote/project/work/a');
  const leaseRoot=await fs.mkdtemp(path.join(os.tmpdir(),'launch-resource-lease-'));
  const manager=id=>new HostOperationLeaseManager({leasePath:path.join(leaseRoot,'lease.json'),windowId:id,heartbeatMs:0});
  const left=manager('left'),right=manager('right');
  const resourceHost=manager=>({...host,hostOperationLease:manager});
  let release;
  const held=new Promise(resolve=>{release=resolve;});
  let entered=0;
  const first=resourceHost(left).withRemoteActionResource('worker','start-worker-task',{planFile:'plans/a.yaml',outputDir:'work/a'},async()=>{entered++;await held;});
  await new Promise(setImmediate);
  const second=resourceHost(right).withRemoteActionResource('worker','start-worker-task',{planFile:'plans/a.yaml',outputDir:'work/b'},async()=>{entered++;});
  await second;assert.equal(entered,2,'same Plan with distinct outputs must start concurrently');
  await assert.rejects(resourceHost(right).withRemoteActionResource('worker','start-worker-task',{planFile:'plans/a.yaml',outputDir:'work/a'},async()=>{}),/正在由另一个操作修改/);
  await assert.rejects(resourceHost(right).withRemoteActionResource('worker','stop-worker-task',{planFile:'plans/a.yaml',outputDir:'work/a'},async()=>{}),/正在由另一个操作修改/);
  release();await first;
});
