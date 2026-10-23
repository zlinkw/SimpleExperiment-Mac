const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
require('../_helpers/registerTsRequire');
const {resultCollectionHost}=require('../../src/extension/ResultCollectionHost.ts');
const {fixture}=require('../_helpers/freshResultHost');

const root = path.resolve(__dirname, "../..");

function clock() {
  let now = 1_000_000, next = 0;
  const timers = new Map();
  return {
    timers,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, ms) { timers.set(++next, { callback, at: now + ms }); return next; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const entry = [...timers].filter(([, row]) => row.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at; timers.delete(entry[0]); entry[1].callback();
      }
      now = end;
    },
  };
}

function selectedMethods(names, globals = {}) {
  const source = fs.readFileSync(path.join(root, "src/extension/legacy.ts"), "utf8");
  const ast = ts.createSourceFile("provider.ts", source, ts.ScriptTarget.Latest, true);
  const provider = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === "RealtimeTunnelPanelProvider");
  const selected = new Set(names);
  const members = provider.members.filter((node) => node.name && selected.has(node.name.getText(ast)));
  const code = ts.transpileModule("class Subject {\n" + members.map((node) => node.getText(ast)).join("\n") + "\n}", {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sandbox = {
    AbortController,
    resultCollectionHost,
    workspaceRoot: () => "/project",
    errorMessage: (error) => String(error?.message || error),
    assertRetryRequestCurrent: () => undefined,
    retryRequestSignal: () => undefined,
    completedResultPlanFiles: async () => [],
    // 085 repair: the Mac default stub used to sit after the real resultCollectionHost binding
    // and shadowed it (duplicate key), so the .403 background route saw an empty report. The
    // real host is now the single default; every Mac test that wants a stub passes its own
    // resultCollectionHost override through globals, exactly as before.
    vscode: { ProgressLocation: { Notification: 1 }, window: {
      showInformationMessage: async () => {},
      showWarningMessage: async () => {},
      withProgress: async (_options, work) => work({ report() {} }, { isCancellationRequested: false }),
    } },
    ...globals,
  };
  vm.runInNewContext(code + "\nthis.Subject = Subject;", sandbox);
  return new sandbox.Subject();
}

function distributedHost(globals = {}) {
  const calls = [];
  const provider = selectedMethods(["scheduleDistributedPostprocess", "postprocessDistributedResultsForManual", "syncPendingResultMetricsFromUi"], globals);
  provider.calls = calls;
  provider.distributedPostprocessPromise = undefined;
  provider.loadDistributedQueue = async () => ({ plans: [{ planFile: "experiments/plans/a.yaml" }] });
  provider.syncDistributedJobArtifacts = async (_root, _queue, phase) => {
    calls.push(`artifacts:${phase}`);
    if (phase === "fragments") throw new Error("historical Plan has no fragment inventory");
  };
  provider.rebuildDistributedResults = async (_root, _queue, preview) => {
    calls.push(preview ? "rebuild:preview" : "rebuild:published");
    if (preview) throw new Error("optional preview unavailable");
  };
  provider.recordActionError = (entry) => calls.push(`warning:${entry.command}`);
  provider.postState = () => calls.push("state");
  provider.captureProjectContext = () => ({ root: "/project", generation: 1 });
  provider.projectContextIsCurrent = () => true;
  provider.client = {};
  provider.effectiveConnectionMode = () => "tunnel";
  provider.lastWorkerProbes = {};
  provider.workerCodeSyncTargets = () => [{ id: "worker-a" }];
  provider.refreshDistributedResultSyncProbes = async () => { provider.lastWorkerProbes = { "worker-a": { status: "ok" } }; };
  provider.refreshLocalPlanMetadataForAction = async () => {};
  provider.loadPlanSyncLedger = async () => ({ schemaVersion: 2, entries: {} });
  provider.queuePlanArtifactSyncStatusCheck = force => { assert.equal(force, true); calls.push("sync-check"); };
  provider.rebuildProjectResultTablesFromUi = async options => { calls.push("local-tables"); return options; };
  return provider;
}

test("background Worker mirroring keeps local result parsing and publication manual", async () => {
  const calls = [];
  const provider = selectedMethods(["scheduleDistributedPostprocess", "queuePlanScopedResultParse", "queueCompletedPlanArtifactSync"]);
  provider.distributedPostprocessPromise = undefined;
  provider.syncDistributedJobArtifacts = async () => calls.push("transfer");
  provider.rebuildDistributedResults = async () => calls.push("rebuild");
  provider.runActionCommand = async () => calls.push("parse");
  provider.isRealtimeMode = () => true;
  provider.projectTopologyAssessment = () => ({ mode: "worker_pool" });
  provider.captureProjectContext = () => ({ root: "/project" });
  provider.projectContextIsCurrent = () => true;
  provider.syncCompletedPlanArtifacts = async () => calls.push("worker-mirror");
  provider.queuePlanArtifactSyncStatusCheck = () => {};
  provider.postState = () => {};
  provider.scheduleDistributedPostprocess("/project", true);
  provider.queuePlanScopedResultParse("plan selected", "experiments/plans/a.yaml", "a");
  await provider.queueCompletedPlanArtifactSync({ status: "completed" });
  await provider.distributedPostprocessPromise;
  assert.ok(calls.every(call => call === "worker-mirror"));
});

test("manual result sync directly downloads metrics and publishes local tables without remote rebuild or full mirroring", async () => {
  // 门面只负责路由：人工请求必须把原始 planFiles 交给本机总表重建，绝不触发远端重建或整树镜像。
  const provider = distributedHost();
  const result = await provider.syncPendingResultMetricsFromUi({ planFiles: ["experiments/plans/a.yaml"] });
  assert.equal(result.title, undefined, "the current result entry forwards user options without injecting a retired workflow");
  assert.deepEqual(Array.from(result.planFiles), ["experiments/plans/a.yaml"]);
  assert.deepEqual(provider.calls, ["local-tables"]);
  // 本机重建的真实主体：一次带取消信号的采集更新 + 进度标题"更新结果汇总"。
  const signals = [];
  const titles = [];
  const real = selectedMethods(["rebuildProjectResultTablesFromUi"], {
    resultCollectionHost: () => ({ update: async signal => { signals.push(signal); return { current: true, completed: 2, expected: 2, missing: [], skipped: [] }; } }),
    vscode: { ProgressLocation: { Notification: 1 }, window: {
      showInformationMessage: async () => {},
      showWarningMessage: async () => { throw new Error("完整成功的同步不应弹警告"); },
      withProgress: async (options, work) => { titles.push(options.title); return work({ report() {} }, {}); },
    } },
  });
  const report = await real.rebuildProjectResultTablesFromUi({ planFiles: ["experiments/plans/a.yaml"] });
  assert.deepEqual(titles, ["更新结果汇总"]);
  assert.equal(signals.length, 1, "manual sync performs exactly one collection update");
  assert.ok(signals[0] instanceof AbortSignal, "the manual notification stays cancellable");
  assert.equal(report.current, true);
  assert.equal(report.notificationShown, true);
});

test("explicit full artifact sync mirrors fragments, checkpoints and logs without remotely rebuilding results", async () => {
  const provider = distributedHost();
  provider.syncDistributedJobArtifacts = async (_root, _queue, phase) => provider.calls.push(`artifacts:${phase}`);
  provider.rebuildDistributedResults = async (_root, _queue, preview) => provider.calls.push(preview ? "rebuild:preview" : "rebuild:published");
  await provider.postprocessDistributedResultsForManual("/project", "full");
  assert.deepEqual(provider.calls, [
    "artifacts:fragments", "artifacts:bulk", "state", "sync-check",
  ]);
});

test("background metrics requests cannot enter the manual result path", async () => {
  const updateArgs = [];
  const provider = distributedHost({
    resultCollectionHost: () => ({ update: async signal => { updateArgs.push(signal); return { current: true }; } }),
  });
  await provider.syncPendingResultMetricsFromUi({ background: true });
  assert.equal(updateArgs.length, 1, "background refresh goes straight to the shared collection host");
  assert.equal(updateArgs[0], undefined, "background updates carry no manual cancellation signal");
  assert.deepEqual(provider.calls, [], "the manual local-table path is never entered");
});

test("two concurrent manual summary requests share at most three direct manual retries", async () => {
  // 移植后契约：人工 dirtyKey 的直连重试只经预算退避入口排队，同一时刻至多一个定时器，
  // 在途期间反复重排且总重试次数封顶 3，期间绝不提前发起采集。
  const timer = clock();
  let fetches = 0;
  const warnings = [];
  const provider = selectedMethods(["refreshResultsSummary", "scheduleResultsSummaryTimer", "scheduleResultsSummaryBudgetRetryFromRealtime"], {
    ...timer,
    usableSelectionKey: (value) => String(value || ""),
    resultCollectionHost: () => ({ update: async () => { fetches += 1; return {}; } }),
  });
  Object.assign(provider, {
    resultsSummaryRefreshInFlight: true,
    resultsSummaryRefreshRetryCount: 0,
    resultsSummaryRefreshTimerGeneration: 0,
    projectContextGeneration: 1,
    client: {},
    selectedPlanId: "experiments/plans/a.yaml",
    planFileInput: "experiments/plans/a.yaml",
    lastResultsSummaryRefreshedDirtyKey: "",
    pendingResultsSummaryDirtyKey: "d1",
    pendingResultsSummaryDirtyPlanFile: "experiments/plans/a.yaml",
    effectiveConnectionMode: () => "tunnel",
    recordActionError: entry => warnings.push(entry.command),
    postState() {},
  });
  const cooldown = { decision: { reason: "cooldown" } };
  await provider.scheduleResultsSummaryBudgetRetryFromRealtime(cooldown, "manual_refresh", "d1");
  await provider.scheduleResultsSummaryBudgetRetryFromRealtime(cooldown, "manual_refresh", "d1");
  assert.equal(timer.timers.size, 1, "the concurrent manual clicks coalesce to one timer");
  timer.advance(500);
  timer.advance(500);
  assert.equal(provider.resultsSummaryRefreshRetryCount, 3);
  assert.equal(timer.timers.size, 0, "manual retry count is bounded");
  assert.equal(fetches, 0, "an in-flight fetch is never duplicated by a bounded retry");
});

test("a queued manual summary retry returns to the manual fetch after the active fetch ends", async () => {
  const timer = clock();
  let fetches = 0;
  const provider = selectedMethods(["refreshResultsSummary", "scheduleResultsSummaryTimer", "scheduleResultsSummaryBudgetRetryFromRealtime"], {
    ...timer,
    usableSelectionKey: (value) => String(value || ""),
    resultCollectionHost: () => ({ update: async () => { fetches += 1; return {}; } }),
  });
  Object.assign(provider, {
    resultsSummaryRefreshInFlight: true,
    resultsSummaryRefreshRetryCount: 0,
    resultsSummaryRefreshTimerGeneration: 0,
    projectContextGeneration: 1,
    client: {},
    selectedPlanId: "experiments/plans/a.yaml",
    planFileInput: "experiments/plans/a.yaml",
    localPlanMetadata: { plans: [{ planFile: "experiments/plans/a.yaml" }] },
    lastResultsSummaryRefreshedDirtyKey: "",
    pendingResultsSummaryDirtyKey: "d1",
    pendingResultsSummaryDirtyPlanFile: "experiments/plans/a.yaml",
    effectiveConnectionMode: () => "tunnel",
    recordActionError: () => { throw new Error("successful retry must not record an error"); },
    resolveSelectedPlanFile: (value) => value,
    postState() {},
  });
  await provider.scheduleResultsSummaryBudgetRetryFromRealtime({ decision: { reason: "rate_limited" } }, "manual_refresh", "d1");
  timer.advance(500);
  assert.equal(fetches, 0, "the retry defers while the active fetch is in flight");
  provider.resultsSummaryRefreshInFlight = false;
  timer.advance(500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1, "the deferred manual retry re-enters the single manual fetch path");
  assert.equal(provider.resultsSummaryRefreshRetryCount, 2);
});

test("background metrics collection reads verified artifacts in memory without the manual full-transfer route", async () => {
  const f=fixture(),provider=Object.assign(selectedMethods(["syncPendingResultMetricsFromUi"]),f.host);
  provider.rebuildProjectResultTablesFromUi=()=>assert.fail("background query must not enter the manual full-transfer UI");
  const report=await provider.syncPendingResultMetricsFromUi({background:true});
  assert.equal(report.source,"active_query");assert.equal(report.completed,1);
  const transfers=f.calls.filter(row=>row[0]==="sync.downloadMappedPaths");assert.equal(transfers.length,1);
  assert.equal(transfers[0][1].memoryOnly,true);assert.equal(transfers[0][1].metricsOnly,true);
  assert.equal(fs.existsSync(path.join(f.root,"work_dirs")),false,"raw artifacts cannot be downloaded to the local project");
});

test("concurrent manual summary refreshes share one active collection without a duplicate transfer", async () => {
  const f=fixture();let release;f.block(new Promise(resolve=>release=resolve));
  const provider=Object.assign(selectedMethods(["refreshResultsSummary"]),f.host,{
    effectiveConnectionMode:()=>"tunnel",recordActionError:error=>assert.fail(error.message)});
  const first=provider.refreshResultsSummary(),second=provider.refreshResultsSummary();
  await new Promise(setImmediate);assert.equal(f.calls.filter(row=>row[0]==="tasks").length,1);
  release();await Promise.all([first,second]);
  assert.equal(f.calls.filter(row=>row[0]==="tasks").length,2,"one discovery plus one fresh declared-result query");
  assert.equal(f.calls.filter(row=>row[0]==="sync.downloadMappedPaths").length,1);
  assert.equal(provider.resultsSummary.completed,1);
});

test("an explicit refresh after a failed query starts a fresh collection and cannot reuse cached metrics", async () => {
  const f=fixture(),provider=Object.assign(selectedMethods(["refreshResultsSummary"]),f.host,{effectiveConnectionMode:()=>"tunnel"});
  f.offline(true);await provider.refreshResultsSummary();
  assert.equal(provider.resultsSummary.results.length,0);assert.ok(provider.resultsSummary.skipped.length>0);
  const before=f.calls.length;f.offline(false);await provider.refreshResultsSummary();
  assert.equal(provider.resultsSummary.completed,1);assert.equal(provider.resultsSummary.results.length,1);
  assert.ok(f.calls.length>before);assert.equal(f.calls.filter(row=>row[0]==="sync.downloadMappedPaths").length,1);
});
