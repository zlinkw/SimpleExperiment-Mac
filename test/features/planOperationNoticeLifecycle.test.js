const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Task ui-plan-gpu-progress-20261024 review item 3/4/5: these tests actually drive the
// notification lifecycle (begin → report → finish) through a controllable withProgress
// mock — late callbacks, fast success/failure/cancel, first-stage visibility, one
// notification per batch, and the real result-based tone — not just card hiding.
const source = fs.readFileSync(require.resolve('../../dist/extension/legacy.js'), 'utf8');
function method(first, next) {
  const start = source.indexOf('    ' + first), end = source.indexOf('    ' + next, start);
  assert.ok(start >= 0 && end > start, first);
  return source.slice(start, end);
}
function fixture() {
  const progressEntries = [], notices = [], warnings = [], logLines = [], posts = [];
  const vscode = {
    ProgressLocation: { Notification: 15 },
    window: {
      withProgress(options, callback) {
        const entry = { options, callback, reports: [], started: false };
        entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
        entry.run = async () => { entry.started = true; await callback({ report: (value) => entry.reports.push(value.message) }); entry.resolve(); };
        progressEntries.push(entry);
        return entry.promise;
      },
      showInformationMessage: async (...args) => { notices.push(args); },
      showWarningMessage: async (...args) => { warnings.push(args); },
      createOutputChannel: (name) => ({ name, appendLine: (line) => logLines.push(line), show() {}, dispose() {} }),
    },
  };
  const sandbox = {
    vscode, console, setTimeout,
    stringField: (record, key) => String((record && record[key]) || ''),
    OPERATION_NOTICE_TITLES: { runPlan: '运行 Plan', runAllPlans: '批量运行 PLAN', validatePlan: '校验 Plan（实验准备）' },
    OPERATION_NOTICE_COMMANDS: new Set(['runPlan', 'reproducePlan', 'validatePlan', 'dryRunPlan', 'runAllPlans']),
    resultStatus: (result) => (result && typeof result === 'object' ? String(result.status || '') : undefined),
  };
  vm.createContext(sandbox);
  vm.runInContext(`this.methods = { ${[
    method('operationNoticeKey(message)', 'ensureOperationLogChannel('),
    method('ensureOperationLogChannel()', 'logOperationFact('),
    method('logOperationFact(text)', 'showOperationLogFromUi('),
    method('showOperationLogFromUi()', 'beginOperationProgressNotice('),
    method('beginOperationProgressNotice(command, message)', 'reportOperationNotice(key, text)'),
    method('reportOperationNotice(key, text)', 'finishOperationProgressNotice('),
    method('finishOperationProgressNotice(', 'submissionNoticeTone(message, result)'),
    method('submissionNoticeTone(message, result)', 'submissionNoticeText(message, result)'),
    method('postUiCommandStatus(clientActionId', 'notifyLocalActionStarted('),
  ].join(',')} };`, sandbox);
  const host = { ...sandbox.methods, operationNoticeSessions: new Map(), context: { subscriptions: [] },
    localOperations: {}, planSubmissionOperationId: () => '', view: { webview: { postMessage: (row) => posts.push(row) } } };
  return { host, progressEntries, notices, warnings, logLines, posts };
}

test('late withProgress callback replays the first stage and converges on an already finished success (no dangling notification)', async () => {
  const f = fixture();
  f.host.beginOperationProgressNotice('runPlan', { clientActionId: 'c1', planFile: 'plans/a.yaml' });
  f.host.reportOperationNotice('c1', '已收到校验并提交运行，正在准备计划与插件接入规则…');
  f.host.finishOperationProgressNotice('c1', 'succeeded', '已提交。');
  assert.equal(f.progressEntries.length, 1, 'one notification per operation');
  const entry = f.progressEntries[0];
  assert.equal(entry.started, false, 'host may delay the callback');
  await entry.run();
  assert.deepEqual(entry.reports, ['已收到校验并提交运行，正在准备计划与插件接入规则…', '已提交。'], 'first stage visible via replay, then the terminal line');
  await entry.promise;
  assert.deepEqual(f.notices[0][1], '查看日志');
  assert.ok(f.logLines.some(line => line.includes('已提交。')));
});

test('fast failure and fast cancellation finish a not-yet-started notification with the warning tone', async () => {
  for (const [tone, expectWarning] of [['failed', true], ['cancelled', true]]) {
    const f = fixture();
    f.host.beginOperationProgressNotice('runPlan', { clientActionId: 'c2' });
    f.host.finishOperationProgressNotice('c2', tone, '出错了');
    await f.progressEntries[0].run();
    await f.progressEntries[0].promise;
    assert.equal(f.warnings.length, expectWarning ? 1 : 0, tone + ' uses the warning prompt');
    assert.equal(f.notices.length, 0, tone + ' must not claim success');
  }
});

test('in-order operation streams every stage live and resolves when finished', async () => {
  const f = fixture();
  f.host.beginOperationProgressNotice('validatePlan', { clientActionId: 'c3' });
  const entry = f.progressEntries[0];
  const running = entry.run();
  f.host.reportOperationNotice('c3', '正在校验计划');
  f.host.finishOperationProgressNotice('c3', 'succeeded', '校验通过');
  await running;
  assert.deepEqual(entry.reports, ['正在校验计划', '校验通过']);
  assert.equal(f.host.operationNoticeSessions.size, 0);
});

test('a host-side withProgress rejection leaves no unhandled rejection and later operations still work', async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const f = fixture();
    f.host.beginOperationProgressNotice('runPlan', { clientActionId: 'c4' });
    f.progressEntries[0].reject(new Error('host disposed'));
    f.host.finishOperationProgressNotice('c4', 'succeeded', '已完成');
    f.host.beginOperationProgressNotice('runPlan', { clientActionId: 'c5' });
    f.host.finishOperationProgressNotice('c5', 'succeeded', '又完成');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, []);
    assert.equal(f.progressEntries.length, 2);
  } finally { process.off('unhandledRejection', listener); }
});

test('a batch produces exactly one notification and child stages route into the parent session', async () => {
  const f = fixture();
  f.host.beginOperationProgressNotice('runAllPlans', { parentClientActionId: 'batch-1' });
  for (const plan of ['plans/a.yaml', 'plans/b.yaml']) f.host.reportOperationNotice('batch-1', `提交 ${plan}`);
  assert.equal(f.progressEntries.length, 1, 'per-plan submissions must not open their own notification');
  f.host.finishOperationProgressNotice('batch-1', 'succeeded', '批量完成');
  await f.progressEntries[0].run();
  assert.deepEqual(f.progressEntries[0].reports, ['提交 plans/a.yaml', '提交 plans/b.yaml', '批量完成']);
});

test('notice tone follows real result facts when no plan-submit row exists', async () => {
  const f = fixture();
  assert.equal(f.host.submissionNoticeTone({ clientActionId: 'v1' }, { status: 'failed', message: '校验失败' }), 'failed', 'a failed validation result stays failed');
  assert.equal(f.host.submissionNoticeTone({ clientActionId: 'v2' }, { status: 'cancelled' }), 'cancelled', 'a cancelled dry-run stays cancelled');
  assert.equal(f.host.submissionNoticeTone({ clientActionId: 'v3' }, { ok: false, error: '预演失败' }), 'failed');
  assert.equal(f.host.submissionNoticeTone({ clientActionId: 'v4' }, { status: 'completed' }), 'succeeded');
  assert.equal(f.host.submissionNoticeTone({ clientActionId: 'v5' }, undefined), 'succeeded', 'a plain return without a row is success');
  f.host.planSubmissionOperationId = () => 'plan-submit-x';
  f.host.localOperations['plan-submit-x'] = { status: 'failed', message: '提交失败' };
  assert.equal(f.host.submissionNoticeTone({ clientActionId: 'v6' }, { status: 'completed' }), 'failed', 'a failed submission row outranks the wrapper return');
});

test('full validation/dry-run feedback lands in the same operation log channel, out-of-scope commands stay out', async () => {
  const f = fixture();
  f.host.postUiCommandStatus('c9', 'failed', 'validatePlan', '校验失败：GPU 不足');
  f.host.postUiCommandStatus('c9', 'completed', 'dryRunPlan', '预演完成');
  f.host.postUiCommandStatus('c9', 'failed', 'fetchTmuxList', '范围外命令');
  assert.ok(f.logLines.some(line => line.includes('[c9] validatePlan failed：校验失败：GPU 不足')));
  assert.ok(f.logLines.some(line => line.includes('[c9] dryRunPlan completed：预演完成')));
  assert.ok(!f.logLines.some(line => line.includes('范围外命令')));
  assert.equal(f.posts.length, 3, 'webview routing itself is unchanged');
});

test('a validation status longer than 400 characters is preserved in full in the log', async () => {
  const f = fixture();
  const longText = '校验阶段明细：' + '检查任务状态；'.repeat(120);
  f.host.postUiCommandStatus('c10', 'failed', 'validatePlan', longText);
  assert.ok(longText.length > 400);
  assert.ok(f.logLines.some(line => line.includes(longText)), 'the operation log keeps the complete feedback, not a 400-char slice');
});

test('in-progress validation and dry-run feedback advances the live notification, not only the log', async () => {
  const f = fixture();
  f.host.beginOperationProgressNotice('validatePlan', { clientActionId: 'c11' });
  const entry = f.progressEntries[0];
  const running = entry.run();
  f.host.postUiCommandStatus('c11', 'running', 'validatePlan', '正在校验计划：检查 GPU 空闲');
  assert.deepEqual(entry.reports, ['running：正在校验计划：检查 GPU 空闲'], 'the notification body updates while validation is in flight');
  f.host.postUiCommandStatus('c11', 'failed', 'validatePlan', '校验失败：GPU 不足');
  assert.ok(entry.reports.includes('failed：校验失败：GPU 不足'), 'the failed status also advances the live notification');
  f.host.finishOperationProgressNotice('c11', 'failed', '校验失败：GPU 不足');
  await running;
  const g = fixture();
  g.host.beginOperationProgressNotice('dryRunPlan', { clientActionId: 'c12' });
  g.host.postUiCommandStatus('c12', 'running', 'dryRunPlan', '正在预演：解析计划');
  g.host.finishOperationProgressNotice('c12', 'succeeded', '预演完成');
  await g.progressEntries[0].run();
  assert.ok(g.progressEntries[0].reports.includes('running：正在预演：解析计划'), 'a late callback also replays the buffered dry-run stage');
});

test('more than eight buffered stages roll: the newest stages and the terminal line survive for a late callback', async () => {
  const f = fixture();
  f.host.beginOperationProgressNotice('runPlan', { clientActionId: 'c13' });
  for (let index = 1; index <= 12; index++) f.host.reportOperationNotice('c13', `阶段 ${index}`);
  f.host.finishOperationProgressNotice('c13', 'succeeded', '最终结果已提交');
  await f.progressEntries[0].run();
  const replayed = f.progressEntries[0].reports;
  assert.equal(replayed.length, 8, 'replay stays bounded');
  assert.equal(replayed[replayed.length - 1], '最终结果已提交', 'the terminal result is never dropped by the roll');
  assert.ok(replayed.includes('阶段 12') && replayed.includes('阶段 6'), 'the newest window of stages survives');
  assert.ok(!replayed.includes('阶段 1') && !replayed.includes('阶段 5'), 'older rolled stages rely on the full log channel instead');
});

// r4 (task ui-plan-gpu-progress-20261024 返修): the four artifact-sync commands bypass
// runActionCommand (handleMessageCore → withManualResultSync → artifactSyncFromUi), so
// their Notification must open/close inside the real withUiCommandStatus funnel. These
// cases drive that extracted method and assert one notification per operation, the real
// result-based tone (partial/failed/cancelled/remote-pending never claim success), full
// logging, and no dangling session on any exit.
function functionSource(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('unterminated function ' + name);
}
function funnelFixture() {
  const progressEntries = [], notices = [], warnings = [], errors = [], logLines = [], posts = [], launches = [];
  const vscode = {
    ProgressLocation: { Notification: 15 },
    window: {
      withProgress(options, callback) {
        const entry = { options, callback, reports: [], started: false };
        entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
        entry.run = async () => { entry.started = true; await callback({ report: (value) => entry.reports.push(value.message) }); entry.resolve(); };
        progressEntries.push(entry);
        return entry.promise;
      },
      showInformationMessage: async (...args) => { notices.push(args); },
      showWarningMessage: async (...args) => { warnings.push(args); },
      showErrorMessage: async (...args) => { errors.push(args); },
      createOutputChannel: (name) => ({ name, appendLine: (line) => logLines.push(line), show() {}, dispose() {} }),
    },
  };
  const sandbox = {
    vscode, console, setTimeout,
    stringField: (record, key) => String((record && record[key]) || ''),
    // Keep this map aligned with OPERATION_NOTICE_TITLES in the source; the source
    // registration itself is asserted below, the runtime title proves the wiring.
    OPERATION_NOTICE_TITLES: {
      runPlan: '运行 Plan', reproducePlan: '复现 Plan', validatePlan: '校验 Plan（实验准备）',
      dryRunPlan: '预演 Plan（实验准备）', runAllPlans: '批量运行 PLAN',
      retryJobArtifactSync: '重试产物同步', refreshJobArtifacts: '刷新产物状态',
      syncPendingPlanArtifacts: '同步待同步产物', syncAllResultArtifacts: '同步全部结果文件',
    },
    OPERATION_NOTICE_COMMANDS: new Set(['runPlan', 'reproducePlan', 'validatePlan', 'dryRunPlan']),
    PLAN_SUBMISSION_COMMANDS: new Set(['runPlan', 'reproducePlan']),
    localCommandReleasesAfterTrigger: () => false,
    resultSyncCommandOutcome: null, formatResultSyncReport: null,
    OperationOutcome_1: { operationOutcomeFor: () => ({}) },
    isUiCommandRemotePending: (error) => Boolean(error && error.__remotePending),
    isUiCommandCancelled: (error) => Boolean(error && error.__cancelled),
    errorMessage: (error) => String((error && error.message) || error),
    hostOperationLeaseActionLabel: (command) => command,
    actionErrorSuggestion: () => '',
    compactSensitiveText: (text) => String(text),
  };
  vm.createContext(sandbox);
  vm.runInContext(functionSource('resultSyncCommandOutcome') + '\n' + functionSource('formatResultSyncReport'), sandbox);
  vm.runInContext(`this.methods = { ${[
    method('async withUiCommandStatus(clientActionId', 'uiCommandWatchdogMs(command)'),
    method('postUiCommandStatus(clientActionId', 'notifyLocalActionStarted('),
    method('operationNoticeKey(message)', 'ensureOperationLogChannel('),
    method('ensureOperationLogChannel()', 'logOperationFact('),
    method('logOperationFact(text)', 'showOperationLogFromUi('),
    method('showOperationLogFromUi()', 'beginOperationProgressNotice('),
    method('beginOperationProgressNotice(command, message)', 'reportOperationNotice(key, text)'),
    method('reportOperationNotice(key, text)', 'finishOperationProgressNotice('),
    method('finishOperationProgressNotice(', 'submissionNoticeTone(message, result)'),
  ].join(',')} };`, sandbox);
  const host = { ...sandbox.methods, operationNoticeSessions: new Map(), context: { subscriptions: [] },
    localOperations: {}, planSubmissionOperationId: () => '', view: { webview: { postMessage: (row) => posts.push(row) } },
    beginSimpleSftpCapabilityLaunch() { if (host.throwOnLaunch) throw new Error('能力读取异常'); launches.push(1); },
    finishPlanSubmissionProgress() {}, recordActionError() {}, postState() {} };
  return { host, progressEntries, notices, warnings, errors, logLines, posts, launches };
}

test('the four artifact-sync commands open exactly one notification through the real funnel with their titles', async () => {
  const cases = [
    ['retryJobArtifactSync', '重试产物同步', { status: 'completed', message: '产物增量同步：3 个 job 已一致，0 个不在勾选范围，0 个未完成。' }],
    ['refreshJobArtifacts', '刷新产物状态', { status: 'completed', message: '产物状态核对：5 个 job 已一致。' }],
    ['syncPendingPlanArtifacts', '同步待同步产物', { included: ['plans/a.yaml'], skipped: [], missing: [], pending: [], previews: [] }],
    ['syncAllResultArtifacts', '同步全部结果文件', { status: 'completed', message: '结果文件同步完成：4/4，跳过已有 1 个。' }],
  ];
  for (const [command, title, value] of cases) {
    const f = funnelFixture();
    await f.host.withUiCommandStatus('ca-' + command, command, { clientActionId: 'ca-' + command }, async () => value);
    assert.equal(f.progressEntries.length, 1, command + ': exactly one notification per operation');
    assert.equal(f.progressEntries[0].options.title, title, command + ': Chinese title registered for the notification');
    await f.progressEntries[0].run();
    await f.progressEntries[0].promise;
    assert.ok(f.notices.some((args) => String(args[0]).includes(title)), command + ': success prompt carries the real title');
    assert.equal(f.warnings.length, 0, command + ': a verified sync must not warn');
    assert.equal(f.host.operationNoticeSessions.size, 0, command + ': no dangling session');
    assert.ok(f.logLines.some((line) => line.includes(`[ca-${command}] ${command} running：正在执行...（按钮已转圈）`)),
      command + ': the in-flight line lands in the full operation log');
    assert.ok(f.logLines.some((line) => line.includes(`[ca-${command}] ${command} completed：`)),
      command + ': the terminal line lands in the full operation log');
  }
});

test('a partial result sync closes its notification as a warning and never claims success', async () => {
  const f = funnelFixture();
  await f.host.withUiCommandStatus('ca-p', 'syncPendingPlanArtifacts', { clientActionId: 'ca-p' },
    async () => ({ included: ['plans/a.yaml'], skipped: [], missing: ['plans/b.yaml：Worker 不可用'], pending: [], previews: [] }));
  assert.equal(f.progressEntries.length, 1);
  await f.progressEntries[0].run();
  await f.progressEntries[0].promise;
  assert.equal(f.notices.length, 0, 'a partial outcome must not open the success prompt');
  assert.ok(f.warnings.some((args) => String(args[0]).includes('部分结果已更新')), 'the warning prompt reports the partial facts');
  assert.equal(f.host.operationNoticeSessions.size, 0, 'the notification closes on the partial exit');
});

test('failed, cancelled and remote-pending artifact exits close the notification with the real outcome', async () => {
  const throws = [
    [new Error('同步失败：Worker 不可用'), 'failed', '同步失败：Worker 不可用'],
    [Object.assign(new Error('已取消，未重试产物同步'), { __cancelled: true }), 'cancelled', '已取消，未重试产物同步'],
    [Object.assign(new Error('请求已发出，远端仍在处理'), { __remotePending: true }), 'submitted', '请求已发出，远端仍在处理'],
  ];
  for (const [error, status, text] of throws) {
    const f = funnelFixture();
    await f.host.withUiCommandStatus('ca-x', 'retryJobArtifactSync', { clientActionId: 'ca-x' }, async () => { throw error; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(f.progressEntries.length, 1, status + ': one notification');
    await f.progressEntries[0].run();
    assert.ok(f.warnings.some((args) => String(args[0]).includes(text)), status + ': the terminal prompt carries the real message');
    assert.ok(!f.notices.some((args) => String(args[0]).includes(text) && String(args[0]).startsWith('SimpleExperiment ')),
      status + ': the notification never claims success');
    assert.equal(f.host.operationNoticeSessions.size, 0, status + ': no dangling session');
    assert.ok(f.logLines.some((line) => line.includes(`[ca-x] retryJobArtifactSync ${status}：`)), status + ': full terminal line logged');
  }
});

test('a funnel throw before the work result still closes the opened notification', async () => {
  const f = funnelFixture();
  f.host.throwOnLaunch = true;
  await assert.rejects(f.host.withUiCommandStatus('ca-t', 'refreshJobArtifacts', { clientActionId: 'ca-t' },
    async () => ({ status: 'completed', message: '不应到达' })));
  assert.equal(f.progressEntries.length, 1, 'the notification was opened before the throw');
  await f.progressEntries[0].run();
  assert.ok(f.warnings.some((args) => String(args[0]).includes('产物同步操作异常结束')), 'the fallback terminal line closes it');
  assert.equal(f.host.operationNoticeSessions.size, 0, 'no dangling session after an unexpected throw');
});

test('out-of-scope commands keep the grey-line routing and open no notification', async () => {
  const f = funnelFixture();
  await f.host.withUiCommandStatus('ca-o', 'fetchTmuxList', { clientActionId: 'ca-o' }, async () => 'sessions ok');
  assert.equal(f.progressEntries.length, 0, 'no notification for out-of-scope commands');
  assert.equal(f.host.operationNoticeSessions.size, 0);
  assert.ok(!f.logLines.some((line) => line.includes('fetchTmuxList')), 'out-of-scope commands stay out of the operation log');
  assert.equal(f.posts.length, 2, 'the webview still receives running and completed states');
  assert.equal(f.posts[1].status, 'completed');
});

test('the four Chinese titles are registered next to the plan titles in the source', () => {
  assert.match(source, /retryJobArtifactSync: "重试产物同步"/);
  assert.match(source, /refreshJobArtifacts: "刷新产物状态"/);
  assert.match(source, /syncPendingPlanArtifacts: "同步待同步产物"/);
  assert.match(source, /syncAllResultArtifacts: "同步全部结果文件"/);
});


test('webpage messages become native info/warning/error actions with full logs and bounded repeat suppression', async () => {
  const native = [], logs = [], opened = [];
  let now = 10000;
  const sandbox = { Date: { now: () => now }, vscode: { window: Object.fromEntries(
    ['showInformationMessage', 'showWarningMessage', 'showErrorMessage'].map(name => [name, async (...args) => {
      native.push({ name, args }); return args[1];
    }])) } };
  vm.createContext(sandbox);
  vm.runInContext('this.notify = ({' + method('showNativePanelMessage(message)', 'operationNoticeKey(message)') + '}).showNativePanelMessage;', sandbox);
  const host = { webviewNoticeLastAt: new Map(), panelDocumentGeneration: 4,
    logOperationFact: text => logs.push(text), showOperationLogFromUi: () => opened.push('log'),
    openPanelAt: async section => opened.push(section) };
  const full = '隔离区删除审核账本不可用：' + '完整说明；'.repeat(130);
  sandbox.notify.call(host, { tone: 'warning', message: full });
  sandbox.notify.call(host, { tone: 'warning', message: full });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(native.length, 1, 'rapid repeated messages do not flood native notifications');
  assert.equal(native[0].name, 'showWarningMessage');
  assert.ok(native[0].args[0].includes(full), 'no 480-character webview truncation');
  assert.deepEqual(Array.from(native[0].args).slice(1), ['查看日志', '打开面板']);
  assert.deepEqual(opened, ['log']);
  assert.equal(logs.filter(text => text.includes(full)).length, 2, 'even suppressed repeats keep full evidence');
  now += 5001;
  sandbox.notify.call(host, { tone: 'warning', message: full });
  sandbox.notify.call(host, { tone: 'info', message: '信息' });
  sandbox.notify.call(host, { tone: 'error', message: '错误' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(native.map(row => row.name), ['showWarningMessage', 'showWarningMessage', 'showInformationMessage', 'showErrorMessage']);
  for (let index = 0; index < 40; index++) sandbox.notify.call(host, { message: 'message-' + index });
  assert.ok(host.webviewNoticeLastAt.size <= 32);
});

// ── r82（0.5.414）：部分提交如实呈现（413 上红）────────────────────────────────
// 现场：一 job 隔离执行被拒（四 target 全 pending、pendingNodes:[]），操作记录仍是
// status="succeeded"、error=""（r81d local_operations run-plan 记录键集无任何阻断表达），
// 用户看到"预演通过，开启调度"。修复契约：blockedCount 进入提交结果与进度文案；
// 三类如实文案（未启动+下一步 / 过期须重新预览 / 现场失败走"重新排队此 job"）有单源投影。
// r83 返修：拆开短路——进度呈现与文案投影各自独立成用例，任一红不再遮蔽其余断言的复现机会。
test('r82 red: a partial submission with isolation-paused jobs is never announced as full success and names the next step', () => {
  const Queue = require('../../dist/features/DistributedPlanQueue.js');
  const progress = Queue.distributedSubmissionProgress({ enqueued: true, localQueued: true, pendingCount: 0, blockedCount: 2, dispatchError: '' });
  assert.equal(progress.waiting, true, '存在隔离暂停 job 时操作不得落为无等待的完成态');
  assert.doesNotMatch(progress.message, /调度队列已接收；面板继续显示/, '部分提交不得沿用全量接收文案');
  assert.match(progress.message, /隔离未完成/); assert.match(progress.message, /2/);
  assert.match(progress.message, /重新审核/);
});
test('r82 red: the isolation notice states 未启动+下一步 and never claims success', () => {
  const Queue = require('../../dist/features/DistributedPlanQueue.js');
  const notice = Queue.outputIsolationNotice({ index: 3, outputIsolationBlocked: { reason: 'nwpu3：ACTIVE_TRANSFER SimpleSFTP files.cleanup.execute：[ACTIVE_TRANSFER]', stage: 'execute', code: 'ACTIVE_TRANSFER', declarationKey: 'work/j3', observedAt: '2026-10-26T03:13:15.000Z' } });
  assert.match(notice, /未启动/); assert.match(notice, /重新审核/); assert.doesNotMatch(notice, /已成功|已完成本次/);
});
test('r82 red: an expired preview token notice demands a fresh preview with exact paths', () => {
  const Queue = require('../../dist/features/DistributedPlanQueue.js');
  const expired = Queue.outputIsolationNotice({ index: 3, outputIsolationBlocked: { reason: 'PREVIEW_EXPIRED', stage: 'execute', code: 'PREVIEW_EXPIRED', declarationKey: 'work/j3', observedAt: '2026-10-26T03:13:15.000Z' } });
  assert.match(expired, /重新生成预览/); assert.match(expired, /精确路径/);
});
