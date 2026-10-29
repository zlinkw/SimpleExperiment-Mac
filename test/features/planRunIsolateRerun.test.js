const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
require('../_helpers/registerTsRequire');
const {replaceRunOutputs}=require('../../src/features/PlanRunReplacement.ts');
const {PlanCleanup,cleanupDigest}=require('../../dist/features/PlanCleanup');
const clone=value=>JSON.parse(JSON.stringify(value));
// B 冻结合同逐字节复制（simple-sftp cleanup-file-api.js 的 requiredInputs 校验行）：
// 任何 A 出站 preview 携带不合规 requiredInputs 都按真实后端一样 INVALID_REQUEST 拒绝。
const requiredInputsBad=v=>v!==undefined&&(!Array.isArray(v)||v.length>200
  ||v.some(name=>typeof name!=='string'||!name||name.length>4096
    ||/[\\\x00-\x1f:*?[\]{}]/.test(name)||name.startsWith('/')
    ||name.split('/').some(part=>part===''||part==='.'||part==='..')));

function flowFixture(script){
  const events=[],isolated=new Set(),state={};
  const jobs=[0,1,2].map(index=>({index,output_dir:'work/job'+index}));
  const ports={assertCurrent(){},progress(){},save:async()=>events.push('save'),
    preview:async job=>{const mode=(script&&script[job.index])||'ok';
      if(mode==='overlap'){const error=Error('必需输入重叠');error.apiData={code:'ISOLATE_REQUIRED_INPUT_OVERLAP',detail:'checkpoint 被必需输入引用'};throw error;}
      if(mode==='blocker')return{token:'op'+job.index,digest:'d'+job.index,action:'isolate',scope:{},verifiedOnly:false,expiresAt:Date.now()+6e5,confirmations:0,blockers:[{code:'ISOLATE_REQUIRED_INPUT_OVERLAP',nodeId:'worker',detail:'必需 checkpoint 无法隔离'}],rows:[{node:{id:'worker',kind:'remote',user:'u',host:'h',port:22},nodeId:'worker',absolutePath:'/safe/work/job'+job.index,type:'directory',disposition:'protected',protectedReason:'必需 checkpoint 无法隔离'}]};
      return{token:'op'+job.index,digest:'d'+job.index,action:'isolate',scope:{},blockers:[],verifiedOnly:false,expiresAt:Date.now()+6e5,confirmations:0,
        rows:[{node:{id:'worker',kind:'remote',user:'u',host:'h',port:22},nodeId:'worker',absolutePath:'/safe/work/job'+job.index,type:'directory',disposition:'isolate'}]};},
    ask:async p=>{events.push('ask'+p.phase);return p.phase===1?'rerun_all':'isolate_and_run';},
    beforeDelete:async()=>events.push('workers'),hold:async selected=>events.push('hold:'+selected.map(job=>job.index).join(',')),
    verify:async preview=>{if(script&&script[Number(preview.token.slice(2))]==='occupied')throw Error('SOURCE_PATH_UNAVAILABLE：原路径仍被占用');events.push('verify'+preview.token);},
    service:{confirm:async p=>events.push('confirm'+p.phase+p.token),preflightConfirmed:async id=>events.push('check'+id),status:async id=>({state:isolated.has(id)?'completed':'partial'})},
    execute:async id=>{const index=Number(id.slice(2));if(script&&script[index]==='fail')throw Error('ISOLATE_TARGET_CONFLICT：服务器拒绝移动');
      // r82 现场复刻（se413 isolation partial 取证）：execute 返回 partial/带逐 target pending 的"顶层好看"结果，
      // 以及过期令牌拒绝——均须结构化阻断，绝不凭顶层 completed 或空 pendingNodes 放行。
      if(script&&script[index]==='expired')throw Object.assign(Error('PREVIEW_EXPIRED：隔离确认已过期'),{apiData:{code:'PREVIEW_EXPIRED',detail:'隔离确认已过期'}});
      if(script&&script[index]==='partialPending')return{state:'partial',pendingNodes:[],targets:{'0':{state:'pending'}}};
      if(script&&script[index]==='completedPending')return{state:'completed',pendingNodes:[],targets:{'0':{state:'pending'}}};
      isolated.add(id);events.push('isolate'+id);return{state:'completed',pendingNodes:[]};}};
  return{ports,state,jobs,events,isolated,run:()=>replaceRunOutputs(ports,state,'plans/p.yaml',jobs,[],'frozen')};
}

test('a job whose checkpoint cannot be isolated is paused alone while the other jobs isolate, confirm and start',async()=>{
  const f=flowFixture({1:'blocker'}),r=await f.run();
  assert.deepEqual(r.selectedIndices,[0,2]);
  assert.equal(f.state.blocked.length,1);assert.equal(f.state.blocked[0].index,1);assert.match(f.state.blocked[0].reason,/checkpoint/);
  assert.ok(!f.events.includes('confirm1op1')&&!f.isolated.has('op1'),'blocked job never reaches confirm or isolation');
  assert.deepEqual(f.events.filter(e=>e.startsWith('isolate')),['isolateop0','isolateop2']);
  assert.ok(f.events.indexOf('isolateop2')<f.events.indexOf('hold:0,2'),'hold waits only for accepted jobs');
});
test('isolation conflict reported by the server excludes only that job; already isolated batches are not rolled back',async()=>{
  const f=flowFixture({1:'fail'}),r=await f.run();
  assert.deepEqual(r.selectedIndices,[0,2]);assert.ok(f.isolated.has('op0')&&f.isolated.has('op2')&&!f.isolated.has('op1'));
  assert.match(f.state.blocked[0].reason,/ISOLATE_TARGET_CONFLICT/);assert.ok(f.events.includes('hold:0,2'));
});
test('every job blocked before admission means no confirmation, no isolation, no dispatch and an explicit failure',async()=>{
  const f=flowFixture({0:'overlap',1:'overlap',2:'overlap'});
  await assert.rejects(f.run(),error=>error.apiData?.code==='OUTPUT_ISOLATION_FAILED'&&/没有任何 job/.test(String(error.apiData?.detail||error.message)));
  assert.ok(!f.events.some(e=>e.startsWith('ask')||e.startsWith('isolate')||e.startsWith('hold')));
});
test('a source path still occupied after isolation denies only that job; accepted jobs proceed and resume never re-dispatches',async()=>{
  const f=flowFixture({2:'occupied'}),r=await f.run();
  assert.deepEqual(r.selectedIndices,[0,1]);assert.ok(f.events.includes('verifyop0')&&f.events.includes('verifyop1'));
  assert.match(f.state.blocked[0].reason,/SOURCE_PATH_UNAVAILABLE/);
  const before=[...f.events];await f.run();
  assert.deepEqual(f.events.filter(e=>e.startsWith('ask')||e.startsWith('confirm')||e.startsWith('isolate')),before.filter(e=>e.startsWith('ask')||e.startsWith('confirm')||e.startsWith('isolate')),'resume revalidates but never re-confirms, re-isolates or re-asks');
  assert.ok(!f.events.includes('verifyop2'));
});
test('required-capability missing surfaces as an explicit upgrade failure for every job instead of an old delete fallback',async()=>{
  const f=flowFixture({});const saved=f.ports.preview;
  f.ports.preview=async job=>{const error=Error('upgrade');error.apiData={code:'SFTP_ISOLATE_UPGRADE_REQUIRED',detail:'请更新配套插件'};throw error;};
  await assert.rejects(f.run(),error=>error.apiData?.code==='SFTP_ISOLATE_UPGRADE_REQUIRED');
  assert.ok(!f.events.some(e=>e.startsWith('isolate')||e.startsWith('hold')));
  void saved;
});

async function backendFixture(options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'plan-isolate-test-'));
  const scope={projectId:'project',planKey:'owner',planFile:'experiments/plans/p.yaml',planHash:'p-hash',runIds:['run-A'],revision:'frozen',
    nodes:[{id:'local',kind:'local',root}],observationMode:'managed_tmux',authorizationMode:'confirmed_paths',blockers:[]};
  const sources=new Map([['work/job0','sha-old0'],['work/job1','sha-old1']]);
  const registered=new Map();const records=new Map();const calls=[];const maintenanceRequests=[];let checks=0,deletePhase=0;
  // r98 B1：与插件 cleanup-files.py 移动时写下的 completion 逐字同形的真实应答（0.2.111 协议）。
  const completionReceipt=target=>({isolationCompletionProtocol:1,archiveBatch:target.archiveBatch,sourceRelativePath:target.relativePath,
    destinationRelativePath:target.destination,renameCommitted:true,sourceMissingAtMove:true,registered:true,executorsChecked:true,executors:[]});
  // r98 B1 负例：同一后端一致变异（execute 与 check 以同一形状返回，SE 任一路径都不得授权）。
  const variantReceipt=(target,variant)=>{const receipt=completionReceipt(target);
    if(variant==='registeredFalse')receipt.registered=false;
    else if(variant==='protocol2')receipt.isolationCompletionProtocol=2;
    else if(variant==='foreign')receipt.destinationRelativePath='clean_dir/job-000000000000000000000000000000000000000000000000000000000000/tampered';
    else if(variant==='executorsNotEmpty')receipt.executors=['%foreign-window'];
    else if(variant==='incompleteFacts')receipt.executorsChecked=false;
    return receipt;};
  if(options.receiptRegisteredBad)options.receiptBad='registeredFalse'; // r98：既有 R3 选项映射到统一负例通道
  for(const node of options.extraNodes||[])scope.nodes.push(node); // r98 B2：多节点分组用例
  const isolateFlags=()=>({batchPreviewCapacity:4096,managedObservation:1,confirmedPathDeletion:1,
    isolateFast:options.noCapability?0:1,requiredInputGuard:1,registeredIsolationDeletion:1,subtreeSingleWriter:1,
    // r87 块4：0.2.111 才有后台清隔离副本能力；默认（旧插件）不上报该字段。
    ...(options.backgroundDelete?{backgroundIsolatedDelete:1}:{})});
  const sftp=async(method,params)=>{calls.push({method,params:clone(params)});
    if(method==='files.cleanup.preview'){
      const targets=params.targets.map(row=>{
        if(params.action==='isolate'&&!/^job-[a-f0-9]{48}$/.test(String(row.archiveBatch||'')))throw Object.assign(Error('INVALID_ARCHIVE_BATCH'),{code:'INVALID_ARCHIVE_BATCH'});
        if(requiredInputsBad(row.requiredInputs))throw Object.assign(Error('INVALID_REQUEST'),{code:'INVALID_REQUEST',apiData:{code:'INVALID_REQUEST',detail:'requiredInputs 合同违例'}});
        // 等价提取自 B cleanup-files.py 的守卫：输入存在且等于目标或位于目标之下 → 拒绝，先于任何移动。
        if(params.action==='isolate'&&Array.isArray(row.requiredInputs))for(const name of row.requiredInputs)
          if(sources.has(name)&&(name===row.relativePath||name.startsWith(row.relativePath+'/')))
            throw Object.assign(Error('隔离目标将连同必需输入 '+name),{code:'ISOLATE_REQUIRED_INPUT_OVERLAP',apiData:{code:'ISOLATE_REQUIRED_INPUT_OVERLAP',detail:'隔离目标将连同必需输入 '+name}});
        if(params.action==='isolate'&&row.relativePath==='work/locked')throw Object.assign(Error('overlap'),{code:'ISOLATE_REQUIRED_INPUT_OVERLAP',apiData:{code:'ISOLATE_REQUIRED_INPUT_OVERLAP',detail:'必需输入重叠'}});
        if(params.action==='delete'&&!/^clean_dir\/job-[a-f0-9]{48}\//.test(row.relativePath))
          throw Object.assign(Error('NOT_REGISTERED_ISOLATION：只允许删除已登记隔离目标'),{code:'NOT_REGISTERED_ISOLATION',apiData:{code:'NOT_REGISTERED_ISOLATION',detail:row.relativePath}});
        const fingerprint=sources.get(row.relativePath);if(!fingerprint)throw Object.assign(Error('MISSING_TARGET'),{code:'MISSING_TARGET'});
        return{...row,absolutePath:params.node.root+'/'+row.relativePath,fingerprint,device:'1',inode:row.relativePath,size:10,inventory:[]};});
      const token=cleanupDigest([params.node.id,targets,calls.length]).slice(0,48);
      const record={token,digest:cleanupDigest(targets),rootIdentity:{path:params.node.root},targets,confirmations:0,action:params.action,node:params.node,completed:new Set(),started:new Set(),executorExit:null};
      // 与 B 9ca51e1d 一致：只有确认路径删除回包携带批量快删安全标志，隔离仍走隔离能力。
      records.set(token,record);return clone({...record,safety:{...isolateFlags(),...(params.action==='delete'?{entryIdentityBind:1,batchedFastDelete:1,directoryTreeIsolateDelete:1,isolationRenameNoReplace:1,fastDeleteBatchLimit:5000}:{})},confirmations:0});}
    if(method==='files.cleanup.inspect')return{target:{type:params.target.type,absolutePath:params.node.root+'/'+params.target.relativePath,missing:!sources.has(params.target.relativePath)}};
    // r87 块3：批量只读观察 v1.10 合同（与 isolatedReviewWorld 参考实现同形）——按 key 逐项回真实源状态。
    // r90：observeBatch 请求不带 token，必须放在下方"逐 token 记录"公共守卫之前，否则被误判为未知令牌。
    if(method==='files.cleanup.observeBatch')return{ok:true,observationId:params.observationId,rootIdentity:{path:params.node.root},capabilities:{batchCleanupObservation:1},
      observations:params.targets.map(t=>{const present=sources.has(t.relativePath);const rec=t.backendToken!==undefined?records.get(t.backendToken):undefined;
        const state=rec?(rec.completed.has(t.backendIndex)?'completed':rec.started&&rec.started.has(t.backendIndex)?'executing':'pending'):undefined;
        return{key:t.key,relativePath:t.relativePath,type:t.type,status:present?'present':'gone',...(state?{state}:{}),
          executorsChecked:true,executors:[],target:{relativePath:t.relativePath,type:t.type,missing:!present,absolutePath:params.node.root+'/'+t.relativePath}};})};
    const row=records.get(params.token);assert.ok(row,'frozen backend record');
    if(method==='files.cleanup.status'){const observations=row.targets.map((target,index)=>({state:row.completed.has(index)?'completed':row.started&&row.started.has(index)?'executing':'pending'}));
      return clone({...row,confirmations:row.confirmations,observations,states:observations.map(row=>row.state),batchExecuting:false});}
    if(method==='files.cleanup.confirm'){if(row.action==='isolate'&&params.phase>1)throw Object.assign(Error('CONFIRM_PHASE_LIMIT'),{code:'CONFIRM_PHASE_LIMIT'});
      if(row.action==='delete')deletePhase=params.phase;row.confirmations=params.phase;return{ok:true};}
    if(method==='files.cleanup.check'){const target=row.targets[params.index];
      // r98 B1 路径③/④/⑤：完成行的 check 应答携带该目标自己的回执；completionEcho 模拟托管观察完成回显
      // （回执嵌在 completion，不带顶层 receipt）；checkWithoutReceipt 用于证明回执只能来自某条特定应答。
      const goodReceipt=()=>{if(row.action!=='isolate'||!options.backgroundDelete||options.checkWithoutReceipt)return undefined;
        if(options.receiptBad==='missing')return undefined;
        return options.receiptBad?variantReceipt(target,options.receiptBad):completionReceipt(target);};
      if(row.completed.has(params.index)){const receipt=goodReceipt();
        if(receipt&&options.completionEcho)return{state:'completed',verifiedBy:'rename_registered',completion:receipt};
        return{state:'completed',verifiedBy:row.action==='isolate'?'rename_registered':'path_absence',...(receipt?{receipt}:{})};}
      if(row.action==='delete'&&row.started.has(params.index)){checks++;if(checks>=(options.slowDelete||0))row.completed.add(params.index);
        return row.completed.has(params.index)?{state:'completed',verifiedBy:'path_absence'}:{state:'executing'};}
      return{state:row.started&&row.started.has(params.index)?'executing':'pending'};}
    if(method==='files.cleanup.execute'){const target=row.targets[params.index];assert.ok(row.confirmations>=(row.action==='delete'?2:1),'backend confirmations before execute');
      row.started||=new Set();
      if(row.action==='isolate'){
        if(options.lostExecuteOnce&&!row.lostThrown){ // r98 B1 路径⑤夹具：移动已提交、应答在传输中丢失
          row.lostThrown=true;sources.delete(target.relativePath);sources.set(target.destination,target.fingerprint);
          registered.set(target.relativePath,target.destination);row.completed.add(params.index);throw new Error('传输中断（该次应答丢失）');}
        const already=row.completed.has(params.index);
        sources.delete(target.relativePath);sources.set(target.destination,target.fingerprint);
        registered.set(target.relativePath,target.destination);row.completed.add(params.index);
        // r98 B1 路径①/②：应答为插件真实协议形状——直接完成 {ok,receipt}；后端已完成的重入
        // {ok,alreadyCompleted,receipt}（alreadyOnExecute 模拟 check 未见完成而 execute 发现已完成）。
        if(options.backgroundDelete&&!options.completionEcho){
          const shape=already||options.alreadyOnExecute?{ok:true,alreadyCompleted:true}:{ok:true};
          if(options.receiptBad==='missing')return shape;
          return{...shape,receipt:options.receiptBad?variantReceipt(target,options.receiptBad):completionReceipt(target)};}}
      else{// 与 B 快删链一致：一次 execute 事务性处理整批已确认目标，不按 index 逐条执行。
        row.started||=new Set();for(const [index,target] of row.targets.entries()){if(row.completed.has(index))continue;sources.delete(target.relativePath);row.started.add(index);row.completed.add(index);}}
      return{ok:true};}
    // r87 块4 / r98 B2：后台清隔离副本入口——SE 只交 token+冻结摘要+目标绑定；插件端语义逐字仿真：
    // 单 token、index 不得重复（cleanup-file-api.js :1095+ 的 TARGET_BINDINGS_MISMATCH），绑定必须等于该
    // token 台账内该 index 的登记；跨 token 借用（别的节点/别的分块的目标混进来）会在这两条断言处暴露。
    if(method==='files.cleanup.isolatedMaintenanceDelete'){assert.ok(params.token&&params.digest&&Array.isArray(params.targets)&&params.targets.length
      &&params.targets.every(t=>Number.isInteger(t.index)&&t.relativePath&&t.destination&&Object.keys(t).length===3),'SE 只提交 token/digest 与 index/relativePath/destination 绑定');
      const record=records.get(params.token);assert.ok(record&&record.action==='isolate','后台删除只接受隔离 token');
      const seen=new Set();maintenanceRequests.push(clone(params));
      for(const t of params.targets){assert.ok(!seen.has(t.index),'同一 token 的 index 必须唯一（插件拒绝重复 index）');seen.add(t.index);
        assert.ok(t.index<record.targets.length,'index 必须落在该 token 的冻结台账内');
        assert.equal(record.targets[t.index].relativePath,t.relativePath);assert.equal(record.targets[t.index].destination,t.destination);}
      // r98 补：插件拒绝走 fail(code,message=code,{reason})（:311-312）——原因只在 error.apiData.reason，message 仅码名。
      if(options.maintenanceOutcome==='secondRejected'&&maintenanceRequests.length===2)
        throw Object.assign(new Error('TARGET_BINDINGS_MISMATCH'),{code:'TARGET_BINDINGS_MISMATCH',apiData:{reason:'destination 与本批次登记不符，绑定不符（apiData.reason 通道）'}});
      const outcome=options.maintenanceOutcome==='firstFailed'?(maintenanceRequests.length===1?'failed':'accepted'):options.maintenanceOutcome;
      if(outcome==='failed')return{state:'failed',reason:'插件侧删除被拒绝（reason 通道）'}; // r98 附带项：原因在 reason 字段
      if(outcome==='unknown')throw new Error('传输中断');
      return{state:'accepted',operationId:'maint-'+params.token.slice(0,8)};}
    throw new Error(method);};
  // r99 修（宿主 r99 窄跑 4 红定位，简报 §16）：B2 分组用例改走真实 job 作用域，废弃 plainCandidates 直挂
  // 候选的形状——archiveBatch 由引擎按 job 令牌生成（PlanCleanup.ts:887 "job-"+token），插件端硬要求
  // archiveBatch 为字符串且 destination 匹配 clean_dir/job-<48hex>/（cleanup-file-api.js:1159-1161，本夹具
  // :97 逐字仿真），"无 job 的隔离"本就被后端 INVALID_ARCHIVE_BATCH 挡下，到不了分组接线。collect 因此按
  // manifest.declarations 逐条产出候选（真实批次输出即一个 job 多声明，声明可带 nodeId 表示该输出登记在
  // 哪个节点——与 ManifestCleanup"每节点/输出一条有界读取"同形）。
  const service=new PlanCleanup({storageRoot:path.join(root,'state'),
    collect:async(file,opts)=>clone({...scope,job:opts?.job,candidates:(opts.job?opts.job.manifest.declarations:[]).map(declaration=>({nodeId:declaration.nodeId||'local',relativePath:declaration.output_dir,type:'directory',category:'输出目录',owners:['o'],evidence:['精确注册'],dependencies:[]}))}),
      sftp,updateIndexes:async()=>{},restoreGate:async()=>{}});
  const job=(index,extra={})=>{const {declarations,...rest}=extra;return{workflowId:'run-A',commandId:'c'+index,index,purpose:'replace_outputs',manifest:{declarations:declarations||[{index,output_dir:'work/job'+index,...rest}]}};};
  return{root,scope,service,job,sources,registered,calls,records,maintenanceRequests,get deletePhase(){return deletePhase;},noCapability:()=>{options.noCapability=true;},allowJob:rel=>sources.set(rel,'sha-x')};
}
const exactOf=preview=>preview.rows.filter(row=>row.disposition===preview.action).map(row=>row.node.id+':'+row.absolutePath);
test('background deletion binds both confirmations and prunes parents only after artifact deletion; parent failure stays unknown without replay',async()=>{
 for(const fail of [false,true]){
  const f=await backendFixture({backgroundDelete:true});
  const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:f.job(0)});
  const op=await f.service.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:exactOf(preview)});
  await f.service.execute(op.id);
  const parents=[{token:'parent-token',node:preview.rows[0].node,sourceIsolationTokens:[preview.rows[0].backendToken],confirmations:1}];
  await assert.rejects(f.service.autoDeleteIsolated(op.id,parents),/两次确认/);assert.equal(f.maintenanceRequests.length,0);
  parents[0].confirmations=2;let pruned=0;
  f.service.executeEmptyParentCleanup=async actual=>{assert.deepEqual(actual,parents);assert.equal(f.maintenanceRequests.length,1);pruned++;if(fail)throw Error('EMPTY_ISOLATION_PARENT_NOT_EMPTY');return 2;};
  const outcome=await f.service.autoDeleteIsolated(op.id,parents);
  assert.equal(f.maintenanceRequests[0].parentCleanupToken,'parent-token');assert.equal(pruned,1);
  assert.equal(outcome.state,fail?'unknown':'accepted');
  if(fail)assert.match((await f.service.status(op.id)).autoDeleteError,/空目录尚未确认移除/);
  await f.service.autoDeleteIsolated(op.id,parents);assert.equal(f.maintenanceRequests.length,1);assert.equal(pruned,1);
 }
});

test('isolate preview on an old backend without the fast-isolate capability fails explicitly with zero mutations',async()=>{
  const f=await backendFixture({noCapability:true});
  await assert.rejects(f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:f.job(0)}),
    error=>error.apiData?.code==='SFTP_ISOLATE_UPGRADE_REQUIRED');
  assert.ok(f.sources.has('work/job0'),'nothing moved');
});
test('isolate needs exactly one confirmation, moves sources into the registered clean batch, then permanent delete re-enters the double-confirmed flow',async()=>{
  const f=await backendFixture();
  const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:f.job(0)});
  assert.equal(preview.action,'isolate');assert.equal(preview.rows[0].disposition,'isolate');
  assert.match(preview.rows[0].destination,/^clean_dir\/job-[a-f0-9]{48}\/work\/job0$/);
  const op=await f.service.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:exactOf(preview)});
  assert.ok(op.state==='ready');
  await assert.rejects(f.service.confirm({token:preview.token,digest:preview.digest,phase:2,confirm:true,exactTargets:exactOf(preview)}),/CONFIRM_REQUIRED/);
  const done=await f.service.execute(op.id);assert.equal(done.state,'completed');
  assert.ok(!f.sources.has('work/job0')&&f.sources.has(preview.rows[0].destination),'source renamed into the clean batch');
  await f.service.assertIsolatedSourcesAbsent(preview);
  const deleted=await f.service.isolatedDeletePreview(op.id);
  assert.ok(deleted.rows.every(row=>row.relativePath.startsWith('clean_dir/job-')));
  await f.service.confirm({token:deleted.token,digest:deleted.digest,phase:1,confirm:true,exactTargets:exactOf(deleted)});
  await f.service.confirm({token:deleted.token,digest:deleted.digest,phase:2,confirm:true,exactTargets:exactOf(deleted)});
  const del=await f.service.execute(deleted.token);assert.equal(del.state,'completed');
  assert.ok(!f.sources.has(preview.rows[0].destination));assert.equal(f.deletePhase,2);
  await f.service.status(op.id);const after=await f.service.status(op.id);
  assert.equal(after.state,'completed','later permanent deletion never reverts the frozen isolation receipt');
});
// ── r87（块3 合并查询）：隔离后源路径核实按节点合并为一次批量只读观察；核验数量与阻断语义不变 ──
test('r87 block3: post-isolation source verification merges every original path of one node into a single batched observation',async()=>{
  const f=await backendFixture();const previews=[];
  for(const index of [0,1]){
    const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:f.job(index)});
    const op=await f.service.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:exactOf(preview)});
    await f.service.execute(op.id);previews.push(preview);
  }
  const merged={...previews[0],rows:[...previews[0].rows,...previews[1].rows].filter(row=>row.disposition==='isolate')};
  assert.equal(merged.rows.length,2,'两个 job 各一个隔离目标');
  const cut=f.calls.length;
  await f.service.assertIsolatedSourcesAbsent(merged);
  const batched=f.calls.slice(cut).filter(row=>row.method==='files.cleanup.observeBatch');
  assert.equal(batched.length,1,'同一节点同一轮只发一次批量观察');
  assert.deepEqual(batched[0].params.targets.map(t=>t.relativePath).sort(),['work/job0','work/job1'],'两个原路径都必须在同一次观察里逐项核验');
  assert.equal(f.calls.slice(cut).filter(row=>row.method==='files.cleanup.inspect').length,0,'合并后不再逐行 inspect');
});
test('r87 block3: a still-occupied source still blocks the job, and one occupied target never masks the other rows in the merged batch',async()=>{
  const f=await backendFixture();
  const p0=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:f.job(0)});
  const op0=await f.service.confirm({token:p0.token,digest:p0.digest,phase:1,confirm:true,exactTargets:exactOf(p0)});
  await f.service.execute(op0.id);
  const p1=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:f.job(1)});// job1 未执行：源仍在
  const merged={...p0,rows:[...p0.rows,...p1.rows].filter(row=>row.disposition==='isolate')};
  const cut=f.calls.length;
  await assert.rejects(f.service.assertIsolatedSourcesAbsent(merged),error=>error.apiData?.code==='SOURCE_PATH_UNAVAILABLE'&&String(error.message).includes('work/job1'));
  assert.equal(f.calls.slice(cut).filter(row=>row.method==='files.cleanup.observeBatch').length,1,'失败路径同样一次批量，不逐行拆查');
});
// ── r87（块4 隔离完即派发+后台自动删接线）：能力门、完成回执授权、旁路提交与幂等 ──────────
const isolateOne=async(f,index)=>{const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:f.job(index)});
  const op=await f.service.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:exactOf(preview)});
  return{preview,op};};
test('r87 block4: complete isolation receipts freeze on the row, authorize exactly one background delete, and resubmission never resends',async()=>{
  const f=await backendFixture({backgroundDelete:true});
  const{preview,op}=await isolateOne(f,0);
  assert.equal(preview.autoDeleteCapability,1,'插件应答 backgroundIsolatedDelete 时预览必须置能力位（0.2.111 门）');
  await f.service.execute(op.id);
  const persisted=await f.service.status(op.id);
  assert.deepEqual(persisted.preview.rows.filter(row=>row.disposition==='isolate').map(row=>row.isolationReceipt),
    [{renamed:true,sourceMissingAtMove:true,registered:true}],'完成回执随目标冻结落盘（r98：内部只保留插件真实返回的三项事实，renameCommitted→renamed）');
  const outcome=await f.service.autoDeleteIsolated(op.id);
  assert.equal(outcome.state,'accepted','受理态如实记 accepted——绝不写成删除已完成');
  assert.equal(typeof outcome.operationId,'string');
  const deletes=f.calls.filter(row=>row.method==='files.cleanup.isolatedMaintenanceDelete');
  assert.equal(deletes.length,1);
  assert.deepEqual(deletes[0].params.targets,[{index:0,relativePath:'work/job0',destination:preview.rows[0].destination}],'只交 token+摘要+目标绑定，destination 来自冻结行');
  const again=await f.service.autoDeleteIsolated(op.id);
  assert.equal(again.state,'accepted');assert.equal(again.operationId,outcome.operationId);
  assert.equal(f.calls.filter(row=>row.method==='files.cleanup.isolatedMaintenanceDelete').length,1,'已受理的旁路重试不得重发删除请求');
  assert.equal((await f.service.status(op.id)).autoDeleteState,'accepted');
});
test('r87 block4: an old plugin without backgroundIsolatedDelete gets an explicit upgrade refusal and zero delete RPCs',async()=>{
  const f=await backendFixture();
  const{op}=await isolateOne(f,0);await f.service.execute(op.id);
  await assert.rejects(f.service.autoDeleteIsolated(op.id),
    error=>error.apiData?.code==='SFTP_ISOLATE_AUTODELETE_UPGRADE_REQUIRED'&&/0\.2\.111/.test(String(error.message)));
  assert.equal(f.calls.filter(row=>row.method==='files.cleanup.isolatedMaintenanceDelete').length,0,'旧插件绝不调用新接口');
  assert.equal((await f.service.status(op.id)).autoDeleteState,undefined,'拒绝不留下任何伪状态');
});
test('r87 block4: a token with unfinished targets or a registration-failed receipt authorizes nothing — zero RPCs, no pseudo-state',async()=>{
  const f=await backendFixture({backgroundDelete:true,receiptRegisteredBad:true});
  const{op}=await isolateOne(f,0);
  await assert.rejects(f.service.autoDeleteIsolated(op.id),error=>error.apiData?.code==='ISOLATE_AUTODELETE_NOT_AUTHORIZED',
    '确认未执行（目标未完成）时不授权');
  await f.service.execute(op.id);
  await assert.rejects(f.service.autoDeleteIsolated(op.id),error=>error.apiData?.code==='ISOLATE_AUTODELETE_NOT_AUTHORIZED',
    '登记未成功＝回执不全，不授权后台删除');
  assert.equal(f.calls.filter(row=>row.method==='files.cleanup.isolatedMaintenanceDelete').length,0);
  assert.equal((await f.service.status(op.id)).autoDeleteState,undefined);
});
test('r87 block4: delete failure and transport loss only land in a truthful state — no rollback, no rethrow, no silent resend',async()=>{
  for(const[outcome,expected]of[['failed','failed'],['unknown','unknown']]){
    const f=await backendFixture({backgroundDelete:true,maintenanceOutcome:outcome});
    const{preview,op}=await isolateOne(f,0);await f.service.execute(op.id);
    const first=await f.service.autoDeleteIsolated(op.id);
    assert.equal(first.state,expected);assert.ok(first.message,'失败原因必须留给操作日志与通知');
    assert.equal(f.calls.filter(row=>row.method==='files.cleanup.isolatedMaintenanceDelete').length,1);
    const persisted=await f.service.status(op.id);
    assert.equal(persisted.state,'completed','删除失败不回滚隔离完成事实');
    assert.equal(persisted.autoDeleteState,expected);assert.ok(persisted.autoDeleteError);
    assert.ok(f.sources.has(preview.rows[0].destination),'隔离副本仍在清理区，可走既有人工双确认删除');
    const second=await f.service.autoDeleteIsolated(op.id);
    assert.equal(second.state,expected);
    assert.equal(f.calls.filter(row=>row.method==='files.cleanup.isolatedMaintenanceDelete').length,1,'失败/未知结果同样不自动重发（防重复删除执行者）');
  }
});

// ── r98 B1：真实协议形状、五条完成路径、硬门+行绑定负例 ──────────────────────────────────────────────
test('r98 B1: a lost execute response freezes the completion receipt from the read-only check convergence, then authorizes exactly one background submit',async()=>{
  const f=await backendFixture({backgroundDelete:true,lostExecuteOnce:true});
  const{op}=await isolateOne(f,0);
  // r99 修（宿主 r99 窄跑首条红）：托管执行链的引擎契约是 execute 绝不抛回派发链——PlanCleanup.ts:643-644
  // 的 catch 只落 partial+原错误并返回；r98 首版误按"抛错"断言。改为按契约断言，且比原断言更强：
  // partial 如实、错误原文保留、目标不得写伪 completed、没拿到完成应答绝不伪造回执。
  const lost=await f.service.execute(op.id);
  assert.equal(lost.state,'partial','丢应答不抛回派发链，如实落 partial（引擎契约 :643-644）');
  assert.match(String(lost.error),/传输中断/,'失败原因原文保留，不吞不掩盖');
  assert.ok(Object.values(lost.targets).every(target=>target.state==='pending'),'未核实前目标保持 pending，绝不写伪 completed');
  assert.equal(lost.preview.rows[0].isolationReceipt,undefined,'第一次执行未获完成应答——绝不伪造回执');
  const done=await f.service.execute(op.id);assert.equal(done.state,'completed','丢应答由该行自己的只读 check 应答收敛，不重复移动');
  assert.equal(f.calls.filter(row=>row.method==='files.cleanup.execute').length,1,'重试绝不重复执行移动');
  assert.ok(done.preview.rows[0].isolationReceipt,'回执来自 check 应答并随行冻结（路径⑤）');
  const outcome=await f.service.autoDeleteIsolated(op.id);assert.equal(outcome.state,'accepted');
  assert.equal(f.maintenanceRequests.length,1);});
test('r98 B1: an alreadyCompleted re-entry response authorizes with the receipt from that response alone',async()=>{
  const f=await backendFixture({backgroundDelete:true,alreadyOnExecute:true,checkWithoutReceipt:true});
  const{op}=await isolateOne(f,0);await f.service.execute(op.id);
  const persisted=await f.service.status(op.id);
  assert.ok(persisted.preview.rows[0].isolationReceipt,'check 永不携带回执时，冻结只能来自 execute 的 alreadyCompleted 应答（路径②）');
  const outcome=await f.service.autoDeleteIsolated(op.id);assert.equal(outcome.state,'accepted');});
test('r98 B1: a managed completion echo freezes the receipt from the nested completion field',async()=>{
  const f=await backendFixture({backgroundDelete:true,completionEcho:true});
  const{op}=await isolateOne(f,0);await f.service.execute(op.id);
  const persisted=await f.service.status(op.id);
  assert.ok(persisted.preview.rows[0].isolationReceipt,'完成回显（嵌套 completion）是插件自己认回执的规范读法（路径④）');
  const outcome=await f.service.autoDeleteIsolated(op.id);assert.equal(outcome.state,'accepted');});
test('r98 B1: hard gate — a missing receipt, protocol≠1, registered=false, a foreign destination or non-empty executors authorize nothing (zero RPCs, no pseudo-state)',async()=>{
  for(const variant of ['missing','registeredFalse','protocol2','foreign','executorsNotEmpty','incompleteFacts']){
    const f=await backendFixture({backgroundDelete:true,receiptBad:variant});
    const{op}=await isolateOne(f,0);const done=await f.service.execute(op.id);
    assert.equal(done.state,'completed','隔离完成事实本身不受回执形状影响（'+variant+'）');
    assert.equal((await f.service.status(op.id)).preview.rows[0].isolationReceipt,undefined,'硬门/绑定不合格一律视为无回执（'+variant+'）');
    await assert.rejects(f.service.autoDeleteIsolated(op.id),error=>error.apiData?.code==='ISOLATE_AUTODELETE_NOT_AUTHORIZED',variant);
    assert.equal(f.calls.filter(row=>row.method==='files.cleanup.isolatedMaintenanceDelete').length,0,variant+'：不授权就零 RPC');}});
// ── r98 B2：单 token 语义按真实后端分组、逐组提交、结论独立落盘、部分受理措辞如实 ──────────────────────
test('r98 B2: every backend token carries its own index-0-based ledger — one maintenance request per token, and one failed group never blocks the next job',async()=>{
  // r99 修：真实形状 = 一个批次 job 的多个输出声明分布在不同节点（archiveBatch 由引擎按 job 令牌生成，
  // 见 collect 上方注释；无 job 的形状会被后端 INVALID_ARCHIVE_BATCH 挡在预检，不属于本接线的可达路径）。
  // r99c 乙（GPT 批准的切分）：1+1 → 2+1 行——同 token 台账内也要装多目标，证明"分组提交"不是"每组一条"
  // 的巧合，各组 index 台账独立（w1 台账与 local 台账同样从 0 起）；全链仍真实执行、规模 3 目标（§17 模型 <0.1s）。
  const f=await backendFixture({backgroundDelete:true,extraNodes:[{id:'w1',kind:'remote',user:'u',host:'host',port:2222,root:'/w1-root'}],maintenanceOutcome:'firstFailed'});
  const batchJob=f.job(9,{declarations:[{index:0,output_dir:'work/ja',nodeId:'local'},{index:1,output_dir:'work/jb',nodeId:'local'},{index:2,output_dir:'work/ja',nodeId:'w1'}]});
  f.sources.set('work/ja','sha-ja');f.sources.set('work/jb','sha-jb');
  const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:batchJob});
  assert.equal(preview.rows.filter(row=>row.disposition==='isolate').length,3);assert.equal(preview.blockers.length,0);
  const op=await f.service.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:exactOf(preview)});
  const done=await f.service.execute(op.id);assert.equal(done.state,'completed');
  const isolateRows=done.preview.rows.filter(row=>row.disposition==='isolate');
  assert.equal(new Set(isolateRows.map(row=>row.backendToken)).size,2,'两个后端 token');
  const w1Row=isolateRows.find(row=>row.node.id==='w1');
  assert.deepEqual(isolateRows.filter(row=>row.node.id==='local').map(row=>row.backendIndex),[0,1],'local 台账 index 0..1');
  assert.equal(w1Row.backendIndex,0,'w1 台账同样从 0 起——单请求合并方案在此必然绑定错位的形状');
  const outcome=await f.service.autoDeleteIsolated(op.id);
  assert.equal(f.maintenanceRequests.length,2,'每组各一次提交，绝不跨 token 合并');
  assert.deepEqual(f.maintenanceRequests.map(request=>request.targets.length),[2,1],'每组带且只带自己台账的目标');
  assert.deepEqual(f.maintenanceRequests[1].targets.map(target=>target.index),[0],'次组唯一目标复用自身台账 index 0');
  assert.equal(outcome.state,'unknown','部分受理绝不写"已提交/全部提交"');
  assert.match(outcome.message,/1 组已受理/);assert.match(outcome.message,/未受理/);assert.match(outcome.message,/reason 通道/,'失败原因走 reason 字段也不许丢');
  const persisted=await f.service.status(op.id);
  assert.equal(persisted.autoDeleteGroups.length,2);assert.deepEqual(persisted.autoDeleteGroups.map(row=>row.state).sort(),['accepted','failed']);
  assert.equal(persisted.state,'completed','后台分组结果不回滚隔离完成事实');
  const retry=await f.service.autoDeleteIsolated(op.id);assert.equal(retry.state,'unknown');
  assert.equal(f.maintenanceRequests.length,2,'已记录分组（含失败与未知组）一律不重发');
  const second=await isolateOne(f,1);await f.service.execute(second.op.id); // 新 job 的隔离派发不被旁路删除结果阻塞
  assert.equal((await f.service.status(second.op.id)).state,'completed','后续 job 照常完成');});
test('r98 补: a fail(code,{reason}) rejection keeps apiData.reason verbatim in the group record and aggregate wording, still unknown, never resent',async()=>{
  // r99 修：同上，真实 job 作用域两节点批次（archiveBatch 形态要求见 collect 上方注释）。
  const f=await backendFixture({backgroundDelete:true,extraNodes:[{id:'w1',kind:'remote',user:'u',host:'host',port:2222,root:'/w1-root'}],maintenanceOutcome:'secondRejected'});
  const batchJob=f.job(9,{declarations:[{index:0,output_dir:'work/ja',nodeId:'local'},{index:1,output_dir:'work/ja',nodeId:'w1'}]});
  f.sources.set('work/ja','sha-ja');
  const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:batchJob});
  assert.equal(preview.blockers.length,0,'预检必须真实通过，拒绝要落在分组提交阶段，不是预检');
  const op=await f.service.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:exactOf(preview)});
  assert.equal((await f.service.execute(op.id)).state,'completed');
  const outcome=await f.service.autoDeleteIsolated(op.id);
  assert.equal(f.maintenanceRequests.length,2);
  assert.equal(outcome.state,'unknown','拒绝结果对调用方不可断言为 failed——仍 unknown，绝不升级措辞');
  assert.match(outcome.message,/apiData\.reason 通道/,'抛错拒绝的具体原因必须原文进聚合消息，不许只剩码名');
  const persisted=await f.service.status(op.id);
  assert.deepEqual(persisted.autoDeleteGroups.map(row=>row.state).sort(),['accepted','unknown'],'一组受理+一组拒绝=unknown，拒绝组不得写成 failed');
  const rejectedGroup=persisted.autoDeleteGroups.find(row=>row.state==='unknown');
  assert.ok(rejectedGroup,'第二组记 unknown（不是 failed）');
  assert.match(rejectedGroup.error,/绑定不符（apiData\.reason 通道）/,'组内落盘保留 reason 原文');
  const retry=await f.service.autoDeleteIsolated(op.id);assert.equal(retry.state,'unknown');
  assert.equal(f.maintenanceRequests.length,2,'已记录组绝不重发');
  const second=await isolateOne(f,1);await f.service.execute(second.op.id);
  assert.equal((await f.service.status(second.op.id)).state,'completed','拒绝组不阻塞后续 job 派发');});
test('r98 B2: one node chunked over the 500-target engine limit freezes two per-chunk ledgers whose row bindings never cross chunks',async()=>{
  // r99c 甲（GPT 批准的覆盖切分，简报 §18）：本条只承担"分块边界与行→台账归属"——501 条真实声明只跑到
  // preview（2 次分块 RPC，零全链持久化；r99b 的 600 条全链在宿主入口 20s 被 cancelled，计时模型见 §17，
  // O(n²) 持久化放大另立性能切片登记）。同节点两 token 的分组提交由 §18-丙承担（GPT 点名的缺口），
  // 跨 token 合并请求的反证由乙与两节点用例的夹具台账校验承担。
  const rels=Array.from({length:501},(_,i)=>'work/c'+String(i).padStart(3,'0'));
  const f=await backendFixture({backgroundDelete:true});
  const batchJob=f.job(9,{declarations:rels.map((relativePath,index)=>({index,output_dir:relativePath}))});
  for(const relativePath of rels)f.sources.set(relativePath,'sha-'+relativePath);
  const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:batchJob});
  assert.equal(preview.blockers.length,0);assert.equal(preview.rows.filter(row=>row.disposition==='isolate').length,501);
  assert.deepEqual(f.calls.filter(row=>row.method==='files.cleanup.preview').map(row=>row.params.targets.length),[500,1],'预检请求形态即分块边界：每块一次、绝不合并');
  const rows=preview.rows.filter(row=>row.disposition==='isolate');
  const tokens=new Set(rows.map(row=>row.backendToken));assert.equal(tokens.size,2,'同节点超 500 上限冻结两个后端台账');
  assert.deepEqual(rows.slice(0,500).map(row=>row.backendIndex),Array.from({length:500},(_,index)=>index),'首 500 行属第一台账，index 恰为 0..499');
  assert.equal(new Set(rows.slice(0,500).map(row=>row.backendToken)).size,1,'前 500 行同台账，行→归属不跨块');
  assert.notEqual(rows[500].backendToken,rows[0].backendToken,'第 501 行属第二台账');
  assert.equal(rows[500].backendIndex,0,'第二台账 index 从 0 起——与第一台账重复，只按节点/合并提交的实现必然错绑');
  assert.equal(rows[500].relativePath,rels[500],'归属逐行可指认：第 501 行就是越限那条');});
test('r99c 丙: a same-node two-token ledger with fixture-arranged completion facts (NOT a real execute chain) is still submitted once per token by autoDeleteIsolated',async()=>{
  // r99c 丙（GPT 点名的缺口）：完成事实与回执是**夹具安排的前置状态**（直接写入持久化操作文件，声明见下），
  // 不是真实 execute 得出，本条不声称覆盖完整隔离执行链；它只把甲产出的"同节点两 token"输入直接喂给
  // 生产 autoDeleteIsolated()，堵住"分组退化成只按节点"的退化路径——甲不调后台删除、乙两节点天然分开，
  // 都挡不住那种退化。501 条 preview 仅 2 次 RPC，不触发每目标持久化（§17 模型）。
  const rels=Array.from({length:501},(_,i)=>'work/d'+String(i).padStart(3,'0'));
  const f=await backendFixture({backgroundDelete:true});
  const batchJob=f.job(9,{declarations:rels.map((relativePath,index)=>({index,output_dir:relativePath}))});
  for(const relativePath of rels)f.sources.set(relativePath,'sha-'+relativePath);
  const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:batchJob});
  assert.equal(preview.blockers.length,0);assert.equal(new Set(preview.rows.filter(row=>row.disposition==='isolate').map(row=>row.backendToken)).size,2);
  const op=await f.service.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:exactOf(preview)});
  // ——夹具安排的前置状态（显式声明）：全部目标"已完成+回执齐备"直接落进持久化操作文件；
  // status() 对无 executionRequestedAt 的托管操作原样读回（status :246 的早退 return，:255），不会被重观察覆盖。
  const file=path.join(f.root,'state',op.id+'.json');
  const arranged=JSON.parse(await fs.readFile(file,'utf8'));
  for(const row of arranged.preview.rows)if(row.disposition==='isolate')row.isolationReceipt={renamed:true,sourceMissingAtMove:true,registered:true};
  for(const rowId of Object.keys(arranged.targets))arranged.targets[rowId]={state:'completed',receipt:{source:'fixture-arranged-front-state'}};
  await fs.writeFile(file,JSON.stringify(arranged));
  const outcome=await f.service.autoDeleteIsolated(op.id);
  assert.equal(outcome.state,'accepted','同节点两个 token 全受理才 accepted');
  assert.equal(f.maintenanceRequests.length,2,'同节点也按 token 各一次提交——分组绝不退化到只按节点');
  assert.deepEqual(f.maintenanceRequests.map(request=>request.targets.length),[500,1],'各组只带自己台账的目标');
  assert.notEqual(f.maintenanceRequests[0].token,f.maintenanceRequests[1].token,'两组各用自己的 token/digest');
  assert.deepEqual(f.maintenanceRequests[0].targets.map(target=>target.index),Array.from({length:500},(_,index)=>index),'首组 index 恰为第一台账 0..499');
  assert.deepEqual(f.maintenanceRequests[1].targets.map(target=>target.index),[0],'次组复用自身台账 index 0——合并成单请求必在此错绑（夹具按插件 :1095+ 语义当场拒绝）');
  assert.equal(f.maintenanceRequests[1].targets[0].relativePath,rels[500],'次组唯一目标=越限第 501 条，绑定不跨台账');
  const persisted=await f.service.status(op.id);
  assert.deepEqual(persisted.autoDeleteGroups.map(row=>row.state),['accepted','accepted'],'各组结论独立落盘');
  assert.deepEqual(persisted.autoDeleteGroups.map(row=>row.destinations.length),[500,1]);
  const retry=await f.service.autoDeleteIsolated(op.id);assert.equal(retry.state,'accepted');
  assert.equal(f.maintenanceRequests.length,2,'已受理不重发');});
test('permanent deletion only ever targets registered clean-batch paths; a same-name new output at the original path is never touched',async()=>{
  const f=await backendFixture({slowDelete:2});
  const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:f.job(0)});
  const op=await f.service.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:exactOf(preview)});
  await f.service.execute(op.id);
  f.allowJob('work/job0');const destination=preview.rows[0].destination;
  const deleted=await f.service.isolatedDeletePreview(op.id);
  await f.service.confirm({token:deleted.token,digest:deleted.digest,phase:1,confirm:true,exactTargets:exactOf(deleted)});
  await f.service.confirm({token:deleted.token,digest:deleted.digest,phase:2,confirm:true,exactTargets:exactOf(deleted)});
  const del=await f.service.execute(deleted.token);
  assert.equal(del.state,'completed');assert.ok(f.sources.has('work/job0'),'the new run output at the original path survives');
  assert.ok(!f.sources.has(destination));
  const deleteExecutes=f.calls.filter(row=>row.method==='files.cleanup.execute'&&f.records.get(row.params.token).action==='delete');
  assert.ok(deleteExecutes.length&&deleteExecutes.every(row=>/^clean_dir\/job-[a-f0-9]{48}\//.test(f.records.get(row.params.token).targets[row.params.index].relativePath)));
});
test('isolated delete preview rejects targets of an isolation batch that never finished settling',async()=>{
  const f=await backendFixture();
  const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',job:f.job(1)});
  assert.ok(preview.rows.length);
  const op=await f.service.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:exactOf(preview)});
  // 新主线精确契约：isolatedDeletePreview 对未落定隔离批次先记 ISOLATE_NOT_SETTLED blocker（PlanCleanup.ts:1174），
  // 无 delete 行时以 blocker.code 抛出（:1201）；cleanupError 把 code 放在 apiData.code、detail 放 message
  // （PlanCleanup.ts:119-121），故按契约字段断言精确 code 并要求 detail 保留，拒绝与零变更语义不变。
  await assert.rejects(f.service.isolatedDeletePreview(op.id),error=>error.apiData?.code==='ISOLATE_NOT_SETTLED'&&/隔离未完成确认，请先刷新实际状态/.test(String(error.message)));
});
test('the real isolate preview payload carries normalized requiredInputs from the PLAN checkpoint declaration',async()=>{
  const f=await backendFixture();
  const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',
    job:f.job(0,{checkpoint_source:{checkpoint_path:'work/shared/ckpt_model.pt',config_path:f.root+'/configs/job0.yaml',checkpoint_sha256:'a'.repeat(64)}})});
  assert.equal(preview.blockers.length,0,'inputs outside the target must not block isolation');
  assert.equal(preview.rows[0].disposition,'isolate');
  const sent=f.calls.filter(row=>row.method==='files.cleanup.preview').map(row=>row.params.targets).flat();
  assert.ok(sent.length,'preview reached the backend');
  assert.ok(sent.every(row=>Array.isArray(row.requiredInputs)&&row.requiredInputs.length===2),'every isolate target carries requiredInputs');
  assert.deepEqual(sent[0].requiredInputs,['configs/job0.yaml','work/shared/ckpt_model.pt']);
});
test('a checkpoint inside the isolated directory is refused by the guard on the field actually sent; the job pauses and the source stays byte-identical in place',async()=>{
  const f=await backendFixture();
  f.sources.set('work/job0/ckpt/model.pt','sha-checkpoint');
  const preview=await f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',
    job:f.job(0,{checkpoint_source:{checkpoint_path:'work/job0/ckpt/model.pt',config_path:'work/job0/configs/train.yaml'}})});
  const overlap=preview.blockers.find(row=>row.code==='ISOLATE_REQUIRED_INPUT_OVERLAP');
  assert.ok(overlap,'the guard rejection reaches the job as a blocker');
  assert.match(overlap.detail,/model\.pt/);
  const sent=f.calls.find(row=>row.method==='files.cleanup.preview').params.targets[0];
  assert.deepEqual(sent.requiredInputs,['work/job0/ckpt/model.pt','work/job0/configs/train.yaml']);
  assert.equal(f.sources.get('work/job0'),'sha-old0','source bytes and location unchanged');
  assert.equal(f.sources.get('work/job0/ckpt/model.pt'),'sha-checkpoint');
  assert.ok(![...f.sources.keys()].some(k=>k.startsWith('clean_dir/')),'nothing moved to the isolation batch');
});
test('on the real preview chain one overlapping job pauses alone while the clean job isolates, confirms once and starts',async()=>{
  const f=await backendFixture();
  f.sources.set('work/job0/ckpt/model.pt','sha-checkpoint');
  const jobs=[{index:0,output_dir:'work/job0',checkpoint_source:{checkpoint_path:'work/job0/ckpt/model.pt'}},{index:1,output_dir:'work/job1'}];
  const ports={assertCurrent(){},progress(){},save:async()=>{},ask:async p=>p.phase===1?'rerun_all':'isolate_and_run',
    preview:job=>f.service.preview({planFile:f.scope.planFile,action:'isolate',authorizationMode:'confirmed_paths',
      job:{workflowId:'run-A',commandId:'c'+job.index,index:job.index,purpose:'replace_outputs',manifest:{declarations:[job]}}}),
    service:f.service,execute:id=>f.service.execute(id),verify:async preview=>{await f.service.assertIsolatedSourcesAbsent(preview);},
    beforeDelete:async()=>{},hold:async()=>{}};
  const state={};const outcome=await replaceRunOutputs(ports,state,'plans/p.yaml',jobs,[],'frozen');
  assert.equal(state.blocked.length,1);assert.equal(state.blocked[0].index,0);assert.match(state.blocked[0].reason,/ISOLATE_REQUIRED_INPUT_OVERLAP/);
  assert.deepEqual(outcome.selectedIndices,[1]);
  assert.equal(f.sources.get('work/job0'),'sha-old0');assert.equal(f.sources.get('work/job0/ckpt/model.pt'),'sha-checkpoint');
  assert.ok(!f.sources.has('work/job1'),'the admitted job moved');
  assert.ok(state.previews[0].preview.rows.every(row=>row.disposition!=='isolate'),'the paused job keeps no isolation targets');
});
// ── r82（0.5.414）：隔离失败/未知结果结构化阻断，绝不静默放行 ──────────────────
// 现场（se413 取证 r80/r81，宿主日志 b55fb4a9 stdout 1–50 与 761c1089 stdout 200–242）：
// files.cleanup.execute 返回 state=partial、error=[ACTIVE_TRANSFER]、四 target 全 pending、
// pendingNodes:[]，job 曾被下游 rerun_all 清空排除表后照常派发，远端 FORMAL_JOB_CONFLICT 退出 1。
// 本组在 413 上必须红（返回值无 blocked 结构、顶层 completed+逐 target pending 被放行、
// 阻断条目无 stage/code），修复后转绿；413 既有不变量（失败只挡该 job、零永久删除）由上方原用例继续守住。
test('r82 red: execute partial with pending targets blocks stage=execute even though pendingNodes is empty',async()=>{
  const f=flowFixture({1:'partialPending'}),r=await f.run();
  assert.deepEqual(r.selectedIndices,[0,2]);
  assert.ok(Array.isArray(r.blocked),'返回值必须携带结构化 blocked（准入决定可审计、可透传）');
  assert.equal(r.blocked.length,1);assert.equal(r.blocked[0].index,1);assert.equal(r.blocked[0].stage,'execute');
  assert.ok(!f.isolated.has('op1')&&!f.events.includes('hold:0,1,2'),'partial 结果绝不计入 hold');
  assert.ok(f.events.includes('hold:0,2'),'已通过 job 照常继续');
});
test('r82 red: a top-level completed result cannot overrule a per-target pending record',async()=>{
  const f=flowFixture({1:'completedPending'}),r=await f.run();
  assert.ok(f.state.blocked.some(row=>row.index===1&&row.stage==='execute'),
    '有逐 target 明细时必须核对每个 target 完成；顶层 completed+空 pendingNodes 不得放行');
  assert.ok(!r.selectedIndices.includes(1));assert.equal(f.events.includes('hold:0,1,2'),false);
});
test('r82 red: an expired preview token blocks with its exact code and never reuses the old approval',async()=>{
  const f=flowFixture({1:'expired'}),r=await f.run();
  assert.equal(f.state.blocked.length,1);assert.equal(f.state.blocked[0].index,1);
  assert.equal(f.state.blocked[0].code,'PREVIEW_EXPIRED');assert.equal(f.state.blocked[0].stage,'execute');
  assert.deepEqual(r.selectedIndices,[0,2]);
  assert.equal(f.events.filter(e=>e==='isolateop1').length,0,'过期令牌本轮不得再次执行旧确认');
});
test('r82 red: blocked entries carry stage — preview blocker vs post-execute verify failure stay distinguishable',async()=>{
  const f=flowFixture({1:'occupied',2:'blocker'}),r=await f.run();
  assert.deepEqual(r.selectedIndices,[0]);
  const stages=new Map((r.blocked||[]).map(row=>[row.index,row.stage]));
  assert.equal(stages.get(1),'verify','执行后源核验失败必须记 stage=verify');
  assert.equal(stages.get(2),'preview','预览拒绝必须记 stage=preview');
  assert.ok(f.isolated.has('op1'),'已移动的事实不回滚，但核验失败者不得准入');
});

test('requiredInputs normalization anchors roots, folds separators and refuses anything unresolvable instead of guessing',()=>{
  const helper=require('../../dist/features/PlanCleanup').isolateRequiredInputPaths;
  const node={id:'w1',kind:'remote',root:'/srv/proj'};
  assert.deepEqual(helper({},node),{inputs:[]});
  assert.deepEqual(helper({checkpoint_source:{checkpoint_path:'work\\job0\\ckpt.pt'}},node),{inputs:['work/job0/ckpt.pt']});
  assert.deepEqual(helper({checkpoint_source:{checkpoint_path:'/srv/proj/work/./ck.pt'}},node),{inputs:['work/ck.pt']});
  assert.deepEqual(helper({checkpoint_source:{checkpoint_path:'d:\\proj\\work\\ck.pt'}},{id:'w2',kind:'local',root:'D:/proj'}),{inputs:['work/ck.pt']});
  assert.match(helper({checkpoint_source:{checkpoint_path:'/other/proj/ck.pt'}},node).error,/锚定/);
  assert.match(helper({checkpoint_source:{checkpoint_path:'work/../secret/ck.pt'}},node).error,/路径段/);
  assert.match(helper({checkpoint_source:{checkpoint_path:''}},node).error,/非空/);
  assert.match(helper({checkpoint_source:{checkpoint_path:'work/a:b'}},node).error,/合同/);
  assert.match(helper({checkpoint_source:{checkpoint_path:'x'.repeat(4097)}},node).error,/合同/);
  const many={};for(let i=0;i<201;i++)many['p'+i+'_path']='w/f'+i;
  assert.match(helper({checkpoint_source:many},node).error,/200/);
});
