// plan-run-single-batch 2026-10-24：单选与多选批量共同失败的缺陷回归。
// 缺陷：finishDistributedPlanSubmission 内两处对象简写 planFile 在函数作用域无绑定
//（源码约 10998/11006；tsc TS18004 两条），运行期 ReferenceError "planFile is not defined"：
//  第一处 planIsolatedReplacementsLocal.set(operationId,{planFile,count}) 抛出 → 外层 catch 原样 rethrow →
//  runSelectedPlans 行级 failed（宿主 operations 所见裸文案）；
//  第二处 attachIsolatedCleanup({…planFile…}) 被 11008 catch{} 吞掉——断言必须读真实账本，不能只看没抛错。
// 本夹具全部真实：runSelectedPlans（生产入口）、finishDistributedPlanSubmission（legacy 源码方法体提取转译，
// 与既有套件同法）、PlanSubmissionBatch/PlanIsolatedBatchLedger/WorkflowWorkspaceBinding/DistributedPlanQueue 真实模块；
// 仅替换：远端提交(enqueueDistributedPlan)、远端预检/确认、恢复存储、工作区根。不连远端、不跑科研。
const { test, assert, fs, os, path, ledger, runSelectedPlans, Q, legacySource, extractMethodBody, transpile } = require("./planIsolatedBatchLedger.support.cjs");
const crypto = require("node:crypto");
const { planSubmissionBatchFor } = require("../../src/features/PlanSubmissionBatch.ts");
const WorkflowBinding = require("../../src/features/WorkflowWorkspaceBinding.ts");

const sha = text => crypto.createHash("sha256").update(text).digest("hex");

function makeHarness({ files, counts, choices, ledgerFile }) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "se-plan-run-shared-"));
  const planFiles = files.map(rel => {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const text = `jobs:\n  - case: ${path.basename(rel)}\n`;
    fs.writeFileSync(abs, text);
    return { rel, abs, revision: sha(text) };
  });
  const finishBody = transpile(extractMethodBody(legacySource, "async finishDistributedPlanSubmission(command, message, plan, body, binding) {"));
  const injected = new Function("workspaceRoot", "WorkflowBinding", "PlanRunHost", "WorkerPreparation", "stringField", "errorMessage",
    "isUiCommandCancelled", "releaseRetentionClaim", "attachIsolatedCleanup", "DistributedPlanQueue",
    `"use strict"; return async function (command, message, plan, body, binding) {${finishBody}};`);
  const byRel = new Map(planFiles.map(item => [item.rel, item]));
  const mapWrites = [];
  const recordingMap = { set(k, v) { mapWrites.push({ operationId: k, ...v }); return Map.prototype.set.call(this, k, v); }, has: Map.prototype.has, delete: Map.prototype.delete, get: Map.prototype.get };
  const enqueued = [];
  const finals = [];
  const host = {
    client: {}, localOperations: {},
    localPlanMetadata: { plans: planFiles.map(item => ({ planFile: item.rel, revision: item.revision })) },
    captureProjectContext: () => ({ root: ws }),
    projectContextIsCurrent: () => true,
    refreshLocalPlanMetadataForAction: async () => {},
    distributedPlanEligible: () => true,
    localDistributedCodeFingerprint: async () => 'fp-batch',
    workerActionTargets: () => [{ id: 'w1', host: 'h1.example', user: 'u', port: 22, project_dir: '/srv/proj' }],
    planSubmissionOperationId: m => 'plan-submit-' + m.clientActionId,
    isolatedReplacementLedgerFileLocal: () => ledgerFile,
    planIsolatedReplacementsLocal: Object.assign(new Map(), recordingMap),
    ensureCodeReadyForRun: async () => { host.lastCodeSyncState = { fingerprint: 'fp-batch', workerVersions: { w1: { fingerprint: 'fp-batch' } } }; },
    enabledWorkerConfigs: () => [{ id: 'w1' }],
    lastCodeSyncState: undefined,
    tickDistributedQueue: async () => {},
    // ── runActionCommand：复刻生产 core 的批次接线（planSubmissionBatchFor → body.submissionBatchLocal），
    //    body 按 actionBody→actionPlanTarget 同源语义从 message.planFile 构造（canonical 相对路径+文件实算 revision）。
    runActionCommand: async (command, message) => {
      const item = byRel.get(message.planFile);
      const batch = planSubmissionBatchFor(message);
      if (!batch) throw Error('harness：message 未绑定批次（生产 bind 应已发生）');
      const body = {
        workspace: ws, planFile: message.planFile, planRevision: item.revision, codeFingerprint: 'fp-batch',
        existingOutputCount: counts[message.planFile] ?? 0,
        runRecovery: { checkKey: 'ck-' + message.planFile, preflight: { ok: true } },
      };
      body.submissionOperationIdLocal = host.planSubmissionOperationId(message);
      Object.defineProperty(body, "submissionBatchLocal", { value: batch });
      try {
        await finish.call(host, command, message, { planFile: body.planFile }, body, undefined);
      } catch (error) {
        host.localOperations[body.submissionOperationIdLocal] = { status: 'failed', message: String(error && error.message || error) };
        throw error;
      }
    },
    // ── finish 方法面的协作桩：只替代远端/确认/恢复面 ──
    loadDistributedQueue: async () => undefined,
    submissionStillCurrent: () => true,
    waitForPlanSubmission: async (message, work) => await work(),
    distributedCodeVersionHold: async () => ({ root: ws, fingerprint: 'fp-batch' }),
    legacySourceFreezeWorkerNames: () => [],
    reportPlanStage: () => {},
    recordPlanSubmissionTiming: () => {},
    recordPlanSubmissionTimingByOperation: () => {},
    planValidationCacheKey: body => 'ck-' + body.planFile,
    planSchedulerWorkerId: () => 'w1',
    assertPlanSubmissionWorkers: async () => {},
    assertExecutionCondaEnvReady: () => {},
    confirmDistributedPlanExistingOutputs: async (plan, body) => {
      body.existingOutputChoice = choices[body.planFile];
      if (["rerun_all", "rerun_missing"].includes(body.existingOutputChoice) && body.existingOutputCount > 0) {
        const token = 'tok-' + path.basename(body.planFile);
        body.runReplacement = { flow: 'isolate', done: true, completed: [token],
          previews: [{ index: 0, preview: { token, action: 'isolate', rows: [
            { disposition: 'isolate', relativePath: 'work/x', destination: 'clean_dir/20261024/work/x', absolutePath: '/srv/proj/work/x', archiveBatch: '20261024', node: { id: 'w1', host: 'h1.example' } }] } }] };
      }
    },
    enqueueDistributedPlan: async (body, validated, skipTick, superseded, epoch, opId) => {
      enqueued.push({ planFile: body.planFile, batchFlag: skipTick === true, epoch, opId });
      return { enqueued: true, localQueued: true, pendingCount: 0 };
    },
    finishPlanSubmissionProgress: (message, status, text) => {
      finals.push({ clientActionId: message.clientActionId, status, text });
      const opId = host.planSubmissionOperationId(message);
      host.localOperations[opId] = { status: status === "succeeded" ? "succeeded" : status, message: text };
    },
    recordActionError: () => {},
    distributedSubmissionEpochs: new Map(), distributedSubmissionAborts: new Map(),
    activeRetentionClaims: new Set(), hostOperationLease: 'lease-test',
    localPlanForActionBody: body => ({ planFile: body.planFile }),
  };
  const finish = injected(() => ws, WorkflowBinding,
    class { async save() {} async load() { throw Error('harness：不应进入恢复分支'); } },
    class { constructor() { throw Error('harness：代码同步短路分支不应构造 WorkerPreparation'); } },
    (o, k) => String(o?.[k] ?? ''), e => String(e?.message ?? e), e => e?.name === 'UiCommandCancelled',
    async () => {}, ledger.attachIsolatedCleanup, Q);
  return { host, ws, planFiles, mapWrites, enqueued, finals, finish, byRel };
}

test('批量 rerun_all/rerun_missing+旧产物：map 与账本写入各自 Plan 的 canonical 路径与原 revision，抵达 enqueue（缺陷红线复现处）', async () => {
  const ledgerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'se-plan-run-ledger-')), 'ledger.json');
  const files = ['plans/a.yaml', 'plans/b.yaml'];
  const counts = { 'plans/a.yaml': 3, 'plans/b.yaml': 5 };
  const choices = { 'plans/a.yaml': 'rerun_all', 'plans/b.yaml': 'rerun_missing' };
  const h = makeHarness({ files, counts, choices, ledgerFile });
  const report = await runSelectedPlans(h.host, { planFiles: files });
  assert.deepEqual(report.rows.map(row => [row.planFile, row.status]), [['plans/a.yaml', 'succeeded'], ['plans/b.yaml', 'succeeded']],
    '两 PLAN 必须全部成功抵达 enqueue：' + JSON.stringify(report.rows.map(r => r.message)));
  // 第一处缺陷：map 写入按 operationId 记各自 planFile/count，不得串批
  assert.equal(h.mapWrites.length, 2);
  const byOp = new Map(h.mapWrites.map(w => [w.operationId, w]));
  const rowOps = new Map(report.rows.map(row => [row.planFile, row.operationId]));
  for (const item of h.planFiles) {
    const write = byOp.get(rowOps.get(item.rel));
    assert.ok(write, 'map 必须记录 ' + item.rel + ' 的隔离事实');
    assert.equal(write.planFile, item.rel, 'map.planFile 必须是本 Plan 的 canonical 相对路径');
    assert.equal(write.count, counts[item.rel]);
  }
  // 第二处缺陷：attachIsolatedCleanup 的 catch 会吞 ReferenceError——必须读真实账本证明写入与身份
  const batches = await ledger.loadIsolatedBatchLedger(ledgerFile);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].plans.length, 2, '初始冻结集合两 Plan 都在');
  for (const item of h.planFiles) {
    const entry = batches[0].plans.find(plan => plan.planFile === item.rel);
    assert.ok(entry, '账本必须含 ' + item.rel + '（attach 被吞错时此处为空）');
    const token = 'tok-' + path.basename(item.rel);
    const cleanup = (entry.cleanup || []).find(record => record.cleanupOperationId === token);
    assert.ok(cleanup, item.rel + ' 的隔离完成 operation 必须挂接进本 Plan 账本（catch 吞错时此处缺失）');
    assert.deepEqual(cleanup.targets, [{ nodeId: 'w1', host: 'h1.example', sourceRelativePath: 'work/x',
      isolationRelativePath: 'clean_dir/20261024/work/x', archiveBatch: '20261024' }], item.rel + ' 的隔离目标必须原样冻结');
    assert.equal(String(entry.revision || ''), item.revision, item.rel + ' 挂接的 revision 必须是原文件实算值');
    assert.equal(String(entry.codeFingerprint || ''), 'fp-batch', item.rel + ' 挂接的代码指纹必须是同步态值');
    assert.equal(String(entry.submissionOperationId || ''), rowOps.get(item.rel), item.rel + ' 挂接的 operation 身份不得串');
  }
  assert.equal(h.enqueued.length, 2);
  assert.deepEqual(h.enqueued.map(row => row.planFile).sort(), files, 'enqueue 必须按各自 body 身份抵达');
});

test('控制组 keep_existing：跳过隔离块且不 enqueue，正常返回保留提示（旧码也须绿，证明失败域只在隔离块）', async () => {
  const ledgerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'se-plan-run-ledger-')), 'ledger.json');
  const h = makeHarness({ files: ['plans/a.yaml'], counts: { 'plans/a.yaml': 4 }, choices: { 'plans/a.yaml': 'keep_existing' }, ledgerFile });
  const report = await runSelectedPlans(h.host, { planFiles: ['plans/a.yaml'] });
  assert.equal(report.rows[0].status, 'succeeded');
  assert.equal(h.mapWrites.length, 0, 'keep_existing 不记隔离');
  assert.equal(h.enqueued.length, 0, 'keep_existing 不创建调度');
  assert.ok(h.finals.some(row => /保留已有产物/.test(row.text)));
});

test('控制组 无旧产物(existingOutputCount=0)+rerun_all：不记隔离但正常抵达 enqueue', async () => {
  const ledgerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'se-plan-run-ledger-')), 'ledger.json');
  const h = makeHarness({ files: ['plans/a.yaml'], counts: {}, choices: { 'plans/a.yaml': 'rerun_all' }, ledgerFile });
  const report = await runSelectedPlans(h.host, { planFiles: ['plans/a.yaml'] });
  assert.equal(report.rows[0].status, 'succeeded');
  assert.equal(h.mapWrites.length, 0);
  assert.equal(h.enqueued.length, 1);
});

test('单选 UI 路径=runSelectedPlans([one])：与批量共用提交方法，同样必须写对 map+账本（宿主 operationId=plan-submit-selected-plan-* 即此路证据）', async () => {
  const ledgerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'se-plan-run-ledger-')), 'ledger.json');
  const h = makeHarness({ files: ['plans/qmf.yaml'], counts: { 'plans/qmf.yaml': 2 }, choices: { 'plans/qmf.yaml': 'rerun_all' }, ledgerFile });
  const report = await runSelectedPlans(h.host, { planFiles: ['plans/qmf.yaml'] });
  assert.equal(report.rows[0].status, 'succeeded', '单选批量路必须成功：' + report.rows[0].message);
  assert.ok(/^plan-submit-selected-plan-/.test(report.rows[0].operationId), 'UI 单选 operationId 前缀与宿主失败记录一致');
  assert.equal(h.mapWrites.length, 1);
  assert.equal(h.mapWrites[0].planFile, 'plans/qmf.yaml');
  const batches = await ledger.loadIsolatedBatchLedger(ledgerFile);
  const entry = batches[0].plans.find(plan => plan.planFile === 'plans/qmf.yaml');
  assert.ok(entry && (entry.cleanup || []).some(record => record.cleanupOperationId === 'tok-qmf.yaml'
    && record.targets[0].isolationRelativePath === 'clean_dir/20261024/work/x'), '单选路账本挂接必须完整');
  assert.equal(h.enqueued.length, 1);
});

test('恢复路（非批量，无 submissionBatchLocal）：隔离块整体不进入，enqueue 以 batch=false 抵达', async () => {
  const ledgerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'se-plan-run-ledger-')), 'ledger.json');
  const h = makeHarness({ files: ['plans/a.yaml'], counts: { 'plans/a.yaml': 2 }, choices: { 'plans/a.yaml': 'rerun_all' }, ledgerFile });
  const { host, planFiles, finish } = h;
  const item = planFiles[0];
  host.lastCodeSyncState = { fingerprint: 'fp-batch', workerVersions: { w1: { fingerprint: 'fp-batch' } } };
  const message = { command: 'runPlan', planFile: item.rel, clientActionId: 'resume-no-batch' };
  const body = { workspace: h.ws, planFile: item.rel, planRevision: item.revision, existingOutputCount: 2,
    runRecovery: { checkKey: 'ck-' + item.rel, preflight: { ok: true }, syncFingerprint: 'fp-batch' } };
  // 复刻 legacy.ts:7075 恢复路直调：无 submissionBatchLocal、无批次冻结
  await finish.call(host, 'runPlan', message, { planFile: item.rel }, body, undefined);
  assert.equal(h.mapWrites.length, 0, '非批量路不得写隔离 map（缺陷块整体不进入）');
  assert.equal(h.enqueued.length, 1, '恢复路必须抵达 enqueue');
  assert.equal(h.enqueued[0].batchFlag, false, '恢复路以 batch=false 抵达 enqueue');
});
