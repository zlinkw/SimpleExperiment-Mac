const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
require('../_helpers/registerTsRequire');
const Q = require('../../src/features/DistributedPlanQueue.ts');
const R = require('../../src/features/PlanOutputReplacement.ts');
const {collectPlanCleanupEvidence} = require('../../src/features/PlanCleanupEvidence.ts');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cleared-output-'));
  const file = 'experiments/plans/comparison/concatenation.yaml';
  await fs.mkdir(path.join(root, 'experiments/plans/comparison'), {recursive:true});
  await fs.writeFile(path.join(root, file), 'mode: train_test\n# current revision\n', 'utf8');
  const projectId = Q.canonicalProjectId(root), now = new Date().toISOString();
  // Actual 0.5.302 cleared registration shape: no status or collectionResultCsv.
  const audit = {projectId, workflowId:'old-run', planFile:file, planRevision:'a'.repeat(64), codeFingerprint:'b'.repeat(64),
    experimentIndex:0, case:'concatenation_bus', seed:42, resultPathPolicy:'declared', globalJobId:'old-run:0',
    outputDir:'work_dirs/formal/concatenation/job0', workerId:'w', commandId:'original-command', runKey:'original-command', clearedAt:now};
  const task = {...audit, status:'completed', enqueuedAt:now, finishedAt:now, planJobCount:1, fullPlanJobCount:1,
    collectionResultCsv:'tmp/result/concatenation/job0.csv', executionMode:'train_test', mode:'train_test', durableAccepted:true};
  const snapshots = [{workerId:'w', generatedAt:now, fetchedAt:now, capabilities:{controlStateRetirement:1,durablePlanQueue:true,schemaVersion:1}, tasks:[task]}];
  const queue = {schemaVersion:1, plans:[], clearedJobs:[audit]};
  const declarations = [{index:0,case:audit.case,seed:42,output_dir:audit.outputDir,result_csv:task.collectionResultCsv}];
  return {root,file,projectId,queue,snapshots,task,audit,declarations};
}
test('cleared formal output ownership is available for replacement without restoring cards or changing audit bytes', async () => {
  const f = await fixture(), before = JSON.stringify(f.queue);
  const evidence = R.replacementEvidenceQueue(f.queue, f.snapshots, f.projectId);
  const groups = R.replacementJobGroups(evidence,f.file,f.declarations,f.projectId);
  assert.equal(groups[0][0].commandId,'original-command');
  assert.equal(JSON.stringify(f.queue),before);
  assert.deepEqual(Q.mergeDurableWorkerSnapshots(f.queue,f.snapshots,f.projectId).plans,[]);
  const input = {root:f.root,planFile:f.file,job:groups[0][0],queue:evidence,snapshots:f.snapshots,
    ledger:{schemaVersion:2,entries:{}},nodes:[{id:'w',kind:'remote',root:'/safe/project'}]};
  const scope = await collectPlanCleanupEvidence(input);
  assert.deepEqual(scope.blockers,[]);
  assert.deepEqual(scope.candidates.map(row=>row.relativePath).sort(),[f.audit.outputDir,f.task.collectionResultCsv].sort());
  assert.ok(scope.candidates.every(row=>row.expectedOwner.planRevision===f.audit.planRevision));
  // Current PLAN hash differs from the original owner; replacing it preserves both.
  assert.notEqual(scope.planHash,f.audit.planRevision);
  assert.equal(JSON.stringify(f.queue),before);
});
test('fresh full identity, terminal state and original declaration are required after history clear', async () => {
  for(const change of ['offline','stale','identity','revision','source','running','csv','attempt','project','capability','no-terminal-proof']) {
    const f=await fixture();
    if(change==='offline')f.snapshots[0].error='offline';
    if(change==='stale')f.snapshots[0].generatedAt='2000-01-01T00:00:00Z';
    if(change==='identity')f.task.globalJobId='other:0';
    if(change==='revision')f.task.planRevision='c'.repeat(64);
    if(change==='source')f.task.codeFingerprint='c'.repeat(64);
    if(change==='running')f.task.status='running';
    if(change==='csv')f.task.collectionResultCsv='tmp/result/other.csv';
    if(change==='attempt')f.task.outputDir+='/attempts/old';
    if(change==='project')f.task.projectId='other-project';
    if(change==='capability')f.snapshots[0].capabilities.durablePlanQueue=false;
    if(change==='no-terminal-proof')delete f.task.finishedAt;
    const evidence=R.replacementEvidenceQueue(f.queue,f.snapshots,f.projectId);
    assert.throws(()=>R.replacementJobGroups(evidence,f.file,f.declarations,f.projectId),undefined,change);
    assert.equal(f.queue.plans.length,0);
  }
});
test('replacement lifecycle is retained in cleared audit; partial cleanup blocks reuse and never recreates execution',async()=>{
  const f=await fixture(), selection={workflowId:'old-run',index:0,commandId:'original-command',purpose:'replace_outputs'};
  const record=R.replacementLifecycleJob(f.queue,selection);
  assert.equal(record,f.audit);
  record.outputRetiredAt='retired';record.cleanup={operationId:'partial-operation',state:'partial',pendingNodes:['w'],completedTargets:[]};
  const evidence=R.replacementEvidenceQueue(f.queue,f.snapshots,f.projectId);
  assert.throws(()=>R.replacementJobGroups(evidence,f.file,f.declarations,f.projectId),/partial-operation/);
  assert.equal(f.queue.plans.length,0);
  assert.equal(R.replacementLifecycleJob(f.queue,{...selection,commandId:'changed'}),undefined);
});
test('new history clears retain the full result binding and cleanup lifecycle',async()=>{
  const f=await fixture(),evidence=R.replacementEvidenceQueue(f.queue,f.snapshots,f.projectId),plan=evidence.plans[0],job=plan.jobs[0];
  job.outputRetiredAt='retired';job.cleanup={operationId:'cleanup',state:'deleted',pendingNodes:[],completedTargets:['w:/safe/job']};
  const cleared=Q.removeConfirmedDistributedPlan({...evidence,clearedJobs:[]},f.file,{jobKeys:new Set([Q.distributedJobControlKey(plan,job)]),deferredIds:new Set()});
  assert.equal(cleared.clearedJobs[0].collectionResultCsv,f.task.collectionResultCsv);
  assert.equal(cleared.clearedJobs[0].status,'completed');
  assert.equal(cleared.clearedJobs[0].cleanup.operationId,'cleanup');
  assert.equal(cleared.clearedJobs[0].outputRetiredAt,'retired');
  assert.equal(cleared.plans.length,0);
});

test('actual cleanup Host uses current file observations without requiring retired remote control state',async()=>{
  const f=await fixture(),storage=await fs.mkdtemp(path.join(os.tmpdir(),'cleared-output-host-'));
  const source=await fs.readFile(path.join(__dirname,'../../src/extension/PlanCleanupHost.ts'),'utf8');
  const ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true);
  const cls=ast.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='PlanCleanupHost');
  const C=require('../../src/features/PlanCleanup.ts'),ledger=require('../../src/features/PlanArtifactSync.ts');
  // 2026-10-23 行数门禁提取：collect() 的节点枚举/机器状态绑定来自 PlanCleanupNodeGuards 兄弟模块；
  // vm 只注入类文本无 import，须显式提供这些标识符（真实模块，非桩）。
  const G=require('../../src/extension/PlanCleanupNodeGuards.ts');
  const queuePath=Q.distributedQueuePath(storage,f.root);
  await fs.mkdir(path.dirname(queuePath),{recursive:true});await fs.writeFile(queuePath,JSON.stringify(f.queue),'utf8');
  const bytes=await fs.readFile(queuePath,'utf8'),events=[];
  const json=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='json');
  const Host=vm.runInNewContext(ts.transpileModule(json.getText(ast)+'\n'+cls.getText(ast).replace(/^export /,'')+';PlanCleanupHost;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
    {fs,path,...C,...Q,...R,...ledger,...G,managedNodesOf:G.managedNodes,machineStateForNodeOf:G.machineStateForNode,collectPlanCleanupEvidence,AbortSignal,vscode:{workspace:{workspaceFolders:[{uri:{fsPath:f.root}}],textDocuments:[]}}});
  let saved;
  const rootMaps = require('../../src/features/ProjectRootMap.ts');
  const guard = projectDir => rootMaps.machineStateGuard(rootMaps.resolveProjectRootMap({projectDir, installDir:'/private/plugin', stateDir:'/private/machine-state', machineStateDirs:['/private/worker-state']}));
  const host={localMachineStateGuard: guard, targetRootGuard: target => guard(target.remotePath), context:{globalStorageUri:{fsPath:storage}},setupConfig:{workerTunnels:[{id:'w'}]},
    client:{getWorkerTasks:async id=>{assert.equal(id,'w');events.push('tasks');return f.snapshots[0];}},
    workerCodeSyncTarget:worker=>({id:worker.id,host:'configured-host',port:30022,user:'configured-user',remotePath:'/safe/project'}),
    buildPlanRuntimeEvidenceState:()=>({operations:{
      own:{operationId:'plan-submit-current',status:'running',planFile:f.file},
      old:{operationId:'archive-worker-artifacts-failed-cleanup-old',status:'running'}
    }}),loadDistributedQueue:async()=>structuredClone(f.queue),
    hostOperationLease:{inspect:async options=>{assert.equal(options.excludeCurrent,true);return {records:[]};}},
    saveDistributedQueue:async(_,q)=>{saved=structuredClone(q);events.push('save');},postState(){},
    retireReplacedJobState:async()=>assert.fail('confirmed deletion must not wait for old remote control records'),
    withHostOperationLease:async(_,__,work)=>work()};
  const cleanup=new Host(host,f.root);
  const groups=await cleanup.replacementGroups(f.queue,f.file,f.declarations,f.projectId,'');
  const scope=await cleanup.collect(f.file,false,undefined,undefined,undefined,groups[0][0]);
  assert.deepEqual(Array.from(scope.blockers),[]);
  delete f.snapshots[0].capabilities.controlStateRetirement;
  assert.ok((await cleanup.collect(f.file,false,undefined,undefined,undefined,groups[0][0])).blockers.some(row=>row.code==='STATE_RETIREMENT_CAPABILITY_REQUIRED'));
  f.snapshots[0].capabilities.controlStateRetirement=1;
  f.snapshots[0].activeOperations=[{operationId:'live-archive',status:'running',payload:{outputDir:f.audit.outputDir}}];
  const busy=await cleanup.collect(f.file,false,undefined,undefined,undefined,groups[0][0]);
  assert.ok(busy.blockers.some(row=>row.code==='ACTIVE_OPERATION'&&row.detail==='live-archive'));
  delete f.snapshots[0].activeOperations;
  host.hostOperationLease.inspect=async()=>({records:[{leaseId:'live-upload',resources:[{server:'configured-host:30022',project:'/safe/project',target:'/safe/project/'+f.audit.outputDir}]}]});
  const transfer=await cleanup.collect(f.file,false,undefined,undefined,undefined,groups[0][0]);
  assert.ok(transfer.blockers.some(row=>row.code==='ACTIVE_OPERATION'&&row.detail==='live-upload'));
  host.hostOperationLease.inspect=async()=>({records:[{leaseId:'different-server',resources:[{server:'other-host:30022',project:'/safe/project',target:'/safe/project/'+f.audit.outputDir}]}]});
  assert.deepEqual(Array.from((await cleanup.collect(f.file,false,undefined,undefined,undefined,groups[0][0])).blockers),[]);
  host.hostOperationLease.inspect=async()=>({records:[]});
  assert.equal(await fs.readFile(queuePath,'utf8'),bytes);assert.equal(saved,undefined);
  assert.ok(scope.candidates.every(row=>!row.relativePath.includes('attempts')));
  const rows=scope.candidates.map((row,index)=>({...row,id:String(index),node:{id:'w'},absolutePath:'/safe/project/'+row.relativePath}));
  const operation={id:'confirmed-operation',pendingNodes:[],preview:{action:'delete',scope,rows},targets:Object.fromEntries(rows.map(row=>[row.id,{state:'completed'}]))};
  let applied=false;
  cleanup.service={registeredIsolationSource:async()=>undefined,status:async()=>{
      if(applied&&!operation.indexed){
        events.push('active-query');operation.state='completed';operation.retirementPendingNodes=[];
        for(const row of rows)operation.targets[row.id]={state:'completed',receipt:{source:'active_query',verifiedBy:'path_absence'}};
        await cleanup.updateIndexes(operation,false);operation.indexed=true;
      }return operation;
    },history:async()=>[],preflightConfirmed:async()=>events.push('preflight'),
    setStateRetirement:async()=>assert.fail('current file absence needs no old state acknowledgement'),
    execute:async()=>{events.push('delete');assert.equal(saved.plans.length,0);assert.equal(saved.clearedJobs[0].cleanup.state,'partial');
      applied=true;host.loadDistributedQueue=async()=>structuredClone(saved);return {state:'completed'};}};
  await cleanup.execute(operation.id);
  assert.ok(events.indexOf('save')<events.indexOf('delete'));
  assert.ok(events.indexOf('delete')<events.indexOf('active-query'));
  const callsAfterComplete=events.length;await cleanup.execute(operation.id);assert.equal(events.length,callsAfterComplete);
  assert.equal(saved.plans.length,0);assert.equal(saved.clearedJobs[0].cleanup.state,'deleted');
  assert.equal(saved.clearedJobs[0].commandId,f.audit.commandId);assert.equal(saved.clearedJobs[0].planRevision,f.audit.planRevision);
  assert.ok(saved.clearedJobs[0].outputRetiredAt);assert.equal(await fs.readFile(queuePath,'utf8'),bytes);
});
