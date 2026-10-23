const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsPromises=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),ts=require('typescript');
require('../_helpers/registerTsRequire');
const Q=require('../../src/features/DistributedPlanQueue.ts');
const PulledTaskControl=require('../../src/features/PulledTaskControl.ts');
const {atomicWriteText}=require('../../src/state/StateStore.ts');
const {cleanupDigest}=require('../../dist/features/PlanCleanup.js');

// 返修（2026-10-22）P0：真实生产缺失路径不产 rows——本套件不手写 collect scope：
// 真实 dist/extension/PlanCleanupHost.collectManaged + 真实 ManifestCleanup.discoverManifestCandidates
// + 真实 PlanCleanup 服务 + 真实队列文件 + 沙箱物理文件系统后端（只读核验；execute 仅 rm 沙箱内路径）。
// 缺失判定只认 ENOENT/ENOTDIR；其它 stat 错误按真实语义抛出/记 error，绝不伪造成 missing。
// 场景：本机缺/remote 有、全缺、删除后全缺、外置 CSV 仍存在、外置 CSV 未知、删后重启恢复、清单归属未核实。
// 不连任何真实主机、不真实 SSH；清理适配器仅在本地沙箱目录做真实 stat/rm。

function extractMethodBody(source,name){
  const at=source.indexOf(name);
  if(at<0) throw Error('METHOD_NOT_FOUND '+name);
  let i=source.indexOf('{',at),depth=0,end=-1;
  for(let j=i;j<source.length;j++){if(source[j]==='{')depth++;else if(source[j]==='}'){depth-=1;if(!depth){end=j;break;}}}
  if(end<0) throw Error('METHOD_UNBALANCED '+name);
  return source.slice(i+1,end);
}
const legacySource=fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
const retryBody=ts.transpileModule(extractMethodBody(legacySource,'async retryPulledJob(plan, job, root, isCurrent, anomalyOnly = false) {'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const makeRetry=new Function('fs','path','crypto','PlanCodeScopeHost','PulledTaskControl','vscode','UiCommandCancelled','makeOpId','errorMessage','PlanRunHost',
  'return async function (plan, job, root, isCurrent, anomalyOnly = false) {'+retryBody+'};');
class UiCommandCancelled extends Error {}
const ast=ts.createSourceFile('host.ts',legacySource,ts.ScriptTarget.Latest,true);
function legacyMethods(names,globals={}){let cls;function visit(n){if(ts.isClassDeclaration(n)&&n.name?.text==='RealtimeTunnelPanelProvider')cls=n;ts.forEachChild(n,visit)}visit(ast);
  const members=cls.members.filter(n=>names.includes(n.name?.getText(ast)));assert.equal(members.length,names.length,names.join(','));
  return vm.runInNewContext(ts.transpileModule('class Host{'+members.map(n=>n.getText(ast)).join('\n')+'};Host',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
    {AbortController,errorMessage:e=>e.message,compactSensitiveText:s=>String(s).slice(0,240),require:()=>({getUpdater:()=>undefined}),syncGpuQuotaPolicies:async()=>({}),
     DistributedPlanQueue:Q,fs:fsPromises,path,atomicWriteText,...globals});}
const QueueHost=legacyMethods(['saveDistributedQueue','withQueueWriteResource']);
const hostTemplate=fs.readFileSync(path.resolve(__dirname,'../../dist/extension/PlanCleanupHost.js'),'utf8');

async function loadRealPlanCleanupHost(root,planHostPorts){
  const modulePath=path.resolve(__dirname,'../../dist/extension/PlanCleanupHost.js'),exports={};
  const {createRequire}=require('node:module');
  const localRequire=createRequire(modulePath);
  const vscodeStub={workspace:{workspaceFolders:[{uri:{fsPath:root}}],textDocuments:[]},window:{}};
  await vm.runInNewContext(hostTemplate,{exports,require:name=>name==='vscode'?vscodeStub:name==='./PlanCleanupPanel'?{}:localRequire(name),AbortSignal,AbortController,console},{});
  return new exports.PlanCleanupHost(planHostPorts,root);
}

function world(options={}){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'se-jobdel-prod-'));
  const storage=path.join(root,'plugin-storage');
  const remoteRoot=path.join(root,'server');
  const planFile='experiments/plans/a.yaml';
  fs.mkdirSync(path.join(root,'experiments/plans'),{recursive:true});fs.mkdirSync(remoteRoot,{recursive:true});
  const text='mode: train\ncases: [c0, c1]\n';fs.writeFileSync(path.join(root,planFile),text);
  const revision=crypto.createHash('sha256').update(text).digest('hex');
  const projectId=Q.canonicalProjectId(root);
  const outputDir='work_dirs/a0';
  const resultCsv=options.externalCsv?'experiments/results/a0.csv':'work_dirs/a0/m.csv';
  const markerRel=outputDir+'/artifact_manifest.json';
  const binding={planFile,runId:'cmd-old',outputDir,resultCsv,index:0,case:'c0',seed:1};
  function plant(nodeRoot,withMarker=true,withFiles=true){
    fs.mkdirSync(path.join(nodeRoot,outputDir),{recursive:true});
    if(withFiles)fs.writeFileSync(path.join(nodeRoot,outputDir,'out.txt'),'payload');
    if(!options.externalCsv)fs.writeFileSync(path.join(nodeRoot,outputDir,'m.csv'),'a,b\n1,2\n');
    if(withMarker)fs.writeFileSync(path.join(nodeRoot,markerRel),JSON.stringify(binding));
  }
  if(options.onRemote!==false)plant(remoteRoot,!options.withoutManifest);
  if(options.onLocal)plant(root,!options.withoutManifest);
  if(options.externalCsv&&options.csvPresent!==false){fs.mkdirSync(path.join(remoteRoot,'experiments/results'),{recursive:true});
    fs.writeFileSync(path.join(remoteRoot,resultCsv),'metric\n1\n');}
  const stats={deletes:0,previews:0,removes:[],checkShapes:[]};
  const backend=new Map();let tokenSeq=0;
  const statReal=async(p)=>{try{return await fsPromises.stat(p);}catch(error){
    if(error&&(error.code==='ENOENT'||error.code==='ENOTDIR'))return null;throw error;}};
  const posixAbs=(nodeObj,relative)=>String(nodeObj.root).split(path.sep).join('/')+'/'+relative;
  const sftp=async(method,params)=>{
    const abs=(nodeObj,relative)=>path.join(nodeObj.root,relative);
    if(method==='files.cleanup.preview'){
      stats.previews+=1;
      const targets=[];
      for(const row of params.targets){
        const st=await statReal(abs(params.node,row.relativePath));
        if(!st){targets.push({relativePath:row.relativePath,type:row.type,missing:true});continue;}
        targets.push({relativePath:row.relativePath,type:row.type,destination:row.destination,absolutePath:posixAbs(params.node,row.relativePath),
          fingerprint:'fp-'+cleanupDigest(st.isDirectory()?fs.readdirSync(abs(params.node,row.relativePath)):fs.readFileSync(abs(params.node,row.relativePath))).slice(0,16),
          contentFingerprint:'cf-'+cleanupDigest([String(st.ino),String(st.size)]).slice(0,16),
          device:String(st.dev),inode:String(st.ino),size:Number(st.size),missing:false,inventory:[]});
      }
      const token='bp'+cleanupDigest([params.node&&params.node.id,params.targets.map(t=>t.relativePath),tokenSeq++]).replace(/[^0-9a-f]/g,'').slice(0,44);
      const record={token,digest:cleanupDigest(targets.map(({destination,inventory,...identity})=>identity)),
        rootIdentity:{path:params.node.root},targets,confirmations:0,node:params.node,action:params.action};
      backend.set(token,record);
      return {...JSON.parse(JSON.stringify(record)),
        safety:{gitRepositoryAncestors:true,readOnlyReceiptCheck:true,formalJobOwner:true,immutableArchiveBatch:true,batchPreviewCapacity:4096,managedObservation:1}};
    }
    if(method==='files.cleanup.inspect'){
      if(options.inspectErrorFor===String(params.node.id)+'\0'+params.target.relativePath)
        throw Object.assign(Error('EIO 模拟：后端无法应答'),{code:'EIO'});
      const st=await statReal(abs(params.node,params.target.relativePath));
      if(!st)return {target:{type:params.target.type,missing:true},executorsChecked:true,executors:[]};
      const manifests=[];
      if(params.manifestOnly&&st.isDirectory()){
        const marker=await statReal(abs(params.node,markerRel));
        if(marker){const bytes=await fsPromises.readFile(abs(params.node,markerRel));
          manifests.push({relativePath:markerRel,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
            binding:JSON.parse(String(bytes)),planHints:[planFile]});}
      }
      return {target:{type:params.target.type,absolutePath:posixAbs(params.node,params.target.relativePath),missing:false,rootIdentity:{path:params.node.root},
        manifests,fingerprint:'fp-'+cleanupDigest([params.node.root,params.target.relativePath]).slice(0,16)},rootIdentity:{path:params.node.root},executorsChecked:true,executors:[]};
    }
    const record=backend.get(params.token);assert.ok(record,'preview 必须先于任何后端动作');
    if(method==='files.cleanup.status'){
      // 真实观察语义：逐目标实时 stat；消失 → completed+gone（服务据此产生 path_absence 回执）
      const observations=await Promise.all(record.targets.map(async t=>{
        const gone=!(await statReal(abs(record.node,t.relativePath)));
        // 真实语义：executors 空数组+executorsChecked=true 只表示本轮查询成功、
        // 当前无活动执行器（新任务刚启动执行器尚未出现也是这个形态），不是「没有任务」。
        const executorEvidence={executors:[],executorsChecked:true};
        return t.missing?{state:'completed',...executorEvidence}:{state:gone?'completed':'pending',...(gone?{status:'gone'}:{}),...executorEvidence};}));
      return {...JSON.parse(JSON.stringify(record)),observations,states:observations.map(o=>o.state),batchExecuting:false};}
    if(method==='files.cleanup.confirm'){
      if(params.phase===2)assert.equal(record.confirmations,1,'第 2 相位必须紧接同一会话的第 1 相位');
      record.confirmations=params.phase;return {ok:true};}
    if(method==='files.cleanup.preflight')return {ok:true};
    if(method==='files.cleanup.verify')return {ok:true};
    if(method==='files.cleanup.check'){const target=record.targets[params.index];
      const st=await statReal(abs(record.node,target.relativePath));
      const shape=st?{state:'pending',verifiedBy:'actual_filesystem',executors:[],executorsChecked:true,rootIdentity:record.rootIdentity}
        :{state:'completed',verifiedBy:'path_absence',executors:[],executorsChecked:true,rootIdentity:record.rootIdentity};
      stats.checkShapes.push({executors:shape.executors,executorsChecked:shape.executorsChecked});
      return shape;}
    if(method==='files.cleanup.settle'){const target=record.targets[params.index];
      const exists=await statReal(abs(record.node,target.relativePath));
      return {ok:true,state:exists?'pending':'completed',receipt:{source:'active_query',verifiedBy:'path_absence',contentFingerprint:target.contentFingerprint}};}
    if(method==='files.cleanup.execute'){
      assert.ok(record.confirmations,'执行前必须已有确认相位');assert.equal(record.action,'delete','本流只允许永久删除');
      const target=record.targets[params.index];
      await fsPromises.rm(abs(record.node,target.relativePath),{recursive:true,force:true});
      stats.deletes+=1;stats.removes.push(record.node.id+':'+target.relativePath);
      return {ok:true,receipt:{source:'active_query',verifiedBy:'path_absence',contentFingerprint:target.contentFingerprint}};}
    throw Error('ADAPTER_REFUSES_'+method);};
  const queueFile=Q.distributedQueuePath(storage,root);
  const seedPlans=Q.restoreFormalJobQueue(Object.assign(Q.emptyDistributedQueue(),{plans:[{id:'plan-a',projectId,planFile,revision,codeFingerprint:'fp-1',
    executionMode:'train',resultPathPolicy:'declared',
    jobs:[{index:0,case:'c0',seed:1,status:'failed',lifecycleProtocol:2,commandId:'cmd-old',workerId:'w1',outputDir,collectionResultCsv:resultCsv},
      {index:1,case:'c1',seed:2,status:'running',lifecycleProtocol:2,commandId:'cmd-b',workerId:'w1',outputDir:'work_dirs/a1',collectionResultCsv:'work_dirs/a1/m.csv'}]}]}));
  fs.mkdirSync(path.dirname(queueFile),{recursive:true});
  fs.writeFileSync(queueFile,Q.serializeDistributedQueue(seedPlans));
  const loadQueue=async()=>{const raw=fs.readFileSync(queueFile,'utf8');
    return Q.setDistributedQueueBaseSignature(Q.restoreFormalJobQueue(JSON.parse(raw)),Q.distributedQueueDiskSignature(raw));};
  const dialogs=[];const posted=[];const actionErrors=[];
  const answers=[...(options.answers===undefined?['确认删除（1/2）','永久删除（2/2）']:options.answers)];
  const vscode={window:{showWarningMessage:async(_message,_options,...items)=>{const a=answers.shift();const value=typeof a==='function'?a():a;
    dialogs.push(String(value));return items.includes(String(value))?String(value):undefined;}}};
  // 强取消证据形态：raw cancelled===true && tmux===null && result null|匹配所选 commandId（提交/停止后核验用）。
  const observation={lifecycleProtocol:2,commandId:'cmd-old',projectId,workerId:'w1',cancelled:true,tmux:null,result:null};
  const client={postWorkerAction:async(workerId,action)=>{posted.push({workerId,action});},
    getWorkerTasks:async()=>({capabilities:{taskLifecycle:2},queryComplete:true,tasks:[{commandId:'cmd-old',observation}]})};
  function buildLegacyHost(){
    const h=new QueueHost();
    Object.assign(h,{context:{globalStorageUri:{fsPath:storage}},workspaceRootValue:root,
      distributedQueueGeneration:0,distributedPlanStopEpoch:0,planStopClearBatchLease:undefined,distributedSubmissionEpochs:new Map(),
      distributedQueueWritePromise:Promise.resolve(),hostOperationLease:undefined,distributedQueueCache:null,distributedQueueRoot:'',
      distributedQueueDiskSignature:'',distributedQueueStorageDiagnostics:{status:'ready'},distributedQueueMetadataWrites:[],
      detachStaleDistributedTick(){},postState(){},recordActionError(row){actionErrors.push(row);},
      client,manualDispatchInFlight:new Set(),loadDistributedQueue:loadQueue,
      assertPlanSubmissionWorkers:async()=>{},tickDistributedQueue:async()=>{}});
    const saved=h.saveDistributedQueue.bind(h);
    h.saveDistributedQueue=async(rootArg,queueArg,optionsArg)=>{
      // 只有重新排队 commit（controlMutation+mutateLatest）会命中故障注入；
      // 执行持久化（updateIndexes 的位置参数保存）不受影响，与真实重启语义一致。
      if(options.failNextSave&&optionsArg&&optionsArg.mutateLatest){options.failNextSave=false;throw Error('STORAGE_WRITE_FAILED');}
      return saved(rootArg,queueArg,optionsArg);};
    return h;
  }
  function buildPlanHostPorts(h){
    return {taskLifecycleProtocol:2,context:{globalStorageUri:{fsPath:storage}},
      // 合流接线（2026-10-23）：feature 侧 PlanCleanupHost 以机器状态映射守卫做 fail-closed 保护——
      // 端口缺失即 unknown → 全部 protected。与 manifestCleanup.test.js 同款夹具口径：
      // 映射已解析且状态根不与 work_dirs 声明产物相交，本轮清理按真实语义放行。
      localMachineStateGuard:()=>({prefixes:[],unknown:false}),
      targetRootGuard:()=>({prefixes:[],unknown:false}),
      setupConfig:{workerTunnels:[{id:'w1'}]},
      workerCodeSyncTarget:()=>({host:'h1.example',port:22,user:'u',remotePath:remoteRoot}),
      simpleSftpApiCall:sftp,client,h,
      loadDistributedQueue:loadQueue,saveDistributedQueue:(rootArg,queueArg)=>h.saveDistributedQueue(rootArg,queueArg),
      updatePlanSyncLedger:async()=>{},postState(){},assertArtifactSyncPathsIdle(){},
      withHostOperationLease:async(_k,_d,fn)=>fn()};
  }
  async function buildStack(){
    const h=buildLegacyHost();
    const adapter=await loadRealPlanCleanupHost(root,buildPlanHostPorts(h));
    h.planCleanupHost=()=>adapter;
    return {h,adapter};
  }
  const runner=makeRetry(fsPromises,path,crypto,{resolvePlanExecutionSource:async()=>undefined,verifyLocalPlanSource:async()=>{}},
    PulledTaskControl,vscode,UiCommandCancelled,()=>'op-'+Math.random(),e=>e.message,
    class{async replace(){throw Error('MUST_NOT_RENAME_ISOLATE');}});
  const queue=()=>Q.restoreFormalJobQueue(JSON.parse(fs.readFileSync(queueFile,'utf8')));
  const seedPlan=queue().plans.find(row=>row.id==='plan-a');
  return {root,storage,remoteRoot,planFile,revision,projectId,stats,client,h:null,adapter:null,
    plan:seedPlan,job:seedPlan.jobs[0],
    queue,queueFile,dialogs,posted,actionErrors,
    jobRow:()=>queue().plans.find(row=>row.id==='plan-a').jobs.find(row=>row.index===0),
    sibling:()=>queue().plans.find(row=>row.id==='plan-a').jobs.find(row=>row.index===1),
    existsRemote:(...p)=>fs.existsSync(path.join(remoteRoot,...p)),
    existsLocal:(...p)=>fs.existsSync(path.join(root,...p)),
    async build(){const s=await buildStack();this.h=s.h;this.adapter=s.adapter;return s;},
    async run(h,plan=this.plan,job=this.job,isCurrent=()=>true){
      if(!h){const s=await this.build();h=s.h;}
      return runner.call(h,plan,job,this.root,isCurrent,false);},
    writeQueueNow:mutate=>{const q=JSON.parse(fs.readFileSync(queueFile,'utf8'));mutate(q);
      fs.writeFileSync(queueFile,Q.serializeDistributedQueue(Q.restoreFormalJobQueue(q)));}};
}

test('本机缺/remote 有：真实 collect+ManifestCleanup 只对 remote 产 delete 行，本机缺路径由逐目标核验证明不存在，删后原卡入队',async()=>{
  const w=await world();await w.build();
  const result=await w.run();
  assert.equal(result.status,'queued');
  assert.deepEqual(w.dialogs,['确认删除（1/2）','永久删除（2/2）']);
  assert.equal(w.stats.deletes,1,'只删远端一份物理目标');
  assert.ok(w.stats.removes.includes('w1:work_dirs/a0'));
  assert.ok(!w.existsRemote('work_dirs/a0'));assert.ok(!w.existsLocal('work_dirs/a0'));
  const job=w.jobRow();assert.equal(job.status,'pending');assert.equal(job.commandId,undefined);
  assert.ok(job.nextCommandId&&job.nextCommandId!=='cmd-old');
  assert.equal(w.sibling().commandId,'cmd-b');
  assert.match(result.message,/永久删除并核实源路径不存在/);
});
test('全缺：无 rows 也必须由真实逐目标核验证明不存在才入队，零对话框零删除',async()=>{
  const w=await world({onRemote:false});await w.build();
  const result=await w.run();
  assert.equal(result.status,'queued');
  assert.deepEqual(w.dialogs,[]);assert.equal(w.stats.deletes,0);
  assert.match(result.message,/已核实不存在（本轮逐目标后端 proof/);
  assert.equal(w.jobRow().status,'pending');
});
test('删除后全缺：新宿主真实 preview 无行且 verifyDeclaredTargets 逐目标证明不存在；旧 job 再点击被身份围栏拒绝',async()=>{
  const w=await world({onLocal:true});await w.build();
  const first=await w.run();assert.equal(first.status,'queued');
  assert.equal(w.stats.deletes,2,'local+remote 各删一次');
  const s=await w.build();// 模拟进程重启：新 PlanCleanupHost 实例
  await assert.rejects(()=>s.adapter.service.preview({planFile:w.planFile,action:'delete',verifiedOnly:false,
    job:{workflowId:'plan-a',index:0,commandId:'cmd-old'}}),/JOB_DECLARATIONS_UNVERIFIED/,
    '已重排的旧 commandId 不能再建立删除审核（fail-closed，不再产生 delete 行）');
  const verdicts=await s.adapter.verifyDeclaredTargets({job:{workflowId:'plan-a',index:0,commandId:'cmd-old'},
    declared:[{relativePath:'work_dirs/a0',type:'directory'}],
    nodes:[{id:'local',kind:'local',root:w.root},
      {id:'w1',kind:'remote',host:'h1.example',user:'u',port:22,root:w.remoteRoot}]});
  assert.equal(verdicts.blockers.length,0);
  assert.deepEqual(JSON.parse(JSON.stringify(verdicts.verdicts.map(v=>v.nodeId+":"+v.state))).sort(),["local:absent","w1:absent"],
    '真实逐目标核验：本机与远端声明路径都证明不存在');
  await assert.rejects(()=>w.run(s.h),/任务身份或声明产物路径已变化/,'已重排的旧 job 再点击零停止零删除');
  assert.equal(w.stats.deletes,2,'重启后零重复删除');
});
test('外置 CSV 仍存在：目录缺失被核验救回，但 CSV present 必须拒绝——零删除零入队',async()=>{
  const w=await world({externalCsv:true,onRemote:false});await w.build();
  await assert.rejects(()=>w.run(),error=>/CLEANUP_PROOF_INCOMPLETE/.test(String(error&&error.message))&&/核验=present/.test(String(error&&error.message)));
  assert.equal(w.stats.deletes,0);assert.deepEqual(w.dialogs,[]);
  assert.equal(w.jobRow().commandId,'cmd-old');
  assert.ok(w.existsRemote('experiments/results/a0.csv'),'外置结果文件保留待审');
});
test('外置 CSV 核验未知（后端应答错误）：按缺项拒绝，不得把 error 当不存在',async()=>{
  const w=await world({externalCsv:true,onRemote:false,inspectErrorFor:'w1\0experiments/results/a0.csv'});await w.build();
  await assert.rejects(()=>w.run(),error=>/CLEANUP_PROOF_INCOMPLETE/.test(String(error&&error.message))&&/核验=error/.test(String(error&&error.message)));
  assert.equal(w.stats.deletes,0);assert.deepEqual(w.dialogs,[]);
  assert.equal(w.jobRow().commandId,'cmd-old');
});
test('删除成功但入队写失败：新宿主实例恢复——absent 核验直接入队，零重复删除',async()=>{
  const w=await world({failNextSave:true});await w.build();
  await assert.rejects(()=>w.run(),/STORAGE_WRITE_FAILED/);
  assert.equal(w.stats.deletes,1);assert.ok(!w.existsRemote('work_dirs/a0'));
  assert.equal(w.jobRow().commandId,'cmd-old','写失败保持原任务身份');
  const s=await w.build();
  const second=await w.run(s.h);
  assert.equal(second.status,'queued');
  assert.match(second.message,/已核实不存在/);
  assert.equal(w.stats.deletes,1);
});
test('P0-2 新任务观察回归：重新排队后查询成功且 executors=[]+executorsChecked=true 必须放行，保持新任务代际且不再触发清理',async()=>{
  const w=await world();await w.build();
  const result=await w.run();
  // ① 重新排队成功
  assert.equal(result.status,'queued');
  const row=w.jobRow();
  // ② 新任务保持新 command（returnPulledJobToLocal：旧 commandId 清除，新代际在 nextCommandId，同一代）
  assert.notEqual(row.commandId,'cmd-old','旧执行身份已清除');
  const newCommandId=row.nextCommandId;assert.ok(newCommandId&&newCommandId!=='cmd-old','新任务使用新的 command 代际');
  const opId=row.cleanup&&row.cleanup.operationId;assert.ok(opId,'清理操作账本仍在');
  // ③ 新任务启动后再次查询清理观察：后端回「本轮查询成功、当前无活动执行器」。
  //    这不能解释成「任务没有运行/没启动/已退出」，更不得触发第二次清理或拒绝放行。
  const status=await w.adapter.service.status(String(opId));
  assert.ok(status,'重新排队后的观察查询成功，未被拒绝');
  assert.ok(w.stats.checkShapes.length>0,'删除轮后端观察必须实际发生');
  assert.ok(w.stats.checkShapes.every(s=>Array.isArray(s.executors)&&s.executors.length===0&&s.executorsChecked===true),
    '所有后端观察应答均为 executors=[] 且 executorsChecked=true 的正常组合（这不是「没有任务」）');
  // ④ 新 command 再查询 getWorkerTasks 成功（worker 侧同样不得把查询成功当作任务消失）
  w.h.client.getWorkerTasks=async()=>({capabilities:{taskLifecycle:2},queryComplete:true,
    tasks:[{commandId:newCommandId,observation:{lifecycleProtocol:2,commandId:newCommandId,projectId:w.projectId,workerId:'w1',cancelled:false,tmux:'zlink-1',result:null}}]});
  // 新任务派发回同一 worker 后按新 command 查询（pending 派发前无 workerId；派发身份用原 worker）。
  const requery=await PulledTaskControl.queryTask(w.h.client,w.plan,{...row,commandId:newCommandId,workerId:'w1'});
  assert.ok(requery.task&&requery.task.observation,'新 commandId 的 getWorkerTasks 查询成功');
  // ⑤ 旧任务已删除 1 个文件
  assert.equal(w.stats.deletes,1,'旧任务删除恰好一次');
  assert.ok(!w.existsRemote('work_dirs/a0'),'删除的正是旧声明产物');
  // ⑥ 不再次删除、不重新进入清理对话
  assert.deepEqual(w.dialogs,['确认删除（1/2）','永久删除（2/2）'],'没有第二次清理对话');
  assert.equal(w.jobRow().nextCommandId,newCommandId,'新任务代际不被观察轮改写');
});
test('清单归属未核实：真实 ManifestCleanup 产生 OWNERSHIP_UNVERIFIED 阻断，任何删除/确认前拒绝',async()=>{
  const w=await world({withoutManifest:true});await w.build();
  await assert.rejects(()=>w.run(),/CLEANUP_INCOMPLETE[\s\S]*OWNERSHIP_UNVERIFIED|OWNERSHIP_UNVERIFIED/);
  assert.equal(w.stats.deletes,0);assert.deepEqual(w.dialogs,[]);
  assert.ok(w.existsRemote('work_dirs/a0'));
});
