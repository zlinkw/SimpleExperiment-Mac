const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = 'C:/project';
const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/legacy.ts'), 'utf8');
const original = require.extensions['.ts'];
require.extensions['.ts'] = (loaded, filename) => loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const queueApi = require('../../src/features/DistributedPlanQueue.ts');
require.extensions['.ts'] = original;

function provider(names, extra = {}) {
  const ast = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'RealtimeTunnelPanelProvider');
  const code = 'class Provider {' + cls.members.filter((node) => names.includes(node.name?.getText(ast))).map((node) => node.getText(ast)).join('\n') + '}; Provider;';
  return vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { ...require('../_helpers/nativeHostScope'), DistributedPlanQueue: queueApi, workspaceRoot: () => root, makeOpId: (kind) => `${kind}-12345678`,
      errorMessage: (error) => error.message, vscode: { window: { showInformationMessage: () => undefined, showWarningMessage: async()=> "确认召回" } }, ...extra });
}
function snapshot(plan, job, status = 'queued', aliases = false, extra = {}) {
  const now = new Date().toISOString();
  return { workerId: job.workerId, generatedAt: now, fetchedAt: now,
    capabilities: { durablePlanQueue: true, queuedJobRecall: true, schemaVersion: 1 }, tasks: [{
      ...(aliases ? { commandId: job.commandId, planId: plan.id, plan: plan.planFile, caseName: job.case }
        : { projectId: plan.projectId, workflowId: plan.id, planFile: plan.planFile, planRevision: plan.revision,
          codeFingerprint: plan.codeFingerprint, planJobCount: plan.planJobCount, experimentIndex: job.index,
          runKey: job.runKey || job.commandId, case: job.case }),
      seed: job.seed, attempt: job.attempt, outputDir: job.outputDir, workerId: job.workerId,
      ...(plan.resultPathPolicy === 'declared' ? { resultPathPolicy: 'declared', globalJobId: job.globalJobId,
        collectionResultCsv: job.collectionResultCsv } : {}),
      commandId: job.commandId, gpuId: job.gpuId, status, ...extra,
    }] };
}
function releaseReceipt(request, legacy = false) {
  return { ...request, status: 'cancelled', stopReason: 'requeue', durableReleased: true,
    durableAccepted: !legacy, legacyReleased: legacy, neverStarted: true,
    neverStartedEvidence: legacy ? 'worker_command_queued' : 'durable_queued_row' };
}
function providerState(stored, compatibility = true, globals = {}) {
  // Existing durable v1 queue receipts remain readable; new v2 recall is separately fenced below.
  if (compatibility) for (const plan of stored.value.plans) for (const job of plan.jobs) delete job.lifecycleProtocol;
  const Provider = provider(['recallPlanToLocalQueueFromUi', 'processDistributedRecall'],globals);
  const instance = new Provider();
  instance.captureProjectContext = () => ({ root });
  instance.projectContextIsCurrent = context => context.root === root;
  instance.distributedQueueGeneration = 0;
  const context={root};instance.captureProjectContext=()=>context;instance.projectContextIsCurrent=value=>value===context;
  instance.distributedRecallInFlight = new Set();
  instance.distributedQueueTickPromise = undefined;
  instance.distributedTickAbort = undefined;
  instance.detachStaleDistributedTick = () => undefined;
  instance.postState = () => undefined;
  instance.captureProjectContext = () => ({root});
  instance.projectContextIsCurrent = context => context.root === root;
  instance.tickDistributedQueue = async () => undefined;
  instance.loadDistributedQueue = async () => structuredClone(stored.value);
  instance.saveDistributedQueue = async (_root, next) => { stored.value = structuredClone(next); };
  instance.withRemoteActionResource = async (_worker, _action, _request, action) => action();
  return instance;
}

// 085 repair: these .403 native-recall tests need the lifecycleProtocol-2 stamp that the
// merged queue applies, so they opt out of the durable-v1 compatibility strip (compat=false),
// matching the Mac native-recall test that already passes compat=false. No assertion changed.
test('lost stop ACK preserves native recall intent; restart settles only from an active exact query',async()=>{
  const at=new Date().toISOString();
  const queue=queueApi.enqueuePlan(queueApi.emptyDistributedQueue(),{projectId:queueApi.canonicalProjectId(root),schedulingMode:'server_prequeue',
    planFile:'plans/recall.yaml',revision:'r1',codeFingerprint:'f1',jobs:[0,1].map(index=>({index,case:'case-'+index,seed:40+index,outputDir:'runs/'+index,collectionResultCsv:'tmp/result/'+index+'.csv'}))},'plan-recall',at);
  const plan=queue.plans[0],job=plan.jobs[0];
  Object.assign(job,{status:'queued',workerId:'worker-a',commandId:'target-command-0001',gpuId:'0'});
  Object.assign(plan.jobs[1],{status:'running',workerId:'worker-a',commandId:'running-command-0002',gpuId:'1'});
  const sibling=structuredClone(plan.jobs[1]),stored={value:queue},p=providerState(stored, false),calls=[];
  p.client={postWorkerAction:async(_w,_a,request)=>{calls.push(request);throw Error('lost ACK');},
    getWorkerTasks:async()=>{throw Error('active query unavailable');}};
  await assert.rejects(p.recallPlanToLocalQueueFromUi({planId:plan.id,planFile:plan.planFile,jobIndex:0}),/active query unavailable/);
  assert.equal(stored.value.plans[0].jobs[0].recallRequested,true);
  const operationId=stored.value.plans[0].jobs[0].recallOperationId;assert.ok(operationId);
  assert.equal(stored.value.plans[0].jobs[0].commandId,job.commandId);
  assert.deepEqual(stored.value.plans[0].jobs[1],sibling);
  const resumed=providerState(stored, false);
  resumed.client={postWorkerAction:async(_w,_a,request)=>{calls.push(request);throw Error('lost ACK again');},
    getWorkerTasks:async()=>({capabilities:{taskLifecycle:2},queryComplete:true,tasks:[{observation:{lifecycleProtocol:2,commandId:job.commandId,
      projectId:plan.projectId,workerId:job.workerId,observedAt:new Date().toISOString(),cancelled:true,tmux:null,result:null}}]})};
  await resumed.processDistributedRecall(root,plan.id,0,0);
  const released=stored.value.plans[0].jobs[0];
  assert.equal(calls.length,2);assert.equal(calls[1].operationId,operationId);assert.equal(calls[1].targetCommandId,job.commandId);
  assert.equal(released.status,'pending');assert.equal(released.attempt,0);assert.equal(released.commandId,undefined);
  assert.ok(released.nextCommandId);assert.equal(released.outputDir,job.outputDir);
  assert.deepEqual(stored.value.plans[0].jobs[1],sibling);
});
test('historical queued release with a lost ACK retains durable intent and restart replays the same operation id', async () => {
  const stamp = new Date().toISOString();
  let queue = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), { projectId: queueApi.canonicalProjectId(root),
    schedulingMode: 'server_prequeue', planFile: 'plans/recall.yaml', revision: 'r1', codeFingerprint: 'f1',
    jobs: [0, 1].map((index) => ({ index, case: `case-${index}`, seed: 40 + index,
      outputDir: `runs/${index}`, collectionResultCsv: `tmp/result/${index}/metrics.csv` })) }, 'plan-recall', stamp);
  const plan = queue.plans[0];
  for (const job of plan.jobs) delete job.lifecycleProtocol; // Retained pre-protocol2 queue, never a newly admitted native task.
  const [queued, running] = plan.jobs;
  Object.assign(queued, { status: 'queued', workerId: 'worker-a', commandId: 'target-command-0001', runKey: 'target-command-0001', gpuId: '' });
  Object.assign(running, { status: 'running', workerId: 'worker-a', commandId: 'running-command-0002', runKey: 'running-command-0002', gpuId: '0' });
  const stored = { value: queue };
  const p = providerState(stored);
  p.tickDistributedQueue = async () => p.processDistributedRecall(root, plan.id, queued.index, p.distributedQueueGeneration);
  let calls = [];
  p.readWorkerTaskSnapshot = async () => snapshot(plan, queued);
  p.client = { postWorkerAction: async (_worker, _action, request) => { calls.push(request); throw new Error('lost ACK'); } };
  await p.recallPlanToLocalQueueFromUi({ planId: plan.id, planFile: plan.planFile });
  let persisted = stored.value.plans[0];
  const operationId = persisted.jobs[0].recallOperationId;
  assert.ok(operationId);
  assert.equal(persisted.schedulingMode, 'local_idle');
  assert.equal(persisted.localDispatchOverride, true);
  assert.equal(persisted.jobs[0].status, 'unknown');
  assert.equal(persisted.jobs[0].recallRequested, true);
  assert.equal(persisted.jobs[0].workerId, 'worker-a');
  assert.equal(persisted.jobs[1].status, 'running');
  assert.equal(calls.length, 1);

  const pRestart = providerState(stored);
  pRestart.distributedQueueGeneration = p.distributedQueueGeneration;
  pRestart.readWorkerTaskSnapshot = async () => snapshot(plan, queued);
  pRestart.client = { postWorkerAction: async (_worker, _action, request) => {
    calls.push(request);
    return releaseReceipt({ ...request, targetCommandId: queued.commandId });
  } };
  await pRestart.processDistributedRecall(root, plan.id, queued.index, pRestart.distributedQueueGeneration);
  persisted = stored.value.plans[0];
  assert.equal(calls[1].opId, operationId, 'the restart must replay the saved operation id');
  assert.equal(persisted.jobs[0].status, 'pending');
  assert.equal(persisted.jobs[0].attempt, 0);
  assert.equal(persisted.jobs[0].outputDir, 'runs/0');
  assert.equal(persisted.jobs[0].workerId, undefined);
  assert.equal(persisted.jobs[1].status, 'running');
});

test('a projectless all-legacy queue recalls one job while a running legacy sibling remains reconcilable to completion', async () => {
  const plan = { id: 'old-plan-id', planFile: 'plans/old.yaml', revision: 'legacy-r', codeFingerprint: 'legacy-f',
    enqueuedAt: new Date().toISOString(), schedulingMode: 'server_prequeue', jobs: [{ index: 4, case: 'old-case', seed: 8,
      outputDir: 'runs/historical', attempt: 1, status: 'queued', workerId: 'worker-old', commandId: 'old-command-1234', runKey: 'old-command-1234' },
    { index: 5, case: 'still-running', seed: 9, outputDir: 'runs/legacy-running', attempt: 1, status: 'running',
      workerId: 'worker-old', commandId: 'old-running-5678', runKey: 'old-running-5678', gpuId: '0' }] };
  const job = plan.jobs[0];
  const sibling = plan.jobs[1];
  const stored = { value: { schemaVersion: 1, plans: [plan] } };
  const p = providerState(stored);
  const calls = [];
  p.readWorkerTaskSnapshot = async () => snapshot(plan, job, 'queued', true);
  p.client = { postWorkerAction: async (_worker, _action, request) => {
    calls.push(request);
    return releaseReceipt({ ...request, targetCommandId: job.commandId }, true);
  } };
  await p.recallPlanToLocalQueueFromUi({ planId: plan.id, planFile: plan.planFile, jobIndex: job.index });
  const current = stored.value.plans[0];
  assert.equal(calls.length, 1);
  assert.equal(current.schedulingMode, 'server_prequeue', 'single-job recall keeps unrelated hosted policy');
  assert.equal(current.localDispatchOverride, undefined);
  assert.ok(current.projectId, 'released historical Plan enters the current durable queue');
  assert.equal(current.jobs[0].status, 'pending');
  assert.equal(current.jobs[0].localQueueOnly, true);
  assert.equal(current.jobs[0].outputDir, 'runs/historical');
  assert.equal(current.jobs[0].attempt, 0);
  assert.equal(current.jobs[1].status, 'running');
  assert.equal(queueApi.hasLegacyOwnership(current.jobs[1]), true,
    'the promoted Plan must preserve the old worker identity as an assigned legacy job');
  const completedLegacyReceipt = { commandId: sibling.commandId, workerId: sibling.workerId, planId: plan.id,
    plan: plan.planFile, caseName: sibling.case, status: 'completed' };
  assert.equal(queueApi.historicalRecallTaskMatchesJob(current, current.jobs[1], completedLegacyReceipt), true,
    'a later legacy completion must still match the untouched historical identity');
  const fresh = new Date().toISOString();
  const recovered = queueApi.mergeDurableWorkerSnapshots(stored.value, [{ workerId: sibling.workerId,
    generatedAt: fresh, fetchedAt: fresh, capabilities: { durablePlanQueue: true, schemaVersion: 1 },
    tasks: [completedLegacyReceipt] }], current.projectId);
  assert.equal(recovered.plans[0].jobs[1].status, 'completed', 'the server projection updates a promoted legacy sibling immediately');
  const stale = new Date(Date.now() - 6000).toISOString();
  const staleProjection = queueApi.mergeDurableWorkerSnapshots(stored.value, [{ workerId: sibling.workerId,
    generatedAt: stale, fetchedAt: stale, capabilities: { durablePlanQueue: true, schemaVersion: 1 },
    tasks: [completedLegacyReceipt] }], current.projectId, Date.now(), 5000);
  assert.equal(staleProjection.plans[0].jobs[1].status, 'unknown', 'expired historical evidence cannot preserve a running display');
  assert.match(source, /filter\(\(\{ plan, job \}\) => !plan\.projectId \|\| DistributedPlanQueue\.hasLegacyOwnership\(job\)\)/,
    'the tick reconciler must continue polling legacy-owned jobs after Plan promotion');
});

test('restart reconciles a persisted cancelled requeue tombstone only with its complete never-started proof', async () => {
  const stamp = new Date().toISOString();
  const queue = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), { projectId: queueApi.canonicalProjectId(root),
    schedulingMode: 'local_idle', localDispatchOverride: true, planFile: 'plans/tombstone.yaml', revision: 'r1',
    codeFingerprint: 'f1', jobs: [{ index: 0, case: 'case', seed: 3, outputDir: 'runs/case', collectionResultCsv: 'tmp/result/case/metrics.csv' }] },
  'tombstone-plan', stamp);
  const plan = queue.plans[0];
  const job = plan.jobs[0];
  Object.assign(job, { status: 'unknown', workerId: 'worker-a', commandId: 'target-command-tombstone',
    runKey: 'target-command-tombstone', recallRequested: true, recallOperationId: 'saved-operation-1234', reassignmentPending: true });
  const stored = { value: queue };
  const p = providerState(stored, false);
  const tombstone = releaseReceipt({ projectId: plan.projectId, workflowId: plan.id, planFile: plan.planFile,
    planRevision: plan.revision, codeFingerprint: plan.codeFingerprint, planJobCount: plan.planJobCount,
    experimentIndex: job.index, case: job.case, seed: job.seed, attempt: job.attempt, outputDir: job.outputDir,
    workerId: job.workerId, gpuId: job.gpuId, runKey: job.runKey, commandId: job.commandId,
    targetCommandId: job.commandId, opId: job.recallOperationId });
  p.readWorkerTaskSnapshot = async () => snapshot(plan, job, 'cancelled', false, tombstone);
  let rpcCalls = 0;
  p.client = { postWorkerAction: async () => { rpcCalls++; throw new Error('lost ACK'); },
    getWorkerTasks:async()=>({capabilities:{taskLifecycle:2},queryComplete:true,tasks:[{observation:{lifecycleProtocol:2,commandId:job.commandId,projectId:plan.projectId,workerId:job.workerId,observedAt:new Date().toISOString(),cancelled:true,tmux:null,result:null}}]}) };
  await p.processDistributedRecall(root, plan.id, job.index, 0);
  const released = stored.value.plans[0].jobs[0];
  assert.equal(rpcCalls, 1,'a cached tombstone cannot replace an active native stop/query boundary');
  assert.equal(released.status, 'pending');
  assert.equal(released.attempt, 0);
  assert.equal(released.recallRequested, undefined);
});

test('historical restart reconciles a cancelled requeue tombstone only with its complete never-started proof', async () => {
  const stamp = new Date().toISOString();
  const queue = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), { projectId: queueApi.canonicalProjectId(root),
    schedulingMode: 'local_idle', localDispatchOverride: true, planFile: 'plans/tombstone.yaml', revision: 'r1',
    codeFingerprint: 'f1', jobs: [{ index: 0, case: 'case', seed: 3, outputDir: 'runs/case', collectionResultCsv: 'tmp/result/case/metrics.csv' }] },
  'tombstone-plan', stamp);
  const plan = queue.plans[0];
  const job = plan.jobs[0];
  delete job.lifecycleProtocol; // Persisted pre-protocol2 declared record.
  Object.assign(job, { status: 'unknown', workerId: 'worker-a', commandId: 'target-command-tombstone',
    runKey: 'target-command-tombstone', recallRequested: true, recallOperationId: 'saved-operation-1234', reassignmentPending: true });
  const stored = { value: queue };
  const p = providerState(stored);
  const tombstone = releaseReceipt({ projectId: plan.projectId, workflowId: plan.id, planFile: plan.planFile,
    planRevision: plan.revision, codeFingerprint: plan.codeFingerprint, planJobCount: plan.planJobCount,
    experimentIndex: job.index, case: job.case, seed: job.seed, attempt: job.attempt, outputDir: job.outputDir,
    workerId: job.workerId, gpuId: job.gpuId, runKey: job.runKey, commandId: job.commandId,
    targetCommandId: job.commandId, opId: job.recallOperationId });
  p.readWorkerTaskSnapshot = async () => snapshot(plan, job, 'cancelled', false, tombstone);
  let rpcCalls = 0;
  p.client = { postWorkerAction: async () => { rpcCalls++; throw new Error('lost ACK'); },
    getWorkerTasks: async () => { throw new Error('legacy tombstone recall must not need a native active query'); } };
  await p.processDistributedRecall(root, plan.id, job.index, 0);
  const released = stored.value.plans[0].jobs[0];
  assert.equal(rpcCalls, 0, 'a pre-protocol2 tombstone settles from its complete never-started proof without RPC');
  assert.equal(released.status, 'pending');
  assert.equal(released.attempt, 0);
  assert.equal(released.recallRequested, undefined);
});

test('a partial historical requeue snapshot replays the saved operation to obtain the full proof', async () => {
  const plan = { id: 'legacy-replay', planFile: 'plans/old.yaml', revision: 'rev-old', codeFingerprint: 'old-f',
    jobs: [{ index: 0, case: 'old', seed: 42, attempt: 1, outputDir: 'runs/old', status: 'unknown',
      workerId: 'worker-old', gpuId: '0', commandId: 'legacy-replay-command', recallRequested: true,
      recallOperationId: 'persisted-recall-1234', reassignmentPending: true }] };
  const job = plan.jobs[0];
  const stored = { value: { schemaVersion: 1, plans: [plan] } };
  const p = providerState(stored);
  p.readWorkerTaskSnapshot = async () => snapshot(plan, job, 'cancelled', true, { stopReason: 'requeue' });
  let calls = 0;
  p.client = { postWorkerAction: async (_worker, _action, request) => {
    calls++;
    assert.equal(request.operationId, 'persisted-recall-1234');
    return { workflowId: plan.id, planFile: plan.planFile, planRevision: plan.revision,
      case: job.case, seed: job.seed, attempt: job.attempt, outputDir: job.outputDir,
      workerId: job.workerId, gpuId: job.gpuId, commandId: job.commandId, targetCommandId: job.commandId,
      status: 'cancelled', stopReason: 'requeue', durableReleased: true, legacyReleased: true,
      neverStarted: true, neverStartedEvidence: 'worker_task_queued' };
  } };
  await p.processDistributedRecall(root, plan.id, job.index, 0);
  assert.equal(calls, 1);
  assert.equal(stored.value.plans[0].jobs[0].status, 'pending');
  assert.equal(stored.value.plans[0].jobs[0].attempt, 0);
});

test('historical pending receipts can be recalled through the Agent queued-only release', async () => {
  const plan = { id: 'legacy-pending', planFile: 'plans/pending.yaml', revision: 'rev-old', codeFingerprint: 'old-f',
    jobs: [{ index: 0, case: 'old', seed: 42, attempt: 1, outputDir: 'runs/pending', status: 'queued',
      workerId: 'worker-old', gpuId: '0', commandId: 'legacy-pending-command' }] };
  const job = plan.jobs[0];
  const stored = { value: { schemaVersion: 1, plans: [plan] } };
  const p = providerState(stored);
  p.readWorkerTaskSnapshot = async () => snapshot(plan, job, 'pending', true);
  let calls = 0;
  p.client = { postWorkerAction: async (_worker, _action, request) => {
    calls++;
    return { ...releaseReceipt(request, true), neverStartedEvidence: 'worker_task_pending' };
  } };
  await p.recallPlanToLocalQueueFromUi({ planId: plan.id, planFile: plan.planFile, jobIndex: job.index });
  assert.equal(calls, 1, 'historical pending must reach the queued-only Agent recall');
  assert.equal(stored.value.plans[0].jobs[0].status, 'pending');
  assert.equal(stored.value.plans[0].jobs[0].attempt, 0);
});

 test('native recall needs explicit confirmation and an identity-bound cancelled observation',async()=>{
  for(const confirmed of [false,true]) {
    const q=queueApi.enqueuePlan(queueApi.emptyDistributedQueue(),{projectId:root,planFile:'plans/native.yaml',revision:'r',codeFingerprint:'code',jobs:[0,1].map(index=>({index,case:'case',seed:42+index,outputDir:'runs/native/'+index,collectionResultCsv:'tmp/result/native/'+index+'.csv'}))},'native-run');
    Object.assign(q.plans[0].jobs[0],{status:'running',workerId:'worker',commandId:'original-native-command',runKey:'original-native-command'});
    const original=JSON.stringify(q),sibling=JSON.stringify(q.plans[0].jobs[1]),stored={value:q},posts=[],queries=[];
    const p=providerState(stored,false,{vscode:{window:{showWarningMessage:async()=>confirmed?'确认召回':undefined}}});
    p.client={postWorkerAction:async(worker,action,request)=>{posts.push(request);assert.equal(worker,'worker');assert.equal(action,'stop-worker-task');assert.equal(request.targetCommandId,'original-native-command');assert.equal(Object.hasOwn(request,'attempt'),false);},getWorkerTasks:async(worker,options)=>{
      queries.push(options);assert.equal(worker,'worker');assert.equal(options.queries[0].commandId,'original-native-command');
      return {queryComplete:true,capabilities:{taskLifecycle:2},tasks:[{observation:{lifecycleProtocol:2,commandId:'original-native-command',projectId:root,workerId:'worker',cancelled:true}}]};
    }};
    await p.recallPlanToLocalQueueFromUi({planId:'native-run',jobIndex:0,planFile:'plans/native.yaml'});
    if(!confirmed){assert.equal(JSON.stringify(stored.value),original);assert.equal(posts.length,0);assert.equal(queries.length,0);continue;}
    const job=stored.value.plans[0].jobs[0];assert.equal(posts.length,1);assert.equal(queries.length,1);assert.equal(job.status,'pending');assert.equal(job.lifecycleProtocol,2);assert.equal(job.commandId,undefined);assert.ok(job.nextCommandId);assert.equal(job.localQueueOnly,true);assert.equal(job.outputDir,'runs/native/0');assert.equal(JSON.stringify(stored.value.plans[0].jobs[1]),sibling);
  }
 });

test('a native recall cannot settle from an old cancelled receipt when the current query fails', async () => {
  const queue = queueApi.enqueuePlan(queueApi.emptyDistributedQueue(), {projectId:queueApi.canonicalProjectId(root),
    planFile:'plans/native.yaml',revision:'r',codeFingerprint:'code',jobs:[{index:0,case:'a',seed:1,
      outputDir:'runs/native',collectionResultCsv:'tmp/result/native.csv'}]}, 'native-recall');
  const job = queue.plans[0].jobs[0];
  Object.assign(job,{workerId:'worker-a',commandId:'native-original',status:'unknown',recallRequested:true,recallOperationId:'native-stop-request'});
  const stored = {value:queue}, p = providerState(stored, false), posts=[];
  const before = JSON.stringify(queue);
  p.client = {postWorkerAction: async (worker,action,request) => {posts.push({worker,action,request}); return {status:'completed'};},
    getWorkerTasks: async () => ({capabilities:{taskLifecycle:2},queryComplete:false,error:'query unavailable',tasks:[]})};
  p.readWorkerTaskSnapshot = async () => assert.fail('native recall must query protocol2 observation instead of adopting an old receipt');
  await assert.rejects(p.processDistributedRecall(root,'native-recall',0,0), /query unavailable/);
  assert.equal(JSON.stringify(stored.value),before);
  assert.equal(posts.length,1); assert.equal(posts[0].request.targetCommandId,'native-original');
  assert.equal(posts[0].worker,'worker-a'); assert.equal(posts[0].action,'stop-worker-task');
});
