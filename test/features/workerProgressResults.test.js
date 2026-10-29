const test=require('node:test'),assert=require('node:assert/strict');
require('../_helpers/registerTsRequire');
const {queryWorkerProgress}=require('../../src/features/WorkerProgressQuery.ts');
test('low traffic tracks 72 live jobs without background artifact/log reads, then verifies a real exit',async()=>{
 const tasks=Array.from({length:72},(_,i)=>({commandId:'c'+i,projectId:'p',workerId:'w',outputDir:'work/'+i,
  observation:{lifecycleProtocol:2,commandId:'c'+i,projectId:'p',workerId:'w',tmux:{dead:false,phase:'running',windowId:'@'+i,paneId:'%'+i}}}));
 let calls=0;const client={getWorkerTasks:async(_worker,options)=>{calls++;return {resultsOnly:true,queryComplete:true,capabilities:{taskLifecycle:2},tasks:options.queries.map(q=>({...q,observation:{lifecycleProtocol:2,commandId:q.commandId,projectId:'p',workerId:'w',result:{runId:q.commandId,status:'completed',present:true,verified:true,identityMatches:true,artifactsComplete:true},runtimeDiagnostics:{schemaVersion:1,commandId:q.commandId,runId:q.commandId,state:'clear',count:0,scanComplete:true}}}))};}};
 const execution={queryComplete:true,capabilities:{taskLifecycle:2},tasks};
 const running=await queryWorkerProgress(client,'w',tasks,execution,{terminalOnly:true});
 assert.equal(calls,0);assert.equal(running.tasks.length,72);assert.equal(running.executionOnly,true);
 assert.equal(running.resultQueryError,undefined,'deferral is not a failed read');
 tasks[0].observation.tmux={...tasks[0].observation.tmux,dead:true,exitCode:0};
 const ended=await queryWorkerProgress(client,'w',tasks,execution,{terminalOnly:true});
 assert.equal(calls,1);assert.equal(ended.tasks[0].status,'completed');assert.equal(ended.tasks[0].completionState,'verified');
 await queryWorkerProgress(client,'w',tasks.slice(1,3),{...execution,tasks:tasks.slice(1,3)});
 assert.equal(calls,2,'explicit detail refresh still checks running tasks');
});
test('result and launch declaration queries avoid all historical task work',()=>{
 const path=require('node:path');const r=require('node:child_process').spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',path.join(__dirname,'lightweightResultQueries.fixture.py'),path.join(__dirname,'../../src/runtime/TmuxTaskLifecycle.ts')],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(r.status,0,r.stderr||r.stdout);
});

test('one blocked NFS log read cannot hold the parser lock for other jobs',()=>{
 const path=require('node:path');const r=require('node:child_process').spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',path.join(__dirname,'logReadIsolation.fixture.py'),path.join(__dirname,'../../src/runtime/RuntimeLogDiagnostics.ts')],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(r.status,0,r.stderr||r.stdout);
});

test('ended native panes do not lock code merely because their result status is unknown',async()=>{
 const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
 const source=fs.readFileSync('src/extension/legacy.ts','utf8'),ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true);let method;
 function visit(node){if(ts.isMethodDeclaration(node)&&node.name.getText(ast)==='safeWorkerCodeSyncTargets')method=node;ts.forEachChild(node,visit);}visit(ast);
 const fn=vm.runInNewContext(ts.transpileModule('class H{'+method.getText(ast)+'};H.prototype.safeWorkerCodeSyncTargets',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{workspaceRoot:()=>'/project',mapLimited:(rows,n,fn)=>Promise.all(rows.map(fn)),UiCommandCancelled:class extends Error{},DistributedPlanQueue:{canonicalProjectId:()=> 'project',mergeDurableWorkerSnapshots:()=>({}),hasFreshDurableSnapshot:()=>true,workerCodeVersionAvailable:()=>true}});
 const task={lifecycleProtocol:2,codeFingerprint:'old',status:'unknown',observation:{tmux:{dead:true}}},target={role:'worker',id:'w'};
 const host={client:{},readWorkerTaskSnapshot:async()=>({workerId:'w',tasks:[task]}),loadDistributedQueue:async()=>({plans:[]}),projectTopologyAssessment:()=>({mode:'single_worker'})};
 assert.equal((await fn.call(host,[target],'/project','new','workers')).length,1);
 task.observation.tmux.dead=false;
 await assert.rejects(fn.call(host,[target],'/project','new','workers'),/未覆盖运行中代码/);
});

test('results-only metadata combines with actual execution and cannot override a nonzero exit',async()=>{
 const q={commandId:'c',projectId:'p',workerId:'w',outputDir:'work/c'};
 const read={...q,observation:{lifecycleProtocol:2,commandId:'c',projectId:'p',workerId:'w',result:{runId:'c',status:'completed',present:true,verified:true,artifactsComplete:true},runtimeDiagnostics:{schemaVersion:1,commandId:'c',runId:'c',state:'clear',count:0,scanComplete:true}}};
 const client={getWorkerTasks:async()=>({resultsOnly:true,queryComplete:true,capabilities:{taskLifecycle:2},tasks:[read]})};
 for(const exitCode of [0,7]){
  const task={...q,observation:{lifecycleProtocol:2,commandId:'c',projectId:'p',workerId:'w',tmux:{dead:true,exitCode,phase:'running',windowId:'@1',paneId:'%1'}}};
  const result=await queryWorkerProgress(client,'w',[q],{queryComplete:true,capabilities:{taskLifecycle:2},tasks:[task]});
  assert.equal(result.tasks[0].status,exitCode===0?'completed':'failed');assert.equal(result.tasks[0].exitCode,exitCode);
  assert.equal(result.controlIncomplete,true,'result observations cannot authorize launch without cleanup-window checks');
 }
});
test('result observation uses the bounded normal pool, leaving execution/stop emergency slots available',async()=>{
 const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
 const source=fs.readFileSync('src/tunnel/TunnelClient.legacy.ts','utf8'),ast=ts.createSourceFile('client.ts',source,ts.ScriptTarget.Latest,true);let method;
 function visit(node){if(ts.isMethodDeclaration(node)&&node.name.getText(ast)==='getWorkerTasks')method=node;ts.forEachChild(node,visit);}visit(ast);assert.ok(method);
 const fn=vm.runInNewContext(ts.transpileModule('class C{'+method.getText(ast)+'};C.prototype.getWorkerTasks',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{});
 const purposes=[],paths=[],host={requestJson:async(_path,purpose,body)=>{paths.push(_path);purposes.push(purpose);return body;}};
 const body=await fn.call(host,{selectedOnly:true,observationOnly:true,queries:[{commandId:'c'}]});assert.equal(body.observationOnly,true);
 await fn.call(host,{executionOnly:true});
 const launch=await fn.call(host,{declarationOnly:true,declarations:[]});assert.equal(launch.declarationOnly,true);
 assert.deepEqual(purposes,['manual_refresh','job_reconcile','manual_refresh']);
 await fn.call(host,{selectedOnly:true,observationOnly:true,diagnosticsOnly:true,queries:[{commandId:'c'}]});
 assert.equal(paths.at(-1),'/api/worker/tasks/diagnostics');
});
test('valid synchronized copies remain complete without reading weight contents',()=>{
 const path=require('node:path');const r=require('node:child_process').spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',path.join(__dirname,'portableManifest.fixture.py'),path.join(__dirname,'../../src/runtime/TmuxTaskLifecycle.ts')],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(r.status,0,r.stderr||r.stdout);
});
test('one failed result read cannot discard completed jobs or execution evidence',async()=>{
 const tasks=Array.from({length:6},(_,i)=>({commandId:'c'+i,projectId:'p',workerId:'w',outputDir:'work/'+i,observation:{lifecycleProtocol:2,commandId:'c'+i,projectId:'p',workerId:'w',tmux:{dead:true,exitCode:0,phase:'running'}}}));
 const execution={executionOnly:true,queryComplete:true,fetchedAt:'2026-10-16T00:00:00Z',capabilities:{taskLifecycle:2},tasks},published=[];
 let active=0,max=0;
 const client={getWorkerTasks:async(_,o)=>{assert.equal(o.selectedOnly,true);assert.equal(o.observationOnly,true);assert.ok(o.queries.length<=4);max=Math.max(max,++active);await new Promise(setImmediate);active--;return {queryComplete:true,capabilities:{taskLifecycle:2},cleanupExecutors:[],tasks:o.queries.map(task=>task.commandId==='c2'?{...task,observation:{...task.observation,queryError:'result offline'}}:{...task,status:'completed',observation:{...task.observation,result:{runId:task.commandId,present:true,verified:true,artifactsComplete:true,status:'completed'}}})};}};
 const result=await queryWorkerProgress(client,'w',tasks,execution,{onSnapshot:s=>published.push(s)});
 assert.ok(max<=4);assert.equal(result.tasks.filter(t=>t.status==='completed').length,5);
 assert.equal(result.tasks[2].observation.tmux.exitCode,0);assert.match(result.tasks[2].observation.resultQueryError,/result offline/);
 assert.equal(result.tasks[2].observation.result,undefined);assert.ok(published.length>=2);
 assert.equal(result.executionOnly,true,'partial observations cannot authorize launch/cleanup checks');
 assert.equal(result.fetchedAt,execution.fetchedAt,'result waits must not relabel older execution observations as newly received');
});
test('all selected current results finish without requiring other Workers or synchronization receipts',async()=>{
 const t={commandId:'c',projectId:'p',workerId:'w',outputDir:'work/c'};
 const result=await queryWorkerProgress({getWorkerTasks:async()=>({queryComplete:true,capabilities:{taskLifecycle:2},cleanupExecutors:[],tasks:[{...t,status:'completed',observation:{result:{runId:'c',present:true,verified:true}}}]})},'w',[t],{tasks:[],capabilities:{taskLifecycle:2},queryComplete:true},{onSnapshot(){}});
 assert.equal(result.tasks[0].status,'completed');assert.equal(result.executionOnly,undefined);
});

test('timeout preserves already verified results and rotates past slow jobs on the next round',async()=>{
 const tasks=Array.from({length:24},(_,i)=>({commandId:'c'+i,projectId:'p',workerId:'w',outputDir:'work/'+i}));
 const seen=[];let resolveLate;const blocked=new Promise(resolve=>{resolveLate=resolve;});
 const client={getWorkerTasks:async(_,o)=>{const t=o.queries[0];seen.push(t.commandId);if(t.commandId!=='c4')return blocked;return {queryComplete:true,capabilities:{taskLifecycle:2},cleanupExecutors:[],tasks:o.queries.map(t=>({...t,status:'completed'}))};}};
 const controller=new AbortController(),published=[];
 const pending=queryWorkerProgress(client,'w',tasks,{tasks,capabilities:{taskLifecycle:2},queryComplete:true},{signal:controller.signal,onSnapshot:s=>published.push(s)});
 await new Promise(setImmediate);controller.abort(Object.assign(Error('bounded result wait'),{code:'TASK_QUERY_TIMEOUT'}));
 const result=await pending;assert.equal(result.tasks.find(t=>t.commandId==='c4').status,'completed');
 const length=published.length;resolveLate({queryComplete:true,tasks:[]});await new Promise(setImmediate);assert.equal(published.length,length,'late reads cannot overwrite the next snapshot');
 const old=seen.length,c2=new AbortController();const second=queryWorkerProgress(client,'w',tasks,{tasks,capabilities:{taskLifecycle:2},queryComplete:true},{signal:c2.signal});
 await new Promise(setImmediate);c2.abort(Object.assign(Error('bounded result wait'),{code:'TASK_QUERY_TIMEOUT'}));await second;
 assert.equal(seen[old],'c20','the same slow first jobs cannot starve later results');
});

test('43 current jobs use at most 11 bounded result requests, rather than one round trip per job',async()=>{
 const tasks=Array.from({length:43},(_,i)=>({commandId:'c'+i,projectId:'p',workerId:'w',outputDir:'work/'+i}));let reads=0;
 const client={getWorkerTasks:async(_,o)=>{reads++;assert.ok(o.queries.length<=4);return {queryComplete:true,capabilities:{taskLifecycle:2},cleanupExecutors:[],tasks:o.queries.map(t=>({...t,status:'completed'}))};}};
 const result=await queryWorkerProgress(client,'w',tasks,{tasks,capabilities:{taskLifecycle:2},queryComplete:true});
 assert.equal(reads,11);assert.equal(result.tasks.filter(t=>t.status==='completed').length,43);
});

test('blocked log analysis cannot erase already verified artifacts from any job',async()=>{
 const tasks=Array.from({length:6},(_,i)=>({commandId:'c'+i,projectId:'p',workerId:'w',outputDir:'work/'+i,observation:{lifecycleProtocol:2,commandId:'c'+i,projectId:'p',workerId:'w',tmux:{dead:true,exitCode:0,phase:'running'}}}));
 const controller=new AbortController(),requests=[],published=[];let release;
 const slow=new Promise(resolve=>{release=resolve;});
 const client={getWorkerTasks:async(_,options)=>{requests.push(options);if(options.diagnosticsOnly)return slow;return {metadataOnly:true,resultsOnly:true,queryComplete:true,capabilities:{taskLifecycle:2},tasks:options.queries.map(t=>({...t,observation:{lifecycleProtocol:2,commandId:t.commandId,projectId:'p',workerId:'w',result:{runId:t.commandId,status:'completed',present:true,verified:true,identityMatches:true,artifactsComplete:true}}}))};}};
 const pending=queryWorkerProgress(client,'w',tasks,{queryComplete:true,capabilities:{taskLifecycle:2},tasks},{signal:controller.signal,onSnapshot:s=>published.push(s)});
 await new Promise(setImmediate);
 assert.ok(requests.some(o=>o.diagnosticsOnly),'logs must use a distinct request phase');
 assert.equal(published.at(-1).tasks.filter(t=>t.resultState==='complete').length,6);
 controller.abort(Object.assign(Error('log wait expired'),{code:'TASK_QUERY_TIMEOUT'}));
 const result=await pending;
 assert.equal(result.tasks.filter(t=>t.status==='completed'&&t.resultState==='complete').length,6);
 assert.ok(result.tasks.every(t=>t.completionState==='unverified'));
 assert.equal(result.executionOnly,undefined);assert.match(result.runtimeQueryError,/log/);
 const count=published.length;release({queryComplete:true,tasks:[]});await new Promise(setImmediate);assert.equal(published.length,count);
});

test('separate log reads preserve per-job errors, explicit nonzero exits and anomaly review',async()=>{
 const tasks=Array.from({length:4},(_,i)=>({commandId:'c'+i,projectId:'p',workerId:'w',outputDir:'work/'+i,observation:{lifecycleProtocol:2,commandId:'c'+i,projectId:'p',workerId:'w',tmux:{dead:true,exitCode:i===3?7:0,phase:'running'}}}));
 const client={getWorkerTasks:async(_,o)=>({queryComplete:true,resultsOnly:true,metadataOnly:!o.diagnosticsOnly,capabilities:{taskLifecycle:2},tasks:o.queries.map(t=>({...t,observation:o.diagnosticsOnly?(t.commandId==='c1'?{runtimeQueryError:'one log offline'}:{runtimeDiagnostics:{schemaVersion:1,commandId:t.commandId,runId:t.commandId,scanComplete:true,state:t.commandId==='c2'?'anomalous':'clear',count:t.commandId==='c2'?1:0}}):{lifecycleProtocol:2,commandId:t.commandId,projectId:'p',workerId:'w',result:{runId:t.commandId,status:'completed',present:true,verified:true,artifactsComplete:true}}}))})};
 const result=await queryWorkerProgress(client,'w',tasks,{queryComplete:true,tasks,capabilities:{taskLifecycle:2}});
 assert.ok(result.tasks.every(t=>t.resultState==='complete'));
 assert.deepEqual(result.tasks.map(t=>t.completionState),['verified','unverified','review_required','verified']);
 assert.deepEqual(result.tasks.map(t=>t.status),['completed','completed','completed','failed']);
 assert.equal(result.tasks[3].exitCode,7);assert.match(result.tasks[1].runtimeDiagnostics.reason,/offline/);
 assert.equal(result.tasks[0].successful,true);assert.equal(result.tasks[2].successful,false);
});
