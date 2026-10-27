const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { PlanCleanup, cleanupRelative, cleanupDigest } = require('../../dist/features/PlanCleanup');
const { collectPlanCleanupEvidence } = require('../../dist/features/PlanCleanupEvidence');
const { canonicalProjectId } = require('../../dist/features/DistributedPlanQueue');
const { pendingPlanSyncs } = require('../../dist/features/PlanArtifactSync');
const { plansForOutputSync } = require('../../dist/features/PlanOutputRetention');
if(!process.env.LOCALAPPDATA)process.env.LOCALAPPDATA=require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(),'r17-lease-')); // 与 r3 isolatedTestEnv 同约定：租约注册表落隔离目录（沙箱 homedir/AppData 只读，产品路径不变）
const clone = value => JSON.parse(JSON.stringify(value));

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-plan-cleanup-test-'));
  const nodes = [{ id:'local', kind:'local', root }, { id:'w1', kind:'remote', root:'/project/a',host:'worker',port:2222,user:'fixture' }];
  const candidate = (nodeId, relativePath) => ({nodeId,relativePath,type:'file',category:'专用产物',owners:['owner'],evidence:['exact job / attempt / command registration'],dependencies:[]});
  const scope = {projectId:'project',planKey:'owner',planFile:'experiments/plans/p.yaml',planHash:'p-hash',runIds:['run-A'],revision:'frozen',nodes,
    candidates:[candidate('local','work_dirs/exact/a.csv'),candidate('w1','work_dirs/exact/b.csv')],blockers:[]};
  let mutations=0,indexed=0,failOnce=false,restoreCollision=false;
  const records=new Map(),sources=new Map(scope.candidates.map(row=>[row.nodeId+':'+row.relativePath,'sha-'+row.relativePath])),calls=[];
  const storageRoot=path.join(root,'state');
  const sftp=async (method,params)=>{
    calls.push({method,params:clone(params)});
    if(method==='files.cleanup.preview') {
      const targets=params.targets.map(row=>{
        if(params.action==='restore'&&restoreCollision) throw new Error('DESTINATION_EXISTS');
        const fingerprint=sources.get(params.node.id+':'+row.relativePath);
        if(!fingerprint) throw new Error('MISSING_TARGET');
        return {...row,absolutePath:params.node.root+'/'+row.relativePath,fingerprint,contentFingerprint:fingerprint,device:'1',inode:row.relativePath.split('/').pop(),size:10,inventory:[]};
      });
      const token=cleanupDigest([params.node.id,targets,calls.length]).slice(0,48), row={token,digest:cleanupDigest(targets),rootIdentity:{path:params.node.root},targets,confirmations:0,node:params.node};
      records.set(token,row);return clone(row);
    }
    if(method==='files.cleanup.inspect') return {target:{size:10,fingerprint:sources.get(params.node.id+':'+params.target.relativePath)||'protected'}};
    const row=records.get(params.token);assert.ok(row,'known frozen backend capability');
    if(method==='files.cleanup.status') return clone(row);
    if(method==='files.cleanup.verify') return {ok:true};
    if(method==='files.cleanup.settle'){const target=row.targets[params.index];return {ok:true,state:sources.has(row.node.id+':'+target.relativePath)?'pending':'completed',receipt:{contentFingerprint:target.fingerprint}};}
    if(method==='files.cleanup.confirm'){row.confirmations=params.phase;return {ok:true};}
    if(method==='files.cleanup.execute'){
      assert.ok(row.confirmations);const target=row.targets[params.index];
      if(failOnce&&mutations===1){failOnce=false;throw new Error('NETWORK_DISCONNECT');}
      mutations++;sources.delete(row.node.id+':'+target.relativePath);sources.set(row.node.id+':'+target.destination,target.fingerprint);
      return {ok:true,receipt:{source:target.relativePath,destination:target.destination,contentFingerprint:target.fingerprint}};
    }
    throw new Error(method);
  };
  const ports={storageRoot,collect:async()=>clone(scope),sftp,updateIndexes:async()=>{indexed++},restoreGate:async()=>{}};
  const service=new PlanCleanup(ports);
  const confirm=async preview=>service.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:preview.rows.filter(r=>r.disposition===preview.action).map(r=>r.node.id+':'+r.absolutePath)});
  return {root,scope,storageRoot,service,ports,sources,calls,confirm,get mutations(){return mutations},get indexed(){return indexed},disconnect(){failOnce=true},collision(){restoreCollision=true}};
}

test('two valid cleanup targets cannot be confirmed in a reordered echo',async()=>{
  const f=await fixture(),p=await f.service.preview({planFile:f.scope.planFile});
  const exact=p.rows.filter(r=>r.disposition===p.action).map(r=>r.node.id+':'+r.absolutePath);
  assert.equal(exact.length,2,'both targets must be executable, not a vacuous blocked preview');
  await assert.rejects(f.service.confirm({token:p.token,digest:p.digest,phase:1,confirm:true,exactTargets:[...exact].reverse()}),/CONFIRM_REQUIRED/);
  assert.equal(f.mutations,0);
  const operation=await f.service.confirm({token:p.token,digest:p.digest,phase:1,confirm:true,exactTargets:exact});
  assert.equal(operation.preview.confirmations,1);
  assert.equal(f.mutations,0);
});
// ── r87（块3 合并查询）：执行前逐目标复查按节点合并为一次批量预览；单目标不符仍逐条阻断、零 mutation ──
test('r87 block3: the pre-execute recheck merges same-node targets into one batched preview while a per-target mismatch still blocks with zero mutations',async()=>{
  const extra={nodeId:'local',relativePath:'work_dirs/exact/c.csv',type:'file',category:'专用产物',owners:['owner'],evidence:['exact job / attempt / command registration'],dependencies:[]};
  const f=await fixture();f.scope.candidates.push(clone(extra));
  f.sources.set('local:work_dirs/exact/c.csv','sha-work_dirs/exact/c.csv'); // r90：补上第三个候选在源台账里的事实（fixture 键 nodeId:relativePath）
  const p=await f.service.preview({planFile:f.scope.planFile});
  assert.equal(p.rows.filter(r=>r.disposition===p.action).length,3,'local 两个目标 + w1 一个目标');
  const operation=await f.confirm(p);
  const cut=f.calls.length;
  await f.service.execute(operation.id);
  const recheck=f.calls.slice(cut).filter(row=>row.method==='files.cleanup.preview');
  assert.equal(recheck.length,2,'每个节点身份一次批量复查，而不是逐行一次');
  assert.equal(recheck.find(row=>row.params.node.id==='local').params.targets.length,2,'同节点两个目标同批携带各自的 destination/expectedOwner');
  assert.equal(f.mutations,3);
  const g=await fixture();g.scope.candidates.push(clone(extra));
  g.sources.set('local:work_dirs/exact/c.csv','sha-work_dirs/exact/c.csv'); // r93：与 f 镜像——同一候选的源台账事实两个分支都必须在，否则 g.confirm 先被 MISSING_TARGET 挡下，走不到篡改断言
  const gp=await g.service.preview({planFile:g.scope.planFile});const gop=await g.confirm(gp);
  const original=g.ports.sftp;
  g.ports.sftp=async(method,params)=>{const result=await original(method,params);
    if(method==='files.cleanup.preview'&&params.targets.length===2)result.targets[1].fingerprint='sha-tampered';
    return result;};
  await assert.rejects(g.service.execute(gop.id),error=>error.apiData?.code==='PREVIEW_CHANGED');
  assert.equal(g.mutations,0,'一个目标的内容变化不得放行任何一次 mutation');
});

test('preview performs no journal writes, no mutation, keeps exact evidence and immutable returned records',async()=>{
  const f=await fixture(),p=await f.service.preview({planFile:f.scope.planFile});
  assert.equal(f.mutations,0);await assert.rejects(fs.stat(f.storageRoot),{code:'ENOENT'});
  assert.ok(f.calls.every(row=>['files.cleanup.preview','files.cleanup.inspect'].includes(row.method)));
  p.rows[0].relativePath='foreign.csv';const operation=await f.confirm(p);assert.notEqual(operation.preview.rows[0].relativePath,'foreign.csv');
});
test('job review freezes archive layout, orders external CSV before its owner directory, and continuation cannot change job',async()=>{
  const f=await fixture(),job={workflowId:'run',index:1,commandId:'command'};f.scope.job=job;
  f.scope.candidates[0].type='directory';f.scope.candidates[0].relativePath='work_dirs/exact/owner';
  f.scope.candidates[1].relativePath='tmp/result/exact.csv';
  f.sources.set('local:work_dirs/exact/owner','owner');f.sources.set('w1:tmp/result/exact.csv','csv');
  const p=await f.service.preview({planFile:f.scope.planFile,job:{commandId:'command',index:1,workflowId:'run'}});
  assert.equal(p.rows[0].type,'file');assert.equal(p.rows[1].type,'directory');
  assert.ok(p.rows.every(row=>/^job-[a-f0-9]{48}$/.test(row.archiveBatch)));
  assert.ok(p.rows.every(row=>row.destination==='clean_dir/'+row.archiveBatch+'/'+row.relativePath));
  const op=await f.confirm(p);await f.service.execute(op.id);
  f.scope.job={...job,index:2};
  await assert.rejects(f.service.preview({planFile:f.scope.planFile,job:f.scope.job,continuationOf:op.id}),/JOB_SCOPE_CHANGED/);
});
test('preview reports real preflight progress without storing observers or authorizing mutation',async()=>{
  const f=await fixture(),events=[];
  const p=await f.service.preview({planFile:f.scope.planFile},event=>{events.push(event);if(event.phase==='discovery')throw new Error('UI detached');});
  assert.equal(events[0].phase,'discovery');assert.equal(events.at(-1).phase,'complete');
  assert.ok(events.some(event=>event.phase==='nodes'&&event.completed===2&&event.total===2));
  assert.equal(f.mutations,0);assert.equal(p.confirmations,0);assert.equal(JSON.stringify(p).includes('onProgress'),false);
});
test('all nodes are rechecked before the first move, then indexes update; duplicate execution is idempotent',async()=>{
  const f=await fixture(),p=await f.service.preview({planFile:f.scope.planFile}),op=await f.confirm(p),start=f.calls.length;
  const done=await f.service.execute(op.id);assert.equal(done.state,'completed');assert.equal(f.mutations,2);assert.equal(f.indexed,1);
  const execution=f.calls.slice(start),first=execution.findIndex(row=>row.method==='files.cleanup.execute');
  assert.deepEqual(new Set(execution.slice(0,first).filter(row=>row.method==='files.cleanup.preview').map(row=>row.params.node.id)),new Set(['local','w1']));
  await f.service.execute(op.id);assert.equal(f.mutations,2);
});
test('permanent deletion requires two exact-path confirmations of the same immutable digest',async()=>{
  const f=await fixture(),p=await f.service.preview({planFile:f.scope.planFile,action:'delete'}),op=await f.confirm(p);
  await assert.rejects(f.service.execute(op.id),/CONFIRM_REQUIRED/);
  await assert.rejects(f.service.confirm({token:p.token,digest:p.digest,phase:2,confirm:true,exactTargets:['other-host:/other']}),/CONFIRM_REQUIRED/);
  await f.service.confirm({token:p.token,digest:p.digest,phase:2,confirm:true,exactTargets:p.rows.map(r=>r.node.id+':'+r.absolutePath)});
  // Transport is mocked: no file is permanently deleted by this regression.
  assert.equal((await f.service.execute(op.id)).state,'completed');
});
test('offline node blocks full cleanup; explicit verified-only choice remains partial with pending host',async()=>{
  const f=await fixture();f.scope.nodes[1].error='offline';f.scope.blockers.push({code:'OFFLINE_NODE',nodeId:'w1',detail:'offline'});
  const p=await f.service.preview({planFile:f.scope.planFile});await assert.rejects(f.confirm(p),/OFFLINE_NODE/);assert.equal(f.mutations,0);
  const partial=await f.service.preview({planFile:f.scope.planFile,verifiedOnly:true}),op=await f.confirm(partial),done=await f.service.execute(op.id);
  assert.equal(done.state,'partial');assert.deepEqual(done.pendingNodes,['w1']);assert.equal(f.mutations,1);
});
test('active job, changed configuration and changed contents invalidate approval without any move',async()=>{
  const f=await fixture();f.scope.blockers.push({code:'ACTIVE_JOB',detail:'run-A:0'});
  await assert.rejects(f.confirm(await f.service.preview({planFile:f.scope.planFile})),/ACTIVE_JOB/);
  f.scope.blockers=[];const p=await f.service.preview({planFile:f.scope.planFile});f.scope.revision='new-code';await assert.rejects(f.confirm(p),/PREVIEW_CHANGED/);
  f.scope.revision='frozen';const p2=await f.service.preview({planFile:f.scope.planFile}),op=await f.confirm(p2);
  f.sources.set('w1:work_dirs/exact/b.csv','changed');await assert.rejects(f.service.execute(op.id),/PREVIEW_CHANGED/);assert.equal(f.mutations,0);assert.equal(f.indexed,0);
});
test('partial failure persists receipts and resume does not repeat successful moves',async()=>{
  const f=await fixture(),p=await f.service.preview({planFile:f.scope.planFile}),op=await f.confirm(p);f.disconnect();
  await assert.rejects(f.service.execute(op.id),/NETWORK_DISCONNECT/);assert.equal(f.mutations,1);assert.equal(f.indexed,0);
  const resumed=new PlanCleanup(f.ports);assert.equal((await resumed.execute(op.id)).state,'completed');assert.equal(f.mutations,2);assert.equal(f.indexed,1);
});
test('restore is preview-only and refuses a new destination; restored contents use original receipts',async()=>{
  const f=await fixture(),p=await f.service.preview({planFile:f.scope.planFile}),op=await f.confirm(p);await f.service.execute(op.id);
  f.collision();await assert.rejects(f.service.restorePreview(op.id),/DESTINATION_EXISTS/);assert.equal(f.mutations,2);
});
test('protected/shared/unknown ownership and their ancestors never enter an executable batch',async()=>{
  const f=await fixture();f.scope.candidates[0].dependencies=['other PLAN'];f.scope.candidates[1].owners=['foreign-owner'];
  const p=await f.service.preview({planFile:f.scope.planFile});assert.ok(p.rows.every(row=>row.disposition==='protected'));await assert.rejects(f.confirm(p),/NO_VERIFIED_TARGETS/);
  for(const rel of ['../out','/root','x/*','a\\b','x/../y','C:/root','a//b'])assert.throws(()=>cleanupRelative(rel),/UNSAFE_PATH/);
});
test('cleanup lifecycle markers exclude artifacts from auto sync and result recollection, preserving history',()=>{
  const plan={id:'run-A',planFile:'experiments/plans/p.yaml',revision:'r',jobs:[],enqueuedAt:'2026-01-01',cleanup:{operationId:'cleanup',state:'archived',completedTargets:[],pendingNodes:[]}};
  assert.deepEqual(plansForOutputSync({schemaVersion:1,plans:[plan]}),[]);
  assert.deepEqual(pendingPlanSyncs({schemaVersion:2,entries:{a:{planFile:plan.planFile,runId:plan.id,cleanupOperationId:'cleanup',destinations:{w1:{status:'pending'}}}}}),[]);
  assert.equal(plan.id,'run-A');assert.equal(plan.cleanup.operationId,'cleanup');
});
test('evidence joins all attempts and historical workers; same prefixes stay separate and shared config/results remain protected',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'simple-plan-evidence-test-'));
  await fs.mkdir(path.join(root,'experiments/plans/group'),{recursive:true});await fs.mkdir(path.join(root,'configs'),{recursive:true});
  await fs.writeFile(path.join(root,'experiments/plans/group/p.yaml'),'config: configs/shared.yaml\n', 'utf8');
  await fs.writeFile(path.join(root,'experiments/plans/group/p_more.yaml'),'config: configs/shared.yaml\n','utf8');
  await fs.writeFile(path.join(root,'configs/shared.yaml'),'seed: 42\n','utf8');
  const job={index:0,case:'c',seed:42,attempt:2,status:'failed',workerId:'w2',commandId:'cmd2',outputDir:'work_dirs/c/attempts/B',history:[{attempt:1,status:'failed',workerId:'w1',commandId:'cmd1',outputDir:'work_dirs/c/attempts/A'}]};
  const plan={id:'run',projectId:canonicalProjectId(root),planFile:'experiments/plans/group/p.yaml',revision:'r',codeFingerprint:'code',jobs:[job]};
  const scope=await collectPlanCleanupEvidence({root,planFile:plan.planFile,queue:{schemaVersion:1,plans:[plan,{...plan,id:'other',planFile:'experiments/plans/group/p_more.yaml',jobs:[{...job,commandId:'other',outputDir:'work_dirs/c_more/attempts/Z',history:[]}]}]},ledger:{schemaVersion:2,entries:{}},
    nodes:[{id:'local',kind:'local',root},{id:'w1',kind:'remote',root:'/p'},{id:'w2',kind:'remote',root:'/p'}],snapshots:['w1','w2'].map(workerId=>({workerId,tasks:[],generatedAt:new Date().toISOString()})),registry:{planRun:'run',path:'experiments/results/shared.csv'}});
  assert.deepEqual(scope.runIds,['run']);assert.equal(scope.candidates.filter(row=>row.category.startsWith('作业产物')).length,2);
  assert.ok(!scope.candidates.some(row=>row.relativePath.includes('c_more')));
  assert.match(scope.candidates.find(row=>row.relativePath==='configs/shared.yaml').protectedReason,/共享/);
  assert.ok(scope.candidates.find(row=>row.relativePath==='experiments/results/shared.csv').protectedReason);
});
test('same physical root/target across aliases is processed once',async()=>{
  const f=await fixture();f.scope.nodes[1].root=f.scope.nodes[0].root;f.scope.candidates[1].relativePath=f.scope.candidates[0].relativePath;
  f.sources.set('w1:'+f.scope.candidates[0].relativePath,'sha-'+f.scope.candidates[0].relativePath);
  f.scope.candidates.push({...f.scope.candidates[1],relativePath:'work_dirs/exact/unique.csv'});f.sources.set('w1:work_dirs/exact/unique.csv','unique');
  const p=await f.service.preview({planFile:f.scope.planFile});assert.equal(p.rows.filter(r=>r.disposition==='move').length,2);assert.match(p.rows[1].protectedReason,/物理目标/);
  const op=await f.confirm(p);
  const duplicate=p.rows[1],unique=p.rows[2];assert.notEqual(unique.backendToken,duplicate.backendToken);
  const approval=f.calls.find(row=>row.method==='files.cleanup.confirm'&&row.params.token===unique.backendToken);
  assert.deepEqual(approval.params.exactTargets,[unique.absolutePath]);assert.ok(!f.calls.some(row=>row.method==='files.cleanup.confirm'&&row.params.token===duplicate.backendToken));
  await f.service.execute(op.id);assert.equal(f.mutations,2);
});
test('standard PLAN command placeholders resolve through the declared config without false global blockers',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'simple-cleanup-placeholder-')),file='experiments/plans/p.yaml';
  await fs.mkdir(path.join(root,'experiments/plans'),{recursive:true});await fs.mkdir(path.join(root,'configs'),{recursive:true});
  await fs.writeFile(path.join(root,file),'base_config: configs/p.yaml\nrunner:\n  train_command: "wrapper --config {config} -- train --config {config}"\n  test_command: "test --config {config}"\n','utf8');
  await fs.writeFile(path.join(root,'configs/p.yaml'),'seed: 42\n','utf8');
  const input={root,planFile:file,queue:{schemaVersion:1,plans:[]},ledger:{schemaVersion:2,entries:{}},nodes:[{id:'local',kind:'local',root}],snapshots:[]};
  const scope=await collectPlanCleanupEvidence(input);
  assert.deepEqual(scope.blockers,[]);assert.equal(scope.candidates.find(row=>row.relativePath==='configs/p.yaml').protectedReason,undefined);
  await fs.writeFile(path.join(root,'experiments/plans/q.yaml'),'base_config: configs/q.yaml\ntrain_command: train --config {custom_config}\n','utf8');
  await fs.writeFile(path.join(root,'configs/q.yaml'),'seed: 43\n','utf8');
  const unknown=await collectPlanCleanupEvidence(input);
  assert.ok(!unknown.blockers.some(row=>row.code==='CONFIG_REFERENCE_UNVERIFIED'));
  assert.match(unknown.candidates.find(row=>row.relativePath==='configs/p.yaml').protectedReason,/无法证明独占/);
  assert.equal(unknown.notices.filter(row=>row.code==='CONFIG_REFERENCE_UNVERIFIED').length,1);
});
test('only matching or overlapping active operations block cleanup; unscoped activity still fails closed',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'simple-cleanup-op-scope-')),file='experiments/plans/p.yaml';
  await fs.mkdir(path.join(root,'experiments/plans'),{recursive:true});await fs.writeFile(path.join(root,file),'mode: train\n','utf8');
  const input={root,planFile:file,queue:{schemaVersion:1,plans:[]},ledger:{schemaVersion:2,entries:{}},nodes:[{id:'local',kind:'local',root}],snapshots:[]};
  const ops=[{operationId:'other',status:'running',planFile:'experiments/plans/q.yaml',payload:{outputDir:'work_dirs/q/attempts/one'}},
    {operationId:'own',status:'running',payload:{planFile:file}},
    {operationId:'overlap',status:'pending',planFile:'experiments/plans/q.yaml',payload:{targetPath:file}},
    {operationId:'unknown',status:'running',type:'sync'}];
  const scope=await collectPlanCleanupEvidence({...input,operations:ops});
  assert.deepEqual(scope.blockers.filter(row=>row.code==='ACTIVE_OPERATION').map(row=>row.detail),['own','overlap','unknown']);
});
test('result review excludes regenerated tables and unrelated PLAN files while retaining published source protection',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'simple-cleanup-result-scope-')),file='experiments/plans/p.yaml';
  await fs.mkdir(path.join(root,'experiments/plans'),{recursive:true});await fs.writeFile(path.join(root,file),'mode: train\n','utf8');
  const output='work_dirs/p/attempts/run',raw='custom/results/pad/plans/p__exact/raw/metrics.csv',other='custom/results/pad/plans/q__exact/raw/metrics.csv';
  const record={planFile:file,runId:'run',dataset:'pad',method:'p',jobDir:output};
  const scope=await collectPlanCleanupEvidence({root,planFile:file,resultDir:'custom/results',queue:{schemaVersion:1,plans:[{id:'run',projectId:canonicalProjectId(root),planFile:file,revision:'r',jobs:[{case:'p',seed:42,attempt:1,workerId:'w',commandId:'cmd',status:'completed',outputDir:output}]}]},ledger:{schemaVersion:2,entries:{}},nodes:[{id:'local',kind:'local',root},{id:'w',kind:'remote',root:'/project'}],snapshots:[{workerId:'w',tasks:[],generatedAt:new Date().toISOString()}],registry:{schemaVersion:1,plans:{[file]:{records:[record],wrapperEvidence:{sources:[{localRelativePath:raw}],tablePath:'custom/results/pad/final/final.md'}},'experiments/plans/q.yaml':{records:[{...record,planFile:'experiments/plans/q.yaml',runId:'other'}],wrapperEvidence:{sources:[{localRelativePath:other}]}}}}});
  assert.ok(scope.candidates.some(row=>row.relativePath===raw&&row.protectedReason));
  assert.ok(!scope.candidates.some(row=>[other,'custom/results/pad/final/final.md','simple_cluster/results/project_table_registry.json'].includes(row.relativePath)));
  assert.ok(scope.candidates.find(row=>row.relativePath===output).dependencies.some(ref=>ref.includes('正式/历史')));
});
test('only exclusive config is eligible; transitive, absolute command and canonical aliases stay shared',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'simple-cleanup-config-scope-')),file='experiments/plans/p.yaml';
  await fs.mkdir(path.join(root,'experiments/plans'),{recursive:true});await fs.mkdir(path.join(root,'configs/sub'),{recursive:true});
  const shared='configs/shared.yaml',exclusive='configs/only.yaml';
  await fs.writeFile(path.join(root,file),'config: '+exclusive+'\nbase_config: '+shared+'\n','utf8');
  await fs.writeFile(path.join(root,exclusive),'seed: 42\nresult_file: "configs/generated.json"\nreport_file: configs/generated.yaml\n','utf8');await fs.writeFile(path.join(root,shared),'seed: 43\n','utf8');
  await fs.writeFile(path.join(root,'configs/sub/other.yaml'),'_base_:\n  - ../shared.yaml\n','utf8');
  await fs.writeFile(path.join(root,'experiments/plans/q.yaml'),'config: configs/sub/other.yaml\n','utf8');
  const input={root,planFile:file,queue:{schemaVersion:1,plans:[]},ledger:{schemaVersion:2,entries:{}},nodes:[{id:'local',kind:'local',root}],snapshots:[]};
  let scope=await collectPlanCleanupEvidence(input);
  assert.equal(scope.candidates.find(row=>row.relativePath===exclusive).protectedReason,undefined);
  assert.ok(!scope.candidates.some(row=>row.relativePath==='configs/generated.json'));
  assert.ok(!scope.candidates.some(row=>row.relativePath==='configs/generated.yaml'));
  assert.match(scope.candidates.find(row=>row.relativePath===shared).protectedReason,/共享/);
  await fs.writeFile(path.join(root,'configs/sub/other.json'),JSON.stringify({extends:['../shared.yaml'],result_file:'configs/generated.json'}),'utf8');
  await fs.writeFile(path.join(root,'experiments/plans/q.yaml'),'config: configs/sub/other.json\n','utf8');
  scope=await collectPlanCleanupEvidence(input);
  assert.match(scope.candidates.find(row=>row.relativePath===shared).protectedReason,/共享/);
  assert.ok(!scope.candidates.some(row=>row.relativePath==='configs/generated.json'));
  const alias=process.platform==='win32'?'CONFIGS/ONLY.yaml':'configs/./only.yaml';
  await fs.writeFile(path.join(root,'experiments/plans/q.yaml'),'train_command: python train.py --config "'+path.join(root,alias).replace(/\\/g,'/')+'"\n','utf8');
  scope=await collectPlanCleanupEvidence(input);
  assert.match(scope.candidates.find(row=>row.relativePath===exclusive).protectedReason,/共享/);
  assert.equal(scope.candidates.filter(row=>row.relativePath.toLowerCase()===exclusive).length,1);
  await fs.writeFile(path.join(root,'experiments/plans/q.yaml'),'train_command: python train.py config="'+path.join(root,exclusive).replace(/\\/g,'/')+'"\n','utf8');
  scope=await collectPlanCleanupEvidence(input);
  assert.match(scope.candidates.find(row=>row.relativePath===exclusive).protectedReason,/共享/);
});
test('a new cross-PLAN config reference invalidates an exclusive preview before confirmation',async()=>{
  const f=await fixture(),file=f.scope.planFile,config='configs/only.yaml';
  await fs.mkdir(path.join(f.root,'experiments/plans'),{recursive:true});await fs.mkdir(path.join(f.root,'configs'),{recursive:true});
  await fs.writeFile(path.join(f.root,file),'config: '+config+'\n','utf8');await fs.writeFile(path.join(f.root,config),'seed: 42\n','utf8');
  f.sources.set('local:'+file,'plan-fingerprint');f.sources.set('local:'+config,'config-fingerprint');
  f.ports.collect=()=>collectPlanCleanupEvidence({root:f.root,planFile:file,queue:{schemaVersion:1,plans:[]},ledger:{schemaVersion:2,entries:{}},nodes:[{id:'local',kind:'local',root:f.root}],snapshots:[]});
  const p=await f.service.preview({planFile:file});assert.equal(p.rows.find(row=>row.relativePath===config).disposition,'move');
  await fs.writeFile(path.join(f.root,'experiments/plans/other.yaml'),'config: '+config+'\n','utf8');
  await assert.rejects(f.confirm(p),/PREVIEW_CHANGED/);assert.equal(f.mutations,0);
});
test('resume reconstructs only our already-moved PLAN/config evidence without reading active replacements',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'simple-plan-resume-evidence-'));
  await fs.mkdir(path.join(root,'experiments/plans'),{recursive:true});await fs.mkdir(path.join(root,'configs'),{recursive:true});
  const file='experiments/plans/p.yaml',config='configs/p.yaml',text='config: configs/p.yaml\n';
  await fs.writeFile(path.join(root,file),text,'utf8');await fs.writeFile(path.join(root,config),'seed: 42\n','utf8');
  await fs.writeFile(path.join(root,'experiments/plans/q.yaml'),'config: configs/q.yaml\n','utf8');await fs.writeFile(path.join(root,'configs/q.yaml'),'seed: 43\n','utf8');
  const input={root,planFile:file,queue:{schemaVersion:1,plans:[]},ledger:{schemaVersion:2,entries:{}},nodes:[{id:'local',kind:'local',root}],snapshots:[]};
  const before=await collectPlanCleanupEvidence(input);
  await fs.mkdir(path.join(root,'clean_dir/configs'),{recursive:true});await fs.rename(path.join(root,config),path.join(root,'clean_dir',config));
  const after=await collectPlanCleanupEvidence({...input,archivedFiles:{[config]:'clean_dir/'+config}});assert.equal(after.revision,before.revision);
  await fs.mkdir(path.join(root,'clean_dir/experiments/plans'),{recursive:true});await fs.rename(path.join(root,file),path.join(root,'clean_dir',file));
  const moved=await collectPlanCleanupEvidence({...input,archivedFiles:{[config]:'clean_dir/'+config,[file]:'clean_dir/'+file}});assert.equal(moved.revision,before.revision);
  await fs.writeFile(path.join(root,config),'new job\n','utf8');await assert.rejects(collectPlanCleanupEvidence({...input,archivedFiles:{[config]:'clean_dir/'+config}}),/SOURCE_RECREATED_OR_CHANGED/);
});

test('lost PLAN move receipt settles before source discovery; resumed preflight sees only our archived metadata',async()=>{
  const f=await fixture(),candidate=f.scope.candidates.find(row=>row.nodeId==='local');
  f.sources.delete('local:'+candidate.relativePath);candidate.relativePath=f.scope.planFile;candidate.category='PLAN 文件';f.sources.set('local:'+candidate.relativePath,'sha-'+candidate.relativePath);
  const p=await f.service.preview({planFile:f.scope.planFile}),op=await f.confirm(p),local=p.rows.find(row=>row.node.id==='local');
  const original=f.ports.sftp;let lost=false;
  f.ports.sftp=async(method,params)=>{const result=await original(method,params);if(method==='files.cleanup.execute'&&params.token===local.backendToken&&!lost){lost=true;throw new Error('lost PLAN response')}return result};
  f.ports.collect=async(_file,options)=>{if(!f.sources.has('local:'+f.scope.planFile))assert.equal(options.archivedFiles[f.scope.planFile],local.destination);return clone(f.scope)};
  await assert.rejects(f.service.execute(op.id),/lost PLAN response/);
  const done=await new PlanCleanup(f.ports).execute(op.id);assert.equal(done.state,'completed');assert.equal(f.mutations,2);
});

test('partial restore discovery skips metadata files already restored and rechecks the remaining originals',async()=>{
  const modulePath=require.resolve('../../dist/extension/PlanCleanupHost'),{createRequire}=require('node:module'),from=createRequire(modulePath),exports={};
  vm.runInNewContext(await fs.readFile(modulePath,'utf8'),{exports,require:name=>['vscode','./PlanCleanupPanel'].includes(name)?{}:from(name)});
  const node={id:'local',kind:'local',root:'C:/fixture'},rows=[{id:'p',node,category:'PLAN 文件',relativePath:'clean_dir/experiments/plans/p.yaml',destination:'experiments/plans/p.yaml'},{id:'c',node,category:'专用配置',relativePath:'clean_dir/configs/p.yaml',destination:'configs/p.yaml'}];
  const preview={scope:{planFile:'experiments/plans/p.yaml',planKey:'key'},rows};
  await exports.PlanCleanupHost.prototype.restoreGate.call({collect:async(_file,_allowMissing,archivedFiles)=>{
    assert.deepEqual(clone(archivedFiles),{'configs/p.yaml':'clean_dir/configs/p.yaml'});return {blockers:[],nodes:[node],references:{},candidates:[]};
  }},preview,{targets:{p:{state:'completed'},c:{state:'pending'}}});
});
test('Host refuses a backend without the required Git ancestor safety capability before approvals',async()=>{
  const modulePath=require.resolve('../../dist/extension/PlanCleanupHost'),from=require('node:module').createRequire(modulePath),exports={};
  vm.runInNewContext(await fs.readFile(modulePath,'utf8'),{exports,require:name=>['vscode','./PlanCleanupPanel'].includes(name)?{}:from(name)});
  // 能力门与 root 形状无关；root 必须是跨平台绝对路径（r17 返修#1：派生入口拒绝相对/伪绝对根）。
  let safe=false,formal=false;const host=new exports.PlanCleanupHost({context:{globalStorageUri:{fsPath:os.tmpdir()}},simpleSftpApiCall:async()=>({safety:{gitRepositoryAncestors:safe,readOnlyReceiptCheck:safe,formalJobOwner:formal,immutableArchiveBatch:formal}})},path.resolve(os.tmpdir(),'cleanup-capability-fixture'));
  await assert.rejects(host.service.ports.sftp('files.cleanup.preview',{}),error=>error.apiData.code==='SFTP_SAFE_CLEANUP_UPGRADE_REQUIRED');
  safe=true;assert.equal((await host.service.ports.sftp('files.cleanup.preview',{})).safety.gitRepositoryAncestors,true);
  const params={targets:[{expectedOwner:{resultPathPolicy:'declared'},archiveBatch:'job-'+'a'.repeat(48)}]};
  await assert.rejects(host.service.ports.sftp('files.cleanup.preview',params),error=>error.apiData.code==='SFTP_FORMAL_OWNER_UPGRADE_REQUIRED');
  formal=true;assert.equal((await host.service.ports.sftp('files.cleanup.preview',params)).safety.formalJobOwner,true);
});

test('recorded stable identity joins renamed PLAN; unknown historical and dynamic config references stay protected',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'simple-plan-rename-evidence-'));
  const file='experiments/plans/new/p.yaml';await fs.mkdir(path.join(root,'experiments/plans/new'),{recursive:true});await fs.mkdir(path.join(root,'configs'),{recursive:true});
  await fs.writeFile(path.join(root,file),'plan_id: stable-A\nconfig: configs/p.yaml\n','utf8');await fs.writeFile(path.join(root,'configs/p.yaml'),'weights: ${UNKNOWN}\n','utf8');
  const plan={id:'run',stablePlanId:'stable-A',projectId:canonicalProjectId(root),planFile:'experiments/plans/old/p.yaml',revision:'r',jobs:[]};
  const scope=await collectPlanCleanupEvidence({root,planFile:file,queue:{schemaVersion:1,plans:[plan]},ledger:{schemaVersion:2,entries:{}},nodes:[{id:'local',kind:'local',root}],snapshots:[]});
  assert.deepEqual(scope.runIds,['run']);assert.match(scope.candidates.find(row=>row.relativePath==='configs/p.yaml').protectedReason,/无法证明独占/);
  await fs.writeFile(path.join(root,'configs/p.yaml'),'seed: 42\n','utf8');
  await fs.writeFile(path.join(root,'experiments/plans/new/q.yaml'),'shared: &cfg configs/p.yaml\nconfig: *cfg\n','utf8');
  const aliased=await collectPlanCleanupEvidence({root,planFile:file,queue:{schemaVersion:1,plans:[plan]},ledger:{schemaVersion:2,entries:{}},nodes:[{id:'local',kind:'local',root}],snapshots:[]});
  assert.match(aliased.candidates.find(row=>row.relativePath==='configs/p.yaml').protectedReason,/无法证明独占/);
});

test('another PLAN checkpoint reference protects the registered attempt; absolute registry paths also protect it',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'simple-plan-shared-checkpoint-'));
  await fs.mkdir(path.join(root,'experiments/plans'),{recursive:true});await fs.mkdir(path.join(root,'configs'),{recursive:true});
  const file='experiments/plans/a.yaml',outputDir='work_dirs/a/attempts/run';
  await fs.writeFile(path.join(root,file),'config: configs/a.yaml\n','utf8');await fs.writeFile(path.join(root,'experiments/plans/b.yaml'),'config: configs/b.yaml\n','utf8');
  await fs.writeFile(path.join(root,'configs/a.yaml'),'seed: 42\n','utf8');await fs.writeFile(path.join(root,'configs/b.yaml'),'checkpoint_path: '+outputDir+'/weights.pt\n','utf8');
  const plan={id:'run',projectId:canonicalProjectId(root),planFile:file,revision:'r',jobs:[{index:0,case:'a',seed:42,attempt:1,status:'completed',workerId:'w',commandId:'cmd',outputDir}]};
  const input={root,planFile:file,queue:{schemaVersion:1,plans:[plan]},ledger:{schemaVersion:2,entries:{}},nodes:[{id:'local',kind:'local',root},{id:'w',kind:'remote',root:'/project'}],snapshots:[{workerId:'w',tasks:[],generatedAt:new Date().toISOString()}]};
  const scope=await collectPlanCleanupEvidence(input);assert.ok(scope.candidates.find(row=>row.relativePath===outputDir).dependencies.some(ref=>ref.includes('其他 PLAN 配置')));
  const published=await collectPlanCleanupEvidence({...input,registry:{jobDir:'/project/'+outputDir}});assert.ok(published.candidates.find(row=>row.relativePath===outputDir).dependencies.some(ref=>ref.includes('正式/历史')));
});

test('local API publishes the cleanup method contract and both deletion confirmations without starting a listener',()=>{
  const {LocalApiServer}=require('../../dist/api/LocalApiServer');
  const names=['preview','list','confirm','execute','status','resume','cancel','restore','continue','recheck'].map(name=>'plans.cleanup.'+name);
  const server=new LocalApiServer({name:'fixture',version:'test',preferredPort:0,discoveryPath:path.join(os.tmpdir(),'unused-cleanup-discovery.json'),methods:Object.fromEntries(names.map(name=>[name,async()=>({})]))});
  const caps=server.capabilities();assert.ok(names.every(name=>caps.methods.includes(name)));assert.equal(caps.methodOptions['plans.cleanup.confirm'].deleteConfirmationCount,2);
  assert.equal(caps.methodOptions['plans.cleanup.preview'].zeroWrites,true);assert.equal(server.openapi()['x-simple-method-options']['plans.cleanup.restore'].noOverwrite,true);
  assert.equal(caps.methodOptions['plans.cleanup.recheck'].automaticExecution,false);assert.equal(caps.methodOptions['plans.cleanup.continue'].newExactConfirmation,true);
});

test('exact legacy task references include unselected historical workers but cannot authorize unknown lineage',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'simple-plan-legacy-task-')),file='experiments/plans/p.yaml';await fs.mkdir(path.join(root,'experiments/plans'),{recursive:true});await fs.writeFile(path.join(root,file),'mode: train\n','utf8');
  const scope=await collectPlanCleanupEvidence({root,planFile:file,queue:{schemaVersion:1,plans:[]},ledger:{schemaVersion:2,entries:{}},nodes:[{id:'local',kind:'local',root},{id:'old-worker',kind:'remote',root:'/project'}],snapshots:[{workerId:'old-worker',generatedAt:new Date().toISOString(),tasks:[{planFile:file,projectId:canonicalProjectId(root),workflowId:'manual-run',commandId:'old-command',status:'failed',outputDir:'work_dirs/p/attempts/old'}]}]});
  assert.ok(scope.nodes.some(node=>node.id==='old-worker'));assert.match(scope.candidates.find(row=>row.category==='旧任务登记产物').protectedReason,/仅报告/);
});
test('cleanup review script parses; opening reads only, and permanent delete needs two distinct UI clicks',async()=>{
  let panel;const fields=new Map(),posted=[],listeners=[];
  const element=id=>{if(!fields.has(id))fields.set(id,{value:id==='action'?'delete':'',checked:false,disabled:false,textContent:'',innerHTML:''});return fields.get(id)};
  const vscode={ViewColumn:{Active:1},window:{createWebviewPanel:()=>panel={
    webview:{html:'',onDidReceiveMessage:()=>({dispose(){}})},onDidDispose(){}}}};
  const exports={},panelPath=require.resolve('../../dist/extension/PlanCleanupPanel'),panelRequire=require('node:module').createRequire(panelPath);vm.runInNewContext(await fs.readFile(panelPath,'utf8'),{exports,require:name=>name==='vscode'?vscode:panelRequire(name)});
  await exports.openPlanCleanupPanel({service:{}},'experiments/plans/p.yaml');
  const script=panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];new vm.Script(script);
  vm.runInNewContext(script,{acquireVsCodeApi:()=>({postMessage:message=>posted.push(clone(message))}),document:{getElementById:element},setInterval:()=>0,window:{addEventListener:(_event,listener)=>listeners.push(listener)}});
  assert.deepEqual(posted.map(row=>row.type),['history']);listeners[0]({data:{type:'history',rows:[]}});assert.equal(posted.at(-1).type,'preview');
  const preview={action:'delete',blockers:[],rows:[{node:{id:'local',root:'C:/fixture'},disposition:'delete',absolutePath:'C:/fixture/p.yaml',type:'file',evidence:['exact'],dependencies:[]}]};
  listeners[0]({data:{type:'preview',preview}});element('confirm').onclick();assert.equal(posted.at(-1).phase,1);
  listeners[0]({data:{type:'confirmed',operation:{id:'op',state:'ready',targets:{},preview:{...preview,confirmations:1}}}});assert.equal(element('execute').disabled,true);assert.equal(posted.filter(row=>row.phase===2).length,0);
  element('confirm').onclick();assert.equal(posted.at(-1).phase,2);assert.equal(posted.filter(row=>row.type==='execute').length,0);
  element('partial').onchange();assert.equal(element('resume').disabled,true);assert.equal(element('restore').disabled,true);assert.equal(element('cancel').disabled,true);
});
