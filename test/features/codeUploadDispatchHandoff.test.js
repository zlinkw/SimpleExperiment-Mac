// 代码写入／派发交接 gate：所有权、per-Worker 独立状态、阶段诊断与发送口围栏。
// 全部使用可控替身与事件顺序断言，不做计时断言、不设性能阈值。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
require('../_helpers/registerTsRequire');
const source = fs.readFileSync('src/extension/legacy.ts', 'utf8');
const tree = ts.createSourceFile('host.ts', source, ts.ScriptTarget.Latest, true);
const cls = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'RealtimeTunnelPanelProvider');
const Gate = require('../../src/features/DispatchHandoffGate.ts');
const Q = require('../../src/features/DistributedPlanQueue.ts');
const ExecutionMode = require('../../src/features/PlanExecutionMode.ts');
const ROOT = '/handoff-fixture';

// 交接 gate 的字段与成员在夹具里复用真实实现；真实扩展类内这些成员恒定存在。
const GATE_MEMBERS = ['dispatchHandoffGate', 'codeUploadTargetLeases', 'gateStateLocal', 'targetLeaseTableLocal', 'distributedTickIds',
  'codeUploadHandoffSeq', 'distributedTickSeq',
  'codeSyncTargetResults', 'dispatchHandoffTimeoutEvidence', 'distributedQueueStorageDiagnostics',
  'beginCodeUploadHandoffLocal', 'endCodeUploadHandoffLocal', 'awaitDispatchHandoffSafeLocal', 'markCodeUploadWorkerReadyLocal',
  'markCodeUploadWorkerFailedLocal', 'dispatchHandoffAllowsWorkerLocal', 'dispatchHandoffYieldsRoundLocal', 'registerDispatchHandoffsLocal',
  'advanceDispatchHandoffLocal', 'markDispatchHandoffTransmissionLocal', 'endDispatchHandoffLocal', 'endTickHandoffsLocal',
  'beginDistributedTickRecordLocal', 'beginDistributedTickLocal', 'setDistributedTickPhaseLocal', 'endDistributedTickRecordLocal',
  'recordDispatchHandoffTimeoutLocal', 'dispatchHandoffDiagnosticsLocal', 'distributedTickDiagnosticsLocal',
  'assertDispatchHandoffSendAllowedLocal', 'ensureDispatchHandoffForSendLocal', 'acquireCodeUploadTargetLeaseLocal',
  'releaseCodeUploadTargetLeaseLocal', 'markCodeSyncTargetResultLocal', 'boundedPromise',
  // R1：写目标身份只能走生产侧真链路，不能靠伪 sftpManager；这些成员必须是类里的真实实现。
  'resolveCodeUploadTargetIdentityLocal', 'dispatchTargetKeyLocal', 'noteCodeUploadTargetLocal',
  'retainCodeUploadTargetLeaseLocal', 'releaseRetainedCodeUploadTargetLeaseLocal', 'retainedCodeUploadTargetLeases',
  'pendingCodeUploadUnknownWriteLocal', 'resolveCodeUploadUnknownWriteLocal', 'verifyCodeUploadTargetQuiescentLocal',
  // 接管只用写入引擎自己的只读投影，取消也只走现有 simpleSftpApiCall 通道。
  'codeUploadTargetRowsLocal', 'codeUploadCurrentRoundTargetKeysLocal', 'cancelCodeUploadTargetWriteLocal',
  // 本轮写入边界：不带主机/路径的操作项要靠它认出本轮刚启动的上传，必须是生产本体而不是替身。
  'withCodeUploadRoundWriteLocal', 'codeUploadRoundWriteFloorLocal',
  'takeoverCodeUploadTargetLocal', 'takeoverCodeUploadTargetLockedLocal',
  'rememberUnknownCodeWriteLocal',
  // R2：“外层已返回 / 传输在途 / 本机可靠移交”是三件事，必须用真实方法区分。
  'markDispatchHandoffTransportSettledLocal', 'observeDispatchHandoffTransportLocal', 'markDispatchHandoffAwaitingEvidenceLocal',
  'releaseDispatchHandoffsOnObservationLocal', 'commitDispatchHandoffLocal'];
function gateHost(globals = {}, extraMembers = []) {
  const wanted = [...GATE_MEMBERS, ...extraMembers];
  const picked = wanted.filter(name => cls.members.some(node => node.name?.getText(tree) === name));
  assert.equal(picked.length, wanted.length, 'every handoff member must exist in the real class');
  const code = 'class Host {' + cls.members.filter(node => picked.includes(node.name?.getText(tree))).map(node => node.getText(tree)).join('\n') + '}; Host;';
  const Ctor = vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { DispatchHandoffGate: Gate, workspaceRoot: () => ROOT, errorMessage: error => error?.message || String(error), setInterval, clearInterval, ...globals });
  return new Ctor();
}
const target = (id, remotePath, host = 'worker.example', port = 22) => ({ id, role: 'worker', label: id, host, port, remotePath });
// R1 身份宿主：只注入目标清单与真实身份模块，sftpServerOptions / sshTransportIdentity 本身从类里切出来。
function identityHost(targets, globals = {}) {
  const h = gateHost({ SshTransportIdentity_1: require('../../dist/tunnel/SshTransportIdentity.js'), ...globals },
    ['sftpServerOptions', 'sshTransportIdentity']);
  // 目标清单与 SimpleSFTP 入口在生产里是实例成员，夹具同样挂在实例上，不伪装成全局变量。
  h.sftpSharedTargets = () => targets;
  return h;
}

test('a code write intent is registered synchronously and releases one Worker at a time', async () => {
  const h = gateHost();
  const intent = h.beginCodeUploadHandoffLocal(ROOT, 'run', ['w1', 'w2']);
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w1'), false, 'registered target must not accept a new dispatch');
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'other'), true, 'an unrelated Worker is never falsely locked');
  assert.equal(h.dispatchHandoffYieldsRoundLocal(ROOT, ['w1', 'w2']), true);
  h.markCodeUploadWorkerReadyLocal(intent, ROOT, 'w1');
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w1'), true, 'a Worker confirmed written in this round dispatches again');
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w2'), false, 'a Worker still uploading must not be released');
  assert.equal(h.dispatchHandoffYieldsRoundLocal(ROOT, ['w1', 'w2']), false, 'one released Worker is enough to keep the round alive');
  const snapshot = h.dispatchHandoffDiagnosticsLocal();
  assert.deepEqual(snapshot.workerUploads.map(row => [row.workerId, row.state]).sort(), [['w1', 'uploaded'], ['w2', 'uploading']]);
  h.endCodeUploadHandoffLocal(intent.uploadId);
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w2'), true);
});

test('handoff ownership survives the wait budget and only real evidence releases it', async () => {
  const h = gateHost();
  const intent = h.beginCodeUploadHandoffLocal(ROOT, 'run', ['w1']);
  h.registerDispatchHandoffsLocal({ tickId: 'tick-1', generation: 3, root: ROOT, projectId: 'p',
    dispatches: [{ workerId: 'w1', planId: 'plan', planFile: 'p.yaml', jobIndex: 0, commandId: 'cmd-1', attempt: 0 }] });
  const blocked = await h.awaitDispatchHandoffSafeLocal(intent, 20);
  assert.equal(blocked.safe, false, 'an open handoff is never reported safe');
  assert.equal(blocked.timedOut, true);
  assert.equal(blocked.blocking.length, 1);
  assert.equal(blocked.blocking[0].commandId, 'cmd-1');
  assert.equal(h.dispatchHandoffDiagnosticsLocal().activeHandoffCount, 1, 'the wait timeout must not release ownership');
  // 已开始发送的所有权只能由真实提交或明确未发送证据解除。
  h.advanceDispatchHandoffLocal(ROOT, 'cmd-1', 'code-proof-prepare');
  h.markDispatchHandoffTransmissionLocal(ROOT, 'cmd-1');
  assert.equal(h.dispatchHandoffDiagnosticsLocal().activeHandoffs[0].sent, true);
  h.endDispatchHandoffLocal(ROOT, 'cmd-1', 'committed');
  const released = await h.awaitDispatchHandoffSafeLocal(intent, 20);
  assert.equal(released.safe, true, 'a committed receipt handoff opens the gate');
  assert.equal(h.dispatchHandoffDiagnosticsLocal().recentHandoffs[0].outcome, 'committed');
  // 旧轮迟到续体受原身份/代际围栏：已结束的旧 command 不会被迟到的发送标记重新拉起，
  // 也不会改写新一轮的登记。
  h.beginDistributedTickLocal('tick-new', ROOT, 4);
  h.registerDispatchHandoffsLocal({ tickId: 'tick-new', generation: 4, root: ROOT, projectId: 'p',
    dispatches: [{ workerId: 'w1', planId: 'plan', jobIndex: 0, commandId: 'cmd-new' }] });
  h.markDispatchHandoffTransmissionLocal(ROOT, 'cmd-1');
  const after = h.dispatchHandoffDiagnosticsLocal();
  assert.deepEqual(after.activeHandoffs.map(row => [row.commandId, row.tickId, row.generation]), [['cmd-new', 'tick-new', 4]]);
  assert.equal(after.activeHandoffs[0].sent, false, 'a late old-round marker cannot claim the new round already sent');
  h.endTickHandoffsLocal('tick-new', 'round-ended');
  h.endCodeUploadHandoffLocal(intent.uploadId);
});

test('unsent admission evidence and stale rounds are recorded truthfully, never as committed', async () => {
  const h = gateHost();
  h.registerDispatchHandoffsLocal({ tickId: 'tick-9', generation: 7, root: ROOT, projectId: 'p',
    dispatches: [{ workerId: 'w1', planId: 'plan', jobIndex: 0, commandId: 'cmd-unsent' }, { workerId: 'w2', planId: 'plan', jobIndex: 1, commandId: 'cmd-stale' }] });
  assert.equal(h.endDispatchHandoffLocal(ROOT, 'cmd-unsent', 'unsent-released'), true);
  assert.equal(h.endTickHandoffsLocal('tick-9', 'stale-generation'), 1);
  const recent = h.dispatchHandoffDiagnosticsLocal().recentHandoffs.map(row => [row.commandId, row.outcome, row.sent]);
  assert.deepEqual(recent, [['cmd-stale', 'stale-generation', false], ['cmd-unsent', 'unsent-released', false]]);
  assert.ok(!recent.some(row => row[1] === 'committed'), 'neither a stale round nor an unsent rollback may be recorded as committed');
});

test('an unknown-failed Worker keeps its ownership through later successes and later rounds', async () => {
  const h = gateHost();
  const first = h.beginCodeUploadHandoffLocal(ROOT, 'workers', ['w1', 'w2']);
  h.markCodeUploadWorkerReadyLocal(first, ROOT, 'w2');
  h.markCodeUploadWorkerFailedLocal(first, ROOT, 'w1', 'connection reset');
  h.endCodeUploadHandoffLocal(first.uploadId);
  const kept = h.dispatchHandoffDiagnosticsLocal().workerUploads;
  assert.deepEqual(kept.filter(row => row.workerId === 'w1').map(row => row.state), ['unknown-failed'],
    'another Worker success or the round end must not wash an unknown write into ready');
  const second = h.beginCodeUploadHandoffLocal(ROOT, 'workers', ['w1']);
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w1'), false);
  h.markCodeUploadWorkerReadyLocal(second, ROOT, 'w1');
  assert.equal(h.dispatchHandoffDiagnosticsLocal().workerUploads.find(row => row.workerId === 'w1').state, 'uploaded');
  h.endCodeUploadHandoffLocal(second.uploadId);
});

test('the same real write target is exclusive even across different Worker ids, different targets stay free', async () => {
  const targets = [target('a', '/work/proj/', 'Box.Example'), target('b', '/work/proj', 'box.example'),
    target('c', '/work/proj', 'other.example'), target('d', '/work/PROJ', 'box.example'), target('e', '/work/proj', 'box.example', 2222)];
  const h = identityHost(targets);
  const first = await h.acquireCodeUploadTargetLeaseLocal(targets[0], 'sync-1');
  let secondDone = false;
  const second = h.acquireCodeUploadTargetLeaseLocal(targets[1], 'sync-2').then(token => { secondDone = true; return token; });
  await new Promise(setImmediate);
  assert.equal(secondDone, false, 'Worker ids pointing at the same canonical server and root must not overlap');
  const other = await h.acquireCodeUploadTargetLeaseLocal(targets[2], 'sync-3');
  assert.equal(first.key, 'box.example:22:/work/proj');
  assert.notEqual(other.key, first.key);
  h.releaseCodeUploadTargetLeaseLocal(first.token);
  const released = await second;
  assert.equal(released.key, first.key);
  // 大小写：主机不区分，POSIX root 区分；不同大小写的 root 不得归并成同一把锁。
  const caseSplit = await h.acquireCodeUploadTargetLeaseLocal(targets[3], 'sync-4');
  assert.notEqual(caseSplit.key, first.key, 'POSIX 路径大小写区分，root 不得强行小写');
  // 端口差异就是不同的实际写目标，不能归并成同一把锁把跳服务器并行打成串行。
  const portSplit = await h.acquireCodeUploadTargetLeaseLocal(targets[4], 'sync-5');
  assert.notEqual(portSplit.key, first.key, '同一主机不同端口不是同一个写入目标');
  h.releaseCodeUploadTargetLeaseLocal(released.token);
  h.releaseCodeUploadTargetLeaseLocal(other.token);
  h.releaseCodeUploadTargetLeaseLocal(caseSplit.token);
  h.releaseCodeUploadTargetLeaseLocal(portSplit.token);
});

test('an unresolvable write target fails clearly instead of falling back to a placeholder identity', async () => {
  const h = identityHost([{ id: 'x', role: 'worker', label: '跳板 X', remotePath: '/work/proj' }]);
  await assert.rejects(() => h.acquireCodeUploadTargetLeaseLocal({ id: 'x', role: 'worker', label: '跳板 X', remotePath: '/work/proj' }, 'sync-1'),
    /缺少服务器地址/);
  let failure;
  try { await h.acquireCodeUploadTargetLeaseLocal({ id: 'x', role: 'worker', label: '跳板 X', host: 'h.example' }, 'sync-2'); }
  catch (error) { failure = error; }
  assert.match(String(failure?.message || failure), /缺少远端项目根/, '没有实际 root 就不能归并到同一把写锁');
  assert.equal(h.targetLeaseTableLocal().held.size, 0, '解析失败不得留下占位租约');
  // 身份解不出来时派发侧只按原 Worker ID 规则判定，不编造目标键。
  assert.equal(h.dispatchTargetKeyLocal('x'), '');
});

test('transfer, verification and proof are recorded separately and never escalated across stages', async () => {
  const h = gateHost();
  const fresh = h.markCodeSyncTargetResultLocal(target('w3', '/work/proj'), 'sync-0', { proof: 'done' });
  assert.equal(fresh.proof, 'pending', 'proof cannot be marked ready before the transfer stage is confirmed');
  assert.equal(fresh.ready, false);
  const row = h.markCodeSyncTargetResultLocal(target('w1', '/work/proj'), 'sync-1', { transfer: 'done' });
  assert.equal(row.ready, false);
  const verified = h.markCodeSyncTargetResultLocal(target('w1', '/work/proj'), 'sync-1', { transfer: 'done', verified: 'done', proof: 'done' });
  assert.equal(verified.ready, true, 'ready only after transport, verification and proof are all done');
  const failed = h.markCodeSyncTargetResultLocal(target('w2', '/work/proj'), 'sync-1', { transfer: 'unknown-failed', error: 'unknown write result' });
  assert.equal(failed.transfer, 'unknown-failed');
  assert.equal(h.markCodeSyncTargetResultLocal(target('w2', '/work/proj'), 'sync-1', { verified: 'done' }).transfer, 'unknown-failed',
    'a later stage must not overwrite an unknown write');
});

test('wait timeout evidence lands on the persistable channel and late old rounds cannot impersonate the new one', async () => {
  const recorded = [];
  const h = gateHost({ });
  h.recordActionError = row => recorded.push(row);
  h.postState = () => {};
  h.distributedQueueStorageDiagnostics = { status: 'stale', reason: 'queue-commit-failed', message: 'disk busy' };
  h.beginDistributedTickLocal('tick-old', ROOT, 1);
  h.setDistributedTickPhaseLocal('tick-old', 'dispatch-admission', { workerId: 'w1', commandId: 'cmd-1', sent: true });
  const intent = h.beginCodeUploadHandoffLocal(ROOT, 'run', ['w1']);
  h.registerDispatchHandoffsLocal({ tickId: 'tick-old', generation: 1, root: ROOT, projectId: 'p',
    dispatches: [{ workerId: 'w1', planId: 'plan', planFile: 'p.yaml', jobIndex: 2, commandId: 'cmd-1' }] });
  h.markDispatchHandoffTransmissionLocal(ROOT, 'cmd-1');
  const wait = await h.awaitDispatchHandoffSafeLocal(intent, 10);
  const message = h.recordDispatchHandoffTimeoutLocal('codeSyncTargets', intent, wait);
  assert.match(message, /^原派发尚未确认结束，代码同步未写入；请刷新任务状态后重试。/);
  assert.match(message, /dispatch-admission/);
  assert.match(message, /已发送/);
  assert.match(message, /queue-commit-failed/);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].command, 'codeUploadDispatchHandoff');
  assert.equal(h.dispatchHandoffTimeoutEvidence.blocking[0].commandId, 'cmd-1');
  // 新一轮开始：旧轮迟到写入只影响旧记录，不覆写当前阶段与结局。
  h.endDistributedTickRecordLocal('tick-old', 'completed');
  h.beginDistributedTickLocal('tick-new', ROOT, 2);
  h.setDistributedTickPhaseLocal('tick-new', 'probe-tunnel');
  h.setDistributedTickPhaseLocal('tick-old', 'late-old-write');
  const current = h.distributedTickDiagnosticsLocal().ticks.find(row => row.tickId === 'tick-new');
  assert.equal(current.phase, 'probe-tunnel');
  assert.equal(h.distributedTickDiagnosticsLocal().ticks.length, 1, '有界近期项：旧轮只保留成一条结局，不会被迟到续体改写');
  const oldRound = h.distributedTickDiagnosticsLocal().recent.find(row => row.tickId === 'tick-old');
  assert.equal(oldRound.outcome, 'completed');
  assert.equal(oldRound.phase, 'dispatch-admission');
  h.endCodeUploadHandoffLocal(intent.uploadId);
});

test('the final send boundary re-checks the gate and refuses a send without posting', async () => {
  const posted = [];
  const h = gateHost({ workspaceRoot: () => ROOT, DistributedPlanQueue: Q, PlanExecutionMode: ExecutionMode,
    PlanCodeScopeHost: { supportsPlanCodeScope: () => true, verifyWorkerPlanSource: async () => ({ executionSource: 'proof' }) },
    DistributedSchedulingPolicy: require('../../src/features/DistributedSchedulingPolicy.ts'), errorMessage: error => error.message,
    AgentTmuxPolicy_1: { normalizeRemoteTmuxSessionPrefix: value => value }, vscode: { workspace: { getConfiguration: () => ({ get: () => 'mine' }) } },
    GpuQuotaScheduling: require('../../dist/features/GpuQuotaScheduling') },
    ['sendDistributedJob', 'releaseUnsentDistributedJob']);
  const projectId = Q.canonicalProjectId(ROOT);
  const plan = { id: 'p', projectId, revision: 'r', planFile: 'p.yaml', resultPathPolicy: 'declared', executionMode: 'train_test', codeFingerprint: 'code', jobs: [] };
  const job = { index: 0, attempt: 0, outputDir: 'work/a', lifecycleProtocol: 2, status: 'dispatching', workerId: 'w', gpuId: '0', commandId: 'cmd-1' };
  plan.jobs = [job];
  let settlePost = { resolve: () => ({}), reject: () => {} };
  Object.assign(h, { client: { postWorkerAction: () => new Promise((resolve, reject) => { posted.push(1); settlePost = { resolve, reject }; }) },
    taskLifecycleProtocol: 2, distributedQueueGeneration: 0, distributedPlanStopEpoch: 0, unifiedDomainState: () => ({ active: false, blocked: '' }),
    lastWorkerProbes: { w: { capabilities: { endpoints: { declaredJobPaths: true, formalJobIdentityEnv: 1, gpuQuotaScheduling: 1, gpuMemoryBudgetScheduling: 1, taskShellEnvironment: 1, projectManagedValidation: 1 } } } },
    submissionWorkerProbes: async () => h.lastWorkerProbes, workerActionTargets: () => [{ id: 'w' }], enabledWorkerConfigs: () => [],
    schedulerSettings: () => ({}), lastWorkerTaskSnapshots: new Map([[`${ROOT}\u0000w`, { capabilities: { taskLifecycle: 2 } }]]),
    lastCodeSyncState: {}, postState() {}, recordActionError() {}, loadDistributedQueue: async () => ({ plans: [] }) });
  const intent = h.beginCodeUploadHandoffLocal(ROOT, 'run', ['w']);
  let failure;
  try { await h.sendDistributedJob(plan, job, 'w', '0', 'cmd-1'); } catch (error) { failure = error; }
  assert.equal(posted.length, 0, 'a pending code write must not be raced by a send');
  assert.equal(failure?.dispatchNotSent, true, 'the refusal is provable not-sent evidence, so the durable intent can be rolled back');
  assert.match(failure.message, /代码写入尚未交接完成/);
  assert.equal(h.dispatchHandoffDiagnosticsLocal().activeHandoffCount, 0, 'a refused channel send releases the ownership it took');
  h.markCodeUploadWorkerReadyLocal(intent, ROOT, 'w');
  const receipt = await h.sendDistributedJob(plan, job, 'w', '0', 'cmd-1');
  assert.equal(posted.length, 1);
  assert.equal(receipt.lifecycleProtocol, 2);
  const inFlight = h.dispatchHandoffDiagnosticsLocal();
  assert.equal(inFlight.activeHandoffCount, 1, '外层发送已返回不等于送达：fire-and-forget 在途登记必须保留');
  assert.equal(inFlight.activeHandoffs[0].sent, true);
  assert.equal(inFlight.activeHandoffs[0].transportSettled, false, '传输 promise 还没落定，不能记成已落定');
  assert.match(inFlight.activeHandoffs[0].awaitingEvidence, /transport-in-flight/);
  const inFlightTick = inFlight.activeHandoffs[0].tickId;
  // 整轮结束、换代、“外层已返回”都不是释放证据。
  assert.equal(h.endTickHandoffsLocal(inFlightTick, 'round-ended'), 0, 'round end cannot wash an in-flight transport');
  assert.equal(h.dispatchHandoffDiagnosticsLocal().activeHandoffCount, 1);
  assert.match(h.dispatchHandoffDiagnosticsLocal().activeHandoffs[0].awaitingEvidence, /deferred-transport-in-flight$/);
  // 传输落定前，完整查询也不能当释放证据。
  assert.equal(h.releaseDispatchHandoffsOnObservationLocal(ROOT, 'w', { queryComplete: true, tasks: [] }), 0);
  settlePost.resolve({ lifecycleProtocol: 2, status: 'unknown' });
  await new Promise(setImmediate);
  const settled = h.dispatchHandoffDiagnosticsLocal().activeHandoffs[0];
  assert.equal(settled.transportSettled, true, '传输自己落定是另一个事实，只能由传输的 promise 记录');
  assert.equal(settled.transportOutcome, 'ok');
  // 不完整/报错的查询不算证据。
  assert.equal(h.releaseDispatchHandoffsOnObservationLocal(ROOT, 'w', { queryComplete: false, tasks: [] }), 0);
  assert.equal(h.releaseDispatchHandoffsOnObservationLocal(ROOT, 'w', { queryComplete: true, error: 'timeout', tasks: [] }), 0);
  assert.equal(h.dispatchHandoffDiagnosticsLocal().activeHandoffCount, 1);
  // 精确查询（完整、无错）才是释放证据。
  assert.equal(h.releaseDispatchHandoffsOnObservationLocal(ROOT, 'w', { queryComplete: true, tasks: [{ commandId: 'cmd-1' }] }), 1);
  assert.equal(h.dispatchHandoffDiagnosticsLocal().activeHandoffCount, 0);
  assert.equal(h.dispatchHandoffDiagnosticsLocal().recentHandoffs[0].outcome, 'transport-handed-off');
  h.endCodeUploadHandoffLocal(intent.uploadId);
});

test('committed is only recorded on a reliable local handoff, failed commits keep ownership', async () => {
  const h = gateHost();
  h.registerDispatchHandoffsLocal({ tickId: 'tick-c', generation: 5, root: ROOT, projectId: 'p',
    dispatches: [{ workerId: 'w1', planId: 'plan', jobIndex: 0, commandId: 'cmd-a' }, { workerId: 'w2', planId: 'plan', jobIndex: 1, commandId: 'cmd-b' }] });
  h.advanceDispatchHandoffLocal(ROOT, 'cmd-a', 'code-proof-prepare');
  h.markDispatchHandoffTransmissionLocal(ROOT, 'cmd-a');
  h.markDispatchHandoffTransportSettledLocal(ROOT, 'cmd-a', 'ok');
  // 本机落盘真的成功：这才是可靠移交。
  assert.equal(h.commitDispatchHandoffLocal(ROOT, 'cmd-a'), true);
  const committed = h.dispatchHandoffDiagnosticsLocal().recentHandoffs[0];
  assert.deepEqual([committed.commandId, committed.outcome, committed.sent], ['cmd-a', 'committed', true]);
  // 回执提交失败：只标注在等什么证据，既不记 committed 也不删所有权。
  h.markDispatchHandoffTransmissionLocal(ROOT, 'cmd-b');
  h.markDispatchHandoffAwaitingEvidenceLocal(ROOT, 'cmd-b', 'receipt-commit-failed');
  const held = h.dispatchHandoffDiagnosticsLocal().activeHandoffs.find(row => row.commandId === 'cmd-b');
  assert.equal(held.awaitingEvidence, 'receipt-commit-failed');
  assert.equal(h.dispatchHandoffDiagnosticsLocal().recentHandoffs.some(row => row.commandId === 'cmd-b'), false,
    'a failed receipt commit must never be recorded as committed or unsent-released');
  // 明确未发送但退回也没落盘：同样不能记成 unsent-released。
  h.registerDispatchHandoffsLocal({ tickId: 'tick-c', generation: 5, root: ROOT, projectId: 'p',
    dispatches: [{ workerId: 'w3', planId: 'plan', jobIndex: 2, commandId: 'cmd-c' }] });
  h.markDispatchHandoffAwaitingEvidenceLocal(ROOT, 'cmd-c', 'unsent-rollback-incomplete');
  assert.equal(h.dispatchHandoffDiagnosticsLocal().activeHandoffs.some(row => row.commandId === 'cmd-c'), true);
  assert.equal(h.dispatchHandoffDiagnosticsLocal().recentHandoffs.some(row => row.commandId === 'cmd-c'), false);
  // 从未发送且安全退回已落盘：按 unsent-released 回收，不伪装成 committed。
  assert.equal(h.endDispatchHandoffLocal(ROOT, 'cmd-c', 'unsent-released'), true);
  assert.equal(h.dispatchHandoffDiagnosticsLocal().recentHandoffs[0].outcome, 'unsent-released');
  h.endTickHandoffsLocal('tick-c', 'round-ended');
});

test('已发送且传输已落定但未提交时，换代与整轮结束都不得删掉所有权', async () => {
  const h = gateHost();
  h.registerDispatchHandoffsLocal({ tickId: 'tick-r2', generation: 7, root: ROOT, projectId: 'p',
    dispatches: [{ workerId: 'w1', planId: 'plan', jobIndex: 0, commandId: 'cmd-x' }] });
  h.advanceDispatchHandoffLocal(ROOT, 'cmd-x', 'transmission');
  h.markDispatchHandoffTransmissionLocal(ROOT, 'cmd-x');
  // 真实入口：传输自己的 promise 落定（失败也是落定），不是外层函数返回。
  h.observeDispatchHandoffTransportLocal(ROOT, 'cmd-x', Promise.reject(new Error('连接被重置')));
  await new Promise(setImmediate);
  const settled = h.dispatchHandoffDiagnosticsLocal().activeHandoffs[0];
  assert.equal(settled.transportSettled, true, '传输失败落定也是落定');
  assert.equal(settled.transportOutcome, 'failed');
  // 复审核对的那条路径：已发送 + 传输落定 + 未提交 + 未查询，此时换代/整轮结束都不得洗掉所有权。
  assert.equal(h.endTickHandoffsLocal('tick-r2', 'stale-generation'), 0, '换代不是释放证据');
  assert.equal(h.dispatchHandoffDiagnosticsLocal().activeHandoffCount, 1, '传输落定不等于本机状态已移交');
  assert.equal(h.endTickHandoffsLocal('tick-r2', 'round-ended'), 0, '整轮结束同样不得删掉未提交的已发送登记');
  const held = h.dispatchHandoffDiagnosticsLocal().activeHandoffs[0];
  assert.equal(held.transportSettled, true);
  assert.match(held.awaitingEvidence, /deferred-awaiting-commit-or-query$/);
  assert.equal(h.dispatchHandoffDiagnosticsLocal().recentHandoffs.some(row => row.commandId === 'cmd-x'), false,
    '不能被记成 stale-generation / round-ended 之类“已结束”结局');
  // 没拿到证据前，代码写入必须继续让路。
  const intent = h.beginCodeUploadHandoffLocal(ROOT, 'run', ['w1']);
  const wait = await h.awaitDispatchHandoffSafeLocal(intent, 10);
  assert.equal(wait.safe, false, '未拿到移交或查询证据前，代码写入不得接管该目标');
  assert.equal(wait.blocking[0].commandId, 'cmd-x');
  assert.equal(wait.blocking[0].transportSettled, true);
  // 本机可靠移交仍可释放（这里用新一代登记走同一个入口验证）。
  assert.equal(h.releaseDispatchHandoffsOnObservationLocal(ROOT, 'w1', { queryComplete: true, tasks: [] }), 1,
    '完整无错查询确认未到达也是有效证据');
  assert.equal(h.dispatchHandoffDiagnosticsLocal().activeHandoffCount, 0);
  assert.equal(h.dispatchHandoffDiagnosticsLocal().recentHandoffs[0].outcome, 'transport-not-observed');
  h.endCodeUploadHandoffLocal(intent.uploadId);
});

test('the dispatch round re-reads the intent before allocating and registers ownership before the durable admission', () => {
  const tick = source.slice(source.indexOf('async tickDistributedQueueCore('), source.indexOf('async function dispatchReadyManualJobs'));
  assert.ok(tick.length > 1000);
  const yields = tick.indexOf('dispatchHandoffYieldsRoundLocal');
  const realloc = tick.indexOf('const dispatchableWorkers = workers.filter');
  const allocate = tick.indexOf('allocateAvailable(queue, dispatchableWorkers');
  const register = tick.indexOf('registerDispatchHandoffsLocal?.({ tickId, generation, root, projectId, dispatches })');
  const admission = tick.indexOf('{ queueGeneration: generation, dispatchAdmission: true }');
  assert.ok(yields > 0 && yields < allocate, 'the round must yield while every candidate is still blocked');
  assert.ok(realloc > 0 && realloc < allocate, 'the intent must be re-read before any new intent is allocated');
  assert.ok(register > 0 && register < admission, 'ownership starts before the admission intent is persisted');
  const legacyAllocate = tick.indexOf('allocateAvailable(queue, dispatchableLegacyWorkers)');
  const legacyRegister = tick.indexOf('dispatches: allocation.dispatches }');
  const legacyAdmission = tick.indexOf('legacyAdmissionReceipt = await this.saveDistributedQueue');
  assert.ok(legacyAllocate > 0 && legacyRegister > 0 && legacyRegister < legacyAdmission, 'the legacy channel is covered the same way');
  assert.ok(tick.indexOf('dispatchableLegacyWorkers') < legacyAllocate);
  // 回执提交完成才解除所有权；整轮结束与换代都按真实结局回收。
  assert.ok(tick.indexOf('endDispatchHandoffLocal?.(root, dispatch.commandId') > tick.indexOf('try { await receiptCommits; }'));
  const wrapper = source.slice(source.indexOf('async tickDistributedQueue() {'), source.indexOf('async tickDistributedQueueCore('));
  assert.ok(wrapper.includes('endTickHandoffsLocal?.(tickId'), 'the tick lifecycle reclaims uncommitted handoffs with the real outcome');
  assert.ok(wrapper.includes('endDistributedTickRecordLocal?.(tickId'), 'the tick ledger records its end/failure/invalidation');
  const detachStart = source.indexOf('\n    detachStaleDistributedTick(task) {');
  const detach = source.slice(detachStart, source.indexOf('requestDistributedQueueRefresh()', detachStart));
  assert.ok(detach.length > 200 && detach.includes('endTickHandoffsLocal?.(detachedTickId'), 'a fenced-out round cannot keep holding the code write gate');
});

test('the send fence sits directly on the transport boundary for both transports', () => {
  const send = source.slice(source.indexOf('async sendDistributedJob('), source.indexOf('async releaseUnsentDistributedJob('));
  const fences = [...send.matchAll(/assertDispatchHandoffSendAllowedLocal\?\.\(root, workerId\);/g)].map(row => row.index);
  const transmissions = [...send.matchAll(/transmissionStarted = true;/g)].map(row => row.index);
  const marks = [...send.matchAll(/markDispatchHandoffTransmissionLocal\?\.\(root, commandId\);/g)].map(row => row.index);
  assert.equal(fences.length, 2, 'both the legacy lease transport and the protocol-2 direct post re-check the gate');
  assert.equal(transmissions.length, 2);
  assert.equal(marks.length, 2);
  for (let index = 0; index < 2; index += 1) {
    assert.ok(fences[index] < transmissions[index], 'the re-check must happen before the transport boundary');
    assert.ok(marks[index] > transmissions[index], 'the transmission marker follows the real boundary');
  }
  assert.match(send, /finally \{\s*if \(channelHandoffRoot\)/, 'a channel-owned handoff is reclaimed by the sender itself');
});

test('the code upload waits on the handoff gate instead of the whole dispatch round', () => {
  const sync = source.slice(source.indexOf('async syncCodeTargets(targets, scope, options = {})'), source.indexOf('async safeWorkerCodeSyncTargets('));
  assert.ok(!/this\.distributedQueueTickPromise/.test(sync), 'the whole-tick promise is not a safety proof');
  assert.ok(!/distributedQueueWritePromise/.test(sync));
  const registered = sync.indexOf('this.beginCodeUploadHandoffLocal?.');
  assert.ok(registered > 0 && registered < sync.indexOf('await this.boundedPromise'), 'the intent is registered before the first await');
  assert.ok(registered < sync.indexOf('ensureSftpManagerCommand'), 'probe/tunnel waits cannot delay the intent');
  const readyCallbacks = (sync.match(/await options\.onTargetReady\?\./g) || []).length;
  assert.ok(readyCallbacks > 0);
  assert.equal((sync.match(/markCodeUploadWorkerReadyLocal\?\./g) || []).length, readyCallbacks, 'every ready callback marks its own Worker, including the no-upload path');
  assert.match(sync, /awaitDispatchHandoffSafeLocal\?\.\(codeUploadHandoff, 10_000\)/, 'the wait budget stays 10_000 with handoff semantics');
  const released = sync.indexOf('this.endCodeUploadHandoffLocal?.(codeUploadHandoff?.uploadId)');
  assert.ok(released > sync.indexOf('} finally {'), 'the intent is released in the finally block');
  assert.match(sync, /this\.codeSyncInFlight--;\s*\}/);
});

test('别名 Worker 指向同一实际写目标时，不能被另一个 Worker 的完成放行', async () => {
  const targets = [target('w-a', '/work/proj', 'same.example'), target('w-b', '/work/proj/', 'SAME.example')];
  const h = identityHost(targets);
  assert.equal(h.dispatchTargetKeyLocal('w-a'), h.dispatchTargetKeyLocal('w-b'), '别名必须归并到同一实际写目标');
  const intent = h.beginCodeUploadHandoffLocal(ROOT, 'workers', ['w-a', 'w-b']);
  // 与生产新顺序一致：每个目标在等写租约之前就先登记实际目标键，
  // 因此排队中的别名从一开始就能参与判定（真实入口的行为覆盖在 codeUploadParallelBranches）。
  h.noteCodeUploadTargetLocal(intent, ROOT, 'w-a', h.dispatchTargetKeyLocal('w-a'));
  h.noteCodeUploadTargetLocal(intent, ROOT, 'w-b', h.dispatchTargetKeyLocal('w-b'));
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w-a'), false);
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w-b'), false, '未写入的别名同样不得接新派发');
  assert.equal(h.dispatchHandoffYieldsRoundLocal(ROOT, ['w-a', 'w-b']), true);
  h.markCodeUploadWorkerReadyLocal(intent, ROOT, 'w-a', h.dispatchTargetKeyLocal('w-a'));
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w-a'), false, '同一实际目标上仍有未确认完成的写入时不得放行');
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w-b'), false);
  h.markCodeUploadWorkerReadyLocal(intent, ROOT, 'w-b', h.dispatchTargetKeyLocal('w-b'));
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w-a'), true, '共享目标本轮写入全部确认完成后才恢复派发');
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w-b'), true);
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'unrelated'), true, '不同实际目标不被别名判定误锁');
  h.endCodeUploadHandoffLocal(intent.uploadId);
});

test('真正未知的写入保留目标所有权，别的 Worker 成功与本轮结束都不能解除', async () => {
  const targets = [target('w-unk', '/work/proj', 'box.example'), target('w-ok', '/work/proj', 'other.example')];
  const calls = [];
  // 核实只认写入引擎自己的写忙投影（内存只读），形状与生产一致。
  const quiesced = () => ({ ok: true, instanceId: 'instance-1', transfers: [], operations: [], settledOperations: [],
    busy: { schemaVersion: 1, instanceId: 'instance-1', busy: false, activeTransferCount: 0, blockingTransferCount: 0,
      uploadOperationCount: 0, uploadOperations: [], uploadQueueCount: 0 } });
  const busyState = () => {
    const state = quiesced();
    state.busy.busy = true;
    state.busy.activeTransferCount = 1;
    state.busy.blockingTransferCount = 1;
    state.transfers = [{ id: 't-1', operation: 'upload.workspace', host: 'box.example', remotePath: '/work/proj',
      status: 'running', phase: 'uploading' }];
    return state;
  };
  const h = identityHost(targets);
  h.simpleSftpApiCall = async (command) => { calls.push(command); return busyState(); };
  const lease = await h.acquireCodeUploadTargetLeaseLocal(targets[0], 'sync-1');
  const intent = h.beginCodeUploadHandoffLocal(ROOT, 'workers', ['w-unk', 'w-ok']);
  const remembered = h.rememberUnknownCodeWriteLocal(intent, ROOT, targets[0], lease, 'sync-1', new Error('连接中断，写入结果未知'));
  assert.equal(remembered.targetKey, lease.key);
  assert.equal(remembered.uploadId, intent.uploadId, '保留的是原操作身份，不是本轮新身份');
  assert.equal(remembered.syncId, 'sync-1');
  h.retainCodeUploadTargetLeaseLocal(lease);
  h.markCodeUploadWorkerReadyLocal(intent, ROOT, 'w-ok', h.dispatchTargetKeyLocal('w-ok'));
  h.endCodeUploadHandoffLocal(intent.uploadId);
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w-unk'), false, '未知写入在本轮结束后仍不得接新派发');
  assert.equal(h.dispatchHandoffDiagnosticsLocal().status, 'unknown-write-retained');
  assert.equal(h.dispatchHandoffDiagnosticsLocal().unknownWrites[0].uploadId, intent.uploadId, '原操作身份必须保留');
  let secondDone = false;
  const second = h.acquireCodeUploadTargetLeaseLocal(targets[0], 'sync-2').then(result => { secondDone = true; return result; });
  await new Promise(setImmediate);
  // 已排队的分支必须能结束本次等待（否则同批整批收敛不了），但结束等待绝不等于拿到写锁。
  assert.equal(secondDone, true, '等待者不能被未知围栏无限掉住');
  const deferredSecond = await second;
  assert.equal(deferredSecond.token, undefined, '没有查询证据前不得把保留中的写锁交给第二个 Worker');
  assert.match(String(deferredSecond.deferred.reason), /未确认结束/, '退出时要交出明确的「未开始、需核实」理由');
  assert.equal(h.codeUploadTargetLeases.held.size, 1, '退出等待也不放锁：未知写入的保留租约仍在');
  // 查询仍报告活跃 → 仍未知，不自动重放。
  const busy = await h.verifyCodeUploadTargetQuiescentLocal(targets[0], lease.key);
  assert.equal(busy.quiescent, false);
  assert.equal(busy.evidence, 'operation-active');
  // 查询本身失败 → 也仍是未知，不能当确认结束。
  h.simpleSftpApiCall = async () => { throw new Error('RPC 超时'); };
  const failed = await h.verifyCodeUploadTargetQuiescentLocal(targets[0], lease.key);
  assert.equal(failed.quiescent, false);
  assert.equal(failed.evidence, 'operation-query-failed');
  assert.equal(h.pendingCodeUploadUnknownWriteLocal(ROOT, { targetKey: lease.key, workerId: 'w-unk' }).uploadId, intent.uploadId);
  // 完整查询确认已结束，才释放身份与目标租约。
  // 先验证回归点：目录存在性查询（只有 exists/empty）不得被当成写入收敛证据。
  h.simpleSftpApiCall = async () => { calls.push('tree-state'); return { ok: true, relativePath: '.', exists: true, empty: false }; };
  const treeState = await h.verifyCodeUploadTargetQuiescentLocal(targets[0], lease.key);
  assert.equal(treeState.quiescent, false, '目录在不在不能证明写入已结束');
  assert.equal(treeState.evidence, 'operation-state-incomplete');
  assert.equal(h.pendingCodeUploadUnknownWriteLocal(ROOT, { targetKey: lease.key, workerId: 'w-unk' }).uploadId, intent.uploadId,
    '不完整返回后仍保留原操作身份');
  h.simpleSftpApiCall = async () => { calls.push('idle'); return quiesced(); };
  const idle = await h.verifyCodeUploadTargetQuiescentLocal(targets[0], lease.key);
  assert.equal(idle.quiescent, true);
  assert.equal(h.resolveCodeUploadUnknownWriteLocal(ROOT, { targetKey: lease.key, workerId: 'w-unk' }).uploadId, intent.uploadId);
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w-unk'), true);
  const handedOver = await h.acquireCodeUploadTargetLeaseLocal(targets[0], 'sync-3');
  assert.ok(handedOver.token, '只有核实并交还旧租约之后，才真正拿到写锁');
  assert.equal(heldKey(handedOver), lease.key);
  assert.equal(h.codeUploadTargetLeases.held.size, 1, '接管后重新持锁，不是无人持锁的空窗');
  assert.deepEqual(calls, ['transfers.list', 'tree-state', 'idle'], '只在需要核实时各查一次，不轮询、不自动重放');
  h.releaseCodeUploadTargetLeaseLocal(handedOver.token);
  h.releaseCodeUploadTargetLeaseLocal(handedOver.token);
});
function heldKey(token) { return token.key; }

test('已确认终结的普通失败不会把目标永久锁死，明确未开始更可重试', async () => {
  const h = identityHost([target('w-f', '/work/proj', 'box.example')]);
  const intent = h.beginCodeUploadHandoffLocal(ROOT, 'workers', ['w-f']);
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w-f'), false, '本轮写入进行中不得接新派发');
  h.markCodeUploadWorkerFailedLocal(intent, ROOT, 'w-f', '远端校验不一致', h.dispatchTargetKeyLocal('w-f'));
  h.endCodeUploadHandoffLocal(intent.uploadId);
  assert.equal(h.pendingCodeUploadUnknownWriteLocal(ROOT, { targetKey: h.dispatchTargetKeyLocal('w-f'), workerId: 'w-f' }), undefined,
    '已确认终结的失败不登记为未知写入，不长期占用目标所有权');
  assert.equal(h.dispatchHandoffAllowsWorkerLocal(ROOT, 'w-f'), true, '确认终结的失败必须允许下一轮重试');
});

test('交接超时证据走真实压缩与序列化，重载后仍能读回精确身份', async () => {
  const api = actionErrorHarness();
  const recorded = [];
  const h = gateHost();
  h.postState = () => {};
  h.recordActionError = row => { recorded.push(api.compact(row)); };
  h.distributedQueueMetrics = [{ at: new Date().toISOString(), op: 'save', repeats: 1, queueBytes: 2_097_152, clearedJobs: 7, sameContent: true }];
  h.beginDistributedTickLocal('tick-r5', ROOT, 11);
  h.setDistributedTickPhaseLocal('tick-r5', 'transmission', { workerId: 'w1', commandId: 'cmd-r5', sent: true });
  const intent = h.beginCodeUploadHandoffLocal(ROOT, 'run', ['w1']);
  h.registerDispatchHandoffsLocal({ tickId: 'tick-r5', generation: 11, root: ROOT, projectId: 'p',
    dispatches: [{ workerId: 'w1', planId: 'plan', planFile: 'p.yaml', jobIndex: 4, commandId: 'cmd-r5' }] });
  h.markDispatchHandoffTransmissionLocal(ROOT, 'cmd-r5');
  const wait = await h.awaitDispatchHandoffSafeLocal(intent, 10);
  h.recordDispatchHandoffTimeoutLocal('codeSyncTargets', intent, wait);
  assert.equal(recorded.length, 1);
  const evidence = recorded[0].details.dispatchHandoff;
  assert.equal(evidence.tickId, 'tick-r5', '超时必须带上当时挡住的 tickId');
  assert.equal(evidence.generation, 11);
  assert.equal(evidence.blocking[0].commandId, 'cmd-r5', '超时必须带上挡路的精确 commandId');
  assert.equal(evidence.blocking[0].phase, 'transmission');
  assert.equal(evidence.blocking[0].sent, true);
  assert.equal(evidence.blocking[0].transportSettled, false);
  assert.equal(evidence.queueBytes, 2_097_152, '有界队列诊断随证据一起落盘');
  assert.equal(evidence.clearedJobsCount, 7);
  assert.equal(evidence.queueStorageStatus, 'ready');
  await api.writeErrors('C:/project', recorded);
  const readBack = await api.readErrors('C:/project');
  assert.equal(readBack.length, 1);
  const persisted = readBack[0].details.dispatchHandoff;
  assert.deepEqual([persisted.tickId, persisted.generation, persisted.blocking[0].commandId, persisted.blocking[0].phase],
    ['tick-r5', 11, 'cmd-r5', 'transmission'], '重载后仍能核对当时挡住的是谁，不能只剩一句笼统文案');
  assert.equal(persisted.blocking[0].sent, true);
  assert.equal(persisted.blocking[0].transportSettled, false, '传输是否落定必须能重载读回');
  assert.equal(persisted.blocking[0].elapsedMs >= 0, true);
  assert.equal(persisted.waitedMs, evidence.waitedMs, '读回证据必须仍带着真实已等时长');
  assert.equal(Number.isSafeInteger(persisted.waitedMs) && persisted.waitedMs >= 0, true);
  assert.equal(JSON.stringify(persisted).includes('token'), false, '证据不含密钥');
  assert.equal(JSON.stringify(persisted).includes('manifest'), false, '证据不含文件清单');
  // 有界：多余字段与非本命令的证据都不会被持久化。
  const oversized = api.compact({ command: 'codeUploadDispatchHandoff', message: 'm', details: { dispatchHandoff: {
    tickId: 'tick-x', blocking: Array.from({ length: 30 }, (_, index) => ({ tickId: `t${index}`, commandId: `c${index}`, secretToken: 'sk-1' })),
    secretToken: 'sk-2', fullManifest: { 'a.py': 'x'.repeat(500) } } } });
  assert.equal(oversized.details.dispatchHandoff.blocking.length, 4, 'blocking 有界');
  assert.equal(JSON.stringify(oversized.details).includes('sk-'), false, '未知字段与密钥被丢弃');
  assert.equal(oversized.details.dispatchHandoff.fullManifest, undefined);
  const unrelatedRow = api.compact({ command: 'otherCommand', message: 'm', details: { dispatchHandoff: { tickId: 'tick-y' } } });
  await api.writeErrors('C:/project', [unrelatedRow]);
  const unrelatedReadBack = await api.readErrors('C:/project');
  assert.equal(unrelatedReadBack[0].details, undefined, '只有这条命令能把该证据持久化并读回');
  h.endCodeUploadHandoffLocal(intent.uploadId);
});

function extractFunction(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist as a top level function`);
  const body = source.indexOf('{', start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(name);
}

// 真实错误压缩/序列化/读回链路：与生产同一批函数，夹具只提供内存文件系统。
function actionErrorHarness() {
  const files = new Map();
  const normalize = value => String(value).split(String.fromCharCode(92)).join('/');
  const fsMock = { async mkdir() {}, async writeFile(key, contents) { files.set(normalize(key), String(contents)); },
    async readFile(key) { const name = normalize(key); if (!files.has(name)) throw new Error('ENOENT'); return files.get(name); } };
  const sandbox = { fs: fsMock, path: require('node:path'), Date,
    WorkerProgressQuery: require('../../dist/features/WorkerProgressQuery'),
    UI_ACTION_ERROR_RECORD_LIMIT: 8, UI_ACTION_ERROR_MESSAGE_LIMIT: 480, UI_ACTION_ERROR_SUGGESTION_LIMIT: 240,
    UI_ACTION_ERROR_CAPABILITY_LIMIT: 8, compactPanelRenderEvidence: value => value,
    OperationOutcome_1: require('../../dist/core/OperationOutcome.js'),
    async writeAtomicPluginStateJson(file, value) { files.set(normalize(file), JSON.stringify(value, null, 2) + String.fromCharCode(10)); },
    actionErrorSuggestion: () => '刷新任务状态后重试' };
  vm.createContext(sandbox);
  vm.runInContext('(async () => {' + [
    'const PROJECT_ACTION_ERRORS_PATH = "simple_cluster/ui/action_errors.json";',
    extractFunction('redactSensitiveText'), extractFunction('compactSensitiveText'),
    extractFunction('compactDispatchHandoffEvidence'), extractFunction('compactPanelLifecycleDetails'),
    extractFunction('normalizeUiActionError'), extractFunction('compactUiActionError'), extractFunction('normalizeActionErrorRow'),
    extractFunction('readProjectActionErrorsState'), extractFunction('writeProjectActionErrorsState'),
    'this.compact = compactUiActionError; this.writeErrors = writeProjectActionErrorsState; this.readErrors = readProjectActionErrorsState;',
  ].join('\n') + ' })()', sandbox);
  return sandbox;
}
