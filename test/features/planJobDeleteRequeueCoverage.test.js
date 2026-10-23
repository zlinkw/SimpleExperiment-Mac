const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsPromises=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),ts=require('typescript');
require('../_helpers/registerTsRequire');
const Q=require('../../src/features/DistributedPlanQueue.ts');
const PulledTaskControl=require('../../src/features/PulledTaskControl.ts');
const {atomicWriteText}=require('../../src/state/StateStore.ts');
const {PlanCleanup,cleanupDigest}=require('../../dist/features/PlanCleanup.js');

// 返修 P0（2026-10-21）：单 job「删除并重新排队」的缺项证明必须被拒绝，而不是当成功。
// 本套件不用"永远完整"的手工 stub——清理链走 dist 里的真实 PlanCleanup 服务，
// SimpleSFTP 后端由沙箱内真实文件系统实现（preview 真实 stat：存在给指纹、缺失给 missing:true；
// execute 真实 rm；inspect/settle/verify 按真实形状回包）。缺项形态（blockers/空 rows/unverified/
// protected/多节点少一个/物理别名/删后重建/确认期间漂移/回执篡改）由真实服务产生或按真实契约篡改，
// 断言"拒绝 + 零入队 + 零文件副作用"。队列读写走 legacy 真实 saveDistributedQueue + 真实 atomicWriteText。
// 不连任何真实主机，绝不触碰真实数据。

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

function world(options={}){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'se-jobdel-cov-'));
  const storage=path.join(root,'storage');const serverRoot=path.join(root,'server');
  const planFile='plans/a.yaml';fs.mkdirSync(path.join(root,'plans'),{recursive:true});
  const text='mode: train\n';fs.writeFileSync(path.join(root,planFile),text);
  const revision=crypto.createHash('sha256').update(text).digest('hex');
  const node={id:'w1',kind:'remote',root:serverRoot,host:'h1.example',port:22,user:'u'};
  fs.mkdirSync(path.join(serverRoot,'work_dirs/a0'),{recursive:true});
  fs.writeFileSync(path.join(serverRoot,'work_dirs/a0/out.txt'),'payload');
  fs.writeFileSync(path.join(serverRoot,'work_dirs/a0/m.csv'),'a,b\n1,2\n');
  const stats={deletes:0,previews:0,tokens:[]};
  const backend=new Map();let tokenSeq=0;
  const owned=(relative,extra)=>Object.assign({nodeId:'w1',relativePath:relative,type:'directory',category:'专用产物',
    owners:['owner'],evidence:['exact job / attempt / command registration'],dependencies:[]},extra||{});
  const scope={projectId:Q.canonicalProjectId(root),planKey:'owner',planFile,planHash:'h-a',runIds:['run-a'],revision:'frozen',
    nodes:[node],blockers:[],candidates:[owned('work_dirs/a0'),owned('work_dirs/a0/m.csv',{type:'file'})]};
  if(options.alias){scope.nodes.push({id:'w2',kind:'remote',root:serverRoot,host:'h2.example',port:22,user:'u'});
    scope.candidates.push(owned('work_dirs/a0',{nodeId:'w2'}),owned('work_dirs/a0/m.csv',{nodeId:'w2',type:'file'}));}
  if(options.offlineNode)scope.nodes.push({id:'w3',kind:'remote',root:serverRoot,host:'h3.example',port:22,user:'u',error:'SSH 连接超时'});
  if(options.weakOwnership)scope.candidates.forEach(row=>{row.owners=[];row.evidence=[];});
  if(options.secondNode)scope.nodes.push({id:'w3',kind:'remote',root:serverRoot,host:'h3.example',port:22,user:'u'});// 合法第二节点但候选一行不给它：少一个覆盖
  if(options.emptyScope)scope.candidates=[];
  if(options.absentFiles)fs.rmSync(path.join(serverRoot,'work_dirs'),{recursive:true,force:true});
  const sftp=async(method,params)=>{
    const abs=(nodeObj,relative)=>path.join(nodeObj.root,relative);
    const posixAbs=(nodeObj,relative)=>String(nodeObj.root).split(path.sep).join('/')+'/'+relative;
    // 只有 ENOENT/ENOTDIR 才是「不存在」；EACCES 等错误必须抛出，绝不被 catch 伪造成 missing。
    const statReal=async(p)=>{try{return await fsPromises.stat(p);}catch(error){
      if(error&&(error.code==='ENOENT'||error.code==='ENOTDIR'))return null;throw error;}};
    if(method==='files.cleanup.preview'){
      stats.previews+=1;
      if(options.failPreview&&params.node&&params.node.id==='w1')throw Object.assign(Error('WORKER_UNREACHABLE'),{apiData:{code:'WORKER_UNREACHABLE'}});
      const targets=[];
      for(const row of params.targets){
        const st=await statReal(abs(params.node,row.relativePath));
        if(!st){targets.push({relativePath:row.relativePath,type:row.type,missing:true});continue;}
        targets.push({relativePath:row.relativePath,type:row.type,destination:row.destination,absolutePath:posixAbs(params.node,row.relativePath),
          fingerprint:'fp-'+cleanupDigest([params.node.root,row.relativePath]).slice(0,16),contentFingerprint:'cf-'+cleanupDigest(row.relativePath).slice(0,16),
          device:String(st.dev),inode:String(st.ino),size:Number(st.size),missing:false,inventory:[]});
      }
      const token='bp'+cleanupDigest([params.node&&params.node.id,params.targets.map(t=>t.relativePath),tokenSeq++]).replace(/[^0-9a-f]/g,'').slice(0,44);
      // 后端摘要覆盖目标自身身份（路径/类型/存在/指纹/inode），不覆盖 destination——
      // delete 的 destination 只是 clean_dir 命名占位（且含 token），不是目标身份的一部分。
      // 真实 SimpleSFTP 的 preview token/会话摘要每次预览都变化（内容指纹由文件内容决定，保持确定）；
      // 会话摘要作为每次预览的记录摘要含一次性盐，与 token 同步变化。
      const previewSession=crypto.randomBytes(8).toString('hex');
      const record={token,digest:cleanupDigest([previewSession,targets.map(({destination,inventory,...identity})=>identity)]),rootIdentity:{path:params.node.root},targets,confirmations:0,node:params.node,action:params.action};
      backend.set(token,record);stats.tokens.push(token);return JSON.parse(JSON.stringify(record));
    }
    if(method==='files.cleanup.inspect'){
      const st=await statReal(abs(params.node,params.target.relativePath));
      return {target:{type:params.target.type,absolutePath:posixAbs(params.node,params.target.relativePath),
        missing:!st,fingerprint:'fp-'+cleanupDigest([params.node.root,params.target.relativePath]).slice(0,16)},executorsChecked:true,executors:[]};
    }
    const record=backend.get(params.token);assert.ok(record,'preview 必须先于任何后端动作');
    if(method==='files.cleanup.status')return JSON.parse(JSON.stringify(record));
    if(method==='files.cleanup.confirm'){
      if(params.phase===2)assert.equal(record.confirmations,1,'第 2 相位必须紧接同一会话的第 1 相位');
      record.confirmations=params.phase;return {ok:true};}
    if(method==='files.cleanup.preflight')return {ok:true};
    if(method==='files.cleanup.verify')return {ok:true};
    if(method==='files.cleanup.settle'){const target=record.targets[params.index];
      const exists=await statReal(abs(record.node,target.relativePath));
      return {ok:true,state:exists?'pending':'completed',receipt:{source:'active_query',verifiedBy:'path_absence',contentFingerprint:target.contentFingerprint}};}
    if(method==='files.cleanup.execute'){
      assert.ok(record.confirmations,'执行前必须已有确认相位');assert.equal(record.action,'delete','本流只允许永久删除，不得 rename 隔离');
      const target=record.targets[params.index];
      await fsPromises.rm(abs(record.node,target.relativePath),{recursive:true,force:true});stats.deletes+=1;
      if(options.recreateAfterDelete&&!options.recreated){options.recreated=true;
        await fsPromises.mkdir(abs(record.node,'work_dirs/a0'),{recursive:true});await fsPromises.writeFile(abs(record.node,'work_dirs/a0/out.txt'),'new');}
      return {ok:true,receipt:{source:'active_query',verifiedBy:'path_absence',contentFingerprint:target.contentFingerprint}};}
    throw Error('ADAPTER_REFUSES_'+method);};
  let collectRound=0;
  const service=new PlanCleanup({storageRoot:storage,collect:async(file,opts)=>{
    collectRound+=1;
    const copy=JSON.parse(JSON.stringify(scope));
    if(collectRound>1&&options.mutateRecheck)options.mutateRecheck(copy);
    const job=opts&&opts.job;copy.job=job?{workflowId:job.workflowId,index:job.index,commandId:job.commandId,purpose:job.purpose}:undefined;
    return copy;},sftp,updateIndexes:async()=>{},restoreGate:async()=>{}});

  const projectId=Q.canonicalProjectId(root);
  const queueFile=Q.distributedQueuePath(storage,root);
  const seedPlans=Q.restoreFormalJobQueue(Object.assign(Q.emptyDistributedQueue(),{plans:[{id:'plan-a',projectId,planFile,revision,codeFingerprint:'fp-1',executionMode:'train',resultPathPolicy:'declared',
    jobs:[{index:0,case:'c0',seed:1,status:'completed',lifecycleProtocol:2,commandId:'cmd-old',workerId:'w1',outputDir:'work_dirs/a0',collectionResultCsv:'work_dirs/a0/m.csv'},
      {index:1,case:'c1',seed:2,status:'running',lifecycleProtocol:2,commandId:'cmd-b',workerId:'w1',outputDir:'work_dirs/a1',collectionResultCsv:'work_dirs/a1/m.csv'}]}]}));
  fs.mkdirSync(path.dirname(queueFile),{recursive:true});
  fs.writeFileSync(queueFile,Q.serializeDistributedQueue(seedPlans));
  const loadQueue=async()=>Q.restoreFormalJobQueue(JSON.parse(fs.readFileSync(queueFile,'utf8')));
  const dialogs=[];const posted=[];const actionErrors=[];
  const answers=[...(options.answers===undefined?['确认删除（1/2）','永久删除（2/2）']:options.answers)];
  const vscode={window:{showWarningMessage:async(_message,_options,...items)=>{const a=answers.shift();const value=typeof a==='function'?a():a;
    dialogs.push(String(value));return items.includes(String(value))?String(value):undefined;}}};
  function buildHost(){
    const h=new QueueHost();
    Object.assign(h,{context:{globalStorageUri:{fsPath:storage}},workspaceRootValue:root,
      distributedQueueGeneration:0,distributedPlanStopEpoch:0,planStopClearBatchLease:undefined,distributedSubmissionEpochs:new Map(),
      distributedQueueWritePromise:Promise.resolve(),hostOperationLease:undefined,distributedQueueCache:null,distributedQueueRoot:'',
      distributedQueueDiskSignature:'',distributedQueueStorageDiagnostics:{status:'ready'},distributedQueueMetadataWrites:[],
      detachStaleDistributedTick(){},postState(){},recordActionError(row){actionErrors.push(row);},
      client,manualDispatchInFlight:new Set(),loadDistributedQueue:loadQueue,
      assertPlanSubmissionWorkers:async()=>{},
      planCleanupHost:()=>({service,
        // 与真实 PlanCleanupHost.verifyDeclaredTargets 同一证据纪律：只有 ENOENT/ENOTDIR 才是 absent，
        // 其它 stat 错误是 error 判定（拒绝），绝不把失败伪造成不存在。
        verifyDeclaredTargets:async({declared,nodes})=>{const verdicts=[],blockers=[];
          for(const frozen of nodes){
            if(frozen.error){blockers.push({code:'OFFLINE_NODE',nodeId:frozen.id,detail:String(frozen.error)});continue;}
            for(const t of declared){
              try{await fsPromises.stat(path.join(frozen.root,t.relativePath));
                verdicts.push({nodeId:frozen.id,relativePath:t.relativePath,type:t.type,state:'present',rootIdentity:{path:frozen.root}});}
              catch(error){if(error&&(error.code==='ENOENT'||error.code==='ENOTDIR'))
                  verdicts.push({nodeId:frozen.id,relativePath:t.relativePath,type:t.type,state:'absent',rootIdentity:{path:frozen.root}});
                else verdicts.push({nodeId:frozen.id,relativePath:t.relativePath,type:t.type,state:'error',error:String(error&&error.code||error)});}
            }}
          return {verdicts,blockers};},
        execute:async id=>{const done=await service.execute(id);
          if(options.tamper==='dropRows')return {...done,preview:{...done.preview,rows:[]}};
          if(options.tamper==='dropOne')return {...done,preview:{...done.preview,rows:done.preview.rows.filter(row=>row.type!=='directory')}};
          if(options.tamper==='wrongToken')return {...done,preview:{...done.preview,token:'tok-not-the-preview'}};
          if(options.tamper==='forgedRow')return {...done,preview:{...done.preview,rows:done.preview.rows.map(row=>({...row,relativePath:'work_dirs/forged'}))}};
          return done;}}),
      tickDistributedQueue:async()=>{}});
    const saved=h.saveDistributedQueue.bind(h);
    h.saveDistributedQueue=async(...args)=>{if(options.failNextSave){options.failNextSave=false;throw Error('STORAGE_WRITE_FAILED');}
      return saved(...args);};
    return h;
  }
  // 阶段 2 强取消证据形态：raw cancelled===true && tmux===null && result null|匹配所选 commandId（初次准入另允许原生终止形态）。
  const baseObservation=Object.assign({lifecycleProtocol:2,commandId:'cmd-old',projectId,workerId:'w1',
    cancelled:true,tmux:null,result:null},options.observation||{});
  const client={postWorkerAction:async(workerId,action)=>{posted.push({workerId,action});},
    getWorkerTasks:async()=>({capabilities:{taskLifecycle:2},queryComplete:true,
      tasks:options.tasks===undefined?[{commandId:'cmd-old',observation:baseObservation}]:options.tasks})};
  const host=buildHost();
  const queue=()=>Q.restoreFormalJobQueue(JSON.parse(fs.readFileSync(queueFile,'utf8')));
  const seedPlan=queue().plans.find(row=>row.id==='plan-a');
  const runner=makeRetry(fsPromises,path,crypto,{resolvePlanExecutionSource:async()=>undefined,verifyLocalPlanSource:async()=>{}},
    PulledTaskControl,vscode,UiCommandCancelled,()=>'op-'+Math.random(),e=>e.message,
    class{async replace(){throw Error('MUST_NOT_RENAME_ISOLATE');}});
  return {root,storage,serverRoot,planFile,revision,projectId,node,scope,stats,service,host,buildHost,queue,queueFile,dialogs,posted,actionErrors,
    plan:seedPlan,job:seedPlan.jobs[0],
    sibling:()=>queue().plans.find(row=>row.id==='plan-a').jobs.find(row=>row.index===1),
    jobRow:()=>queue().plans.find(row=>row.id==='plan-a').jobs.find(row=>row.index===0),
    exists:(...parts)=>fs.existsSync(path.join(serverRoot,...parts)),
    writeQueueNow:mutate=>{const q=JSON.parse(fs.readFileSync(queueFile,'utf8'));mutate(q);
      fs.writeFileSync(queueFile,Q.serializeDistributedQueue(Q.restoreFormalJobQueue(q)));},
    planText:()=>fs.readFileSync(path.join(root,planFile),'utf8'),
    setPlanText:t=>fs.writeFileSync(path.join(root,planFile),t),
    run:(h=host,plan=seedPlan,job=seedPlan.jobs[0],isCurrent=()=>true)=>runner.call(h,plan,job,root,isCurrent,false)};
}

const codes=error=>String((error&&(error.message||error))+'');

test('preview 仅 blockers（离线节点）：拒绝并入队为零——离线不能被当成"该节点已删干净"',async()=>{
  const w=world({offlineNode:true});
  await assert.rejects(()=>w.run(),error=>/CLEANUP_INCOMPLETE/.test(codes(error))&&/OFFLINE_NODE/.test(codes(error)));
  assert.equal(w.stats.deletes,0);assert.deepEqual(w.dialogs,[]);
  assert.equal(w.jobRow().commandId,'cmd-old','零入队');
});
test('preview 空 rows：绝不能免删直接入队（旧候选在此静默成功）',async()=>{
  const w=world({emptyScope:true});
  await assert.rejects(()=>w.run(),error=>/CLEANUP_PROOF_INCOMPLETE/.test(codes(error)));
  assert.equal(w.stats.deletes,0);assert.deepEqual(w.dialogs,[]);
  assert.equal(w.jobRow().commandId,'cmd-old');
});
test('unverified 行（后端预览拒绝）：拒绝且零副作用',async()=>{
  const w=world({failPreview:true});
  await assert.rejects(()=>w.run(),/CLEANUP_INCOMPLETE|CLEANUP_PROOF_INCOMPLETE/);
  assert.equal(w.stats.deletes,0);assert.deepEqual(w.dialogs,[]);
});
test('protected 行（所有权不唯一）：拒绝——保护不是删除证明',async()=>{
  const w=world({weakOwnership:true});
  await assert.rejects(()=>w.run(),error=>/CLEANUP_PROOF_INCOMPLETE/.test(codes(error))&&/核验=present/.test(codes(error)));
  assert.equal(w.stats.deletes,0);
});
test('多节点少一个：w3 一行覆盖都没有时拒绝，不得以 w1 的证明冒充全量',async()=>{
  const w=world({secondNode:true});
  await assert.rejects(()=>w.run(),error=>/CLEANUP_PROOF_INCOMPLETE/.test(codes(error))&&/w3/.test(codes(error)));
  assert.equal(w.stats.deletes,0);
});
test('物理别名（同 root 双节点）：受保护别名由已证明父目标覆盖，允许删除并回原卡',async()=>{
  const w=world({alias:true});
  const result=await w.run();
  assert.equal(result.status,'queued');
  assert.ok(w.stats.deletes>=1);
  assert.ok(!w.exists('work_dirs/a0'),'别名同一物理源必须真实释放');
  const q=w.queue();assert.equal(q.plans.length,1);
  const job=q.plans.find(row=>row.id==='plan-a').jobs.find(row=>row.index===0);
  assert.equal(job.status,'pending');assert.equal(job.commandId,undefined);assert.ok(job.nextCommandId&&job.nextCommandId!=='cmd-old');
  assert.equal(w.sibling().commandId,'cmd-b','兄弟 job 保留');
});
test('done completed 但回执篡改：空 rows / 目标遗漏 → PERMANENT_DELETE_UNVERIFIED；token 不符 → DELETE_RECEIPT_MISMATCH；均零入队',async()=>{
  for(const tamper of ['dropRows','dropOne','wrongToken']){
    const w=world({tamper});
    const expected=tamper==='wrongToken'?/DELETE_RECEIPT_MISMATCH/:/PERMANENT_DELETE_UNVERIFIED/;
    await assert.rejects(()=>w.run(),expected);
    assert.equal(w.jobRow().commandId,'cmd-old',tamper+' 后仍须零入队');
  }
});
test('删除后源被重建：复查预览以本轮 stat 拒绝入队（SOURCE_STILL_PRESENT）',async()=>{
  const w=world({recreateAfterDelete:true});
  await assert.rejects(()=>w.run(),/SOURCE_STILL_PRESENT/);
  assert.equal(w.jobRow().commandId,'cmd-old');
  assert.ok(w.exists('work_dirs/a0'),'重建文件保留待下轮审核，不静默再删');
});
test('确认期间 commandId 被并发写改：执行前围栏拒绝，零删除零覆盖',async()=>{
  const w=world({answers:['确认删除（1/2）',()=>{w.writeQueueNow(q=>{q.plans.find(row=>row.id==='plan-a').jobs.find(row=>row.index===0).commandId='cmd-hijacked';});
    return '永久删除（2/2）';}]});
  await assert.rejects(()=>w.run(),/任务身份或声明产物路径已变化/);
  assert.equal(w.stats.deletes,0);assert.equal(w.exists('work_dirs/a0'),true);
  assert.equal(w.jobRow().commandId,'cmd-hijacked','外部写入保留，本流零覆盖');
});
test('已有安全 absence（本轮逐目标 missing 证明）：免再次删除直接入队，零对话框零删除动作',async()=>{
  const w=world({absentFiles:true});
  const result=await w.run();
  assert.equal(result.status,'queued');
  assert.deepEqual(w.dialogs,[],'无删除目标就不该弹删除确认');
  assert.equal(w.stats.deletes,0);
  assert.match(result.message,/已核实不存在（本轮逐目标后端 proof/);
});
test('sourceChange：单 job 不建新卡不重跑兄弟——阻断在任何停止/删除/写之前',async()=>{
  const w=world();
  w.setPlanText(w.planText()+'# edited\n');
  const result=await w.run();
  assert.equal(result.status,'blocked');assert.equal(result.code,'SOURCE_CHANGED_UNSUPPORTED');
  assert.deepEqual(w.posted,[],'不得先停任务再告知');
  assert.equal(w.stats.previews,0,'阻断发生在任何清理预览之前');
  assert.equal(w.jobRow().commandId,'cmd-old');
});
test('删除成功但入队写失败：新宿主实例（模拟重启）恢复——absent 预览直接入队，零重复删除',async()=>{
  const w=world({failNextSave:true});
  await assert.rejects(()=>w.run(),/STORAGE_WRITE_FAILED/);
  assert.equal(w.stats.deletes,1);assert.equal(w.exists('work_dirs/a0'),false);
  const h2=w.buildHost();// 模拟进程重启：新宿主实例、同磁盘队列与同沙箱
  const result=await w.run(h2,w.plan,w.job);
  assert.equal(result.status,'queued');
  assert.match(result.message,/已核实不存在（本轮逐目标后端 proof/);
  assert.equal(w.stats.deletes,1,'重启恢复零重复删除');
});
test('旧回执不影响新 command：入队成功后拿旧 job 再点，停止之前就拒绝',async()=>{
  const w=world();
  const ok=await w.run();assert.equal(ok.status,'queued');
  const postedBefore=w.posted.length,deletesBefore=w.stats.deletes;
  await assert.rejects(()=>w.run(),/任务身份或声明产物路径已变化/);
  assert.equal(w.posted.length,postedBefore,'不得再次停止');
  assert.equal(w.stats.deletes,deletesBefore,'不得再次删除');
});
test('全绿链物理事实：两次确认精确路径、真实 rm、逐目标 path_absence、原卡 pending、兄弟与卡片保留',async()=>{
  const w=world();
  const result=await w.run();
  assert.equal(result.status,'queued');
  assert.ok(!w.exists('work_dirs/a0'),'源目录必须真实不存在');
  assert.deepEqual(w.dialogs,['确认删除（1/2）','永久删除（2/2）']);
  const q=w.queue();assert.equal(q.plans.length,1,'不建新卡');
  const job=q.plans.find(row=>row.id==='plan-a').jobs.find(row=>row.index===0);
  assert.equal(job.status,'pending');assert.equal(job.commandId,undefined);
  assert.ok((job.history||[]).some(row=>row.commandId==='cmd-old'&&row.stopReason==='requeue'));
  assert.deepEqual(w.posted.map(row=>row.action),['stop-worker-task']);
});

// ===== 返修（2026-10-22）两阶段准入与错误优先反例组 =====
test('缺所选 commandId 证据：真实 PulledTaskControl.queryTask 拒绝，零停止零预览零入队',async()=>{
  const w=world({tasks:[]});
  await assert.rejects(()=>w.run(),/未返回所选 commandId/);
  assert.deepEqual(w.posted,[]);assert.equal(w.stats.previews,0);assert.deepEqual(w.dialogs,[]);
  assert.equal(w.jobRow().commandId,'cmd-old');
});
test('窗口仍在且无整数 exitCode（pane dead 无 exit）：无正终止证据，posted=[]',async()=>{
  for(const tmux of [{windowId:'1.0',paneId:'9',dead:true,exitCode:null},{windowId:'1.0',paneId:'9',dead:true,exitCode:'1'},
    {windowId:'1.0',paneId:'9',dead:false,exitCode:0}]){
    const w=world({observation:{tmux}});
    await assert.rejects(()=>w.run(),/TASK_TERMINATION_UNVERIFIED/,JSON.stringify(tmux));
    assert.deepEqual(w.posted,[]);assert.equal(w.stats.previews,0);assert.equal(w.jobRow().commandId,'cmd-old');
  }
});
test('错误优先：executionQueryError/resultQueryError 即使正标记全真（cancelled=true+tmux=null+result=null）也必须零停止零删除零入队',async()=>{
  for(const field of ['executionQueryError','resultQueryError']){
    const w=world({observation:{[field]:'explicit query failed',cancelled:true,tmux:null,result:null}});
    await assert.rejects(()=>w.run(),/TASK_STATE_UNKNOWN/,field);
    assert.deepEqual(w.posted,[]);assert.equal(w.stats.previews,0);assert.deepEqual(w.dialogs,[]);
    assert.equal(w.jobRow().commandId,'cmd-old');
  }
});
test('queryError 与错身份组合：真实 queryTask/错误优先双重拒绝，posted=[]',async()=>{
  const q=world({observation:{queryError:'worker 快照查询失败',cancelled:true,tmux:null,result:null}});
  await assert.rejects(()=>q.run(),/worker 快照查询失败/);
  assert.deepEqual(q.posted,[]);assert.equal(q.jobRow().commandId,'cmd-old');
  const m=world({observation:{executionQueryError:'x',result:{runId:'cmd-other',identityMatches:true,status:'failed'}}});
  await assert.rejects(()=>m.run(),/TASK_STATE_UNKNOWN/);
  assert.deepEqual(m.posted,[]);
});
test('result 不匹配所选 commandId：cancel=true+tmux=null 也拒绝',async()=>{
  for(const result of [{runId:'cmd-other',identityMatches:true,status:'failed'},{runId:'cmd-old',identityMatches:false,status:'failed'},{runId:'cmd-old',identityMatches:true,status:'running'}]){
    const w=world({observation:{result}});
    await assert.rejects(()=>w.run(),/TASK_TERMINATION_UNVERIFIED/,JSON.stringify(result));
    assert.deepEqual(w.posted,[]);assert.equal(w.stats.previews,0);assert.equal(w.jobRow().commandId,'cmd-old');
  }
});
test('正证据形态全绿：cancelled===true && tmux===null && result===null 才准入并入队',async()=>{
  const w=world();
  const ok=await w.run();assert.equal(ok.status,'queued');
  assert.deepEqual(w.posted.map(row=>row.action),['stop-worker-task']);
});
test('原生已终止 pane 正向：dead=true+整数 exitCode=1 初次准入→受控 stop fence→强取消复核→双确认真实删除→原卡同 job 一次入队；兄弟不变',async()=>{
  const w=world({observation:{cancelled:false,tmux:{windowId:'1.0',paneId:'9',dead:true,exitCode:1},result:null}});
  const read=w.host.client.getWorkerTasks,post=w.host.client.postWorkerAction;let fenced=false;
  w.host.client.postWorkerAction=async(...a)=>{await post(...a);fenced=true;};
  w.host.client.getWorkerTasks=async(...a)=>{const answer=await read(...a);
    if(fenced)answer.tasks[0].observation=Object.assign({},answer.tasks[0].observation,{cancelled:true,tmux:null,result:null});
    return answer;};
  const ok=await w.run();assert.equal(ok.status,'queued');
  assert.equal(w.stats.deletes,1);
  assert.deepEqual(w.posted.map(row=>row.action),['stop-worker-task'],'恰一次受控停止围栏');
  const row=w.jobRow();assert.ok(row.nextCommandId&&row.nextCommandId!=='cmd-old','新代际入队');
  assert.equal(w.sibling().commandId,'cmd-b','兄弟 job 不变');
});
test('写盘临界区原子身份围栏：最终 worker 查询期间外部漂移 outputDir/collectionResultCsv → 拒入队，保留外部最新修改与原 commandId，零重复删除',async()=>{
  for(const field of ['outputDir','collectionResultCsv']){
    const w=world();const read=w.host.client.getWorkerTasks;let changed=false;
    w.host.client.getWorkerTasks=async(...a)=>{const answer=JSON.parse(JSON.stringify(await read(...a)));
      if(w.stats.deletes>0&&!changed){changed=true;
        const other='work_dirs/new-intent';fs.mkdirSync(path.join(w.serverRoot,other),{recursive:true});
        fs.writeFileSync(path.join(w.serverRoot,other,'m.csv'),'new artifact must survive');
        w.writeQueueNow(q=>{q.plans.find(p=>p.id==='plan-a').jobs.find(j=>j.index===0)[field]=field==='outputDir'?other:other+'/m.csv';});}
      return answer;};
    await assert.rejects(()=>w.run(),/任务身份或声明产物路径已变化/,field);
    assert.equal(w.stats.deletes,1,'仅删除已确认的原声明产物，恰一次');
    assert.equal(w.exists('work_dirs/new-intent/m.csv'),true,'新路径文件必须保留');
    assert.equal(w.jobRow().commandId,'cmd-old','保留原 commandId，不提交新代际');
    assert.equal(String(w.jobRow()[field]),field==='outputDir'?'work_dirs/new-intent':'work_dirs/new-intent/m.csv','外部最新修改不被本流覆盖');
  }
});
test('执行查询完成边界：停止后复查缺 result 字段（execution 查询完成、已取消、窗口释放）不因此拒绝，正常完成入队',async()=>{
  const w=world({observation:{cancelled:false,tmux:{windowId:'1.0',paneId:'9',dead:true,exitCode:2},result:null}});
  const read=w.host.client.getWorkerTasks,post=w.host.client.postWorkerAction;let fenced=false,stopVerified=false;
  w.host.client.postWorkerAction=async(...a)=>{await post(...a);fenced=true;};
  w.host.client.getWorkerTasks=async(...a)=>{const answer=await read(...a);
    if(fenced&&!stopVerified){stopVerified=true;const o=Object.assign({},answer.tasks[0].observation,{cancelled:true,tmux:null});delete o.result;answer.tasks[0].observation=o;}
    else if(fenced)answer.tasks[0].observation=Object.assign({},answer.tasks[0].observation,{cancelled:true,tmux:null,result:null});
    return answer;};
  const ok=await w.run();assert.equal(ok.status,'queued');
  assert.equal(w.stats.deletes,1);assert.deepEqual(w.posted.map(row=>row.action),['stop-worker-task']);
});
test('错误优先注入在真实删除完成后：提交前复查报 executionQueryError → 拒绝，保留原队列身份，零重复删除零入队',async()=>{
  const w=world();const original=w.host.client.getWorkerTasks;
  w.host.client.getWorkerTasks=async(...args)=>{const answer=JSON.parse(JSON.stringify(await original(...args)));
    // 按真实删除状态定位（不按固定第几次查询）：删除完成后的提交复查才注入错误。
    if(w.stats.deletes>0)answer.tasks[0].observation.executionQueryError='final execution observation unavailable';
    return answer;};
  await assert.rejects(()=>w.run(),/远端状态未知，未重新排队.*查询错误/);
  assert.equal(w.stats.deletes,1,'删除恰完成一次，拒绝后不重复删除');
  assert.equal(w.jobRow().commandId,'cmd-old','队列保留原任务身份，未提交新 command');
  assert.notEqual(w.jobRow().status,'pending');
});
test('P0-1 会话不变性只认 canonical 快照：token/会话摘要每次变化、内容身份相同仍正常删除入队',async()=>{
  // 真实 preview 每次给新 token，后端会话摘要随之变化；内容指纹是确定性的内容身份，不随会话抖动。
  // 入口不变性只由 exactTargets+声明路径+节点身份+plan/commandId 快照判定，不得拿 token/会话摘要比较。
  const w=world();
  const ok=await w.run();assert.equal(ok.status,'queued');
  assert.equal(w.stats.deletes,1);
  assert.ok(w.stats.previews>=5,'初次预览 + 每次确认/执行前复核预览都要发生（本流至少 5 次）');
  assert.ok(new Set(w.stats.tokens).size>=5,'后端真实 token 每次预览都不同：'+JSON.stringify(w.stats.tokens.map(t=>t.slice(0,8))));
});
test('P0-1 快照漂移负例：复核时精确目标/声明集合增删仍须拒绝「旧清理会话已失效」，零删除零确认',async()=>{
  for(const mutate of [
    copy=>{copy.candidates=copy.candidates.filter(row=>row.relativePath!=='work_dirs/a0/m.csv');},
    copy=>{copy.candidates=copy.candidates.concat(JSON.parse(JSON.stringify([{...copy.candidates[0],relativePath:'work_dirs/extra'}])));}]){
    const w=world({mutateRecheck:mutate});
    await assert.rejects(()=>w.run(),/旧清理会话已失效/);
    assert.equal(w.stats.deletes,0);assert.equal(w.jobRow().commandId,'cmd-old');
  }
});
test('同 ID 换路径的伪造删除回执：PERMANENT_DELETE_UNVERIFIED，零入队',async()=>{
  const w=world({tamper:'forgedRow'});
  await assert.rejects(()=>w.run(),/PERMANENT_DELETE_UNVERIFIED/);
  assert.equal(w.jobRow().commandId,'cmd-old');
});
test('确认前重新预览发现节点退出/换根：旧清理会话已失效，零删除零确认',async()=>{
  for(const mutate of [
    copy=>{copy.nodes=copy.nodes.filter(n=>n.id!=='w1');},
    copy=>{copy.nodes=copy.nodes.map(n=>({...n,root:path.join(copy.projectId,'other-root')}));}]){
    const w=world({mutateRecheck:mutate});
    await assert.rejects(()=>w.run(),/旧清理会话已失效|CLEANUP_SCOPE_DRIFTED|SERVER_IDENTITY/);
    assert.equal(w.stats.deletes,0);assert.deepEqual(w.dialogs,['确认删除（1/2）','永久删除（2/2）'],'对话框在会话复核之前，复核失败不得再确认');
    const confirms=[];// 无任何后端 confirm/execute：deletes=0 且会话记录不存在
    assert.equal(w.jobRow().commandId,'cmd-old');void confirms;
  }
});
test('确认期间声明产物路径被改：新 fence 拒绝，零删除零覆盖',async()=>{
  const w=world({answers:['确认删除（1/2）',()=>{w.writeQueueNow(q=>{q.plans.find(row=>row.id==='plan-a').jobs.find(row=>row.index===0).outputDir='work_dirs/hijacked';});
    return '永久删除（2/2）';}]});
  await assert.rejects(()=>w.run(),/任务身份或声明产物路径已变化/);
  assert.equal(w.stats.deletes,0);assert.ok(w.exists('work_dirs/a0'));
  assert.equal(w.jobRow().commandId,'cmd-old','外部写入由围栏拒绝，本流零覆盖');
});
