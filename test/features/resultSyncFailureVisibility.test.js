const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const OperationOutcome_1 = require("../../dist/core/OperationOutcome.js");
const source = fs.readFileSync(require.resolve("../../dist/extension/legacy.js"), "utf8");
function method(first, next) {
  const start = source.indexOf(first), end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start, first);
  return source.slice(start, end).replace(/}\r?\n {4}(?=(?:async )?[a-zA-Z_$][\w$]*\()/g, "},\n    ");
}

function fixture() {
  const alerts = [], warnings = [], statuses = [], terminal = [], progress = [], information = [];
  const sandbox = {
    workspaceRoot: () => "C:/project",
    OperationOutcome_1,
    PLAN_SUBMISSION_COMMANDS: new Set(["runPlan"]),
    actionCommandMap: { runPlan: "plan/run" },
    localCommandReleasesAfterTrigger: () => false,
    hostOperationLeaseActionLabel: command => command,
    errorMessage: error => error.message, compactSensitiveText: text => text,
    isUiCommandRemotePending: () => false, isUiCommandCancelled: error => error.name === "UiCommandCancelled",
    actionErrorSuggestion: () => "inspect",
    vscode: { window: { showErrorMessage: async (...args) => alerts.push(args), showWarningMessage: async (...args) => warnings.push(args), showInformationMessage: (...args) => information.push(args) } },
  };
  vm.createContext(sandbox);
  const helperStart = source.indexOf("function resultSyncCommandOutcome(");
  assert.ok(helperStart >= 0, "compiled collector outcome helper");
  vm.runInContext(source.slice(helperStart, source.indexOf("function resultMetricMergeScopePaths(", helperStart)), sandbox);
  vm.runInContext(`this.methods = { ${[
    method("async withUiCommandStatus(", "uiCommandWatchdogMs("),
    method("async runActionCommandCore(", "async runPlanPreflight("),
    method("\n    assertPlanSubmissionNotDuringResultSync(", "\n    async finishDistributedPlanSubmission("),
    method("async finishDistributedPlanSubmission(", "async activeDeferredForSubmission("),
    method("async distributedCodeVersionHold(", "planValidationCacheKey("),
  ].join(",")} };`, sandbox);
  const host = {
    ...sandbox.methods, localOperations: {}, manualResultSyncCounts: new Map(),
    postUiCommandStatus(_id, status, command, message, extra) { statuses.push(status); terminal.push({ status, command, message, ...extra }); },
    planSubmissionOperationId: () => "op", submissionStillCurrent: () => true,
    finishPlanSubmissionProgress(_message, status, detail) { progress.push({ status, detail }); },
    postState() {}, recordActionError() {}, queuePlanArtifactSyncStatusCheck() {},
  };
  return { host, alerts, warnings, statuses, terminal, progress, information };
}

test("replaced result requests finish silently while ordinary cancellations stay visible", async () => {
  for (const replaced of [true, false]) {
    const f = fixture();
    await f.host.withUiCommandStatus("click", "rebuildProjectResultTables", {}, async () => {
      const error = new Error(replaced ? "旧请求已被重新执行替代，保留已有产物。" : "用户取消同步。");
      error.name = "UiCommandCancelled";
      throw error;
    });
    assert.equal(f.statuses.at(-1), "cancelled");
    assert.equal(f.information.length, replaced ? 0 : 1);
    assert.equal(f.alerts.length, 0);
  }
});

test("run during result sync fails in a modal without navigating, cancelling or touching the sync", async () => {
  const f = fixture();
  const sync = Promise.resolve("still syncing");
  f.host.distributedPostprocessPromise = sync;
  let codeSync = false;
  f.host.ensureCodeReadyForRun = async () => { codeSync = true; };
  await f.host.withUiCommandStatus("click", "runPlan", {},
    () => f.host.finishDistributedPlanSubmission("runPlan", {}, {}, {}));
  assert.equal(f.host.distributedPostprocessPromise, sync);
  assert.equal(codeSync, false);
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0][1].modal, true);
  assert.match(f.alerts[0][1].detail, /同步将继续/);
  assert.equal(f.statuses.at(-1), "failed");
});

test("the full result download scope blocks submission before rules, Worker selection or client changes", async () => {
  const f = fixture();
  const client = {};
  f.host.client = client;
  let release;
  const download = f.host.withManualResultSync(() => new Promise(resolve => { release = resolve; }));
  await f.host.withUiCommandStatus("run-click", "runPlan", {}, () => f.host.runActionCommandCore("runPlan", {}));
  assert.equal(f.host.client, client);
  assert.equal(f.host.manualResultSyncCounts.get("C:/project"), 1);
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0][1].modal, true);
  assert.match(f.alerts[0][1].detail, /同步将继续/);
  release();
  await download;
  assert.equal(f.host.manualResultSyncCounts.size, 0);
  await assert.rejects(f.host.withManualResultSync(async () => { throw new Error("sync failed"); }), /sync failed/);
  assert.equal(f.host.manualResultSyncCounts.size, 0);
});

for (const command of ["syncPendingPlanArtifacts", "rebuildProjectResultTables", "syncAllResultArtifacts"]) {
  test(`${command} keeps verified results and reports partial collection without a second modal`, async () => {
    const f = fixture();
    await f.host.withUiCommandStatus("click", command, {}, async () => ({
      discovered: 2, included: ["a"], skipped: ["b: content missing"], missing: [], notificationShown: true,
    }));
    assert.equal(f.alerts.length, 0);
    assert.equal(f.warnings.length, 0, "the collector already displayed its warning");
    assert.equal(f.statuses.at(-1), "completed");
    assert.equal(f.terminal.at(-1).resultSync.outcome, "partial");
    assert.equal(f.terminal.at(-1).resultSync.included, 1);
    assert.equal(f.terminal.at(-1).resultSync.skipped, 1);
    assert.match(f.terminal.at(-1).message, /content missing/);
  });

  test(`${command} does not label rejected identity or hash checks successful when nothing is published`, async () => {
    for (const notificationShown of [false, true]) {
      const f = fixture();
      await f.host.withUiCommandStatus("click", command, {}, async () => ({
        discovered: 1, included: [], skipped: ["seed mismatch / SHA256 mismatch"], missing: [], notificationShown,
      }));
      assert.equal(f.statuses.at(-1), "failed");
      assert.equal(f.terminal.at(-1).resultSync.outcome, "failed");
      assert.equal(f.alerts.length, 0);
      assert.equal(f.warnings.length, notificationShown ? 0 : 1);
      assert.match(f.terminal.at(-1).message, /SHA256 mismatch/);
    }
  });

  test(`${command} distinguishes pending-only and preview-only results from formal publication`, async () => {
    for (const preview of [false, true]) {
      const f = fixture();
      await f.host.withUiCommandStatus("click", command, {}, async () => ({
        discovered: 1, included: [], skipped: [], missing: preview ? ["incomplete seeds"] : [],
        pending: preview ? [] : ["no completed jobs"], previews: preview ? ["run-b preview"] : [], notificationShown: true,
      }));
      assert.equal(f.statuses.at(-1), "completed");
      assert.equal(f.terminal.at(-1).resultSync.included, 0);
      assert.equal(f.terminal.at(-1).resultSync.outcome, preview ? "partial" : "pending");
      assert.equal(f.terminal.at(-1).resultSync.previews, preview ? 1 : 0);
      if (preview) assert.match(f.terminal.at(-1).message, /仅更新未完成运行预览，正式结果未更新/);
      assert.equal(f.alerts.length, 0);
    }
  });
}

test("a result operation exception still fails visibly and is never converted into partial success", async () => {
  const f = fixture();
  await f.host.withUiCommandStatus("click", "rebuildProjectResultTables", {}, async () => {
    throw new Error("publication transaction failed");
  });
  assert.equal(f.statuses.at(-1), "failed");
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0][1].modal, true);
});

test("completed old-revision history and an artifact sync do not masquerade as a live training blocker", async () => {
  const f = fixture();
  f.host.distributedPostprocessPromise = Promise.resolve();
  f.host.loadDistributedQueue = async () => ({ plans: [{ codeFingerprint: "old", jobs: [{ status: "completed" }] }] });
  f.host.localDistributedCodeFingerprint = async () => { throw new Error("should not compare inactive code"); };
  assert.equal(await f.host.distributedCodeVersionHold({}), undefined);
});
