const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
require('../_helpers/registerTsRequire');
const { WorkerPreparation } = require('../../src/features/WorkerPreparation.ts');
const source = fs.readFileSync(path.join(__dirname, '../../src/extension/legacy.ts'), 'utf8');
function method(name, globals = {}) {
  const tree = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
  let found; const visit = node => { if (ts.isMethodDeclaration(node) && node.name.getText(tree) === name) found = node; else ts.forEachChild(node, visit); }; visit(tree);
  assert.ok(found, name);
  const code = ts.transpileModule('class Host {' + found.getText(tree) + '} globalThis.Host = Host;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const sandbox = { require: require("node:module").createRequire(path.resolve(__dirname, "../../dist/extension/legacy.js")), ...globals, setTimeout, clearTimeout, AbortSignal, console }; vm.runInNewContext(code, sandbox); return sandbox.Host.prototype[name];
}
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
test('actual submission enqueues after first prepared server, while a slow server keeps preparing', async () => {
  const slow = deferred(), first = deferred(), enqueued = deferred(), body = {}, stages = [], root = 'fixture'; let tick = 0, preparations = 0, submissions = 0;
  const globals = { WorkerPreparation, workspaceRoot: () => root, WorkflowBinding: { bindWorkflowWorkspace: () => ({}), assertWorkflowWorkspace() {} },
    PlanRunHost: class { async save() {} }, stringField: () => '', errorMessage: e => e.message,
    DistributedPlanQueue: { distributedSubmissionProgress: () => ({ status: 'succeeded' }) } };
  const host = { localOperations: { op: {} }, distributedSubmissionEpochs: new Map(), planSubmissionOperationId: () => 'op', submissionStillCurrent: () => true,
    distributedCodeVersionHold: async () => undefined, waitForPlanSubmission: async (_m, work) => work(), recordPlanSubmissionTiming() {},
    localDistributedCodeFingerprint: async () => 'fp', enabledWorkerConfigs: () => [{ id: 'fast' }, { id: 'slow' }],
    ensureCodeReadyForRun: async (_c, _b, _report, ready) => {
      preparations++;
      host.lastCodeSyncState = { fingerprint: 'fp', workerVersions: { fast: { fingerprint: 'fp' } } }; ready('fast'); first.resolve();
      await slow.promise; host.lastCodeSyncState.workerVersions.slow = { fingerprint: 'fp' }; ready('slow');
    }, stampWorkerPoolManualTarget: (b, id) => b.schedulerOwnerWorkerId = id,
    planValidationCacheKey: () => 'check', planSchedulerWorkerId: b => b.schedulerOwnerWorkerId,
    runPlanPreflight: async () => ({ validation: { jobs: [] } }), assertPlanSubmissionWorkers: async () => {},
    confirmDistributedPlanExistingOutputs: async () => {}, assertExecutionCondaEnvReady() {}, workerActionTargets: () => [],
    enqueueDistributedPlan: async b => { b.submissionWorkflowId = 'run' + (++submissions); enqueued.resolve(); return { enqueued: true }; },
    tickDistributedQueue: async () => { tick++; }, reportPlanStage: (_m, text) => stages.push(text),
    legacySourceFreezeWorkerNames: () => [],
    finishPlanSubmissionProgress: (_m, state) => assert.equal(state, 'succeeded'), recordActionError() {} };
  const work = method('finishDistributedPlanSubmission', globals).call(host, 'runPlan', {}, {}, body);
  await first.promise; await enqueued.promise;
  assert.equal(host.workerPreparation.preparation.settled, false); assert.equal(body.schedulerOwnerWorkerId, 'fast');
  await work; assert.equal(body.workerPreparationPendingLocal, true);
  await method('finishDistributedPlanSubmission', globals).call(host, 'runPlan', {}, {}, {});
  assert.equal(preparations, 1); assert.equal(submissions, 2);
  slow.resolve(); await body.awaitWorkerPreparationLocal(); assert.ok(tick > 0); assert.equal(host.workerPreparation, undefined);
});
test('later failure preserves ready servers; destructive replacement still waits for every server', async () => {
  const slow = deferred(); let calls = 0;
  const p = new WorkerPreparation(async ready => { ready('fast'); ready('fast'); await slow.promise; throw Error('slow unavailable'); }, () => calls++);
  assert.equal(await p.first(), 'fast'); assert.equal(p.settled, false); assert.equal(calls, 1);
  const all = p.all(); slow.resolve(); await assert.rejects(all, /slow unavailable/); assert.deepEqual([...p.ready], ['fast']);
  const failed = new WorkerPreparation(async () => { throw Error('none ready'); }); await assert.rejects(failed.first(), /none ready/);
});
test('401 during activation rereads discovery once, before any RPC; persistent failure is bounded', async () => {
  let reads = 0, gets = 0; const auth = [];
  const globals = { path, process, os: { homedir: () => '' }, URL, vscode:{extensions:{}},workspaceRoot:()=> 'C:/fixture',
    ...require('../../src/core/SimpleSftpWindow.ts'),
    fs: { readFile: async () => JSON.stringify({ pid:process.pid,startedAt:'fixture',version:'fixture',baseUrl: 'http://127.0.0.1:3456', token: String(++reads) }) },
    fetch: async (_url, options) => { auth.push(options.headers.Authorization); return ++gets === 1 ? { status: 401, ok: false }
      : { ok: true, json: async () => ({ name:'SimpleSFTP',version:'fixture',instanceId:process.pid+':fixture',methods: ['files.cleanup.inspect'] }) }; } };
  // 31：能力读取移入共享单槽；401 重试语义（只重读发现头部文件一次、不重放 RPC）保持不变。
  const capability = method('simpleSftpCapability', globals);
  const mk = () => ({ simpleSftpCapLaunch: 0, simpleSftpCapShared: undefined, readSimpleSftpCapabilities: method('readSimpleSftpCapabilities', globals) });
  await capability.call(mk(), 'files.cleanup.inspect');
  assert.deepEqual(auth, ['Bearer 1', 'Bearer 2']); assert.equal(reads, 2);
  globals.fetch = async () => ({ status: 401, ok: false }); reads = 0;
  await assert.rejects(method('simpleSftpCapability', globals).call(mk(), 'files.cleanup.inspect'), /HTTP 401/); assert.equal(reads, 2);
});

test('runtime reads overlap synchronization but readiness waits for both; workspace changes never release a target', async () => {
  const version = deferred(), syncStarted = deferred(); const ready = [];
  const host = { prepareSftpTargets: async () => {}, projectContextIsCurrent: () => true,
    assertPlanTopologyReady: () => ({mode:'worker_pool'}), planSchedulerWorkerId: () => 'fast',
    workerCodeSyncTargets: () => [{id:'fast'}, {id:'slow'}],
    ensureRemoteAgentVersionConsistent: () => version.promise,
    syncCodeTargets: async (targets, scope, options) => {
      assert.equal(scope, 'run'); assert.equal(targets.length, 2); assert.equal(options.hashCompare, true);
      syncStarted.resolve(); await options.onTargetReady('fast'); return targets;
    } };
  const run = method('ensureCodeReadyForRun', {uniqueStrings: rows => [...new Set(rows)], UiCommandCancelled: Error});
  const work = run.call(host, {root:'fixture'}, [], () => {}, id => ready.push(id));
  await syncStarted.promise; assert.deepEqual(ready, []);
  version.resolve(); await work; assert.deepEqual(ready, ['fast']);
  host.projectContextIsCurrent = () => false;
  await assert.rejects(run.call(host, {root:'changed'}, [], () => {}, id => ready.push(id)), /工作区已切换/);
  assert.deepEqual(ready, ['fast']);
});

test('both cleanup paths forward the configured prefix without changing target authorization or caller input', async () => {
  const calls=[];
  const run=method('simpleSftpApiCall',{assertRetryRequestCurrent(){},workspaceRoot:()=> 'C:/fixture',
    sftpFileIndexQuery:require('../../src/features/ProjectFileIndex.ts').sftpFileIndexQuery,
    fileOperationIndexPaths:require('../../src/features/ProjectFileIndex.ts').fileOperationIndexPaths,
    vscode:{workspace:{getConfiguration:()=>({get:()=> 'global'})}},
    AgentTmuxPolicy_1:require('../../src/tunnel/AgentTmuxPolicy.ts'),
    callSftpWithProgress:async(name,params,capability)=>{await capability(name);calls.push({name,params});return {ok:true};}});
  const host={assertTransferRootSafety:method('assertTransferRootSafety'),setupConfig:{sessionPrefix:'Research'},simpleSftpCapability:async()=>({})};
  const input={token:'original',index:0,confirm:false};
  for(const name of ['files.cleanup.preview','files.cleanup.execute','files.cleanup.check'])await run.call(host,name,input);
  assert.equal(calls[0].params.tmuxSessionPrefix,'research'); assert.equal(calls[1].params.tmuxSessionPrefix,'research');
  assert.equal(calls[2].params,input); assert.equal(input.tmuxSessionPrefix,undefined);
  assert.equal(calls[1].params.confirm,false);assert.equal(calls[1].params.token,'original');
});

test('submission rechecks only unavailable capabilities and freezes the successful response for this boundary', async () => {
  const endpoints={taskLifecycle:2,declaredJobPaths:true,formalJobIdentityEnv:1,taskShellEnvironment:1,projectManagedValidation:1};
  const healthy=()=>({status:'ok',capabilities:{endpoints:{...endpoints}}});
  let calls=0,reply=healthy(),root='project';
  const host={client:{},projectContextGeneration:1,lastWorkerProbes:{fast:healthy(),h20:{status:'timeout',message:'health query aborted'}},
    tunnelConfig:{token:'fixture'},tunnelLaunchItems:()=>[{id:'h20',role:'worker',config:{localForwardPort:23456}}],
    expectedWorkerAgentProjectRoot:()=>'/project',stampWorkerProbeGeneration:(_,p)=>p};
  const globals={workspaceRoot:()=>root,enforceExpectedAgentProjectRoot:p=>p,
    XshellTunnelPortProbe_1:{probeWorkerTelemetryTunnel:async(config,options)=>{
      calls++;assert.equal(config.localForwardPort,23456);assert.equal(options.timeoutMs,8000);return reply;
    }}};
  host.submissionWorkerProbes=method('submissionWorkerProbes',globals);
  const targets=[{id:'fast'},{id:'h20'}];
  const observed=await host.submissionWorkerProbes(targets);
  assert.equal(calls,1);assert.equal(observed.h20.capabilities.endpoints.taskShellEnvironment,1);
  host.lastWorkerProbes.h20={status:'timeout'};
  assert.equal(observed.h20.status,'ok','a later background timeout cannot erase this observation');
  reply={status:'timeout',message:'GET /api/health timed out'};
  await assert.rejects(host.submissionWorkerProbes(targets),e=>e.retryableSubmission===true
    && e.workerId==='h20' && /GET \/api\/health timed out/.test(e.message) && !/PROTOCOL_INCOMPATIBLE/.test(e.message));
  host.lastWorkerProbes.h20={status:'timeout'};reply=healthy();delete reply.capabilities.endpoints.taskShellEnvironment;
  const unsupported=await host.submissionWorkerProbes(targets);
  assert.equal(unsupported.h20.capabilities.endpoints.taskShellEnvironment,undefined,'do not invent a missing protocol');
  reply=healthy();globals.XshellTunnelPortProbe_1.probeWorkerTelemetryTunnel=async()=>{root='other';return reply;};
  await assert.rejects(host.submissionWorkerProbes(targets),/工作区或连接已变化/);
});

test('real enqueue rechecks H20 after background probe loss but still rejects an explicitly missing protocol', async () => {
  const endpoints={taskLifecycle:2,declaredJobPaths:true,formalJobIdentityEnv:1,taskShellEnvironment:1,projectManagedValidation:1};
  let reply={status:'ok',capabilities:{endpoints}};
  const host={client:{},projectContextGeneration:1,taskLifecycleProtocol:2,lastWorkerProbes:{h20:{status:'timeout'}},
    tunnelConfig:{},tunnelLaunchItems:()=>[{id:'h20',role:'worker',config:{}}],workerActionTargets:()=>[{id:'h20'}],
    expectedWorkerAgentProjectRoot:()=>'/project',stampWorkerProbeGeneration:(_,p)=>p};
  const globals={workspaceRoot:()=> 'project',enforceExpectedAgentProjectRoot:p=>p,
    XshellTunnelPortProbe_1:{probeWorkerTelemetryTunnel:async()=>reply},
    WorkflowBinding:{bindWorkflowWorkspace:()=>({}),assertPlanSeedContract(){},assertWorkflowWorkspace(){}},planValidationFromResult:r=>r};
  host.submissionWorkerProbes=method('submissionWorkerProbes',globals);
  // 块C：真实 enqueue 落盘窄溯源——提取纯法身而非 stub（this 绑定由 .call(host) 承担）。
  Object.assign(host,{queueGitProvenance:method('queueGitProvenance',globals),stripGitUrlCredentials:method('stripGitUrlCredentials',globals)});
  const enqueue=method('enqueueDistributedPlan',globals);
  await assert.rejects(enqueue.call(host,{},{}),/Agent 校验未返回逐 job 清单/);
  host.lastWorkerProbes.h20={status:'timeout'};
  reply={status:'ok',capabilities:{endpoints:{...endpoints,taskShellEnvironment:0}}};
  await assert.rejects(enqueue.call(host,{},{}),/WORKER_PROTOCOL_INCOMPATIBLE.*h20/);
});

test('stopping or replacing the queue during a capability recheck cannot send a task', async () => {
  const host={taskLifecycleProtocol:2,client:{},distributedQueueGeneration:1,
    unifiedDomainState:()=>({active:false,blocked:""}), // 块B：夹具根未登记 → 既有单机发送路径
    submissionWorkerProbes:async()=>{host.distributedQueueGeneration++;return {};}};
  const send=method('sendDistributedJob',{workspaceRoot:()=> 'project'});
  await assert.rejects(send.call(host,{resultPathPolicy:'declared'},{outputDir:'work/job'},'h20','0','original'),/派发上下文已变化.*未发送/);
});
