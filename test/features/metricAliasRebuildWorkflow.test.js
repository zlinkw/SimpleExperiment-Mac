const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
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

const planFile = "experiments/plans/demo.yaml";
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

test("the production rebuild publishes canonical seed means, sample SD, Markdown, and raw provenance", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "metric-alias-rebuild-"));
  try {
    const summary = resultSummary((index) => index === 0
      ? { AUC: { value: 0.6 }, roc_auc: { value: 0.6 }, ECE: { value: 0.1 }, ece: { value: 0.1 } }
      : { auc: { value: 0.8 }, ECE: { value: 0.3 } });
    const report = await __rebuildProjectResultTablesForTest(providerFor(workspace, { schemaVersion: 1, plans: {} }, summary));
    assert.equal(report.current, true); assert.equal(report.completed, 2); assert.deepEqual(report.missing, []);
    const outputRoot = path.join(workspace, "experiments", "results", "set", "final");
    const csv = fs.readFileSync(path.join(outputRoot, "final.csv"), "utf8");
    const markdown = fs.readFileSync(path.join(outputRoot, "final.md"), "utf8");
    const latest = JSON.parse(fs.readFileSync(path.join(workspace, "experiments", "results", "latest-results.json"), "utf8"));
    const parsed = tablesModule.exports.readCsv(csv);
    assert.equal(parsed.header.filter((column) => column === "roc_auc_mean").length, 1);
    assert.equal(parsed.header.filter((column) => column === "ece_mean").length, 1);
    assert.equal(parsed.rows[0][parsed.header.indexOf("roc_auc_mean")], "0.7");
    assert.ok(Math.abs(Number(parsed.rows[0][parsed.header.indexOf("roc_auc_sd")]) - Math.sqrt(0.02)) < 1e-12);
    assert.equal(parsed.rows[0][parsed.header.indexOf("ece_mean")], "0.2");
    assert.ok(Math.abs(Number(parsed.rows[0][parsed.header.indexOf("ece_sd")]) - Math.sqrt(0.02)) < 1e-12);
    assert.match(markdown, /0\.7000 ± 0\.1414/);
    assert.deepEqual([...new Set(report.results.filter(row => row.dimensions.seed === '42').flatMap(row => Object.keys(row.metrics)))].sort(), ['AUC', 'ECE', 'ece', 'roc_auc'].sort());
    assert.equal(latest.source, 'active_query'); assert.equal(latest.jobs.length, 2);
    for (const job of latest.jobs) {
      assert.equal(job.planFile, planFile); assert.equal(job.state, 'complete');
      assert.equal(job.sources.length, 2);
      assert.ok(job.sources.every(file => /^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0 && file.remotePath.startsWith(job.outputDir + '/')));
    }
    assert.equal(fs.existsSync(path.join(workspace, 'simple_cluster/results/project_table_registry.json')), false);
  } finally {
    vscode.workspace.workspaceFolders = [];
  }
});

test("the production rebuild keeps prior files but excludes them from the current export when every seed has conflicting aliases", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "metric-alias-conflict-"));
  try {
    const oldRegistry = tablesModule.exports.updateRegistry(tablesModule.exports.emptyTableRegistry(), {
      planFile, planRevision: "r1", completedRunId: "run-old", rawResultCsvPath: rawPath,
      workerResultTables: [{ workerId: "w1", rawResultCsvPath: rawPath, aggregateStatus: "ready" }],
      results: [{ workerId: "w1", runId: "run-old", attempt: "1", planRevision: "r1",
        dimensions: { case: "alpha", seed: "42", method: "demo", dataset: "set" },
        metrics: { AUC: { value: 0.5 } }, sourceFiles: [{ path: rawPath }] }],
    }, planFile, 1);
    const table = tablesModule.exports.buildTables(oldRegistry)["set/final"];
    const outputRoot = path.join(workspace, "experiments", "results", "set", "final");
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, "final.csv"), tablesModule.exports.writeCsv(table.header, table.rows), "utf8");
    fs.writeFileSync(path.join(outputRoot, "final.md"), table.markdown, "utf8");
    const beforeCsv = fs.readFileSync(path.join(outputRoot, "final.csv"), "utf8");
    const beforeMarkdown = fs.readFileSync(path.join(outputRoot, "final.md"), "utf8");
    const conflict = resultSummary((index) => index === 0
      ? { AUC: { value: 0.6 }, roc_auc: { value: 0.7 } }
      : { AUC: { value: 0.8 }, roc_auc: { value: 0.9 } });
    const report = await __rebuildProjectResultTablesForTest(providerFor(workspace, oldRegistry, conflict));
    assert.equal(report.completed, 0); assert.equal(report.jobs.length, 2);
    assert.ok(report.jobs.every(job => job.state === 'unknown' && /指标冲突/.test(job.error)));
    assert.equal(report.results.length, 0); assert.equal(report.tables.length, 0);
    const latest = JSON.parse(fs.readFileSync(path.join(workspace, 'experiments/results/latest-results.json'), 'utf8'));
    assert.deepEqual(latest.tables, []);
    assert.equal(fs.readFileSync(path.join(outputRoot, "final.csv"), "utf8"), beforeCsv);
    assert.equal(fs.readFileSync(path.join(outputRoot, "final.md"), "utf8"), beforeMarkdown);
  } finally {
    vscode.workspace.workspaceFolders = [];
  }
});

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
