const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
require('../_helpers/registerTsRequire');
const {CompletedJobSyncHost}=require('../../src/extension/CompletedJobSyncHost.ts'),{canonicalProjectId}=require('../../src/features/DistributedPlanQueue.ts');
const {buildScopeStatuses,scopeInventoryPathAllowed}=require('../../src/features/SyncScopeStatus.ts');
const {planLatestWorkerMerge}=require('../../src/features/SyncLatestMerge.ts'),{runSyncScopeBatch}=require('../../src/features/SyncScopeBatch.ts');
test('completed-job result verification does not inspect unrelated panes while broad discovery stays complete',()=>{
 const {spawnSync}=require('node:child_process');
 const result=spawnSync('python',['-X','utf8',path.join(__dirname,'selectedTaskQuery.fixture.py'),path.join(__dirname,'../../src/runtime/TmuxTaskLifecycle.ts')],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(result.status,0,result.stderr||result.stdout);
 assert.deepEqual(JSON.parse(result.stdout),{ok:true,selected:1,discovered:180});
});
const source=fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8'),ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);let member;function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)==='mergeLatestWorkerVersions')member=n;ts.forEachChild(n,visit);}visit(ast);
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'se-job-latest-')),targets=['a','b','c'].map(id=>({id,host:id+'.invalid',port:2222,user:'u',remotePath:'/safe/project'}));
 const jobs=[0,1].map(index=>({index,case:'case'+index,seed:42,attempt:0,status:index?'running':'completed',lifecycleProtocol:2,workerId:'a',commandId:'command'+index,outputDir:'work_dirs/p/job'+index,collectionResultCsv:'tmp/result/job'+index+'.csv',actualExecutionMode:'train_test'}));
 const plan={id:'plan',projectId:canonicalProjectId(root),planFile:'plans/p.yaml',enqueuedAt:'2026-10-14T00:00:00Z',executionMode:'train_test',jobs},queue={plans:[plan]},inventory={a:{},b:{},c:{}},transfers=[],reads={sync:0,inventory:0},errors=[];
 for(const file of ['work_dirs/p/job0/model.pth','work_dirs/p/job0/artifact_manifest.json','tmp/result/job0.csv'])inventory.a[file]={sha256:'a'.repeat(64),size:3,modifiedAtMs:1};
 inventory.b['work_dirs/p/job0/model.pth']={sha256:'b'.repeat(64),size:3,modifiedAtMs:999};
 const config={get:(_k,fallback)=>fallback};let lost=false;
 const h={context:{globalStorageUri:{fsPath:root}},workerCodeSyncTargets:()=>targets,enabledWorkerConfigs:()=>targets,loadDistributedQueue:async()=>structuredClone(queue),
  // Endpoint machine-state guards: fixture endpoints carry no state mapping.
  localMachineStateGuard:()=>({prefixes:[],unknown:false}),targetRootGuard:()=>null,machineStatePrefixesById:()=>[],machineStatePrefixesForTarget:()=>[],
 client:{getWorkerTasks:async()=>{reads.sync++;throw Error('产物同步不得查询 job 状态');}},
 sftpServerOptions:row=>row,recordActionError:r=>errors.push(r),assertSshTransportIdentities:async()=>{},
 refreshSyncScopeStatus:async(_root,_targets,_mode,scopes)=>{reads.inventory++;return buildScopeStatuses({local:{},workers:Object.fromEntries(Object.entries(inventory).map(([id,files])=>[id,Object.fromEntries(Object.entries(files).filter(([file])=>scopes.some(scope=>file===scope||file.startsWith(scope+'/'))))]))},'server-server',scopes,new Set(),{entries:{}});},
 verifiedSftpProjectInventory:async({source,scopePaths})=>({files:Object.fromEntries(Object.entries(inventory[source.id]).filter(([file])=>scopePaths.some(scope=>file===scope||file.startsWith(scope+'/'))))}),
 simpleSftpApiCall:async(method,p)=>{assert.equal(method,'sync.serverToServerFpsync');assert.equal(p.directory,undefined);assert.equal(p.manualRetain,undefined);assert.equal(p.destination.id==='local',false);transfers.push(p);for(const file of p.relativePaths)inventory[p.destination.id][file]=structuredClone(inventory[p.source.id][file]);if(lost){lost=false;throw Error('transport response lost');}},
 patchDistributedJob:async(_root,_id,index,_attempt,patch)=>{const j=jobs[index];if(j.commandId!==patch.expectedCommandId)return;const {expectedCommandId,replaceMirroredWorkerIds,...fields}=patch;Object.assign(j,fields);}};
 h.mergeLatestWorkerVersions=vm.runInNewContext(ts.transpileModule('class Host{'+member.getText(ast)+'};Host.prototype.mergeLatestWorkerVersions',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
 {vscode:{workspace:{getConfiguration:()=>config},Uri:{file:x=>x}},scopeInventoryPathAllowed,planLatestWorkerMerge,runSyncScopeBatch,loadSyncHolds:async()=>({}),isLocalCodeOwnedPath:()=>false,safeSyncPath:require('../../src/features/SyncResolution.ts').safeSyncPath,path,workerFpsyncTaskLabel:()=>'',UiCommandCancelled:Error});
 return {h,root,queue,jobs,inventory,transfers,reads,errors,setLost:()=>lost=true,run:(scope=['.'])=>new CompletedJobSyncHost(h,root,()=>true).run(scope)};
}
test('first completed job merges latest files to every Worker while its sibling is running; old timestamps never win',async()=>{
 const f=fixture();await f.run();assert.equal(f.transfers.length,2);assert.ok(f.transfers.every(p=>p.relativePaths.every(file=>file.includes('job0'))));
 assert.equal(f.inventory.b['work_dirs/p/job0/model.pth'].sha256,'a'.repeat(64));assert.equal(f.jobs[0].latestArtifactSync.state,'synced');assert.equal(f.jobs[1].latestArtifactSync,undefined);
 const proofAt=f.jobs[0].latestArtifactSync.checkedAt,inventoryReads=f.reads.inventory;await f.run();assert.equal(f.transfers.length,2);assert.equal(f.reads.inventory,inventoryReads,'已确认轮不再读取来源清单');assert.equal(f.jobs[0].latestArtifactSync.checkedAt,proofAt,'完成证明时间不被刷新');assert.equal(f.reads.sync,0,'同步全程不查询 job 状态');assert.deepEqual(f.errors,[]);
});
test('newly observed artifact hashes invalidate the old content confirmation without rerunning the task',async()=>{
 const f=fixture();await f.run();const receipt=structuredClone(f.jobs[0].latestArtifactSync),file='work_dirs/p/job0/model.pth';
 assert.equal(typeof receipt.artifactDigest,'string');f.inventory.a[file].sha256='c'.repeat(64);f.jobs[0].artifacts[file]='c'.repeat(64);
 await f.run();assert.equal(f.jobs[0].status,'completed');assert.equal(f.jobs[0].commandId,'command0');
 assert.equal(f.inventory.b[file].sha256,'c'.repeat(64));assert.equal(f.inventory.c[file].sha256,'c'.repeat(64));
 assert.notEqual(f.jobs[0].latestArtifactSync.artifactDigest,receipt.artifactDigest);
 assert.equal(f.jobs[0].latestArtifactSync.state,'synced');
});
test('sync permission reuses the confirmed queue fact with zero job-state queries; a row replaced mid-copy fails honestly and the same error is not logged twice',async()=>{
 const f=fixture();await f.run();assert.equal(f.reads.sync,0,'开始许可与复制全程不查询 job 状态');assert.equal(f.jobs[0].latestArtifactSync.state,'synced');
 const g=fixture();const transfer=g.h.simpleSftpApiCall;let flipped=false;
 g.h.simpleSftpApiCall=async(...args)=>{await transfer(...args);if(!flipped){flipped=true;g.queue.plans[0].jobs[0].outputRetiredAt=new Date().toISOString();}};
 await g.run();
 assert.equal(g.transfers.length,1,'退役行不进入下一个传输分组');
 assert.equal(g.jobs[0].latestArtifactSync.state,'partial');assert.match(g.jobs[0].latestArtifactSync.error,/替代/);assert.equal(g.reads.sync,0);
 g.jobs[0].latestArtifactSync.retryAfter='';await g.run();assert.equal(g.errors.length,1,'同一同步身份的相同错误不逐轮追加');
});
test('a local stop during the copy halts remaining transfers without writing a completion proof',async()=>{
 const f=fixture();let allow=true;const transfer=f.h.simpleSftpApiCall;let flipped=false;
 f.h.simpleSftpApiCall=async(...args)=>{await transfer(...args);if(!flipped){flipped=true;allow=false;}};
 await assert.rejects(new CompletedJobSyncHost(f.h,f.root,()=>allow).run(['.']),/同步已停止/);
 assert.equal(f.transfers.length,1,'停止在下一分组发送前生效');
 assert.equal(f.jobs[0].latestArtifactSync,undefined,'被停止的轮次不写完成证明');assert.equal(f.reads.sync,0);
});
test('bytes that changed after the frozen source manifest fail target verification honestly without rebinding the manifest',async()=>{
 const f=fixture();const refresh=f.h.refreshSyncScopeStatus;let mutated=false;
 f.h.refreshSyncScopeStatus=async(...args)=>{const s=await refresh(...args);if(!mutated){mutated=true;f.inventory.a['work_dirs/p/job0/model.pth']={sha256:'e'.repeat(64),size:3,modifiedAtMs:2};}return s;};
 await f.run();
 assert.equal(f.transfers.length,1,'不符目标后停止继续传输');
 assert.equal(f.jobs[0].latestArtifactSync.state,'partial');assert.match(f.jobs[0].latestArtifactSync.error,/文件内容与本次最新产物不符/);
 assert.equal(f.jobs[0].artifacts,undefined,'未通过核对的字节不记为已确认产物');assert.equal(f.reads.sync,0);
});
test('synthetic real bytes copied to synthetic targets are confirmed by real SHA256 end to end, and post-freeze source tampering fails byte verification honestly',async()=>{
 const crypto=require('node:crypto'),sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 const f=fixture();
 const dirs=Object.fromEntries(['a','b','c'].map(id=>[id,path.join(f.root,'remote',id)]));
 for(const id of Object.keys(dirs))fs.mkdirSync(dirs[id],{recursive:true});
 const files={'work_dirs/p/job0/model.pth':'weights-v1','work_dirs/p/job0/artifact_manifest.json':'{"ok":true}','tmp/result/job0.csv':'seed,acc\n42,0.9\n'};
 for(const [rel,bytes] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(dirs.a,rel)),{recursive:true});fs.writeFileSync(path.join(dirs.a,rel),bytes);}
 f.h.refreshSyncScopeStatus=async(_r,_t,_m,scopes)=>{f.reads.inventory++;const workers={};for(const id of Object.keys(dirs)){workers[id]={};for(const rel of Object.keys(files)){const p=path.join(dirs[id],rel);if(fs.existsSync(p))workers[id][rel]={sha256:sha(p),size:fs.statSync(p).size,modifiedAtMs:1};}}return buildScopeStatuses({local:{},workers},'server-server',scopes,new Set(),{entries:{}});};
 f.h.verifiedSftpProjectInventory=async({source,scopePaths})=>{const out={};for(const rel of scopePaths){const p=path.join(dirs[source.id],rel);if(fs.existsSync(p))out[rel]={sha256:sha(p)};}return {files:out};};
 f.h.simpleSftpApiCall=async(method,p)=>{f.transfers.push(p);for(const rel of p.relativePaths){const to=path.join(dirs[p.destination.id],rel);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(dirs[p.source.id],rel),to);}};
 const report=await f.run();assert.equal(report.synced,1);assert.equal(f.reads.sync,0);
 for(const id of ['b','c'])for(const [rel,bytes] of Object.entries(files))assert.equal(fs.readFileSync(path.join(dirs[id],rel),'utf8'),bytes,'目标 '+id+' 实际字节与来源一致');
 fs.writeFileSync(path.join(dirs.b,'work_dirs/p/job0/model.pth'),'stale');
 const refresh=f.h.refreshSyncScopeStatus;let tampered=false;
 f.h.refreshSyncScopeStatus=async(...args)=>{const s=await refresh(...args);if(!tampered){tampered=true;fs.writeFileSync(path.join(dirs.a,'work_dirs/p/job0/model.pth'),'weights-v2-TAMPERED');}return s;};
 await new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,jobs:[{planId:'plan',index:0,commandId:'command0'}]});
 assert.equal(f.jobs[0].latestArtifactSync.state,'partial');assert.match(f.jobs[0].latestArtifactSync.error,/文件内容与本次最新产物不符/);
 assert.notEqual(fs.readFileSync(path.join(dirs.b,'work_dirs/p/job0/model.pth'),'utf8'),'weights-v1','被篡改来源的不匹配字节如实失败而不是重新绑定清单');
});
test('an excluded selection syncs nothing, and a new run identity is never covered by the old proof',async()=>{
 const f=fixture();await f.run(['models']);assert.equal(f.reads.inventory,0,'无同步工作不发生清单读取');assert.equal(f.jobs[0].latestArtifactSync.state,'excluded');
 await f.run(['.']);const oldKey=f.jobs[0].latestArtifactSync.key,readsBefore=f.reads.inventory;
 f.jobs[0].commandId='command0-new';await f.run(['.']);
 assert.ok(f.reads.inventory>readsBefore,'新运行身份不被旧完成证明冒充跳过，仍实际核对');
 assert.notEqual(f.jobs[0].latestArtifactSync.key,oldKey,'新身份得到自己的证明而不是旧凭据');
 assert.equal(f.jobs[0].latestArtifactSync.state,'synced');assert.equal(f.reads.sync,0);
});
test('checkbox scope limits transfers; excluded jobs do not expand scope, a changed selection permits their results',async()=>{
 const f=fixture();await f.run(['work_dirs']);assert.ok(f.transfers.every(p=>p.relativePaths.every(file=>file.startsWith('work_dirs/'))));assert.equal(f.inventory.b['tmp/result/job0.csv'],undefined);
 const excluded=fixture();await excluded.run(['models']);assert.equal(excluded.transfers.length,0);assert.equal(excluded.jobs[0].latestArtifactSync.state,'excluded');
 await excluded.run(['.']);assert.equal(excluded.transfers.length,2);
});
test('lost transfer response keeps training completed and retries only remaining content after an active query',async()=>{
 const f=fixture();f.setLost();await f.run();assert.equal(f.jobs[0].status,'completed');assert.equal(f.jobs[0].latestArtifactSync.state,'partial');
 f.jobs[0].latestArtifactSync.retryAfter='';await f.run();assert.equal(f.jobs[0].latestArtifactSync.state,'synced');assert.equal(f.transfers.length,2,'the already copied destination needs no repeated transfer');
});

test('artifact transfer and code upload have independent activity while exact artifact paths remain protected',async()=>{
 const f=fixture();
 f.h.codeSyncInFlight=1;
 let release,started;
 const active=new Promise(resolve=>{started=resolve;});
 const transfer=f.h.simpleSftpApiCall;
 f.h.simpleSftpApiCall=async(...args)=>{started();await new Promise(resolve=>{release=resolve;});f.h.simpleSftpApiCall=transfer;return transfer(...args);};
 const mirror=f.run();await active;
 assert.equal(f.h.syncScopeMutationInFlight,undefined,'artifact copy must not take the project code mutation gate');
 assert.equal(f.h.codeSyncInFlight,1);
 assert.equal(f.h.activeArtifactSyncScopes.size,1);
 const ts=require('typescript'),ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);let member;
 function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)==='assertArtifactSyncPathsIdle')member=n;ts.forEachChild(n,visit);}visit(ast);
 const check=vm.runInNewContext(ts.transpileModule('class H{'+member.getText(ast)+'};H.prototype.assertArtifactSyncPathsIdle',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText);
 assert.doesNotThrow(()=>check.call(f.h,f.root,['work_dirs/another-job']));
 assert.throws(()=>check.call(f.h,f.root,['work_dirs/p/job0']),/精确产物路径仍在同步/);
 assert.throws(()=>check.call(f.h,f.root,['work_dirs']),/精确产物路径仍在同步/);
 release();await mirror;
 assert.equal(f.h.activeArtifactSyncScopes.size,0);
 assert.equal(f.jobs[0].latestArtifactSync.state,'synced');
});

test('manual retry bypasses a stale success receipt and cooldown, copying only the selected completed job delta',async()=>{
 const f=fixture();await f.run();const identity=f.jobs[0].commandId;
 delete f.inventory.b['work_dirs/p/job0/model.pth'];f.jobs[0].artifactError='FILE_INDEX_INVALIDATED_DURING_READ';
 f.jobs[0].latestArtifactSync.retryAfter=new Date(Date.now()+60000).toISOString();f.jobs[1].status='completed';
 const report=await new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,jobs:[{planId:'plan',index:0,commandId:identity}]});
 assert.equal(f.transfers.length,3);assert.deepEqual(Array.from(f.transfers[2].relativePaths),['work_dirs/p/job0/model.pth']);
 assert.equal(f.jobs[0].artifactError,undefined);assert.equal(f.jobs[0].commandId,identity);assert.equal(f.jobs[0].status,'completed');assert.equal(f.jobs[1].latestArtifactSync,undefined);
 assert.equal(report.synced,1);assert.deepEqual(report.errors,[]);
});
test('manual refresh reports remaining differences without transfers, and clears a stale sync error when content already agrees',async()=>{
 const f=fixture(),options={force:true,verifyOnly:true,jobs:[{planId:'plan',index:0,commandId:'command0'}]};
 const first=await new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],options);
 assert.equal(f.transfers.length,0);assert.equal(first.errors.length,1);assert.equal(f.jobs[0].latestArtifactSync.state,'partial');
 for(const id of ['b','c'])f.inventory[id]=structuredClone(f.inventory.a);
 const last=await new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],options);
 assert.equal(f.transfers.length,0);assert.equal(last.synced,1);assert.equal(f.jobs[0].artifactError,undefined);assert.equal(f.jobs[0].status,'completed');
});
test('manual stale or running job selections never widen to another job or launch work',async()=>{
 for(const selection of [{planId:'plan',index:0,commandId:'old-command'},{planId:'plan',index:1,commandId:'command1'}]){
  const f=fixture();await assert.rejects(new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,jobs:[selection]}),/所选|完成|变化/);assert.equal(f.transfers.length,0);
 }
});
test('duplicate manual retries share the current job transfer instead of copying twice',async()=>{
 const f=fixture(),merge=f.h.mergeLatestWorkerVersions;let release,entered,calls=0;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 f.h.mergeLatestWorkerVersions=async(...args)=>{calls++;entered();await gate;return merge.call(f.h,...args)};
 const options={force:true,jobs:[{planId:'plan',index:0,commandId:'command0'}]},a=new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],options);
 await started;const b=new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],options);release();await Promise.all([a,b]);
 assert.equal(calls,1);assert.equal(f.transfers.length,2);assert.equal(f.h.completedJobSyncRuns.size,0);
});
