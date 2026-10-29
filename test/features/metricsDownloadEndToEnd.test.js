const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const ts = require("typescript");
// A persistent .ts loader keeps the later direct src requires (ResultCollectionHost, PlanCodeScopeHost,
// WorkspacePathMapper) resolvable after the one-off shim below is restored.
require("../_helpers/registerTsRequire");

const repo = path.join(__dirname, "..", "..");
const tablesPath = path.join(repo, "src", "results", "ProjectResultTables.ts");
const tablesModule = new Module(tablesPath, module);
tablesModule.filename = tablesPath;
tablesModule.paths = Module._nodeModulePaths(path.dirname(tablesPath));
tablesModule._compile(ts.transpileModule(fs.readFileSync(tablesPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, tablesPath);

const uiNotices = [];
const vscode = {
  commands: { executeCommand: async () => ({ ok: true }) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: { withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false }),
    showInformationMessage: async (...args) => { uiNotices.push(["info", ...args]); },
    showWarningMessage: async (...args) => { uiNotices.push(["warning", ...args]); }, setStatusBarMessage() {} },
  Uri: { file: (fsPath) => ({ fsPath }) }, ProgressLocation: { Notification: 1 },
};
const originalLoad = Module._load;
const originalTsLoader = Module._extensions[".ts"];
Module._extensions[".ts"] = (loadedModule, filename) => {
  const source = fs.readFileSync(filename, "utf8") + (filename.endsWith(path.join("src", "extension", "legacy.ts"))
    ? "\nexport { planValidationFromResult };\n" : "");
  loadedModule._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
// 真实 mapper 的 host 侧只接受无越界 POSIX 绝对路径（src/platform/Filesystem.ts:4-10），Windows 宿主的
// 临时目录是盘符路径，会被直接拒；这是宿主路径口径，不是本发布线的行为差异，也不允许为此去放宽生产 mapper。
// 这里沿用已有的 Module._load 注入边界：只为被加载的 legacy 模块提供工作区位置适配器，把 file URI 的盘符
// 路径规范化成正斜杠 hostPath 返回，其余行为原样透传真实 mapper；真实 mapper 自身的“接受 POSIX、拒绝盘符”
// 契约在本文件末尾单独断言，不因为适配器而丢失。
const hostWorkspacePath = fsPath => String(fsPath).replace(/\\/g, "/");
const realWorkspaceMapper = require(path.join(repo, "src/core/WorkspacePathMapper.ts"));
const workspaceLocationAdapter = {
  ...realWorkspaceMapper,
  resolveWorkspaceLocation(uri, config = {}) {
    if (String(uri?.scheme || "").toLowerCase() === "file" && /^[A-Za-z]:[\\/]/.test(String(uri?.fsPath || ""))) {
      const hostPath = hostWorkspacePath(uri.fsPath);
      return { scheme: "file", editorUri: String(uri?.external || "file:///" + hostPath), hostPath, relativePath: "", remote: false };
    }
    return realWorkspaceMapper.resolveWorkspaceLocation(uri, config);
  },
};
const legacyEntryFile = filename => /[\\/](src|dist)[\\/]extension[\\/]legacy\.(ts|js)$/.test(String(filename || ""));
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscode;
  if (request === "../core/WorkspacePathMapper" && legacyEntryFile(parent?.filename)) return workspaceLocationAdapter;
  if (request === "node:worker_threads" || request === "worker_threads") {
    const workerThreads = originalLoad.call(this, request, parent, isMain);
    return { ...workerThreads, Worker: class extends workerThreads.Worker { constructor(filename, options) {
      super(String(filename).endsWith(path.join('src', 'results', 'ProjectResultCatalogWorker.js'))
        ? path.join(repo, 'dist/results/ProjectResultCatalogWorker.js') : filename, options);
    } } };
  }
  if (request.startsWith("../vendor/semver/")) return originalLoad.call(this, path.join(repo, "dist/vendor/semver", request.slice("../vendor/semver/".length)), parent, isMain);
  if (request === "../results/ProjectResultTables" && parent?.filename.endsWith(path.join("src", "extension", "legacy.ts"))) return tablesModule.exports;
  if (request === "../results/ProjectResultCatalog") return originalLoad.call(this, path.join(repo, "dist/results/ProjectResultCatalog.js"), parent, isMain);
  return originalLoad.call(this, request, parent, isMain);
};
const { __syncPendingResultMetricsForTest, RealtimeTunnelPanelProvider, planValidationFromResult } = require("../../src/extension/legacy.ts");
Module._load = originalLoad;
if (originalTsLoader) Module._extensions[".ts"] = originalTsLoader;
else delete Module._extensions[".ts"];

const planFile = "experiments/plans/demo.yaml";
const remoteCsv = "simple_cluster/results/worker-a/seed_metrics.csv";
const localCsvPattern = path.join("experiments", "results", "_unassigned", "plans", tablesModule.exports.planDirectoryKey(planFile), "raw");
const csvFor = (rows) => "case,seed,method,dataset,metric,value\n" + rows.map((row) =>
  `alpha,${row.seed},demo,set,${row.metric},${row.value}`).join("\n") + "\n";

function providerFor(workspace, csvText, oldRegistry) {
  const calls = [];
  const summary = { planFile, planRevision: "rev-1", completedRunId: "run-complete",
    resultOwnerWorkerId: "worker-a", rawResultCsvPath: remoteCsv,
    workerResultTables: [{ workerId: "worker-a", rawResultCsvPath: remoteCsv, aggregateStatus: "ready" }], results: [] };
  const provider = {
    calls, context: { globalStorageUri: { fsPath: workspace } }, client: { getResultsSummary: async () => summary },
    hostOperationLease: { run: async (_request, operation) => operation() },
    workerProbeSignatures: new Map(), workerProbeGenerations: new Map(),
    setupConfig: { workerTunnels: [{ id: "worker-a" }] }, localPlanMetadata: { plans: [{ planFile, revision: "rev-1", seeds: [42, 43] }] },
    selectedRunKeys: new Set(), selectedExperimentIds: new Set(), selectedArchiveKeys: new Set(), selectedTaskUiKeys: new Set(),
    panelSectionInterest: { documentGeneration: "1", mainSection: "results", visibleSections: ["results"], expandedSections: ["results"], pinnedInspectorSection: "" },
    planFileInput: "", selectedPlanId: "", selectedRunKey: "", resultsSummary: undefined,
    captureProjectContext: () => ({ root: workspace, generation: 1 }), projectContextIsCurrent: () => true,
    lastWorkerProbes: {},
    refreshResultCatalogForCurrentInterest: () => undefined,
    refreshDistributedResultSyncProbes: async function () { this.lastWorkerProbes = { "worker-a": { status: "ok" } }; },
    effectiveConnectionMode: () => "tunnel", refreshLocalPlanMetadataForAction: async () => {},
    loadPlanSyncLedger: async () => ({ schemaVersion: 2, entries: { demo: { planFile, revision: "rev-1", runId: "run-complete",
      sourceWorkerId: "worker-a", artifactPaths: [remoteCsv], directoryPaths: ["simple_cluster/results/worker-a"], destinations: {} } } }),
    loadDistributedQueue: async () => ({ schemaVersion: 1, plans: [] }),
    distributedProjectContract: () => ({ resultRowsPath: "test_results/formal_result_rows.csv", fourStatePath: "test_results/four_state_metrics.csv" }),
    schedulerSettings: () => ({ gpuIdleUtilThreshold: 5, gpuIdleMemThresholdMb: 200, sessionCheckMinSeconds: 30, workerStatusTtlSeconds: 180 }),
    workerCodeSyncTargets: () => [{ id: "worker-a", host: "worker-a.example", user: "exp", port: 22,
      remotePath: "/project", transferHost: "worker-a.example", resolvedHost: "worker-a.example" }],
    resolveSelectedPlanFile: () => "", enabledWorkerConfigs: () => [{ id: "worker-a" }], postState() {},
    sftpServerOptions: (target) => ({ id: target.id, host: target.host, user: target.user, port: target.port, remotePath: target.remotePath }),
    loadProjectTableRegistry: async () => oldRegistry || tablesModule.exports.emptyTableRegistry(),
    simpleSftpCapability: async () => ({ methodOptions: { "sync.downloadMappedPaths": { memoryOnly: true, memoryWrapperResults: true } } }),
    simpleSftpApiCall: async (method, params) => {
      calls.push([method, params]);
      if (method === "sync.projectInventory") return { files: { [remoteCsv]: { size: Buffer.byteLength(csvText), sha256: crypto.createHash("sha256").update(csvText).digest("hex") } } };
      if (method === "sync.projectFileStats") return { files: { [remoteCsv]: { size: Buffer.byteLength(csvText) } } };
      assert.equal(method, "sync.downloadMappedPaths");
      assert.equal(params.memoryOnly, true);
      return { ok: true, memoryOnly: true, fileCount: params.entries.length, completedFiles: params.entries.length,
        entries: params.entries.map(entry => ({ remotePath: entry.remotePath, bytes: Buffer.byteLength(csvText),
          sha256: crypto.createHash("sha256").update(csvText).digest("hex"), dataBase64: Buffer.from(csvText).toString("base64") })) };
    },
  };
  provider.testSummary = summary;
  return provider;
}

const {fixture, planText}=require('../_helpers/freshResultHost');
const {ResultCollectionHost}=require('../../src/extension/ResultCollectionHost.ts');
const {resultDigest}=require('../../src/results/FreshResults.ts');



test('single Worker result discovery uses the selected execution environment when sync destinations have no Conda field',async()=>{
  const f=fixture();f.host.workerActionTargets=()=>[{id:'a',conda_env:'chosen-research-env'}];
  const original=f.host.client.getWorkerTasks;
  f.host.client.getWorkerTasks=async(id,options)=>{
    if(options.discovery)assert.equal(options.discovery.condaEnv,'chosen-research-env');
    return original(id,options);
  };
  const report=await __syncPendingResultMetricsForTest(f.host);
  assert.equal(report.current,true,JSON.stringify(report.skipped));assert.equal(report.completed,1);
  assert.ok(f.calls.some(row=>row[0]==='tasks'&&row[2].discovery?.condaEnv==='chosen-research-env'));
});

test('a task environment change during result discovery cancels publication and preserves the previous export',async()=>{
  const f=fixture();let env='first';f.host.workerActionTargets=()=>[{id:'a',condaEnv:env}];
  await __syncPendingResultMetricsForTest(f.host);
  const table=path.join(f.root,'experiments/results/set/final/final.csv'),before=fs.readFileSync(table,'utf8');
  const original=f.host.client.getWorkerTasks;
  f.host.client.getWorkerTasks=async(id,options)=>{const value=await original(id,options);if(options.discovery)env='changed';return value;};
  await assert.rejects(__syncPendingResultMetricsForTest(f.host),/配置已变化/);
  assert.equal(fs.readFileSync(table,'utf8'),before);
});
test("actual UI entry reads native manifests and alias metrics into memory without a result registry", async()=>{
  const f=fixture();f.raw['work_dirs/alpha42/metrics.csv']=csvFor([{seed:42,metric:'AUC',value:.4},{seed:42,metric:'roc_auc',value:.4},{seed:42,metric:'ECE',value:.1}]);
  f.host.parseFreshResultMetric=RealtimeTunnelPanelProvider.prototype.parseFreshResultMetric;
  const report=await __syncPendingResultMetricsForTest(f.host);
  assert.equal(report.current,true,JSON.stringify(report.skipped));assert.equal(report.included.length,1);
  const table=tablesModule.exports.readCsv(fs.readFileSync(path.join(f.root,'experiments/results/set/final/final.csv'),'utf8'));
  assert.equal(table.rows[0][table.header.indexOf('roc_auc_mean')],'0.4');
  assert.equal(fs.existsSync(path.join(f.root,'simple_cluster/results/project_table_registry.json')),false);
  assert.ok(f.calls.filter(call=>call[0]==='sync.downloadMappedPaths').every(call=>call[1].memoryOnly));
  // 原始指标只在内存中解析：本机绝不落任何 raw 缓存目录。
  const walked=[];const visit=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const full=path.join(directory,entry.name);if(entry.isDirectory())visit(full);else walked.push(full);}};
  visit(f.root);
  assert.ok(walked.every(file=>!file.includes(localCsvPattern)&&!file.includes(path.join('_unassigned'))),
    'raw metric bytes are parsed in memory, never saved as local cache');
});

// 旧 0.5.x 门禁的均值/样本SD/来源保证在新直查管线下原样保留：两个正式 job 的别名指标
// （AUC/auc/roc_auc、ECE/ece）归一后 mean=0.5、样本SD=√0.02，来源身份来自本轮主动查询。
test("two formal jobs keep alias-normalized mean, sample SD and per-run provenance in the fresh export", async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'simple-fresh-two-seeds-'));
  fs.mkdirSync(path.join(root,'experiments/plans'),{recursive:true});fs.writeFileSync(path.join(root,planFile),planText,'utf8');
  const jobs=[{index:0,seed:42},{index:1,seed:43}].map(row=>({...row,case:'alpha',
    output_dir:`work_dirs/alpha${row.seed}`,result_csv:`work_dirs/alpha${row.seed}/metrics.csv`,planHash:resultDigest(planText)}));
  const csv={'work_dirs/alpha42/metrics.csv':csvFor([{seed:42,metric:'AUC',value:.4},{seed:42,metric:'roc_auc',value:.4},{seed:42,metric:'ECE',value:.1}]),
    'work_dirs/alpha43/metrics.csv':csvFor([{seed:43,metric:'auc',value:.6},{seed:43,metric:'ECE',value:.3}])};
  for(const job of jobs)csv[`${job.output_dir}/artifact_manifest.json`]=JSON.stringify({simpleExperiment:{runId:'command',status:'completed',mode:'test',
    job:{index:job.index,case:job.case,seed:job.seed},outputDir:job.output_dir,resultCsv:job.result_csv,weights:[]}});
  const calls=[],worker={id:'a',host:'configured-host',port:222,user:'exp',remotePath:'/configured/project'};
  const filesOf=job=>[`${job.output_dir}/artifact_manifest.json`,job.result_csv].map(remotePath=>
    ({remotePath,bytes:Buffer.byteLength(csv[remotePath]),sha256:resultDigest(csv[remotePath])}));
  const host={panelDisposed:false,resultCsvDirectory:'experiments/results',
    captureProjectContext:()=>({root}),projectContextIsCurrent:()=>true,workerCodeSyncTargets:()=>[worker],
    currentResultPlanInputs:async()=>[{planFile,revision:resultDigest(planText),mode:'test',seeds:[42,43],jobCount:2}],
    resultAdapterRules:()=>({}),parseFreshResultMetric:RealtimeTunnelPanelProvider.prototype.parseFreshResultMetric,
    client:{getWorkerTasks:async(id,options)=>{assert.equal(id,'a');
      if(options.discovery)return{queryComplete:true,capabilities:{resultCollection:1},declaredJobs:jobs};
      return{queryComplete:true,capabilities:{resultCollection:1},tasks:[],declaredResults:jobs.map(job=>({index:job.index,
        outputDir:job.output_dir,completed:true,runId:'command',files:filesOf(job),
        runtimeDiagnostics:{schemaVersion:1,commandId:'command',runId:'command',state:'clear',count:0,scanComplete:true}}))};}},
    simpleSftpCapability:async()=>({methodOptions:{'sync.downloadMappedPaths':{memoryOnly:true,memoryWrapperResults:true}}}),
    sftpServerOptions:row=>row,
    simpleSftpApiCall:async(method,params)=>{calls.push([method,params]);assert.equal(method,'sync.downloadMappedPaths');
      return{ok:true,memoryOnly:true,entries:params.entries.map(entry=>({remotePath:entry.remotePath,bytes:entry.bytes,
        sha256:entry.sha256,dataBase64:Buffer.from(csv[entry.remotePath]).toString('base64')}))};},
    refreshLocalResultCatalogForProject:async()=>{},postState(){},recordActionError(){},
    loadDistributedQueue:()=>assert.fail('queue must not supply results'),loadPlanSyncLedger:()=>assert.fail('ledger must not supply results'),
    loadProjectTableRegistry:()=>assert.fail('registry must not supply results')};
  const report=await new ResultCollectionHost(host).update();
  assert.equal(report.current,true,JSON.stringify(report.skipped.concat(report.missing)));
  assert.equal(report.completed,2);assert.deepEqual(report.included,[planFile]);
  const table=tablesModule.exports.readCsv(fs.readFileSync(path.join(root,'experiments/results/set/final/final.csv'),'utf8'));
  assert.equal(table.header.filter(column=>column==='roc_auc_mean').length,1);
  assert.equal(table.rows[0][table.header.indexOf('roc_auc_mean')],'0.5');
  assert.ok(Math.abs(Number(table.rows[0][table.header.indexOf('roc_auc_sd')])-Math.sqrt(0.02))<1e-12);
  assert.equal(table.rows[0][table.header.indexOf('ece_mean')],'0.2');
  assert.ok(Math.abs(Number(table.rows[0][table.header.indexOf('ece_sd')])-Math.sqrt(0.02))<1e-12);
  assert.match(fs.readFileSync(path.join(root,'experiments/results/set/final/final.md'),'utf8'),/0\.5000 ± 0\.1414/);
  // 长表一行一条指标：逐行核验来源身份，再按 seed 聚合别名指标值，全部来自本轮核实集合。
  const bySeed=new Map();
  for(const row of report.results){
    assert.equal(row.runId,'command');assert.equal(row.workerId,'a');
    assert.equal(row.dimensions.case,'alpha');assert.equal(row.dimensions.method,'demo');assert.equal(row.dimensions.dataset,'set');
    const bucket=bySeed.get(row.dimensions.seed)||{};bySeed.set(row.dimensions.seed,bucket);
    for(const [metric,raw] of Object.entries(row.metrics))bucket[metric]=(raw&&raw.value!==undefined)?raw.value:raw;
  }
  assert.deepEqual([...bySeed.keys()].sort(),['42','43'],'every declared job contributes rows from this verified collection');
  assert.deepEqual(bySeed.get('42'),{AUC:0.4,roc_auc:0.4,ECE:0.1});
  assert.deepEqual(bySeed.get('43'),{auc:0.6,ECE:0.3});
  assert.deepEqual(report.jobs.map(job=>job.state),['complete','complete']);
  assert.equal(fs.existsSync(path.join(root,'simple_cluster/results/project_table_registry.json')),false);
  // 一次人工同步只走一次内存映射传输，批量携带全部四个声明文件，且仍按配置的 Worker 端点。
  const downloads=calls.filter(call=>call[0]==='sync.downloadMappedPaths');
  assert.equal(downloads.length,1,'one manual sync batches every declared file into a single memory read');
  const params=downloads[0][1];
  assert.equal(params.memoryOnly,true);assert.equal(params.metricsOnly,true);
  assert.equal(params.confirm,true);assert.equal(params.pathConfirmed,true);
  assert.equal(params.server.host,'configured-host','the mapped transfer follows the configured Worker endpoint');
  assert.equal(params.server.remotePath,'/configured/project');
  assert.deepEqual(new Set(params.entries.map(entry=>entry.remotePath)),new Set(Object.keys(csv)));
  assert.ok(params.entries.every(entry=>!/weight|checkpoint|\.log$/i.test(entry.remotePath)));
  const walked=[];const visit=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const full=path.join(directory,entry.name);if(entry.isDirectory())visit(full);else walked.push(full);}};
  visit(root);
  assert.ok(walked.every(file=>!file.includes(localCsvPattern)&&!file.includes(path.join('_unassigned'))),
    'raw metric bytes are never written as a local cache');
});

test("conflicting aliases remain visible as an unknown job and do not borrow the previous export",async()=>{
  const f=fixture();f.host.parseFreshResultMetric=RealtimeTunnelPanelProvider.prototype.parseFreshResultMetric;
  f.raw['work_dirs/alpha42/metrics.csv']=csvFor([{seed:42,metric:'AUC',value:.4}]);
  await __syncPendingResultMetricsForTest(f.host);
  f.raw['work_dirs/alpha42/metrics.csv']=csvFor([{seed:42,metric:'AUC',value:.4},{seed:42,metric:'roc_auc',value:.8}]);
  const report=await __syncPendingResultMetricsForTest(f.host);
  assert.equal(report.results.length,0);assert.equal(report.jobs[0].state,'unknown');assert.match(report.missing.join(' '),/指标.*冲突/);
});

// 旧"坏内存响应保留既有产物"门禁在直查管线下的等价形式：未声明/篡改响应必须显式失败，
// 已发布的 CSV/Markdown 保持字节一致，绝不从旧数据补齐本轮结果。
test("corrupt or unrequested memory responses keep the published CSV and Markdown byte-identical",async()=>{
  const corruptions=[
    [entry=>({...entry,remotePath:'simple_cluster/results/other/seed_metrics.csv'}),/RESULT_MEMORY_READ_UNDECLARED/],
    [entry=>({...entry,sha256:'0'.repeat(64)}),/RESULT_CONTENT_CHANGED/],
    [entry=>({...entry,bytes:entry.bytes+1}),/RESULT_CONTENT_CHANGED/],
    [entry=>({...entry,dataBase64:Buffer.from('invalid').toString('base64')}),/RESULT_CONTENT_CHANGED/],
  ];
  for(const [corrupt,expected] of corruptions){
    const f=fixture();
    f.host.parseFreshResultMetric=RealtimeTunnelPanelProvider.prototype.parseFreshResultMetric;
    f.raw['work_dirs/alpha42/metrics.csv']=csvFor([{seed:42,metric:'AUC',value:.9}]);
    await __syncPendingResultMetricsForTest(f.host);
    const outputs=['experiments/results/set/final/final.csv','experiments/results/set/final/final.md']
      .map(relative=>path.join(f.root,relative));
    const before=outputs.map(file=>fs.readFileSync(file,'utf8'));
    const pristine=f.host.simpleSftpApiCall;
    f.host.simpleSftpApiCall=async(...args)=>{const response=await pristine(...args);
      return args[0]==='sync.downloadMappedPaths'?{...response,entries:response.entries.map(corrupt)}:response;};
    const callsBefore=f.calls.filter(call=>call[0]==='sync.downloadMappedPaths').length;
    const report=await __syncPendingResultMetricsForTest(f.host);
    assert.equal(report.results.length,0,'a corrupted response cannot enter this export');
    assert.equal(report.jobs[0].state,'unknown');
    assert.match(report.missing.join(' '),expected);
    assert.equal(f.calls.filter(call=>call[0]==='sync.downloadMappedPaths').length,callsBefore+1,
      'a rejected read is not retried through an alternate path');
    assert.deepEqual(outputs.map(file=>fs.readFileSync(file,'utf8')),before);
    assert.equal(fs.existsSync(path.join(f.root,'simple_cluster/results/project_table_registry.json')),false);
  }
});

test("pulled completion automatically updates results without mirroring, remote aggregation or persisted completion marks",async()=>{
  const f=fixture();const {resultCollectionHost}=require('../../src/extension/ResultCollectionHost.ts');
  const service=resultCollectionHost(f.host);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('automatic summary did not complete')),3000);
    f.host.recordActionError=error=>{clearTimeout(timer);reject(Error(JSON.stringify(error)));};
    f.host.postState=()=>{clearTimeout(timer);resolve();};
    service.observe({workerId:'a',queryComplete:true,capabilities:{resultCollection:1},tasks:[{commandId:'command',observation:{result:{verified:true,runId:'command',status:'completed'},tmux:{dead:true,exitCode:0}}}]});
  });
  assert.equal(f.host.resultsSummary.current,true,JSON.stringify(f.host.resultsSummary.skipped));assert.equal(f.host.resultsSummary.completed,1);
  assert.ok(!f.calls.some(call=>/merge|rebuild|serverToServer/.test(call[0])));
});
test("API and legacy parse entry use the same fresh collection as UI",async()=>{
  const f=fixture();
  const report=await RealtimeTunnelPanelProvider.prototype.apiResultsList.call(f.host,{planFile});
  assert.equal(report.source,'active_query');assert.equal(report.results.length,1);
  const parsed=await RealtimeTunnelPanelProvider.prototype.runActionCommandCore.call(f.host,'parseResults',{});
  assert.equal(parsed.source,'active_query');assert.equal(parsed.completed,1);
});

test("late local lock ACK is fenced before the captured Worker client can send", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p6-late-ack-"));
  try {
    vscode.workspace.workspaceFolders = [{ uri: { scheme: "file", path: workspace.replace(/\\/g, "/"),
      fsPath: workspace, toString: () => "file://" + workspace.replace(/\\/g, "/") } }];
    let sends = 0;
    const provider = providerFor(workspace, "");
    provider.context.globalStorageUri.fsPath = workspace;
    provider.client = { postWorkerAction: async () => { sends += 1; return { status: "queued" }; } };
    provider.workerActionTargets = () => [{ id: "worker-a", condaEnv: "env-a" }];
    provider.localCodeManifestCacheFile = () => path.join(workspace, "manifest-cache.json");
    const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
    host.distributedQueueGeneration = 7;
    let manifestBuilds = 0;
    host.buildDistributedJobCodeManifest = async () => { manifestBuilds += 1; throw new Error("code manifest must not be prepared before the fence"); };
    host.lastWorkerProbes = { 'worker-a': { capabilities: { endpoints: { declaredJobPaths: true, formalJobIdentityEnv: 1, taskShellEnvironment: 1, projectManagedValidation: 1, gpuQuotaScheduling: 1, gpuMemoryBudgetScheduling: 1 } } } };
    host.withRemoteActionResource = async (_workerId, _resource, _request, callback) => {
      host.distributedQueueGeneration += 1;
      return callback();
    };
    const emptyManifestFingerprint = crypto.createHash("sha256").update("[]").digest("hex");
    await assert.rejects(() => host.sendDistributedJob(
      { id: "plan-a", projectId: "project-a", resultPathPolicy: "declared", executionMode: "train_test", planJobCount: 1, planFile, revision: "rev-1", codeFingerprint: emptyManifestFingerprint },
      { index: 0, case: "alpha", seed: 42, outputDir: "runs/a", collectionResultCsv: "tmp/result/a.csv" }, "worker-a", undefined, "command-a",
    ), /提交已取消或项目已切换/);
    assert.equal(sends, 0, "generation changed while awaiting the local resource lock must block the remote write");
    assert.equal(manifestBuilds, 0, "a late lock ACK must fence before any code-manifest preparation runs");
  } finally {
    vscode.workspace.workspaceFolders = [];
  }
});

test("a granted local lock ACK with unchanged context still sends the durable job with its proof fields", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p6-ack-ok-"));
  try {
    vscode.workspace.workspaceFolders = [{ uri: { scheme: "file", path: workspace.replace(/\\/g, "/"),
      fsPath: workspace, toString: () => "file://" + workspace.replace(/\\/g, "/") } }];
    const sent = [];
    const provider = providerFor(workspace, "");
    provider.context.globalStorageUri.fsPath = workspace;
    provider.client = { postWorkerAction: async (_workerId, _action, request) => { sent.push(request); return { status: "queued" }; } };
    provider.workerActionTargets = () => [{ id: "worker-a", condaEnv: "env-a" }];
    provider.localCodeManifestCacheFile = () => path.join(workspace, "manifest-cache.json");
    const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
    host.distributedQueueGeneration = 7;
    let manifestBuilds = 0;
    host.buildDistributedJobCodeManifest = async () => { manifestBuilds += 1; throw new Error("a durable proof worker must not rebuild the local manifest"); };
    const emptyManifestFingerprint = crypto.createHash("sha256").update("[]").digest("hex");
    host.lastWorkerProbes = { 'worker-a': { capabilities: { endpoints: { declaredJobPaths: true, formalJobIdentityEnv: 1, taskShellEnvironment: 1, projectManagedValidation: 1, gpuQuotaScheduling: 1, gpuMemoryBudgetScheduling: 1 }, actionEndpoints: { "register-code-sync-proof": true } } } };
    host.lastCodeSyncState = { workerVersions: { 'worker-a': { codeSyncProofId: "proof-9", manifestDigest: emptyManifestFingerprint, fingerprint: emptyManifestFingerprint } } };
    host.withRemoteActionResource = async (_workerId, _resource, _request, callback) => callback();
    const receipt = await host.sendDistributedJob(
      { id: "plan-a", projectId: "project-a", resultPathPolicy: "declared", executionMode: "train_test", planJobCount: 1, planFile, revision: "rev-1", codeFingerprint: emptyManifestFingerprint },
      { index: 0, case: "alpha", seed: 42, outputDir: "runs/a", collectionResultCsv: "tmp/result/a.csv" }, "worker-a", undefined, "command-a",
    );
    assert.deepEqual(receipt, { status: "queued" });
    assert.equal(sent.length, 1, "an undisrupted lock ACK must still deliver exactly one durable job");
    assert.equal(manifestBuilds, 0, "the persistent proof path carries the proof id without touching the local tree");
    assert.equal(sent[0].codeSyncProofId, "proof-9", "the deferred proof preparation must rejoin the request before transport");
    assert.equal(sent[0].manifestDigest, emptyManifestFingerprint);
    assert.equal(sent[0].projectId, "project-a");
    assert.equal(sent[0].outputDir, "runs/a");
    assert.equal(sent[0].planFile, planFile);
    assert.equal(sent[0].resultPathPolicy, "declared");
  } finally {
    vscode.workspace.workspaceFolders = [];
  }
});

test("a normal send without a resolvable local project root fails explicitly before manifest preparation", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p6-no-root-"));
  try {
    vscode.workspace.workspaceFolders = [];
    let sends = 0;
    const provider = providerFor(workspace, "");
    provider.context.globalStorageUri.fsPath = workspace;
    provider.client = { postWorkerAction: async () => { sends += 1; return { status: "queued" }; } };
    provider.workerActionTargets = () => [{ id: "worker-a", condaEnv: "env-a" }];
    provider.localCodeManifestCacheFile = () => path.join(workspace, "manifest-cache.json");
    const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
    host.distributedQueueGeneration = 7;
    let manifestBuilds = 0;
    host.buildDistributedJobCodeManifest = async () => { manifestBuilds += 1; throw new Error("manifest preparation must be blocked by the explicit root guard"); };
    host.lastWorkerProbes = { 'worker-a': { capabilities: { endpoints: { declaredJobPaths: true, formalJobIdentityEnv: 1, taskShellEnvironment: 1, projectManagedValidation: 1, gpuQuotaScheduling: 1, gpuMemoryBudgetScheduling: 1 } } } };
    host.withRemoteActionResource = async (_workerId, _resource, _request, callback) => callback();
    const emptyManifestFingerprint = crypto.createHash("sha256").update("[]").digest("hex");
    await assert.rejects(() => host.sendDistributedJob(
      { id: "plan-a", projectId: "project-a", resultPathPolicy: "declared", executionMode: "train_test", planJobCount: 1, planFile, revision: "rev-1", codeFingerprint: emptyManifestFingerprint },
      { index: 0, case: "alpha", seed: 42, outputDir: "runs/a", collectionResultCsv: "tmp/result/a.csv" }, "worker-a", undefined, "command-a",
    ), /缺少本机项目根目录/);
    assert.equal(sends, 0, "a request without a resolvable project root must never reach the Worker transport");
    assert.equal(manifestBuilds, 0, "the explicit root guard must reject before any local manifest I/O");
  } finally {
    vscode.workspace.workspaceFolders = [];
  }
});

test("actual plan validation parser prefers the latest complete 0.5.179 wrapped payload", () => {
  const rows = [0, 1, 2].map((index) => ({ index, case: "alpha", seed: 42 + index, output_dir: "runs/a/" + index }));
  const parsed = planValidationFromResult({
    latestEvent: { payload: { validation: { ok: true, jobs: rows } } },
    payload: { validation: { ok: true, jobs: [rows[0]] } },
    result: { validation: { ok: true, jobs: [] } },
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.jobs.map((job) => job.index), [0, 1, 2], "the newest full preflight list must win over stale wrappers");
  for (const wrapper of [
    { payload: { validation: { jobs: rows } } },
    { result: { validation: { jobs: rows } } },
    { validation: { jobs: rows } },
  ]) assert.deepEqual(planValidationFromResult(wrapper).jobs.map((job) => job.index), [0, 1, 2]);
  for (const validation of [null, [], "bad"]) assert.equal(planValidationFromResult({
    latestEvent: { payload: { validation } }, payload: { validation: { ok: true, jobs: rows } },
  }), undefined, "a malformed latest receipt must not borrow stale validation");
});

// ─── R22 race regressions: a fence flip landing while code-source preparation is awaited ───
// The lazy preparation runs inside the lock callback / protocol-2 branch after the pre-send
// fence. The lease guarantees resource ownership only, so both transports must re-check the
// fence synchronously after the awaited preparation and before transmissionStarted.
const scopeHostModule = require(path.join(repo, "src/extension/PlanCodeScopeHost.ts"));
const scopeHostOriginal = {
  supportsPlanCodeScope: scopeHostModule.supportsPlanCodeScope,
  verifyWorkerPlanSource: scopeHostModule.verifyWorkerPlanSource,
};
// 工作区根必须能被 resolveWorkspaceLocation 解析出 hostPath，否则 workspaceRoot() 退化成 undefined，
// 测的就不是“同一根在册、随后切换”的围栏。适配器把盘符根规范成正斜杠 hostPath，因此快照键等
// 以 hostPath 为键的地方必须用 hostWorkspacePath() 同一口径，不能再假设宿主原始反斜杠写法。
const workspaceFolder = (fsPath) => ({ uri: { scheme: "file", path: fsPath, fsPath,
  toString: () => "file://" + hostWorkspacePath(fsPath) } });

function raceFixture(mode, flip) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p6-race-"));
  vscode.workspace.workspaceFolders = [{ uri: { scheme: "file", path: workspace.replace(/\\/g, "/"),
    fsPath: workspace, toString: () => "file://" + workspace.replace(/\\/g, "/") } }];
  const sent = [];
  const provider = providerFor(workspace, "");
  provider.context.globalStorageUri.fsPath = workspace;
  provider.client = { postWorkerAction: async (_w, _a, request) => { sent.push(request); return { status: "queued" }; } };
  provider.workerActionTargets = () => [{ id: "worker-a", condaEnv: "env-a" }];
  provider.localCodeManifestCacheFile = () => path.join(workspace, "manifest-cache.json");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  host.distributedQueueGeneration = 7;
  host.lastWorkerProbes = { 'worker-a': { status: 'ok', capabilities: { endpoints: { declaredJobPaths: true, formalJobIdentityEnv: 1, taskShellEnvironment: 1, projectManagedValidation: 1, gpuQuotaScheduling: 1, gpuMemoryBudgetScheduling: 1, planCodeScope: 1 } } } };
  let manifestBuilds = 0;
  host.buildDistributedJobCodeManifest = async () => { manifestBuilds += 1; throw new Error("source-branch preparation must not build a manifest"); };
  scopeHostModule.supportsPlanCodeScope = () => true;
  scopeHostModule.verifyWorkerPlanSource = async () => {
    await new Promise(resolve => setImmediate(resolve));
    flip(host);
    await new Promise(resolve => setImmediate(resolve));
    return { policy: "plan-dependency-verified", verifiedAt: "now" };
  };
  if (mode === "p2") {
    host.lastWorkerTaskSnapshots = new Map([
      // 生产用 `${workspaceRoot()}\u0000${workerId}` 取快照，适配器给出的 hostPath 是正斜杠形态。
      [hostWorkspacePath(workspace) + "\u0000worker-a", { capabilities: { taskLifecycle: 2 } }],
      [workspace + "\u0000worker-a", { capabilities: { taskLifecycle: 2 } }],
      [String(undefined) + "\u0000worker-a", { capabilities: { taskLifecycle: 2 } }],
    ]);
  } else {
    host.withRemoteActionResource = async (_w, _r, _req, callback) => callback();
  }
  const plan = { id: "plan-a", projectId: "project-a", resultPathPolicy: "declared", executionMode: "train_test", planJobCount: 1, planFile, revision: "rev-1", codeFingerprint: "fp-source-branch" };
  const job = mode === "p2"
    ? { index: 0, lifecycleProtocol: 2, case: "alpha", seed: 42, outputDir: "runs/a", collectionResultCsv: "tmp/result/a.csv" }
    : { index: 0, case: "alpha", seed: 42, outputDir: "runs/a", collectionResultCsv: "tmp/result/a.csv" };
  return { workspace, sent, host, plan, job, manifestBuilds: () => manifestBuilds };
}

async function assertFencedRace(label, f) {
  const outcome = await f.host.sendDistributedJob(f.plan, f.job, "worker-a", undefined, "command-a")
    .then(r => ({ ok: r && r.status }), e => ({ err: String(e && e.message) }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.sent.length, 0, label + ": a flip during awaited preparation must never post via the old captured client");
  assert.ok(outcome.err && /提交已取消或项目已切换/.test(outcome.err), label + ": must fail with the cancellation fence error");
}

test("R0 control: an undisrupted source-branch send still joins the verified executionSource once", async () => {
  const f = raceFixture("legacy", () => {});
  try {
    const receipt = await f.host.sendDistributedJob(f.plan, f.job, "worker-a", undefined, "command-a");
    assert.deepEqual(receipt, { status: "queued" });
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].executionSource.policy, "plan-dependency-verified", "the normal path still joins proof fields before transport");
    assert.equal(f.manifestBuilds(), 0);
  } finally {
    Object.assign(scopeHostModule, scopeHostOriginal);
    vscode.workspace.workspaceFolders = [];
  }
});

for (const [label, flip] of [
  ["R1 legacy generation flip during preparation", host => { host.distributedQueueGeneration += 1; }],
  ["R2 legacy captured-client replacement during preparation", host => { host.client = { postWorkerAction: async () => { throw new Error("OLD CLIENT STILL POSTED"); } }; }],
  ["R3 legacy stop-epoch opening during preparation", host => { host.distributedPlanStopEpoch = 1; }],
]) test(label + " must send nothing", async () => {
  const f = raceFixture("legacy", flip);
  try { await assertFencedRace(label, f); } finally {
    Object.assign(scopeHostModule, scopeHostOriginal);
    vscode.workspace.workspaceFolders = [];
  }
});

test("R4 protocol-2 generation flip during preparation must send nothing", async () => {
  const f = raceFixture("p2", host => { host.distributedQueueGeneration += 1; });
  try { await assertFencedRace("R4", f); } finally {
    Object.assign(scopeHostModule, scopeHostOriginal);
    vscode.workspace.workspaceFolders = [];
  }
});

test("R5 flip plus a preparation failure stays dispatchNotSent with zero sends for honest release", async () => {
  const f = raceFixture("legacy", host => { host.distributedQueueGeneration += 1; });
  scopeHostModule.verifyWorkerPlanSource = async () => {
    await new Promise(resolve => setImmediate(resolve));
    throw new Error("source verification failed after fence flip");
  };
  try {
    await assert.rejects(() => f.host.sendDistributedJob(f.plan, f.job, "worker-a", undefined, "command-a"),
      (error) => { assert.equal(error.dispatchNotSent, true, "an unsent failure must stay dispatchNotSent for honest release"); return true; });
    assert.equal(f.sent.length, 0);
  } finally {
    Object.assign(scopeHostModule, scopeHostOriginal);
    vscode.workspace.workspaceFolders = [];
  }
});

for (const mode of ["legacy", "p2"]) test(`R6 workspace switch between two resolvable roots during ${mode} preparation must send nothing`, async () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "p6-switch-a-"));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "p6-switch-b-"));
  const f = raceFixture(mode, () => { vscode.workspace.workspaceFolders = [workspaceFolder(rootB)]; });
  try {
    if (mode === "p2") f.host.lastWorkerTaskSnapshots = new Map([[hostWorkspacePath(rootA) + "\u0000worker-a", { capabilities: { taskLifecycle: 2 } }]]);
    vscode.workspace.workspaceFolders = [workspaceFolder(rootA)];
    await assertFencedRace("R6-" + mode, f);
  } finally {
    Object.assign(scopeHostModule, scopeHostOriginal);
    vscode.workspace.workspaceFolders = [];
  }
});

// 适配器只补宿主口径，不改生产规则：真实 mapper 必须继续接受无越界 POSIX 根、继续拒绝盘符根与越界段，
// 否则“Mac 侧工作区身份只认无越界 POSIX 绝对路径”这条生产契约就没人守；适配器本身只允许把盘符根规范成正斜杠。
test("the real workspace mapper keeps its POSIX-only contract while the host adapter only normalises separators", () => {
  const posix = realWorkspaceMapper.resolveWorkspaceLocation(
    { scheme: "file", path: "/Users/demo/研究 项目", fsPath: "/Users/demo/研究 项目", toString: () => "file:///Users/demo/研究 项目" }, {});
  assert.equal(posix.hostPath, "/Users/demo/研究 项目");
  assert.equal(posix.remote, false);
  assert.throws(() => realWorkspaceMapper.resolveWorkspaceLocation({ scheme: "file", path: "D:/demo", fsPath: "D:\\demo" }, {}),
    /必须是无越界路径段的 POSIX 绝对路径/);
  assert.throws(() => realWorkspaceMapper.resolveWorkspaceLocation({ scheme: "file", path: "/a/../../etc", fsPath: "/a/../../etc" }, {}),
    /必须是无越界路径段的 POSIX 绝对路径/);
  assert.equal(workspaceLocationAdapter.resolveWorkspaceLocation({ scheme: "file", fsPath: "D:\\demo\\研究 项目" }, {}).hostPath, "D:/demo/研究 项目");
});
