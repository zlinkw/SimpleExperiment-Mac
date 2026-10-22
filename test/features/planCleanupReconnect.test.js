const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {PlanCleanup}=require('../../dist/features/PlanCleanup');
const {collectPlanCleanupEvidence}=require('../../dist/features/PlanCleanupEvidence');
const {canonicalProjectId}=require('../../dist/features/DistributedPlanQueue');

async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'plan-cleanup-reconnect-'));
  const nodes=[{id:'local',kind:'local',root},{id:'worker',kind:'remote',root:'/fixture/project',host:'fixture',port:2222,user:'fixture',error:'offline'}];
  const candidate=(nodeId,relativePath,category)=>({nodeId,relativePath,type:'file',category,owners:['owner'],evidence:['exact registered target'],dependencies:[]});
  const scope={projectId:'project',planKey:'owner',planFile:'experiments/plans/p.yaml',planHash:'plan-hash',runIds:['run'],revision:'revision',nodes,
    candidates:[candidate('local','experiments/plans/p.yaml','PLAN 文件'),candidate('worker','work_dirs/p/metric.csv','专用产物')],blockers:[{nodeId:'worker',code:'OFFLINE_NODE',detail:'offline'}]};
  const sources=new Map(scope.candidates.map(row=>[row.nodeId+':'+row.relativePath,'hash-'+row.relativePath])),records=new Map(),calls=[];
  let counter=0,mutations=0,lost=false;
  const sftp=async(method,params)=>{
    calls.push({method,params:JSON.parse(JSON.stringify(params))});
    if(method==='files.cleanup.preview'){
      const targets=params.targets.map(target=>{const hash=sources.get(params.node.id+':'+target.relativePath);return {...target,absolutePath:params.node.root+'/'+target.relativePath,
        ...(hash?{fingerprint:hash,contentFingerprint:hash,inode:target.relativePath.replace(/^clean_dir\//,''),device:'1'}:{missing:true})};});
      const row={token:'backend-'+(++counter),digest:'digest-'+counter,targets,rootIdentity:{path:params.node.root},node:params.node,action:params.action};records.set(row.token,row);return row;
    }
    if(method==='files.cleanup.inspect')return {target:{missing:!sources.has(params.node.id+':'+params.target.relativePath)}};
    const row=records.get(params.token);assert.ok(row);
    if(method==='files.cleanup.status')return row;
    if(method==='files.cleanup.confirm')return {ok:true};
    const target=row.targets[params.index],source=row.node.id+':'+target.relativePath,dest=row.node.id+':'+target.destination;
    if(method==='files.cleanup.verify'){assert.equal(sources.has(source),false);if(row.action!=='delete')assert.equal(sources.get(dest),target.fingerprint);return {ok:true};}
    if(method==='files.cleanup.check')return {ok:true,state:sources.has(source)?'pending':'completed'};
    if(method==='files.cleanup.settle')return {ok:true,state:sources.has(source)?'pending':'completed',receipt:{}};
    if(method==='files.cleanup.execute'){
      if(row.action!=='delete')sources.set(dest,sources.get(source));sources.delete(source);mutations++;
      if(lost){lost=false;throw new Error('lost response');}return {ok:true,receipt:{}};
    }
    throw new Error(method);
  };
  const collected=[];
  const ports={storageRoot:path.join(root,'state'),sftp,collect:async(_file,options)=>{collected.push(options?.archivedFiles||{});
    if(!sources.has('local:'+scope.planFile)&&!options?.removedMetadata?.hashes[scope.planFile])assert.equal(options?.archivedFiles?.[scope.planFile],'clean_dir/'+scope.planFile);
    return JSON.parse(JSON.stringify(scope));},restoreGate:async()=>{},updateIndexes:async()=>{}};
  const service=new PlanCleanup(ports),confirm=async p=>service.confirm({token:p.token,digest:p.digest,phase:1,confirm:true,exactTargets:p.rows.filter(r=>r.disposition===p.action).map(r=>r.node.id+':'+r.absolutePath)});
  return {service,ports,scope,sources,calls,collected,confirm,get mutations(){return mutations},online(){delete nodes[1].error;scope.blockers=[];},lose(){lost=true;}};
}

test('offline remainder survives restart; reconnect only checks and a new reviewed continuation completes it',async()=>{
  const f=await fixture(),preview=await f.service.preview({planFile:f.scope.planFile,verifiedOnly:true}),op=await f.confirm(preview);
  assert.equal((await f.service.execute(op.id)).state,'partial');assert.equal(f.mutations,1);
  f.online();const restarted=new PlanCleanup(f.ports),start=f.calls.length;
  const checks=await restarted.recheckNode('worker');assert.equal(checks.length,1);assert.equal(checks[0].state,'confirmation_required');assert.equal(f.mutations,1);
  assert.ok(f.calls.slice(start).every(row=>['files.cleanup.inspect','files.cleanup.check'].includes(row.method)));
  const next=await restarted.continuePreview(op.id);assert.equal(next.continuationOf,op.id);
  assert.equal(next.rows.filter(row=>row.disposition==='move').length,1);assert.equal(f.mutations,1);
  await assert.rejects(restarted.execute(next.token));
  const confirmed=await restarted.confirm({token:next.token,digest:next.digest,phase:1,confirm:true,exactTargets:next.rows.filter(r=>r.disposition===next.action).map(r=>r.node.id+':'+r.absolutePath)});
  assert.equal((await restarted.execute(confirmed.id)).state,'completed');assert.equal(f.mutations,2);
  assert.deepEqual(await restarted.recheckNode('worker'),[]);
});

test('a recreated local PLAN and changed Worker identity block continuation and retain pending signals',async()=>{
  const f=await fixture(),op=await f.confirm(await f.service.preview({planFile:f.scope.planFile,verifiedOnly:true}));await f.service.execute(op.id);f.online();
  f.sources.set('local:'+f.scope.planFile,'new PLAN');await assert.rejects(f.service.continuePreview(op.id));f.sources.delete('local:'+f.scope.planFile);
  f.ports.currentNode=async()=>({...f.scope.nodes[1],port:9999});
  const report=(await f.service.recheckNode('worker'))[0];assert.equal(report.state,'blocked');assert.equal(report.targets[0].code,'SERVER_IDENTITY_CHANGED');
  assert.deepEqual((await f.service.status(op.id)).pendingNodes,['worker']);assert.equal(f.mutations,1);
});

test('missing offline targets need reviewed acknowledgement, while active jobs still block confirmation',async()=>{
  const f=await fixture(),op=await f.confirm(await f.service.preview({planFile:f.scope.planFile,verifiedOnly:true}));await f.service.execute(op.id);f.online();
  f.sources.delete('worker:work_dirs/p/metric.csv');assert.equal((await f.service.recheckNode('worker'))[0].targets[0].state,'absent');
  f.scope.blockers=[{code:'ACTIVE_JOB',nodeId:'worker',detail:'active'}];const blocked=await f.service.continuePreview(op.id);await assert.rejects(f.confirm(blocked),/ACTIVE_JOB/);
  f.scope.blockers=[];const preview=await f.service.continuePreview(op.id);assert.equal(preview.rows.filter(row=>row.disposition==='move').length,0);
  const ack=await f.confirm(preview);assert.equal((await f.service.execute(ack.id)).state,'completed');assert.equal(f.mutations,1);assert.deepEqual(await f.service.recheckNode('worker'),[]);
});

test('permanent-delete continuation has its own two confirmations after the local PLAN was removed',async()=>{
  const f=await fixture();f.scope.candidates[0].expectedSha256='plan-hash';
  const p=await f.service.preview({planFile:f.scope.planFile,action:'delete',verifiedOnly:true});let op=await f.confirm(p);
  op=await f.service.confirm({token:p.token,digest:p.digest,phase:2,confirm:true,exactTargets:['local:'+p.rows.find(row=>row.disposition==='delete').absolutePath]});
  assert.equal((await f.service.execute(op.id)).state,'partial');f.online();const next=await f.service.continuePreview(op.id),first=await f.confirm(next);
  await assert.rejects(f.service.execute(first.id),/CONFIRM_REQUIRED/);assert.equal(f.mutations,1);
  await f.service.confirm({token:next.token,digest:next.digest,phase:2,confirm:true,exactTargets:next.rows.filter(row=>row.disposition==='delete').map(row=>row.node.id+':'+row.absolutePath)});
  assert.equal((await f.service.execute(first.id)).state,'completed');assert.equal(f.mutations,2);
});

test('lost move receipts are observed without settlement; confirmed continuation settles once and restores the full chain',async()=>{
  const f=await fixture(),original=await f.confirm(await f.service.preview({planFile:f.scope.planFile,verifiedOnly:true}));await f.service.execute(original.id);f.online();
  const child=await f.confirm(await f.service.continuePreview(original.id));f.lose();await assert.rejects(f.service.execute(child.id),/lost response/);assert.equal(f.mutations,2);
  const start=f.calls.length;assert.equal((await f.service.recheckNode('worker'))[0].state,'settlement_required');const next=await f.service.continuePreview(child.id);
  assert.ok(!f.calls.slice(start).some(row=>['files.cleanup.settle','files.cleanup.execute'].includes(row.method)));
  const ack=await f.confirm(next);assert.equal((await f.service.execute(ack.id)).state,'completed');assert.equal(f.mutations,2);
  assert.equal(f.calls.slice(start).filter(row=>row.method==='files.cleanup.settle').length,1);
  const restore=await f.service.restorePreview(ack.id);assert.equal(restore.continuationOf,undefined);assert.equal(restore.rows.length,2);
  const approved=await f.confirm(restore);assert.equal((await f.service.execute(approved.id)).state,'completed');assert.equal(f.mutations,4);
});

test('the retired connection hook never checks or prompts for cleanup on heartbeats, reconnects or execution edges',async()=>{
  const modulePath=require.resolve('../../dist/extension/PlanCleanupHost'),from=require('node:module').createRequire(modulePath),exports={};let checks=0,notices=0;
  const vscode={workspace:{workspaceFolders:[{uri:{fsPath:'C:/fixture'}}]},window:{showWarningMessage:()=>{notices++;return new Promise(()=>{});}}};
  vm.runInNewContext(await fs.readFile(modulePath,'utf8'),{exports,require:name=>name==='vscode'?vscode:name==='./PlanCleanupPanel'?{}:from(name)});
  const host=new exports.PlanCleanupHost({context:{globalStorageUri:{fsPath:os.tmpdir()}}},'C:/fixture');
  host.service.recheckNode=async()=>{checks++;return [{operationId:'a'.repeat(48)}]};
  const online={id:'worker',streamStatus:'polling',reconnectCount:0};
  await host.observeConnections([online]);await host.observeConnections([online]);assert.equal(checks,0);assert.equal(notices,0);
  await host.observeConnections([{...online,streamStatus:'disconnected'}]);await host.observeConnections([online]);assert.equal(checks,0);assert.equal(notices,0);
  await host.observeConnections([{...online,reconnectCount:1}]);assert.equal(checks,0);
  host.executing=true;await host.observeConnections([{...online,reconnectCount:2}]);assert.equal(checks,0);
  host.executing=false;await host.observeConnections([{...online,reconnectCount:2}]);assert.equal(checks,0);assert.equal(notices,0);
});

test('reconnect review opens the existing operation and waits for explicit continuation and confirmation clicks',async()=>{
  let panel;const posted=[],listeners=[],fields=new Map(),element=id=>{if(!fields.has(id))fields.set(id,{value:id==='action'?'move':'',checked:false,disabled:false,textContent:'',innerHTML:''});return fields.get(id)};
  const exports={},vscode={ViewColumn:{Active:1},window:{createWebviewPanel:()=>panel={webview:{html:'',onDidReceiveMessage:()=>({dispose(){}})},onDidDispose(){}}}};
  const panelPath=require.resolve('../../dist/extension/PlanCleanupPanel'),panelRequire=require('node:module').createRequire(panelPath);
  vm.runInNewContext(await fs.readFile(panelPath,'utf8'),{exports,require:name=>name==='vscode'?vscode:panelRequire(name)});
  const id='a'.repeat(48);await exports.openPlanCleanupPanel({service:{}},'experiments/plans/gone.yaml',id);
  const script=panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];new vm.Script(script);
  vm.runInNewContext(script,{acquireVsCodeApi:()=>({postMessage:m=>posted.push(m)}),document:{getElementById:element},setInterval:()=>0,window:{addEventListener:(_e,l)=>listeners.push(l)}});
  listeners[0]({data:{type:'history',rows:[]}});assert.equal(posted.at(-1).type,'status');assert.equal(posted.at(-1).operationId,id);assert.ok(!posted.some(m=>m.type==='preview'||m.type==='execute'));
  listeners[0]({data:{type:'operation',operation:{id,state:'partial',pendingNodes:['worker'],targets:{},preview:{action:'move',blockers:[],rows:[]}}}});
  assert.equal(element('continue').disabled,false);element('continue').onclick();assert.equal(posted.at(-1).type,'continue');assert.ok(!posted.some(m=>m.type==='confirm'||m.type==='execute'));
});

test('removed PLAN metadata retains the real hash, run identities and remote copies; new shared config references remain protected',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'plan-cleanup-removed-metadata-')),file='experiments/plans/p.yaml',config='configs/p.yaml';
  await fs.mkdir(path.join(root,'experiments/plans'),{recursive:true});await fs.mkdir(path.join(root,'configs'),{recursive:true});
  await fs.writeFile(path.join(root,file),'plan_id: stable\nconfig: configs/p.yaml\n','utf8');await fs.writeFile(path.join(root,config),'seed: 42\n','utf8');
  const run={id:'run',stablePlanId:'stable',projectId:canonicalProjectId(root),revision:'r',planFile:file,jobs:[]};
  const input={root,planFile:file,nodes:[{id:'local',kind:'local',root},{id:'worker',kind:'remote',root:'/fixture'}],queue:{schemaVersion:1,plans:[run]},
    ledger:{schemaVersion:2,entries:{entry:{planFile:file,runId:'run',revision:'r',sourceWorkerId:'worker',destinations:{worker:{status:'synced'}}}}},snapshots:[{workerId:'worker',tasks:[],generatedAt:new Date().toISOString()}]};
  const before=await collectPlanCleanupEvidence(input),hashes=Object.fromEntries(before.candidates.filter(row=>row.nodeId==='local'&&row.expectedSha256).map(row=>[row.relativePath,row.expectedSha256]));
  // Keep fixture originals in clean_dir; no permanent deletion is used to simulate their absence.
  for(const rel of [file,config]){await fs.mkdir(path.dirname(path.join(root,'clean_dir',rel)),{recursive:true});await fs.rename(path.join(root,rel),path.join(root,'clean_dir',rel));}
  await fs.writeFile(path.join(root,'experiments/plans/other.yaml'),'config: configs/p.yaml\n','utf8');
  const after=await collectPlanCleanupEvidence({...input,allowMissing:true,removedMetadata:{planFile:file,planHash:before.planHash,planKey:before.planKey,runIds:before.runIds,hashes,references:before.references}});
  assert.equal(after.planHash,before.planHash);assert.equal(after.planKey,before.planKey);assert.deepEqual(after.runIds,['run']);
  assert.equal(after.candidates.find(row=>row.nodeId==='worker'&&row.relativePath===file).expectedSha256,before.planHash);
  assert.match(after.candidates.find(row=>row.nodeId==='worker'&&row.relativePath===config).protectedReason,/共享/);
});

test('restoring an interrupted continuation clears only its own ancestor lifecycle markers',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'plan-cleanup-restore-chain-')),modulePath=require.resolve('../../dist/extension/PlanCleanupHost'),from=require('node:module').createRequire(modulePath),exports={};
  vm.runInNewContext(await fs.readFile(modulePath,'utf8'),{exports,require:name=>name==='vscode'?{workspace:{workspaceFolders:[{uri:{fsPath:root}}]}}:name==='./PlanCleanupPanel'?{}:from(name)});
  const parent='a'.repeat(48),child='b'.repeat(48),restore='c'.repeat(48),queue={plans:[{id:'run',cleanup:{operationId:parent}},{id:'other',cleanup:{operationId:'unrelated'}}]},ledger={entries:{ours:{runId:'run',cleanupOperationId:parent},other:{runId:'other',cleanupOperationId:'unrelated'}}};
  const host=new exports.PlanCleanupHost({context:{globalStorageUri:{fsPath:root}},loadDistributedQueue:async()=>queue,saveDistributedQueue:async()=>{},
    updatePlanSyncLedger:async(_root,update)=>update(ledger),postState(){}},root);
  host.service.history=async()=>[{id:child},{id:parent}];
  await host.updateIndexes({id:restore,preview:{originalOperationId:child,scope:{runIds:['run']}}},true);
  assert.equal(queue.plans[0].cleanup,undefined);assert.equal(ledger.entries.ours.cleanupOperationId,undefined);
  assert.equal(queue.plans[1].cleanup.operationId,'unrelated');assert.equal(ledger.entries.other.cleanupOperationId,'unrelated');
});
