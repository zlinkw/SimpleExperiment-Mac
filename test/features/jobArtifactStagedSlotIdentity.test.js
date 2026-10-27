// r6 必须项1（跨入口身份一致性，可移植行为回归——纯 JS，无 receiver/python/固定机器路径）：
// 同一 job/run/完整冻结源清单经两个真实入口（CompletedJobSyncHost→merge 与
// syncDistributedJobArtifacts）必须产生同一 retentionKey+generation；同输入重试同代；
// 真实内容变化跨入口同新代；新 command 同清单新代。真实 staged receiver 的两代槽断言为
// Linux 专属套件（r9 起位于 verification/linux/jobArtifactStagedSlotReceiver.test.js，
// 通用 test glob 之外、Windows 通道不执行；Linux 最终清单显式必跑并 env 注入 receiver 路径+SHA）。
const test = require("node:test");
const assert = require("node:assert/strict");
const { OUT, H, V1, V2, completedJobEntry, dedicatedEntry, jobArtifactRunGeneration } = require("./jobArtifactStagedSlot.support.cjs");

test("both real entry points derive one identity and one generation for the same run and manifest", async () => {
  const entryA = await completedJobEntry(V1).run();
  const entryB = await dedicatedEntry(V1).run();
  assert.equal(entryA.length, 1); assert.equal(entryB.length, 1);
  const expectedKey = JSON.stringify(["job-artifacts", "plans/p.yaml", 0, "c0", 42]);
  assert.equal(entryA[0].retentionKey, expectedKey);
  assert.equal(entryB[0].retentionKey, expectedKey);
  // 不断言 generation 的内部摘要域（属实现细节），只断言 r6 要求的行为关系：
  // 同 job/run/完整清单跨入口必须同代；同入口重试同代；真实内容变化必须新代且跨入口仍同代。
  assert.match(entryA[0].generation, /^[0-9a-f]{64}$/, "A 链 generation 必须是接收端可用的 64hex 稳定代");
  assert.match(entryB[0].generation, /^[0-9a-f]{64}$/, "B 链 generation 必须是接收端可用的 64hex 稳定代（String(plan.id) 不是）");
  assert.equal(entryB[0].generation, entryA[0].generation, "同一 run 的完整冻结源清单跨入口必须同代，否则两个入口白白消耗两代槽");
  const retryA = await completedJobEntry(V1).run();
  assert.equal(retryA[0].generation, entryA[0].generation, "同输入重试必须复用同代");
  // 内容变化：两条链各自开同一个新代（真实清单不同才允许不同代，这里清单相同）。
  const entryA2 = await completedJobEntry(V2).run();
  const entryB2 = await dedicatedEntry(V2).run();
  assert.equal(entryA2[0].generation, entryB2[0].generation, "变化后的完整清单跨入口仍须同代");
  assert.notEqual(entryA2[0].generation, entryA[0].generation, "真实源内容变化必须开新代");
  // 同 command、同 job 身份下专用链自身的内容变化也必须新代（不固定 plan.id）。
  assert.notEqual(entryB2[0].generation, entryB[0].generation);
  // 新 command（新 attempt/run）即使清单相同也开新代 —— 由 generation 纯函数契约保证。
  assert.notEqual(jobArtifactRunGeneration("plan", "command1", { [`${OUT}/model.pth`]: H.alpha }),
    jobArtifactRunGeneration("plan", "command0", { [`${OUT}/model.pth`]: H.alpha }));
  // r9 返修控制（正常面，真实 host patch 落点）：queue.artifacts 恰为 V1 产物全集——
  // host 逐字 {...job.artifacts, ...result.files}，禁止后缀侧的控制见 rootBinding files/generation/传输三层断言。
  const hostRun = await completedJobEntry(V1).runWithReport();
  assert.equal(hostRun.report.synced, 1);
  assert.deepEqual(Object.keys(hostRun.jobs[0].artifacts || {}).sort(), Object.keys(V1).sort(),
    "queue.artifacts 必须恰为本次产物清单（不含禁止后缀、不缺正常产物）");
});

// r9（真实 host 消费面，纯 JS 可移植）：冻结保护命中必须显式 partial，
// 严禁把受保护文件过滤成空 files/空 errors 后让 CompletedJobSyncHost 写 synced/全 mirrored。
test("r9: a frozen-protected destination never receives bytes and the real host records partial, never synced/mirrored", async () => {
  const entry = completedJobEntry(V1, { freezeGuard: t => (t.id === "b" ? { prefixes: ["work_dirs"], unknown: false } : { prefixes: [], unknown: false }) });
  const { report, transfers, jobs } = await entry.runWithReport();
  assert.equal(transfers.length, 0, "唯一目标端点 b 被冻结保护：不得有任何 fpsync 字节发出");
  assert.equal(report.synced, 0, "受保护 job 绝不允许计为 synced");
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /冻结机器状态映射均保护/);
  assert.equal(jobs[0].latestArtifactSync.state, "partial");
  assert.ok(!jobs[0].mirroredWorkerIds, "受保护 job 不得写 mirroredWorkerIds 全量成功证明");
});

test("r9: a frozen-protected source refuses with an explicit error instead of an empty success", async () => {
  const entry = completedJobEntry(V1, { freezeGuard: t => (t.id === "a" ? { prefixes: ["work_dirs/p"], unknown: false } : { prefixes: [], unknown: false }) });
  const { report, transfers, jobs } = await entry.runWithReport();
  assert.equal(transfers.length, 0, "来源清单被冻结保护污染时不得上传任何文件");
  assert.equal(report.synced, 0);
  assert.match(report.errors[0], /来源 a 的本次冻结机器状态映射保护/);
  assert.equal(jobs[0].latestArtifactSync.state, "partial");
  assert.ok(!jobs[0].mirroredWorkerIds);
});

// 0.5.416 配套（se-stage-block-visibility-release）：暂存槽卡点证据净化与释放能力门（纯单元，无平台依赖）。
// 卡点结构化字段是释放执行的唯一绑定来源：净化必须全量保留主机/范围/通道/身份/两槽与完整 64hex 代，
// 拒绝任何非 v1 结构与未知字段；释放能力门只认实时 capabilities，绝不按版本号推断。
const { sanitizeArtifactStageBlock, artifactStageBlockFromError, stagedSlotReleaseEvidenceReady }
  = require("../../src/features/JobArtifactSyncIdentity.ts");
const STAGE_ID = "a".repeat(64), STAGE_GEN = "c".repeat(64), STAGE_INCOMING = "b".repeat(64);
const rawStageBlock = () => ({ schemaVersion: 1, code: "TRANSFER_STAGE_PENDING",
  destination: { id: "nwpu3", profile: "work", host: "nwpu3.invalid" }, scope: '["job-artifacts","plans/p.yaml",0,"c0",42]',
  lane: 1, identity: STAGE_ID, incomingGeneration: STAGE_INCOMING,
  slots: [{ slot: "slot-0", path: ".staged-slots/" + STAGE_ID + "/slot-0", generation: STAGE_GEN, status: "committed",
      createdAt: 10, terminalAt: 20, updatedAt: 30, timeSource: "journal-terminalAt", ageMs: 172800000, locked: false,
      protectedReason: null, injectedUnknownField: "不得进入持久化" },
    { slot: "slot-1", path: ".staged-slots/" + STAGE_ID + "/slot-1", generation: "d".repeat(64), status: "running",
      createdAt: 40, terminalAt: 0, updatedAt: 50, timeSource: null, ageMs: null, locked: true, protectedReason: "lock-held" }],
  releaseCandidate: true });

test("卡点净化保留主机/范围/通道/身份与两槽全量事实和完整 64hex 代，拒绝非 v1、错误文本与未知字段", () => {
  const clean = sanitizeArtifactStageBlock(rawStageBlock());
  assert.ok(clean, "v1 卡点必须通过净化");
  assert.deepEqual(clean.destination, { id: "nwpu3", profile: "work", host: "nwpu3.invalid" });
  assert.equal(clean.scope, '["job-artifacts","plans/p.yaml",0,"c0",42]', "scope 逐字保留调用方声明的稳定范围");
  assert.equal(clean.lane, 1);
  assert.equal(clean.identity, STAGE_ID);
  assert.equal(clean.incomingGeneration, STAGE_INCOMING, "UI 可缩写，持久化与后台绑定必须完整值");
  assert.equal(clean.slots.length, 2, "两槽事实全量可见：含被占用槽的 locked/protectedReason");
  assert.equal(clean.slots[0].path, ".staged-slots/" + STAGE_ID + "/slot-0");
  assert.equal(clean.slots[0].generation, STAGE_GEN);
  assert.equal(clean.slots[1].locked, true);
  assert.equal(clean.slots[1].protectedReason, "lock-held");
  assert.equal(JSON.stringify(clean).includes("不得进入持久化"), false, "白名单外字段绝不落队列文件");
  assert.equal(sanitizeArtifactStageBlock({ schemaVersion: 2, code: "TRANSFER_STAGE_PENDING" }), undefined);
  assert.equal(sanitizeArtifactStageBlock({ schemaVersion: 1, code: "OTHER" }), undefined);
  assert.equal(sanitizeArtifactStageBlock("暂存槽卡点：主机 x · 范围 y"), undefined, "错误文本永不是卡点来源（禁止从文本猜路径）");
  assert.equal(sanitizeArtifactStageBlock({ ...rawStageBlock(), identity: "not-hex" }).identity, "", "非 64hex 身份置空，不成为可执行绑定");
  assert.equal(artifactStageBlockFromError({ message: "m", apiData: { stageBlock: rawStageBlock() } }).releaseCandidate, true, "apiData.stageBlock 位置同样兼容");
  assert.equal(artifactStageBlockFromError({ message: "m" }), undefined, "无结构化字段=只有文本，不猜");
});

test("释放能力门要求裁定能力实时齐备，任一缺失（含新 SE＋旧 SFTP）一律关闭", () => {
  // 终审 P1-2：门覆盖释放链真实会调用的每个方法与裁定选项——含 confirm 的精确批次摘要、
  // isolatedMaintenanceDelete 的登记 token/删除集合只能由插件从台账派生/回执前置保证；
  // status 是只读回执轮询，接收端只声明方法不声明选项（缺方法名同样拒绝）。
  const base = () => structuredClone({ methods: ["files.cleanup.stagedSlots", "files.cleanup.preview", "files.cleanup.confirm",
      "files.cleanup.execute", "files.cleanup.status", "files.cleanup.isolatedMaintenanceDelete"],
    methodOptions: {
      "files.cleanup.stagedSlots": { expiredCommittedReclaim: 1, structuredBlockEvidence: 1, releaseConfirmationCount: 1 },
      "sync.serverToServerFpsync": { claimScopedExpiredReclaim: 1, stageBlockEvidence: 1 },
      "files.cleanup.preview": { backgroundIsolatedDelete: 1 },
      "files.cleanup.execute": { isolationCompletionReceipt: 1 },
      "files.cleanup.confirm": { exactBatchDigest: true, deleteConfirmationCount: 2 },
      "files.cleanup.isolatedMaintenanceDelete": { registeredIsolationTokenOnly: 1, pluginDerivedDeleteSet: 1,
        isolationCompletionReceiptRequired: 1, userConfirmedSlotRelease: 1 } } });
  assert.equal(stagedSlotReleaseEvidenceReady(base()), true);
  const mutations = [
    c => { c.methodOptions["files.cleanup.stagedSlots"].expiredCommittedReclaim = 0; },
    c => { delete c.methodOptions["files.cleanup.stagedSlots"].releaseConfirmationCount; },
    c => { delete c.methodOptions["sync.serverToServerFpsync"].stageBlockEvidence; },
    c => { delete c.methodOptions["files.cleanup.preview"].backgroundIsolatedDelete; },
    c => { delete c.methodOptions["files.cleanup.execute"].isolationCompletionReceipt; },
    c => { delete c.methodOptions["files.cleanup.confirm"].exactBatchDigest; },
    c => { c.methodOptions["files.cleanup.confirm"].exactBatchDigest = false; },
    c => { delete c.methodOptions["files.cleanup.isolatedMaintenanceDelete"].registeredIsolationTokenOnly; },
    c => { delete c.methodOptions["files.cleanup.isolatedMaintenanceDelete"].pluginDerivedDeleteSet; },
    c => { delete c.methodOptions["files.cleanup.isolatedMaintenanceDelete"].isolationCompletionReceiptRequired; },
    c => { delete c.methodOptions["files.cleanup.isolatedMaintenanceDelete"].userConfirmedSlotRelease; }, // 旧 0.2.113：无提前释放旗=不给入口，预期 fail-closed
    c => { c.methodOptions["files.cleanup.isolatedMaintenanceDelete"].userConfirmedSlotRelease = 0; },
    c => { c.methods = c.methods.filter(name => name !== "files.cleanup.confirm"); }, // 缺方法：确认链不可用
    c => { c.methods = c.methods.filter(name => name !== "files.cleanup.status"); }, // 缺方法：回执轮询不可用
    c => { c.methods = c.methods.filter(name => name !== "files.cleanup.isolatedMaintenanceDelete"); }, // 缺方法：隔离副本无法登记删除
    c => { c.methods = ["files.cleanup.preview", "files.cleanup.execute"]; }, // 旧 SFTP：无 stagedSlots
  ];
  for (const mutate of mutations) {
    const clone = base(); mutate(clone);
    assert.equal(stagedSlotReleaseEvidenceReady(clone), false);
  }
  assert.equal(stagedSlotReleaseEvidenceReady(undefined), false);
  assert.equal(stagedSlotReleaseEvidenceReady({ methods: [], version: "0.3.0" }), false, "版本号字样不构成能力");
});
