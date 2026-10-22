const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

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
    workspaceRoot: () => "/project",
    errorMessage: (error) => String(error?.message || error),
    assertRetryRequestCurrent: () => undefined,
    retryRequestSignal: () => undefined,
    completedResultPlanFiles: async () => [],
    resultCollectionHost: () => ({ update: async () => ({}) }),
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
