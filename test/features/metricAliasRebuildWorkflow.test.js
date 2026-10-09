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
  const csv = tablesModule.exports.writeCsv(['case','seed','method','dataset','rate_percent','eval_protocol','metric','value'],
    summary.results.flatMap(row => Object.entries(row.metrics).map(([metric, payload]) => [row.dimensions.case, row.dimensions.seed,
      row.dimensions.method, row.dimensions.dataset, row.dimensions.rate_percent, row.dimensions.eval_protocol, metric, payload.value])));
  const sha = require('node:crypto').createHash('sha256').update(csv).digest('hex');
  return {
    context: { globalStorageUri: { fsPath: workspace } },
    client: { getResultsSummary: async () => summary },
    setupConfig: { workerTunnels: [], agentProjectDir: "", condaEnv: "" },
    localPlanMetadata: { plans: [{ planFile, revision: "r1", seeds: [42, 43] }] },
    selectedRunKeys: new Set(), selectedExperimentIds: new Set(), selectedArchiveKeys: new Set(), selectedTaskUiKeys: new Set(),
    planFileInput: "", selectedPlanId: "", selectedRunKey: "",
    captureProjectContext: () => ({ root: workspace, generation: 1 }),
    projectContextIsCurrent: () => true,
    effectiveConnectionMode: () => "tunnel",
    refreshLocalPlanMetadataForAction: async () => {},
    loadPlanSyncLedger: async () => ({ schemaVersion: 2, entries: { demo: { planFile, revision: "r1", runId: "run-1" } } }),
    loadProjectTableRegistry: async () => previousRegistry,
    loadDistributedQueue: async () => ({ schemaVersion: 1, plans: [] }),
    distributedProjectContract: () => ({ resultRowsPath: "test_results/formal_result_rows.csv", fourStatePath: "test_results/four_state_metrics.csv" }),
    simpleSftpCapability: async () => ({ methodOptions: { 'sync.downloadMappedPaths': { memoryOnly: true } } }),
    mappedDownloadServerForSource: id => ({ id, host: 'configured.example', remotePath: '/project' }),
    simpleSftpApiCall: async (method, params) => method === 'sync.projectInventory'
      ? { files: { [rawPath]: { size: Buffer.byteLength(csv), sha256: sha } } }
      : { ok: true, memoryOnly: true, entries: params.entries.map(entry => ({ remotePath: entry.remotePath, bytes: Buffer.byteLength(csv), sha256: sha, dataBase64: Buffer.from(csv).toString('base64') })) },
    schedulerSettings: () => ({ gpuIdleUtilThreshold: 5, gpuIdleMemThresholdMb: 200, sessionCheckMinSeconds: 30, workerStatusTtlSeconds: 180 }),
    workerCodeSyncTargets: () => [],
    resolveSelectedPlanFile: () => "",
    enabledWorkerConfigs: () => [{ id: "w1" }],
    postState() {},
  };
}

test("the production rebuild publishes canonical seed means, sample SD, Markdown, and raw provenance", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "metric-alias-rebuild-"));
  try {
    const summary = resultSummary((index) => index === 0
      ? { AUC: { value: 0.6 }, roc_auc: { value: 0.6 }, ECE: { value: 0.1 }, ece: { value: 0.1 } }
      : { auc: { value: 0.8 }, ECE: { value: 0.3 } });
    await __rebuildProjectResultTablesForTest(providerFor(workspace, { schemaVersion: 1, plans: {} }, summary));
    const outputRoot = path.join(workspace, "experiments", "results", "set", "final");
    const csv = fs.readFileSync(path.join(outputRoot, "final.csv"), "utf8");
    const markdown = fs.readFileSync(path.join(outputRoot, "final.md"), "utf8");
    const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
    const parsed = tablesModule.exports.readCsv(csv);
    assert.equal(parsed.header.filter((column) => column === "roc_auc_mean").length, 1);
    assert.equal(parsed.header.filter((column) => column === "ece_mean").length, 1);
    assert.equal(parsed.rows[0][parsed.header.indexOf("roc_auc_mean")], "0.7");
    assert.ok(Math.abs(Number(parsed.rows[0][parsed.header.indexOf("roc_auc_sd")]) - Math.sqrt(0.02)) < 1e-12);
    assert.equal(parsed.rows[0][parsed.header.indexOf("ece_mean")], "0.2");
    assert.ok(Math.abs(Number(parsed.rows[0][parsed.header.indexOf("ece_sd")]) - Math.sqrt(0.02)) < 1e-12);
    assert.match(markdown, /0\.7000 ± 0\.1414/);
    assert.deepEqual(Object.keys(registry.plans[planFile].records[0].metrics).sort(), ["AUC", "ECE", "ece", "roc_auc"].sort());
  } finally {
    vscode.workspace.workspaceFolders = [];
  }
});

test("the production rebuild retains prior CSV and Markdown when same-seed aliases conflict", async () => {
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
      : { AUC: { value: 0.8 } });
    await __rebuildProjectResultTablesForTest(providerFor(workspace, oldRegistry, conflict));
    assert.equal(fs.readFileSync(path.join(outputRoot, "final.csv"), "utf8"), beforeCsv);
    assert.equal(fs.readFileSync(path.join(outputRoot, "final.md"), "utf8"), beforeMarkdown);
  } finally {
    vscode.workspace.workspaceFolders = [];
  }
});
