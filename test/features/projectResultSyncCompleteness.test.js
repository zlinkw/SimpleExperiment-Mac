const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const extensionRoot = path.join(__dirname, "..", "..");
const vscodeStub = {
  commands: { executeCommand: async () => ({ ok: true }) },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    workspaceFolders: [{ uri: { fsPath: "", scheme: "file", path: "" } }],
  },
  extensions: {
    getExtension: () => ({ extensionPath: extensionRoot, packageJSON: require("../../package.json") }),
    onDidChange: () => ({ dispose() {} }),
  },
  window: {
    showWarningMessage: async (text) => { vscodeStub.window.warnings.push(String(text)); return "覆盖已有文件并同步"; },
    showErrorMessage: async (...args) => { vscodeStub.window.errors.push(args); },
    showInformationMessage: async (text) => { vscodeStub.window.messages.push(String(text)); },
    setStatusBarMessage: () => {},
    withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false }),
    messages: [],
    warnings: [],
    errors: [],
  },
  Uri: { file: (value) => ({ fsPath: value }) },
  ProgressLocation: { Notification: 1 },
};
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? vscodeStub : originalLoad.call(this, request, ...args);
};

function target(id) {
  return {
    id, host: id + ".example", user: "exp", port: 22, remotePath: "/projects/" + id,
    transferHost: id + ".example", resolvedHost: id + ".example", sftpHost: id + ".example", sshHost: id + ".example",
    networkHost: id + ".example", sshConfigHost: "", sshConfigAlias: "",
  };
}

function row(workerId, caseName, seed, metric, revision = "ra") {
  return {
    workerId,
    runId: "run-" + revision,
    attempt: "1",
    planRevision: revision,
    resultOwnerWorkerId: workerId,
    dimensions: { case: caseName, seed: String(seed), method: "method", dataset: "set", eval_protocol: "holdout" },
    metrics: { AUC: { value: metric } },
    sourceFiles: [{ path: "simple_cluster/results/" + workerId + "/raw.csv" }],
  };
}

function table(workerId, status = "ready", planName = "a") {
  return {
    workerId,
    aggregateStatus: status,
    rawResultCsvPath: "simple_cluster/results/" + workerId + "/" + planName + "/raw.csv",
    aggregateCsvPath: "simple_cluster/results/" + workerId + "/detail.csv",
  };
}

function providerFor(workspace) {
  const plans = {
    "experiments/plans/a.yaml": {
      planFile: "experiments/plans/a.yaml", planRevision: "ra",
      workerResultTables: [table("w1"), table("w2")],
      completedRunId: "run-ra",
      results: [row("w1", "alpha", 1, 0.81), row("w1", "alpha", 2, 0.82), row("w2", "alpha", 3, 0.83)],
    },
    "experiments/plans/b.yaml": {
      planFile: "experiments/plans/b.yaml", planRevision: "rb",
      workerResultTables: [table("w2", "ready", "b")],
      results: [row("w2", "beta", 1, 0.71, "rb")],
    },
    "experiments/plans/c.yaml": {
      planFile: "experiments/plans/c.yaml", planRevision: "rc",
      workerResultTables: [table("w1", "ready", "c")],
      results: [row("w1", "gamma", 1, 0.61, "rc"), row("w1", "gamma", 2, 0.62, "rc")],
    },
  };
  const calls = [];
  const metricText = (file, worker) => {
    const name = file.includes("/b/") ? "beta" : file.includes("/c/") ? "gamma" : "alpha";
    const seeds = name === "alpha" ? (worker === "w2" ? [[3, 0.83]] : [[1, 0.81], [2, 0.82]])
      : name === "gamma" ? [[1, 0.61], [2, 0.62]] : [[1, 0.71]];
    return "case,seed,method,dataset,eval_protocol,AUC\n" + seeds.map(([seed, value]) => `${name},${seed},${worker},set,holdout,${value}`).join("\n") + "\n";
  };
  const provider = {
    calls,
    manualResultSyncCounts: new Map(),
    runningBuildIdentity: require("../../dist/features/PanelBuildIdentity").readPanelBuildIdentity(extensionRoot, undefined, require("../../package.json").version),
    planFileInput: "experiments/plans/b.yaml",
    selectedPlanId: "experiments/plans/b.yaml",
    selectedRunKeys: new Set(), selectedExperimentIds: new Set(), selectedArchiveKeys: new Set(), selectedTaskUiKeys: new Set(),
    panelSectionInterest: { documentGeneration: "1", mainSection: "results", visibleSections: ["results"], expandedSections: ["results"], pinnedInspectorSection: "" },
    context: { globalStorageUri: { fsPath: workspace } },
    hostOperationLease: { run: async (_request, operation) => operation() },
    localPlanMetadata: { plans: [
      { planFile: "experiments/plans/a.yaml", revision: "ra", seeds: [1, 2, 3], outputSignals: ["结果目录：simple_cluster/results/w1"] },
      { planFile: "experiments/plans/b.yaml", revision: "rb", seeds: [1] },
      { planFile: "experiments/plans/c.yaml", revision: "rc", seeds: [1, 2] },
      { planFile: "experiments/plans/empty.yaml", revision: "re", seeds: [] },
    ] },
    setupConfig: { workerTunnels: [{ id: "w1" }, { id: "w2" }] },
    client: {
      getResultsSummary: async (planFile) => {
        calls.push(["summary", planFile]);
        if (planFile.endsWith("empty.yaml")) throw new Error("worker unreachable");
        return plans[planFile];
      },
    },
    simpleSftpApiCall: async (method, params) => {
      calls.push([method, (params.server || params.source)?.id, (params.entries || []).map((entry) => entry.remotePath)]);
      const worker = (params.server || params.source)?.id;
      if (method === "sync.projectInventory") return { ok: true, files: Object.fromEntries((params.scopePaths || []).map(remotePath => {
        const text = metricText(remotePath, worker);
        return [remotePath, { size: Buffer.byteLength(text), sha256: crypto.createHash("sha256").update(text).digest("hex") }];
      })) };
      if (params.memoryOnly) return { ok: true, memoryOnly: true, entries: params.entries.map(entry => {
        const text = metricText(entry.remotePath, worker);
        return { remotePath: entry.remotePath, bytes: Buffer.byteLength(text), sha256: crypto.createHash("sha256").update(text).digest("hex"), dataBase64: Buffer.from(text).toString("base64") };
      }) };
      if (method === "sync.projectFileStats") return { files: Object.fromEntries((params.paths || []).map((remotePath) => [remotePath, { size: 10 }])) };
      for (const entry of params.entries) {
        const full = path.join(workspace, ...entry.localRelativePath.split("/"));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const worker = params.server.id;
        const relative = String(entry.localRelativePath);
        const planName = relative.includes("/b/") ? "beta" : relative.includes("/c/") ? "gamma" : "alpha";
        const seeds = planName === "alpha" ? (worker === "w2" ? [["3", "0.83"]] : [["1", "0.81"], ["2", "0.82"]]) : planName === "gamma" ? [["1", "0.61"], ["2", "0.62"]] : [["1", "0.71"]];
        const body = seeds.map(([seed, metric]) => planName + "," + seed + "," + worker + ",set,holdout," + metric).join("\n");
        fs.writeFileSync(full, "case,seed,method,dataset,eval_protocol,AUC\n" + body + "\n");
      }
      return { ok: true, fileCount: params.entries.length, completedFiles: params.entries.length };
    },
    simpleSftpCapability: async () => ({ methodOptions: { "sync.downloadMappedPaths": { memoryOnly: true } } }),
    sftpServerOptions: (item) => ({ id: item.id, host: item.host, user: item.user, port: item.port, remotePath: item.remotePath, transferHost: item.host, resolvedHost: item.host }),
    postState() {
      calls.push(["postState", this.resultSyncReport, this.resultsSummary && this.resultsSummary.planFile]);
      this.postedReport = this.resultSyncReport;
      this.postedSummary = this.resultsSummary;
    },
    resolveSelectedPlanFile: (hint = "") => String(hint || provider.planFileInput || ""),
    captureProjectContext: () => ({ root: workspace, generation: 1 }),
    projectContextIsCurrent: () => true,
    effectiveConnectionMode: () => "tunnel",
    refreshLocalPlanMetadataForAction: async () => { calls.push(["metadata"]); },
    loadPlanSyncLedger: async () => ({
      schemaVersion: 2,
      entries: {
        onlyOwner: {
          planFile: "experiments/plans/a.yaml", revision: "ra", runId: "run-ra", sourceWorkerId: "w1",
          artifactPaths: ["simple_cluster/results/w1/raw.csv"], directoryPaths: ["simple_cluster/results/w1"],
          destinations: {},
        },
      },
    }),
    workerCodeSyncTargets: () => [target("w1"), target("w2")],
    enabledWorkerConfigs: () => [{ id: "w1" }, { id: "w2" }],
    filterResultsSummaryForPlan: (value) => value,
    loadProjectTableRegistry: undefined,
    writeProjectTableRegistry: undefined,
    withProjectResultPublicationLease: async (_root, _resultDir, work) => work(),
    recoverProjectResultPublicationIfNeeded: async () => "clean",
    invalidateResultCatalogCache: () => {},
    queueHistoricalPlanArtifactSyncs: async () => { calls.push(["queue-historic"]); },
    mergeLatestWorkerVersions: async (_root, _targets, scopePaths) => {
      calls.push(["merge", scopePaths.slice()]);
      return { completed: [], errors: [] };
    },
  };
  const prototype = require("../../dist/extension/legacy.js").RealtimeTunnelPanelProvider.prototype;
  provider.loadProjectTableRegistry = (root) => prototype.loadProjectTableRegistry.call(provider, root);
  provider.writeProjectTableRegistry = (root, registry, resultDir) => prototype.writeProjectTableRegistry.call(provider, root, registry, resultDir);
  return provider;
}

test("sync includes every completed plan and both workers before one mapped download per source", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-complete-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  vscodeStub.window.messages = [];
  const provider = providerFor(workspace);
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts");
  const result = host.postedReport;
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  assert.deepEqual(Object.keys(registry.plans).sort(), [
    "experiments/plans/a.yaml", "experiments/plans/b.yaml", "experiments/plans/c.yaml",
  ]);
  assert.equal(registry.plans["experiments/plans/a.yaml"].records.length, 3);
  assert.deepEqual([...new Set(registry.plans["experiments/plans/a.yaml"].records.map((item) => item.workerId))].sort(), ["w1", "w2"]);
  assert.equal(registry.plans["experiments/plans/b.yaml"].records.length, 1);
  assert.equal(registry.plans["experiments/plans/c.yaml"].records.length, 2);
  const mergeAt = host.calls.findIndex((call) => call[0] === "merge");
  const downloadAt = host.calls.findIndex((call) => call[0] === "sync.downloadMappedPaths");
  assert.equal(mergeAt, -1); assert.ok(downloadAt >= 0);
  const downloads = host.calls.filter((call) => call[0] === "sync.downloadMappedPaths");
  assert.equal(host.postedSummary.results.length > 0, true);
  assert.equal(host.calls.some((call) => call[0] === "postState" && call[1] && call[1].discovered === 4), true);
  assert.deepEqual(downloads.map((call) => call[1]).sort(), ["w1", "w2"]);
  assert.equal(downloads.every((call) => call[2].length >= 1), true);
  assert.match(result.skipped.join("\n"), /empty\.yaml/);
  assert.equal(result.discovered, 4);
  assert.match(JSON.stringify(host.postedReport), /发现|empty\.yaml|收录/);
  assert.equal(fs.existsSync(path.join(workspace, "experiments", "results", "set", "final", "final.csv")), true);
});

for (const command of ["syncPendingPlanArtifacts", "rebuildProjectResultTables"]) {
  test(`${command} publishes valid local tables and releases its button with one partial warning`, async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-button-"));
    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
    vscodeStub.window.warnings = [];
    vscodeStub.window.errors = [];
    const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
    const statuses = [];
    const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), providerFor(workspace), {
      postUiCommandStatus: (id, status, name, message, extra) => statuses.push({ id, status, name, message, ...extra }),
      finishPlanSubmissionProgress: () => {},
      recordActionError: error => { throw new Error("partial publication must not record a global failure: " + error.message); },
    });
    const invoke = () => host.withUiCommandStatus("result-button", command, {}, () => host.handleMessageCore({ command }, command));
    await invoke();
    const terminal = statuses.at(-1);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.resultSync.outcome, "partial");
    assert.equal(terminal.resultSync.included, 3);
    assert.equal(terminal.resultSync.skipped, 1);
    assert.match(terminal.message, /empty\.yaml/);
    assert.equal(vscodeStub.window.warnings.length, 1);
    assert.equal(vscodeStub.window.errors.length, 0);
    assert.equal(host.manualResultSyncCounts.size, 0);
    const registryPath = path.join(workspace, "simple_cluster/results/project_table_registry.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    assert.equal(Object.keys(registry.plans).length, 3);
    assert.equal(fs.existsSync(path.join(workspace, "experiments/results/set/final/final.md")), true);
    host.calls.length = 0;
    await invoke();
    assert.equal(statuses.at(-1).resultSync.outcome, "partial");
    assert.equal(vscodeStub.window.warnings.length, 2, "one warning per click, including a repeated click");
    assert.equal(statuses.at(-1).resultSync.included, 3, "a repeated click still reports the actual published Plans");
    assert.equal(vscodeStub.window.errors.length, 0);
  });
}

test("rebuild downloads metrics from both workers before recomputing and does not merge directories", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-rebuild-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const provider = providerFor(workspace);
  provider.loadPlanSyncLedger = async () => ({ schemaVersion: 2, entries: {
    a: { planFile: "experiments/plans/a.yaml", revision: "ra", runId: "run-ra", sourceWorkerId: "w1", artifactPaths: [], directoryPaths: [], destinations: {} },
    b: { planFile: "experiments/plans/b.yaml", revision: "rb", runId: "run-rb", sourceWorkerId: "w2", artifactPaths: [], directoryPaths: [], destinations: {} },
    c: { planFile: "experiments/plans/c.yaml", revision: "rc", runId: "run-rc", sourceWorkerId: "w1", artifactPaths: [], directoryPaths: [], destinations: {} },
  } });
  const { __handleResultUiCommandForTest } = require("../../dist/extension/legacy.js");
  await __handleResultUiCommandForTest(provider, { command: "rebuildProjectResultTables" });
  assert.equal(provider.calls.some((call) => call[0] === "merge"), false);
  assert.deepEqual(provider.calls.filter((call) => call[0] === "sync.downloadMappedPaths").map((call) => call[1]).sort(), ["w1", "w2"]);
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  assert.equal(registry.plans["experiments/plans/a.yaml"].records.length, 3);
  assert.equal(provider.calls.filter((call) => call[0] === "summary").length, 4);
});

test("a failed plan keeps the other completed plans and does not claim full success", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-partial-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  vscodeStub.window.messages = [];
  const provider = providerFor(workspace);
  provider.client.getResultsSummary = async (planFile) => {
    provider.calls.push(["summary", planFile]);
    if (String(planFile).includes("/b.")) throw new Error("summary timeout");
    if (String(planFile).includes("empty")) return { planFile, planRevision: "re", results: [], workerResultTables: [] };
    return {
      planFile, planRevision: planFile.includes("/a.") ? "ra" : "rc",
      workerResultTables: [table(planFile.includes("/a.") ? "w1" : "w1"), ...(planFile.includes("/a.") ? [table("w2")] : [])],
      results: planFile.includes("/a.")
        ? [row("w1", "alpha", 1, 0.81), row("w2", "alpha", 3, 0.83)]
        : [row("w1", "gamma", 1, 0.61, "rc")],
    };
  };
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts");
  const result = host.postedReport;
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  assert.equal(Boolean(registry.plans["experiments/plans/a.yaml"]), true);
  assert.equal(Boolean(registry.plans["experiments/plans/c.yaml"]), true);
  assert.equal(registry.plans["experiments/plans/b.yaml"], undefined);
  assert.match(result.skipped.join("\n"), /b\.yaml/);
  assert.match(result.skipped.join("\n"), /跳过\/失败|b\.yaml/);
});

test("downloaded csv rows fill plans when the server summary has no result rows", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-download-parse-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const provider = providerFor(workspace);
  provider.localPlanMetadata.plans = [{ planFile: "experiments/plans/a.yaml", revision: "ra", seeds: [1, 2, 3] }];
  provider.client.getResultsSummary = async (planFile) => ({
    planFile, planRevision: "ra", workerResultTables: [table("w1"), table("w2")], results: [],
  });
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts");
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  const seeds = registry.plans["experiments/plans/a.yaml"].records.map((item) => item.seed).sort();
  assert.deepEqual(seeds, ["1", "2", "3"]);
  assert.equal(host.postedReport.included.some((line) => line.includes("a.yaml")), true);
});

test("same-revision rerun recovery ignores anonymous shared CSV and publishes only latest attempt jobs", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-run-freshness-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const planFile = "experiments/plans/comparison/ebmc.yaml";
  const seeds = [42, 43, 44];
  const expectedJobs = ["bus_p100", "pad_p100"].flatMap((caseName) => seeds.map((seed) => ({ case: caseName, seed })));
  const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
  const fragments = new Map();
  const makeRun = (id, enqueuedAt, metricBase) => ({
    id, planFile, revision: "revision-ebmc", enqueuedAt, planJobCount: expectedJobs.length,
    jobs: expectedJobs.map(({ case: caseName, seed }, index) => {
      const outputDir = `simple_cluster/runs/ebmc/attempts/${id}/job-${caseName}-${seed}`;
      const raw = `${outputDir}/test_results/formal_result_rows.csv`;
      const fourState = `${outputDir}/test_results/four_state_metrics.csv`;
      const value = (metricBase + index / 100).toFixed(2);
      const dataset = caseName === "bus_p100" ? "BUS" : "PAD";
      const rawText = `case,seed,method,dataset,eval_protocol,AUC,run_id,job_dir\n${caseName},${seed},ebmc,${dataset},p0 Full,${value},${id},${outputDir}\n`;
      const fourText = `run_id,case,seed,job_dir\n${id},${caseName},${seed},${outputDir}\n`;
      fragments.set(raw, rawText);
      fragments.set(fourState, fourText);
      const workerId = index % 2 ? "w2" : "w1";
      return { index, case: caseName, seed, attempt: 1, status: "completed", workerId, outputDir,
        commandId: `${id}-command-${seed}`, artifacts: { [raw]: sha(rawText), [fourState]: sha(fourText) } };
    }),
  });
  const runA = makeRun("run-a", "2026-09-01T00:00:00.000Z", 0.1);
  const runB = makeRun("run-b", "2026-09-02T00:00:00.000Z", 0.8);
  const queue = { schemaVersion: 1, plans: [runA, runB] };
  const provider = providerFor(workspace);
  provider.planFileInput = planFile;
  provider.selectedPlanId = planFile;
  provider.localPlanMetadata.plans = [{ planFile, revision: "revision-ebmc", seeds }];
  provider.distributedQueueCache = queue;
  provider.distributedQueueRoot = workspace;
  provider.loadPlanSyncLedger = async () => ({ schemaVersion: 2, entries: {} });
  const oldSharedPath = "experiments/results/formal/ebmc.csv";
  const staleRow = {
    workerId: "w1", run_id: "run-a", planRevision: "revision-ebmc",
    dimensions: { case: "bus_p100", seed: "42", method: "ebmc", dataset: "BUS", eval_protocol: "p0 Full" },
    metrics: { AUC: { value: 0.11 } }, sourceFiles: [{ path: oldSharedPath }],
  };
  provider.client.getResultsSummary = async () => ({
    planFile, planRevision: "revision-ebmc", completedRunId: null, runId: null,
    projectFinalCsvPath: oldSharedPath,
    workerResultTables: [{ workerId: "w1", aggregateStatus: "ready", rawResultCsvPath: oldSharedPath }],
    results: [staleRow],
  });
  const staleSummary = {
    planFile, planRevision: "revision-ebmc", completedRunId: "run-a", workerResultTables: [{
      workerId: "w1", aggregateStatus: "ready", rawResultCsvPath: oldSharedPath,
    }], results: [staleRow],
  };
  const resultTables = require("../../dist/results/ProjectResultTables.js");
  const resultLayout = require("../../dist/results/ResultLayout.js");
  const previousRegistry = resultTables.updateRegistry(resultTables.emptyTableRegistry(), staleSummary, planFile, seeds.length);
  await provider.writeProjectTableRegistry(workspace, previousRegistry);
  for (const caseName of ["bus_p100", "pad_p100"]) {
    const dataset = caseName === "bus_p100" ? "BUS" : "PAD";
    const oldRemote = `simple_cluster/runs/ebmc/attempts/run-a/job-${caseName}-42/test_results/formal_result_rows.csv`;
    const oldLocal = path.join(workspace, "experiments", "results", ...resultTables.planArtifactPath(resultTables.datasetPathKey(dataset), planFile, "raw", `old-${caseName}.csv`).split("/"));
    fs.mkdirSync(path.dirname(oldLocal), { recursive: true });
    fs.writeFileSync(oldLocal, `case,seed,method,dataset,eval_protocol,AUC,run_id,job_dir\n${caseName},42,ebmc,${dataset},p0 Full,0.11,run-a,${oldRemote.replace(/\/test_results\/formal_result_rows\.csv$/, "")}\n`, "utf8");
  }
  provider.loadDistributedQueue = async () => queue;
  provider.distributedProjectContract = () => ({ resultRowsPath: "test_results/formal_result_rows.csv", fourStatePath: "test_results/four_state_metrics.csv" });
  provider.postprocessDistributedResultsForManual = async (_root, scope) => { provider.calls.push(["postprocess", scope]); };
  provider.mappedDownloadServerForSource = (workerId) => target(workerId);
  provider.confirmMappedResultDownloads = async (_context, _client, batches) => {
    provider.selectedDownloadEntries = batches.flatMap((batch) => batch.entries || []);
    return { cancelled: false, overwrite: true, batches, skippedExisting: 0 };
  };
  provider.simpleSftpApiCall = async (method, params) => {
    provider.calls.push([method, params.server?.id, params.scopePaths || params.entries?.map((entry) => entry.remotePath) || []]);
    if (method === "sync.projectInventory") {
      const files = {};
      for (const remote of params.scopePaths) {
        const body = fragments.get(remote);
        files[remote] = { size: Buffer.byteLength(body || "", "utf8"), sha256: body ? sha(body) : "" };
      }
      return { ok: true, files };
    }
    if (method === "sync.downloadMappedPaths") {
      return { ok: true, memoryOnly: true, entries: params.entries.map(entry => {
        const body = fragments.get(entry.remotePath);
        assert.ok(body, `unexpected remote artifact ${entry.remotePath}`);
        return { remotePath: entry.remotePath, bytes: entry.bytes, sha256: entry.sha256, dataBase64: Buffer.from(body).toString("base64") };
      }) };
    }
    throw new Error("unexpected SimpleSFTP method " + method);
  };
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts");
  await RealtimeTunnelPanelProvider.prototype.rebuildProjectResultTablesFromUi.call(host);
  host.actionBody = (value) => value;
  host.resolveSelectedPlanFile = (hint = "") => String(hint || planFile);
  host.filterResultsSummaryForPlan = (value) => value;
  host.refreshResultsSummary = async () => { host.resultsSummary = await provider.client.getResultsSummary(planFile); };
  await RealtimeTunnelPanelProvider.prototype.syncAllResultArtifactsFromUi.call(host, { planFile });

  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  const records = registry.plans[planFile].records;
  assert.deepEqual([...new Set(records.map((record) => record.runId))], ["run-b"]);
  for (const dataset of ["BUS", "PAD"]) {
    const datasetRecords = records.filter((record) => record.dataset === dataset);
    assert.deepEqual([...new Set(datasetRecords.map((record) => record.seed))].sort(), ["42", "43", "44"]);
    const methodPath = path.join(workspace, "experiments", "results", ...resultLayout.tablePaths(resultTables.datasetPathKey(dataset), "ebmc", "method").relativePath.split("/"));
    const methodCsv = fs.readFileSync(methodPath, "utf8").trim().split("\n").map((line) => line.split(","));
    const header = methodCsv[0];
    const row = methodCsv[1];
    assert.equal(row[header.indexOf("jobs")], "3");
    assert.equal(Number(row[header.indexOf("roc_auc_mean")]), dataset === "BUS" ? 0.81 : 0.84);
  }
  assert.equal(records.every((record) => record.metrics.AUC >= 0.8), true);
  assert.equal(host.calls.some((call) => call[0] === "postprocess"), false);
  assert.equal(host.calls.some((call) => call[0] === "merge" && call[1].includes(oldSharedPath)), false);
  const downloadedRaw = host.calls.flatMap((call) => call[0] === "sync.downloadMappedPaths" ? call[2] : [])
    .filter((remote) => remote.endsWith("/formal_result_rows.csv"));
  assert.deepEqual([...new Set(downloadedRaw)].sort(), runB.jobs.map((job) => `${job.outputDir}/test_results/formal_result_rows.csv`).sort());
  for (const remotePath of downloadedRaw) {
    const text = fragments.get(remotePath);
    const header = text.trim().split("\n")[0].split(",");
    const fields = text.trim().split("\n")[1].split(",");
    assert.equal(fields[header.indexOf("run_id")], "run-b");
    assert.equal(fields[header.indexOf("job_dir")], remotePath.replace(/\/test_results\/formal_result_rows\.csv$/, ""));
  }
  for (const caseName of ["bus_p100", "pad_p100"]) {
    const dataset = caseName === "bus_p100" ? "BUS" : "PAD";
    const oldLocal = path.join(workspace, "experiments", "results", ...resultTables.planArtifactPath(resultTables.datasetPathKey(dataset), planFile, "raw", `old-${caseName}.csv`).split("/"));
    assert.match(fs.readFileSync(oldLocal, "utf8"), /,run-a,/);
  }
  assert.equal(records.every((record) => record.runId !== "run-a"), true);
});

test("yaml newer than the trusted completed run still publishes that completed run", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-old-run-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const provider = providerFor(workspace);
  provider.localPlanMetadata.plans = [{ planFile: "experiments/plans/a.yaml", revision: "yaml-new", seeds: [1, 2, 3] }];
  provider.loadPlanSyncLedger = async () => ({ schemaVersion: 2, entries: { done: {
    planFile: "experiments/plans/a.yaml", revision: "ra", runId: "run-ra", sourceWorkerId: "w1",
    artifactPaths: ["simple_cluster/results/w1/raw.csv"], directoryPaths: ["simple_cluster/results/w1"], destinations: {},
  } } });
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  host.planVersionForFile = RealtimeTunnelPanelProvider.prototype.planVersionForFile;
  host.filterResultsSummaryForPlan = RealtimeTunnelPanelProvider.prototype.filterResultsSummaryForPlan;
  host.resolveSelectedPlanFile = (hint = "") => String(hint || "");
  host.client.getResultsSummary = async () => ({
    planFile: "experiments/plans/a.yaml", planRevision: "ra", completedRunId: "run-ra",
    results: [
      row("w1", "alpha", 1, 0.81),
      { ...row("w1", "other", 9, 0.1), planFile: "experiments/plans/b.yaml" },
    ],
    workerResultTables: [table("w1"), table("w2")],
  });
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts");
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  assert.equal(registry.plans["experiments/plans/a.yaml"].revision, "ra");
  assert.equal(registry.plans["experiments/plans/a.yaml"].records.some((item) => item.case === "other"), false);
  assert.match(host.postedReport.skipped.join("\n"), /yaml-new/);
});

test("a plan known only from the registry is still discovered", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-registry-plan-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  fs.mkdirSync(path.join(workspace, "simple_cluster", "results"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), JSON.stringify({
    schemaVersion: 1, plans: { "experiments/plans/c.yaml": { revision: "rc", expectedSeeds: 2, records: [] } },
  }));
  const provider = providerFor(workspace);
  provider.localPlanMetadata.plans = [];
  provider.loadPlanSyncLedger = async () => ({ schemaVersion: 2, entries: {} });
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts");
  assert.equal(host.postedReport.discovered, 1);
  assert.equal(Boolean(host.postedReport.plans.includes("experiments/plans/c.yaml")), true);
});

test("one failed worker is omitted and the successful worker is published", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-one-source-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const provider = providerFor(workspace);
  provider.localPlanMetadata.plans = [{ planFile: "experiments/plans/a.yaml", revision: "ra", seeds: [1, 2, 3] }];
  const firstSftp = provider.simpleSftpApiCall;
  provider.simpleSftpApiCall = async (method, params) => {
    if ((params.server || params.source).id === "w2") throw new Error("w2 ssh closed");
    return firstSftp(method, params);
  };
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts");
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  const workers = [...new Set(registry.plans["experiments/plans/a.yaml"].records.map((item) => item.workerId))];
  assert.deepEqual(workers, ["w1"]);
  assert.match(host.postedReport.skipped.join("\n"), /w2/);
});

test("nested comparison plans are discovered and a conflicting metric path blocks only that plan", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-nested-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const provider = providerFor(workspace);
  const nested = ["experiments/plans/comparison/drf.yaml", "experiments/plans/comparison/dpl.yaml", "experiments/plans/comparison/nested/x.yaml"];
  provider.localPlanMetadata.plans = nested.map((planFile) => ({ planFile, revision: "rn", seeds: [1] }));
  provider.loadPlanSyncLedger = async () => ({ schemaVersion: 2, entries: {} });
  provider.client.getResultsSummary = async (planFile) => ({
    planFile, planRevision: "rn",
    workerResultTables: [{ workerId: planFile.includes("/comparison/nested/") ? "w2" : "w1", rawResultCsvPath: "simple_cluster/results/" + planFile.split("/").at(-2) + "/raw.csv", aggregateStatus: "ready" }],
    results: [{ workerId: "w1", dimensions: { case: "alpha", seed: "1", method: "method", dataset: "set", eval_protocol: "holdout" }, metrics: { AUC: { value: 0.5 } }, sourceFiles: [{ path: "simple_cluster/results/" + planFile.split("/").at(-2) + "/raw.csv" }] }],
  });
  const nestedSftp = provider.simpleSftpApiCall;
  provider.simpleSftpApiCall = async (method, params) => {
    if ((params.scopePaths || params.entries?.map(entry => entry.remotePath) || []).some(file => file.includes("comparison/raw.csv"))) throw new Error("comparison raw SHA256 evidence unavailable");
    return nestedSftp(method, params);
  };
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts");
  assert.deepEqual(host.postedReport.plans, nested);
  assert.match(JSON.stringify(host.postedReport), /drf\.yaml/);
  assert.equal(host.calls.some((call) => call[0] === "sync.downloadMappedPaths" && JSON.stringify(call).includes("comparison/raw.csv")), false);
});

test("an existing w2 record stays when this sync fails w2 and updates w1", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-keep-w2-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  fs.mkdirSync(path.join(workspace, "simple_cluster", "results"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), JSON.stringify({ schemaVersion: 1, plans: { "experiments/plans/a.yaml": { revision: "ra", expectedSeeds: 3, records: [
    { planFile: "experiments/plans/a.yaml", workerId: "w2", case: "alpha", seed: "3", method: "method", dataset: "set", rate: "", endpoint: "holdout", metrics: { AUC: 0.83 }, runId: "run-ra", attempt: "1", revision: "ra" },
  ] } } }));
  const provider = providerFor(workspace);
  provider.localPlanMetadata.plans = [{ planFile: "experiments/plans/a.yaml", revision: "ra", seeds: [1, 2, 3] }];
  provider.loadPlanSyncLedger = async () => ({ schemaVersion: 2, entries: { done: { planFile: "experiments/plans/a.yaml", revision: "ra", runId: "run-ra", sourceWorkerId: "w1", artifactPaths: [], directoryPaths: [], destinations: {} } } });
  provider.client.getResultsSummary = async () => ({
    planFile: "experiments/plans/a.yaml", planRevision: "ra", completedRunId: "run-ra",
    workerResultTables: [table("w1"), table("w2")],
    results: [row("w1", "alpha", 1, 0.81), row("w2", "alpha", 3, 0.99)],
  });
  const existingSftp = provider.simpleSftpApiCall;
  provider.simpleSftpApiCall = async (method, params) => {
    if ((params.server || params.source).id === "w2") throw new Error("w2 ssh closed");
    return existingSftp(method, params);
  };
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts");
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  const records = registry.plans["experiments/plans/a.yaml"].records;
  assert.equal(records.find((item) => item.workerId === "w2").metrics.AUC, 0.83);
  assert.equal(records.some((item) => item.workerId === "w1" && item.seed === "1"), true);
});

test("a missing owner does not publish server rows and a partial worker aggregate keeps the verified worker", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-partial-owner-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const provider = providerFor(workspace);
  provider.localPlanMetadata.plans = [{ planFile: "experiments/plans/a.yaml", revision: "ra", seeds: [1, 2] }];
  provider.loadPlanSyncLedger = async () => ({ schemaVersion: 2, entries: {} });
  const { mergeWorkerResultsSummaries } = require("../../dist/tunnel/MultiEndpointRealtimeClient.legacy.js");
  const merged = mergeWorkerResultsSummaries([
    { workerId: "w1", summary: { planFile: "experiments/plans/a.yaml", planRevision: "ra", aggregateStatus: "ready", rawResultCsvPath: "simple_cluster/results/w1/raw.csv", results: [row("w1", "alpha", 1, 0.81)] } },
  ], "experiments/plans/a.yaml", ["w1", "w2"]);
  provider.client.getResultsSummary = async () => ({
    ...merged,
    rawResultCsvPath: "simple_cluster/results/w1/raw.csv",
    workerResultTables: [{ ...(merged.workerResultTables || [])[0], workerId: "w1", aggregateStatus: "ready", rawResultCsvPath: "simple_cluster/results/w1/raw.csv" }],
    results: [{ ...merged.results[0], workerId: "w1", sourceFiles: [{ path: "simple_cluster/results/w1/raw.csv" }] }],
  });
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "rebuildProjectResultTables" }, "rebuildProjectResultTables");
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  assert.deepEqual(registry.plans["experiments/plans/a.yaml"].records.map((item) => [item.workerId, item.seed]), [["w1", "1"], ["w1", "2"]]);
  assert.match(JSON.stringify(host.resultSyncReport || {}), /w2|unavailable|缺/);
});

test("three plans survive a real request budget cooldown and cancel publishes nothing", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-budget-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const { RequestBudgetDeniedError } = require("../../dist/tunnel/RequestBudget.js");
  const provider = providerFor(workspace);
  provider.localPlanMetadata.plans = ["a", "b", "c"].map((name) => ({ planFile: "experiments/plans/" + name + ".yaml", revision: "r" + name, seeds: [1] }));
  let hits = 0;
  provider.client.getResultsSummary = async (planFile) => {
    hits += 1;
    if (hits === 1) throw new RequestBudgetDeniedError("manual_refresh", { allowed: false, reason: "cooldown", retryAfterMs: 1000 });
    const owner = planFile.includes("/b.") ? "w2" : "w1";
    return { planFile, planRevision: planFile.includes("/b.") ? "rb" : planFile.includes("/c.") ? "rc" : "ra", workerResultTables: [table(owner)], results: [row(owner, "alpha", 1, 0.5, planFile.includes("/b.") ? "rb" : planFile.includes("/c.") ? "rc" : "ra")] };
  };
  provider.resultSummaryBudgetWait = async (delay, label, isCurrent, token) => {
    provider.calls.push(["budget-wait", delay, label, token.isCancellationRequested]);
    if (token.isCancellationRequested || !isCurrent()) throw new Error("cancelled");
  };
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts");
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  assert.equal(Object.keys(registry.plans).length, 3);
  assert.equal(host.calls.some((call) => call[0] === "budget-wait" && call[1] === 1000), true);

  const cancelled = providerFor(workspace);
  cancelled.localPlanMetadata.plans = provider.localPlanMetadata.plans;
  cancelled.client.getResultsSummary = async () => { throw new RequestBudgetDeniedError("manual_refresh", { allowed: false, reason: "rate_limited", retryAfterMs: 1000 }); };
  cancelled.resultSummaryBudgetWait = async (_delay, _label, _isCurrent, token) => { token.isCancellationRequested = true; };
  const cancelHost = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), cancelled);
  await assert.rejects(RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(cancelHost, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts"), /已取消/);
  assert.equal(cancelHost.calls.some((call) => call[0] === "postState"), false);
  assert.equal(fs.existsSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json")), true);
});

test("cancelling the first worker aborts its RPC and never starts the second owner", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-cancel-source-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const previous = vscodeStub.window.withProgress;
  const listeners = new Set();
  const token = { isCancellationRequested: false, onCancellationRequested(fn) { listeners.add(fn); return {dispose() {listeners.delete(fn);}}; } };
  vscodeStub.window.withProgress = async (_options, task) => task({ report() {} }, token);
  const provider = providerFor(workspace);
  provider.localPlanMetadata.plans = [{ planFile: "experiments/plans/a.yaml", revision: "ra", seeds: [1, 2, 3] }];
  const sftp = provider.simpleSftpApiCall;
  provider.simpleSftpApiCall = async (method, params) => {
    if (method !== "sync.downloadMappedPaths") return sftp(method, params);
    provider.calls.push([method, params.server.id]);
    token.isCancellationRequested = true;
    for (const fn of listeners) fn();
    assert.equal(params.signal.aborted, true);
    throw params.signal.reason;
  };
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  try {
    await assert.rejects(host.syncPendingResultMetricsFromUi(), /已取消/);
    assert.equal(host.resultsSummary, undefined);
    assert.equal(host.calls.filter(call => call[0] === "sync.downloadMappedPaths").some(call => call[1] === "w2"), false);
    assert.equal(listeners.size, 0);
    assert.equal(fs.existsSync(path.join(workspace,"simple_cluster/results/project_table_registry.json")), false);
  } finally { vscodeStub.window.withProgress = previous; }
});

test("a ledger run does not stamp anonymous summary rows and a contradictory run keeps the old table", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-anonymous-run-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const provider = providerFor(workspace);
  provider.localPlanMetadata.plans = [{ planFile: "experiments/plans/a.yaml", revision: "ra", seeds: [1] }];
  provider.loadPlanSyncLedger = async () => ({ schemaVersion: 2, entries: { done: { planFile: "experiments/plans/a.yaml", revision: "ra", runId: "run-ledger", sourceWorkerId: "w1", artifactPaths: [], directoryPaths: [], destinations: {} } } });
  const anonymous = row("w1", "alpha", 1, 0.81);
  delete anonymous.runId;
  provider.client.getResultsSummary = async () => ({ planFile: "experiments/plans/a.yaml", planRevision: "ra", workerResultTables: [table("w1")], results: [anonymous] });
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "rebuildProjectResultTables" }, "rebuildProjectResultTables");
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  assert.equal(registry.plans["experiments/plans/a.yaml"].records[0].runId || "", "");
  assert.match(JSON.stringify(host.resultSyncReport), /run-ledger/);

  const contradictory = providerFor(workspace);
  contradictory.localPlanMetadata.plans = provider.localPlanMetadata.plans;
  contradictory.loadPlanSyncLedger = provider.loadPlanSyncLedger;
  contradictory.client.getResultsSummary = async () => ({ planFile: "experiments/plans/a.yaml", planRevision: "ra", completedRunId: "run-other", workerResultTables: [table("w1")], results: [anonymous] });
  const other = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), contradictory);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(other, { command: "rebuildProjectResultTables" }, "rebuildProjectResultTables");
  const kept = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  assert.equal(kept.plans["experiments/plans/a.yaml"].records[0].runId || "", "");
  assert.match(JSON.stringify(other.resultSyncReport), /矛盾/);
});

test("a budget-limited second worker is retried and an offline worker stays reported", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-worker-budget-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const { mergeWorkerResultsSummaries } = require("../../dist/tunnel/MultiEndpointRealtimeClient.legacy.js");
  const provider = providerFor(workspace);
  provider.localPlanMetadata.plans = [{ planFile: "experiments/plans/a.yaml", revision: "ra", seeds: [1, 2, 3] }];
  provider.loadPlanSyncLedger = async () => ({ schemaVersion: 2, entries: {} });
  let calls = 0;
  const partial = mergeWorkerResultsSummaries([
    { workerId: "w1", summary: { planFile: "experiments/plans/a.yaml", planRevision: "ra", aggregateStatus: "ready", rawResultCsvPath: "simple_cluster/results/w1/raw.csv", results: [row("w1", "alpha", 1, 0.81), row("w1", "alpha", 2, 0.82)] } },
  ], "experiments/plans/a.yaml", ["w1", "w2"]);
  const complete = mergeWorkerResultsSummaries([
    { workerId: "w1", summary: { planFile: "experiments/plans/a.yaml", planRevision: "ra", aggregateStatus: "ready", rawResultCsvPath: "simple_cluster/results/w1/raw.csv", results: [row("w1", "alpha", 1, 0.81), row("w1", "alpha", 2, 0.82)] } },
    { workerId: "w2", summary: { planFile: "experiments/plans/a.yaml", planRevision: "ra", aggregateStatus: "ready", rawResultCsvPath: "simple_cluster/results/w2/raw.csv", results: [row("w2", "alpha", 3, 0.83)] } },
  ], "experiments/plans/a.yaml", ["w1", "w2"]);
  provider.client.getResultsSummary = async () => {
    calls += 1;
    const summary = calls === 1 ? partial : complete;
    return { ...summary, results: summary.results.map((item) => ({ ...item, sourceFiles: [{ path: "simple_cluster/results/" + item.workerId + "/raw.csv" }] })) };
  };
  provider.client.budgetSnapshots = () => ({ w2: { lastDeniedReason: "cooldown", lastAllowedAt: new Date(Date.now() - 200).toISOString(), requestsLastMinute: 1 } });
  provider.resultSummaryBudgetWait = async (delay) => { provider.calls.push(["budget-wait", delay]); };
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "syncPendingPlanArtifacts" }, "syncPendingPlanArtifacts");
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  assert.deepEqual(registry.plans["experiments/plans/a.yaml"].records.map((item) => item.seed).sort(), ["1", "2", "3"]);
  assert.equal(calls, 2);

  fs.writeFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), JSON.stringify({ schemaVersion: 1, plans: {} }));
  const offline = providerFor(workspace);
  offline.localPlanMetadata.plans = provider.localPlanMetadata.plans;
  offline.loadPlanSyncLedger = provider.loadPlanSyncLedger;
  offline.client.getResultsSummary = async () => ({ ...partial, results: partial.results.map((item) => ({ ...item, sourceFiles: [{ path: "simple_cluster/results/w1/raw.csv" }] })) });
  offline.client.budgetSnapshots = () => ({ w2: { lastDeniedReason: "offline" } });
  const offlineHost = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), offline);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(offlineHost, { command: "rebuildProjectResultTables" }, "rebuildProjectResultTables");
  const partialRegistry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  assert.deepEqual([...new Set(partialRegistry.plans["experiments/plans/a.yaml"].records.map((item) => item.workerId))], ["w1"]);
  assert.match(JSON.stringify(offlineHost.resultSyncReport), /w2/);
  assert.doesNotMatch(JSON.stringify(offlineHost.resultSyncReport.skipped || []), /^$/);
});

test("an existing trusted summary updates the table without download and a bad plan does not block the next", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-zero-download-"));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspace, scheme: "file", path: workspace } }];
  const provider = providerFor(workspace);
  provider.localPlanMetadata.plans = [
    { planFile: "experiments/plans/a.yaml", revision: "ra", seeds: [1] },
    { planFile: "experiments/plans/b.yaml", revision: "rb", seeds: [1] },
  ];
  provider.loadPlanSyncLedger = async () => ({ schemaVersion: 2, entries: {} });
  provider.client.getResultsSummary = async (planFile) => {
    if (String(planFile).includes("/a.")) return {
      planFile, planRevision: "ra", workerResultTables: [table("w1")],
      results: [{ ...row("w1", "alpha", 1, 0.81), metrics: { AUC: { value: Number.NaN } } }],
    };
    return { planFile, planRevision: "rb", workerResultTables: [table("w2")], results: [row("w2", "beta", 1, 0.71, "rb")] };
  };
  const { RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), provider);
  await RealtimeTunnelPanelProvider.prototype.handleMessageCore.call(host, { command: "rebuildProjectResultTables" }, "rebuildProjectResultTables");
  const registry = JSON.parse(fs.readFileSync(path.join(workspace, "simple_cluster", "results", "project_table_registry.json"), "utf8"));
  assert.equal(Boolean(registry.plans["experiments/plans/b.yaml"]), true);
  assert.equal(host.calls.some((call) => call[0] === "postState"), true);
  assert.match(JSON.stringify(host.resultSyncReport), /a\.yaml/);
});
