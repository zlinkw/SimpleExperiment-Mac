const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const source=fs.readFileSync(require('node:path').join(__dirname,'../../src/extension/legacy.ts'),'utf8');
const ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true),members=new Map();
function visit(n){if(ts.isMethodDeclaration(n))members.set(n.name.getText(ast),n.getText(ast));ts.forEachChild(n,visit);}visit(ast);
const terminal=row=>['completed','failed','stalled','cancelled'].includes(row?.status);
test('real Agent operation lookup consumes journal append deltas and detects rotation and incomplete writes',()=>{
 const result=require('node:child_process').spawnSync('python',['-B','-X','utf8',require('node:path').join(__dirname,'operationJournalIncremental.fixture.py')],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(result.status,0,result.stderr||result.stdout);assert.equal(JSON.parse(result.stdout).ok,true);
});
// 生产代码新增的模块级 helper 必须来自同一份 src，绝不在测试里手抄一份判定逻辑。
const helperStart=source.indexOf('function operationNoRecordResponseFromError');
const helperEnd=source.indexOf('function operationTerminal(value) {', helperStart);
const helpers=helperStart>=0&&helperEnd>helperStart?source.slice(helperStart,helperEnd):'';
assert.ok(helpers.includes('Worker Agent HTTP 404: ')&&helpers.includes('eventCount')&&helpers.includes('operationExpiryDedupeStillApplies'),'the authoritative no-record contract and the dedupe guard must stay in src');
function proto(names,globals={}){return vm.runInNewContext(ts.transpileModule(helpers+';class Host{'+names.map(n=>members.get(n)).join('\n')+'};Host.prototype', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{workspaceRoot:()=>'/project',errorMessage:e=>e.message||String(e),planSubmitProgress:{isLocal:r=>r.localSubmissionProgress===true},operationTerminal:terminal,resultStatus:r=>r?.status,stringFromRecord:(r,keys)=>keys.map(k=>r[k]).find(Boolean)||'',planCheckAccepted:r=>r.status==='completed',RunOperations_1:require('../../dist/features/RunOperations.js'),...globals});}
test('manual refresh queries real Workers and original pending operations, never the retired scheduler count',async()=>{
 const messages=[],calls=[];const p=proto(['manualSnapshot'],{vscode:{window:{showInformationMessage:t=>messages.push(t),showWarningMessage:t=>messages.push(t)}}});
 const h={projectContextGeneration:1,taskLifecycleProtocol:2,client:{getGpu:async()=>calls.push('gpu')},refreshLocalPlanMetadata:async()=>{},effectiveConnectionMode:()=> 'realtime',workerActionTargets:()=>[{id:'a'},{id:'b'}],
 readWorkerTaskSnapshot:async(id,o)=>{assert.equal(o.fresh,true);calls.push(id);return {queryComplete:true,tasks:[{},{}]};},refreshPendingWorkerOperations:async()=>{calls.push('operations');return{checked:2,errors:[],expired:[]};},postState(){},tickDistributedQueue:async()=>{},recordActionError(){}};
 await p.manualSnapshot.call(h);assert.deepEqual(calls.sort(),['a','b','gpu','operations']);assert.match(messages[0],/2\/2 台 Worker、4 个任务，核对 2 项原操作/);
});
test('stalled original validation is re-read, and its interrupted parent becomes continueable without resubmitting',async()=>{
 const id='validate-plan-original',parent='plan-submit-original',reads=[];
 const p=proto(['refreshPendingWorkerOperations','refreshOperationStatus']);
 const h={projectContextGeneration:1,client:{getWorkerOperation:async(w,op)=>{reads.push([w,op]);return {status:'completed',message:'校验通过'};}},workerActionTargets:()=>[{id:'w'}],
 localOperations:{[id]:{type:'validate-plan',workerId:'w',planFile:'p.yaml',status:'stalled',message:'Worker 未在 60s 内返回终态'},[parent]:{localSubmissionProgress:true,type:'run-plan',planFile:'p.yaml',status:'failed',message:'执行结果待确认 operationId='+id}},
 markLocalOperationsDirty(){},clearOperationStatusProbe(){},clearOperationWatchdog(){},postState(){}};
 h.refreshOperationStatus=p.refreshOperationStatus;const report=await p.refreshPendingWorkerOperations.call(h);
 assert.deepEqual(reads,[['w',id]]);assert.equal(report.checked,1);assert.equal(h.localOperations[id].status,'completed');
 assert.equal(h.localOperations[parent].status,'queued');assert.equal(h.localOperations[parent].outcomePending,false);assert.match(h.localOperations[parent].message,/尚未派发/);
});
test('query failure remains unknown, real validation rejection remains failed, and retired Worker operations are skipped',async()=>{
 const p=proto(['refreshPendingWorkerOperations','refreshOperationStatus']),h={projectContextGeneration:1,client:{getWorkerOperation:async(w,id)=>{if(id==='unknown')throw Error('offline');return{status:'failed',message:'真实校验错误'};}},workerActionTargets:()=>[{id:'w'}],
 localOperations:{unknown:{type:'validate-plan',workerId:'w',status:'outcome_pending',outcomePending:true},bad:{type:'validate-plan',workerId:'w',status:'running'},retired:{type:'validate-plan',workerId:'hub',status:'outcome_pending'},parent:{type:'run-plan',localSubmissionProgress:true,status:'failed',message:'执行结果待确认 operationId=bad'}},markLocalOperationsDirty(){},clearOperationStatusProbe(){},clearOperationWatchdog(){},postState(){}};
 h.refreshOperationStatus=p.refreshOperationStatus;const r=await p.refreshPendingWorkerOperations.call(h);assert.equal(r.errors.length,1);assert.equal(h.localOperations.unknown.status,'outcome_pending');assert.equal(h.localOperations.parent.status,'failed');assert.match(h.localOperations.parent.message,/真实校验错误/);
});
test('foreground inactivity never cancels a remote check or posts a replacement operation',async()=>{
 let idle,posts=0;const p=proto(['waitForOperationTerminalResult'],{ProgressInactivity:class{constructor(ms,cb){idle=cb;}update(){}dispose(){}},remoteActionPendingStatus:()=>true,sleep:async()=>idle(),operationLongRunningAction:()=>false,operationSubmissionAccepted:()=>false,UiCommandRemotePending:Error});
 const h={client:{postWorkerAction:async()=>posts++},localOperations:{check:{status:'running'}},assertActionAuthorityCurrent(){},operationManualWaitDelayMs:()=>1,refreshOperationStatus:async()=>false};
 await assert.rejects(p.waitForOperationTerminalResult.call(h,'validate-plan',{status:'accepted',operationId:'check'},'校验',45000,'w'),/执行结果待确认/);
 assert.equal(posts,0);assert.equal(h.localOperations.check.status,'outcome_pending');
});
test('inventory invalidation repeats only the read, never mutations or changed connections',async()=>{
 const p=proto(['simpleSftpApiCall','invalidateSimpleSftpCapabilityAfterFailure','invalidateSimpleSftpCapability'],{...require('../_helpers/nativeHostScope'),assertRetryRequestCurrent(){},sftpFileIndexQuery:()=>({paths:['output']}),callSftpWithProgress:async()=>({files:{}})});
 let reads=0;const h={client:{},projectFileObservationIndex:()=>({read:async(q,load)=>{if(++reads<3)throw Error('FILE_INDEX_INVALIDATED_DURING_READ');return load();}})};
 h.invalidateSimpleSftpCapabilityAfterFailure=p.invalidateSimpleSftpCapabilityAfterFailure;h.invalidateSimpleSftpCapability=p.invalidateSimpleSftpCapability;
 const value=await p.simpleSftpApiCall.call(h,'sync.projectInventory',{source:{id:'w'}});assert.equal(reads,3);assert.ok(value.files);
 reads=0;assert.ok((await p.simpleSftpApiCall.call(h,'files.cleanup.inspect',{})).files);assert.equal(reads,3);
 for(const method of ['files.cleanup.preview','files.cleanup.execute']){
  reads=0;await assert.rejects(p.simpleSftpApiCall.call(h,method,{}),/FILE_INDEX_INVALIDATED/);assert.equal(reads,1);
 }
 reads=0;h.projectFileObservationIndex=()=>({read:async()=>{reads++;h.client={};throw Error('FILE_INDEX_INVALIDATED_DURING_READ');}});
 await assert.rejects(p.simpleSftpApiCall.call(h,'sync.projectInventory',{}),/FILE_INDEX_INVALIDATED/);assert.equal(reads,1);
});
