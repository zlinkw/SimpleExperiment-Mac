const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const OperationOutcome_1 = require("../../dist/core/OperationOutcome.js");
const source = fs.readFileSync(require.resolve("../../dist/extension/legacy.js"), "utf8");
function method(first, next) {
  const start = source.indexOf(first), end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start, first);
  return source.slice(start, end).replace(/}\r?\n {4}(?=(?:async )?[a-zA-Z_$][\w$]*\()/g, "},\n    ");
}

function fixture({ errorChoice, finishChoice } = {}) {
  const alerts = [], warnings = [], statuses = [], terminal = [], progress = [], information = [], logCalls = [], facts = [], openedPanels = [];
  const sandbox = {
    workspaceRoot: () => "C:/project",
    OperationOutcome_1,
    PLAN_SUBMISSION_COMMANDS: new Set(["runPlan"]),
    actionCommandMap: { runPlan: "plan/run" },
    localCommandReleasesAfterTrigger: () => false,
    hostOperationLeaseActionLabel: command => command,
    errorMessage: error => error.message, compactSensitiveText: text => text,
    isUiCommandRemotePending: () => false, isUiCommandCancelled: error => error.name === "UiCommandCancelled",
    // r49 迁类：runActionCommandCore/distributedCodeVersionHold 的编译切片经 UiCommandCancelled_1
    // 命名空间引用共享取消类；沙箱按 core 同一构造语义供给，分支一旦执行不再 ReferenceError。
    UiCommandCancelled_1: { UiCommandCancelled: class UiCommandCancelled extends Error {
      constructor(message = "操作已取消。", code = "USER_CANCELLED") { super(message); this.name = "UiCommandCancelled"; this.code = code; } } },
    actionErrorSuggestion: () => "inspect",
    // r4 (task ui-plan-gpu-progress-20261024 返修): the four artifact-sync commands now run
    // their per-operation Notification through the real withUiCommandStatus funnel, so this
    // fixture supplies the same lifecycle dependencies planOperationNoticeLifecycle uses —
    // real methods below, mock host surfaces only. Failure/partial/cancelled semantics
    // asserted here are unchanged.
    stringField: (record, key) => String((record && record[key]) || ""),
    OPERATION_NOTICE_TITLES: {
      retryJobArtifactSync: "重试产物同步", refreshJobArtifacts: "刷新产物状态",
      syncPendingPlanArtifacts: "同步待同步产物", syncAllResultArtifacts: "同步全部结果文件",
    },
    vscode: {
      ProgressLocation: { Notification: 15 },
      window: {
        // r42: Native showErrorMessage resolves the clicked button item (undefined on dismiss);
        // 记录调用后返回 errorChoice，被测 callback 仍由产品真实 .then 分支驱动。
        showErrorMessage: async (...args) => { alerts.push(args); return errorChoice; }, showWarningMessage: async (...args) => { warnings.push(args); return finishChoice; }, showInformationMessage: (...args) => information.push(args),
        withProgress: (_options, callback) => Promise.resolve(callback({ report() {} })).catch(() => undefined),
        createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      },
    },
  };
  vm.createContext(sandbox);
  const helperStart = source.indexOf("function resultSyncCommandOutcome(");
  assert.ok(helperStart >= 0, "compiled collector outcome helper");
  vm.runInContext(source.slice(helperStart, source.indexOf("function resultMetricMergeScopePaths(", helperStart)), sandbox);
  vm.runInContext(`this.methods = { ${[
    method("async withUiCommandStatus(", "uiCommandWatchdogMs("),
    method("\n    operationNoticeKey(message)", "\n    submissionNoticeTone(message, result)"),
    method("async runActionCommandCore(", "async runPlanPreflight("),
    method("\n    assertPlanSubmissionNotDuringResultSync(", "\n    async finishDistributedPlanSubmission("),
    method("async finishDistributedPlanSubmission(", "async activeDeferredForSubmission("),
    method("async distributedCodeVersionHold(", "legacySourceFreezeWorkerNames("),
    method("\n    finishOperationProgressNotice(", " submissionNoticeTone("),
  ].join(",")} };`, sandbox);
  const host = {
    ...sandbox.methods, localOperations: {}, manualResultSyncCounts: new Map(),
    operationNoticeSessions: new Map(), context: { subscriptions: [] },
    postUiCommandStatus(_id, status, command, message, extra) { statuses.push(status); terminal.push({ status, command, message, ...extra }); },
    planSubmissionOperationId: () => "op", submissionStillCurrent: () => true,
    finishPlanSubmissionProgress(_message, status, detail) { progress.push({ status, detail }); },
    postState() {}, recordActionError() {}, queuePlanArtifactSyncStatusCheck() {},
    beginSimpleSftpCapabilityLaunch() {}, legacySourceFreezeWorkerNames() { return []; },
    // r42: 最小可观察日志宿主——仅计数真实产品 .then 分支的调用，不伪造被测 callback。
    showOperationLogFromUi() { logCalls.push(1); },
    // r47 A：finishOperationProgressNotice 的被测宿主——完整日志通道与面板导航均为真实方法调用点。
    logOperationFact(line) { facts.push(line); }, openPanelAt(panel) { openedPanels.push(panel); },
  };
  return { host, alerts, warnings, statuses, terminal, progress, information, logCalls, facts, openedPanels };
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

test("legacy result-sync submission guard leaves active mirrors and UI untouched", async () => {
  const f = fixture();
  const sync = Promise.resolve("still syncing");
  f.host.distributedPostprocessPromise = sync;
  f.host.assertPlanSubmissionNotDuringResultSync({});
  assert.equal(f.host.distributedPostprocessPromise, sync);
  assert.equal(f.alerts.length, 0);
  assert.equal(f.progress.length, 0);
});

test("memory-only result reads do not reserve a global PLAN submission scope", async () => {
  const f = fixture();
  const client = {};
  f.host.client = client;
  let release;
  const download = f.host.withManualResultSync(() => new Promise(resolve => { release = resolve; }));
  f.host.assertPlanSubmissionNotDuringResultSync({});
  assert.equal(f.host.client, client);
  assert.equal(f.host.manualResultSyncCounts.size, 0);
  assert.equal(f.alerts.length, 0);
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
  // r42: 失败反馈按用户 r40 要求为非 modal 原生错误通知 + "查看日志"按钮（legacy.ts
  // withUiCommandStatus catch→failed 分支），旧 modal:true 预期失效。两个必要选择 case
  // 在本测试内循环，完整保留失败可见性与终态语义断言。
  for (const errorChoice of ["查看日志", undefined]) {
    const f = fixture({ errorChoice });
    await f.host.withUiCommandStatus("click", "rebuildProjectResultTables", {}, async () => {
      throw new Error("publication transaction failed");
    });
    await new Promise(resolve => setImmediate(resolve)); // flush 产品通知按钮 .then
    assert.equal(f.statuses.at(-1), "failed");
    assert.equal(f.terminal.at(-1).status, "failed");
    assert.equal(f.terminal.at(-1).resultSync, undefined, "异常失败绝不被转成 partial 结果同步成功");
    assert.equal(f.alerts.length, 1, "恰好一条原生错误通知");
    assert.match(f.alerts[0][0], /publication transaction failed/, "完整异常原因进入原生错误通知");
    assert.match(f.terminal.at(-1).message, /publication transaction failed/, "终态记录保留完整异常原因");
    assert.deepEqual(f.alerts[0].slice(1), ["查看日志"], "唯一按钮为查看日志，无 modal/options 对象");
    assert.equal(f.warnings.length, 0);
    assert.equal(f.information.length, 0, "不增加重复 info/warning");
    assert.equal(f.logCalls.length, errorChoice === "查看日志" ? 1 : 0, "仅点击\"查看日志\"才实际调用日志宿主，dismiss 不调用");
  }
});

test("A cleared-selection wait closes its native progress session silently while ordinary cancellation keeps its warning feedback", async () => {
  for (const silent of [false, true]) {
    const f = fixture({ finishChoice: silent ? undefined : "查看日志" });
    let finished = 0;
    f.host.operationNoticeSessions.set("artifact-key", { title: "重试产物同步", reports: [], closed: false, finishResolve: () => { finished++; } });
    f.host.finishOperationProgressNotice("artifact-key", "cancelled", "所选任务已被本地清退或被新的运行替代，本次等待已结束。", silent ? { silent: true } : undefined);
    await new Promise(resolve => setImmediate(resolve)); // flush 按钮 .then
    assert.equal(finished, 1, "session 的 done 释放照旧（silent 不吞释放）");
    assert.equal(f.host.operationNoticeSessions.size, 0, "session 删除照旧");
    assert.ok(f.facts.some(line => /SimpleExperiment 重试产物同步：所选任务已被本地清退/.test(line)), "完整终态日志照旧");
    assert.equal(f.warnings.length, silent ? 0 : 1, "仅 A 身份失效清退静默收拢；普通取消的既有可见 warning 反馈保留");
    assert.equal(f.alerts.length, 0);
    assert.equal(f.information.length, 0);
    assert.equal(f.logCalls.length, silent ? 0 : 1, "非静默且点击\"查看日志\"仍真实调用日志宿主");
  }
});

test("a non-silent progress finish keeps the native button routing to the execution panel", async () => {
  const f = fixture({ finishChoice: "打开面板" });
  let finished = 0;
  f.host.operationNoticeSessions.set("k", { title: "t", reports: [], closed: false, finishResolve: () => { finished++; } });
  f.host.finishOperationProgressNotice("k", "cancelled", "普通取消原因。", undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, 1);
  assert.equal(f.warnings.length, 1);
  assert.deepEqual(f.openedPanels, ["execution"], "点击\"打开面板\"真实调用既有 execution 面板宿主（Job 行手动重新同步所在处）");
});

test("completed old-revision history and an artifact sync do not masquerade as a live training blocker", async () => {
  const f = fixture();
  f.host.distributedPostprocessPromise = Promise.resolve();
  f.host.loadDistributedQueue = async () => ({ plans: [{ codeFingerprint: "old", jobs: [{ status: "completed" }] }] });
  f.host.localDistributedCodeFingerprint = async () => { throw new Error("should not compare inactive code"); };
  assert.equal(await f.host.distributedCodeVersionHold({}), undefined);
});

// 0.5.416 配套（se-stage-block-visibility-release）：「释放旧文件占用」专用受控链。
// 从编译产物切出真实 releaseJobStageBlockSlotsFromUi 方法，在 vm 沙箱里由产品代码驱动全部分支；
// 只 mock 宿主表面（能力读取、cleanup RPC、确认框、重试入口），断言全部走真实方法逻辑。
const STAGE_ID = "a".repeat(64), STAGE_GEN = "c".repeat(64), STAGE_INCOMING = "b".repeat(64);
const STAGE_RELATIVE = ".staged-slots/" + STAGE_ID + "/slot-0";
// 0.5.416 终审第二轮返修夹具要点（审核第 3/4 条：mock 逐条对齐真实引擎、目录证据必须真实）：
// - 源槽目录与 manifest.json 是真实文件系统实体：夹具在 mkdtemp 的真实临时目录里建真实目录与文件；
//   所有"源槽仍在/已被移走""隔离副本存在/不存在"断言一律基于 existsSync 真实结果，不再用模拟布尔
//   冒充真实目录证据（temp 根在进程退出时尽力清理）。
// - capabilities 是已发布 SimpleSFTP 0.2.113 的完整释放契约（方法＋裁定选项），缺任一即入门拒绝。
// - preview mock 忠实复现发布版 preview 的 stagedJournal 严格格式校验（cleanup-file-api.js 0.2.113:508–516）
//   并把绑定与目标冻结进模拟台账（真实台账语义：execute 只能用冻结值）；绑定格式非法即抛
//   INVALID_STAGED_JOURNAL_BINDING；不传绑定预览仍成功（发布版只保留槽锁检查——回归用例靠这条真实
//   分支证明"没带绑定就会被隔离"）。preview 在夹具里零写入：绝不触碰槽目录。
// - execute mock 逐条移植发布版 cleanup-files.py::verify_staged_journal_binding（0.2.113 全部语义）：
//   绑定形状；journal 不可读/JSON 损坏/非对象；identity/完整代/committed 状态；已写字段的 null 一律
//   malformed（createdAt/terminalAt/updatedAt）；journal 丢了 terminalAt 不再被接受（绑定冻结了终态时刻
//   就要求原样带回，无回退）；绑定 terminalAt 必须精确一致；时间基准 terminalAt→updatedAt→manifest
//   mtime 择基；future 基准；createdAt 矛盾；以及 1146–1147 的最后一条无条件年龄阈值
//   （(now-basis)*1000 < expiryMs 即拒）。任一不满足抛同源错误，真实源槽目录原样保留。
//   无绑定则按发布版只剩槽锁检查、隔离照常发生。隔离成功先建父目录再 renameSync 真实移动槽目录到
//   clean_dir/<batch>/<rel>（no_replace：destination 已存在即 DESTINATION_EXISTS）。
// - 0.2.114 解冻（SFTP 提交 2b8586a，字段逐字采用）：引擎移植支持 `requireExpired`——仅当值恰为
//   false 时跳过最后那条年龄阈值，其余锁内检查原样；undefined 冻结为 true（0.2.113 逐字节不变）。
//   preview mock 按 cleanup-file-api.js:519 严格校验（只接受 undefined 或 boolean）；requireExpired 进
//   冻结台账并以"台账绑定序列化=预览时冻结摘要"模拟 digest 前置（cleanup-file-api.js:591 真实实现把
//   绑定并入 hash 前置，确认阶段翻转值将以 CONFIRM_REQUIRED 被拒、execute 只重放冻结 copy——夹具以
//   execute 前摘要核对模拟同一拒绝点，模拟面如实标注）。bindingMode 选项可模拟"自动回收链/旧调用方"
//   的 true/缺省绑定形态（本产品用户确认链一律 false），flipAtConfirm 选项模拟确认后翻转尝试。
// - 默认 journal 用 terminalAt=2/updatedAt=3 的秒级纪元时间戳（1970 年）：引擎把 basis 直接当 epoch
//   秒使用，忠实移植 ⇒ 默认候选即"早已过过期阈值的旧槽"；youngJournal=true 时基准=一小时前，用于
//   requireExpired:false 成功路径与 true/缺省仍拒的兼容断言。
const RELEASE_TMP_ROOTS = [];
process.on("exit", () => {
  for (const root of RELEASE_TMP_ROOTS) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 尽力清理 */ } }
});
function releaseFixture(options = {}) {
  const { capabilityReady = true, warningChoice, liveCandidates, deleteState = "accepted", statusStates, releaseCandidate = true,
    ageMs = 172800000, previewSafety = true, liveExpiry = { enabled: true, ms: 86400000 }, onCall, youngJournal = false,
    journalInit = null, bindingMode = null, flipAtConfirm = false, safetyMissing = null } = options;
  const cleanupCalls = [], warnings = [], errorLog = [], syncRetries = [], patches = [];
  const queueJob = { index: 0, commandId: "command0", artifactStageBlock: { schemaVersion: 1, code: "TRANSFER_STAGE_PENDING",
    destination: { id: "b", profile: "work", host: "nwpu3.invalid" }, scope: "job-artifacts-scope", lane: 0, identity: STAGE_ID,
    incomingGeneration: STAGE_INCOMING,
    slots: [{ slot: "slot-0", path: STAGE_RELATIVE, generation: STAGE_GEN, status: "committed", createdAt: 1, terminalAt: 2, updatedAt: 3,
      timeSource: "journal-terminalAt", ageMs, locked: false, protectedReason: null },
      { slot: "slot-1", path: ".staged-slots/" + STAGE_ID + "/slot-1", generation: "d".repeat(64), status: "running", createdAt: 4,
        terminalAt: 0, updatedAt: 5, timeSource: null, ageMs: null, locked: true, protectedReason: "lock-held" }],
    releaseCandidate } };
  const capabilities = { methods: ["files.cleanup.stagedSlots", "files.cleanup.preview", "files.cleanup.confirm",
      "files.cleanup.execute", "files.cleanup.status", "files.cleanup.isolatedMaintenanceDelete"],
    methodOptions: { "files.cleanup.stagedSlots": { expiredCommittedReclaim: 1, structuredBlockEvidence: 1, releaseConfirmationCount: 1 },
      "sync.serverToServerFpsync": { claimScopedExpiredReclaim: 1, stageBlockEvidence: 1 },
      "files.cleanup.preview": { backgroundIsolatedDelete: 1 }, "files.cleanup.execute": { isolationCompletionReceipt: 1 },
      "files.cleanup.confirm": { exactBatchDigest: true, deleteConfirmationCount: 2 },
      "files.cleanup.isolatedMaintenanceDelete": { registeredIsolationTokenOnly: 1, pluginDerivedDeleteSet: 1,
        isolationCompletionReceiptRequired: 1, userConfirmedSlotRelease: 1 } } };
  // 真实远端根：槽目录＋manifest.json 都是真文件；引擎移植只读这些真实文件，绝不读模拟状态。
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "se-stage-release-"));
  RELEASE_TMP_ROOTS.push(projectRoot);
  const slotAbsolute = path.join(projectRoot, ...STAGE_RELATIVE.split("/"));
  const journalFile = path.join(slotAbsolute, "manifest.json");
  fs.mkdirSync(slotAbsolute, { recursive: true });
  const nowS = Math.floor(Date.now() / 1000);
  const state = {
    // 台账 journal 的当前事实（引擎锁内复检唯一比对来源=真实 manifest.json）；回归用例在 execute 前
    // 改写/删除真实文件模拟竞态。youngJournal=true 时基准=一小时前（epoch 秒），忠实触发年龄阈值拒。
    journal: { ...(youngJournal
      ? { identity: STAGE_ID, generation: STAGE_GEN, status: "committed", createdAt: nowS - 3720, terminalAt: nowS - 3600, updatedAt: nowS - 3600 }
      : { identity: STAGE_ID, generation: STAGE_GEN, status: "committed", createdAt: 1, terminalAt: 2, updatedAt: 3 }), ...(journalInit || {}) },
    writeJournal: () => fs.writeFileSync(journalFile, JSON.stringify(state.journal)),
    setJournal: patch => { Object.assign(state.journal, patch); state.writeJournal(); },
    removeJournal: () => fs.rmSync(journalFile, { force: true }),
    isolatedApplied: false, isolatedDestination: null, previewLedger: null,
    breakContext: () => { host.projectContextGeneration += 1; },
  };
  state.writeJournal();
  const sandbox = { workspaceRoot: () => "C:/project", crypto: require("node:crypto"),
    JobArtifactSyncIdentity_1: require("../../dist/features/JobArtifactSyncIdentity.js"),
    vscode: { window: { showWarningMessage: async (...args) => { warnings.push(args); return warningChoice; } } } };
  vm.createContext(sandbox);
  const start = source.indexOf("async releaseJobStageBlockSlotsFromUi(");
  // 终点落在下一成员声明之前的真实边界（release 方法闭合大括号处截断）：
  // 直接用声明名做终点会把 "private async " 残段留在对象字面量尾部，切片自身即非法语法。
  const nextMember = source.indexOf("async syncCompletedPlanArtifacts(context)", start);
  const end = nextMember > start ? source.lastIndexOf("}", nextMember) + 1 : nextMember;
  assert.ok(start >= 0 && end > start, "compiled release method slice");
  vm.runInContext(`this.methods = { ${source.slice(start, end).replace(/}\r?\n {4}(?=(?:async )?[a-zA-Z_$][\w$]*\()/g, "},\n    ")} };`, sandbox);
  let stagedSlotsReads = 0;
  const host = { ...sandbox.methods, client: {}, projectContextGeneration: 1,
    readSimpleSftpCapabilities: async () => { if (!capabilityReady) throw new Error("SimpleSFTP 不支持 files.cleanup.stagedSlots。"); return capabilities; },
    recordActionError: row => errorLog.push(row),
    loadDistributedQueue: async () => ({ plans: [{ id: "plan", jobs: [queueJob] }] }),
    patchDistributedJob: async (...args) => patches.push(args),
    workerCodeSyncTargets: () => [{ id: "b", host: "nwpu3.invalid", port: 22, user: "u", remotePath: "/safe/project" }],
    sftpServerOptions: row => ({ id: row.id, host: row.host, user: row.user, port: row.port, remotePath: row.remotePath }),
    artifactSyncFromUi: async message => { syncRetries.push(message); return { status: "completed", message: "产物增量同步：1 个 job 已一致" }; },
    postState() {},
    simpleSftpApiCall: async (method, params) => {
      cleanupCalls.push({ method, params });
      if (onCall) onCall(method, params, state);
      if (method === "files.cleanup.stagedSlots") {
        stagedSlotsReads += 1;
        if (stagedSlotsReads === 1) return { candidates: liveCandidates === undefined
          ? [{ relativePath: STAGE_RELATIVE, type: "directory", status: "committed", generation: STAGE_GEN, locked: false, releaseCandidate: true,
              terminalAt: state.journal.terminalAt, ageMs, protectedReason: null }]
          : liveCandidates, ...(liveExpiry === null ? {} : { expiry: liveExpiry }) };
        return { candidates: [] }; // 删除后的最终只读复核：原槽已退出盘点。
      }
      if (method === "files.cleanup.preview") {
        const binding = params.stagedJournal;
        if (binding !== undefined) {
          const valid = binding && typeof binding === "object" && !Array.isArray(binding)
            && /^[0-9a-f]{64}$/.test(String(binding.identity || "")) && /^[0-9a-f]{64}$/.test(String(binding.generation || ""))
            && binding.status === "committed" && Number.isInteger(binding.expiryMs) && binding.expiryMs > 0
            && (binding.terminalAt === null || (Number.isInteger(binding.terminalAt) && binding.terminalAt > 0))
            && (binding.requireExpired === undefined || typeof binding.requireExpired === "boolean"); // cleanup-file-api.js:519
          if (!valid) throw new Error("INVALID_STAGED_JOURNAL_BINDING");
        }
        // 冻结进台账（execute 只重放这份）；bindingMode 模拟"自动回收链/旧调用方"的 true/缺省形态——
        // 本产品用户确认链收到的绑定总是 requireExpired:false，覆盖只为构造 0.2.113 兼容拒的路径。
        const frozen = binding === undefined ? undefined : JSON.parse(JSON.stringify(binding));
        if (frozen && bindingMode === "true") frozen.requireExpired = true;
        if (frozen && bindingMode === "absent") delete frozen.requireExpired;
        // 摘要模拟：真实实现把绑定（含 requireExpired）并入 digest 前置（cleanup-file-api.js:591），
        // 确认后改值的确认请求会被 CONFIRM_REQUIRED 拒、execute 只重放冻结 copy；夹具以"execute 前
        // 序列化比对冻结摘要"模拟同一拒绝点。
        state.previewLedger = { stagedJournal: frozen, frozenBindingDigest: frozen === undefined ? null : JSON.stringify(frozen),
          target: { relativePath: params.targets[0].relativePath, destination: params.targets[0].destination } };
        const safety = { backgroundIsolatedDelete: 1, isolationCompletionReceipt: 1, userConfirmedSlotRelease: 1 };
        if (safetyMissing) delete safety[String(safetyMissing)];
        return { token: "tok-1", digest: "dig-1", ...(previewSafety ? { safety } : {}),
          targets: [{ relativePath: params.targets[0].relativePath, destination: params.targets[0].destination, absolutePath: slotAbsolute, missing: false }] };
      }
      if (method === "files.cleanup.confirm") {
        // 模拟"确认请求试图翻转 requireExpired"：真实后端会因 digest 前置不符直接拒该确认请求；
        // 夹具退一步让台账先被改掉，由 execute 的冻结摘要核对兜住同一拒绝点（CONFIRM_REQUIRED）。
        if (flipAtConfirm && state.previewLedger && state.previewLedger.stagedJournal)
          state.previewLedger.stagedJournal.requireExpired = true;
        return {};
      }
      if (method === "files.cleanup.execute") {
        const binding = state.previewLedger ? state.previewLedger.stagedJournal : undefined;
        // 冻结摘要核对（digest 前置的夹具模拟）：requireExpired 已进真实 digest 前置，
        // 预览后被翻转 → 与冻结摘要不符 → CONFIRM_REQUIRED，rename 之前拒。
        if (state.previewLedger && state.previewLedger.frozenBindingDigest !== null
            && JSON.stringify(binding) !== state.previewLedger.frozenBindingDigest)
          throw new Error("CONFIRM_REQUIRED：台账绑定与预览冻结摘要不一致，拒绝执行");
        if (binding !== undefined) {
          // verify_staged_journal_binding 的忠实移植（0.2.113 全量＋0.2.114 requireExpired 分支：
          // 恰为 false 只跳过最后那条年龄阈值，其余检查原样；undefined 冻结为 true=旧行为）。
          const requireExpired = binding.requireExpired === undefined ? true : binding.requireExpired;
          const denyInvalid = () => { throw new Error("INVALID_STAGED_JOURNAL_BINDING"); };
          const denyMismatch = () => { throw new Error("STAGED_JOURNAL_MISMATCH：锁内复检发现暂存槽 journal 不再符合过期回收资格，拒绝隔离"); };
          if (!(typeof binding.identity === "string" && /^[0-9a-f]{64}$/.test(binding.identity)
              && typeof binding.generation === "string" && /^[0-9a-f]{64}$/.test(binding.generation)
              && Number.isInteger(binding.expiryMs) && binding.expiryMs > 0
              && (binding.terminalAt === null || (Number.isInteger(binding.terminalAt) && binding.terminalAt > 0)))) denyInvalid();
          let row, manifestMtime;
          try {
            row = JSON.parse(fs.readFileSync(journalFile, "utf8").slice(0, 262144));
            manifestMtime = fs.statSync(journalFile).mtimeMs / 1000;
          } catch { denyMismatch(); }
          const trusted = value => Number.isInteger(value) && value > 0 ? value : null;
          if (row === null || typeof row !== "object" || Array.isArray(row)
              || row.identity !== binding.identity || row.generation !== binding.generation || row.status !== "committed") denyMismatch();
          if ("createdAt" in row && trusted(row.createdAt) === null) denyMismatch();
          const created = trusted(row.createdAt);
          const createdS = created ? (created > 1_000_000_000_000 ? created / 1_000_000_000 : created) : 0;
          if ("terminalAt" in row && trusted(row.terminalAt) === null) denyMismatch();
          if ("updatedAt" in row && trusted(row.updatedAt) === null) denyMismatch();
          // 字段缺失与写出 null 在 Python 里都让 raw 值为 None，但写出 null 已先被 malformed 拒——
          // 到这里的 None 只可能是字段缺失。
          const terminal = "terminalAt" in row ? row.terminalAt : null;
          const updated = "updatedAt" in row ? row.updatedAt : null;
          if (terminal === null && binding.terminalAt !== null) denyMismatch();
          if (terminal !== null && binding.terminalAt !== null && terminal !== binding.terminalAt) denyMismatch();
          const basis = terminal !== null ? terminal : updated !== null ? updated : manifestMtime;
          const now = Date.now() / 1000;
          if (basis > now || (createdS && basis < createdS - 1)) denyMismatch();
          if (requireExpired !== false && (now - basis) * 1000 < binding.expiryMs) denyMismatch(); // cleanup-files.py 年龄阈值；0.2.114 仅 requireExpired===False 跳过
        }
        const destination = state.previewLedger.target.destination;
        const destinationAbsolute = path.join(projectRoot, ...String(destination).split("/"));
        if (fs.existsSync(destinationAbsolute)) throw new Error("DESTINATION_EXISTS " + destinationAbsolute);
        fs.mkdirSync(path.dirname(destinationAbsolute), { recursive: true });
        fs.renameSync(slotAbsolute, destinationAbsolute); // no_replace rename：真实移动源槽目录
        state.isolatedApplied = true;
        state.isolatedDestination = destinationAbsolute;
        return {};
      }
      if (method === "files.cleanup.status") return { states: statusStates || (state.isolatedApplied ? { 0: "completed" } : { 0: "pending" }) };
      if (method === "files.cleanup.isolatedMaintenanceDelete") return { state: deleteState };
      return {};
    } };
  return { host, state, cleanupCalls, warnings, errorLog, syncRetries, patches, projectRoot, slotAbsolute,
    // 真实文件系统证据（不再是模拟布尔）：
    get slotDirectoryPresent() { return fs.existsSync(slotAbsolute); },
    get isolatedCopyPresent() { return state.isolatedDestination !== null && fs.existsSync(state.isolatedDestination); },
    get isolatedCopyManifestPresent() {
      return state.isolatedDestination !== null && fs.existsSync(path.join(state.isolatedDestination, "manifest.json")); },
    run: () => host.releaseJobStageBlockSlotsFromUi({ planId: "plan", jobIndex: 0, commandId: "command0" }) };
}

test("release chain freezes the live candidate, shows one exact confirmation and only then isolates, proves receipts, deletes registered and retries just the original sync", async () => {
  const f = releaseFixture({ warningChoice: "确认释放此暂存槽" });
  const result = await f.run();
  assert.equal(result.status, "completed", result.message);
  assert.match(result.message, /已释放 nwpu3\.invalid 的旧暂存槽/);
  assert.deepEqual(f.cleanupCalls.map(row => row.method), ["files.cleanup.stagedSlots", "files.cleanup.preview", "files.cleanup.confirm",
    "files.cleanup.execute", "files.cleanup.status", "files.cleanup.isolatedMaintenanceDelete", "files.cleanup.stagedSlots"]);
  const preview = f.cleanupCalls[1].params;
  assert.equal(preview.action, "isolate");
  assert.equal(preview.authorizationSource, "single_confirmation_release", "授权来源=一次确认释放，绝不冒充自动过期策略或通用清理");
  assert.equal(preview.consumerRoot, "C:/project", "consumerRoot=本地消费项目，不是远端根");
  assert.equal(preview.targets.length, 1);
  assert.equal(preview.targets[0].relativePath, STAGE_RELATIVE);
  assert.match(preview.targets[0].archiveBatch, /^job-[a-f0-9]{48}$/);
  assert.equal(preview.targets[0].destination, "clean_dir/" + preview.targets[0].archiveBatch + "/" + STAGE_RELATIVE);
  // 终审 P1-1：释放授权必须显式携带冻结 journal 绑定，让引擎在槽锁内、rename 前对当前 journal 复检。
  assert.ok(preview.stagedJournal && typeof preview.stagedJournal === "object", "释放预览必须携带 stagedJournal 绑定，绝不只靠槽锁");
  assert.equal(preview.stagedJournal.identity, STAGE_ID);
  assert.equal(preview.stagedJournal.generation, STAGE_GEN, "绑定完整代=冻结候选的完整代");
  assert.equal(preview.stagedJournal.status, "committed");
  assert.equal(preview.stagedJournal.expiryMs, 86400000, "过期阈值取本次实时盘点返回的远端 expiry，两种模式都照实携带，绝不塞 0/缺省");
  assert.equal(preview.stagedJournal.terminalAt, 2, "终态时刻冻结自实时候选（journal 无终态时刻时为 null）");
  assert.equal(preview.stagedJournal.requireExpired, false, "用户确认链一律 requireExpired:false（0.2.114：仅免锁内年龄阈值，其余检查全保留）");
  // 一次确认：恰一个模态，展示的绝对/相对路径与 confirm exactTargets、执行绑定逐字一致；完整代随确认呈现。
  assert.equal(f.warnings.length, 1);
  const shown = String(f.warnings[0][0]);
  assert.match(shown, new RegExp("绝对路径：" + f.slotAbsolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "确认展示的绝对路径=夹具真实槽目录");
  assert.ok(shown.includes(STAGE_RELATIVE) && shown.includes(STAGE_GEN), "UI 与后台使用同一完整路径/完整代");
  assert.match(shown, /主机 nwpu3\.invalid（profile work） · 范围 job-artifacts-scope · 通道 0/);
  assert.equal(f.warnings[0][1].modal, true);
  const confirm = f.cleanupCalls[2].params;
  // 夹具内产品在 vm 上下文执行，其容器对象原型属另一 realm；本套件用 assert/strict
  // （deepEqual 即 deepStrictEqual），跨 realm 同结构值判不等。真实扩展单 realm 运行，
  // 产品形态本身正确——在测试侧对同一字段集合做宿主 realm 归一化后仍逐字段严格比对，
  // 不放宽语义、不减字段（JSON 往返对全字段纯数据等价）。
  const normalize = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual([confirm.token, confirm.digest, confirm.phase, confirm.confirm], ["tok-1", "dig-1", 1, true]);
  assert.deepEqual(normalize(confirm.exactTargets), [f.slotAbsolute], "确认绑定精确 token/digest/绝对路径（真实槽目录路径）");
  const execute = f.cleanupCalls[3].params;
  assert.equal(execute.token, "tok-1"); assert.equal(execute.index, 0);
  const deletion = f.cleanupCalls[5].params;
  assert.equal(deletion.token, "tok-1"); assert.equal(deletion.digest, "dig-1", "删除集合只从冻结 token/digest 派生");
  const deletionTargets = normalize(deletion.targets);
  assert.equal(deletionTargets.length, 1, "删除集合恰一个冻结目标");
  assert.equal(deletionTargets[0].index, 0);
  assert.equal(deletionTargets[0].relativePath, STAGE_RELATIVE);
  assert.equal(deletionTargets[0].destination, preview.targets[0].destination);
  assert.deepEqual(deletionTargets, [{ index: 0, relativePath: STAGE_RELATIVE, destination: preview.targets[0].destination }]);
  // 真实文件系统证据：成功隔离＝夹具真实槽目录被 renameSync 真实移走，隔离副本（含 manifest.json）真实存在。
  assert.equal(fs.existsSync(f.slotAbsolute), false, "成功证据（真实文件系统）：原槽目录已被真实 rename 移走");
  assert.equal(f.isolatedCopyPresent, true, "成功证据（真实文件系统）：隔离副本真实存在");
  assert.equal(f.isolatedCopyManifestPresent, true, "journal manifest.json 随槽目录一起进入隔离副本");
  assert.deepEqual(normalize(f.syncRetries), [{ planId: "plan", jobIndex: 0, commandId: "command0" }], "成功后只重试这一条原同步");
  assert.deepEqual(f.patches, [], "释放链自身不改 Job/产物字段；完成状态由既有同步链管理");
});

test("a dismissed confirmation mutates nothing after the read-only preview and keeps partial plus the original error", async () => {
  const f = releaseFixture({ warningChoice: undefined });
  const result = await f.run();
  assert.equal(result.status, "cancelled");
  assert.match(result.message, /未执行任何修改/);
  assert.deepEqual(f.cleanupCalls.map(row => row.method), ["files.cleanup.stagedSlots", "files.cleanup.preview"], "取消后 confirm/execute/delete 零调用");
  assert.deepEqual(f.syncRetries, [], "取消释放不触发同步重试");
});

test("new SE plus old SFTP (live capabilities missing): release refuses before any cleanup call and never guesses a path", async () => {
  const f = releaseFixture({ capabilityReady: false });
  const result = await f.run();
  assert.equal(result.status, "failed");
  assert.match(result.message, /实时 capabilities|未声明完整的受控暂存槽释放能力/);
  assert.deepEqual(f.cleanupCalls, [], "旧 SFTP 下整个受控清理协议一次都不调用，更不会猜路径");
  assert.equal(f.errorLog.length, 1, "真实原因进既有操作日志/通知反馈");
});

test("a locked, mismatched or non-candidate live slot is protected: no preview freeze and no release entry", async () => {
  const locked = releaseFixture({ liveCandidates: [{ relativePath: STAGE_RELATIVE, status: "committed", generation: STAGE_GEN, locked: true, releaseCandidate: false, protectedReason: "lock-held" }] });
  assert.equal((await locked.run()).status, "failed");
  assert.deepEqual(locked.cleanupCalls.map(row => row.method), ["files.cleanup.stagedSlots"], "被占用=protected，不提供强制释放");
  const moved = releaseFixture({ liveCandidates: [{ relativePath: ".staged-slots/" + STAGE_ID + "/slot-9", status: "committed", generation: "e".repeat(64), locked: false, releaseCandidate: true }] });
  assert.equal((await moved.run()).status, "failed", "实时候选与冻结卡点路径/完整代不一致必须停");
  assert.equal(moved.cleanupCalls.length, 1);
  const notReleasable = releaseFixture({ releaseCandidate: false });
  assert.equal((await notReleasable.run()).status, "failed");
  assert.match((await notReleasable.run()).message, /当前卡点没有可释放候选（槽被占用、非终态或时间不明），未执行任何修改。/,
    "文案契约：产品原句逐字匹配，不缩短面向用户的提示");
  assert.deepEqual(notReleasable.cleanupCalls, [], "卡点无候选时连盘点都不发起");
});

test("unknown isolation receipt or refused registered delete stops without replay and keeps the real failure", async () => {
  const unknown = releaseFixture({ warningChoice: "确认释放此暂存槽", statusStates: { 0: "unknown" } });
  const unknownResult = await unknown.run();
  assert.equal(unknownResult.status, "failed");
  assert.match(unknownResult.message, /unknown/);
  assert.equal(unknown.cleanupCalls.filter(row => row.method === "files.cleanup.execute").length, 1, "隔离结果 unknown 后不得再次发送修改");
  assert.deepEqual(unknown.cleanupCalls.filter(row => row.method === "files.cleanup.isolatedMaintenanceDelete"), []);
  assert.deepEqual(unknown.syncRetries, []);
  assert.equal(unknown.errorLog.length, 1, "unknown 停止如实进入操作日志");
  const rejected = releaseFixture({ warningChoice: "确认释放此暂存槽", deleteState: "rejected" });
  assert.equal((await rejected.run()).status, "failed", "删除登记未接受=失败，不冒充成功");
  assert.deepEqual(rejected.syncRetries, [], "删除未成功不宣称释放完成，也不触发重试粉饰");
});

test("an under-one-day leaving candidate is released only through this one explicit confirmation", async () => {
  const f = releaseFixture({ warningChoice: "确认释放此暂存槽", ageMs: 3600000 });
  assert.equal((await f.run()).status, "completed", "未满 1 天的退出候选允许经用户一次确认提前释放（自动链仍不得动它）");
  assert.equal(f.warnings.length, 1, "提前释放同样只有一次确认");
  assert.match(String(f.warnings[0][0]), /已存在 1 小时/);
});

// ——— 0.5.416 终审返修（P1-1/P1-2/P1-3）新增回归 ———

test("a preview whose backend withholds the background-delete and isolation-receipt proofs stops before any confirmation or mutation", async () => {
  // 终审 P1-2：SimpleSFTP 对自证不了支持的后端显式缺省 preview.safety 标志；缺任一即在弹确认前判掉。
  const f = releaseFixture({ warningChoice: "确认释放此暂存槽", previewSafety: false });
  const result = await f.run();
  assert.equal(result.status, "failed");
  assert.match(result.message, /未在预览中自证/);
  assert.match(result.message, /未执行任何修改/);
  assert.equal(f.warnings.length, 0, "自证缺失在确认之前判掉，绝不打一次注定失败的确认");
  assert.deepEqual(f.cleanupCalls.map(row => row.method), ["files.cleanup.stagedSlots", "files.cleanup.preview"], "预览只读；confirm/execute/删除登记零调用");
  assert.equal(fs.existsSync(f.slotAbsolute), true, "后端未自证=真实源槽目录原样存在（夹具 preview 零写入）");
  assert.deepEqual(f.syncRetries, []);
  assert.equal(f.errorLog.length, 1, "真实原因进入既有操作日志");
});

test("a stagedSlots answer without the remote expiry threshold refuses the release before preview, never an unbound one", async () => {
  const f = releaseFixture({ warningChoice: "确认释放此暂存槽", liveExpiry: null });
  const result = await f.run();
  assert.equal(result.status, "failed");
  assert.match(result.message, /journal 绑定信息不完整/);
  assert.deepEqual(f.cleanupCalls.map(row => row.method), ["files.cleanup.stagedSlots"], "缺过期阈值=fail-closed，绝不发送无 journal 绑定的释放预览");
  assert.equal(f.warnings.length, 0);
});

test("a generation-changed, resumed, freshly re-committed or journal-removed slot cannot be isolated through the full release chain and its real source directory stays present", async () => {
  // 终审 P1-1 回归：journal 在预览与 rename 之间被换代/重新占用/重新 commit/删除时，引擎锁内复检必须
  // 拒绝隔离——竞态改写的是真实 manifest.json，夹具 execute 逐条移植 verify_staged_journal_binding 读取
  // 该真实文件后同源拒绝。若产品没把绑定带到预览，夹具按发布版真实行为只剩槽锁检查、隔离照常发生——
  // 真实槽目录被移走，本用例即失败，这就是回归防护本身。
  for (const race of [
    { label: "换代", after: { generation: "e".repeat(64) } },
    { label: "非终态", after: { status: "running" } },
    { label: "刚重新 commit", after: { terminalAt: 777 } },
    { label: "台账被删", removeJournal: true },
  ]) {
    const f = releaseFixture({ warningChoice: "确认释放此暂存槽",
      onCall: (method, params, state) => {
        if (method !== "files.cleanup.execute") return;
        if (race.removeJournal) state.removeJournal();
        else state.setJournal(race.after);
      } });
    await assert.rejects(f.run(), /STAGED_JOURNAL_MISMATCH/, race.label);
    assert.equal(fs.existsSync(f.slotAbsolute), true, race.label + "：锁内复检拒绝后真实源槽目录必须原样存在，绝不被隔离");
    assert.equal(f.isolatedCopyPresent, false, race.label + "：拒绝后不得留下任何隔离副本");
    assert.equal(f.cleanupCalls.filter(row => row.method === "files.cleanup.execute").length, 1, "拒绝后不重放隔离");
    assert.deepEqual(f.cleanupCalls.filter(row => row.method === "files.cleanup.isolatedMaintenanceDelete"), [], "隔离被拒后绝不登记永久删除");
    assert.deepEqual(f.syncRetries, [], race.label + "：隔离失败不触发同步重试粉饰");
    assert.ok(f.cleanupCalls.some(row => row.method === "files.cleanup.preview" && row.params.stagedJournal),
      race.label + "：走到完整释放链路且预览确实携带了 journal 绑定");
  }
});

test("a genuinely young journal is released through the one confirmation with requireExpired false on real directories, while the frozen true/absent modes stay refused", async () => {
  // 0.2.114 解冻（占位用例翻正）：真实年轻的 committed journal（基准=一小时前，epoch 秒）携带
  // requireExpired:false 的用户确认绑定 ⇒ 引擎只免最后一条年龄阈值、其余锁内检查照跑 ⇒ 一次确认后
  // 成功，目录证据全真实；同时"缺省/true 仍被年龄规则拒"的 0.2.113 兼容路径逐模式保留（bindingMode
  // 模拟自动回收链/旧调用方形态，本产品链总是 false）。
  const ok = releaseFixture({ warningChoice: "确认释放此暂存槽", youngJournal: true, ageMs: 3600000 });
  const okResult = await ok.run();
  assert.equal(okResult.status, "completed", okResult.message);
  assert.equal(ok.warnings.length, 1, "年轻槽同样只走一次明确确认");
  const binding = ok.cleanupCalls.find(row => row.method === "files.cleanup.preview").params.stagedJournal;
  assert.equal(binding.requireExpired, false, "用户亲自确认要释放=显式 false");
  assert.equal(binding.expiryMs, 86400000, "过期阈值仍照实携带实时值，不塞 0、不缺省");
  assert.equal(fs.existsSync(ok.slotAbsolute), false, "成功证据（真实文件系统）：年轻源槽目录被真实 rename 移走");
  assert.equal(ok.isolatedCopyPresent, true, "成功证据（真实文件系统）：隔离副本真实存在");
  assert.equal(ok.isolatedCopyManifestPresent, true, "隔离副本的 manifest.json 真实存在");
  assert.equal(ok.syncRetries.length, 1, "成功后只重试这一条原同步");
  for (const mode of ["true", "absent"]) {
    const f = releaseFixture({ warningChoice: "确认释放此暂存槽", youngJournal: true, ageMs: 3600000, bindingMode: mode });
    await assert.rejects(f.run(), /STAGED_JOURNAL_MISMATCH/, mode);
    assert.equal(fs.existsSync(f.slotAbsolute), true, mode + "：requireExpired 缺省/true 保持 0.2.113 逐字节行为，年轻槽确认后仍被年龄规则拒");
    assert.equal(f.isolatedCopyPresent, false);
    assert.deepEqual(f.cleanupCalls.filter(row => row.method === "files.cleanup.isolatedMaintenanceDelete"), [], "拒绝后绝不登记永久删除");
    assert.deepEqual(f.syncRetries, []);
  }
});

test("flipping requireExpired after the preview is refused via the frozen binding digest before any rename", async () => {
  // requireExpired 进真实 digest 前置（cleanup-file-api.js:591），确认阶段改值必被 CONFIRM_REQUIRED 拒、
  // execute 只重放冻结 copy；夹具以 execute 前的冻结摘要核对模拟同一拒绝点（模拟面已在夹具头注明）。
  const f = releaseFixture({ warningChoice: "确认释放此暂存槽", youngJournal: true, ageMs: 3600000, flipAtConfirm: true });
  await assert.rejects(f.run(), /CONFIRM_REQUIRED/);
  assert.equal(fs.existsSync(f.slotAbsolute), true, "预览后翻转=与冻结摘要不符，rename 之前拒，真实目录原样存在");
  assert.equal(f.isolatedCopyPresent, false);
  assert.deepEqual(f.cleanupCalls.filter(row => row.method === "files.cleanup.isolatedMaintenanceDelete"), []);
  assert.deepEqual(f.syncRetries, []);
});

test("malformed, future or createdAt-contradicting journals stay refused under the lock even with requireExpired false", async () => {
  // 0.2.114 只允许跳过年龄阈值：绑定带 false 时这些 journal 病灶仍逐条被锁内检查拒（真实目录证据）。
  const nowS = Math.floor(Date.now() / 1000);
  for (const rule of [
    { label: "畸形时间（terminalAt 写成 null）", journalInit: { terminalAt: null } },
    { label: "未来时间戳", journalInit: { terminalAt: nowS + 3600, updatedAt: nowS + 3600 } },
    { label: "createdAt 矛盾（创建晚于终态）", journalInit: { terminalAt: nowS - 3600, createdAt: nowS + 120 } },
  ]) {
    const f = releaseFixture({ warningChoice: "确认释放此暂存槽", ageMs: 3600000, journalInit: rule.journalInit });
    await assert.rejects(f.run(), /STAGED_JOURNAL_MISMATCH/, rule.label);
    assert.equal(fs.existsSync(f.slotAbsolute), true, rule.label + "：requireExpired:false 下其余锁内检查原样保留");
    assert.equal(f.isolatedCopyPresent, false);
    assert.deepEqual(f.cleanupCalls.filter(row => row.method === "files.cleanup.isolatedMaintenanceDelete"), []);
    assert.deepEqual(f.syncRetries, []);
  }
});

test("a preview safety proof missing any one of the three flags — including the 0.2.114 user-release proof — stops before confirmation", async () => {
  for (const missing of ["backgroundIsolatedDelete", "isolationCompletionReceipt", "userConfirmedSlotRelease"]) {
    const f = releaseFixture({ warningChoice: "确认释放此暂存槽", safetyMissing: missing });
    const result = await f.run();
    assert.equal(result.status, "failed", missing);
    assert.match(result.message, /未在预览中自证/, missing);
    assert.match(result.message, /后端不支持提前释放|未执行任何修改/, missing);
    assert.equal(f.warnings.length, 0, missing + "：在弹确认之前判掉");
    assert.deepEqual(f.cleanupCalls.map(row => row.method), ["files.cleanup.stagedSlots", "files.cleanup.preview"], missing + "：confirm/execute/删除登记零调用");
    assert.equal(fs.existsSync(f.slotAbsolute), true, missing + "：真实源槽目录原样存在");
    assert.deepEqual(f.syncRetries, []);
  }
});

test("a context change during isolation polling stops the wait, registers no delete, retries no sync and reports the isolation as dispatched", async () => {
  const f = releaseFixture({ warningChoice: "确认释放此暂存槽", statusStates: { 0: "pending" },
    onCall: (method, params, state) => { if (method === "files.cleanup.status") state.breakContext(); } });
  const result = await f.run();
  assert.equal(result.status, "failed");
  assert.match(result.message, /项目或连接已变化/);
  assert.match(result.message, /隔离请求此前已发出/, "如实报告：隔离修改已发出，不谎称未做任何事");
  assert.match(result.message, /未登记永久删除、未重试产物同步/);
  assert.equal(f.cleanupCalls.filter(row => row.method === "files.cleanup.status").length, 1, "上下文变化后立即停止轮询，不再空转");
  assert.deepEqual(f.cleanupCalls.filter(row => row.method === "files.cleanup.isolatedMaintenanceDelete"), []);
  assert.deepEqual(f.syncRetries, []);
  assert.equal(f.errorLog.length, 1);
});

test("a context change after the isolation receipt keeps the proven isolation, registers no delete and reports it truthfully", async () => {
  const f = releaseFixture({ warningChoice: "确认释放此暂存槽", statusStates: { 0: "completed" },
    onCall: (method, params, state) => { if (method === "files.cleanup.status") state.breakContext(); } });
  const result = await f.run();
  assert.equal(result.status, "failed");
  assert.match(result.message, /隔离已完成/, "已证成的隔离如实报告，不谎称未做");
  assert.match(result.message, /项目或连接已变化/);
  assert.match(result.message, /未登记永久删除、未重试产物同步/);
  assert.equal(f.slotDirectoryPresent, false, "已完成的隔离不回滚（既成事实），只停下后续修改");
  assert.deepEqual(f.cleanupCalls.filter(row => row.method === "files.cleanup.isolatedMaintenanceDelete"), []);
  assert.deepEqual(f.syncRetries, []);
});

test("a context change after the delete registration skips the sync retry and reports the registered delete", async () => {
  const f = releaseFixture({ warningChoice: "确认释放此暂存槽",
    onCall: (method, params, state) => { if (method === "files.cleanup.isolatedMaintenanceDelete") state.breakContext(); } });
  const result = await f.run();
  assert.equal(result.status, "failed");
  assert.match(result.message, /并登记永久删除/, "删除登记已完成后如实报告（产品原句「…并登记永久删除；项目或连接已变化…」的字面子串）");
  assert.match(result.message, /项目或连接已变化/);
  assert.match(result.message, /未重试产物同步/);
  assert.deepEqual(f.syncRetries, [], "上下文已变不得对新上下文调用产物同步");
  assert.equal(f.errorLog.length, 1);
});
