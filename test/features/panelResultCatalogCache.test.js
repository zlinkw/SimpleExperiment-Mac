const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
require("../_helpers/registerTsRequire");
const LatestResultExport = require("../../src/results/LatestResultExport.ts");

const source = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
const provider = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "RealtimeTunnelPanelProvider");
const names = new Set(["resultCatalogKey", "invalidateResultCatalogCache", "hasResultCatalogForRoot", "cachedResultCatalog", "compactResultTablesFromCatalog", "inspectResultCatalogInputs", "scheduleResultCatalogRefresh", "finishQueuedResultCatalogRefresh", "startResultCatalogRefreshWorker", "refreshLocalResultsFromUi", "refreshLocalResultCatalogForProject", "cancelResultCatalogRefresh"]);
const methods = provider.members.filter(node => node.name && names.has(node.name.getText(ast)));
const code = ts.transpileModule(`class Subject { ${methods.map(node => node.getText(ast)).join("\n")} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const sandbox = {
  path,
  safeWorkspaceChildPath: new Function("path", ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="safeWorkspaceChildPath").getText(ast)+";return safeWorkspaceChildPath;")(path),
  workspaceRoot: () => "C:/workspace",
  DEFAULT_RESULT_CSV_DIR: "experiments/results", Date, console,
  readLatestResultExport:async()=>undefined,
  fs: {lstat:async()=>({...await sandbox.fs.stat(),isFile:()=>true,isSymbolicLink:()=>false})}, ProjectResultPublication: { projectResultPublicationJournalPath: root => path.join(root, "journal.json"), MAX_PROJECT_RESULT_JOURNAL_BYTES: 32 * 1024 * 1024 },
  ProjectResultTables: { buildTables: () => ({}) }, mapLimited: async (items, _limit, work) => Promise.all(items.map(work)),
  pluginProjectAdapterRules: () => ({ planDatasetMapping: {} }),
  PanelStateProjection_1: { panelInterestedSections: () => new Set(["results"]) },
  errorMessage: value => value instanceof Error ? value.message : String(value),
};
require("vm").runInNewContext(`${code}; this.Subject = Subject;`, sandbox);

test("only the current export signature invalidates catalog inputs; retired journals cannot block it", async () => {
  const subject=new sandbox.Subject();subject.resultCsvDirectory="experiments/results";
  let stamp=1,read=0;
  sandbox.fs.stat=async()=>({dev:1,ino:2,size:100,mtimeMs:stamp,ctimeMs:stamp});
  sandbox.fs.readFile=async()=>{read++;throw Error("old publication journal must not be read");};
  const first=await subject.inspectResultCatalogInputs("C:/workspace");
  assert.equal(first.publicationPending,false);stamp=2;
  assert.notEqual((await subject.inspectResultCatalogInputs("C:/workspace")).signature,first.signature);
  assert.equal(read,0);
  const lstat=sandbox.fs.lstat;
  sandbox.fs.lstat=async()=>({isFile:()=>false,isSymbolicLink:()=>true});
  await assert.rejects(subject.inspectResultCatalogInputs("C:/workspace"),/普通文件/);
  sandbox.fs.lstat=lstat;
});

test("malformed current exports and unsafe linked files fail explicitly", async () => {
  const root=fs.mkdtempSync(path.join(require("node:os").tmpdir(),"latest-export-validation-"));
  fs.mkdirSync(path.join(root,"results"));const file=path.join(root,"results/latest-results.json");
  for(const text of ["invalid-json",JSON.stringify({schemaVersion:1,source:"historical_cache",jobs:[],tables:[]}),
    JSON.stringify({schemaVersion:1,source:"active_query",jobs:[],tables:[{relativePath:"../escape.csv",markdownPath:"report.md",header:[],rows:[],markdown:""}]})]){
    fs.writeFileSync(file,text);await assert.rejects(LatestResultExport.readLatestResultExport(root,"results"));
  }
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,source:"active_query",jobs:[],tables:[]}));
  fs.linkSync(file,path.join(root,"results/retained-hardlink.json"));
  await assert.rejects(LatestResultExport.readLatestResultExport(root,"results"),/RESULT_EXPORT_PATH_UNSAFE/);
  // Missing current exports are empty; old registry/journal presence cannot supply rows.
  const empty=fs.mkdtempSync(path.join(require("node:os").tmpdir(),"latest-export-missing-"));
  fs.mkdirSync(path.join(empty,"simple_cluster/results"),{recursive:true});
  fs.writeFileSync(path.join(empty,"simple_cluster/results/project_table_registry.json"),"{}");
  assert.equal(await LatestResultExport.readLatestResultExport(empty,"results"),undefined);
  assert.deepEqual((await LatestResultExport.latestResultCatalog(empty,"results")).datasets,[]);
});

test("current export reader rejects more than 32 MiB before parsing", async () => {
  const root=fs.mkdtempSync(path.join(require("node:os").tmpdir(),"latest-export-bounds-"));
  fs.mkdirSync(path.join(root,"results"));const file=path.join(root,"results/latest-results.json");
  const fd=fs.openSync(file,"w");try{fs.ftruncateSync(fd,32*1024*1024+1);}finally{fs.closeSync(fd);}
  await assert.rejects(LatestResultExport.readLatestResultExport(root,"results"),/RESULT_EXPORT_TOO_LARGE/);
});

test("successful partial sync reaches ready catalog and publishes its tables through the real worker lifecycle", async () => {
  const catalog = { datasets: [{ name: "A", datasetKey: "a", tables: [{ tableKey: "a/final", kind: "final", path: "final.csv", rowCount: 17 }] }] };
  sandbox.fs.stat = async () => ({ dev: 1, ino: 2, size: 100, mtimeMs: 1, ctimeMs: 1 });
  sandbox.fs.readFile = async () => JSON.stringify({ schemaVersion: 1, status: "committed" });
  sandbox.__dirname = "C:/extension/dist";
  sandbox.Worker = class extends require("node:events").EventEmitter {
    postMessage(request) { queueMicrotask(() => this.emit("message", { id: request.id, catalog })); }
    async terminate() { this.emit("exit", 1); }
  };
  const subject = new sandbox.Subject();
  Object.assign(subject, { resultCsvDirectory: "experiments/results", resultCatalogDirtyGeneration: 1,
    resultCatalogRefreshSequence: 0, resultCatalogTtlMs: 5000, resultCatalogStatus: "loading", panelSectionInterest: {},
    resultSyncReport: { incorporated: 17, failed: 3 } });
  subject.scheduleResultCatalogRefreshTimer = () => undefined;
  const posted = [];
  subject.postState = () => posted.push({ status: subject.resultCatalogStatus, tables: subject.resultCatalogCache?.tables });
  subject.scheduleResultCatalogRefresh({ root: "C:/workspace", mappings: {}, key: subject.resultCatalogKey("C:/workspace", {}) });
  for (let turn = 0; turn < 5 && !posted.length; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(subject.resultCatalogStatus, "ready");
  assert.equal(subject.resultCatalogCache.catalog, catalog);
  assert.equal(posted[0].tables[0].rowCount, 17);
  assert.equal(subject.resultCatalogRefreshWorker, undefined);
  assert.equal(subject.resultCatalogRefreshError, "");
});

test("packaged extension directory resolves and runs the real catalog worker without any network", async () => {
  const root = path.resolve(__dirname, "../..");
  const subject = new sandbox.Subject();
  const saved = { root: sandbox.workspaceRoot, worker: sandbox.Worker, fs: sandbox.fs, dirname: sandbox.__dirname };
  sandbox.workspaceRoot = () => root;
  sandbox.fs = require("node:fs/promises");
  sandbox.Worker = require("node:worker_threads").Worker;
  sandbox.__dirname = path.dirname(require.resolve("../../dist/extension/legacy.js"));
  Object.assign(subject, { resultCsvDirectory: "experiments/results", resultCatalogDirtyGeneration: 0,
    resultCatalogRefreshSequence: 0, resultCatalogTtlMs: 5000, panelSectionInterest: {}, resultCatalogStatus: "loading" });
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("real catalog worker did not finish")), 3000);
      subject.postState = resolve;
      subject.scheduleResultCatalogRefreshTimer = () => undefined;
      subject.scheduleResultCatalogRefresh({ root, mappings: {}, key: subject.resultCatalogKey(root, {}) });
    });
    assert.equal(subject.resultCatalogStatus, "ready", subject.resultCatalogRefreshError);
    assert.ok(Array.isArray(subject.resultCatalogCache.catalog.datasets));
  } finally {
    clearTimeout(timer);
    subject.cancelResultCatalogRefresh();
    sandbox.workspaceRoot = saved.root; sandbox.Worker = saved.worker; sandbox.fs = saved.fs; sandbox.__dirname = saved.dirname;
  }
});

test("manual local refresh resets read errors and rescans independently of failed or busy remote sync", async () => {
  assert.equal(typeof sandbox.Subject.prototype.refreshLocalResultsFromUi, "function");
  const subject = new sandbox.Subject();
  Object.assign(subject, { resultCatalogDirtyGeneration: 0, resultCatalogRefreshSequence: 0,
    resultCatalogRefreshError: "old read error", resultCatalogRefreshFailedKey: "old", resultCatalogRefreshBackoffUntil: Date.now() + 30000,
    resultSyncReport: { failed: 11 }, manualResultSyncInFlight: true, withProjectResultPublicationLease:async(_root,_dir,work)=>work() });
  subject.captureProjectContext = () => ({ root: "C:/workspace" });
  subject.projectContextIsCurrent = () => true;
  subject.loadProjectTableRegistry = async () => ({ schemaVersion: 1, plans: {} });
  let rescans = 0, posts = 0;
  subject.readProjectResultCatalog = async (_root, _mappings, _dir, options) => { assert.equal(options.worker, true); return { datasets: [] }; };
  subject.refreshResultCatalogForCurrentInterest = () => { rescans++; };
  subject.postState = () => { posts++; };
  subject.cancelResultCatalogRefresh = () => undefined;
  await subject.refreshLocalResultsFromUi();
  assert.equal(rescans, 1);
  assert.equal(posts, 1);
  assert.equal(subject.resultCatalogRefreshError, "");
  assert.equal(subject.resultCatalogRefreshBackoffUntil, 0);
  assert.equal(subject.resultSyncReport.failed, 11);
});

test("cancelled catalog generations cannot replace the refreshed local results or surface late errors", async () => {
  const subject = new sandbox.Subject();
  const saved = { worker: sandbox.Worker, dirname: sandbox.__dirname };
  const workers = [];
  sandbox.__dirname = path.dirname(require.resolve("../../dist/extension/legacy.js"));
  sandbox.Worker = class extends require("node:events").EventEmitter {
    constructor() { super(); workers.push(this); }
    postMessage() {}
    async terminate() {}
  };
  Object.assign(subject, { resultCsvDirectory: "experiments/results", resultCatalogDirtyGeneration: 0,
    resultCatalogRefreshSequence: 1, resultCatalogRefreshError: "", resultCatalogTtlMs: 5000 });
  const current = { datasets: [{ tables: [{ kind: "final", rowCount: 17 }] }] };
  subject.resultCatalogCache = { key: subject.resultCatalogKey("C:/workspace", {}), catalog: current };
  subject.scheduleResultCatalogRefreshTimer = () => undefined;
  let posts = 0;
  subject.postState = () => { posts++; };
  try {
    const request = { root: "C:/workspace", mappings: {}, key: subject.resultCatalogKey("C:/workspace", {}), registryStat: "old" };
    subject.startResultCatalogRefreshWorker(request, 1);
    subject.cancelResultCatalogRefresh();
    workers[0].emit("message", { id: 1, catalog: { datasets: [] } });
    workers[0].emit("error", new Error("late cancelled read"));
    workers[0].emit("exit", 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(subject.resultCatalogCache.catalog, current);
    assert.equal(subject.resultCatalogRefreshError, "");
    assert.equal(posts, 0);
  } finally {
    subject.cancelResultCatalogRefresh();
    sandbox.Worker = saved.worker; sandbox.__dirname = saved.dirname;
  }
});

test("buildState reads a UI-light catalog cache while catalog scanning stays in a worker", () => {
  const subject = new sandbox.Subject();
  subject.resultCsvDirectory = "experiments/results";
  subject.resultCatalogDirtyGeneration = 0;
  subject.resultCatalogTtlMs = 5000;
  const catalog = { datasets: [{ name: "A", datasetKey: "a", tables: [{ tableKey: "a/final", dataset: "A", kind: "final", header: ["dataset"], values: { dataset: ["A"] }, path: "a.csv", rowCount: 1, plans: ["must-not-copy"] }], plans: [{ artifacts: ["large-plan-artifact-list"] }] }], fullPlanCache: ["omit"] };
  subject.resultCatalogCache = { key: subject.resultCatalogKey("C:/workspace", { a: "A" }), expiresAt: Date.now() + 5000, catalog };
  subject.refreshResultCatalogForCurrentInterest = () => undefined;
  const first = subject.cachedResultCatalog("C:/workspace", { a: "A" });
  const second = subject.cachedResultCatalog("C:/workspace", { a: "A" });
  assert.equal(first, catalog);
  assert.equal(first, second);
  const compact = subject.compactResultTablesFromCatalog(first);
  assert.equal(compact.length, 1);
  assert.equal("plans" in compact[0], false);
  subject.invalidateResultCatalogCache("test-write");
  assert.equal(subject.cachedResultCatalog("C:/workspace", { a: "A" }), catalog, "last-known-good results stay visible during background refresh");

  const buildStateStart = source.indexOf("private buildState(");
  const buildStateEnd = source.indexOf("\n    currentUiLayoutState()", buildStateStart);
  const buildState = source.slice(buildStateStart, buildStateEnd);
  assert.equal((buildState.match(/ProjectResultTables\.resultCatalog\(/g) || []).length, 0);
  assert.match(buildState, /this\.cachedResultCatalog\(/);
  assert.match(buildState, /this\.compactResultTablesFromCatalog\(resultCatalog\)/);
  assert.doesNotMatch(buildState, /ProjectResultTables\.tableCatalog\(/);
  assert.match(buildState, /const timing: PanelBuildTiming/);
  assert.match(buildState, /timing\.runtimeEvidenceMs\s*=/);
  assert.match(buildState, /timing\.resultCatalog\s*=/);
  assert.match(buildState, /this\.latestPanelBuildTiming = timing/);
  assert.match(source, /resultCatalog: \{ \.\.\.this\.latestPanelBuildTiming\.resultCatalog \}/);
  assert.match(source, /receivedRenderedSemantics: "latest_heartbeat_ack"/);
  assert.match(source, /new Worker\(path\.join\(__dirname, "\.\.", "results", "ProjectResultCatalogWorker\.js"\)\)/);
});

function largeLocalResultFixture() {
  const tables = require("../../dist/results/ProjectResultTables");
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "simple-local-catalog-limit-"));
  const registry = tables.emptyTableRegistry();
  registry.publicationGeneration = "local-complete-generation";
  for (let index = 0; index < 11; index++) {
    const planFile = `experiments/plans/comparison/plan-${String(index).padStart(2, "0")}.yaml`;
    registry.plans[planFile] = { revision: "r1", expectedSeeds: 1, records: ["dataset-a", "dataset-b"].map(dataset => ({
      planFile, dataset, workerId: "worker-a", case: dataset, seed: "42", method: "method-a", endpoint: "clean", rate: "", runId: "run-a", metrics: { AUC: .93 },
    })) };
    const raw = path.join(root, "experiments/results/_shared/plans", tables.planDirectoryKey(planFile), "raw/worker-a");
    fs.mkdirSync(raw, { recursive: true });
    for (let file = 0; file < 200; file++) fs.writeFileSync(path.join(raw, `result-${file}.json`), '{"value":1}', "utf8");
  }
  const registryPath = path.join(root, "simple_cluster/results/project_table_registry.json");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry), "utf8");
  for (const table of Object.values(tables.buildTables(registry))) {
    const csv = path.join(root, "experiments/results", table.relativePath);
    const md = path.join(root, "experiments/results", table.markdownPath);
    fs.mkdirSync(path.dirname(csv), { recursive: true });
    fs.writeFileSync(csv, tables.writeCsv(table.header, table.rows), "utf8");
    fs.writeFileSync(md, table.markdown, "utf8");
  }
  fs.writeFileSync(path.join(root,"experiments/results/latest-results.json"),JSON.stringify({schemaVersion:1,source:"active_query",
    observedAt:new Date().toISOString(),jobs:[],errors:[],tables:Object.values(tables.buildTables(registry))}));
  return { root, registry, tables };
}

test("a full raw artifact budget cannot hide later datasets, final tables, methods or registered Plans", () => {
  const { root, tables } = largeLocalResultFixture();
  const catalog = tables.resultCatalog(root, "experiments/results");
  assert.deepEqual(catalog.datasets.flatMap(dataset => dataset.tables.map(table => table.tableKey)).sort(), [
    "dataset-a/final", "dataset-a/method/method-a", "dataset-b/final", "dataset-b/method/method-a",
  ]);
  assert.equal(catalog.multiDatasetPlans.length, 11);
  assert.equal(catalog.datasets.flatMap(dataset => dataset.plans).reduce((total, plan) => total + plan.artifacts.length, 0), 2000);
});

let offlineVscode;
function productionProvider(root) {
  const Module = require("node:module");
  const originalLoad = Module._load;
  offlineVscode ||= {
    Uri: { file: fsPath => ({ fsPath }) }, ProgressLocation: { Notification: 1 },
    extensions: { getExtension: () => ({ extensionPath: path.resolve(__dirname, "../.."), packageJSON: require("../../package.json") }) },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { showInformationMessage: async () => {}, showWarningMessage: async () => {},
      withProgress: async (_options, work) => work({ report() {} }, { isCancellationRequested: false }) },
  };
  offlineVscode.workspace.workspaceFolders = [{ uri: { fsPath: root, scheme: "file" } }];
  let Provider;
  Module._load = function(request, ...args) {
    return request === "vscode" ? offlineVscode : originalLoad.call(this, request, ...args);
  };
  try { Provider = require("../../dist/extension/legacy").RealtimeTunnelPanelProvider; } finally { Module._load = originalLoad; }
  return Provider;
}

test("the real local refresh returns only after the offline catalog is ready and posted, even without section interest", async () => {
  const { root } = largeLocalResultFixture();
  const Provider = productionProvider(root);
  const posts = [];
  const host = Object.assign(Object.create(Provider.prototype), {
    resultCsvDirectory: "experiments/results", resultCatalogDirtyGeneration: 0, resultCatalogRefreshSequence: 0, resultCatalogTtlMs: 5000,
    resultCatalogStatus: "notLoaded", panelSectionInterest: { mainSection: "overview", visibleSections: [], expandedSections: [] },
    captureProjectContext: () => ({ root }), projectContextIsCurrent: () => true,
    postState: () => posts.push({ status: host.resultCatalogStatus, tables: host.resultCatalogCache?.tables }),
    client: { getResultsSummary: () => assert.fail("local refresh cannot query a server") },
    simpleSftpApiCall: () => assert.fail("local refresh cannot download results"),
  });
  try {
    await host.refreshLocalResultsFromUi();
    assert.equal(host.resultCatalogStatus, "ready");
    assert.equal(host.resultCatalogCache.tables.length, 4);
    assert.equal(posts.at(-1).status, "ready");
    assert.equal(posts.at(-1).tables.length, 4);
    assert.equal(host.resultCatalogRefreshWorker, undefined);
  } finally { host.cancelResultCatalogRefresh(); }
});

for (const command of ["syncPendingPlanArtifacts", "rebuildProjectResultTables"]) {
  test(`${command} waits for active collection, export and ready local catalog`,async t=>{
    if(process.platform!=="win32"){t.skip("requires native Windows UI Extension Host; mandatory native acceptance case");return;}
    const f=require('../_helpers/freshResultHost').fixture(),Provider=productionProvider(f.root),statuses=[];
    const host=Object.assign(Object.create(Provider.prototype),f.host,{
      context:{globalStorageUri:{fsPath:f.root}},resultCatalogDirtyGeneration:0,resultCatalogRefreshSequence:0,resultCatalogTtlMs:5000,
      resultCatalogStatus:"notLoaded",panelSectionInterest:{mainSection:"overview",visibleSections:[],expandedSections:[]},manualResultSyncCounts:new Map(),
      runningBuildIdentity:require('../../dist/features/PanelBuildIdentity').readPanelBuildIdentity(path.resolve(__dirname,'../..')),
      refreshLocalResultCatalogForProject:Provider.prototype.refreshLocalResultCatalogForProject,
      effectiveConnectionMode:()=>"tunnel",beginSimpleSftpCapabilityLaunch:()=>undefined,finishPlanSubmissionProgress:()=>{},
      postUiCommandStatus:(_id,status)=>statuses.push({status,loadStatus:host.resultCatalogStatus,tables:host.resultCatalogCache?.tables.length}),
      recordActionError:error=>assert.fail(error.message),
    });
    try{
      await host.withUiCommandStatus("active-result-button",command,{},()=>host.handleMessageCore({command},command));
      assert.equal(statuses.at(-1).status,"completed");assert.equal(statuses.at(-1).loadStatus,"ready");
      assert.ok(statuses.at(-1).tables>0);assert.ok(f.calls.some(row=>row[0]==="sync.downloadMappedPaths"));
      assert.equal(host.resultsSummary.source,"active_query");assert.equal(host.manualResultSyncCounts.size,0);
    }finally{host.cancelResultCatalogRefresh();}
  });
  // 085 移植返修：.403 把这两条命令改走活采集（ResultCollectionHost），旧的注册表夹具会被
  // “原导出文件不是本轮结果”拒收，因此按新契约在 Linux 可运行的 freshResultHost 夹具上重述
  // 本案例的顺序不变式（每条 completed 上报都必须已带就绪表），不删断言语义；
  // Windows 原生门禁案例保持 .403 原样另行执行。
  test(`${command} cannot post completed before its published local tables reach the panel cache`, async () => {
    const f=require('../_helpers/freshResultHost').fixture(),Provider=productionProvider(f.root),statuses=[];
    const host=Object.assign(Object.create(Provider.prototype),f.host,{
      context:{globalStorageUri:{fsPath:f.root}},resultCatalogDirtyGeneration:0,resultCatalogRefreshSequence:0,resultCatalogTtlMs:5000,
      resultCatalogStatus:"notLoaded",panelSectionInterest:{mainSection:"overview",visibleSections:[],expandedSections:[]},manualResultSyncCounts:new Map(),
      runningBuildIdentity:require('../../dist/features/PanelBuildIdentity').readPanelBuildIdentity(path.resolve(__dirname,'../..')),
      refreshLocalResultCatalogForProject:Provider.prototype.refreshLocalResultCatalogForProject,
      effectiveConnectionMode:()=>"tunnel",beginSimpleSftpCapabilityLaunch:()=>undefined,finishPlanSubmissionProgress:()=>{},
      postUiCommandStatus:(_id,status)=>statuses.push({status,loadStatus:host.resultCatalogStatus,tables:host.resultCatalogCache?.tables.length}),
      recordActionError:error=>assert.fail(error.message),
    });
    try{
      await host.withUiCommandStatus("active-result-button",command,{},()=>host.handleMessageCore({command},command));
      assert.ok(statuses.some(row=>row.status==="completed"),`${command} must post completed exactly once the run finishes`);
      for(const row of statuses.filter(row=>row.status==="completed"))
        assert.ok(row.loadStatus==="ready"&&row.tables>0,'a completed post may not precede the published local tables in the panel cache');
      assert.equal(statuses.at(-1).status,"completed");assert.equal(statuses.at(-1).loadStatus,"ready");
      assert.ok(f.calls.some(row=>row[0]==="sync.downloadMappedPaths"),'the new path performs one active declared-result collection');
      assert.equal(host.manualResultSyncCounts.size,0);
    }finally{host.cancelResultCatalogRefresh();}
  });
}
