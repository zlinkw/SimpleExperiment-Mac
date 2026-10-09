const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const ts = require("typescript");
Module._extensions[".ts"] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);

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
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscode;
  if (request.startsWith("../vendor/semver/")) return originalLoad.call(this, path.join(repo, "dist/vendor/semver", request.slice("../vendor/semver/".length)), parent, isMain);
  if (request === "../results/ProjectResultTables" && parent?.filename.endsWith(path.join("src", "extension", "legacy.ts"))) return tablesModule.exports;
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
    simpleSftpCapability: async () => ({ methodOptions: { "sync.downloadMappedPaths": { memoryOnly: true } } }),
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

function seedRegistry() {
  return tablesModule.exports.updateRegistry(tablesModule.exports.emptyTableRegistry(), {
    planFile, planRevision: "rev-1", completedRunId: "run-old", rawResultCsvPath: remoteCsv,
    workerResultTables: [{ workerId: "worker-a", rawResultCsvPath: remoteCsv, aggregateStatus: "ready" }],
    results: [{ workerId: "worker-a", runId: "run-old", attempt: "1", planRevision: "rev-1",
      dimensions: { case: "alpha", seed: "42", method: "demo", dataset: "set" }, metrics: { AUC: { value: 0.5 } },
      sourceFiles: [{ path: remoteCsv }] }],
  }, planFile, 1);
}

test("production metrics-only SFTP mapping retains provenance in the registry without raw cache, with alias-normalized mean and sample SD", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p6-metrics-chain-"));
  try {
    const provider = providerFor(workspace, csvFor([
      { seed: 42, metric: "AUC", value: 0.4 }, { seed: 42, metric: "roc_auc", value: 0.4 },
      { seed: 42, metric: "ECE", value: 0.1 }, { seed: 42, metric: "ece", value: 0.1 },
      { seed: 43, metric: "auc", value: 0.6 }, { seed: 43, metric: "ECE", value: 0.3 },
    ]));
    const report = await __syncPendingResultMetricsForTest(provider);
    assert.equal(report.downloaded, true);
    assert.equal(report.included.length, 1);
    const call = provider.calls.find(([method]) => method === "sync.downloadMappedPaths");
    assert.ok(call);
    assert.equal(call[0], "sync.downloadMappedPaths");
    assert.equal(call[1].metricsOnly, true);
    assert.equal(call[1].memoryOnly, true);
    assert.equal(call[1].confirm, true);
    assert.equal(call[1].pathConfirmed, true);
    assert.equal(call[1].server.id, "worker-a");
    assert.equal(call[1].server.host, "worker-a.example", "the mapped transfer follows the configured Worker endpoint");
    assert.equal(call[1].server.remotePath, "/project");
    assert.equal(provider.calls.filter(([method]) => method === "sync.downloadMappedPaths").length, 1,
      "the cross test uses the mapped metrics transport seam once");
    assert.deepEqual(call[1].entries.map((entry) => entry.remotePath), [remoteCsv]);
    assert.ok(call[1].entries.every((entry) => !/weight|checkpoint|\.log$/i.test(entry.remotePath)));
    const localMetricFiles = [];
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile() && full.includes(localCsvPattern)) localMetricFiles.push(full);
      }
    };
    visit(workspace);
    assert.equal(localMetricFiles.length, 0, "raw metric bytes are parsed in memory, never saved as local cache");
    const outputRoot = path.join(workspace, "experiments", "results", "set", "final");
    const csv = fs.readFileSync(path.join(outputRoot, "final.csv"), "utf8");
    const markdown = fs.readFileSync(path.join(outputRoot, "final.md"), "utf8");
    const table = tablesModule.exports.readCsv(csv);
    assert.equal(table.header.filter((column) => column === "roc_auc_mean").length, 1);
    assert.equal(table.rows[0][table.header.indexOf("roc_auc_mean")], "0.5");
    assert.ok(Math.abs(Number(table.rows[0][table.header.indexOf("roc_auc_sd")]) - Math.sqrt(0.02)) < 1e-12);
    assert.equal(table.rows[0][table.header.indexOf("ece_mean")], "0.2");
    assert.ok(Math.abs(Number(table.rows[0][table.header.indexOf("ece_sd")]) - Math.sqrt(0.02)) < 1e-12);
    assert.match(markdown, /0\.5000 ± 0\.1414/);
    const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
    assert.deepEqual(Object.keys(registry.plans[planFile].records[0].metrics).sort(), ["AUC", "ECE", "ece", "roc_auc"].sort());
    assert.equal(registry.plans[planFile].records[0].runId, "run-complete");
    assert.ok(registry.plans[planFile].records.every(record=>record.runId==="run-complete"));
  } finally {
    vscode.workspace.workspaceFolders = [];
  }
});

test("conflicting raw aliases retain the previous published CSV and Markdown", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p6-metrics-conflict-"));
  try {
    const oldRegistry = seedRegistry();
    const prior = tablesModule.exports.buildTables(oldRegistry)["set/final"];
    const outputRoot = path.join(workspace, "experiments", "results", "set", "final");
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, "final.csv"), tablesModule.exports.writeCsv(prior.header, prior.rows), "utf8");
    fs.writeFileSync(path.join(outputRoot, "final.md"), prior.markdown, "utf8");
    const beforeCsv = fs.readFileSync(path.join(outputRoot, "final.csv"), "utf8");
    const beforeMd = fs.readFileSync(path.join(outputRoot, "final.md"), "utf8");
    const provider = providerFor(workspace, csvFor([
      { seed: 42, metric: "AUC", value: 0.4 }, { seed: 42, metric: "roc_auc", value: 0.8 },
      { seed: 43, metric: "AUC", value: 0.6 },
    ]), oldRegistry);
    const report = await __syncPendingResultMetricsForTest(provider);
    assert.ok(report.skipped.some(issue=>/等价指标值冲突/.test(issue)), "the conflict stays visible in the partial-sync report");
    assert.equal(report.included.length, 0);
    assert.equal(provider.calls.find(([method]) => method === "sync.downloadMappedPaths")[1].metricsOnly, true);
    assert.equal(fs.readFileSync(path.join(outputRoot, "final.csv"), "utf8"), beforeCsv);
    assert.equal(fs.readFileSync(path.join(outputRoot, "final.md"), "utf8"), beforeMd);
  } finally {
    vscode.workspace.workspaceFolders = [];
  }
});

test("completed plans stay untouched until manual metrics sync downloads and publishes their results", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p6-postprocess-chain-"));
  try {
    vscode.workspace.workspaceFolders = [{ uri: { scheme: "file", path: workspace.replace(/\\/g, "/"),
      fsPath: workspace, toString: () => "file://" + workspace.replace(/\\/g, "/") } }];
    const provider = providerFor(workspace, csvFor([
      { seed: 42, metric: "AUC", value: 0.4 }, { seed: 43, metric: "AUC", value: 0.6 },
    ]));
    provider.testSummary.results = [42, 43].map((seed) => ({
      workerId: "worker-a", runId: "run-complete", attempt: "1", planRevision: "rev-1",
      dimensions: { case: "alpha", seed: String(seed), method: "demo", dataset: "set" },
      metrics: { AUC: { value: seed === 42 ? 0.4 : 0.6 } }, sourceFiles: [{ path: remoteCsv }],
    }));
    let queue = { schemaVersion: 1, publishedSignature: "published-v1", previewSignature: "preview-v1",
      plans: [{ id: "demo", planFile, revision: "rev-1", planJobCount: 1, recoveryMissingCount: 0,
        jobs: [{ index: 0, attempt: 1, commandId: "command-1", status: "completed", workerId: "worker-a" }] }] };
    provider.loadDistributedQueue = async () => queue;
    provider.saveDistributedQueue = async (_root, next, options) => {
      queue = options?.mutateLatest ? options.mutateLatest(queue) : next;
    };
    provider.distributedQueueWritePromise = Promise.resolve();
    const stages = [];
    provider.syncDistributedJobArtifacts = async (_root, _queue, stage) => { stages.push(stage); };
    provider.rebuildDistributedResults = async (_root, _queue, preview) => { stages.push(preview ? "preview-rebuild" : "final-rebuild"); };
    provider.recordActionError = (action) => { throw new Error("unexpected postprocess error: " + action.message); };
    const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
    const confirmations = [];
    const confirmDownloads = host.confirmMappedResultDownloads;
    host.confirmMappedResultDownloads = async (...args) => {
      confirmations.push(args[4]);
      return confirmDownloads.apply(host, args);
    };
    const warningCount = uiNotices.filter(([kind]) => kind === "warning").length;
    host.scheduleDistributedPostprocess(workspace, true);
    await Promise.resolve();
    assert.deepEqual(stages, [], "completion must not trigger result postprocessing");
    assert.equal(provider.calls.length, 0, "completion must not download metric files");
    await host.syncPendingResultMetricsFromUi();

    assert.deepEqual(stages, [], "manual metric sync builds local tables without remote mirroring or rebuilding");
    assert.equal(provider.calls.filter(([method]) => method === "sync.downloadMappedPaths").length, 1, "manual sync reaches mapped SFTP transport once");
    const [method, params] = provider.calls.find(([method]) => method === "sync.downloadMappedPaths");
    assert.equal(method, "sync.downloadMappedPaths");
    assert.equal(params.metricsOnly, true);
    assert.equal(params.memoryOnly, true);
    assert.equal(confirmations.length, 0, "memory-only parsing does not request an unrelated local raw-file overwrite");
    assert.deepEqual(params.entries.map((entry) => entry.remotePath), [remoteCsv]);
    const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster/results/project_table_registry.json"), "utf8"));
    assert.ok(registry.plans[planFile].records.every(record=>record.runId==="run-complete"), "publication records the downloaded result generation");
    assert.equal(uiNotices.filter(([kind]) => kind === "warning").length, warningCount, "new metric files do not require overwrite confirmation");
    assert.ok(fs.existsSync(path.join(workspace, "experiments", "results", "set", "final", "final.csv")));
    assert.ok(fs.existsSync(path.join(workspace, "experiments", "results", "set", "final", "final.md")));

    host.scheduleDistributedPostprocess(workspace, true);
    await Promise.resolve();
    assert.equal(provider.calls.filter(([method]) => method === "sync.downloadMappedPaths").length, 1, "later queue ticks do not repeat the manual download");
  } finally {
    vscode.workspace.workspaceFolders = [];
  }
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
    host.withRemoteActionResource = async (_workerId, _resource, _request, callback) => {
      host.distributedQueueGeneration += 1;
      return callback();
    };
    const emptyManifestFingerprint = crypto.createHash("sha256").update("[]").digest("hex");
    await assert.rejects(() => host.sendDistributedJob(
      { id: "plan-a", projectId: "project-a", planJobCount: 1, planFile, revision: "rev-1", codeFingerprint: emptyManifestFingerprint },
      { index: 0, attempt: 1, case: "alpha", seed: 42, outputDir: "runs/a" }, "worker-a", undefined, "command-a",
    ), /提交已取消或项目已切换/);
    assert.equal(sends, 0, "generation changed while awaiting the local resource lock must block the remote write");
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
});
