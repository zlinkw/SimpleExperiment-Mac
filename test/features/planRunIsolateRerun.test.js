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
    execute:async id=>{const index=Number(id.slice(2));if(script&&script[index]==='fail')throw Error('ISOLATE_TARGET_CONFLICT：服务器拒绝移动');isolated.add(id);events.push('isolate'+id);return{state:'completed',pendingNodes:[]};}};
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
  const registered=new Map();const records=new Map();const calls=[];let checks=0,deletePhase=0;
  const isolateFlags=()=>({batchPreviewCapacity:4096,managedObservation:1,confirmedPathDeletion:1,
    isolateFast:options.noCapability?0:1,requiredInputGuard:1,registeredIsolationDeletion:1,subtreeSingleWriter:1});
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
    const row=records.get(params.token);assert.ok(row,'frozen backend record');
    if(method==='files.cleanup.status'){const observations=row.targets.map((target,index)=>({state:row.completed.has(index)?'completed':row.started&&row.started.has(index)?'executing':'pending'}));
      return clone({...row,confirmations:row.confirmations,observations,states:observations.map(row=>row.state),batchExecuting:false});}
    if(method==='files.cleanup.confirm'){if(row.action==='isolate'&&params.phase>1)throw Object.assign(Error('CONFIRM_PHASE_LIMIT'),{code:'CONFIRM_PHASE_LIMIT'});
      if(row.action==='delete')deletePhase=params.phase;row.confirmations=params.phase;return{ok:true};}
    if(method==='files.cleanup.check'){const target=row.targets[params.index];
      if(row.completed.has(params.index))return{state:'completed',verifiedBy:row.action==='isolate'?'rename_registered':'path_absence'};
      if(row.action==='delete'&&row.started.has(params.index)){checks++;if(checks>=(options.slowDelete||0))row.completed.add(params.index);
        return row.completed.has(params.index)?{state:'completed',verifiedBy:'path_absence'}:{state:'executing'};}
      return{state:row.started&&row.started.has(params.index)?'executing':'pending'};}
    if(method==='files.cleanup.execute'){const target=row.targets[params.index];assert.ok(row.confirmations>=(row.action==='delete'?2:1),'backend confirmations before execute');
      row.started||=new Set();
      if(row.action==='isolate'){sources.delete(target.relativePath);sources.set(target.destination,target.fingerprint);
        registered.set(target.relativePath,target.destination);row.completed.add(params.index);}
      else{// 与 B 快删链一致：一次 execute 事务性处理整批已确认目标，不按 index 逐条执行。
        row.started||=new Set();for(const [index,target] of row.targets.entries()){if(row.completed.has(index))continue;sources.delete(target.relativePath);row.started.add(index);row.completed.add(index);}}
      return{ok:true};}
    throw new Error(method);};
  const service=new PlanCleanup({storageRoot:path.join(root,'state'),
    collect:async(file,options)=>clone({...scope,job:options?.job,candidates:options?.job?[
      {nodeId:'local',relativePath:options.job.manifest.declarations[0].output_dir,type:'directory',category:'输出目录',owners:['o'],evidence:['精确注册'],dependencies:[]}]:[]}),
      sftp,updateIndexes:async()=>{},restoreGate:async()=>{}});
  const job=(index,extra={})=>({workflowId:'run-A',commandId:'c'+index,index,purpose:'replace_outputs',manifest:{declarations:[{index,output_dir:'work/job'+index,...extra}]}});
  return{root,scope,service,job,sources,registered,calls,records,get deletePhase(){return deletePhase;},noCapability:()=>{options.noCapability=true;},allowJob:rel=>sources.set(rel,'sha-x')};
}
const exactOf=preview=>preview.rows.filter(row=>row.disposition===preview.action).map(row=>row.node.id+':'+row.absolutePath);

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
