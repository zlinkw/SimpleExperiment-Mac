const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
require('../_helpers/registerTsRequire');
const {CompletedJobSyncHost}=require('../../src/extension/CompletedJobSyncHost.ts'),{canonicalProjectId}=require('../../src/features/DistributedPlanQueue.ts');
const {buildScopeStatuses,scopeInventoryPathAllowed}=require('../../src/features/SyncScopeStatus.ts');
const {planLatestWorkerMerge}=require('../../src/features/SyncLatestMerge.ts'),{runSyncScopeBatch}=require('../../src/features/SyncScopeBatch.ts');
test('one enabled Worker skips artifact synchronization before joining any old run or reading queue state',async()=>{
 const h={workerCodeSyncTargets:()=>[{id:'current'}],completedJobSyncRuns:new Map([['/fixture',{key:'old',promise:Promise.resolve({synced:99,errors:['old']})}]]),
  loadDistributedQueue:()=>assert.fail('single-Worker mode must not inspect the artifact synchronization queue')};
 const report=await new CompletedJobSyncHost(h,'/fixture',()=>true).run(['.'],{force:true,jobs:[{planId:'p',index:0,commandId:'c'}]});
 assert.deepEqual(report,{synced:0,excluded:0,errors:[]});assert.equal(h.completedJobSyncRuns.size,1,'another active record remains untouched');
});
test('single-Worker host entries stop before artifact follow-up preparation, queue reads or remote observations',async()=>{
 const text=fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8'),tree=ts.createSourceFile('legacy.ts',text,ts.ScriptTarget.Latest,true);
 const names=['artifactSyncFromUi','syncCompletedPlanArtifacts','refreshPlanArtifactSyncStatus','syncDistributedJobArtifacts'],methods=new Map();
 function visit(node){if(ts.isMethodDeclaration(node)&&names.includes(node.name.getText(tree)))methods.set(node.name.getText(tree),node.getText(tree));ts.forEachChild(node,visit);}visit(tree);
 for(const name of names){
  const method=vm.runInNewContext(ts.transpileModule('class Host{'+methods.get(name)+'};Host.prototype.'+name,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText);
  const host=new Proxy({workerCodeSyncTargets:()=>[{id:'only'}]},{get(target,key){if(key in target)return target[key];assert.fail(name+' unexpectedly accessed '+String(key));}});
  const result=await method.call(host,{});if(name==='artifactSyncFromUi')assert.equal(result.status,'completed');
 }
});
test('two completed Plans use one archive per Worker pair and keep independent job results',async()=>{
 const f=fixture();f.jobs[1].status='completed';
 for(const file of ['work_dirs/p/job1/model.pth','work_dirs/p/job1/artifact_manifest.json','tmp/result/job1.csv'])f.inventory.a[file]={sha256:'c'.repeat(64),size:3,modifiedAtMs:1};
 const first=f.queue.plans[0];first.jobs=[f.jobs[0]];f.queue.plans.push({...first,id:'second-plan',planFile:'plans/second.yaml',jobs:[f.jobs[1]]});
 const report=await f.run();assert.equal(report.synced,2);assert.deepEqual(report.errors,[]);
 assert.equal(f.transfers.length,2,'one compressed transfer for each of a→b and a→c');
 assert.ok(f.transfers.every(row=>row.relativePaths.some(file=>file.includes('job0'))&&row.relativePaths.some(file=>file.includes('job1'))));
 for(const job of f.jobs){assert.equal(job.latestArtifactSync.state,'synced');assert.ok(Object.keys(job.artifacts).every(file=>file.includes('job'+job.index)));}
 assert.ok(f.transfers.every(row=>row.retentionKey.startsWith('job-artifacts-batch:')));
 assert.equal(f.h.activeArtifactSyncScopes.size,0);
});

function completedPair(){const f=fixture();f.jobs[1].status='completed';giveJob1Source(f);return f;}
test('combined transport retains both exact scope guards through transfer and fresh verification, with independent corruption results',async()=>{
 const f=completedPair(),transfer=f.h.simpleSftpApiCall,inventory=f.h.verifiedSftpProjectInventory;
 const guards=()=>assert.equal(f.h.activeArtifactSyncScopes.size,2,'both job scopes remain protected until the batch finishes');
 f.h.simpleSftpApiCall=async(...args)=>{guards();await transfer(...args);const p=args[1];if(p.destination.id==='b')f.inventory.b['work_dirs/p/job0/model.pth'].sha256='e'.repeat(64);};
 f.h.verifiedSftpProjectInventory=async(...args)=>{guards();return inventory(...args);};
 await f.run();
 assert.equal(f.jobs[0].latestArtifactSync.state,'partial');assert.match(f.jobs[0].artifactError,/文件内容与本次最新产物不符/);
 assert.equal(f.jobs[1].latestArtifactSync.state,'synced','a sibling is not failed by another member’s corrupt output');
 assert.equal(f.h.activeArtifactSyncScopes.size,0);assert.equal(f.jobs[0].status,'completed');
});
test('combined transport lost response retries only remaining deltas with the same full-member identity',async()=>{
 const f=completedPair();f.setLost();await f.run();
 assert.ok(f.jobs.every(job=>job.latestArtifactSync.state==='partial'));const first=f.transfers[0];
 for(const job of f.jobs)job.latestArtifactSync.retryAfter='';
 await f.run();assert.ok(f.jobs.every(job=>job.latestArtifactSync.state==='synced'));
 assert.equal(f.transfers.length,2,'the already copied destination is verified, never copied again');
 assert.equal(f.transfers[1].generation,first.generation);assert.equal(f.transfers[1].retentionKey,first.retentionKey);
 assert.deepEqual(f.jobs.map(job=>job.commandId),['command0','command1']);assert.equal(f.h.activeArtifactSyncScopes.size,0);
});
test('read-only verification of multiple completed jobs never prepares roots or dispatches a combined transfer',async()=>{
 const f=completedPair();f.h.prepareCodeSyncRootGuards=()=>assert.fail('read-only verification must not prepare roots');
 await new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,verifyOnly:true});
 assert.equal(f.transfers.length,0);assert.ok(f.jobs.every(job=>job.latestArtifactSync.state==='partial'));
 assert.equal(f.h.activeArtifactSyncScopes.size,0);
});
test('conflicting batch ownership fails before transfer and releases every prepared scope',async()=>{
 const {transferPreparedArtifacts}=require('../../src/features/ArtifactBatchTransfer.ts');let released=0;
 const rows=['a','b'].map((id,index)=>({member:{retentionKey:id,planId:id,commandId:id,files:{'work_dirs/shared/model':id.repeat(64)}},
  files:{'work_dirs/shared/model':id.repeat(64)},foreignOnly:[],assertCurrent:async()=>{},release:()=>released++,
  requests:[{source:{id:'source'},destination:{id:'target'},paths:['work_dirs/shared/model'],guard:async()=>{},
   transfer:async()=>assert.fail('conflicting ownership cannot create an archive'),inventory:async()=>assert.fail('no transfer to verify')}]}));
 const results=await transferPreparedArtifacts(rows);assert.equal(released,2);
 for(const result of results){assert.equal(result.completed.length,0);assert.match(result.errors.join(' '),/ARTIFACT_BATCH_PATH_CONFLICT/);}
});
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
 const config={get:(_k,fallback)=>fallback};let lost=false;const nativeNotes=[];
 const h={context:{globalStorageUri:{fsPath:root}},workerCodeSyncTargets:()=>targets,enabledWorkerConfigs:()=>targets,loadDistributedQueue:async()=>structuredClone(queue),
  showNativePanelMessage:m=>nativeNotes.push(structuredClone(m)),
  // Endpoint machine-state guards: fixture endpoints carry no state mapping.
  localMachineStateGuard:()=>({prefixes:[],unknown:false}),targetRootGuard:()=>null,machineStatePrefixesById:()=>[],machineStatePrefixesForTarget:()=>[],
  // r8 最小依赖补全：本夹具端点无状态映射，prepare 呈现"已可绑定、零 GET"冻结形态。
  prepareCodeSyncRootGuards:async(rows)=>({guards:new Map(rows.map(t=>[t,{prefixes:[],unknown:false}])),assertBindingsCurrent:()=>{}}),
 client:{getWorkerTasks:async()=>{reads.sync++;throw Error('产物同步不得查询 job 状态');}},
 sftpServerOptions:row=>row,recordActionError:r=>errors.push(r),assertSshTransportIdentities:async()=>{},
 refreshSyncScopeStatus:async(_root,_targets,_mode,scopes)=>{reads.inventory++;return buildScopeStatuses({local:{},workers:Object.fromEntries(Object.entries(inventory).map(([id,files])=>[id,Object.fromEntries(Object.entries(files).filter(([file])=>scopes.some(scope=>file===scope||file.startsWith(scope+'/'))))]))},'server-server',scopes,new Set(),{entries:{}});},
 verifiedSftpProjectInventory:async({source,scopePaths})=>({files:Object.fromEntries(Object.entries(inventory[source.id]).filter(([file])=>scopePaths.some(scope=>file===scope||file.startsWith(scope+'/'))))}),
 simpleSftpApiCall:async(method,p)=>{assert.equal(method,'sync.serverToServerFpsync');assert.equal(p.directory,undefined);assert.equal(p.manualRetain,undefined);assert.equal(p.destination.id==='local',false);transfers.push(p);for(const file of p.relativePaths)inventory[p.destination.id][file]=structuredClone(inventory[p.source.id][file]);if(lost){lost=false;throw Error('transport response lost');}},
 patchDistributedJob:async(_root,_id,index,_attempt,patch)=>{const j=jobs[index];if(j.commandId!==patch.expectedCommandId)return;const {expectedCommandId,replaceMirroredWorkerIds,...fields}=patch;Object.assign(j,fields);}};
 h.mergeLatestWorkerVersions=vm.runInNewContext(ts.transpileModule('class Host{'+member.getText(ast)+'};Host.prototype.mergeLatestWorkerVersions',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
 {vscode:{workspace:{getConfiguration:()=>config},Uri:{file:x=>x}},scopeInventoryPathAllowed,planLatestWorkerMerge,runSyncScopeBatch,loadSyncHolds:async()=>({}),isLocalCodeOwnedPath:()=>false,safeSyncPath:require('../../src/features/SyncResolution.ts').safeSyncPath,path,workerFpsyncTaskLabel:()=>'',UiCommandCancelled:Error,jobArtifactRunGeneration:require('../../src/features/JobArtifactSyncIdentity.ts').jobArtifactRunGeneration,isUnderMachineStatePrefixes:require('../../src/features/ProjectRootMap.ts').isUnderMachineStatePrefixes});
 // r46 A：最小队列提交成功尾复刻——真实 save 只在提交成功时发布最新 cache 并在锁外同步通知订阅者；
 // 失败/围栏路径不发布不通知（观察者绝不在提交内 await 载入，避免重入写锁）。
 const observers=new Set();
 h.distributedQueueCommitObservers=observers;
 const commit=()=>{h.distributedQueueCache=structuredClone(queue);for(const o of [...observers]){try{o(root);}catch{/* 观察者失败不影响提交 */}}};
 return {h,root,queue,jobs,inventory,transfers,reads,errors,nativeNotes,setLost:()=>lost=true,commit,run:(scope=['.'])=>new CompletedJobSyncHost(h,root,()=>true).run(scope)};
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
 assert.equal(g.nativeNotes.length,0,'r49：已证在途替换（outputRetiredAt 清退）经复核确认静默，不弹失败通知');
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

// r47 B：自动轮真实同步失败按既有同签名去重经原生通知恰一次；后台重试同故障、手动轮与正常轮全部静默。
test('automatic round surfaces a real sync failure once through the native notice; same-failure retries, manual runs and normal rounds stay quiet',async()=>{
 const f=fixture();f.setLost();await f.run();
 assert.equal(f.nativeNotes.length,1,'自动轮真实失败恰好一条原生错误通知');
 assert.equal(f.nativeNotes[0].tone,'error');
 assert.match(f.nativeNotes[0].message,/产物同步 plans\/p\.yaml job 0 未完成：transport response lost/,'完整真实原因+plan/job 标识');
 assert.match(f.nativeNotes[0].message,/运行完成状态不变，可在该 Job 行重新同步/,'明示完成状态不变并指向手动重试');
 f.setLost();f.jobs[0].latestArtifactSync.retryAfter='';await f.run();
 assert.equal(f.nativeNotes.length,1,'相同故障的后台重试不重复刷屏（同 key 同 error 签名去重）');
 assert.equal(f.jobs[0].latestArtifactSync.state,'partial');assert.ok(f.jobs[0].latestArtifactSync.retryAfter,'30s 自动恢复保留，未被通知改动');
 f.setLost();await new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,jobs:[{planId:'plan',index:0,commandId:'command0'}]});
 assert.equal(f.nativeNotes.length,1,'手动 force 轮走 withUiCommandStatus 唯一通知漏斗，Host 不再弹第二次');
 const g=fixture();await g.run();assert.deepEqual(g.nativeNotes,[],'正常自动轮全程静默');
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
// r5 P2 身份块：completedJob 链的 fpsync 必须携带真实 job 身份（既有 job-artifacts 五元组）与
// 绑定冻结源清单的稳定运行代；错误链此前落在 root 级 project-files 身份且不传 generation。
test("completed-job fpsync carries the real job identity: five-tuple retentionKey plus a run-bound stable generation", async () => {
 const f=fixture();await f.run();
 const expectedKey=JSON.stringify(["job-artifacts","plans/p.yaml",0,"case0",42]);
 assert.equal(f.transfers.length,2);
 assert.ok(f.transfers.every(p=>p.retentionKey===expectedKey),"每个批次共用该 job 的五元组身份，而不是 root 级 project-files");
 const generations=[...new Set(f.transfers.map(p=>p.generation))];
 assert.equal(generations.length,1,"同一冻结源清单的全部目标批次复用一个 generation");
 assert.match(generations[0],/^[0-9a-f]{64}$/);
 f.inventory.b["work_dirs/p/job0/model.pth"]={sha256:"b".repeat(64),size:3,modifiedAtMs:999};
 await new CompletedJobSyncHost(f.h,f.root,()=>true).run(["."],{force:true});
 assert.equal(f.transfers.length,3,"同输入轮对滞后目标发生真实传输");
 assert.equal([...new Set(f.transfers.map(p=>p.generation))].length,1,"相同输入的重试/重载复用自己的 generation");
 // 先造真实 delta（内容一致时 delta-only 同步不传输，属既有正确行为），再验证新派发身份开新代。
 f.inventory.b["work_dirs/p/job0/model.pth"]={sha256:"b".repeat(64),size:3,modifiedAtMs:999};
 f.jobs[0].commandId="command0-retry";
 await new CompletedJobSyncHost(f.h,f.root,()=>true).run(["."],{force:true,jobs:[{planId:"plan",index:0,commandId:"command0-retry"}]});
 const after=[...new Set(f.transfers.map(p=>p.generation))];
 assert.equal(after.length,2,"新的派发身份开启新 generation");
 assert.equal(after.includes(generations[0]),true,"旧代保持记录");
 assert.ok(after.find(g=>g!==generations[0]),"新代与旧代不同");
});
test("a changed source hash under the same command opens a new generation instead of reusing the frozen manifest", async () => {
 const f=fixture();await f.run();
 const before=f.transfers[0].generation;
 f.inventory.a["work_dirs/p/job0/model.pth"]={sha256:"c".repeat(64),size:3,modifiedAtMs:2};
 await new CompletedJobSyncHost(f.h,f.root,()=>true).run(["."],{force:true});
 const latest=f.transfers.at(-1);
 assert.notEqual(latest.generation,before,"源清单 SHA 变化必须开新代（即便 commandId 未变）");
 assert.ok(f.transfers.slice(2).every(p=>p.generation===latest.generation),"本轮源清单的全部批次共用新代");
});

// r46 A 红灯：排队等待期间自己的 Job 被本地清退/身份替换，必须及时结束等待者自身（UiCommandCancelled 既有取消通路），
// 不等无关 Job 的在途复制结束；不清/不动他人 active 传输、不写任何同步结果。当前 Host.run:23 无伴跑退出 ⇒ 本用例现为红。
test('a queued refresh/retry ends promptly when its own job is cleared or replaced during the wait, leaving the unrelated copy untouched', async () => {
 const Q=require('../../src/features/DistributedPlanQueue.ts');
 for(const scenario of ['cleared','replaced']){
  const f=fixture();
  f.inventory.a['work_dirs/p/job1/model.pth']={sha256:'f'.repeat(64),size:3,modifiedAtMs:1};
  f.inventory.a['work_dirs/p/job1/artifact_manifest.json']={sha256:'f'.repeat(64),size:3,modifiedAtMs:1};
  f.inventory.a['tmp/result/job1.csv']={sha256:'f'.repeat(64),size:3,modifiedAtMs:1};
  f.jobs[1].status='completed';
  let releaseGate,entered;const started=new Promise(r=>entered=r);
  const merge=f.h.mergeLatestWorkerVersions;
  f.h.mergeLatestWorkerVersions=async(...args)=>{entered();await new Promise(r=>releaseGate=r);return merge.call(f.h,...args);};
  // 无关 Job1 的正常复制挂住在传输阶段
  const active=new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{jobs:[{planId:'plan',index:1,commandId:'command1'}]});
  await started;
  const transfersAtEntry=f.transfers.length;
  // 同一目标 Job 的 retry 与 refresh 两个排队者（force 异 key，都在 active 后排队）
  const results=[];
  const retry=new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,jobs:[{planId:'plan',index:0,commandId:'command0'}]}).then(()=>results.push('retry:done'),e=>results.push(e));
  const refresh=new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,verifyOnly:true,jobs:[{planId:'plan',index:0,commandId:'command0'}]}).then(()=>results.push('refresh:done'),e=>results.push(e));
  await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  try{
   // 真实清退/身份替换经队列提交成功边界：removeConfirmedDistributedPlan 为生产纯函数；
   // commit() 复刻 save 成功尾——先发布最新 cache，再同步通知订阅者（锁外，观察者不 await 载入）。
   if(scenario==='cleared'){
    const plan=f.queue.plans[0];
    const next=Q.removeConfirmedDistributedPlan(f.queue,plan.planFile,{jobKeys:new Set([Q.distributedJobControlKey(plan,f.jobs[0])]),deferredIds:new Set(),projectId:Q.canonicalProjectId(f.root)});
    Object.assign(f.queue,next);
   }else f.jobs[0].commandId='command0-replaced';
   f.commit();
   await new Promise(r=>setTimeout(r,5));await new Promise(r=>setTimeout(r,5));
   assert.equal(results.length,2,scenario+'：两个等待者在无关复制放行前即结束');
   const {UiCommandCancelled}=require('../../src/core/UiCommandCancelled.ts');
   for(const outcome of results){
    assert.ok(outcome instanceof UiCommandCancelled,scenario+'：等待者以生产真实取消类型结束，不是普通失败');
    assert.equal(outcome.code,'SELECTED_JOB_CLEARED','精确身份失效标记，供 cancelled 静默收拢按类型识别');
    assert.match(outcome.message,/清退|替代/);assert.doesNotMatch(outcome.message,/任务未完成/,'不用宽泛"任务未完成"误导');
   }
   assert.equal(f.nativeNotes.length,0,'清退取消不得产生原生失败通知');
   assert.equal(f.transfers.length,transfersAtEntry,'排队等待期间对目标 Job 零 SFTP 派发');
   assert.equal(f.jobs[0].latestArtifactSync,undefined,'结束的清退等待不写任何同步结果');
   assert.deepEqual(f.errors,[],'取消结束不产生 partial 失败记录');
  }finally{
   releaseGate();await active.catch(()=>{});
   await Promise.all([retry,refresh]).catch(()=>{});
  }
  assert.equal(f.jobs[1].latestArtifactSync.state,'synced','无关复制不被清退取消打断，正常完成');
  assert.equal(f.inventory.b['work_dirs/p/job1/model.pth'].sha256,'f'.repeat(64),'无关复制字节与来源 SHA 一致');
  assert.equal(f.h.completedJobSyncRuns.size,0,'单飞登记最终清空');
  assert.equal(f.h.distributedQueueCommitObservers.size,0,'等待结束后观察订阅全部释放');
 }
});

// r49 返修 1：等待注册必须先接好 abort 拒绝通路，再订阅提交观察者与项目上下文中止，最后立即基于
// 已提交快照与当前上下文复核一次——预检 await 结束后、订阅挂上前的清退/中止不能丢唤醒；
// 上下文取消保留真实原因（工作区切换不谎称清退）；空选择请求时本地拒绝，不无界排在活动轮后。
function gateMerge(f){let release;const started=new Promise(r=>{const enter=f.h.mergeLatestWorkerVersions;
 f.h.mergeLatestWorkerVersions=async(...args)=>{r();await new Promise(res=>release=res);return enter.apply(f.h,args);};});
 return {started,release:()=>release()};}
// 与清退用例同一 job1 来源配方：无关复制轮的前提必须真实成立（缺来源会按既有保护如实 partial）。
function giveJob1Source(f){f.inventory.a['work_dirs/p/job1/model.pth']={sha256:'f'.repeat(64),size:3,modifiedAtMs:1};
 f.inventory.a['work_dirs/p/job1/artifact_manifest.json']={sha256:'f'.repeat(64),size:3,modifiedAtMs:1};
 f.inventory.a['tmp/result/job1.csv']={sha256:'f'.repeat(64),size:3,modifiedAtMs:1};}

test('a queue clear committed between the pre-check await and wait registration still ends the waiter promptly as a proven cancellation', async () => {
 const {UiCommandCancelled}=require('../../src/core/UiCommandCancelled.ts');
 const Q=require('../../src/features/DistributedPlanQueue.ts');
 const f=fixture();f.jobs[1].status='completed';giveJob1Source(f);
 const gate=gateMerge(f);
 const active=new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{jobs:[{planId:'plan',index:1,commandId:'command1'}]});
 await gate.started;
 // 复现载入/提交竞态窗口：等待者预检拿到旧快照（仍合格），返回前清退已真实提交并先发布新 cache。
 let armed=false,fired=false;const realLoad=f.h.loadDistributedQueue;
 f.h.loadDistributedQueue=async(...args)=>{const snapshot=await realLoad(...args);
  if(armed&&!fired){fired=true;const plan=f.queue.plans[0];
   Object.assign(f.queue,Q.removeConfirmedDistributedPlan(f.queue,plan.planFile,{jobKeys:new Set([Q.distributedJobControlKey(plan,f.jobs[0])]),deferredIds:new Set(),projectId:Q.canonicalProjectId(f.root)}));
   f.commit();}
  return snapshot;};
 armed=true;
 const waiter=new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,jobs:[{planId:'plan',index:0,commandId:'command0'}]}).catch(e=>e);
 try{
  const outcome=await Promise.race([waiter,new Promise(r=>setTimeout(()=>r('仍在排队等待'),20))]);
  assert.notEqual(outcome,'仍在排队等待','注册前已提交的清退绝不能丢唤醒、空等到在途轮结束');
  assert.ok(outcome instanceof UiCommandCancelled,'以生产真实取消类型结束');
  assert.equal(outcome.code,'SELECTED_JOB_CLEARED');
  assert.equal(f.nativeNotes.length,0,'清退取消不产生原生失败通知');
 }finally{gate.release();await active.catch(()=>{});await waiter;}
 assert.equal(f.h.distributedQueueCommitObservers.size,0);
 assert.equal(f.h.completedJobSyncRuns.size,0);
});

test('an aborted project context ends the waiter with its real reason, both when aborting during the wait and when already aborted at registration', async () => {
 const {UiCommandCancelled}=require('../../src/core/UiCommandCancelled.ts');
 for(const when of ['during','before']){
  const f=fixture();f.jobs[1].status='completed';giveJob1Source(f);
  const gate=gateMerge(f);
  const active=new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{jobs:[{planId:'plan',index:1,commandId:'command1'}]});
  await gate.started;
  f.h.projectContextAbortController=new AbortController();
  const reason=new UiCommandCancelled('工作区已切换，旧项目请求已取消。','WORKSPACE_SWITCHED');
  if(when==='before')f.h.projectContextAbortController.abort(reason);
  const waiter=new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,jobs:[{planId:'plan',index:0,commandId:'command0'}]}).catch(e=>e);
  if(when==='during'){await new Promise(r=>setImmediate(r));f.h.projectContextAbortController.abort(reason);}
  const outcome=await Promise.race([waiter,new Promise(r=>setTimeout(()=>r('仍在排队等待'),20))]);
  assert.notEqual(outcome,'仍在排队等待',when+'：项目上下文中止必须能结束等待');
  assert.ok(outcome instanceof UiCommandCancelled,when+'：以上下文真实取消原因结束');
  assert.equal(outcome.code,'WORKSPACE_SWITCHED',when+'：保留真实上下文取消原因');
  assert.match(outcome.message,/工作区已切换/);
  assert.doesNotMatch(outcome.message,/清退/,'工作区切换不得谎称任务被清退');
  assert.equal(f.nativeNotes.length,0);
  gate.release();await active.catch(()=>{});await waiter;
  assert.equal(f.h.distributedQueueCommitObservers.size,0,'等待结束后全部订阅释放');
  assert.equal(f.h.completedJobSyncRuns.size,0);
 }
});

test('an empty selection is rejected at request time and never queues behind the active round', async () => {
 const f=fixture();f.jobs[1].status='completed';giveJob1Source(f);
 const gate=gateMerge(f);
 const active=new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{jobs:[{planId:'plan',index:1,commandId:'command1'}]});
 await gate.started;
 const outcome=await Promise.race([new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,jobs:[]}).catch(e=>e),
  new Promise(r=>setTimeout(()=>r('仍在排队等待'),20))]);
 assert.notEqual(outcome,'仍在排队等待','空选择必须请求时本地拒绝，绝不无界排在在途轮后');
 assert.match(String(outcome.message),/所选任务未完成或身份已变化/);
 assert.equal(f.h.distributedQueueCommitObservers.size,0,'未进入等待通路，自然无残留订阅');
 gate.release();await active;
 assert.equal(f.jobs[1].latestArtifactSync.state,'synced','在途无关轮照常完成（来源真实，复制实际成功）');
 assert.equal(f.jobs[1].commandId,'command1');assert.equal(f.nativeNotes.length,0,'无关轮成功与空选择拒绝均零通知');
 assert.deepEqual(f.errors,[],'全程零失败记录');
});

// r49 返修 2：身份复核读不到队列＝"无法确认"，绝非已证清退——真实失败仍恰一次弹出，并如实附带复核失败原因。
test('a real automatic sync failure is still surfaced once when the identity re-check cannot read the queue, without rewriting completion state', async () => {
 const f=fixture();f.setLost();
 const realLoad=f.h.loadDistributedQueue,transfer=f.h.simpleSftpApiCall;let transferSeen=false;
 f.h.simpleSftpApiCall=async(...args)=>{transferSeen=true;return transfer(...args);};
 f.h.loadDistributedQueue=async(...args)=>{if(transferSeen)throw Error('queue storage unreachable');return realLoad(...args);};
 await f.run();
 assert.equal(f.nativeNotes.length,1,'复核不可用是未知而非已证清退，绝不吞掉真实失败通知');
 assert.match(f.nativeNotes[0].message,/transport response lost/,'完整真实故障原因保留');
 assert.match(f.nativeNotes[0].message,/队列复核暂不可用：queue storage unreachable/,'如实附带复核失败原因');
 assert.equal(f.jobs[0].status,'completed','执行完成状态不被改写');
 assert.equal(f.jobs[0].latestArtifactSync.state,'partial','partial 重试记录与 30s 自动恢复保留');
});

// 0.5.416 配套（se-stage-block-visibility-release）：暂存槽卡点的宿主透传。
// 契约：错误原文逐字保留（含 SFTP 追加的可读卡点后缀）；结构化 stageBlock（含 apiData 位置）
// 净化后随同一 patch 与文本同写同清；成功与"下一次无卡点失败"都不得留下过期释放入口。
const stageBlockShape=()=>({ schemaVersion:1, code:'TRANSFER_STAGE_PENDING',
 destination:{id:'b',profile:'work',host:'nwpu3.invalid'}, scope:JSON.stringify(['job-artifacts','plans/p.yaml',0,'case0',42]),
 lane:0, identity:'a'.repeat(64), incomingGeneration:'b'.repeat(64),
 slots:[{slot:'slot-0',path:'.staged-slots/'+'a'.repeat(64)+'/slot-0',generation:'c'.repeat(64),status:'committed',createdAt:1,terminalAt:2,updatedAt:3,
   timeSource:'journal-terminalAt',ageMs:172800000,locked:false,protectedReason:null,injected:'x'},
  {slot:'slot-1',path:'.staged-slots/'+'a'.repeat(64)+'/slot-1',generation:'d'.repeat(64),status:'running',createdAt:4,terminalAt:0,updatedAt:5,
   timeSource:null,ageMs:null,locked:true,protectedReason:'lock-held'}],
 releaseCandidate:true });
const stageBlockMessage='TRANSFER_STAGE_PENDING: 两代暂存槽均被同一来源的已提交代占用 · 暂存槽卡点：主机 nwpu3.invalid（profile work） · 范围 job-artifacts · 通道 0 · 身份 aaaaaaaaaaaa… · 待进入代 bbbbbbbbbbbb…';

test('staged-slot stage block: readable error kept verbatim, structured slots persisted with full host/scope/lane/two slots, unknown fields dropped',async()=>{
 const f=fixture();const original=f.h.simpleSftpApiCall;
 f.h.simpleSftpApiCall=async(...args)=>{await original(...args);const error=new Error(stageBlockMessage);error.stageBlock=stageBlockShape();throw error;};
 await f.run();const job=f.jobs[0];
 assert.equal(job.status,'completed','卡点绝不改写训练完成状态');
 assert.equal(job.latestArtifactSync.state,'partial');
 assert.match(job.artifactError,new RegExp('^最新产物同步未完成：'+stageBlockMessage.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'文本兼容：SFTP 可读卡点后缀逐字保留在 artifactError');
 assert.equal(job.artifactStageBlock.identity,'a'.repeat(64));
 assert.deepEqual(job.artifactStageBlock.destination,{id:'b',profile:'work',host:'nwpu3.invalid'},'主机/profile 全量持久化');
 assert.equal(job.artifactStageBlock.scope,JSON.stringify(['job-artifacts','plans/p.yaml',0,'case0',42]),'范围=调用方声明的稳定 scope，逐字保留');
 assert.equal(job.artifactStageBlock.slots.length,2,'两槽事实全部可见');
 assert.equal(job.artifactStageBlock.slots[0].path,'.staged-slots/'+'a'.repeat(64)+'/slot-0','后台释放绑定必须拿到完整路径');
 assert.equal(job.artifactStageBlock.slots[0].generation,'c'.repeat(64),'完整 64hex 代，不被缩写');
 assert.equal(job.artifactStageBlock.slots[1].locked,true);assert.equal(job.artifactStageBlock.slots[1].protectedReason,'lock-held');
 assert.equal(JSON.stringify(job.artifactStageBlock).includes('"injected"'),false,'白名单外字段不落队列文件');
 assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/TRANSFER_STAGE_PENDING/,'操作日志仍是原可读文本');
 // 成功重试：文本与卡点同一 patch 清除，释放入口不留残影。
 f.h.simpleSftpApiCall=original;f.jobs[0].latestArtifactSync.retryAfter='';
 await new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,jobs:[{planId:'plan',index:0,commandId:'command0'}]});
 assert.equal(job.artifactError,undefined);assert.equal(job.artifactStageBlock,undefined,'成功后卡点随错误一并清除');
 assert.equal(job.latestArtifactSync.state,'synced');
});

test('stage block also accepted from error.apiData, and a following blockless failure clears the stale block instead of keeping a stale release entry',async()=>{
 const f=fixture();const original=f.h.simpleSftpApiCall;
 f.h.simpleSftpApiCall=async(...args)=>{await original(...args);const error=new Error(stageBlockMessage);error.apiData={stageBlock:stageBlockShape()};throw error;};
 await f.run();assert.ok(f.jobs[0].artifactStageBlock,'apiData.stageBlock 位置同样透传');
 // 下一次失败无结构化字段：文本照常，旧卡点必须被同一次 patch 冲掉（防止对已消失候选保留按钮）。
 f.h.simpleSftpApiCall=async(...args)=>{await original(...args);throw Error('另一链路故障');};
 f.jobs[0].latestArtifactSync.retryAfter='';
 await new CompletedJobSyncHost(f.h,f.root,()=>true).run(['.'],{force:true,jobs:[{planId:'plan',index:0,commandId:'command0'}]});
 assert.equal(f.jobs[0].artifactStageBlock,undefined,'无卡点的新失败清掉旧卡点');
 assert.match(f.jobs[0].artifactError,/另一链路故障/);
 assert.equal(f.jobs[0].latestArtifactSync.state,'partial');
});
