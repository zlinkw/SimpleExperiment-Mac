const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),ts=require('typescript'),crypto=require('node:crypto');
require('../_helpers/registerTsRequire');
const {SyncScopeLocalIndexReader}=require('../../src/features/SyncScopeLocalIndex.ts');
const {SyncScopeAgentIndexReader,scopeIndexUnsupported}=require('../../src/features/SyncScopeAgentIndex.ts');
const {ProjectFileIndex}=require('../../src/features/ProjectFileIndex.ts');
const {expandSyncScopeBatchSelection}=require('../../src/features/SyncScopeBatch.ts');
const {fileOperationIndexPaths,readLocalFileIndexPaths,sftpFileIndexQuery}=require('../../src/features/ProjectFileIndex.ts');
let ast;
async function method(name,globals={}){ast??=ts.createSourceFile('host.ts',await fs.readFile(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8'),ts.ScriptTarget.Latest,true);let found;function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)===name)found=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(found,'production method missing: '+name);return vm.runInNewContext(ts.transpileModule('class Host{'+found.getText(ast)+'};Host.prototype.'+name,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{crypto,path,SyncScopeLocalIndexReader,SyncScopeAgentIndexReader,scopeIndexUnsupported,...globals});}

test('batch delete and sync share one freshly requested index per node across all expanded parents; the next operation accepts live deletion deltas',async()=>{
 const storage=await fs.mkdtemp(path.join(os.tmpdir(),'scope-operation-index-')),root=path.join(storage,'project');
 await fs.mkdir(path.join(root,'local'),{recursive:true});await fs.writeFile(path.join(root,'local','a'),'a','utf8');
 const targets=[{id:'w1'},{id:'w2'}],indexes=new Map(),calls=[],generations=new Map(),states=new Map(targets.map(t=>[t.id,[{p:'.',d:true,m:1},{p:'remote',d:true,m:1},{p:'remote/deep',d:true,m:1},{p:'remote/deep/a',d:false,m:1,s:1}]]));let offline=false;
 for(const entries of states.values())for(let n=0;n<50;n++)entries.push({p:'d'+n,d:true,m:1},{p:'d'+n+'/keep',d:false,m:1,s:1},{p:'d'+n+'/skip',d:false,m:1,s:1});
 const host={context:{globalStorageUri:{fsPath:storage}},sftpServerOptions:t=>({...t,remotePath:'/project'}),projectFileObservationIndex(node){const id=node?.id||'local';if(!indexes.has(id))indexes.set(id,new ProjectFileIndex({workspace:root,endpointId:id,projectRoot:node?'/project':root,connection:'fixture',endpointBinding:id},storage));return indexes.get(id);},
  client:{getWorkerSyncScopeIndex:async(id,q)=>{calls.push({id,...q});if(q.op==='release')return {ok:true};if(offline)throw Error('worker offline');const generation=(generations.get(id)||0)+1;generations.set(id,generation);return {ok:true,status:'ready',instanceId:id,requestId:q.requestId,generation,reset:!q.afterGeneration,entries:q.afterGeneration?[{p:'remote/deep/a',x:true}]:states.get(id),nextCursor:null,projectRoot:'/project',requestedProjectRoot:'/project'};}},
  simpleSftpApiCall:()=>assert.fail('indexed selection must not launch a directory SSH query')};
 host.listSyncScopeUnion=await method('listSyncScopeUnion',{loadSyncHolds:async()=>({}),isSyncHeld:()=>false,errorMessage:e=>e.message});
 const create=await method('createSyncScopeBatchIndex',{workspaceRoot:()=>root});
 assert.throws(()=>create.call(host,root,[],false),/状态未知/);
 let index=create.call(host,root,targets,false,()=>{});
 try{const selected=await expandSyncScopeBatchSelection(['.'],['remote/deep/a',...Array.from({length:50},(_,n)=>'d'+n+'/skip')],p=>index.list(p),()=>{},[],{fresh:true});assert.equal(selected.length,50);assert.ok(selected.every(e=>e.path.endsWith('/keep')));assert.equal((await index.list('remote/deep'))[0].path,'remote/deep/a');assert.equal(calls.filter(c=>c.op==='refresh').length,2);}
 finally{index.dispose();}
 const page=new SyncScopeAgentIndexReader((q,o)=>host.client.getWorkerSyncScopeIndex('w1',q,o),undefined,indexes.get('w1'));await page.read('before-other-operation');
 index=create.call(host,root,targets,true,()=>{});
 try{assert.equal((await index.list('remote/deep')).length,0);for(const id of ['w1','w2'])assert.ok(calls.filter(c=>c.id===id&&c.op==='refresh').at(-1).afterGeneration,'another operation must refresh and resume the saved cursor');}
 finally{index.dispose();for(const value of indexes.values())await value.flush();}
 const latest=generations.get('w1');await page.read('after-other-operation');assert.equal(calls.filter(c=>c.id==='w1'&&c.op==='refresh').at(-1).afterGeneration,latest,'the open page must resume the newer operation cursor instead of requesting a full reset');page.dispose();
 offline=true;index=create.call(host,root,targets,true,()=>{});
 try{await assert.rejects(index.list('remote/deep'),/worker offline/,'saved empty indexes cannot prove absence after a failed live query');}finally{index.dispose();}
});

test('batch selection uses the operation index for both actions and releases it when source selection is cancelled',async()=>{
 const run=await method('runSyncScopeTreeBatch',{expandSyncScopeBatchSelection,loadSyncHolds:async()=>({}),isLocalCodeOwnedPath:()=>false,
 vscode:{workspace:{getConfiguration:()=>({get:()=>[]})},Uri:{file:x=>x},window:{showQuickPick:async()=>undefined}}});
 for(const action of ['sync','delete']){let reads=0,disposed=0;const host={context:{globalStorageUri:{fsPath:'fixture'}},createSyncScopeBatchIndex(){return {list:async()=>{reads++;return [{path:'data',name:'data',directory:true,locations:['w1']}];},dispose(){disposed++;}};},listSyncScopeUnion:()=>assert.fail('batch bypassed its index')};
 assert.equal(await run.call(host,'root',[{id:'w1'}],false,action,['data'],[],()=>{},[{path:'data',name:'stale',directory:true,locations:['old-worker']}]),false);assert.equal(reads,1);assert.equal(disposed,1);assert.equal(host.syncScopeMutationInFlight,false);}
});

test('file-operation metadata refresh reuses live Worker indexes and remote-only synchronization does not stat unrelated local files',async()=>{
 const calls=[],localReads=[],requests=[],indexes=new Map();let offline=false,unsupported=false,failures=0;
 const refresh=await method('refreshProjectFileIndexesBeforeOperation',{workspaceRoot:()=>'/project',fileOperationIndexPaths,sftpFileIndexQuery,
 readLocalFileIndexPaths:async(...args)=>{localReads.push(args);return {files:{}};},callSftpWithProgress:async(name,params)=>{calls.push({name,params});return {files:{}};}});
 const initial=id=>({instanceId:id,generation:1,entries:[['.',{p:'.',d:true,m:1}],['data',{p:'data',d:true,m:1}],['data/a',{p:'data/a',d:false,m:1,s:1}]],acceleration:{mode:'native-directory-deltas'}});
 const host={projectFileObservationIndex(node){const id=node?.id||'local';if(!indexes.has(id)){let saved=initial(id);indexes.set(id,{file:id,readBaseline:async()=>saved,writeBaseline:async value=>{saved=value;},read:async(q,load)=>{try{return await load();}catch(e){failures++;throw e;}}});}return indexes.get(id);},simpleSftpCapability:async()=>({methodOptions:{'sync.projectInventory':{metadataOnly:1}}}),
 client:{getWorkerSyncScopeIndex:async(id,q)=>{if(q.op==='release')return {ok:true};requests.push({id,...q});if(offline)throw Error('offline');if(unsupported)throw Error('SCOPE_INDEX_UNSUPPORTED');return {ok:true,status:'ready',instanceId:id,requestId:q.requestId,generation:q.afterGeneration+1,reset:false,entries:[],acceleration:{mode:'native-directory-deltas'},nextCursor:null,projectRoot:'/project',requestedProjectRoot:'/project'};}}};
 const params={source:{id:'w1',remotePath:'/project'},destination:{id:'w2',remotePath:'/project'},relativePaths:['data']};
 await refresh.call(host,'sync.serverToServerFpsync',params);
 assert.equal(localReads.length,0);assert.equal(calls.length,0,'supported Workers never enter recursive SSH metadata inventory');assert.equal(requests.length,2);
 await refresh.call(host,'simpleSftpMac.uploadWorkspace',{localPath:'/project',server:{id:'w1',remotePath:'/project'},manifest:{'data/a':{size:1}}});assert.equal(localReads.length,1,'actual local sources still get a live exact-path observation');
 offline=true;await refresh.call(host,'sync.serverToServerFpsync',params);assert.equal(failures,2,'failed active observations are recorded unknown for both Workers');assert.equal(calls.length,0,'offline indexes cannot silently fall back to stale or empty facts');
 offline=false;unsupported=true;await refresh.call(host,'sync.serverToServerFpsync',params);assert.equal(calls.length,2,'an explicitly old Agent retains the live legacy lookup');for(const call of calls)assert.equal(call.params.recursive,true,'legacy shallow mode must never falsely report nested paths absent');
 const refreshed=requests.length;indexes.get('w1').readBaseline=async()=>undefined;indexes.get('w2').readBaseline=async()=>({acceleration:{mode:'live-stat-reconciliation'}});
 await refresh.call(host,'sync.serverToServerFpsync',params);assert.equal(requests.length,refreshed,'unindexed or non-native filesystems must not incur an implicit whole-project scan');assert.equal(calls.length,4);
});

test('memory-only batch downloads do not trigger write preflight, invalidation or a second recursive index read',async()=>{
 const call=await method('simpleSftpApiCall',{assertRetryRequestCurrent(){},workspaceRoot:()=> 'C:/fixture',sftpFileIndexQuery,fileOperationIndexPaths,
 callSftpWithProgress:async(name,params)=>{assert.equal(name,'sync.downloadMappedPaths');assert.equal(params.memoryOnly,true);return {ok:true,entries:[]};}});
 const host={refreshProjectFileIndexesBeforeOperation:()=>assert.fail('memory reads cannot start a file-operation scan'),invalidateProjectFileIndexes:()=>assert.fail('memory reads cannot invalidate filesystem observations')};
 assert.equal((await call.call(host,'sync.downloadMappedPaths',{source:{id:'w1'},memoryOnly:true,entries:[{remotePath:'artifacts/a',localRelativePath:'artifacts/a'}]})).ok,true);
});
