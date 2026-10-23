const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
require('../_helpers/registerTsRequire');
const {safeSyncPath}=require('../../src/features/SyncResolution.ts');
const {isUnderMachineStatePrefixes}=require('../../src/features/ProjectRootMap.ts');
const {scopeInventoryPathAllowed,buildScopeStatuses}=require('../../src/features/SyncScopeStatus.ts');
const {expandSyncScopeBatchSelection,runSyncScopeBatch,syncScopeIssueSignature}=require('../../src/features/SyncScopeBatch.ts');
const {planLatestWorkerMerge}=require('../../src/features/SyncLatestMerge.ts');
const {planSyncScopeTransferGroups,batchSyncScopeInventoryPaths,scopeInventorySnapshot}=require('../../src/features/SyncScopeTransferBatch.ts');
const ast=ts.createSourceFile('legacy.ts',fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8'),ts.ScriptTarget.Latest,true);
const targets=[{id:'w1'},{id:'w2'}],file='configs/model.yaml',sha='a'.repeat(64),files={[file]:{sha256:sha,size:3}};
function method(name,globals={}){let member;function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)===name)member=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(member,name);return vm.runInNewContext(ts.transpileModule('class Host{'+member.getText(ast)+'};Host.prototype.'+name,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
 path,safeSyncPath,isUnderMachineStatePrefixes,scopeInventoryPathAllowed,expandSyncScopeBatchSelection,runSyncScopeBatch,planSyncScopeTransferGroups,batchSyncScopeInventoryPaths,scopeInventorySnapshot,
 loadSyncHolds:async()=>({[file]:{endpointId:'w2',codeOwned:true,directory:false}}),isLocalCodeOwnedPath:()=>true,
 vscode:{workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback})},Uri:{file:x=>x}},workerFpsyncTaskLabel:()=>'',...globals});}
function host(){const calls=[];return {calls,context:{globalStorageUri:{fsPath:'unused'}},
 // This fixture explicitly maps machine state outside its project on each endpoint.
 localMachineStateGuard:()=>({prefixes:[],unknown:false}),targetRootGuard:()=>({prefixes:[],unknown:false}),machineStatePrefixesById:()=>[],machineStatePrefixesForTarget:()=>[],
 sftpServerOptions:row=>({...row,host:row.id+'.invalid',remotePath:'/project',user:'u',port:22}),
 simpleSftpCapability:async name=>calls.push({capability:name}),assertSshTransportIdentities:async()=>{},
 verifiedSftpProjectInventory:async()=>({files}),readScopedProjectInventory:async()=>files,loadSyncScopeBatchSourceFiles:async()=>files,
 simpleSftpApiCall:async(method,params)=>{calls.push({method,params});if(method==='sync.projectTree')return {entries:[{path:'configs',directory:true}]};assert.equal(method,'sync.serverToServerFpsync');return {ok:true};},
 deleteSyncScopeRemoteCopy:async(id,server,relative,directory)=>calls.push({delete:id,relative,directory}),
 updateSyncScopeHolds:async(_root,mutate)=>{const saved={};mutate(saved);calls.push({saved});}};}

test('single Worker file and directory choices allow code-owned sources without touching local files',async()=>{
 for(const directory of [false,true]){const h=host(),confirmed=[];
  const retain=method('retainSyncScopeVersion',{confirmSyncScopePaths:async(...args)=>{confirmed.push(args);return true;}});
  assert.equal(await retain.call(h,'local-root',targets,directory?'configs':file,'w1',directory,()=>{},false,['w2']),true);
  assert.equal(confirmed.length,1,'existing full-path double-confirmation entry is retained');
  assert.equal(h.calls.some(c=>c.capability),false,'Worker-only sync never prepares a local download');
  const transfer=h.calls.find(c=>c.method==='sync.serverToServerFpsync');assert.equal(transfer.params.source.id,'w1');assert.equal(transfer.params.destination.id,'w2');
  assert.equal(h.calls.at(-1).saved[directory?'configs':file].codeOwned,true,'code ownership remains recorded');
 }
});

test('Worker batch transfer permits code-owned paths while retaining exact directory replacement and hashes',async()=>{
 for(const directory of [false,true]){const h=host(),run=method('transferSyncScopeBatch');
  assert.deepEqual([...await run.call(h,'local-root',targets,[{path:directory?'configs':file,directory,endpointId:'w1'}],['w2'])],[directory?'configs':file]);
  const transfer=h.calls.find(c=>c.method==='sync.serverToServerFpsync');assert.equal(transfer.params.source.id,'w1');assert.equal(transfer.params.destination.id,'w2');
  assert.deepEqual([...transfer.params.relativePaths],[file]);assert.equal(h.calls.some(c=>c.capability),false);
  assert.equal(h.calls.filter(c=>c.delete).length,directory?1:0);
  assert.equal(h.calls.at(-1).saved[directory?'configs':file].codeOwned,true);
 }
});

test('both transfer entry points still reject remote code overwriting local copies',async()=>{
 for(const name of ['transferSyncScopeBatch','retainSyncScopeVersion']){const h=host(),run=method(name);
  const promise=name==='transferSyncScopeBatch'?run.call(h,'local-root',targets,[{path:file,directory:false,endpointId:'w1'}],['w2','local'])
   :run.call(h,'local-root',targets,file,'w1',false,()=>{},true,['local','w2']);
  await assert.rejects(promise,/代码以本机为准/);assert.equal(h.calls.some(c=>c.method||c.delete||c.saved),false);
 }
});

test('Worker batch source picker includes code-owned copies and forwards only confirmed Worker targets',async()=>{
 const h=host(),picks=[],confirmations=[];let disposed=0;
 h.createSyncScopeBatchIndex=()=>({list:async()=>[{path:file,name:'model.yaml',directory:false,locations:['w1','w2']}],dispose:()=>disposed++});
 h.transferSyncScopeBatch=async(_root,_targets,work,destinations)=>{assert.equal(confirmations.length,1);assert.equal(work[0].endpointId,'w1');assert.deepEqual([...destinations],['w2']);return [file];};
 const run=method('runSyncScopeTreeBatch',{confirmSyncScopePaths:async(...args)=>{confirmations.push(args);return true;},
  vscode:{workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback})},Uri:{file:x=>x},window:{showQuickPick:async(options)=>{picks.push(options);return options[0];}}}});
 const result=await run.call(h,'local-root',targets,false,'sync',[file],[],()=>{});
 assert.deepEqual([...result.completed],[file]);assert.deepEqual(Array.from(picks[0],row=>row.endpointId),['w1','w2']);assert.equal(disposed,1);assert.equal(h.syncScopeMutationInFlight,false);
});

test('manual latest-Worker merge does not discard files solely because local code owns their paths',async()=>{
 const h=host();h.enabledWorkerConfigs=()=>targets;h.refreshSyncScopeStatus=async()=>({});let retained=0;
 h.retainSyncScopeVersion=async(_root,_targets,relative,source,directory,report,approved,destinations)=>{retained++;assert.equal(relative,file);assert.equal(source,'w1');assert.equal(approved,true);assert.deepEqual([...destinations],['w2']);};
 const run=method('mergeLatestWorkerVersions',{planLatestWorkerMerge:()=>({items:[{path:file,sourceId:'w1',destinationIds:['w2']}],skipped:[]}),confirmSyncScopePaths:async()=>true});
 const result=await run.call(h,'local-root',targets,['.'],'.');assert.equal(retained,1);assert.deepEqual([...result.completed],[file]);assert.equal(result.errors.length,0);
});

function latestDirectoryFixture(mode='normal'){
 const h=host(),queries=[],transfers=[],confirmations=[],relative='artifacts',artifact=relative+'/report.json';
 h.enabledWorkerConfigs=()=>targets;h.loadPlanSyncLedger=async()=>({schemaVersion:2,entries:{}});h.loadDistributedQueue=async()=>({});
 h.simpleSftpApiCall=async(name,p)=>{
  assert.equal(name,'sync.projectInventory');queries.push(p);if(mode==='offline'&&p.source.id==='w2')throw Error('worker offline');
  const candidates=[artifact,'work_dirs/run/report.json','artifacts-other/outside.json'];
  const allowed=file=>(p.relativePath==='.'||file===p.relativePath||file.startsWith(p.relativePath+'/'))&&(!p.scopePaths||p.scopePaths.some(scope=>scope==='.'||file===scope||file.startsWith(scope+'/')));
  if(mode==='empty')return {ok:true,files:{}};
  if(mode==='unverified')return {ok:true,files:{},unverifiedFiles:{[artifact]:'PermissionError'}};
  return {ok:true,files:Object.fromEntries(candidates.filter(allowed).map(file=>[file,{sha256:(p.source.id==='w1'?'a':'b').repeat(64),size:3,modifiedAtMs:p.source.id==='w1'?200:100}]))};
 };
 h.refreshSyncScopeStatus=method('refreshSyncScopeStatus',{buildScopeStatuses,syncScopeIssueSignature,loadSyncHolds:async()=>({}),UiCommandCancelled:Error});
 h.retainSyncScopeVersion=async(_root,_targets,file,source,directory,report,approved,destinations)=>transfers.push({file,source,approved,destinations:[...destinations]});
 const run=method('mergeLatestWorkerVersions',{planLatestWorkerMerge,confirmSyncScopePaths:async(...args)=>{confirmations.push(args);return mode!=='cancel';},UiCommandCancelled:Error});
 return {h,run,queries,transfers,confirmations,relative,artifact};
}

test('latest directory merge queries the clicked directory outside automatic scope through real refresh and planning',async()=>{
 const f=latestDirectoryFixture(),result=await f.run.call(f.h,'local-root',targets,['work_dirs/run'],f.relative);
 assert.deepEqual([...result.errors],[],'the clicked folder must not become an unverified synthetic file');assert.deepEqual([...result.completed],[f.artifact]);
 assert.equal(f.queries.length,2);for(const q of f.queries){assert.equal(q.relativePath,f.relative);assert.deepEqual([...q.scopePaths],[f.relative]);}
 assert.deepEqual(f.transfers,[{file:f.artifact,source:'w1',approved:true,destinations:['w2']}]);assert.equal(f.confirmations.length,1);
});

test('an actively queried empty directory is a no-op rather than an unverified file',async()=>{
 const f=latestDirectoryFixture('empty'),result=await f.run.call(f.h,'local-root',targets,['work_dirs/run'],f.relative);
 assert.deepEqual([...result.completed],[]);assert.deepEqual([...result.errors],[]);assert.equal(f.transfers.length,0);assert.equal(f.confirmations.length,0);
});

test('real unreadable files and failed Worker queries cannot become successful empty-directory merges',async()=>{
 const unknown=latestDirectoryFixture('unverified'),result=await unknown.run.call(unknown.h,'local-root',targets,['.'],unknown.relative);
 assert.equal(result.completed.length,0);assert.match(result.errors.join(';'),/artifacts\/report.json.*PermissionError/);assert.equal(unknown.transfers.length,0);
 const offline=latestDirectoryFixture('offline');await assert.rejects(offline.run.call(offline.h,'local-root',targets,['.'],offline.relative),/清单校验失败.*worker offline/);assert.equal(offline.transfers.length,0);
});

test('root latest merge retains its declared scope and cancelling directory confirmation starts no transfer',async()=>{
 const root=latestDirectoryFixture(),result=await root.run.call(root.h,'local-root',targets,['work_dirs/run'],'.');
 assert.deepEqual([...result.completed],['work_dirs/run/report.json']);for(const q of root.queries)assert.deepEqual([...q.scopePaths],['work_dirs/run']);
 const cancel=latestDirectoryFixture('cancel');assert.equal(await cancel.run.call(cancel.h,'local-root',targets,['work_dirs/run'],cancel.relative),false);assert.equal(cancel.transfers.length,0);
});
