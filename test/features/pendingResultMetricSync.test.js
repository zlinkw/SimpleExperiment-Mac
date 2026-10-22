// 本文件锚定“结果按钮 → 一次主动查询采集”的入口契约与本机分发安全层。
// 移植后的权威链路（Windows 0.5.400 同源）：三个结果按钮都汇入 rebuildProjectResultTablesFromUi
// → ResultCollectionHost.update 的主动查询；旧账本/服务器汇总/登记表/镜像不再是指标来源，
// 因此旧文件里基于 ledger/summary/registry/mirror 的场景在这里映射为等价的内存链路不变式。
// 宿主租约冲突等待、锁内暂存复用等只能在 Windows Extension Host 执行（currentHostOperationLeaseContext
// 在非 win32 直接拒绝）；这里如实钉住 Mac 侧的显式拒绝与“提交前本地围栏”，Windows 侧覆盖由配套 Windows 仓库门禁承担。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
require("../_helpers/registerTsRequire");

const extensionRoot = path.join(__dirname, "..", "..");
const extensionSource = fs.readFileSync(path.join(extensionRoot, "src", "extension", "legacy.ts"), "utf8");
const panelSource = fs.readFileSync(path.join(extensionRoot, "src", "ui", "PanelHtml.legacy.ts"), "utf8");
const tablesPath = path.join(extensionRoot, "src", "results", "ProjectResultTables.ts");
const tablesModule = new Module(tablesPath, module);
tablesModule.filename = tablesPath;
tablesModule.paths = Module._nodeModulePaths(path.dirname(tablesPath));
tablesModule._compile(ts.transpileModule(fs.readFileSync(tablesPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, tablesPath);

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
    showWarningMessage: async (text) => { vscodeStub.window.warnings.push(String(text)); },
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
const originalTsLoader = Module._extensions[".ts"];
Module._extensions[".ts"] = (loadedModule, filename) => {
  loadedModule._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  if (request === "node:worker_threads" || request === "worker_threads") {
    const workerThreads = originalLoad.call(this, request, parent, isMain);
    return { ...workerThreads, Worker: class extends workerThreads.Worker { constructor(filename, options) {
      super(String(filename).endsWith(path.join("src", "results", "ProjectResultCatalogWorker.js"))
        ? path.join(extensionRoot, "dist/results/ProjectResultCatalogWorker.js") : filename, options);
    } } };
  }
  if (request.startsWith("../vendor/semver/")) return originalLoad.call(this, path.join(extensionRoot, "dist/vendor/semver", request.slice("../vendor/semver/".length)), parent, isMain);
  if (request === "../results/ProjectResultTables" && parent?.filename.endsWith(path.join("src", "extension", "legacy.ts"))) return tablesModule.exports;
  if (request === "../results/ProjectResultCatalog") return originalLoad.call(this, path.join(extensionRoot, "dist/results/ProjectResultCatalog.js"), parent, isMain);
  return originalLoad.call(this, request, parent, isMain);
};
const { __syncPendingResultMetricsForTest, RealtimeTunnelPanelProvider } = require("../../src/extension/legacy.ts");
// withHostOperationLease 在运行期才懒加载 ../updates/Bootstrap（semver 供应商链接只在 shim 生效时可解析），
// 必须在 shim 拆除前预热，否则发布门的真实拒绝会被模块解析错误掩盖。
require(path.join(extensionRoot, "src/updates/Bootstrap.ts"));
Module._load = originalLoad;
if (originalTsLoader) Module._extensions[".ts"] = originalTsLoader;
else delete Module._extensions[".ts"];
const { ResultCollectionHost } = require("../../src/extension/ResultCollectionHost.ts");
const { resultDigest } = require("../../src/results/FreshResults.ts");

function target(id) {
  return { id, host: id + ".example", user: "exp", port: 22, remotePath: "/projects/" + id };
}
const sha = (text) => resultDigest(text);

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} .. ${end}`);
  return source.slice(from, to);
}

/** 内存直查 fixture：每个已启用 Worker 汇报全部声明 job，本轮导出只由本轮核实字节重建。 */
function syncFixture(options = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-pending-metric-"));
  const specs = options.specs || [
    { planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }, { case: "alpha", seed: 2 }] },
    { planFile: "experiments/plans/b.yaml", jobs: [{ case: "beta", seed: 1 }, { case: "beta", seed: 2 }] },
  ];
  const state = { offline: new Set(), rpcFail: new Set(), readFail: new Set(), empty: new Set(), dropResults: new Set(),
    runOverrides: {}, values: {}, csvText: {} };
  const workers = options.workers || ["w1", "w2"];
  const calls = [];
  const posted = [];
  for (const spec of specs) {
    spec.planKey = spec.planFile.split("/").pop().replace(/\.ya?ml$/, "");
    spec.text = `suite: ${spec.planKey}\nseeds: [${spec.jobs.map(job => job.seed).join(", ")}]\n`;
    spec.revision = sha(spec.text);
    fs.mkdirSync(path.join(workspace, path.dirname(spec.planFile)), { recursive: true });
    fs.writeFileSync(path.join(workspace, spec.planFile), spec.text, "utf8");
    spec.jobs.forEach((job, index) => {
      job.index = index;
      job.outputDir = `work_dirs/${spec.planKey}-${index}`;
      job.resultCsv = `${job.outputDir}/metrics.csv`;
      job.runId = `cmd-${spec.planKey}-${index}`;
    });
  }
  const manifestText = (spec, job) => JSON.stringify({ simpleExperiment: {
    runId: state.runOverrides[`${spec.planFile}:${job.index}`] || job.runId, status: "completed", mode: "test",
    job: { index: job.index, case: job.case, seed: job.seed }, outputDir: job.outputDir, resultCsv: job.resultCsv, weights: [] } });
  const csvText = (spec, job) => {
    const key = `${spec.planFile}:${job.index}`;
    if (state.csvText[key]) return state.csvText[key];
    const value = state.values[key] ?? (0.5 + job.seed / 100).toFixed(2);
    return `case,seed,method,dataset,metric,value\n${job.case},${job.seed},m-${spec.planKey},set,AUC,${value}\n`;
  };
  const jobRaw = (spec, job) => ({ [`${job.outputDir}/artifact_manifest.json`]: manifestText(spec, job), [job.resultCsv]: csvText(spec, job) });
  const allRaw = () => Object.assign({}, ...specs.flatMap(spec => spec.jobs.map(job => jobRaw(spec, job))));
  const host = {
    calls, workspace, state, specs, panelDisposed: false, resultCsvDirectory: "experiments/results",
    captureProjectContext: () => ({ root: workspace, generation: 1 }), projectContextIsCurrent: () => true,
    workerCodeSyncTargets: () => workers.map(target),
    localPlanMetadata: { plans: specs.map(spec => ({ planFile: spec.planFile, revision: spec.revision })) },
    currentResultPlanInputs: async () => specs.map(spec => ({ planFile: spec.planFile, revision: spec.revision, mode: "test",
      seeds: spec.jobs.map(job => job.seed), jobCount: spec.jobs.length })),
    resultAdapterRules: () => ({ csvColumnMapping: options.adapterRules || {} }),
    parseFreshResultMetric: RealtimeTunnelPanelProvider.prototype.parseFreshResultMetric,
    hostOperationLease: { run: async (request, operation) => { calls.push(["lease", request.actionType]); return operation(); } },
    client: {
      getWorkerTasks: async (workerId, request) => {
        calls.push(["tasks", workerId, request.discovery ? "discover:" + request.discovery.planFile : "observe"]);
        if (state.rpcFail.has(workerId)) throw new Error(workerId + " rpc closed");
        if (state.offline.has(workerId)) throw new TypeError("fetch failed");
        if (request.discovery) {
          const spec = specs.find(row => row.planFile === request.discovery.planFile);
          if (!spec || state.empty.has(spec.planFile)) return { queryComplete: true, capabilities: { resultCollection: 1 }, declaredJobs: [] };
          return { queryComplete: true, capabilities: { resultCollection: 1 }, declaredJobs: spec.jobs.map(job => ({
            index: job.index, case: job.case, seed: job.seed, output_dir: job.outputDir, result_csv: job.resultCsv, planHash: spec.revision })) };
        }
        const declaredResults = [];
        for (const declared of request.declarations || []) {
          const spec = specs.find(row => row.planFile === declared.planFile);
          if (!spec || state.empty.has(spec.planFile)) continue;
          const job = spec.jobs.find(row => row.index === declared.index && row.outputDir === declared.output_dir);
          if (!job || state.offline.has(workerId)) continue;
          if (state.dropResults.has(`${workerId}:${spec.planFile}:${job.index}`)) continue;
          const runId = state.runOverrides[`${spec.planFile}:${job.index}`] || job.runId;
          const raw = jobRaw(spec, job);
          declaredResults.push({ index: job.index, outputDir: job.outputDir, completed: true, runId,
            runtimeDiagnostics: { schemaVersion: 1, commandId: runId, runId, state: "clear", count: 0, scanComplete: true },
            files: Object.entries(raw).map(([remotePath, text]) => ({ remotePath, bytes: Buffer.byteLength(text), sha256: sha(text) })) });
        }
        return { queryComplete: true, capabilities: { resultCollection: 1 }, tasks: [], declaredResults };
      },
      getResultsSummary: async () => { throw new Error("the server summary must not supply fresh results"); },
      downloadWorkerFile: async () => { throw new Error("worker file download RPC must not be used for metrics"); },
      downloadFile: async () => { throw new Error("hub download RPC must not be used for metrics"); },
    },
    simpleSftpCapability: async () => ({ methodOptions: { "sync.downloadMappedPaths": { memoryOnly: true, memoryWrapperResults: true } } }),
    sftpServerOptions: (row) => { calls.push(["serverOptions", row.id]); return row; },
    simpleSftpApiCall: async (method, params) => {
      assert.equal(method, "sync.downloadMappedPaths");
      assert.equal(params.memoryOnly, true);
      assert.equal(params.metricsOnly, true);
      assert.equal(params.server.host, params.server.id + ".example");
      assert.equal(params.server.remotePath, "/projects/" + params.server.id);
      calls.push(["dl", params.server.id, params.entries.map(entry => entry.remotePath)]);
      if (state.readFail.has(params.server.id)) throw new Error(params.server.id + " ssh closed");
      const raw = allRaw();
      return { ok: true, memoryOnly: true, entries: params.entries.map(entry => {
        const text = raw[entry.remotePath];
        if (typeof text !== "string") throw new Error("unrequested remote path " + entry.remotePath);
        return { remotePath: entry.remotePath, bytes: entry.bytes, sha256: entry.sha256, dataBase64: Buffer.from(text).toString("base64") };
      }) };
    },
    refreshLocalResultCatalogForProject: async () => {},
    postState() { calls.push(["postState"]); posted.push({ summary: this.resultsSummary, brief: this.resultSyncReport }); },
    recordActionError(entry) { calls.push(["recordActionError", entry.command, entry.message]); },
    distributedQueueCache: { plans: [] },
    loadDistributedQueue: async () => { throw new Error("queue must not supply results"); },
    loadPlanSyncLedger: async () => { throw new Error("ledger must not supply results"); },
    loadProjectTableRegistry: async () => { throw new Error("registry must not supply results"); },
  };
  const ui = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), host, {
    context: { globalStorageUri: { fsPath: workspace } },
    manualResultSyncCounts: new Map(),
    runningBuildIdentity: require("../../dist/features/PanelBuildIdentity").readPanelBuildIdentity(extensionRoot, undefined, require("../../package.json").version),
    panelHostEventLoopSamples: [], panelLayoutEvents: [], panelIncidentEvents: [], panelIncidentSlots: { previous: null }, panelLifecycleDiagnostics: [],
    planFileInput: specs[0].planFile, selectedPlanId: "", statuses: [],
    postUiCommandStatus: function (id, status, name, message, extra) { (this.statuses ||= []).push({ id, status, name, message, ...extra }); },
    finishPlanSubmissionProgress: () => {},
    beginSimpleSftpCapabilityLaunch: () => {},
  });
  const service = new ResultCollectionHost(ui);
  const finalCsv = () => path.join(workspace, "experiments", "results", "set", "final", "final.csv");
  const click = (command, message = {}) => ui.withUiCommandStatus("result-button-" + command, command, message,
    () => ui.handleMessageCore({ command, ...message }, command));
  return { workspace, host: ui, specs, state, workers, calls, posted, click, finalCsv,
    update: (signal) => service.update(signal),
    readTable: () => tablesModule.exports.readCsv(fs.readFileSync(finalCsv(), "utf8")),
    latest: () => JSON.parse(fs.readFileSync(path.join(workspace, "experiments/results/latest-results.json"), "utf8")),
    downloadCalls: (since = 0) => calls.slice(since).filter(call => call[0] === "dl"),
    tasks: (since = 0) => calls.slice(since).filter(call => call[0] === "tasks") };
}

for (const command of ["syncPendingPlanArtifacts", "rebuildProjectResultTables", "syncAllResultArtifacts"]) {
  test(`${command} publishes only the newest queue-bound run and never borrows the previous attempt's bytes`, async () => {
    const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }, { case: "alpha", seed: 2 }] }] });
    const spec = f.specs[0];
    const planEntry = (suffix, enqueuedAt) => ({ id: "plan-demo", projectId: f.workspace, planFile: spec.planFile,
      revision: spec.revision, codeFingerprint: "fp-a", enqueuedAt, jobs: spec.jobs.map(job => ({
        index: job.index, case: job.case, seed: job.seed, status: "completed", workerId: "w1",
        commandId: `run-${suffix}-${job.index}`, outputDir: job.outputDir, collectionResultCsv: job.resultCsv })) });
    f.host.distributedQueueCache = { plans: [planEntry("b", "2026-10-01T00:00:00.000Z")] };
    f.state.runOverrides[`${spec.planFile}:0`] = "run-b-0";
    f.state.runOverrides[`${spec.planFile}:1`] = "run-b-1";
    for (const job of spec.jobs) f.state.values[`${spec.planFile}:${job.index}`] = "0.62";
    await f.click(command);
    const terminal = f.host.statuses.at(-1);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.resultSync.outcome, "completed", JSON.stringify(f.posted.at(-1).summary.missing));
    const table = f.readTable();
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0][table.header.indexOf("roc_auc_mean")], "0.62");
    assert.deepEqual([...new Set(f.latest().jobs.map(job => job.commandId))].sort(), ["run-b-0", "run-b-1"]);
    const publishedCsv = fs.readFileSync(f.finalCsv(), "utf8");

    // 再次入队 run-c 后服务器仍回旧 attempt：owner 绑定必须拒绝旧身份，旧表逐字节保留、不得并入本轮导出。
    f.host.distributedQueueCache = { plans: [planEntry("b", "2026-10-01T00:00:00.000Z"), planEntry("c", "2026-10-05T00:00:00.000Z")] };
    vscodeStub.window.warnings = [];
    await f.click(command);
    const stale = f.host.statuses.at(-1);
    assert.equal(stale.status, "completed");
    assert.equal(stale.resultSync.outcome, "partial");
    assert.equal(stale.resultSync.included, 0);
    const staleReport = f.posted.at(-1).summary;
    assert.equal(staleReport.completed, 0);
    assert.match(staleReport.missing.join(" "), /不属于当前 job 的最新执行/);
    assert.equal(fs.readFileSync(f.finalCsv(), "utf8"), publishedCsv, "an outdated run must not rewrite the published table");
    const staleJobs = f.latest().jobs;
    assert.equal(staleJobs.filter(job => job.state === "complete").length, 0, "the current round honestly reports zero verified results");
    assert.ok(staleJobs.every(job => /不属于当前 job 的最新执行/.test(String(job.error || ""))));
    assert.equal(vscodeStub.window.warnings.length, 1);
  });
}

test("every result button drives exactly one shared collection round per click", async () => {
  const f = syncFixture();
  for (const command of ["rebuildProjectResultTables", "syncPendingPlanArtifacts", "syncAllResultArtifacts"]) {
    const before = f.calls.length;
    await f.click(command);
    assert.equal(f.host.statuses.at(-1).resultSync.outcome, "completed", command);
    const rounds = f.tasks(before);
    assert.equal(rounds.filter(row => row[2] === "observe").length, f.workers.length, command + ": one observation fan-out per click");
    assert.equal(rounds.filter(row => String(row[2]).startsWith("discover:")).length, f.specs.length, command + ": one declaration attempt per PLAN");
    assert.equal(f.downloadCalls(before).length, 1, command + ": memory reads coalesce per answering source");
    assert.equal(f.latest().jobs.length, 4, command + ": each click republishes this round only, never an accumulated merge");
  }
});

test("the same worker across plans is one mapped download and a fallback replica is another", async () => {
  const f = syncFixture();
  await f.update();
  const downloads = f.downloadCalls();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0][1], "w1");
  assert.equal(downloads[0][2].length, 8, "both plans' jobs ride a single batched memory read for the answering source");
  assert.ok(downloads[0][2].some(file => file.includes("a-")) && downloads[0][2].some(file => file.includes("b-")));
  for (const spec of f.specs) for (const job of spec.jobs) f.state.dropResults.add(`w1:${spec.planFile}:${job.index}`);
  await f.update();
  const second = f.downloadCalls().slice(downloads.length);
  assert.equal(second.length, 1);
  assert.equal(second[0][1], "w2");
  assert.equal(second[0][2].length, 8, "the silent replica is skipped; the answering replica serves every plan in one batch");
});

test("all result buttons share one fresh memory collection without prerequisite remote rebuild, mirroring or ledgers", () => {
  assert.match(panelSource, /data-command="syncPendingPlanArtifacts"/);
  assert.match(panelSource, /更新结果汇总/);
  assert.match(panelSource, /尚无总表。点击“更新结果汇总”/);
  assert.doesNotMatch(panelSource, /同步服务器结果并更新总表|下载指标并重新汇总|刷新所有结果|合并最新结果并拉取指标/);
  assert.doesNotMatch(panelSource, /同步待处理产物 \(|待处理产物计数属于自动的权重和日志同步/);
  assert.match(extensionSource, /case "syncPendingPlanArtifacts":\s*return this\.withManualResultSync\(\(\) => this\.syncPendingResultMetricsFromUi\(\)\)/);
  assert.match(extensionSource, /case "rebuildProjectResultTables":\s*return this\.withManualResultSync\(\(\) => this\.rebuildProjectResultTablesFromUi\(\)\)/);
  assert.match(extensionSource, /case "syncAllResultArtifacts":\s*return this\.withManualResultSync\(\(\) => this\.syncAllResultArtifactsFromUi\(message\)\)/);
  // 三个入口都只路由到同一个主动查询门面；远端重建、跨 Worker 合并镜像和账本登记都不在链路上。
  const manual = sliceBetween(extensionSource, "async syncPendingResultMetricsFromUi(", "async summaryForMetricDownload(");
  assert.match(manual, /options\.background \? resultCollectionHost\(this\)\.update\(\) : this\.rebuildProjectResultTablesFromUi\(options\)/);
  const bulk = sliceBetween(extensionSource, "async syncAllResultArtifactsFromUi(message)", "async syncPendingResultMetricsFromUi");
  assert.match(bulk, /rebuildProjectResultTablesFromUi\(\{ planFiles: \[planFile\]/);
  const rebuild = sliceBetween(extensionSource, "async rebuildProjectResultTablesFromUi(", "async openLocalResultTableFromUi");
  assert.match(rebuild, /title: "更新结果汇总"/);
  assert.match(rebuild, /resultCollectionHost\(this\)\.update\(abort\.signal\)/);
  assert.match(rebuild, /notificationShown = true/);
  assert.doesNotMatch(manual + bulk + rebuild, /postprocessDistributedResultsForManual|rebuildDistributedResults|mergeLatestWorkerVersions|loadProjectTableRegistry|loadPlanSyncLedger|getResultsSummary/);
  assert.doesNotMatch(manual + bulk + rebuild, /selectLatestCompletePlanRun|acceptedCompletedRevision|memoryMetricFiles/);
  // 结果汇总动作被显式列入宿主副作用租约免名单：内存链路没有本机原始副本发布。
  assert.match(extensionSource, /\["rebuildProjectResultTables", "syncAllResultArtifacts", "syncPendingPlanArtifacts"/);
  const background = sliceBetween(extensionSource, "async syncPendingPlanArtifacts(onlyKey = \"\", knownSummary?)", "async reconcileProjectFilesAcrossWorkers");
  assert.doesNotMatch(background, /mergeLatestWorkerVersions\(/);
  const auto = extensionSource.slice(extensionSource.indexOf("async refreshResultsSummary"), extensionSource.indexOf("scheduleResultsSummaryRefreshFromRealtime"));
  assert.match(auto, /resultCollectionHost\(this\)\.update\(\)/);
  assert.doesNotMatch(auto, /syncPendingPlanArtifacts\(pending|syncPendingResultMetricsFromUi|mergeLatestWorkerVersions/);
});

test("bulk plan sync keeps the previous candidate policy and metric mode stays optional", () => {
  const download = sliceBetween(extensionSource, "collectMappedResultDownloadBatches(", "async loadProjectTableRegistry");
  assert.match(download, /options\.metricsOnly === true/);
  assert.match(download, /metricsOnly && !isResultMetricFile\(remotePath\)/);
  assert.match(download, /【批量同步结果确认】/);
  assert.match(download, /"覆盖已有文件并同步", "只同步缺失文件"/);
  assert.match(download, /批量同步已取消/);
  assert.match(extensionSource, /syncDistributedJobArtifacts\(root, await this\.loadDistributedQueue\(root\), "bulk"/);
  assert.match(download, /sync\.downloadMappedPaths/);
  assert.doesNotMatch(download, /client\.downloadWorkerFile\(/);
});

test("metric button actions bypass host operation leases and never publish raw metric copies", async () => {
  const f = syncFixture();
  await f.click("rebuildProjectResultTables");
  assert.equal(f.calls.some(call => call[0] === "lease"), false, "memory-only result actions take no host side-effect lease");
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item =>
    item.isDirectory() ? walk(path.join(dir, item.name)) : [path.relative(f.workspace, path.join(dir, item.name)).split(path.sep).join("/")]);
  const files = walk(f.workspace);
  assert.equal(files.some(file => path.posix.basename(file).startsWith(".simple-mapped-")), false);
  assert.equal(files.some(file => file.includes("mapped_stage")), false);
  assert.equal(files.some(file => file.startsWith("simple_cluster/")), false);
  assert.equal(files.some(file => /\/raw\/|_unassigned/.test(file)), false, "raw metric copies are never written locally");
  assert.ok(files.includes("experiments/results/set/final/final.csv"));
  assert.ok(fs.existsSync(path.join(f.workspace, "experiments/results/set/final/final.md")));
  assert.equal(f.calls.some(call => call[0] === "dl"), true);
});

function publicationFixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-pending-publish-"));
  const source = "simple_cluster/downloads/stage/source.csv";
  const destination = "experiments/results/set/plans/a/raw/final.csv";
  fs.mkdirSync(path.join(workspace, path.dirname(source)), { recursive: true });
  fs.mkdirSync(path.join(workspace, path.dirname(destination)), { recursive: true });
  fs.writeFileSync(path.join(workspace, source), "new metrics", "utf8");
  fs.writeFileSync(path.join(workspace, destination), "previous metrics", "utf8");
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), {
    client: {}, projectContextIsCurrent: () => true,
  });
  const context = { root: workspace };
  const entries = [{ remotePath: "metrics.csv", localRelative: destination }];
  const transfers = [{ remotePath: "metrics.csv", localRelativePath: source }];
  return { workspace, host, context, entries, transfers, source, destination,
    publish: (token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }) =>
      host.publishMappedResultDownloads(context, host.client, entries, transfers, true, token, "发布指标测试") };
}

test("mapped publication refuses host side effects outside the Windows extension host and commits nothing", async () => {
  // 租约获取、锁内等待与暂存复用的真实执行只在 Windows UI Extension Host 上发生；
  // Mac 侧必须在写入前显式拒绝，且不得留下覆盖或临时文件。Windows 覆盖见配套 Windows 仓库门禁。
  const f = publicationFixture();
  await assert.rejects(f.publish(), /宿主副作用必须由受支持的本地 UI Extension Host 执行/);
  assert.equal(fs.readFileSync(path.join(f.workspace, f.destination), "utf8"), "previous metrics");
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item =>
    item.isDirectory() ? walk(path.join(dir, item.name)) : [path.basename(path.join(dir, item.name))]);
  assert.equal(walk(f.workspace).some(name => name.startsWith(".simple-mapped-")), false);
});

test("a cancelled publication token never overwrites and releases its listener", async () => {
  const f = publicationFixture();
  let disposed = 0;
  const token = { isCancellationRequested: true, onCancellationRequested() { return { dispose() { disposed++; } }; } };
  await assert.rejects(f.publish(token), /指标分发已取消/);
  assert.equal(disposed, 1);
  assert.equal(fs.readFileSync(path.join(f.workspace, f.destination), "utf8"), "previous metrics");
});

test("a workspace change during a publication wait cannot commit downloaded data", async () => {
  const f = publicationFixture();
  f.host.projectContextIsCurrent = () => false;
  await assert.rejects(f.publish(), /工作区已切换，未发布后续指标文件/);
  assert.equal(fs.readFileSync(path.join(f.workspace, f.destination), "utf8"), "previous metrics");
});

function listTemps(workspace) {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item =>
    item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]);
  return walk(workspace).filter(file => path.basename(file).startsWith(".simple-mapped-"));
}

test("distribution stages a verified copy, consumes the temp by atomic replacement, and keeps residues on interrupted writes", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-pending-distribute-"));
  const { __distributeMappedDownloadsForTest } = require("../../src/extension/legacy.ts");
  const stageRel = "simple_cluster/downloads/mapped_stage/source.csv";
  const destRel = "experiments/results/a/raw/a_seed.csv";
  fs.mkdirSync(path.join(workspace, path.dirname(stageRel)), { recursive: true });
  fs.mkdirSync(path.join(workspace, path.dirname(destRel)), { recursive: true });
  fs.writeFileSync(path.join(workspace, stageRel), "staged bytes", "utf8");
  fs.writeFileSync(path.join(workspace, destRel), "original", "utf8");
  const entry = { remotePath: "simple_cluster/results/w1/raw.csv", localRelative: destRel };
  const transfer = { remotePath: "simple_cluster/results/w1/raw.csv", localRelativePath: stageRel };
  const delivered = await __distributeMappedDownloadsForTest(workspace, [entry], [transfer], true);
  assert.equal(delivered, 1);
  assert.equal(fs.readFileSync(path.join(workspace, destRel), "utf8"), "staged bytes");
  assert.equal(listTemps(workspace).length, 0, "the reusable temp is consumed by the rename");

  // 写入被中断：目标保留原字节，暂存作为证据保留而不是被静默清理。
  fs.writeFileSync(path.join(workspace, destRel), "original", "utf8");
  const originalOpen = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith("source.csv")) handle.read = async () => { throw new Error("copy interrupted"); };
    return handle;
  };
  try {
    await assert.rejects(() => __distributeMappedDownloadsForTest(workspace, [entry], [transfer], true), /本机分发写入失败|暂存保留/);
  } finally {
    fs.promises.open = originalOpen;
  }
  assert.equal(fs.readFileSync(path.join(workspace, destRel), "utf8"), "original");
  assert.equal(listTemps(workspace).length, 1, "an interrupted publication keeps the residue for diagnosis");
});

test("distribution rejects symlink destinations and post-write parent swaps without escaping the workspace", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-pending-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "simple-pending-outside-"));
  const { __distributeMappedDownloadsForTest } = require("../../src/extension/legacy.ts");
  const stageRel = "simple_cluster/downloads/mapped_stage/source.csv";
  const destRel = "experiments/results/a/raw/a_seed.csv";
  fs.mkdirSync(path.join(workspace, path.dirname(stageRel)), { recursive: true });
  fs.mkdirSync(path.join(workspace, path.dirname(destRel)), { recursive: true });
  fs.writeFileSync(path.join(workspace, stageRel), "new");
  fs.writeFileSync(path.join(workspace, destRel), "original");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  let linked = false;
  try { fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, destRel + ".link")); linked = true; }
  catch { linked = false; }
  if (linked) {
    await assert.rejects(() => __distributeMappedDownloadsForTest(workspace, [{
      remotePath: "simple_cluster/results/w1/raw.csv", localRelative: destRel + ".link",
    }], [{ remotePath: "simple_cluster/results/w1/raw.csv" }], true), /符号链接/);
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
  }
  const originalRealpath = fs.promises.realpath;
  const swappedRealpath = async (targetPath, ...args) => {
    const resolved = await originalRealpath(targetPath, ...args);
    if (String(targetPath).endsWith(`${path.sep}raw`)) return path.join(outside, "secret-dir");
    return resolved;
  };
  try {
    await assert.rejects(() => __distributeMappedDownloadsForTest(workspace, [{
      remotePath: "simple_cluster/results/w1/raw.csv", localRelative: destRel,
    }], [{ remotePath: "simple_cluster/results/w1/raw.csv", localRelativePath: stageRel }], true, {
      beforeRename() { fs.promises.realpath = swappedRealpath; },
    }), /父目录在写入后发生变化|超出项目根目录|符号链接/);
  } finally {
    fs.promises.realpath = originalRealpath;
  }
  assert.equal(fs.readFileSync(path.join(workspace, destRel), "utf8"), "original");
  assert.equal(fs.existsSync(path.join(outside, "a_seed.csv")), false);
});

test("downloaded train_rate 0.5 becomes 50 in the project table while rate_percent stays 50", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "low", seed: 1 }, { case: "high", seed: 1 }] }] });
  f.state.csvText["experiments/plans/a.yaml:0"] = "case,seed,method,dataset,train_rate,rate_percent,eval_protocol,AUC\nlow,1,m,set,0.5,,holdout,0.7\n";
  f.state.csvText["experiments/plans/a.yaml:1"] = "case,seed,method,dataset,train_rate,rate_percent,eval_protocol,AUC\nhigh,1,m,set,,50,holdout,0.8\n";
  await f.click("rebuildProjectResultTables");
  const table = f.readTable();
  const rates = table.rows.map(row => row[table.header.indexOf("rate_percent")]).sort();
  assert.deepEqual(rates, ["50", "50"], "fraction train_rate and percent rate_percent land in the same column");
});

test("quoted adapter-mapped columns refresh the visible table through the memory pipeline", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha,set", seed: 1 }] }],
    adapterRules: { case: "specimen", seed: "rng", rate_percent: "rate", eval_protocol: "protocol" } });
  f.state.csvText["experiments/plans/a.yaml:0"] = 'specimen,rng,method,dataset,rate,protocol,AUC\n"alpha,set",1,m,set,10,holdout,0.77\n';
  await f.click("rebuildProjectResultTables");
  const row = f.posted.at(-1).summary.results[0];
  assert.equal(row.dimensions.case, "alpha,set");
  assert.equal(row.dimensions.rate_percent, "10");
  assert.equal(row.dimensions.eval_protocol, "holdout");
  assert.equal(row.metrics.AUC, 0.77);
  const table = f.readTable();
  assert.ok(table.header.includes("rate_percent") && table.header.includes("eval_protocol"));
  assert.equal(table.rows[0][table.header.indexOf("eval_protocol")], "holdout");
  assert.match(fs.readFileSync(f.finalCsv(), "utf8"), /0\.77/);
});

test("no server declaration means no reads and no fallback to on-disk registry, raw copies or a stale export", async () => {
  const f = syncFixture();
  const staleTable = "result_family,dataset,rate_percent,eval_protocol,jobs,AUC_mean,AUC_sd\r\nold,set,, ,1,0.1000,\r\n";
  fs.mkdirSync(path.dirname(f.finalCsv()), { recursive: true });
  fs.writeFileSync(f.finalCsv(), staleTable, "utf8");
  const decoyRaw = path.join(f.workspace, "experiments/results/set/plans/a/raw/raw.csv");
  const decoyRegistry = path.join(f.workspace, "simple_cluster/results/project_table_registry.json");
  fs.mkdirSync(path.dirname(decoyRaw), { recursive: true });
  fs.writeFileSync(decoyRaw, "case,seed,metric,value\nold,1,AUC,0.99\n", "utf8");
  fs.mkdirSync(path.dirname(decoyRegistry), { recursive: true });
  fs.writeFileSync(decoyRegistry, JSON.stringify({ schemaVersion: 1, plans: { "experiments/plans/a.yaml": { revision: "old", records: [] } } }), "utf8");
  for (const spec of f.specs) f.state.empty.add(spec.planFile);
  vscodeStub.window.warnings = [];
  const report = await __syncPendingResultMetricsForTest(f.host);
  assert.equal(report.current, false, "an unverifiable round is never presented as a result");
  assert.equal(report.downloaded, false);
  assert.equal(f.calls.some(call => call[0] === "dl"), false, "nothing is read when no PLAN declaration was accepted");
  assert.equal(fs.readFileSync(f.finalCsv(), "utf8"), staleTable, "the previous export stays byte-identical");
  assert.equal(fs.existsSync(path.join(f.workspace, "experiments/results/latest-results.json")), false);
  assert.equal(fs.readFileSync(decoyRaw, "utf8"), "case,seed,metric,value\nold,1,AUC,0.99\n", "local raw files are never a metric source");
  assert.match(fs.readFileSync(decoyRegistry, "utf8"), /"revision":"old"/, "a registry-era file is never consulted or rewritten");
  assert.equal(vscodeStub.window.warnings.length, 1);
});
