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
    workspaceRoot: () => "/project",
    errorMessage: (error) => String(error?.message || error),
    assertRetryRequestCurrent: () => undefined,
    retryRequestSignal: () => undefined,
    completedResultPlanFiles: async () => [],
    vscode: { ProgressLocation: { Notification: 1 }, window: {
      showInformationMessage: async () => {},
      withProgress: async (_options, work) => work({ report() {} }, { isCancellationRequested: false }),
    } },
    ...globals,
  };
  vm.runInNewContext(code + "\nthis.Subject = Subject;", sandbox);
  return new sandbox.Subject();
}

function distributedHost() {
  const calls = [];
  const provider = selectedMethods(["scheduleDistributedPostprocess", "postprocessDistributedResultsForManual", "syncPendingResultMetricsFromUi"]);
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

test("background queue ticks, completion sync, and selection parsing do not start result work", async () => {
  const calls = [];
  const provider = selectedMethods(["scheduleDistributedPostprocess", "queuePlanScopedResultParse", "queueCompletedPlanArtifactSync"]);
  provider.distributedPostprocessPromise = undefined;
  provider.syncDistributedJobArtifacts = async () => calls.push("transfer");
  provider.rebuildDistributedResults = async () => calls.push("rebuild");
  provider.runActionCommand = async () => calls.push("parse");
  provider.scheduleDistributedPostprocess("/project", true);
  provider.queuePlanScopedResultParse("plan selected", "experiments/plans/a.yaml", "a");
  await provider.queueCompletedPlanArtifactSync({ status: "completed" });
  assert.deepEqual(calls, []);
});

test("manual result sync directly downloads metrics and publishes local tables without remote rebuild or full mirroring", async () => {
  const provider = distributedHost();
  const result = await provider.syncPendingResultMetricsFromUi({ planFiles: ["experiments/plans/a.yaml"] });
  assert.equal(result.title, "同步服务器结果并更新总表");
  assert.deepEqual(Array.from(result.planFiles), ["experiments/plans/a.yaml"]);
  assert.deepEqual(provider.calls, ["local-tables"]);
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
  const provider = distributedHost();
  const result = await provider.syncPendingResultMetricsFromUi({ background: true });
  assert.equal(result.reason, "manual-only");
  assert.deepEqual(provider.calls, []);
});

test("two concurrent manual summary requests share at most three direct manual retries", async () => {
  const timer = clock();
  const provider = selectedMethods(["refreshResultsSummary", "scheduleResultsSummaryTimer"], {
    ...timer,
    usableSelectionKey: (value) => String(value || ""),
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
    pendingResultsSummaryDirtyKey: "",
    pendingResultsSummaryDirtyPlanFile: "",
    effectiveConnectionMode: () => "tunnel",
    shouldRefreshResultsSummaryForDirtyPlan: () => true,
    hasResultsSummaryEndpointCapability: () => true,
  });
  await provider.refreshResultsSummary("experiments/plans/a.yaml");
  await provider.refreshResultsSummary("experiments/plans/a.yaml");
  assert.equal(timer.timers.size, 1, "the concurrent manual clicks coalesce to one timer");
  timer.advance(2_000);
  assert.equal(provider.resultsSummaryRefreshRetryCount, 3);
  assert.equal(timer.timers.size, 0, "manual retry count is bounded");
});

test("a queued manual summary retry returns to the manual fetch after the active fetch ends", async () => {
  const timer = clock();
  const provider = selectedMethods(["refreshResultsSummary", "scheduleResultsSummaryTimer"], {
    ...timer,
    usableSelectionKey: (value) => String(value || ""),
  });
  let fetches = 0;
  Object.assign(provider, {
    resultsSummaryRefreshInFlight: true,
    resultsSummaryRefreshRetryCount: 0,
    resultsSummaryRefreshTimerGeneration: 0,
    projectContextGeneration: 1,
    client: { getResultsSummary: async () => { fetches++; return {}; } },
    selectedPlanId: "experiments/plans/a.yaml",
    planFileInput: "experiments/plans/a.yaml",
    localPlanMetadata: { plans: [{ planFile: "experiments/plans/a.yaml" }] },
    lastResultsSummaryRefreshedDirtyKey: "",
    pendingResultsSummaryDirtyKey: "",
    pendingResultsSummaryDirtyPlanFile: "",
    effectiveConnectionMode: () => "tunnel",
    shouldRefreshResultsSummaryForDirtyPlan: () => true,
    hasResultsSummaryEndpointCapability: () => true,
    resolveSelectedPlanFile: (value) => value,
    postState() {},
  });
  await provider.refreshResultsSummary("experiments/plans/a.yaml");
  provider.resultsSummaryRefreshInFlight = false;
  timer.advance(500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
});
