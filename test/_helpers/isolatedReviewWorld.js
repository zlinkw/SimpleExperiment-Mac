const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict'),Module=require('node:module');
require('./registerTsRequire');
const ts=require('typescript'),Q=require('../../src/features/DistributedPlanQueue.ts'),L=require('../../src/features/PlanIsolatedBatchLedger.ts'),{cleanupDigest}=require('../../src/features/PlanCleanup.ts');
const clone=value=>JSON.parse(JSON.stringify(value));
function load(file,imports){const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const original=m.require.bind(m);m.require=name=>imports[name]||original(name);
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;}
async function world(options={}){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'isolated-review-main-')),storage=path.join(root,'storage'),ledger=path.join(storage,'batches.json');
 const originalId='1'.repeat(48),archiveBatch='job-'+'a'.repeat(48),destination='clean_dir/'+archiveBatch+'/work/p0',node={id:'local',kind:'local',root};
 const mkdir=rel=>fs.mkdirSync(path.join(root,rel),{recursive:true});mkdir('work/p0');mkdir(path.dirname(destination));
 fs.writeFileSync(path.join(root,'work/p0/marker.txt'),'OLD');fs.renameSync(path.join(root,'work/p0'),path.join(root,destination));
 mkdir('work/p0');mkdir('work/p1');fs.writeFileSync(path.join(root,'work/p0/marker.txt'),'NEW');fs.writeFileSync(path.join(root,'work/p1/marker.txt'),'SIBLING');
 const rootIdentity=()=>{const st=fs.statSync(root);return {path:fs.realpathSync(root),device:String(st.dev),inode:String(st.ino)};};
 function safeTarget(relative){assert.ok(relative&&!path.isAbsolute(relative)&&!relative.split('/').some(x=>!x||x==='.'||x==='..'));
  const target=path.resolve(root,relative),parent=fs.realpathSync(path.dirname(target));assert.ok(parent===root||parent.startsWith(root+path.sep));
  let st;try{st=fs.lstatSync(target);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(st.isSymbolicLink())throw Error('SYMLINK_TARGET');assert.equal(st.dev,fs.statSync(root).dev);return {target,parent,st};}
 function fingerprint(relative){const x=safeTarget(relative);if(!x)return null;const rows=[];
  function scan(p){const st=fs.lstatSync(p);if(st.isSymbolicLink())throw Error('SYMLINK_TARGET');if(st.isDirectory())for(const n of fs.readdirSync(p).sort())scan(path.join(p,n));else rows.push([path.relative(x.target,p),fs.readFileSync(p).toString('hex')]);}
  scan(x.target);return cleanupDigest([String(x.st.dev),String(x.st.ino),rows]);}
 function removeRegistered(relative){assert.equal(relative,destination);const x=safeTarget(relative);if(!x)return;const previous=process.cwd();
  process.chdir(x.parent);try{assert.equal(fs.realpathSync(process.cwd()),x.parent);fs.rmSync('./'+path.basename(x.target),{recursive:true});}finally{process.chdir(previous);}}
 const calls=[],backends=new Map(),stats={executions:0,queueWrites:0,leaseCalls:0};let busyPreview=false,busyExecute=false,unknownExecute=false,badRoot=false,hold,enterExecution;
 const executionEntered=new Promise(resolve=>enterExecution=resolve);
 function state(rec){const fp=fingerprint(rec.relative);return !fp?'completed':fp!==rec.fingerprint?'unknown':rec.unknown?'unknown':'pending';}
 function status(rec){const current=state(rec);return {...clone(rec),rootIdentity:rootIdentity(),batchExecuting:false,states:[current],
  observations:[{state:current,status:current==='completed'?'gone':'present',executorsChecked:true,executors:[]}],targets:clone(rec.targets)};}
 async function backend(method,params){calls.push({method,params:clone({...params,signal:undefined})});
  if(method==='files.cleanup.inspect'){const x=safeTarget(params.target.relativePath);return {ok:true,rootIdentity:badRoot?{path:root,inode:'changed'}:rootIdentity(),executorsChecked:true,executors:[],
   target:{...params.target,absolutePath:path.join(root,params.target.relativePath),missing:!x}};}
  if(method==='files.cleanup.preview'){
   if(hold)await hold; if(busyPreview)throw Object.assign(Error('OPERATION_BUSY'),{apiData:{code:'OPERATION_BUSY'}});
   assert.equal(params.action,'delete');assert.equal(params.authorizationMode,'confirmed_paths');assert.equal(params.observationMode,'managed_tmux');assert.deepEqual(params.node,node);
   assert.equal(params.targets.length,1);assert.equal(params.targets[0].relativePath,destination);
   const x=safeTarget(destination),token=crypto.randomBytes(24).toString('hex'),fp=fingerprint(destination);
   const targets=[{relativePath:destination,destination,type:'directory',absolutePath:path.join(root,destination),missing:!x,fingerprint:fp,
    device:x?String(x.st.dev):undefined,inode:x?String(x.st.ino):undefined,size:x?.st.size}];
   const rec={token,digest:cleanupDigest(targets),relative:destination,fingerprint:fp,confirmations:0,targets};backends.set(token,rec);
   return {...status(rec),rootIdentity:badRoot?{path:root,inode:'changed'}:rootIdentity(),safety:{confirmedPathDeletion:1,entryIdentityBind:1,batchedFastDelete:1,directoryTreeIsolateDelete:1,isolationRenameNoReplace:1,fastDeleteBatchLimit:5000,registeredIsolationDeletion:1,subtreeSingleWriter:options.noWriter?undefined:1}};
  }
  if(method==='files.cleanup.observeBatch')return {ok:true,observationId:params.observationId,rootIdentity:rootIdentity(),capabilities:{batchCleanupObservation:1},
   observations:params.targets.map(t=>{const x=safeTarget(t.relativePath),rec=backends.get(t.backendToken);return {key:t.key,relativePath:t.relativePath,type:t.type,
    status:x?'present':'gone',state:rec?state(rec):undefined,executorsChecked:true,executors:[],target:{relativePath:t.relativePath,type:t.type,missing:!x}};})};
  const rec=backends.get(params.token);assert.ok(rec,'request must bind the original preview token');
  if(method==='files.cleanup.status'||method==='files.cleanup.check')return status(rec);
  if(method==='files.cleanup.confirm'){assert.equal(params.digest,rec.digest);assert.equal(params.phase,rec.confirmations+1);assert.deepEqual(params.exactTargets,rec.targets.filter(t=>!t.missing).map(t=>t.absolutePath));rec.confirmations=params.phase;return status(rec);}
  if(method==='files.cleanup.verify')return status(rec);
  if(method==='files.cleanup.execute'){stats.executions++;enterExecution();if(hold)await hold;assert.equal(rec.confirmations,2);assert.equal(params.digest,rec.digest);
   assert.equal(fingerprint(destination),rec.fingerprint);if(busyExecute)throw Object.assign(Error('OPERATION_BUSY'),{apiData:{code:'OPERATION_BUSY'}});
   if(unknownExecute){rec.unknown=true;return {status:'unknown'};}removeRegistered(destination);return status(rec);}
  throw Error('UNEXPECTED_METHOD '+method);
 }
 let queue=Q.enqueuePlan(Q.emptyDistributedQueue(),{projectId:Q.canonicalProjectId(root),planFile:'p.yaml',revision:'r',codeFingerprint:'f',executionMode:'train',
  jobs:[0,1].map(index=>({index,case:'c'+index,seed:index,outputDir:'work/p'+index,collectionResultCsv:'work/p'+index+'/m.csv'}))},'p');
 queue=Q.enqueuePlan(queue,{projectId:Q.canonicalProjectId(root),planFile:'q.yaml',revision:'r',codeFingerprint:'f',executionMode:'train',jobs:[{index:0,case:'q',seed:0,outputDir:'work/q0',collectionResultCsv:'work/q0/m.csv'}]},'q');
 for(const plan of queue.plans)Object.assign(plan.jobs[0],{commandId:'new-'+plan.id,workerId:'local',status:'running'});
 const at=new Date().toISOString(),tasks=queue.plans.map(plan=>({commandId:plan.jobs[0].commandId,projectId:plan.projectId,outputDir:plan.jobs[0].outputDir,collectionResultCsv:plan.jobs[0].collectionResultCsv,
  observation:{lifecycleProtocol:2,commandId:plan.jobs[0].commandId,projectId:plan.projectId,workerId:'local',observedAt:at,tmux:{dead:false,phase:'running',windowId:'@'+plan.id,paneId:'%'+plan.id}}}));
 queue=Q.mergeDurableWorkerSnapshots(queue,[{workerId:'local',fetchedAt:at,generatedAt:at,queryComplete:true,capabilities:{taskLifecycle:2},tasks}],Q.canonicalProjectId(root));
 await L.freezeBatchScope(ledger,{batchId:'batch',projectRoot:root,canonicalProjectId:Q.canonicalProjectId(root)},[{planFile:'p.yaml',submissionOperationId:'submit-p'},{planFile:'q.yaml',submissionOperationId:'submit-q'}]);
 await L.attachIsolatedCleanup(ledger,{batchId:'batch'},{planFile:'p.yaml',submissionOperationId:'submit-p',revision:'r',codeFingerprint:'f',runReplacement:{completed:[originalId],previews:[{preview:{token:originalId,rows:[{disposition:'isolate',node,relativePath:'work/p0',destination,archiveBatch}]}}]}});
 for(const plan of queue.plans)await L.markPlanTerminal(ledger,{batchId:'batch'},{planFile:plan.planFile,submissionOperationId:'submit-'+plan.id,status:'committed',identity:{queuePlanId:plan.id,jobs:plan.jobs.map(j=>({jobIndex:j.index,expectedCommandId:j.commandId||''}))}});
 const observations=queue.plans.filter(p=>options.ready!==false||p.id==='p').map(p=>{const j=p.jobs[0];return {queuePlanId:p.id,projectId:p.projectId,jobIndex:0,commandId:j.commandId,workerId:j.workerId,status:'running',lastObservedAt:j.nativeStartProof.observedAt,source:j.nativeStartProof.source,windowSeen:true};});
 await L.promoteDispatchedPlans(ledger,root,observations);
 const scope={projectId:Q.canonicalProjectId(root),planKey:'p',planFile:'p.yaml',planHash:'r',revision:'r',runIds:['old'],nodes:[node],candidates:[],references:{},blockers:[],notices:[],authorizationMode:'confirmed_paths',observationMode:'managed_tmux',job:{workflowId:'old-p',index:0,commandId:'old',purpose:'replace_outputs'}};
 const row={id:'old-target',nodeId:'local',node,relativePath:'work/p0',destination,archiveBatch,type:'directory',category:'任务产物',owners:['p'],evidence:[],dependencies:[],absolutePath:path.join(root,'work/p0'),disposition:'isolate',rootIdentity:rootIdentity()};
 const original={id:originalId,state:'completed',preview:{token:originalId,digest:'original',action:'isolate',scope,rows:[row],blockers:[],confirmations:1,expiresAt:Date.now()+60000},targets:{'old-target':{state:'completed'}},pendingNodes:[],indexed:true,updatedAt:at};
 const opRoot=path.join(storage,'plan-cleanup',cleanupDigest(root));fs.mkdirSync(opRoot,{recursive:true});fs.writeFileSync(path.join(opRoot,originalId+'.json'),JSON.stringify(original));
 let bridge,dispose;const messages=[],infos=[];
 const panel={webview:{html:'',onDidReceiveMessage:f=>{bridge=f;return {dispose(){}};},postMessage:async value=>{messages.push(value);return true;}},onDidDispose:f=>{dispose=f;return {dispose(){}};}};
 const vscode={workspace:{workspaceFolders:[{uri:{fsPath:root}}],textDocuments:[]},window:{createWebviewPanel:()=>panel,showQuickPick:async items=>items[0],showInformationMessage:async value=>{infos.push(value);}},ViewColumn:{Active:1}};
 const panelModule=load(path.resolve(__dirname,'../../src/extension/PlanCleanupPanel.ts'),{vscode});
 const hostModule=load(path.resolve(__dirname,'../../src/extension/PlanCleanupHost.ts'),{vscode,'./PlanCleanupPanel':panelModule});
 const underlying={context:{globalStorageUri:{fsPath:storage}},isolatedReplacementLedgerFileLocal:()=>ledger,loadDistributedQueue:async()=>clone(queue),
  saveDistributedQueue:async()=>{stats.queueWrites++;throw Error('independent deletion must not write the queue');},simpleSftpApiCall:backend,postState(){},
  withHostOperationLease:async()=>{stats.leaseCalls++;throw Error('independent deletion must not lock the entire project');},
  assertArtifactSyncPathsIdle:(_root,paths)=>assert.ok(paths.every(p=>p===destination))};
 const makeHost=()=>new hostModule.PlanCleanupHost(underlying,root),host=makeHost();
 return {root,storage,ledger,node,destination,originalId,original,opRoot,queue,host,makeHost,underlying,calls,stats,backends,panel,messages,infos,executionEntered,
  send:async type=>{await bridge(type);return messages.at(-1);},dispose:async()=>{await dispose();},
  preview:()=>host.service.isolatedDeletePreview(originalId),
  approve:async preview=>{for(const phase of [1,2])await host.service.confirm({token:preview.token,digest:preview.digest,phase,confirm:true,exactTargets:preview.rows.filter(r=>r.disposition==='delete').map(r=>r.node.id+':'+r.absolutePath)});},
  audit:async()=> (await L.loadIsolatedBatchLedger(ledger))[0].reviews||[],
  setBusyPreview:v=>{busyPreview=v;},setBusyExecute:v=>{busyExecute=v;},setUnknownExecute:v=>{unknownExecute=v;},setBadRoot:v=>{badRoot=v;},
  setHold:p=>{hold=p;},finish:()=>{removeRegistered(destination);for(const rec of backends.values())rec.unknown=false;},
 };
}
module.exports={world};
