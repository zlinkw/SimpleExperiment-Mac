const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
require('../_helpers/registerTsRequire');
const {ProjectFileIndex,normalizeFileIndexResult,sftpFileIndexQuery,fileOperationIndexPaths,readLocalFileIndexPaths}=require('../../src/features/ProjectFileIndex.ts');
const fixture=async(connection='one')=>{const storage=await fs.mkdtemp(path.join(os.tmpdir(),'project-file-index-'));return {storage,identity:{workspace:storage,endpointId:'worker',projectRoot:'/project',connection}};};
const payload=(n=1)=>({ok:true,files:{'data/a':{size:n,modifiedAtMs:1000,sha256:'a'.repeat(64)}}});
const until=async ready=>{const end=Date.now()+3000;while(!ready()){assert.ok(Date.now()<end,'read did not start');await new Promise(resolve=>setImmediate(resolve));}};

test('same explicit round reuses current evidence; another purpose, round, timeout or restart always reads again',async()=>{
 const {storage,identity}=await fixture();let now=1000,calls=0;const index=new ProjectFileIndex(identity,storage,()=>now),load=async()=>{calls++;return payload(calls);};
 const query={method:'sync.projectInventory',recursive:true,round:'run-1',binding:{runId:'command-1'}};
 assert.equal((await index.read(query,load)).files['data/a'].size,1);await index.read(query,load);assert.equal(calls,1);
 await index.read({...query,metadataOnly:true},load);assert.equal(calls,2,'metadata cannot substitute for content');
 await index.read({...query,round:'run-2'},load);assert.equal(calls,3);
 now+=2001;await index.read(query,load);assert.equal(calls,4);
 const disk=JSON.parse(await fs.readFile(index.file,'utf8'));assert.equal(disk.schemaVersion,1);assert.equal(disk.identity.projectRoot,'/project');assert.equal(JSON.parse(await fs.readFile(index.directoryFile('data'),'utf8')).entries['data/a'].sha256,'a'.repeat(64));assert.equal(disk.observations.at(-1).binding.runId,'command-1');
 const restarted=new ProjectFileIndex({...identity,connection:'new-process'},storage,()=>now);assert.equal(restarted.file,index.file);assert.deepEqual(restarted.snapshot().entries,{});await restarted.read(query,load);assert.equal(calls,5,'disk history cannot authorize a new confirmation');
});

test('complete same-scope reads confirm removal, partial/failure stays unknown and other scopes never imply absence',async()=>{
 const {storage,identity}=await fixture(),index=new ProjectFileIndex(identity,storage);
 const q={method:'sync.projectInventory',recursive:true};await index.read(q,async()=>payload());
 await index.read({...q,relativePath:'elsewhere'},async()=>({files:{}}));assert.equal(index.snapshot().entries['data/a'].presence,'present');
 await index.read(q,async()=>({files:{},complete:false}));assert.equal(index.snapshot().entries['data/a'].presence,'unknown');
 await index.read(q,async()=>({files:{}}));assert.equal(index.snapshot().entries['data/a'].presence,'absent');
 await assert.rejects(index.read(q,async()=>{throw Error('offline');}),/offline/);assert.equal(index.snapshot().entries['data/a'].validity,'historical-only');
 for(const bad of [{ok:false,error:'offline',files:{}},{files:[]},{files:'bad'}])assert.equal(normalizeFileIndexResult(bad,'now','id').state,'failed');
});

test('mutation invalidates in-flight and cached reads; connection replacement cannot restore the old file',async()=>{
 const {storage,identity}=await fixture(),index=new ProjectFileIndex(identity,storage);let release;
 const pending=index.read({method:'metadata',round:'old'},()=>new Promise(resolve=>release=resolve));
 await until(()=>release);
 await index.invalidate('upload started');release(payload());await assert.rejects(pending,/INVALIDATED/);assert.deepEqual(index.snapshot().entries,{});
 let oldRelease;const old=index.read({method:'metadata'},()=>new Promise(resolve=>oldRelease=resolve));
 await until(()=>oldRelease);
 const replacement=new ProjectFileIndex({...identity,connection:'two'},storage);await replacement.read({method:'metadata'},async()=>payload(9));oldRelease(payload(1));await assert.rejects(old,/CONNECTION_REPLACED/);
 assert.equal(JSON.parse(await fs.readFile(replacement.directoryFile('data'),'utf8')).entries['data/a'].size,9);
});

test('late overlapping observations cannot replace newer entry facts and failed envelopes are never reused',async()=>{
 const {storage,identity}=await fixture(),index=new ProjectFileIndex(identity,storage);let release;
 const old=index.read({method:'metadata',round:'old'},()=>new Promise(resolve=>release=resolve));await until(()=>release);await index.read({method:'metadata',round:'new'},async()=>payload(2));release(payload(1));await old;
 assert.equal(index.snapshot().entries['data/a'].size,2);
 let calls=0;const query={method:'metadata',round:'retry'};const bad=async()=>{calls++;return {ok:false,error:'offline',files:{}};};await index.read(query,bad);await index.read(query,bad);assert.equal(calls,2);
 assert.equal(sftpFileIndexQuery('files.cleanup.execute',{}),undefined);assert.equal(sftpFileIndexQuery('sync.projectFileStats',{paths:['a']}).metadataOnly,true);
});

test('an unrelated job output change cannot reject a live PLAN input check',async()=>{
 const {storage,identity}=await fixture(),index=new ProjectFileIndex(identity,storage);let release;
 const check=index.read({method:'plan.source',paths:['configs/model.yaml']},()=>new Promise(resolve=>release=resolve));
 await until(()=>release);
 await index.invalidate('job completed',['work_dirs/job']);release({files:{'configs/model.yaml':{size:1,sha256:'a'.repeat(64)}}});
 await check;assert.equal(index.snapshot().entries['configs/model.yaml'].presence,'present');
});

test('real SFTP entry shares only an explicit read round, strips internal hints and invalidates around actual mutations',async()=>{
 const ts=require('typescript'),vm=require('node:vm'),source=await fs.readFile(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
 const ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true);let method;function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)==='simpleSftpApiCall')method=n;ts.forEachChild(n,visit);}visit(ast);
 const {storage,identity}=await fixture(),index=new ProjectFileIndex(identity,storage);let calls=0;const invalidations=[];
 const run=vm.runInNewContext(ts.transpileModule('class Host{'+method.getText(ast)+'};Host.prototype.simpleSftpApiCall',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
  {workspaceRoot:()=>identity.workspace,assertRetryRequestCurrent(){},sftpFileIndexQuery,fileOperationIndexPaths,vscode:{workspace:{getConfiguration:()=>({get:()=> 'simple'})}},AgentTmuxPolicy_1:require('../../src/tunnel/AgentTmuxPolicy.ts'),
   callSftpWithProgress:async(name,params,discover)=>{calls++;await discover(name);assert.equal(params.fileIndexRound,undefined);return payload();}});
 const h={assertTransferRootSafety(){},simpleSftpCapability:async()=>({}),projectFileObservationIndex:()=>index,invalidateProjectFileIndexes:async reason=>{invalidations.push(reason);await index.invalidate(reason);}};
 const params={source:{id:'worker',remotePath:'/project'},metadataOnly:true,recursive:true,fileIndexRound:'one'};
 await run.call(h,'sync.projectInventory',params);await run.call(h,'sync.projectInventory',params);assert.equal(calls,1);
 await run.call(h,'sync.serverToServerFpsync',{});assert.equal(invalidations.length,2);
 await run.call(h,'sync.projectInventory',params);assert.equal(calls,3);
});

test('directory files contain only direct children and child summaries; unchanged content skips every shard rewrite',async()=>{
 const {storage,identity}=await fixture(),index=new ProjectFileIndex(identity,storage);
 const q={method:'local.metadata',recursive:true,metadataOnly:true};const data={files:{'a/b/file':{size:4,modifiedAtMs:1000}},directories:{'.':{modifiedAtMs:1},a:{modifiedAtMs:1},'a/b':{modifiedAtMs:1}}};
 await index.read(q,async()=>data);const root=JSON.parse(await fs.readFile(index.directoryFile('.'),'utf8')),a=JSON.parse(await fs.readFile(index.directoryFile('a'),'utf8'));
 assert.equal(root.entries['a/b/file'],undefined);assert.equal(a.entries['a/b/file'],undefined);assert.ok(a.entries['a/b']);assert.equal(root.summary.files,1);assert.equal(root.children.a.summary.bytes,4);
 const before=(await fs.stat(index.directoryFile('a/b'))).mtimeMs;await index.read(q,async()=>data);
 const header=JSON.parse(await fs.readFile(index.file,'utf8'));assert.equal(header.directoryFilesWritten,0);assert.equal((await fs.stat(index.directoryFile('a/b'))).mtimeMs,before);
 assert.match(root.freshness,/live-observation-required/);assert.equal(header.entries,undefined,'root header never duplicates every descendant');
});

test('query persists reading before touching the filesystem; explicit missing stats never become a pending absence',async()=>{
 const {storage,identity}=await fixture(),index=new ProjectFileIndex(identity,storage);
 const q={method:'sync.projectFileStats',paths:['data/a'],metadataOnly:true,backgroundPersistence:true};await index.read(q,async()=>payload());
 await index.read(q,async()=>{
  const disk=JSON.parse(await fs.readFile(index.file,'utf8'));assert.equal(disk.observations.at(-1).state,'reading');
  assert.equal(index.snapshot().entries['data/a'].validity,'historical-only');return {ok:true,files:{},missing:['data/a']};
 });
 assert.equal(index.snapshot().entries['data/a'].presence,'absent');
});

test('legacy operation preflight keeps nested scope coverage, observes actual local endpoints, and records a failed refresh without authorizing or blocking deletion',async()=>{
 const {fileOperationIndexPaths,readLocalFileIndexPaths}=require('../../src/features/ProjectFileIndex.ts');
 const ts=require('typescript'),vm=require('node:vm'),source=await fs.readFile(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
 const ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true);let method;function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)==='refreshProjectFileIndexesBeforeOperation')method=n;ts.forEachChild(n,visit);}visit(ast);
 const {storage,identity}=await fixture();await fs.mkdir(path.join(storage,'data'));await fs.writeFile(path.join(storage,'data/a'),'abc','utf8');
 const indexes=new Map(),calls=[];let fail=false;
 const run=vm.runInNewContext(ts.transpileModule('class Host{'+method.getText(ast)+'};Host.prototype.refreshProjectFileIndexesBeforeOperation',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
  {workspaceRoot:()=>storage,path,fileOperationIndexPaths,readLocalFileIndexPaths,sftpFileIndexQuery,
   callSftpWithProgress:async(name,params,discover)=>{await discover(name);calls.push({name,params});if(fail)throw Error('offline');return payload();}});
 const host={simpleSftpCapability:async()=>({methodOptions:{'sync.projectInventory':{metadataOnly:1}}}),projectFileObservationIndex:node=>{
  const id=node?.id||'local';if(!indexes.has(id))indexes.set(id,new ProjectFileIndex({...identity,endpointId:id},storage));return indexes.get(id);
 }};
 const params={source:{id:'one'},destination:{id:'two'},relativePaths:['data/a']};
 await run.call(host,'sync.serverToServerFpsync',params);assert.equal(calls.length,2);
 for(const {name,params:request}of calls){assert.equal(name,'sync.projectInventory');assert.deepEqual(Array.from(request.scopePaths),['data/a']);assert.equal(request.metadataOnly,true);assert.equal(request.recursive,true,'legacy shallow mode cannot resolve nested scopes');}
 assert.equal(indexes.has('local'),false,'remote-only transfers do not read unrelated local paths');
 calls.length=0;await run.call(host,'upload.workspace',{server:{id:'one'}});assert.equal(calls[0].name,'sync.projectTree');assert.equal(calls[0].params.recursive,undefined,'unspecified scope is shallow');
 fail=true;await run.call(host,'upload.workspace',{server:{id:'one'},manifest:{'data/a':{size:3}}});
 assert.equal(indexes.get('local').snapshot().entries['data/a'].size,3);
 assert.equal(indexes.get('one').snapshot().observations.at(-1).state,'failed');
 calls.length=0;await run.call(host,'files.cleanup.execute',{token:'not-persisted'});assert.equal(calls.length,0,'token-only execution uses existing live inspection and frozen authorization');
 assert.deepEqual(fileOperationIndexPaths({entries:[{remotePath:'data/a',localRelativePath:'data/b'}]},true),['data/b']);
});

test('production host keeps one index for a server DTO and its cleanup node projection',async()=>{
 const ts=require('typescript'),vm=require('node:vm'),crypto=require('node:crypto'),source=await fs.readFile(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
 const ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true);let method;function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)==='projectFileObservationIndex')method=n;ts.forEachChild(n,visit);}visit(ast);
 const {storage,identity}=await fixture(),{projectFileIndex}=require('../../src/features/ProjectFileIndex.ts');
 const run=vm.runInNewContext(ts.transpileModule('class Host{'+method.getText(ast)+'};Host.prototype.projectFileObservationIndex',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
  {workspaceRoot:()=>identity.workspace,crypto,process,projectFileIndex});
 const host={client:{},context:{globalStorageUri:{fsPath:storage}}},server={id:'worker',host:'10.0.0.1',networkHost:'10.0.0.1',user:'user',port:22,remotePath:'/project'};
 const page=run.call(host,server),node=run.call(host,{id:server.id,host:server.host,user:server.user,port:String(server.port),root:server.remotePath,kind:'remote'});
 assert.equal(page,node,'deletion projection must not steal the page index owner');
 await page.read({method:'agent.metadata',recursive:true},async()=>payload());
 const another=run.call(host,{...server,host:'10.0.0.2',networkHost:'10.0.0.2'});assert.notEqual(another,page);
 await assert.rejects(page.read({method:'agent.metadata',round:'old'},async()=>payload()),/CONNECTION_REPLACED/);
 const returned=run.call(host,server);assert.notEqual(returned,page,'returning to an old configuration creates a fresh owner, never revives in-flight old evidence');
 await returned.read({method:'agent.metadata'},async()=>payload(3));
});

test('live deletion inspection without a relativePath records exact directory absence and removes descendant counts',async()=>{
 const {storage,identity}=await fixture(),index=new ProjectFileIndex(identity,storage);
 await index.read({method:'agent.metadata',recursive:true,metadataOnly:true},async()=>({files:{'data/a':{size:4}},directories:{data:{modifiedAtMs:1}}}));
 await index.read(sftpFileIndexQuery('files.cleanup.inspect',{target:{relativePath:'data',type:'directory'}}),async()=>({ok:true,executorsChecked:true,executors:[],target:{missing:true,type:'directory',absolutePath:'/project/data'}}));
 assert.equal(index.snapshot().entries.data.presence,'absent');assert.equal(index.snapshot().entries['data/a'].presence,'absent');
 const disk=JSON.parse(await fs.readFile(index.directoryFile('.'),'utf8'));assert.equal(disk.summary.files,0);assert.equal(disk.summary.bytes,0);
 await index.read(sftpFileIndexQuery('sync.projectTreeState',{relativePath:'data'}),async()=>({ok:true,relativePath:'data',exists:false}));assert.equal(index.snapshot().entries.data.presence,'absent');
});

test('a complete narrower inventory updates removed files after historical observation retention expires; failed reads never prove absence',async()=>{
 const {storage,identity}=await fixture(),index=new ProjectFileIndex(identity,storage);
 await index.read({method:'sync.projectInventory',recursive:true,metadataOnly:true},async()=>payload());
 for(let n=0;n<66;n++)await index.read({method:'other',relativePath:'unrelated',binding:{n}},async()=>({files:{}}));
 const q={method:'sync.projectInventory',relativePath:'data',recursive:true,metadataOnly:true};
 await index.read(q,async()=>({ok:false,error:'offline',files:{}}));assert.notEqual(index.snapshot().entries['data/a'].presence,'absent');
 await index.read(q,async()=>({files:{}}));assert.equal(index.snapshot().entries['data/a'].presence,'absent');
});

test('a success envelope without the required list or existence field cannot turn old entries into confirmed missing',async()=>{
 const {storage,identity}=await fixture(),index=new ProjectFileIndex(identity,storage),q={method:'sync.projectInventory',recursive:true,metadataOnly:true};
 await index.read(q,async()=>payload());await index.read(q,async()=>({ok:true}));
 assert.equal(index.snapshot().observations.at(-1).state,'failed');assert.notEqual(index.snapshot().entries['data/a'].presence,'absent');
 const tree=sftpFileIndexQuery('sync.projectTreeState',{relativePath:'data'});
 await index.read(tree,async()=>({ok:true,exists:true}));await index.read(tree,async()=>({ok:true}));
 assert.equal(index.snapshot().observations.at(-1).state,'failed');assert.notEqual(index.snapshot().entries.data.presence,'absent');
});

test('actual mutation wrapper refreshes exact scopes before and after the write and records final absence',async()=>{
 const ts=require('typescript'),vm=require('node:vm'),source=await fs.readFile(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
 const ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true),names=['simpleSftpApiCall','refreshProjectFileIndexesBeforeOperation'],members=[];
 function visit(n){if(ts.isMethodDeclaration(n)&&names.includes(n.name.getText(ast)))members.push(n.getText(ast));ts.forEachChild(n,visit);}visit(ast);
 const {storage,identity}=await fixture(),index=new ProjectFileIndex(identity,storage);let present=true;const calls=[];
 const Host=vm.runInNewContext(ts.transpileModule('class Host{'+members.join('\n')+'};Host',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
 {workspaceRoot:()=>storage,path,fileOperationIndexPaths,readLocalFileIndexPaths,sftpFileIndexQuery,assertRetryRequestCurrent(){},
  callSftpWithProgress:async(method,request)=>{calls.push({method,paths:request.scopePaths});if(method==='sync.serverToServerFpsync'){assert.equal(index.snapshot().entries['data/a'].presence,'present');present=false;return {ok:true};}return {ok:true,files:present?{'data/a':{size:3,modifiedAtMs:1}}:{}};}});
 const h=new Host();h.assertTransferRootSafety=()=>{};h.projectFileObservationIndex=node=>node?index:undefined;
 h.simpleSftpCapability=async()=>({methodOptions:{'sync.projectInventory':{metadataOnly:1}}});
 h.invalidateProjectFileIndexes=async(reason,paths)=>{assert.deepEqual([...paths],['data/a']);await index.invalidate(reason,paths);};
 await h.simpleSftpApiCall('sync.serverToServerFpsync',{source:{id:'worker'},relativePaths:['data/a']});
 assert.deepEqual(calls.map(c=>c.method),['sync.projectInventory','sync.serverToServerFpsync','sync.projectInventory']);
 assert.equal(index.snapshot().entries['data/a'].presence,'absent');assert.equal(index.snapshot().observations.at(-1).binding.purpose,'after-operation');
});

test('real tree cleanup invalidates only its Worker and exact subtree, leaving another Worker and sibling reads intact',async()=>{
 const ts=require('typescript'),vm=require('node:vm'),source=await fs.readFile(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
 const ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true),members=[];
 function visit(n){if(ts.isMethodDeclaration(n)&&['simpleSftpApiCall','deleteSyncScopeRemoteCopy','projectFileObservationIndex','invalidateProjectFileIndexes'].includes(n.name.getText(ast)))members.push(n.getText(ast));ts.forEachChild(n,visit);}visit(ast);
 const {storage}=await fixture();
 let starts=0;const requests=[];
 const Host=vm.runInNewContext(ts.transpileModule('class Host{'+members.join('\n')+'};Host',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
  assertRetryRequestCurrent(){},sftpFileIndexQuery,fileOperationIndexPaths,safeSyncPath:require('../../src/features/SyncResolution.ts').safeSyncPath,
  workspaceRoot:()=>storage,projectFileIndex:require('../../src/features/ProjectFileIndex.ts').projectFileIndex,crypto:require('node:crypto'),process,
  deleteConfirmedScopeCopy:require('../../src/features/SyncScopeDelete.ts').deleteConfirmedScopeCopy,
  isUnderMachineStatePrefixes:require('../../src/features/ProjectRootMap.ts').isUnderMachineStatePrefixes,
  vscode:{workspace:{getConfiguration:()=>({get:()=> 'simple'})}},AgentTmuxPolicy_1:require('../../src/tunnel/AgentTmuxPolicy.ts'),
  callSftpWithProgress:async(method,params)=>{
   requests.push({method,params});if(method.endsWith('.inspect'))return {ok:true,executorsChecked:true,executors:[],target:{relativePath:params.target.relativePath,type:'directory',missing:starts===1}};
   if(method.endsWith('.preview'))return {token:'fixed',digest:'approved',safety:{confirmedPathDeletion:1,entryIdentityBind:1,batchedFastDelete:1,directoryTreeIsolateDelete:1,isolationRenameNoReplace:1,fastDeleteBatchLimit:5000},targets:[{absolutePath:'/project/work_dirs/job',type:'directory'}]};
   if(method.endsWith('.execute')){starts++;return {ok:true};}return {ok:true,state:'completed'};
  },
 });
 const host=new Host();host.assertTransferRootSafety=()=>{};host.simpleSftpCapability=async()=>({methodOptions:{'files.cleanup.preview':{confirmedPathMetadata:1,confirmedPathNestedRepositories:1}}});
 host.context={globalStorageUri:{fsPath:storage}};host.client={};
 host.targetRootGuard=target=>require('../../src/features/ProjectRootMap.ts').machineStateGuard(require('../../src/features/ProjectRootMap.ts').resolveProjectRootMap({projectDir:target.remotePath,installDir:'/runtime',machineStateDirs:['/machine-state']}));
 const server={id:'w1',remotePath:'/project',host:'configured-alias',networkHost:'10.0.0.1',user:'user',port:22};
 const a=host.projectFileObservationIndex(server),b=host.projectFileObservationIndex({...server,id:'w2',host:'other-alias',networkHost:'10.0.0.2'}),pending=[];
 for(const [index,relative]of [[b,'work_dirs/job'],[a,'work_dirs/sibling'],[a,'work_dirs/job']]){
  let release;const result=index.read(sftpFileIndexQuery('files.cleanup.inspect',{target:{relativePath:relative,type:'directory'}}),()=>new Promise(resolve=>release=resolve)).then(value=>({value}),error=>({error}));
  await until(()=>release);pending.push({result,release});
 }
 await host.deleteSyncScopeRemoteCopy(storage,'w1',server,'work_dirs/job',true);
 for(const row of pending)row.release({ok:true,executorsChecked:true,executors:[],target:{missing:false}});
 const [other,sibling,same]=await Promise.all(pending.map(row=>row.result));
 assert.equal(other.error,undefined,'a deletion on w1 must not retire a live w2 presence check');assert.equal(sibling.error,undefined);
 assert.match(same.error.message,/INVALIDATED/);assert.equal(starts,1);assert.equal(a.snapshot().entries['work_dirs/job'].presence,'absent');
 const execute=requests.find(row=>row.method.endsWith('.execute'));assert.deepEqual(Object.keys(execute.params).sort(),['consumerRoot','digest','index','tmuxSessionPrefix','token']);assert.equal(execute.params.consumerRoot,storage,'the local consuming project identity is mandatory on every cleanup request');
 assert.ok(requests.every(row=>row.params.consumerRoot===storage),'inspect/preview/confirm/execute/check all carry the same frozen consumer root');
});
