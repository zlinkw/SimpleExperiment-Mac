const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
require("../_helpers/registerTsRequire");

const extensionRoot = path.join(__dirname, "..", "..");
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
const { __handleResultUiCommandForTest, __syncPendingResultMetricsForTest, RealtimeTunnelPanelProvider } = require("../../src/extension/legacy.ts");
Module._load = originalLoad;
if (originalTsLoader) Module._extensions[".ts"] = originalTsLoader;
else delete Module._extensions[".ts"];
const { ResultCollectionHost, resultCollectionHost } = require("../../src/extension/ResultCollectionHost.ts");
const { resultDigest } = require("../../src/results/FreshResults.ts");

function target(id) {
  return { id, host: id + ".example", user: "exp", port: 22, remotePath: "/projects/" + id };
}
const sha = (text) => resultDigest(text);

/** Workers share the project filesystem: every enabled worker reports every declared
 * job, and this round's export is rebuilt only from bytes verified in this round. */
function syncFixture(options = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-fresh-sync-"));
  const specs = options.specs || [
    { planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }, { case: "alpha", seed: 2 }, { case: "alpha", seed: 3 }] },
    { planFile: "experiments/plans/b.yaml", jobs: [{ case: "beta", seed: 1 }] },
    { planFile: "experiments/plans/c.yaml", jobs: [{ case: "gamma", seed: 1 }, { case: "gamma", seed: 2 }] },
  ];
  const state = { offline: new Set(), rpcFail: new Set(), readFail: new Set(), quarantine: new Set(),
    empty: new Set(), runOverrides: {}, manifestRunOverrides: {}, corruptManifest: new Set(), emptyCsv: new Set(), nanCsv: new Set(),
    dropResults: new Set() };
  const workers = (options.workers || ["w1", "w2"]);
  const calls = [];
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
  const manifestText = (spec, job) => {
    if (state.corruptManifest.has(`${spec.planFile}:${job.index}`)) return "{not-json";
    const runId = state.manifestRunOverrides[`${spec.planFile}:${job.index}`] || state.runOverrides[`${spec.planFile}:${job.index}`] || job.runId;
    return JSON.stringify({ simpleExperiment: { runId, status: "completed", mode: "test",
      job: { index: job.index, case: job.case, seed: job.seed }, outputDir: job.outputDir, resultCsv: job.resultCsv, weights: [] } });
  };
  const csvText = (spec, job) => {
    if (state.emptyCsv.has(`${spec.planFile}:${job.index}`)) return "case,seed,method,dataset,metric,value\n";
    if (state.nanCsv.has(`${spec.planFile}:${job.index}`))
      return `case,seed,method,dataset,metric,value\n${job.case},${job.seed},m-${spec.planKey},set,BROKEN,not-a-number\n${job.case},${job.seed},m-${spec.planKey},set,AUC,0.55\n`;
    return `case,seed,method,dataset,metric,value\n${job.case},${job.seed},m-${spec.planKey},set,AUC,${(0.5 + job.seed / 100).toFixed(2)}\n`;
  };
  const jobRaw = (spec, job) => ({ [`${job.outputDir}/artifact_manifest.json`]: manifestText(spec, job), [job.resultCsv]: csvText(spec, job) });
  const allRaw = () => Object.assign({}, ...specs.flatMap(spec => spec.jobs.map(job => jobRaw(spec, job))));
  const host = {
    calls, workspace, state, specs, panelDisposed: false, resultCsvDirectory: "experiments/results",
    captureProjectContext: () => ({ root: workspace, generation: 1 }), projectContextIsCurrent: () => true,
    workerCodeSyncTargets: () => workers.map(target),
    currentResultPlanInputs: async () => specs.map(spec => ({ planFile: spec.planFile, revision: spec.revision, mode: "test",
      seeds: spec.jobs.map(job => job.seed), jobCount: spec.jobs.length })),
    resultAdapterRules: () => ({}),
    parseFreshResultMetric: RealtimeTunnelPanelProvider.prototype.parseFreshResultMetric,
    client: {
      getWorkerTasks: async (workerId, request) => {
        calls.push(["tasks", workerId, request.discovery ? "discover:" + request.discovery.planFile : "observe"]);
        if (state.rpcFail.has(workerId)) throw new Error(workerId + " rpc closed");
        if (state.offline.has(workerId)) throw new TypeError("fetch failed");
        if (request.discovery) {
          const spec = specs.find(row => row.planFile === request.discovery.planFile);
          if (!spec || state.empty.has(spec.planFile) || state.quarantine.has(spec.planFile))
            return { queryComplete: true, capabilities: { resultCollection: 1 }, declaredJobs: [] };
          return { queryComplete: true, capabilities: { resultCollection: 1 }, declaredJobs: spec.jobs.map(job => ({
            index: job.index, case: job.case, seed: job.seed, output_dir: job.outputDir, result_csv: job.resultCsv,
            planHash: state.quarantine.has(spec.planFile) ? "stale" : spec.revision })) };
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
    },
    simpleSftpCapability: async () => ({ methodOptions: { "sync.downloadMappedPaths": { memoryOnly: true, memoryWrapperResults: true } } }),
    sftpServerOptions: (row) => row,
    simpleSftpApiCall: async (method, params) => {
      calls.push([method, params.server.id, params.entries.map(entry => entry.remotePath)]);
      assert.equal(method, "sync.downloadMappedPaths");
      assert.equal(params.memoryOnly, true);
      assert.equal(params.metricsOnly, true);
      if (state.readFail.has(params.server.id)) throw new Error(params.server.id + " ssh closed");
      const raw = allRaw();
      return { ok: true, memoryOnly: true, entries: params.entries.map(entry => {
        const text = raw[entry.remotePath];
        if (typeof text !== "string") throw new Error("unrequested remote path " + entry.remotePath);
        return { remotePath: entry.remotePath, bytes: entry.bytes, sha256: entry.sha256, dataBase64: Buffer.from(text).toString("base64") };
      }) };
    },
    refreshLocalResultCatalogForProject: async () => {},
    postState() { calls.push(["postState"]); this.postedReport = this.resultSyncReport; this.postedSummary = this.resultsSummary; },
    recordActionError(entry) { calls.push(["recordActionError", entry.command, entry.message]); },
    distributedQueueCache: options.queue || { plans: [] },
    loadDistributedQueue: async () => { throw new Error("queue must not supply results"); },
    loadPlanSyncLedger: async () => { throw new Error("ledger must not supply results"); },
    loadProjectTableRegistry: async () => { throw new Error("registry must not supply results"); },
  };
  const ui = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), host, {
    context: { globalStorageUri: { fsPath: workspace } },
    manualResultSyncCounts: new Map(),
    runningBuildIdentity: require("../../dist/features/PanelBuildIdentity").readPanelBuildIdentity(extensionRoot, undefined, require("../../package.json").version),
    panelHostEventLoopSamples: [], panelLayoutEvents: [], panelIncidentEvents: [], panelIncidentSlots: { previous: null }, panelLifecycleDiagnostics: [],
    planFileInput: "", selectedPlanId: "", statuses: [],
    postUiCommandStatus: function (id, status, name, message, extra) { (this.statuses ||= []).push({ id, status, name, message, ...extra }); },
    finishPlanSubmissionProgress: () => {},
    beginSimpleSftpCapabilityLaunch: () => {},
  });
  const service = new ResultCollectionHost(ui);
  const update = (signal) => service.update(signal);
  const finalCsv = () => path.join(workspace, "experiments", "results", "set", "final", "final.csv");
  const readTable = () => tablesModule.exports.readCsv(fs.readFileSync(finalCsv(), "utf8"));
  return { workspace, host: ui, specs, state, workers, calls, update, finalCsv, readTable,
    latest: () => JSON.parse(fs.readFileSync(path.join(workspace, "experiments/results/latest-results.json"), "utf8")) };
}

test("sync includes every completed plan and every worker replica before the verified memory read", async () => {
  const f = syncFixture();
  f.specs.push({ planFile: "experiments/plans/empty.yaml", jobs: [{ case: "none", seed: 1 }] });
  const spec = f.specs.at(-1);
  spec.planKey = "empty"; spec.text = "suite: empty\nseeds: [1]\n"; spec.revision = sha(spec.text);
  fs.mkdirSync(path.join(f.workspace, "experiments/plans"), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, spec.planFile), spec.text, "utf8");
  spec.jobs[0].index = 0; spec.jobs[0].outputDir = "work_dirs/empty-0"; spec.jobs[0].resultCsv = "work_dirs/empty-0/metrics.csv"; spec.jobs[0].runId = "cmd-empty-0";
  f.state.empty.add(spec.planFile);
  // 第一副本读取失败：每个 job 必须落到另一已核实副本，而不是从磁盘旧数据补齐。
  f.state.readFail.add("w1");
  const report = await f.update();
  assert.equal(report.current, true, JSON.stringify(report.skipped));
  assert.equal(report.discovered, 4);
  assert.deepEqual(report.included.sort(), ["experiments/plans/a.yaml", "experiments/plans/b.yaml", "experiments/plans/c.yaml"]);
  assert.equal(report.completed, 6);
  for (const planFile of ["experiments/plans/a.yaml", "experiments/plans/b.yaml", "experiments/plans/c.yaml", "experiments/plans/empty.yaml"])
    assert.ok(f.calls.some(call => call[0] === "tasks" && call[2] === "discover:" + planFile),
      "every PLAN declaration is attempted before any bytes are trusted");
  for (const worker of ["w1", "w2"])
    assert.ok(f.calls.some(call => call[0] === "tasks" && call[1] === worker && call[2] === "observe"),
      "every enabled worker must report the same declared outputs");
  const downloads = f.calls.filter(call => call[0] === "sync.downloadMappedPaths");
  assert.deepEqual([...new Set(downloads.map(call => call[1]))].sort(), ["w1", "w2"],
    "the failed replica attempt is visible and every job then reads from the surviving verified replica");
  assert.ok(report.results.every(row => row.workerId === "w2"), "published bytes come from a replica that actually answered");
  assert.ok(downloads.every(call => call[2].every(remote => /artifact_manifest\.json$|metrics\.csv$/.test(remote))),
    "only the declared manifest and result CSV are read");
  assert.match(report.skipped.join("\n"), /empty\.yaml/);
  const latest = f.latest();
  assert.deepEqual([...new Set(latest.jobs.map(job => job.planFile))].sort(),
    ["experiments/plans/a.yaml", "experiments/plans/b.yaml", "experiments/plans/c.yaml", "experiments/plans/empty.yaml"]);
  assert.equal(fs.existsSync(path.join(f.workspace, "simple_cluster/results/project_table_registry.json")), false);
});

for (const command of ["syncPendingPlanArtifacts", "rebuildProjectResultTables"]) {
  test(`${command} publishes valid local tables and releases its button with one partial warning`, async () => {
    const f = syncFixture();
    f.specs.push({ planFile: "experiments/plans/empty.yaml", jobs: [] });
    const spec = f.specs.at(-1);
    spec.planKey = "empty"; spec.text = "suite: empty\nseeds: []\n"; spec.revision = sha(spec.text);
    fs.writeFileSync(path.join(f.workspace, spec.planFile), spec.text, "utf8");
    f.state.empty.add(spec.planFile);
    vscodeStub.window.warnings = []; vscodeStub.window.errors = []; vscodeStub.window.messages = [];
    f.host.recordActionError = (entry) => { throw new Error("partial publication must not record a global failure: " + entry.message); };
    const invoke = () => f.host.withUiCommandStatus("result-button", command, {}, () => f.host.handleMessageCore({ command }, command));
    await invoke();
    const terminal = f.host.statuses.at(-1);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.resultSync.outcome, "partial");
    assert.equal(terminal.resultSync.included, 3);
    assert.ok(terminal.resultSync.skipped >= 1);
    assert.match(f.host.postedSummary.skipped.join(" "), /empty\.yaml/, "the warning stays traceable to the excluded Plan in the report");
    assert.equal(vscodeStub.window.warnings.length, 1);
    assert.equal(vscodeStub.window.errors.length, 0);
    assert.ok(fs.existsSync(path.join(f.workspace, "experiments/results/set/final/final.md")));
    await invoke();
    assert.equal(f.host.statuses.at(-1).resultSync.outcome, "partial");
    assert.equal(vscodeStub.window.warnings.length, 2, "one warning per click, including a repeated click");
    assert.equal(f.host.statuses.at(-1).resultSync.included, 3, "a repeated click still reports the actual published Plans");
    assert.equal(vscodeStub.window.errors.length, 0);
  });
}

test("rebuild downloads metrics through verified replicas and never merges result directories", async () => {
  const f = syncFixture();
  await __handleResultUiCommandForTest(f.host, { command: "rebuildProjectResultTables" });
  assert.equal(f.calls.some(call => call[0] === "merge"), false, "no server-side or local merge may contribute rows");
  const downloads = f.calls.filter(call => call[0] === "sync.downloadMappedPaths");
  assert.equal(downloads.length >= 1, true);
  const remote = downloads.flatMap(call => call[2]);
  assert.deepEqual([...new Set(remote)].sort(), f.specs.flatMap(spec => spec.jobs.flatMap(job => [`${job.outputDir}/artifact_manifest.json`, job.resultCsv])).sort());
  const latest = f.latest();
  assert.equal(latest.jobs.filter(job => job.state === "complete").length, 6);
});

test("a failed plan keeps the other completed plans and does not claim full success", async () => {
  const f = syncFixture();
  f.state.quarantine.add("experiments/plans/b.yaml");
  const report = await f.update();
  assert.equal(report.current, true);
  assert.deepEqual(report.included.sort(), ["experiments/plans/a.yaml", "experiments/plans/c.yaml"]);
  assert.match(report.skipped.join("\n"), /b\.yaml/);
  assert.match(report.missing.join("\n"), /b\.yaml/);
  assert.equal(report.completed, 5, "a quarantined Plan never claims its jobs");
  assert.ok(report.expected > report.completed, "the quarantined Plan stays visible in coverage instead of silently disappearing");
  assert.equal(report.results.every(row => row.planFile !== "experiments/plans/b.yaml"), true);
});

test("published rows come only from in-memory server CSV bytes, never from any summary", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }, { case: "alpha", seed: 2 }, { case: "alpha", seed: 3 }] }] });
  const report = await f.update();
  assert.equal(report.current, true);
  assert.deepEqual(report.results.map(row => row.dimensions.seed).sort(), ["1", "2", "3"]);
  assert.deepEqual(report.results.map(row => row.metrics.AUC).sort((a, b) => a - b), [0.51, 0.52, 0.53]);
  assert.equal(f.calls.some(call => call[0] === "summary"), false);
  const table = f.readTable();
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0][table.header.indexOf("roc_auc_mean")], "0.52", "three verified seeds aggregate into one alias-normalized row");
});

test("same-revision rerun publishes only the latest binding run and never borrows the old attempt", async () => {
  const planFile = "experiments/plans/comparison/ebmc.yaml";
  const spec = { planFile, jobs: [{ case: "bus_p100", seed: 42 }, { case: "bus_p100", seed: 43 }] };
  const f = syncFixture({ specs: [spec] });
  const planEntry = (suffix, enqueuedAt) => ({ id: "plan-ebmc", projectId: f.workspace, planFile,
    revision: spec.revision, codeFingerprint: "fp-a", enqueuedAt, jobs: spec.jobs.map(job => ({
      index: job.index, case: job.case, seed: job.seed, status: "completed", workerId: "w1",
      commandId: `run-${suffix}-${job.index}`, outputDir: job.outputDir, collectionResultCsv: job.resultCsv })) });
  // 队列同时保留两次运行的回执，owner 绑定取 enqueuedAt 最新的一条；旧 attempt 与旧共享 CSV 都不是来源。
  f.host.distributedQueueCache = { plans: [planEntry("a", "2026-09-01T00:00:00.000Z"), planEntry("b", "2026-09-02T00:00:00.000Z")] };
  const oldShared = path.join(f.workspace, "experiments/results/formal/ebmc.csv");
  fs.mkdirSync(path.dirname(oldShared), { recursive: true });
  fs.writeFileSync(oldShared, "case,seed,method,dataset,metric,value\nbus_p100,42,ebmc,BUS,AUC,0.11\n", "utf8");
  f.state.runOverrides[`${planFile}:0`] = "run-a-0";
  f.state.runOverrides[`${planFile}:1`] = "run-a-1";
  const stale = await f.update();
  assert.equal(stale.completed, 0, "artifacts from an outdated run must not enter the export");
  assert.match(stale.missing.join(" "), /不属于当前 job 的最新执行/);
  assert.equal(stale.results.length, 0);
  f.state.runOverrides[`${planFile}:0`] = "run-b-0";
  f.state.runOverrides[`${planFile}:1`] = "run-b-1";
  const fresh = await f.update();
  assert.equal(fresh.completed, 2);
  assert.deepEqual([...new Set(fresh.results.map(row => row.runId))].sort(), ["run-b-0", "run-b-1"]);
  assert.equal(fresh.results.every(row => row.workflowId === "plan-ebmc"), true);
  assert.equal(JSON.stringify(fresh.results).includes("run-a"), false);
  assert.equal(JSON.stringify(fresh.results).includes("formal/ebmc.csv"), false, "an anonymous shared CSV is never a source");
});

test("yaml newer than the verified server revision publishes nothing stale", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }] }] });
  fs.writeFileSync(path.join(f.workspace, "experiments/plans/a.yaml"), "suite: a\nseeds: [1, 9]\n", "utf8");
  await assert.rejects(f.update(), /PLAN 已变化，未发布过期结果/);
  assert.equal(fs.existsSync(path.join(f.workspace, "experiments/results/latest-results.json")), false);
});

test("a plan known only from the local metadata is still discovered; the registry is never consulted", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/only-local.yaml", jobs: [{ case: "alpha", seed: 1 }] }] });
  fs.mkdirSync(path.join(f.workspace, "simple_cluster/results"), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, "simple_cluster/results", "project_table_registry.json"), JSON.stringify({ schemaVersion: 1, plans: {} }));
  const report = await f.update();
  assert.equal(report.discovered, 1);
  assert.deepEqual(report.plans, ["experiments/plans/only-local.yaml"]);
  assert.equal(report.completed, 1);
});

test("a silent replica is omitted, the answering replica publishes and the failure stays reported", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }] }] });
  f.state.rpcFail.add("w2");
  const report = await f.update();
  assert.equal(report.completed, 1, "one answering replica that matches its manifest is sufficient evidence");
  assert.equal(report.results[0].workerId, "w1");
  assert.equal(report.results[0].runId, "cmd-a-0", "the run identity comes from the verified artifact, not the silent replica");
  assert.match(report.skipped.join(" "), /w2.*rpc closed/, "the failing worker stays visible in this round's report");
  assert.ok(fs.existsSync(f.finalCsv()));
});

test("nested comparison plans are discovered and a conflicting declaration blocks only that plan", async () => {
  const f = syncFixture({ specs: ["experiments/plans/comparison/drf.yaml", "experiments/plans/comparison/dpl.yaml", "experiments/plans/comparison/nested/x.yaml"]
    .map(planFile => ({ planFile, jobs: [{ case: "alpha", seed: 1 }] })) });
  f.state.quarantine.add("experiments/plans/comparison/drf.yaml");
  const report = await f.update();
  assert.deepEqual(report.plans, ["experiments/plans/comparison/dpl.yaml", "experiments/plans/comparison/nested/x.yaml"]);
  assert.match(report.skipped.join("\n"), /drf\.yaml/);
  assert.equal(report.results.every(row => !row.planFile.includes("drf")), true);
  assert.equal(f.calls.filter(call => call[0] === "sync.downloadMappedPaths")
    .flatMap(call => call[2]).some(remote => remote.includes("work_dirs/drf-")), false,
  "a quarantined Plan contributes no downloads");
});

test("a later round that cannot re-verify a row rebuilds the export without it", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }, { case: "alpha", seed: 2 }] }] });
  await f.update();
  const before = fs.readFileSync(f.finalCsv(), "utf8");
  assert.equal(f.latest().jobs.filter(job => job.state === "complete").length, 2);
  // 没有任何副本再能核实 seed 2：本轮不得沿用上一轮的并集。
  f.state.dropResults.add("w1:experiments/plans/a.yaml:1");
  f.state.dropResults.add("w2:experiments/plans/a.yaml:1");
  const report = await f.update();
  assert.equal(report.completed, 1);
  assert.equal(f.latest().jobs.filter(job => job.state === "complete").length, 1);
  const table = f.readTable();
  assert.equal(table.rows[0][table.header.indexOf("roc_auc_mean")], "0.51", "the export is exactly this round's verified rows");
  assert.notEqual(fs.readFileSync(f.finalCsv(), "utf8"), before);
});

test("concurrent manual updates share one collection and cancellation publishes nothing", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }] }] });
  const [first, second] = await Promise.all([f.update(), f.update()]);
  assert.equal(first, second, "concurrent requests join the same in-flight collection");
  assert.equal(f.calls.filter(call => call[2] === "observe").length, f.workers.length,
    "two manual clicks trigger exactly one fresh collection");

  const g = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }] }] });
  const controller = new AbortController();
  const original = g.host.client.getWorkerTasks;
  let discoveries = 0;
  g.host.client.getWorkerTasks = async (...args) => {
    const value = await original(...args);
    if (String(args[1]?.discovery?.planFile || "").length) { discoveries += 1; controller.abort(); }
    return value;
  };
  await assert.rejects(g.update(controller.signal), /取消/);
  assert.ok(discoveries >= 1);
  assert.equal(g.calls.some(call => call[0] === "sync.downloadMappedPaths"), false);
  assert.equal(fs.existsSync(path.join(g.workspace, "experiments/results/latest-results.json")), false);
});

test("aborting a read keeps the captured transport fenced and starts no second-round write", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }] }] });
  const controller = new AbortController();
  const pristine = f.host.simpleSftpApiCall;
  f.host.simpleSftpApiCall = async (method, params) => {
    controller.abort();
    f.calls.push([method, params.server.id, params.entries.map(entry => entry.remotePath)]);
    assert.equal(params.signal.aborted, true, "the durable memory read carries the manual cancellation signal");
    throw params.signal.reason;
  };
  await assert.rejects(f.update(controller.signal), /取消|AbortError/);
  assert.equal(f.calls.filter(call => call[0] === "sync.downloadMappedPaths").length, 1,
    "the aborted read is fenced before any second attempt reaches the transport");
  assert.equal(fs.existsSync(path.join(f.workspace, "experiments/results/latest-results.json")), false);
  assert.equal(f.host.resultsSummary, undefined);
});

test("a contradictory manifest identity keeps the previous export and reports the job as unknown", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }] }] });
  await f.update();
  const before = { csv: fs.readFileSync(f.finalCsv(), "utf8"), md: fs.readFileSync(path.join(f.workspace, "experiments/results/set/final/final.md"), "utf8") };
  f.state.manifestRunOverrides["experiments/plans/a.yaml:0"] = "forged-run";
  const report = await f.update();
  assert.equal(report.completed, 0);
  assert.equal(report.jobs[0].state, "unknown");
  assert.equal(fs.readFileSync(f.finalCsv(), "utf8"), before.csv, "an unverifiable round rewrites nothing");
  assert.equal(fs.readFileSync(path.join(f.workspace, "experiments/results/set/final/final.md"), "utf8"), before.md);
});

test("an offline worker falls back for declarations, stays reported and recovers without sticky state", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }] }] });
  f.state.offline.add("w1");
  const down = await f.update();
  assert.ok(f.calls.some(call => call[1] === "w1" && String(call[2]).startsWith("discover:")), "the offline worker is still attempted first");
  assert.ok(f.calls.some(call => call[1] === "w2" && String(call[2]).startsWith("discover:")), "declarations fall back to the next worker");
  assert.match(down.skipped.join(" "), /w1/, "the offline worker stays reported in this round");
  assert.equal(down.completed, 1);
  assert.equal(down.results[0].workerId, "w2");
  f.state.offline.delete("w1");
  const up = await f.update();
  assert.equal(up.completed, 1, "the transient failure is not sticky: this round re-verifies everything");
  assert.deepEqual(up.results.map(row => row.dimensions.seed), ["1"]);
  // 两个在线副本报告不同的执行身份：冲突显式可见，绝不任选一份发布。
  const original = f.host.client.getWorkerTasks;
  f.host.client.getWorkerTasks = async (workerId, request) => {
    const value = await original(workerId, request);
    if (workerId === "w2" && value.declaredResults)
      value.declaredResults.forEach(row => { row.runId = "w2-only-run"; row.files = row.files.map(file => ({ ...file })); });
    return value;
  };
  const conflict = await f.update();
  assert.equal(conflict.completed, 0);
  assert.match(conflict.jobs.find(job => job.planFile === "experiments/plans/a.yaml").error, /服务器副本的执行身份或指标内容冲突/);
});

test("a plan with no parseable metrics blocks only itself and a malformed value drops only that metric", async () => {
  const f = syncFixture({ specs: [
    { planFile: "experiments/plans/broken.yaml", jobs: [{ case: "beta", seed: 1 }] },
    { planFile: "experiments/plans/good.yaml", jobs: [{ case: "gamma", seed: 2 }] },
  ] });
  f.state.emptyCsv.add("experiments/plans/broken.yaml:0");
  f.state.nanCsv.add("experiments/plans/good.yaml:0");
  const report = await f.update();
  assert.equal(report.completed, 1);
  assert.deepEqual(report.included, ["experiments/plans/good.yaml"]);
  assert.match(report.missing.join(" "), /broken\.yaml.*RESULT_METRICS_EMPTY/);
  const goodMetrics = report.results.filter(row => row.planFile === "experiments/plans/good.yaml")
    .flatMap(row => Object.entries(row.metrics).map(([name, value]) => [name, value]));
  assert.deepEqual(goodMetrics, [["AUC", 0.55]], "a non-finite value is dropped, not published as zero");
});

test("every download stays memory-only against the mapped Worker endpoint with the declared file set", async () => {
  const f = syncFixture({ specs: [{ planFile: "experiments/plans/a.yaml", jobs: [{ case: "alpha", seed: 1 }] }] });
  const seen = [];
  const pristine = f.host.simpleSftpApiCall;
  f.host.simpleSftpApiCall = async (method, params) => { seen.push(params); return pristine(method, params); };
  await f.update();
  assert.equal(seen.length >= 1, true);
  for (const params of seen) {
    assert.equal(params.memoryOnly, true);
    assert.equal(params.metricsOnly, true);
    assert.equal(params.confirm, true);
    assert.equal(params.pathConfirmed, true);
    assert.equal(params.server.host, "w1.example", "reads follow the configured Worker endpoint mapping");
    assert.equal(params.server.remotePath, "/projects/w1");
    assert.ok(params.entries.every(entry => !/weight|checkpoint|\.log$/i.test(entry.remotePath)));
  }
  const walked = [];
  const visit = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(full); else walked.push(full);
  } };
  visit(f.workspace);
  assert.ok(walked.every(file => !file.includes(path.join("_unassigned")) && !file.endsWith("metrics.csv")),
    "raw metric bytes never land in a local cache");
});
