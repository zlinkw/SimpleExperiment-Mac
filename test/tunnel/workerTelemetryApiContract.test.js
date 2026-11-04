const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { MultiEndpointRealtimeClient, mergeWorkerResultsSummaries } = require("../../dist/tunnel/MultiEndpointRealtimeClient.js");
const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { readSource } = require("../_helpers/sourceReader");

const {
  workerTelemetryAllowedEvents,
  workerTelemetryAllowedActions,
  workerLocalSchedulerActionNames,
  workerResultActionNames,
  workerTelemetryForbiddenEndpoints,
  workerTelemetryRequiredEndpoints,
  validateWorkerTelemetryCapabilities,
  isWorkerDirectAction,
  isWorkerTelemetryAction,
} = require("../../dist/tunnel/WorkerTelemetryApi.js");

function productionWorkerTelemetryCapabilities() {
  return require('../_helpers/workerTelemetryCapabilities')();
}

test("formal stop capability markers validate without becoming callable controls", async (context) => {
  context.mock.method(global, "fetch", async () => { throw Error("capability marker must never dispatch HTTP"); });
  const capabilities = productionWorkerTelemetryCapabilities();
  for (const marker of ['stop-worker-task-formal-identity', 'stop-worker-task-formal-no-attempt', 'stop-worker-task-local-command']) {
    assert.equal(capabilities.actionEndpoints[marker], true);
    assert.equal(isWorkerDirectAction(marker), false);
    assert.equal(isWorkerTelemetryAction(marker), false);
    assert.ok(!workerTelemetryAllowedActions.includes(`POST /api/actions/${marker}`));
    const client = new MultiEndpointRealtimeClient([{ id: 'worker', role: 'worker', localHost: '127.0.0.1', localPort: 1 }],
      () => new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] }));
    await assert.rejects(client.postWorkerAction('worker', marker, {}), /action not allowed/);
  }
  const result = validateWorkerTelemetryCapabilities(capabilities);
  assert.equal(result.ok, true, result.warnings.join('; '));
  assert.deepEqual(result.warnings, []);
  for (const action of ['deploy-runtime', 'stop-worker-task-formal-all', 'stop-worker-task-formal-no-attempt-extra']) {
    const bad = validateWorkerTelemetryCapabilities({ ...capabilities, actionEndpoints: { ...capabilities.actionEndpoints, [action]: true } });
    assert.equal(bad.ok, false);
    assert.ok(bad.warnings.some(warning => warning.endsWith(action)));
  }
});

function panelFunction(name) {
  const source = readSource("src/ui/PanelHtml.ts");
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test("worker telemetry permits bounded worker controls plus local scheduler actions", () => {
  assert.ok(workerTelemetryRequiredEndpoints.includes("/api/gpu"));
  assert.ok(workerTelemetryRequiredEndpoints.includes("/api/worker/tasks"));
  assert.ok(workerTelemetryRequiredEndpoints.includes("/api/results/summary"));
  assert.deepEqual([...workerTelemetryAllowedActions].sort(), [
    "POST /api/actions/configure-gpu-quota",
    "POST /api/actions/start-worker-task",
    "POST /api/actions/preflight-worker-task",
    "POST /api/actions/register-code-sync-proof",
    "POST /api/actions/rebuild-distributed-results",
    "POST /api/actions/retry-worker-task",
    "POST /api/actions/stop-worker-task",
    "POST /api/actions/stop-worker-task-exact-pane",
    "POST /api/actions/delete-worker-artifacts",
    "POST /api/actions/archive-worker-artifacts",
    "POST /api/actions/finalize-worker-operation",
    "POST /api/actions/start-tensorboard",
    "POST /api/actions/stop-tensorboard",
    "POST /api/actions/get-tensorboard-status",
    "POST /api/actions/install-rich",
    "POST /api/actions/save-result-policy",
  ].sort());
  assert.deepEqual([...workerLocalSchedulerActionNames], ["validate-plan", "dry-run-plan", "run-plan", "reproduce-plan", "stop-scheduler-operation"]);
  assert.ok(workerResultActionNames.includes("parse-results"));
  assert.ok(workerResultActionNames.includes("archive-artifacts"));
  assert.equal(workerTelemetryForbiddenEndpoints.includes("POST /api/actions/parse-results"), false);
  assert.ok(workerTelemetryForbiddenEndpoints.includes("GET /api/files/list"));
  assert.equal(workerTelemetryForbiddenEndpoints.includes("GET /api/files/*"), false);
  assert.deepEqual([...workerTelemetryAllowedEvents].sort(), ["agent_heartbeat", "diagnostics_updated", "gpu_snapshot", "log_tail", "worker_health", "worker_task_snapshot"].sort());
});

test("worker capabilities tolerate missing file and action api", () => {
  const result = validateWorkerTelemetryCapabilities({
    schemaVersion: 1,
    mode: "worker_telemetry",
    apiVersion: "1",
    agentVersion: "1",
    endpoints: { health: true, capabilities: true, gpu: true, workerTasks: true, resultsSummary: true, liveOutput: true, diagnostics: true, websocketEvents: true, sseEvents: true, actions: false, fileList: false },
  });
  assert.equal(result.ok, true);
});

test("worker capabilities accept local scheduler actions and reject other Hub actions", () => {
  const base = {
    schemaVersion: 1,
    mode: "worker_telemetry",
    apiVersion: "1",
    agentVersion: "1",
    endpoints: { health: true, capabilities: true, gpu: true, workerTasks: true, resultsSummary: true, liveOutput: true, diagnostics: true, websocketEvents: true, sseEvents: true, actions: true, fileList: false },
  };
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "start-worker-task": true, "retry-worker-task": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "run-plan": true, "validate-plan": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "parse-results": true, "archive-artifacts": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "start-tensorboard": true, "stop-tensorboard": true, "get-tensorboard-status": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "install-rich": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "stop-worker-task-exact-pane": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "deploy-runtime": true } }).ok, false);
  const readOnlyDownload = validateWorkerTelemetryCapabilities({
    ...base,
    endpoints: { ...base.endpoints, fileDownload: true, fileRangeDownload: true, fileList: false, fileUploadChunk: false },
    actionEndpoints: { "stop-worker-task-exact-pane": true },
  });
  assert.equal(readOnlyDownload.ok, true);
  assert.deepEqual(readOnlyDownload.warnings, []);
  const productionWorker = validateWorkerTelemetryCapabilities(productionWorkerTelemetryCapabilities());
  assert.equal(productionWorker.ok, true);
  assert.deepEqual(productionWorker.warnings, []);
  const writes = validateWorkerTelemetryCapabilities({
    ...base,
    endpoints: { ...base.endpoints, fileList: true, fileUploadChunk: true, fileUploadInit: true },
  });
  assert.equal(writes.ok, false);
  assert.match(writes.warnings.join("\n"), /不允许的文件写入或列表端点：fileList、fileUploadChunk、fileUploadInit/);
  const missingGpu = validateWorkerTelemetryCapabilities({
    ...base,
    endpoints: { ...base.endpoints, gpu: false },
  });
  assert.equal(missingGpu.ok, false);
  assert.match(missingGpu.warnings.join("\n"), /缺少端点：gpu/);
});

test("Worker-only client requires topology stamp and never substitutes Worker for Hub", async (context) => {
  // A rejected read must be independent of the user's live Agent/tunnel ports.
  context.mock.method(global, "fetch", async (url) => {
    assert.match(String(url), /\/api\/results\/summary$/);
    throw new TypeError("fetch failed");
  });
  const client = new MultiEndpointRealtimeClient([
    { id: "worker-1", role: "worker", localHost: "127.0.0.1", localPort: 23456 },
  ], () => new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] }));
  await assert.rejects(client.postWorkerAction("worker-1", "run-plan", {}), /action not allowed/);
  await assert.rejects(client.postWorkerAction("worker-1", "parse-results", {}), /action not allowed/);
  await assert.rejects(client.postAction("run-plan", {}), /WORKER_ACTION_REQUIRED/);
  await assert.rejects(client.getResultsSummary(), /fetch failed|ECONNREFUSED|AbortError|timeout|No Worker endpoint|worker telemetry does not expose hub control api/);
});

test("Worker summaries merge read-only while preserving result ownership", () => {
  const merged = mergeWorkerResultsSummaries([
    { workerId: "worker-b", summary: { planFile: "experiments/plans/demo.yaml", planRevision: "rev-1", workerSetRevision: "set-1", results: [{ resultId: "same", finalEvidenceState: "pending_review" }] } },
    { workerId: "worker-a", summary: { planFile: "experiments/plans/demo.yaml", planRevision: "rev-1", workerSetRevision: "set-1", results: [{ resultId: "same", finalEvidenceState: "archived", metrics: { AUC: { value: 0.9 } } }] } },
  ], "experiments/plans/demo.yaml");
  assert.equal(merged.authoritative, false);
  assert.equal(merged.displayAggregateOnly, true);
  assert.equal(merged.resultCount, 2);
  assert.equal(merged.finalResultCount, 1);
  assert.equal(merged.incompleteAggregate, false);
  assert.equal(merged.aggregateCoverage, "2/2");
  assert.deepEqual(merged.workerIds, ["worker-a", "worker-b"]);
  assert.deepEqual(merged.results.map((row) => row.resultOwnershipKey).sort(), ["worker-a:same", "worker-b:same"]);
  assert.ok(merged.results.every((row) => row.workerId === row.resultOwnerWorkerId && row.provenance.workerId === row.workerId));
});

test("partial Worker summaries stay worker-pool scoped and disclose missing endpoints", () => {
  const merged = mergeWorkerResultsSummaries([
    { workerId: "worker-a", summary: { planFile: "experiments/plans/demo.yaml", planRevision: "rev-1", results: [{ resultId: "a", finalEvidenceState: "archived" }] } },
  ], "experiments/plans/demo.yaml", ["worker-a", "worker-b"]);
  assert.equal(merged.topologyMode, "worker_pool");
  assert.equal(merged.incompleteAggregate, true);
  assert.equal(merged.aggregateCoverage, "1/2");
  assert.deepEqual(merged.expectedWorkerIds, ["worker-a", "worker-b"]);
  assert.deepEqual(merged.availableWorkerIds, ["worker-a"]);
  assert.deepEqual(merged.unavailableWorkerIds, ["worker-b"]);
  assert.match(merged.message, /不是全局结果/);
  const panel = readSource("src/ui/PanelHtml.ts");
  assert.match(panel, /function renderWorkerResultAggregateWarning\(summary\)/);
  assert.match(panel, /当前数字仅代表可用 Worker 的只读部分视图/);
});

test("no-Hub result buttons use the owning Worker capability instead of Hub capability", () => {
  const sandbox = {
    noHubWorkerResultCommands: new Set(["archiveArtifacts", "parseResults", "refreshResults"]),
    NO_HUB_TOPOLOGY_MODES: new Set(["single_worker", "worker_pool"]),
    asArray: (value) => Array.isArray(value) ? value : [],
    resolveWorkerId: (value) => String(value || "").trim(),
    uniqueText: (values) => [...new Set(values)],
    enabledWorkerTunnelsForState: (state) => state.setup.workerTunnels.filter((worker) => worker.enabled !== false),
    hasCapability: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(panelFunction("missingNoHubWorkerResultCapabilities") + "\nthis.check = missingNoHubWorkerResultCapabilities;", sandbox);
  const good = { status: "ok", capabilities: { endpoints: { actions: true, resultsSummary: true }, actionEndpoints: { "archive-artifacts": true, "parse-results": true } } };
  const stale = { status: "ok", capabilities: { endpoints: { actions: true, resultsSummary: false }, actionEndpoints: { "archive-artifacts": false, "parse-results": false } } };
  const state = {
    topology: { mode: "worker_pool" },
    setup: { workerTunnels: [{ id: "worker-a" }, { id: "worker-b" }] },
    workerProbes: { "worker-a": good, "worker-b": stale },
  };
  assert.deepEqual([...sandbox.check(state, "archiveArtifacts", ["actions.archive-artifacts"], { workerId: "worker-a" })], []);
  assert.deepEqual([...sandbox.check(state, "parseResults", ["actions.parse-results"], {})], ["worker-b: actions.parse-results"]);
  assert.deepEqual([...sandbox.check(state, "refreshResults", ["endpoints.resultsSummary"], {})], ["worker-b: endpoints.resultsSummary"]);
  assert.equal(sandbox.check({ ...state, topology: { mode: "hub_worker" } }, "parseResults", ["actions.parse-results"], {}), null);
});

test("packaged Scheduler declarations survive embedded data, reject real failures, and reach the desktop probe unchanged", async context => {
  const {spawnSync}=require('node:child_process'),http=require('node:http'),crypto=require('node:crypto');
  const packageRoot=process.env.SIMPLE_PROTOCOL_PACKAGE_ROOT||path.resolve(__dirname,'../..');
  const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',path.join(__dirname,'../_helpers/workerTelemetryCapabilities.py'),'--regression'],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4*1024*1024,env:{...process.env,SIMPLE_PROTOCOL_RUNTIME_ROOT:path.join(packageRoot,'dist/runtime')}});
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  const matrix=JSON.parse(result.stdout),{schedulerProtocolDiagnostic}=require(path.join(packageRoot,'dist/tunnel/AgentCapabilities'));
  const probeModule=require(path.join(packageRoot,'dist/tunnel/XshellTunnelPortProbe'));
  let payload=matrix.capabilities;
  const remoteRoot='/srv/研究 项目',localRoot=path.resolve(__dirname,'../..');
  const server=http.createServer((request,response)=>{response.setHeader('content-type','application/json');response.setHeader('connection','close');response.end(JSON.stringify(request.url==='/api/capabilities'?payload:{schemaVersion:1,mode:'worker_telemetry',status:'ok',projectRoot:remoteRoot,agentVersion:payload.agentVersion}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  context.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>setImmediate(resolve));});
  const config={localForwardHost:'127.0.0.1',localForwardPort:server.address().port,remoteAgentHost:'127.0.0.2',remoteAgentPort:23491};
  const compiled=fs.readFileSync(path.join(packageRoot,'dist/extension/legacy.js'),'utf8');
  function method(name,globals){const start=compiled.search(new RegExp('^    (?:async )?'+name+'\\(','m'));assert.ok(start>=0,name);const tail=compiled.slice(start),end=tail.slice(1).search(/^    (?:async )?[a-zA-Z][a-zA-Z0-9_]*\(/m)+1;return vm.runInNewContext('({'+tail.slice(0,end)+'})',globals)[name];}
  const globals={schedulerProtocolDiagnostic,AgentCapabilities_1:{schedulerProtocolDiagnostic},XshellTunnelPortProbe_1:probeModule,workspaceRoot:()=>localRoot,errorMessage:error=>error.message,
    ENDPOINT_READY_PROBE_STATUSES:new Set(['ok']),ApiWorkflow_1:require(path.join(packageRoot,'dist/features/ApiWorkflow'))};
  for(const name of ['normalizeAgentProjectRoot','enforceExpectedAgentProjectRoot']){const start=compiled.indexOf('function '+name+'('),tail=compiled.slice(start),next=tail.slice(1).search(/^function /m)+1;vm.runInNewContext(tail.slice(0,next)+'\nthis.'+name+'='+name+';',globals);}
  const host={client:{},projectContextGeneration:1,lastWorkerProbes:{'worker-a':{capabilities:{endpoints:{projectManagedValidation:0}}},'worker-b':{retained:true}},lastFullEndpointProbeAt:999,tunnelConfig:{},
    tunnelLaunchItems:()=>[{id:'worker-a',role:'worker',config}],expectedWorkerAgentProjectRoot:()=>remoteRoot,stampWorkerProbeGeneration:(_,probe)=>probe,
    assertActionAuthorityCurrent:()=>{throw Error('PROTOCOL_CHECK_PASSED_WITHOUT_SUBMIT');}};
  const refresh=method('refreshDistributedResultSyncProbes',globals),submit=method('postWorkerTunnelAction',globals);
  await refresh.call(host,localRoot);
  assert.equal(host.lastWorkerProbes['worker-a'].status,'ok');
  assert.deepEqual(host.lastWorkerProbes['worker-a'].capabilities.endpoints,payload.endpoints);
  await assert.rejects(submit.call(host,'worker-a','validate-plan',{}, {requiresCapability:['endpoints.projectManagedValidation']}),/PROTOCOL_CHECK_PASSED_WITHOUT_SUBMIT/);
  for(const[name,phrase]of [['permission_denied',/读取失败/],['syntax_error',/解析失败/],['version_mismatch',/版本不匹配/],['runtime_mismatch',/配对文件凭据/],['missing_PROJECT_MANAGED_VALIDATION_PROTOCOL',/确实缺少/]]){
    payload=matrix.responses[name];await refresh.call(host,localRoot);
    assert.match(host.lastWorkerProbes['worker-a'].message,phrase);
    await assert.rejects(submit.call(host,'worker-a','validate-plan',{}, {requiresCapability:['endpoints.projectManagedValidation']}),phrase);
  }
  // Real deployment orchestration; remote boundaries are receipts, never SSH or a user server.
  payload=matrix.capabilities;const calls=[],uploads=[],target={id:'worker-a',role:'worker',label:'fixture',host:'example.invalid',user:'fixture',port:2222,remotePath:'/srv/插件 runtime/simple_cluster/runtime'};
  Object.assign(host,{context:{extension:{packageJSON:{version:payload.runtimeVersion}}},prepareSftpTargets:async()=>{},sftpSharedTargets:()=>[target],agentRuntimeUploadTargets:()=>[target,{...target,id:'worker-b'}],agentLifecycleServer:async()=>({id:target.id}),
    agentLifecycleForTarget:async(actual,action,manifest)=>{calls.push({id:actual.id,action,manifest});return action==='inspect'?{status:'running',runningVersion:'0.5.326',files:{}}:{ok:true,status:'running',runningVersion:payload.runtimeVersion};}});
  Object.assign(globals,{__dirname:path.join(packageRoot,'dist/extension'),fs:require('node:fs/promises'),path,console:{log(){},warn(){}},RuntimeManifest_1:require(path.join(packageRoot,'dist/runtime/RuntimeManifest')),
    AgentRuntimeScope_1:require(path.join(packageRoot,'dist/features/AgentRuntimeScope')),mapLimited:async(items,_limit,work)=>{for(const item of items)await work(item);},sftpUploadFilesSucceeded:record=>record.ok===true,
    vscode:{commands:{executeCommand:async(command,args)=>{assert.equal(command,'simpleSftpMac.uploadFiles');uploads.push(args);return{ok:true};}}}});
  const deploy=method('deployLatestAgentRuntime',globals);
  const receipt=await deploy.call(host,false,true,['worker-a'],true);
  assert.deepEqual(calls.map(row=>row.action),['inspect','restart']);assert.ok(calls.every(row=>row.id==='worker-a'));
  assert.equal(uploads.length,1);assert.deepEqual(Array.from(uploads[0].files,file=>file.remoteName),['cluster_agent.py','cluster_scheduler.py']);
  for(const item of uploads[0].files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(item.localPath)).digest('hex'),receipt.manifest.files[item.remoteName]);
  assert.equal(host.lastWorkerProbes['worker-a'],undefined);assert.equal(host.lastWorkerProbes['worker-b'].retained,true);assert.equal(host.lastFullEndpointProbeAt,0);
  await refresh.call(host,localRoot);assert.equal(host.lastWorkerProbes['worker-a'].capabilities.endpoints.projectManagedValidation,1);
  await assert.rejects(submit.call(host,'worker-a','validate-plan',{}, {requiresCapability:['endpoints.projectManagedValidation']}),/PROTOCOL_CHECK_PASSED_WITHOUT_SUBMIT/);
  globals.stringArrayField=(params,key)=>params[key];
  host.lastWorkerProbes['worker-a']={capabilities:{endpoints:{projectManagedValidation:0}}};
  await method('apiAgentLifecycle',globals).call(host,{action:'restart',serverIds:['worker-a'],confirm:true});
  assert.equal(host.lastWorkerProbes['worker-a'],undefined);assert.equal(host.lastWorkerProbes['worker-b'].retained,true);
  await refresh.call(host,localRoot);assert.equal(host.lastWorkerProbes['worker-a'].capabilities.endpoints.projectManagedValidation,1);
  console.log(JSON.stringify({protocolCases:matrix.cases,pairedUpload:true,selectedRestart:true,capabilityRefresh:true,noTraining:true}));
});
