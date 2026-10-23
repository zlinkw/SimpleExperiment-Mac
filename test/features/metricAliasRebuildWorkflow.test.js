const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
require('../_helpers/registerTsRequire');
const {fixture,planFile,planText}=require('../_helpers/freshResultHost');
const Tables=require('../../src/results/ProjectResultTables.ts');
const {resultDigest}=require('../../src/results/FreshResults.ts');
const source=fs.readFileSync(path.join(__dirname,'../../src/extension/legacy.ts'),'utf8');
const ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);
const parser=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='parseDownloadedMetricCsv').getText(ast);
const parse=new Function('ProjectResultTables',parser+';return parseDownloadedMetricCsv;')(Tables);
function setup(){
  const f=fixture(),declarations=[42,43].map((seed,index)=>({index,case:'alpha',seed,output_dir:'work_dirs/alpha'+seed,result_csv:'work_dirs/alpha'+seed+'/metrics.csv',planHash:resultDigest(planText)}));
  for(const job of declarations)f.raw[job.output_dir+'/artifact_manifest.json']=JSON.stringify({simpleExperiment:{runId:'command-'+job.index,status:'completed',mode:'test',job:{index:job.index,case:job.case,seed:job.seed},outputDir:job.output_dir,resultCsv:job.result_csv,weights:[]}});
  f.host.client.getWorkerTasks=async(_id,options)=>options.discovery?{queryComplete:true,capabilities:{resultCollection:1},declaredJobs:declarations}:
    {queryComplete:true,capabilities:{resultCollection:1},tasks:[],declaredResults:declarations.map(job=>({index:job.index,outputDir:job.output_dir,completed:true,runId:'command-'+job.index,
      runtimeDiagnostics:{schemaVersion:1,commandId:'command-'+job.index,runId:'command-'+job.index,state:'clear',count:0,scanComplete:true},
      files:[job.output_dir+'/artifact_manifest.json',job.result_csv].map(remotePath=>({remotePath,bytes:Buffer.byteLength(f.raw[remotePath]),sha256:resultDigest(f.raw[remotePath])}))}))};
  f.host.parseFreshResultMetric=(text,job)=>parse(text,{},job);
  function values(conflict=false){for(const job of declarations){const first=job.index===0;
    f.raw[job.result_csv]=Tables.writeCsv(['case','seed','method','dataset','metric','value'],(first?[['AUC',.6],['roc_auc',conflict ? .7 : .6],['ECE',.1],['ece',.1]]:[['auc',.8],['ECE',.3]])
      .map(([metric,value])=>[job.case,job.seed,'demo','set',metric,value]));}}
  values();return {...f,values};
}
test('active collection publishes canonical seed means, sample SD and Markdown without raw cache files',async()=>{
  const f=setup(),report=await f.service.update();assert.equal(report.completed,2);
  const output=path.join(f.root,'experiments/results/set/final');
  const csv=fs.readFileSync(path.join(output,'final.csv'),'utf8'),markdown=fs.readFileSync(path.join(output,'final.md'),'utf8');
  const parsed=Tables.readCsv(csv);
  for(const name of ['roc_auc_mean','ece_mean'])assert.equal(parsed.header.filter(column=>column===name).length,1);
  assert.equal(parsed.rows[0][parsed.header.indexOf('roc_auc_mean')],'0.7');
  assert.equal(parsed.rows[0][parsed.header.indexOf('ece_mean')],'0.2');
  for(const name of ['roc_auc_sd','ece_sd'])assert.ok(Math.abs(Number(parsed.rows[0][parsed.header.indexOf(name)])-Math.sqrt(.02))<1e-12);
  assert.match(markdown,/0\.7000 ± 0\.1414/);
  assert.equal(fs.existsSync(path.join(f.root,'simple_cluster/results/project_table_registry.json')),false);
  assert.ok(report.results.every(row=>row.runId&&row.workerId&&row.planFile===planFile));
  const aliases=new Set(report.results.flatMap(row=>Object.keys(row.metrics)));
  for(const name of ['AUC','roc_auc','ECE','ece'])assert.ok(aliases.has(name),'original metric alias retained in memory: '+name);
});
test('same-seed alias conflict stays explicit and excludes that seed from the current partial export',async()=>{
  const f=setup();await f.service.update();f.values(true);
  const report=await f.service.update();
  assert.equal(report.completed,1);assert.equal(report.expected,2);
  assert.equal(report.jobs[0].state,'unknown');assert.match(report.jobs[0].error,/冲突/);
  assert.ok(report.results.every(row=>String(row.dimensions.seed)==='43'),'conflicting seed must never enter a published mean');
  const parsed=Tables.readCsv(fs.readFileSync(path.join(f.root,'experiments/results/set/final/final.csv'),'utf8'));
  assert.equal(parsed.rows[0][parsed.header.indexOf('roc_auc_mean')],'0.8','the prior cached 0.7 mean cannot represent this query');
  const saved=JSON.parse(fs.readFileSync(path.join(f.root,'experiments/results/latest-results.json'),'utf8'));
  assert.equal(saved.source,'active_query');assert.equal(saved.jobs[0].state,'unknown');
  assert.ok(saved.jobs[0].error.includes('冲突'));
});

// Mac coverage cluster: the Mac-only conflicting-seed regression below needs the
// before-merge loader hook, vscode stub, tablesModule, resultSummary and providerFor.
const Module = require("node:module");
const os = require("node:os");
Module._extensions[".ts"] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);

const root = path.join(__dirname, "..", "..");
const tablesSource = path.join(root, "src", "results", "ProjectResultTables.ts");
const tablesModule = new Module(tablesSource, module);
tablesModule.filename = tablesSource;
tablesModule.paths = Module._nodeModulePaths(path.dirname(tablesSource));
tablesModule._compile(ts.transpileModule(fs.readFileSync(tablesSource, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, tablesSource);

const vscode = {
  commands: { executeCommand: async () => ({ ok: true }) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: {
    withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false }),
    showInformationMessage: async () => {}, showWarningMessage: async () => {},
  },
  Uri: { file: (fsPath) => ({ fsPath }) },
  ProgressLocation: { Notification: 1 },
};
const originalLoad = Module._load;
const originalTsLoader = Module._extensions[".ts"];
const tsLoader = (loadedModule, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  loadedModule._compile(compiled, filename);
};
Module._extensions[".ts"] = tsLoader;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscode;
  if (request === "../results/ProjectResultTables" && parent?.filename.endsWith(path.join("src", "extension", "legacy.ts"))) return tablesModule.exports;
  return originalLoad.call(this, request, parent, isMain);
};
const { __rebuildProjectResultTablesForTest } = require("../../dist/extension/legacy.js");
Module._load = originalLoad;
if (originalTsLoader) Module._extensions[".ts"] = originalTsLoader;
else delete Module._extensions[".ts"];

const rawPath = "simple_cluster/results/w1/raw.csv";
function resultSummary(metrics) {
  return {
    planFile, planRevision: "r1", completedRunId: "run-1", rawResultCsvPath: rawPath, resultOwnerWorkerId: "w1",
    workerResultTables: [{ workerId: "w1", rawResultCsvPath: rawPath, aggregateStatus: "ready" }],
    results: [42, 43].map((seed, index) => ({
      planFile, workerId: "w1", runId: "run-1", attempt: "1", planRevision: "r1",
      dimensions: { case: "alpha", seed: String(seed), method: "demo", dataset: "set", rate_percent: "30", eval_protocol: "clean" },
      metrics: metrics(index), sourceFiles: [{ path: rawPath }],
    })),
  };
}
function providerFor(workspace, previousRegistry, summary) {
  const digest = text => require('node:crypto').createHash('sha256').update(text).digest('hex');
  const planText = 'suite: demo\nmode: test\nbase_config: configs/base.yaml\nseeds: [42, 43]\ncases: [{case: alpha}]\ntest_command: python fixture.py\n';
  fs.mkdirSync(path.join(workspace, 'experiments/plans'), { recursive: true });
  fs.writeFileSync(path.join(workspace, planFile), planText);
  vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: workspace } }];
  const raw = {}, declarations = summary.results.map((row, index) => {
    const output_dir = 'work_dirs/alias-' + row.dimensions.seed;
    const result_csv = output_dir + '/metrics.csv';
    raw[result_csv] = tablesModule.exports.writeCsv(['case','seed','method','dataset','rate_percent','eval_protocol','metric','value'],
      Object.entries(row.metrics).map(([metric, payload]) => [row.dimensions.case, row.dimensions.seed,
        row.dimensions.method, row.dimensions.dataset, row.dimensions.rate_percent, row.dimensions.eval_protocol, metric, payload.value]));
    raw[output_dir + '/artifact_manifest.json'] = JSON.stringify({ simpleExperiment: {
      runId: 'command-' + row.dimensions.seed, status: 'completed', mode: 'test',
      job: { index, case: row.dimensions.case, seed: Number(row.dimensions.seed) },
      outputDir: output_dir, resultCsv: result_csv, weights: [], planFile, planRevision: digest(planText) } });
    return { index, case: row.dimensions.case, seed: Number(row.dimensions.seed), output_dir, result_csv, planHash: digest(planText) };
  });
  const worker = { id: 'w1', host: 'fixture.invalid', user: 'fixture', port: 22, remotePath: '/fixture' };
  return {
    context: { globalStorageUri: { fsPath: workspace } },
    setupConfig: { workerTunnels: [], agentProjectDir: '', condaEnv: '' },
    captureProjectContext: () => ({ root: workspace, generation: 1 }), projectContextIsCurrent: () => true,
    resultCsvDirectory: 'experiments/results', resultAdapterRules: () => ({}),
    workerCodeSyncTargets: () => [worker], sftpServerOptions: target => target,
    client: { getResultsSummary: async () => assert.fail('old summaries cannot supply current results'),
      getWorkerTasks: async (id, options) => {
        assert.equal(id, 'w1');
        if (options.discovery) return { queryComplete: true, capabilities: { resultCollection: 1 }, declaredJobs: declarations };
        assert.deepEqual(options.queries, []);
        return { queryComplete: true, capabilities: { resultCollection: 1 }, tasks: [], declaredResults: declarations.map(job => ({
          index: job.index, outputDir: job.output_dir, completed: true, runId: 'command-' + job.seed,
          runtimeDiagnostics: { schemaVersion: 1, commandId: 'command-' + job.seed, runId: 'command-' + job.seed, state: 'clear', count: 0, scanComplete: true },
          files: [job.output_dir + '/artifact_manifest.json', job.result_csv].map(remotePath => ({ remotePath, bytes: Buffer.byteLength(raw[remotePath]), sha256: digest(raw[remotePath]) })) })) };
      } },
    simpleSftpCapability: async () => ({ methodOptions: { 'sync.downloadMappedPaths': { memoryOnly: true, memoryWrapperResults: true } } }),
    simpleSftpApiCall: async (method, params) => {
      assert.equal(method, 'sync.downloadMappedPaths'); assert.equal(params.memoryOnly, true); assert.equal(params.metricsOnly, true);
      return { ok: true, memoryOnly: true, entries: params.entries.map(entry => {
        assert.ok(Object.hasOwn(raw, entry.remotePath));
        return { remotePath: entry.remotePath, bytes: Buffer.byteLength(raw[entry.remotePath]), sha256: digest(raw[entry.remotePath]), dataBase64: Buffer.from(raw[entry.remotePath]).toString('base64') };
      }) };
    },
    loadProjectTableRegistry: () => assert.fail('retired registry must not supply results'),
    loadPlanSyncLedger: () => assert.fail('historical ledger must not supply results'),
    loadDistributedQueue: () => assert.fail('queue must not supply result bytes'),
    refreshLocalResultCatalogForProject: async context => assert.equal(context.root, workspace), postState() {},
  };
}


test("a conflicting seed cannot supply metrics or suppress the other seed's fresh partial table", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "metric-alias-partial-"));
  try {
    const outputRoot = path.join(workspace, "experiments", "results", "set", "final");
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, "final.csv"), "old cached metric,0.5\n");
    fs.writeFileSync(path.join(outputRoot, "final.md"), "old cached metric 0.5\n");
    const summary = resultSummary(index => index === 0
      ? { AUC: { value: 0.6 }, roc_auc: { value: 0.7 } }
      : { auc: { value: 0.8 }, ECE: { value: 0.3 } });
    const report = await __rebuildProjectResultTablesForTest(providerFor(workspace, {}, summary));
    assert.equal(report.current, true); assert.equal(report.completed, 1);
    assert.equal(report.missing.length, 1); assert.match(report.missing[0], /alpha\/42.*指标冲突/);
    assert.equal(report.jobs.find(job => job.seed === 42).state, "unknown");
    assert.equal(report.jobs.find(job => job.seed === 43).state, "complete");
    assert.ok(report.results.length > 0);
    assert.ok(report.results.every(row => row.dimensions.seed === "43"));
    const latest = JSON.parse(fs.readFileSync(path.join(workspace, "experiments/results/latest-results.json"), "utf8"));
    assert.equal(latest.source, "active_query"); assert.equal(latest.tables.length, 2);
    assert.deepEqual(latest.tables.map(table => table.relativePath).sort(), ["set/final/final.csv", "set/methods/demo/demo.csv"]);
    const csv = fs.readFileSync(path.join(outputRoot, "final.csv"), "utf8");
    const parsed = tablesModule.exports.readCsv(csv);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0][parsed.header.indexOf("roc_auc_mean")], "0.8");
    assert.equal(parsed.rows[0][parsed.header.indexOf("ece_mean")], "0.3");
    assert.equal(parsed.rows[0][parsed.header.indexOf("roc_auc_sd")], "");
    assert.equal(parsed.rows[0][parsed.header.indexOf("ece_sd")], "");
    assert.equal(parsed.rows[0][parsed.header.indexOf("jobs")], "1/2");
    for (const table of latest.tables) {
      assert.deepEqual(table.header, parsed.header);
      assert.deepEqual(table.rows.map(row => row.map(String)), parsed.rows);
      const actual = fs.readFileSync(path.join(workspace, "experiments/results", table.relativePath), "utf8");
      assert.deepEqual(tablesModule.exports.readCsv(actual), parsed);
    }
    assert.doesNotMatch(csv, /old cached/);
    const markdown = fs.readFileSync(path.join(outputRoot, "final.md"), "utf8");
    assert.match(markdown, /0\.8000/); assert.doesNotMatch(markdown, /old cached/);
    const fresh = latest.jobs.find(job => job.seed === 43);
    assert.equal(fresh.sources.length, 2);
    assert.ok(fresh.sources.every(file => file.bytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.equal(latest.jobs.find(job => job.seed === 42).sources, undefined);
  } finally {
    vscode.workspace.workspaceFolders = [];
  }
});
