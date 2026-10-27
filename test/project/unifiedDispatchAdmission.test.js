/**
 * 块B：本机统一派发准入（纯判定模块 + 真实两进程资源锁互斥 + 临时 Git/登记表隔离）。
 *
 * 变更前的缺失行为（先记录，再断言新行为）：
 * - 每个项目窗口只按自己的队列分配 GPU；跨项目/跨分支的同卡并发申请互不知晓，同一物理名额
 *   可被重复许诺；手动/服务器队列在“忙卡可用”下可无限绕过任何本机统一口径。
 * - 没有任何“先持久化同意、后唯一 POST”的跨项目共同入口，也没有防旁路的发送前身份核对。
 *
 * 本文件断言的最小行为集合（与批准方案§1/§3/§4/§5/§6 一一对应）：
 * 1) 逻辑服务器身份与 withRemoteActionResource 同构：不同别名同机同端口=同一服务器（会冲突）。
 * 2) 新意图=“盘上基线 vs 即将写入”差异；同 commandId 重试零新意图（不双计数）。
 * 3) 同 GPU 单槽并发只发放一个；多槽/多卡允许并行；已同意未决与 Worker 可自启的 queued 占槽
 *    （不照抄 memoryCounts 排除 queued 的口径）；手动 stage=ready 未消费槽位。
 * 4) 阻断项（损坏成员/缺策略/未映射别名）整批如实拒绝，绝不静默当零占用。
 * 5) 被拒意图剥回 pending/ready：保留所选放置与 nextCommandId（同命令重试），无伪造发送。
 * 6) 策略快照：损坏拒绝解析；合并不覆盖已有服务器条目并报告冲突；漂移按原始输入判定。
 * 7) 真实两进程对固定“统一派发”资源目标的互斥（各自独立进程，同临时登记目录，不写科研内容）。
 * 8) 登记表库存（registryInventory）在真实临时 Git 夹具上工作且不动任何提交。
 * 9) P0-1 持久同意事实跨真实 serialize→restore：手动首发守卫/占位免疫投影清洗；自动 startIntent
 *    被观测清除后仍占位；查询未知/重启不丢；只的确证终态（verifiedCompletion）/被拒剥回才释放；
 *    旧版无该字段的未知项按既有证据保守占位，绝不当零。
 * 10) P0-1/P1-3 两个独立项目窗口的真实进程跑生产提取法身（save 同意事务+跨队列占位+发送守卫）：
 *    同意→落盘→第二项目同卡拒/异卡批→B 根首次派发自登记别名→A 确证完成后同卡再批。
 * 11) P0-2 登记表存在（哪怕域未成立）的带新意图保存先持统一资源；登记表损坏拒绝而非静默放行。
 * 12) P0-R 确证失败退出/确证停止产生身份绑定 trustedTerminalProof，跨 serialize→restore 仍释放名额
 *     （真实 mergeDurableWorkerSnapshots→清洗→重读→再申请可批）；仅本地取消、未知/查询错误不释放。
 * 13) P0-2 返修交错窗口：开始零登记的真实子进程保存持有统一资源直到 atomicWrite 完成，主窗口
 *     “首次登记两根”只能在其写完后进入；随后同卡新意图按盘上保守占位被拒——不双批。
 * 14) 块B返修：真新意图同事务写本机追踪事实 dispatchAdmissionTrace（非同意、非第二账本，含零登记；
 *     获批清旧原因、被拒记本次原因；序列化/投影清洗免疫）。发送守卫与重试去重同收紧：legacy 状态形态
 *     救援只保留给无 trace 的升级前旧任务，trace＋无真实同意→守卫 false（闭合零登记在飞旁路）；
 *     同一精确身份的再申请只占自己一个名额（逐意图临时自扣：获批计数保持原值、被拒恢复），
 *     换 worker/GPU/命令绝不按旧重试、不可借旧身份名额；盘上完整身份被拒＝只记原因不剥回；
 *     跨项目监控从持久 trace 读“上次准入未通过原因，待再判定”，不谎称当前配额仍满。
 * 15) 块B主控审核轮：获批遇同命令换 worker/GPU 的旧同意按本次完整身份替换（磁盘与内存同一份事实，
 *     新身份守卫 true、旧身份 false；完全等价的旧同意保留原 agreedAt；盘上 job GPU 与 consent 冲突时
 *     即使请求省略 gpu 也 false）；“缺失才 legacy”按原字段真正缺失判定——无法解码的未知痕迹既不走状态
 *     形态救援、也不被当同意，被拒写回不剥 startIntent；E 类被拒恢复盘上原快照（unknown/原 startIntent/
 *     原放置元数据，本次副本字段不存活；无可信基线＝拒写不猜）；显存矩阵覆盖并发卡上限 1（自扣被拒不
 *     把已被占的卡错放给新意图）。
 *
 * 需要真实 git 子进程与多 node 进程（互斥/隔离语义本身是被测行为），因此作为新功能域新建本文件；
 * 手动通道对回执的响应扩在 test/features/manualJobDispatch.test.js。Linux 端不运行本套件。
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const admission = require("../../dist/project/UnifiedDispatchAdmission.js");
const { quotaSettings } = require("../../dist/features/GpuQuotaScheduling.js");
const { ResourceOperationLeaseManager } = require("../../dist/core/ResourceOperationLease.js");
const { BranchProjectStore } = require("../../dist/project/BranchProjectStore.js");
const { BranchProjectService } = require("../../dist/project/BranchProjectService.js");
const DPQ = require("../../dist/features/DistributedPlanQueue.js");
const VC = require("../../dist/features/VerifiedCompletion.js");

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
// FIXTURE POLICY: zero cleanup — retained for audit（与仓库 2026-10-23 策略一致）。
after(() => {
  for (const dir of tempDirs) console.log(`[fixtures retained, no cleanup] ${dir}`);
});

const gpuRows = (ids) => ids.map((id) => ({ index: String(id), memoryTotalMb: 40960, memoryUsedMb: 1024 }));
const settings = (jobsPerCard, extra = {}) => quotaSettings({ gpuJobsPerCard: jobsPerCard }, { gpuQuotaConfigured: true, gpuJobsPerCard: jobsPerCard, ...extra }, gpuRows([0, 1]));

const intent = (over = {}) => ({ planId: "plan-a", jobIndex: 0, attempt: 0, commandId: "cmd-0", workerId: "w1", gpuId: "0", manual: false, ...over });
const queueWith = (jobs) => ({ schemaVersion: 1, plans: [{
  id: "plan-a", planFile: "experiments/plans/a.yaml", revision: "r", codeFingerprint: "f", resultPathPolicy: "declared",
  jobs: jobs.map((job, index) => ({ index, attempt: 0, status: "pending", case: "c", seed: 1, outputDir: "work/j" + index, ...job })),
}] });
const dispatched = (over = {}) => ({ status: "dispatching", workerId: "w1", gpuId: "0", commandId: "cmd-0", lifecycleProtocol: 2, startIntent: { commandId: "cmd-0", workerId: "w1", gpuId: "0" }, ...over });

test("逻辑服务器身份：不同别名同机同端口=同一服务器；端口/主机不同则不同；大小写无关", () => {
  const a = admission.logicalServerKey({ workerHost: "GPU-SERVER-A", workerSshPort: 22 }, "workerX");
  const b = admission.logicalServerKey({ workerHost: "gpu-server-a", workerSshPort: 22 }, "workerY");
  const c = admission.logicalServerKey({ workerHost: "gpu-server-a", workerSshPort: 2222 }, "workerX");
  assert.equal(a, b, "跨项目别名不同但物理机相同必须映射为同一逻辑服务器");
  assert.notEqual(a, c);
  assert.equal(a, "gpu-server-a:22");
  const resource = admission.unifiedDispatchResource("C:/Users/x/AppData/Roaming/SimpleExperiment");
  assert.equal(resource.server, "local");
  assert.match(resource.target, /unified-dispatch$/);
});

test("新意图以盘上基线差异为唯一渠道：首发计 1，同命令重试计 0，手动 sent 标记 manual", () => {
  const disk = queueWith([{ status: "pending" }]);
  const outgoing = queueWith([dispatched()]);
  let intents = admission.diffNewDispatchIntents(disk, outgoing);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].commandId, "cmd-0");
  // 同命令重试：盘上已 dispatching 同 commandId → 不再生成新意图，天然不双计数。
  intents = admission.diffNewDispatchIntents(outgoing, DPQ.cloneDistributedQueue(outgoing, "sig"));
  assert.deepEqual(intents, []);
  // p2 unknown+startIntent 同命令（pinned 重试）同样不是新意图。
  const unresolved = queueWith([{ status: "unknown", workerId: "w1", gpuId: "0", commandId: "cmd-0", lifecycleProtocol: 2, startIntent: { commandId: "cmd-0", workerId: "w1", gpuId: "0" } }]);
  assert.deepEqual(admission.diffNewDispatchIntents(unresolved, DPQ.cloneDistributedQueue(unresolved, "sig")), []);
  const manual = queueWith([dispatched({ manualDispatch: { workerId: "w1", gpuId: "0", stage: "sent" } })]);
  const manualIntents = admission.diffNewDispatchIntents(disk, manual);
  assert.equal(manualIntents.length, 1);
  assert.equal(manualIntents[0].manual, true);
});

test("同 GPU 单槽两个并发申请只发放一个；多槽与多卡允许并行；等待原因带真实配额事实", () => {
  const base = { serverOf: () => "srv:22", settingsForServer: () => ({ settings: settings(1), rows: gpuRows([0, 1]) }), blockers: [], occupancy: new Map() };
  const two = [intent(), intent({ planId: "plan-b", jobIndex: 3, commandId: "cmd-3" })];
  let receipt = admission.admitDispatchIntents({ ...base, intents: two });
  assert.equal(receipt.approved.length, 1);
  assert.equal(receipt.denied.length, 1);
  assert.match(receipt.denied[0].reason, /配额已满（1\/1）/);
  // 第二个批准后，占用被计入：再来一发同样被拒（不会把同一槽重复许诺）。
  receipt = admission.admitDispatchIntents({ ...base, intents: [intent({ commandId: "cmd-9", jobIndex: 9 })],
    occupancy: new Map([["srv:22", new Map([["0", 1]])]]) });
  assert.equal(receipt.approved.length, 0);
  // 多槽（jobsPerCard=2）：同卡两个并行。
  const parallel = admission.admitDispatchIntents({ ...base, intents: two, settingsForServer: () => ({ settings: settings(2), rows: gpuRows([0, 1]) }) });
  assert.equal(parallel.approved.length, 2);
  // 不同 GPU：单槽也允许并行。
  const spread = admission.admitDispatchIntents({ ...base, intents: [intent(), intent({ jobIndex: 1, commandId: "cmd-1", gpuId: "1" })] });
  assert.equal(spread.approved.length, 2);
  // 无遥测行 → 不猜容量，如实全部等待。
  const blind = admission.admitDispatchIntents({ ...base, intents: [intent()], settingsForServer: () => ({ settings: settings(1), rows: [] }) });
  assert.equal(blind.approved.length, 0);
  assert.match(blind.denied[0].reason, /遥测未见卡/);
});

test("占用统计：queued 可自启与手动 sent 占槽；手动 ready 未消费；损坏/未映射不得静默当零", () => {
  const own = queueWith([dispatched({ executionState: "queued" }),
    { status: "pending", nextCommandId: "n1", manualDispatch: { workerId: "w1", gpuId: "1", stage: "ready" } }]);
  const member = queueWith([{ status: "dispatching", workerId: "wM", gpuId: "0", commandId: "m-1", manualDispatch: { workerId: "wM", gpuId: "0", stage: "sent" } },
    { status: "running", workerId: "wUnknown", gpuId: "1", commandId: "m-2" }]);
  const result = admission.computeServerOccupancy(
    [{ label: "own", queue: own }, { label: "member", queue: member }],
    (label, workerId) => label === "own" && workerId === "w1" ? "srv:22" : label === "member" && workerId === "wM" ? "srv:22" : undefined);
  assert.equal(result.occupancy.get("srv:22").get("0"), 2, "own queued(可自启) + member 手动 sent 都占槽");
  assert.equal(result.occupancy.get("srv:22").get("1"), undefined, "手动 ready 未消费槽位");
  assert.equal(result.unmapped.length, 1);
  assert.equal(result.unmapped[0].workerId, "wUnknown");
  // 存在未映射/阻断项时整批拒绝，绝不按零占用放行。
  const receipt = admission.admitDispatchIntents({ intents: [intent()], occupancy: result.occupancy,
    serverOf: () => "srv:22", settingsForServer: () => ({ settings: settings(1), rows: gpuRows([0, 1]) }),
    blockers: ["成员队列不可读/已损坏（repo-b）；相关派发已拒绝。"] });
  assert.equal(receipt.approved.length, 0);
  assert.equal(receipt.denied.length, 1);
  assert.match(receipt.denied[0].reason, /阻断项/);
  // 别名映射不出来的意图按未就绪拒绝，不猜测。
  const unmapped = admission.admitDispatchIntents({ intents: [intent()], occupancy: new Map(),
    serverOf: () => undefined, settingsForServer: () => ({ settings: settings(1), rows: gpuRows([0, 1]) }), blockers: [] });
  assert.match(unmapped.denied[0].reason, /未就绪，不猜测/);
});

test("被拒意图剥回 pending/ready：保留放置与 nextCommandId，同命令重试不换新身份，绝不伪造发送", () => {
  const denied = [{ ...intent({ manual: true }), reason: "GPU 0 配额已满" }];
  const queue = queueWith([dispatched({ lifecycleProtocol: 2,
    manualDispatch: { workerId: "w1", gpuId: "0", stage: "sent", origin: "server_queue", batchId: "b1" } })]);
  const stripped = admission.applyDeniedIntents(queue, denied);
  const job = stripped.plans[0].jobs[0];
  assert.equal(job.status, "pending");
  assert.equal(job.commandId, undefined);
  assert.equal(job.nextCommandId, "cmd-0", "保留原命令身份供同命令重试");
  assert.equal(job.manualDispatch.stage, "ready", "手动/服务器队列回到 ready，保留所选服务器/GPU");
  assert.equal(job.manualDispatch.workerId, "w1");
  assert.match(job.blockReason, /统一派发等待配额/);
  // 原地同步（发送方继续持有的同一队列对象）。
  admission.syncDeniedIntentsInPlace(queue, denied);
  assert.equal(queue.plans[0].jobs[0].status, "pending");
  assert.equal(queue.plans[0].jobs[0].manualDispatch.stage, "ready");
  // 身份不匹配的 job 绝不被动。
  const other = queueWith([{ status: "dispatching", workerId: "w1", gpuId: "0", commandId: "other-cmd", lifecycleProtocol: 2 }]);
  assert.equal(admission.applyDeniedIntents(other, denied).plans[0].jobs[0].status, "dispatching");
  // 非手动剥回清 startIntent 并保留 nextCommandId（与 resetUnsentDispatch 同形）。
  const auto = admission.applyDeniedIntents(queueWith([dispatched()]), [intent()]);
  assert.equal(auto.plans[0].jobs[0].startIntent, undefined);
  assert.equal(auto.plans[0].jobs[0].nextCommandId, "cmd-0");
  // 回执过滤语义。
  assert.equal(admission.dispatchAdmissionDenied({ dispatchAdmission: true, denied }, "plan-a", 0, "cmd-0"), true);
  assert.equal(admission.dispatchAdmissionDenied({ dispatchAdmission: true, denied }, "plan-a", 0, "other"), false);
  assert.equal(admission.dispatchAdmissionDenied(undefined, "plan-a", 0, "cmd-0"), false);
});

test("策略快照：损坏拒绝、合并不覆盖已有条目、漂移按原始输入判定（不受遥测迁移输出影响）", () => {
  assert.equal(admission.parseUnifiedPolicy(""), null);
  assert.equal(admission.parseUnifiedPolicy("{not json"), "corrupt");
  assert.equal(admission.parseUnifiedPolicy(JSON.stringify({ schemaVersion: 2, servers: {} })), "corrupt");
  const inputs = admission.buildPolicyInputs({ gpuJobsPerCard: 2, gpuMinFreeMemoryGb: 30, unrelated: "x" },
    { gpuQuotaConfigured: true, gpuJobsPerCard: 2, gpuMaxConcurrentCards: 4, unrelated: "y" });
  assert.deepEqual(Object.keys(inputs.global).sort(), ["gpuJobsPerCard", "gpuMinFreeMemoryGb"]);
  assert.equal(inputs.worker.unrelated, undefined);
  const policy = { schemaVersion: 1, savedAt: "t", savedFromRoot: "R", servers: { "gpu-a:22": { workerId: "w1", inputs } } };
  assert.deepEqual(admission.parseUnifiedPolicy(JSON.stringify(policy)), policy);
  const changed = admission.buildPolicyInputs({ gpuJobsPerCard: 3 }, { gpuQuotaConfigured: true });
  assert.equal(admission.policyInputsDrift(inputs, inputs), false);
  assert.equal(admission.policyInputsDrift(inputs, changed), true);
  const merged = admission.mergePolicyServers(policy, { schemaVersion: 1, savedAt: "t2", savedFromRoot: "R2",
    servers: { "gpu-a:22": { workerId: "w1", inputs: changed }, "gpu-b:22": { workerId: "w2", inputs: changed } } });
  assert.deepEqual(merged.policy.servers["gpu-a:22"].inputs, inputs, "已有条目保留，不被静默覆盖");
  assert.equal(merged.policy.servers["gpu-b:22"].workerId, "w2");
  assert.equal(merged.conflicts.length, 1);
  const map = admission.mergeServerMapRoots(null, "d:/repo-a", { workerX: "gpu-a:22" }, "t");
  const map2 = admission.mergeServerMapRoots(map, "d:/repo-b", { workerY: "gpu-a:22" }, "t2");
  assert.deepEqual(map2.roots["d:/repo-a"].aliases, { workerX: "gpu-a:22" });
  assert.deepEqual(admission.parseUnifiedServerMap(JSON.stringify(map2)), map2);
  assert.equal(admission.parseUnifiedServerMap("[]"), "corrupt");
});

test("真实两进程：同一固定统一派发资源目标上的保存临界区互斥（独立进程，同临时登记目录）", async () => {
  const dir = tempDir("se-unified-lease-");
  const leasePath = path.join(dir, "host-operation-lease.json");
  const apiDir = path.join(dir, "api");
  fs.mkdirSync(apiDir, { recursive: true });
  const logFile = path.join(dir, "interleave.log");
  const childScript = path.join(dir, "child.js");
  fs.writeFileSync(childScript, [
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const [leasePath, apiDir, id, holdMs, logFile, leaseMod, admissionMod] = process.argv.slice(2);",
    "const { ResourceOperationLeaseManager } = require(leaseMod);",
    "const { unifiedDispatchResource } = require(admissionMod);",
    "(async () => {",
    "  const manager = new ResourceOperationLeaseManager({ leasePath, windowId: os.hostname() + ':' + process.pid + ':t-' + id, ttlMs: 30000, heartbeatMs: 1000 });",
    "  await manager.run({ pluginId: 'p.test', workspaceUri: 'ws', hostProjectPath: apiDir, actionType: 'unified-dispatch', actionLabel: 'test', waitForConflict: true,",
    "    resources: [unifiedDispatchResource(apiDir)] }, async () => {",
    "    fs.appendFileSync(logFile, 'hold ' + id + '\\n');",
    "    await new Promise(resolve => setTimeout(resolve, Number(holdMs)));",
    "    fs.appendFileSync(logFile, 'exit ' + id + '\\n');",
    "  });",
    "})().catch(error => { fs.appendFileSync(logFile, 'error ' + id + ' ' + error.message + '\\n'); process.exitCode = 1; });",
    ""].join("\n"), "utf8");
  const distDir = path.join(__dirname, "..", "..", "dist");
  const start = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript, leasePath, apiDir, id, "600", logFile,
      path.join(distDir, "core/ResourceOperationLease.js"), path.join(distDir, "project/UnifiedDispatchAdmission.js")], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ id, code, stderr }));
  });
  const results = await Promise.all([start("A"), start("B")]);
  for (const row of results) assert.equal(row.code, 0, `子进程 ${row.id} 异常退出：${row.stderr}`);
  const lines = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).filter((line) => !line.startsWith("error"));
  const holds = lines.filter((line) => line.startsWith("hold"));
  assert.equal(holds.length, 2, "两个进程都必须进入临界区（waitForConflict 排队而不是失败）");
  // 互斥证明：hold 与 exit 必须严格成对，不得交错。
  const pairs = lines.map((line) => line.split(" ")[0] + ":" + line.split(" ")[1]).join(",");
  assert.ok(/^hold:[AB],exit:[AB],hold:[AB],exit:[AB]$/.test(pairs)
    && pairs.split(",")[0].split(":")[1] === pairs.split(",")[1].split(":")[1]
    && pairs.split(",")[2].split(":")[1] === pairs.split(",")[3].split(":")[1],
  `统一派发资源上的两进程临界区不得交错：${pairs}`);
});

test("登记表库存在真实临时 Git 夹具上工作：两个登记根=统一域基数，且不动任何提交", async () => {
  const { execFileSync } = require("node:child_process");
  const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" } });
  const makeRepo = (name) => {
    const dir = tempDir(`se-unified-${name}-`);
    git(["init", "-q", dir], dir);
    git(["checkout", "-q", "-B", "main"], dir);
    git(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], dir);
    return dir;
  };
  const ancestor = makeRepo("ancestor");
  const branch = makeRepo("branch");
  const beforeHead = git(["rev-parse", "HEAD"], ancestor).trim();
  const service = new BranchProjectService(new BranchProjectStore(path.join(tempDir("se-unified-store-"), "branch-projects.json")), () => ancestor);
  const ancestorRecord = await service.registerAncestor({ label: "", gitRoot: ancestor });
  const ancestorRow = service.registryInventory();
  assert.deepEqual(ancestorRow.ancestors.map((row) => path.normalize(row)), [path.normalize(ancestor)]);
  assert.deepEqual(ancestorRow.branches, []);
  await service.registerBranch({ ancestorId: ancestorRecord.id, label: "", workspaceRoot: branch });
  const inventory = service.registryInventory();
  assert.equal(inventory.ancestors.length + inventory.branches.length, 2, "两登记根=≥2 的统一域基数");
  assert.equal(git(["rev-parse", "HEAD"], ancestor).trim(), beforeHead, "库存读取绝不动提交");
});

test("P0-1 持久同意事实跨真实 serialize→restore：守卫/占位免疫投影清洗；确证终态/被拒剥回才释放；旧未知项不当零", () => {
  // 变更前缺失：同意只活在 dispatching/startIntent 内存状态里，serialize 投影一洗守卫就自拒、
  // 跨项目名额被清零——本机首发被自己拒绝、同卡被另一分支重复领取。
  const manualQueue = admission.attachApprovedDispatchConsent(
    queueWith([dispatched({ manualDispatch: { workerId: "w1", gpuId: "0", stage: "sent" }, startIntent: undefined })]),
    [intent({ manual: true })]);
  assert.equal(manualQueue.plans[0].jobs[0].dispatchConsent.commandId, "cmd-0");
  assert.equal(admission.attachApprovedDispatchConsent(manualQueue, [intent({ manual: true })]).plans[0].jobs[0].dispatchConsent,
    manualQueue.plans[0].jobs[0].dispatchConsent, "同身份重复批准不重写事实");
  const serialized = DPQ.serializeDistributedQueue(manualQueue);
  assert.match(serialized, /"dispatchConsent"/, "同意事实随队列落盘（不在投影清洗清单内）");
  const washed = JSON.parse(serialized).plans[0].jobs[0];
  assert.equal(washed.status, "unknown", "native 投影清洗：磁盘 status 从不被当运行真值");
  assert.equal(washed.startIntent, undefined);
  const restored = DPQ.restoreFormalJobQueue(JSON.parse(serialized));
  const rplan = restored.plans[0], rjob = rplan.jobs[0];
  // manual 首发守卫（清洗后）通过且占槽——靠同一份落盘事实，不靠被洗的状态。
  assert.equal(admission.consentPersistedOnDisk(rjob, "cmd-0", "w1", "0"), true);
  assert.equal(admission.jobOccupiesUnifiedSlot(rplan, rjob), true);
  assert.deepEqual(admission.diffNewDispatchIntents(restored, DPQ.cloneDistributedQueue(restored, "sig")), [], "清洗后同命令重试仍零新意图（不双计数）");
  // 自动项：观测确证执行清掉 startIntent，再 serialize→restore 仍占位。
  const autoQueue = admission.attachApprovedDispatchConsent(queueWith([dispatched()]), [intent()]);
  autoQueue.plans[0].jobs[0].startIntent = undefined;
  const autoRestored = DPQ.restoreFormalJobQueue(JSON.parse(DPQ.serializeDistributedQueue(autoQueue)));
  assert.equal(admission.jobOccupiesUnifiedSlot(autoRestored.plans[0], autoRestored.plans[0].jobs[0]), true, "startIntent 被清后仍靠持久事实占位");
  // 查询未知/重启：反复 serialize→restore 事实不丢。
  const againRestored = DPQ.restoreFormalJobQueue(JSON.parse(DPQ.serializeDistributedQueue(autoRestored)));
  assert.equal(againRestored.plans[0].jobs[0].dispatchConsent.commandId, "cmd-0");
  assert.equal(admission.consentPersistedOnDisk(againRestored.plans[0].jobs[0], "cmd-0", "w1", "0"), true);
  // 旧版无新字段的未知项：守卫按既有证据不伪造，占位按“无法确认保留”保守计占，绝不直接当零。
  const legacyUnknown = queueWith([{ status: "unknown", workerId: "w1", gpuId: "0", commandId: "cmd-old", lifecycleProtocol: 2 }]);
  assert.equal(admission.jobOccupiesUnifiedSlot(legacyUnknown.plans[0], legacyUnknown.plans[0].jobs[0]), true, "无法确认的旧未知项保留占位");
  assert.equal(admission.consentPersistedOnDisk(legacyUnknown.plans[0].jobs[0], "cmd-old", "w1", "0"), false, "守卫不替旧条目伪造同意");
  // 第二项目同 GPU 不获批、不同 GPU/多槽可批——占用全部来自 restore 之后的队列。
  const occupancy = admission.computeServerOccupancy([{ label: "own", queue: restored }], () => "srv:22").occupancy;
  const base = { serverOf: () => "srv:22", settingsForServer: () => ({ settings: settings(1), rows: gpuRows([0, 1]) }), blockers: [] };
  let receipt = admission.admitDispatchIntents({ ...base, occupancy, intents: [intent({ planId: "plan-b", commandId: "cmd-b" })] });
  assert.equal(receipt.approved.length, 0);
  assert.match(receipt.denied[0].reason, /配额已满（1\/1）/);
  receipt = admission.admitDispatchIntents({ ...base, occupancy, intents: [intent({ planId: "plan-b", jobIndex: 1, commandId: "cmd-b1", gpuId: "1" })] });
  assert.equal(receipt.approved.length, 1, "不同 GPU 可并行批准");
  const twoSlot = admission.admitDispatchIntents({ ...base, occupancy, settingsForServer: () => ({ settings: settings(2), rows: gpuRows([0, 1]) }),
    intents: [intent({ planId: "plan-b", commandId: "cmd-b" })] });
  assert.equal(twoSlot.approved.length, 1, "每卡多槽时第二个可批");
  // 确证完成＝跨清洗存活的 durable verifiedCompletion；释放后同卡才再批。
  const completed = queueWith([{ status: "completed", trustedTerminalStatus: "completed", workerId: "w1", gpuId: "0", commandId: "cmd-0", lifecycleProtocol: 2 }]);
  completed.plans[0].projectId = "proj-verified";
  const cjob = completed.plans[0].jobs[0];
  cjob.verifiedCompletion = { schemaVersion: 1, identity: VC.completionIdentity(completed.plans[0], cjob), verifiedAt: new Date().toISOString(), exitCode: 0 };
  const completedOnDisk = DPQ.restoreFormalJobQueue(JSON.parse(DPQ.serializeDistributedQueue(completed)));
  assert.equal(completedOnDisk.plans[0].jobs[0].status, "completed", "确证完成在 restore 后仍呈现 completed（proof 恢复投影）");
  assert.equal(admission.jobOccupiesUnifiedSlot(completedOnDisk.plans[0], completedOnDisk.plans[0].jobs[0]), false, "确证完成即释放名额");
  receipt = admission.admitDispatchIntents({ ...base, occupancy: admission.computeServerOccupancy([{ label: "own", queue: completedOnDisk }], () => "srv:22").occupancy,
    intents: [intent({ planId: "plan-b", commandId: "cmd-b" })] });
  assert.equal(receipt.approved.length, 1, "释放确证后才再批");
  // 被拒剥回：同意事实随身份一并剥除（该身份从未获得名额），同命令重试将来重新申请。
  const deniedRow = admission.applyDeniedIntents(manualQueue, [{ ...intent({ manual: true }), reason: "配额已满" }]);
  assert.equal(deniedRow.plans[0].jobs[0].dispatchConsent, undefined, "拒绝剥回清除持久事实");
  assert.equal(admission.jobOccupiesUnifiedSlot(deniedRow.plans[0], deniedRow.plans[0].jobs[0]), false);
  // 原地同步：批准事实写回调用方内存队列（同一来源，无第二真值）。
  const live = queueWith([dispatched()]);
  admission.syncApprovedConsentInPlace(live, [intent()]);
  assert.equal(live.plans[0].jobs[0].dispatchConsent.commandId, "cmd-0");
});

// —— 生产法身两窗口夹具：把 legacy 真实“保存同意事务 + 跨队列占位 + 发送守卫”方法体提取进隔离
// vm 沙箱（同 staleQueueRoundBehavior 口径），登记表库存是唯一注入点（薄可测试接口）；
// 第二窗口跑真实 node 子进程，证明占位事实经磁盘跨进程可见——不是只纯函数+锁日志。
const UNIFIED_HOST_HARNESS = [
  '"use strict";',
  'const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");',
  'module.exports=function makeHost(env){',
  '  const ts=require(env.typescript);',
  '  const source=fs.readFileSync(env.legacySource,"utf8");',
  '  const ast=ts.createSourceFile("legacy.ts",source,ts.ScriptTarget.Latest,true);',
  '  let cls=null;const visit=n=>{if(ts.isClassDeclaration(n)&&n.name&&n.name.text==="RealtimeTunnelPanelProvider")cls=n;ts.forEachChild(n,visit);};visit(ast);',
  '  const names=["saveDistributedQueue","withQueueWriteResource","computeUnifiedDispatchAdmission","assertUnifiedDispatchConsentPersisted","unifiedDomainState","registryHasEntries","withUnifiedAdmissionLease","readUnifiedSnapshotText","unifiedWorkerSetup","unifiedServerKey","unifiedCurrentAliasMap","unifiedDispatchProjection"];',
  '  const members=cls.members.filter(n=>n.name&&names.includes(n.name.getText(ast)));',
  '  if(members.length!==names.length)throw new Error("统一域宿主法身闭包不齐："+names.join(","));',
  '  const Host=vm.runInNewContext(ts.transpileModule("class Host{"+members.map(m=>m.getText(ast)).join("\\n")+"};Host",{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{',
  '    AbortController,workspaceRoot:()=>env.root,errorMessage:e=>String((e&&e.message)||e),compactSensitiveText:s=>String(s).slice(0,240),',
  '    require:()=>({getUpdater:()=>undefined}),syncGpuQuotaPolicies:async()=>({}),',
  '    listPluginInstances:()=>({rows:[],truncated:false}),preflightPluginAt:async()=>({capabilities:{}}),',
  '    DistributedPlanQueue:require(env.dist+"/features/DistributedPlanQueue.js"),',
  '    UnifiedDispatchAdmission:require(env.dist+"/project/UnifiedDispatchAdmission.js"),',
  '    GpuQuotaScheduling:require(env.dist+"/features/GpuQuotaScheduling.js"),',
  '    canonicalComparablePath:require(env.dist+"/project/BranchProjectStore.js").canonicalComparablePath,',
  '    atomicWriteText:(()=>{const real=require(env.dist+"/state/StateStore.js").atomicWriteText;',
  '      return async(...a)=>{if(!env.writeDelayMs)return real(...a);',
  '        if(env.eventLog)fs.appendFileSync(env.eventLog,"write-enter "+process.pid+"\\n");',
  '        await new Promise(resolve=>setTimeout(resolve,env.writeDelayMs));',
  '        const outcome=await real(...a);if(env.eventLog)fs.appendFileSync(env.eventLog,"write-done "+process.pid+"\\n");return outcome;};})(),',
  '    path,fs:require("node:fs/promises"),API_DISCOVERY_DIR:env.apiDir});',
  '  const h=new Host();',
  '  Object.assign(h,{',
  '    context:{globalStorageUri:{fsPath:env.storage}},manualDispatchInFlight:new Set(),planCleanupHosts:new Map(),',
  '    captureProjectContext:()=>({root:env.root}),projectContextIsCurrent:()=>true,',
  '    distributedQueueGeneration:0,distributedPlanStopEpoch:0,planStopClearBatchLease:undefined,distributedTickAbort:undefined,distributedQueueTickPromise:undefined,',
  '    distributedSubmissionEpochs:new Map(),distributedQueueWritePromise:Promise.resolve(),',
  '    hostOperationLease:env.leasePath?new(require(env.dist+"/core/ResourceOperationLease.js").ResourceOperationLeaseManager)',
  '      ({leasePath:env.leasePath,windowId:(env.windowId||"host")+"-"+process.pid,ttlMs:30000,heartbeatMs:1000}):undefined,',
  '    distributedQueueCache:null,distributedQueueRoot:"",distributedQueueDiskSignature:"",distributedQueueStorageDiagnostics:{status:"ready"},',
  '    distributedQueueMetadataWrites:[],detachStaleDistributedTick(){},postState(){},recordActionError(){},',
  '    setupConfig:{sessionPrefix:"T",workerTunnels:[{id:"w",workerHost:"gpu-host",workerSshPort:22}]},',
  '    enabledWorkerConfigs:()=>[{id:"w",gpuQuotaConfigured:true,gpuJobsPerCard:1}],schedulerSettings:()=>({gpuJobsPerCard:1}),',
  '    lastRealtimeState:{gpu:{w:[{index:"0",memoryTotalMb:40960,memoryUsedMb:1024},{index:"1",memoryTotalMb:40960,memoryUsedMb:1024}]}},',
  '    branchProjectService:()=>env.brokenRegistry?{registryInventory:()=>{throw new Error("模拟登记表损坏");}}',
  '      :{registryInventory:()=>({ancestors:env.rootsFile?JSON.parse(fs.readFileSync(env.rootsFile,"utf8")):(env.roots||[]),branches:[]})},',
  '  });',
  '  return h;',
  '};',
  ''].join("\n");

const UNIFIED_CHILD_SOURCE = [
  'const fs=require("node:fs");',
  'const C=JSON.parse(process.argv[2]);',
  'const makeHost=require(C.harness);',
  'const DPQ=require(C.dist+"/features/DistributedPlanQueue.js");',
  '(async()=>{',
  '  const h=makeHost({typescript:C.ts,legacySource:C.legacy,dist:C.dist,apiDir:C.apiDir,storage:C.storage,root:C.root,roots:C.roots,',
  '    rootsFile:C.rootsFile,writeDelayMs:C.writeDelayMs,eventLog:C.eventLog,leasePath:C.leasePath,windowId:C.windowId});',
  '  const file=DPQ.distributedQueuePath(C.storage,C.root);',
  '  const rawText=fs.readFileSync(file,"utf8");',
  '  const disk=DPQ.setDistributedQueueBaseSignature(DPQ.restoreFormalJobQueue(JSON.parse(rawText)),DPQ.distributedQueueDiskSignature(rawText));',
  '  const plan=disk.plans.find(p=>p.id===C.planId),job=plan.jobs.find(j=>j.index===C.jobIndex);',
  '  const guard=async()=>{try{await h.assertUnifiedDispatchConsentPersisted(plan,job,"w",C.gpuId,C.commandId);return true;}catch(e){return false;}};',
  '  const guardBeforeSave=await guard();',
  '  Object.assign(job,{status:"dispatching",workerId:"w",gpuId:C.gpuId,commandId:C.commandId,lifecycleProtocol:2},' +
    'C.manual?{manualDispatch:{workerId:"w",gpuId:C.gpuId,stage:"sent"}}:{startIntent:{commandId:C.commandId,workerId:"w",gpuId:C.gpuId}});',
  '  const receipt=await h.saveDistributedQueue(C.root,disk,{dispatchAdmission:true});',
  '  if(C.eventLog)fs.appendFileSync(C.eventLog,"child-save-return "+process.pid+"\\n");',
  '  const after=DPQ.restoreFormalJobQueue(JSON.parse(fs.readFileSync(file,"utf8")));',
  '  const diskJob=after.plans.find(p=>p.id===C.planId).jobs.find(j=>j.index===C.jobIndex);',
  '  const memoryJob=JSON.parse(JSON.stringify(job));',
  '  const guardAfterSave=await guard();',
  '  process.stdout.write("RESULT"+JSON.stringify({guardBeforeSave,guardAfterSave,receipt,diskJob,memoryJob})+"\\n");',
  '})().catch(error=>{process.stdout.write("RESULT"+JSON.stringify({error:String((error&&error.message)||error)})+"\\n");process.exitCode=1;});',
  ''].join("\n");

test("P0-1/P0-2/P1-3 两个独立项目窗口真实进程：生产同意事务落盘→跨窗口同卡拒→自登记别名→确证释放后再批；登记表损坏拒绝", async () => {
  const dir = tempDir("se-unified-prod-");
  const storage = path.join(dir, "storage"), apiDir = path.join(dir, "api");
  fs.mkdirSync(apiDir, { recursive: true });
  const rootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "se-unified-rootA-")));
  const rootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "se-unified-rootB-")));
  const canonical = require("../../dist/project/BranchProjectStore.js").canonicalComparablePath;
  const harnessPath = path.join(dir, "unified-host.js");
  fs.writeFileSync(harnessPath, UNIFIED_HOST_HARNESS, "utf8");
  const childPath = path.join(dir, "unified-child.js");
  fs.writeFileSync(childPath, UNIFIED_CHILD_SOURCE, "utf8");
  const distDir = path.join(__dirname, "..", "..", "dist");
  // 共享快照：单逻辑服务器 gpu-host:22、每卡 1 槽；别名表初始只含 rootA（B 靠首次派发自登记）。
  const inputs = admission.buildPolicyInputs({ gpuJobsPerCard: 1 }, { gpuQuotaConfigured: true, gpuJobsPerCard: 1 });
  const now = () => new Date().toISOString();
  fs.writeFileSync(path.join(apiDir, admission.UNIFIED_POLICY_FILE_NAME), JSON.stringify({ schemaVersion: 1, savedAt: now(), savedFromRoot: rootA,
    servers: { "gpu-host:22": { workerId: "w", inputs } } }));
  const mapPath = path.join(apiDir, admission.UNIFIED_SERVER_MAP_FILE_NAME);
  fs.writeFileSync(mapPath, JSON.stringify(admission.mergeServerMapRoots(null, canonical(rootA), { w: "gpu-host:22" }, now())));
  const fileFor = root => DPQ.distributedQueuePath(storage, root);
  const seed = (root, planId, jobCount) => {
    const q = DPQ.enqueuePlan(DPQ.emptyDistributedQueue(), { projectId: DPQ.canonicalProjectId(root), executionMode: "train", planFile: planId + ".yaml",
      revision: "r", codeFingerprint: "f", resultPathPolicy: "declared",
      jobs: Array.from({ length: jobCount }, (_unused, index) => ({ index, case: "a", seed: index + 1, outputDir: "work/" + index })) }, planId);
    fs.mkdirSync(path.dirname(fileFor(root)), { recursive: true });
    fs.writeFileSync(fileFor(root), DPQ.serializeDistributedQueue(q), "utf8");
  };
  seed(rootA, "plan-a", 1);
  seed(rootB, "plan-b", 2);
  const base = { harness: harnessPath, ts: require.resolve("typescript"), legacy: path.join(__dirname, "..", "..", "src", "extension", "legacy.ts"),
    dist: distDir, storage, apiDir, roots: [rootA, rootB] };
  const runChild = cfg => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, JSON.stringify({ ...base, ...cfg })], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      const line = out.split("\n").find(row => row.startsWith("RESULT"));
      if (!line) return reject(new Error(`子进程窗口无结果输出（code=${code}）：${err}`));
      resolve(JSON.parse(line.slice("RESULT".length)));
    });
  });
  const readDiskJob = (root, planId, index) => DPQ.restoreFormalJobQueue(JSON.parse(fs.readFileSync(fileFor(root), "utf8")))
    .plans.find(p => p.id === planId).jobs.find(j => j.index === index);
  // —— 窗口 A（进程内生产法身）：手动首发过统一同意事务，事实落盘。
  const hostA = require(harnessPath)({ ...base, typescript: base.ts, legacySource: base.legacy, root: rootA });
  const rawA = fs.readFileSync(fileFor(rootA), "utf8");
  const diskA = DPQ.setDistributedQueueBaseSignature(DPQ.restoreFormalJobQueue(JSON.parse(rawA)), DPQ.distributedQueueDiskSignature(rawA));
  const planA = diskA.plans[0], jobA = planA.jobs[0];
  Object.assign(jobA, { status: "dispatching", workerId: "w", gpuId: "0", commandId: "cmd-a1", lifecycleProtocol: 2,
    manualDispatch: { workerId: "w", gpuId: "0", stage: "sent" } });
  const receiptA = await hostA.saveDistributedQueue(rootA, diskA, { dispatchAdmission: true });
  assert.equal(receiptA.dispatchAdmission, true);
  assert.deepEqual(receiptA.approved.map(r => ({ planId: r.planId, commandId: r.commandId, gpuId: r.gpuId, manual: r.manual })),
    [{ planId: "plan-a", commandId: "cmd-a1", gpuId: "0", manual: true }]);
  assert.deepEqual(receiptA.denied, []);
  assert.equal(receiptA.blockers.length, 0, "夹具快照齐备不应有阻断项");
  const onDiskA = JSON.parse(fs.readFileSync(fileFor(rootA), "utf8")).plans[0].jobs[0];
  assert.equal(onDiskA.status, "unknown", "落盘即被投影清洗：守卫与占位必须靠持久事实而非磁盘状态");
  assert.equal(onDiskA.startIntent, undefined);
  assert.equal(onDiskA.dispatchConsent.commandId, "cmd-a1");
  assert.equal(onDiskA.dispatchConsent.gpuId, "0");
  assert.equal(onDiskA.dispatchAdmissionTrace.commandId, "cmd-a1", "获批新意图的追踪事实同事务落盘（trace≠同意，守卫不因它开绿灯）");
  assert.equal(onDiskA.dispatchAdmissionTrace.reason, undefined, "获批清旧原因：追踪不冒称未发生过的拒绝");
  // 生产发送守卫读真实磁盘文件：清洗后的 manual 首发身份通过（修复前在此被自己拒绝）。
  await hostA.assertUnifiedDispatchConsentPersisted(planA, jobA, "w", "0", "cmd-a1");
  // —— 窗口 B（真实子进程 #1）：同卡申请必须被拒并剥回；剥回身份守卫永不开绿灯。
  const r1 = await runChild({ root: rootB, planId: "plan-b", jobIndex: 0, commandId: "cmd-b1", gpuId: "0", manual: true });
  assert.equal(r1.error, undefined, "子进程异常：" + r1.error);
  assert.equal(r1.guardBeforeSave, false, "未同意前守卫如实拒绝");
  assert.equal(r1.receipt.approved.length, 0);
  assert.equal(r1.receipt.denied.length, 1);
  assert.match(r1.receipt.denied[0].reason, /配额已满（1\/1）/, "占用必须来自跨窗口读到磁盘上的 A 占位");
  assert.equal(r1.diskJob.status, "pending");
  assert.equal(r1.diskJob.nextCommandId, "cmd-b1", "剥回保留同命令重试身份");
  assert.equal(r1.diskJob.dispatchConsent, undefined);
  assert.match(String(r1.memoryJob.blockReason), /统一派发等待配额/, "单窗口原生观测面：等待原因在工作内存队列同一对象上（原地同步）");
  assert.equal(r1.diskJob.blockReason, undefined, "blockReason 属 native 洗投影易失类，磁盘不持久");
  assert.equal(r1.diskJob.dispatchAdmissionTrace.commandId, "cmd-b1", "被拒原因随本机追踪事实持久，跨项目监控从此读真相");
  assert.match(String(r1.diskJob.dispatchAdmissionTrace.reason), /配额已满（1\/1）/, "追踪存的是本次拒绝的真实配额事实");
  assert.equal(r1.guardAfterSave, false, "剥回身份绝不获得发送许可");
  // P1-3：B 根首次派发在事务内自登记本根 Worker 别名（A 的条目保留）。
  const mapAfterB = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  assert.deepEqual(mapAfterB.roots[canonical(rootB)].aliases, { w: "gpu-host:22" }, "分支根首次派发前自登记别名");
  assert.deepEqual(mapAfterB.roots[canonical(rootA)].aliases, { w: "gpu-host:22" }, "自登记只写自身根，不碰其它根");
  // —— 窗口 B（真实子进程 #2）：异卡自动意图获批并落盘，保存后守卫开绿灯。
  const r2 = await runChild({ root: rootB, planId: "plan-b", jobIndex: 1, commandId: "cmd-b2", gpuId: "1", manual: false });
  assert.equal(r2.error, undefined, "子进程异常：" + r2.error);
  assert.equal(r2.receipt.approved.length, 1, "不同 GPU/多槽可批");
  assert.equal(readDiskJob(rootB, "plan-b", 1).dispatchConsent.commandId, "cmd-b2");
  assert.equal(r2.guardAfterSave, true, "同意落盘后生产守卫通过（发送标记的既有 save→send 顺序自然放行）");
  // —— A 确证完成（durable verifiedCompletion 经生产保存事务落盘）→ 同卡名额释放。
  await hostA.saveDistributedQueue(rootA, undefined, { controlMutation: true, mutateLatest: latest => ({
    ...latest,
    plans: latest.plans.map(p => p.id !== "plan-a" ? p : {
      ...p,
      jobs: p.jobs.map(j => ({ ...j, status: "completed", trustedTerminalStatus: "completed", executionState: "exited",
        verifiedCompletion: { schemaVersion: 1, identity: VC.completionIdentity(p, j), verifiedAt: now(), exitCode: 0 } })),
    }),
  }) });
  const releasedA = readDiskJob(rootA, "plan-a", 0);
  assert.equal(releasedA.status, "completed", "确证完成的 proof 跨清洗保留");
  // —— 窗口 B（真实子进程 #3）：释放确证之后，同卡新命令才再批。
  const r3 = await runChild({ root: rootB, planId: "plan-b", jobIndex: 0, commandId: "cmd-b3", gpuId: "0", manual: false });
  assert.equal(r3.error, undefined, "子进程异常：" + r3.error);
  assert.equal(r3.receipt.denied.length, 0, "确证释放后才再批：" + JSON.stringify(r3.receipt.denied));
  assert.equal(r3.receipt.approved.length, 1);
  assert.equal(r3.guardAfterSave, true);
  // 双根磁盘占位终态：A 释放、B 两卡各 1——全部由另一窗口的磁盘读重算。
  const queueB = DPQ.restoreFormalJobQueue(JSON.parse(fs.readFileSync(fileFor(rootB), "utf8")));
  const occ = admission.computeServerOccupancy([{ label: "b", queue: queueB }], () => "gpu-host:22").occupancy;
  assert.equal(occ.get("gpu-host:22").get("0"), 1);
  assert.equal(occ.get("gpu-host:22").get("1"), 1);
  assert.equal(admission.jobOccupiesUnifiedSlot({ ...JSON.parse(fs.readFileSync(fileFor(rootA), "utf8")).plans[0] }, releasedA), false);
  // —— P0-2：登记表存在但域未成立（仅本根）——带新意图保存仍先持统一资源（消除登记切换窗口），
  // 域未成立时不产生同意、队列按既有单项目路径写入。
  const hostSolo = require(harnessPath)({ ...base, typescript: base.ts, legacySource: base.legacy, root: rootA, roots: [rootA] });
  const leaseResources = [];
  hostSolo.hostOperationLease = { run: async (options, work) => { leaseResources.push(options.resources.map(r => r.target)); return work(); } };
  const rawSolo = fs.readFileSync(fileFor(rootA), "utf8");
  const soloDisk = DPQ.setDistributedQueueBaseSignature(DPQ.restoreFormalJobQueue(JSON.parse(rawSolo)), DPQ.distributedQueueDiskSignature(rawSolo));
  const soloPlan = soloDisk.plans[0], soloJob = soloPlan.jobs[0];
  // 本场景不是"从未获批"：r0 已给该 job 以 cmd-a1/w/GPU0 真实批准并落盘（completed 后许可仍是历史事实）。
  // "未成立域不新授权"的契约是不写新同意，而不是把盘上历史许可抹掉——先绑定原许可逐值。
  const historicalConsent = soloJob.dispatchConsent && { ...soloJob.dispatchConsent };
  assert.ok(historicalConsent, "场景前提：盘上持 r0 获批的历史同意事实");
  assert.equal(historicalConsent.commandId, "cmd-a1", "历史许可属于旧身份 cmd-a1");
  assert.equal(String(historicalConsent.gpuId ?? ""), "0", "历史许可属于旧 GPU0，与本次 GPU1 新意图不同");
  Object.assign(soloJob, { status: "dispatching", workerId: "w", gpuId: "1", commandId: "cmd-a2", lifecycleProtocol: 2 });
  const soloReceipt = await hostSolo.saveDistributedQueue(rootA, soloDisk, { dispatchAdmission: true });
  assert.equal(soloReceipt, undefined, "未成立统一域=同意不启用（旧行为保留）");
  assert.ok(leaseResources.flat().some(target => /unified-dispatch$/.test(String(target))),
    "登记表存在时带新意图保存必须已持统一派发资源（事务内复核在持有之后）");
  const afterSolo = readDiskJob(rootA, "plan-a", 0);
  assert.deepEqual(afterSolo.dispatchConsent, historicalConsent,
    "未成立域不新授权，也不删除/改写历史许可：命令/worker/GPU/agreedAt 逐值不变");
  assert.equal(admission.consentPersistedOnDisk(afterSolo, "cmd-a2", "w", "1"), false,
    "历史许可不匹配新 job/新身份即不可借用：守卫对新身份如实 false（R8 收紧）");
  assert.equal(afterSolo.dispatchAdmissionTrace.commandId, "cmd-a2",
    "零登记同事务 trace 绑定的是新身份——trace 不是同意，守卫不因它开绿灯");
  // —— 登记表损坏：带新派发意图的保存被拒绝，绝不按“未登记”静默放行。
  const hostBroken = require(harnessPath)({ ...base, typescript: base.ts, legacySource: base.legacy, root: rootA, roots: [rootA, rootB], brokenRegistry: true });
  const beforeBroken = fs.readFileSync(fileFor(rootA), "utf8");
  await assert.rejects(() => hostBroken.saveDistributedQueue(rootA, soloDisk, { dispatchAdmission: true }),
    /登记表不可读\/已损坏.*已拒绝本次带新派发意图的队列写入/s);
  assert.equal(fs.readFileSync(fileFor(rootA), "utf8"), beforeBroken, "拒绝即零写入");
});

test("P0-R 确证失败退出/确证停止持久身份绑定终态证明：真实 merge→清洗→重读后可再批；本地取消与查询错误不释放", () => {
  // 变更前缺失：status=failed/cancelled 与 trustedTerminalStatus 只活在内存投影里，落盘被洗成
  // unknown 而持久同意仍在——非 0 退出/确证停止的 GPU 名额被永久占用，再也不能派发。
  const projectId = "proj-p0r";
  const build = () => {
    const q = admission.attachApprovedDispatchConsent(queueWith([dispatched()]), [intent()]);
    q.plans[0].projectId = projectId;
    return q;
  };
  const iso = new Date().toISOString();
  const runtime = { schemaVersion: 1, runId: "cmd-0", commandId: "cmd-0", state: "clear", count: 0, scanComplete: true };
  const snapshot = observation => ({ workerId: "w1", queryComplete: true, generatedAt: iso, fetchedAt: iso,
    capabilities: { taskLifecycle: 2 }, tasks: [{ commandId: "cmd-0", projectId, workerId: "w1", outputDir: "work/j0",
      observation: { lifecycleProtocol: 2, commandId: "cmd-0", projectId, workerId: "w1", observedAt: iso, runtimeDiagnostics: runtime, ...observation } }] });
  const base = { serverOf: () => "srv:22", settingsForServer: () => ({ settings: settings(1), rows: gpuRows([0, 1]) }), blockers: [] };
  const sameSlotReceipt = queue => admission.admitDispatchIntents({ ...base,
    occupancy: admission.computeServerOccupancy([{ label: "own", queue }], () => "srv:22").occupancy,
    intents: [intent({ planId: "plan-b", commandId: "cmd-b" })] });
  const washedRelease = merged => {
    const text = DPQ.serializeDistributedQueue(merged);
    assert.match(text, /"trustedTerminalProof"/, "确证终态证明随队列落盘（不在投影清洗清单内）");
    assert.equal(JSON.parse(text).plans[0].jobs[0].status, "unknown", "磁盘 status 照旧被清洗——释放只认证明，不信任盘上状态");
    const restored = DPQ.restoreFormalJobQueue(JSON.parse(text));
    assert.equal(VC.hasTrustedTerminalProof(restored.plans[0], restored.plans[0].jobs[0]), true);
    return restored;
  };
  // ① 物理退出非 0（整数 exitCode=3，四类查询全净）：真实生产合并路径产出终态证明。
  const failed = DPQ.mergeDurableWorkerSnapshots(build(), [snapshot({ tmux: { dead: true, phase: "running", windowId: "@0", paneId: "%0", exitCode: 3 },
    result: { runId: "cmd-0", status: "failed", present: true, verified: true, identityMatches: true, artifactsComplete: false, exitCode: 3 } })], projectId, Date.now());
  assert.equal(failed.plans[0].jobs[0].status, "failed");
  assert.equal(VC.hasTrustedTerminalProof(failed.plans[0], failed.plans[0].jobs[0]), true, "非 0 退出即持久化确证终态证明");
  const failedRestored = washedRelease(failed);
  assert.equal(admission.jobOccupiesUnifiedSlot(failedRestored.plans[0], failedRestored.plans[0].jobs[0]), false, "失败确证跨落盘释放名额");
  assert.equal(sameSlotReceipt(failedRestored).approved.length, 1, "失败确证 serialize→restore→再申请可批");
  // 二次落盘/重读：身份未变，证明仍有效。
  const failedAgain = DPQ.restoreFormalJobQueue(JSON.parse(DPQ.serializeDistributedQueue(failedRestored)));
  assert.equal(admission.jobOccupiesUnifiedSlot(failedAgain.plans[0], failedAgain.plans[0].jobs[0]), false);
  // ② 确证停止（cancelled===true 且窗口已释放）：同样跨落盘释放。
  const stopped = DPQ.mergeDurableWorkerSnapshots(build(), [snapshot({ tmux: null, cancelled: true, result: null })], projectId, Date.now());
  assert.equal(stopped.plans[0].jobs[0].status, "cancelled");
  assert.equal(VC.hasTrustedTerminalProof(stopped.plans[0], stopped.plans[0].jobs[0]), true, "确证停止即持久化终态证明");
  const stoppedRestored = washedRelease(stopped);
  assert.equal(admission.jobOccupiesUnifiedSlot(stoppedRestored.plans[0], stoppedRestored.plans[0].jobs[0]), false);
  assert.equal(sameSlotReceipt(stoppedRestored).approved.length, 1, "确证停止 serialize→restore→再申请可批");
  // ③ 仅本地取消（无远端确证）：落盘即洗回 unknown，无证明则继续保守占位，不得再批。
  const localCancel = build();
  localCancel.plans[0].jobs[0].status = "cancelled";
  const localText = DPQ.serializeDistributedQueue(localCancel);
  assert.doesNotMatch(localText, /"trustedTerminalProof"/, "本地取消文本不产生任何确证");
  assert.equal(JSON.parse(localText).plans[0].jobs[0].status, "unknown", "本地取消落盘同样被清洗");
  const localRestored = DPQ.restoreFormalJobQueue(JSON.parse(localText));
  assert.equal(admission.jobOccupiesUnifiedSlot(localRestored.plans[0], localRestored.plans[0].jobs[0]), true, "远端未证实停止不得释放");
  const localReceipt = sameSlotReceipt(localRestored);
  assert.equal(localReceipt.approved.length, 0);
  assert.match(localReceipt.denied[0].reason, /配额已满（1\/1）/);
  // ④ 查询错误：不产生证明也不释放；先前确证不因后来的未知被伪造出来。
  const errored = DPQ.mergeDurableWorkerSnapshots(build(), [snapshot({ executionQueryError: "查询超时" })], projectId, Date.now());
  assert.equal(VC.hasTrustedTerminalProof(errored.plans[0], errored.plans[0].jobs[0]), false, "查询错误不得产生确证");
  const erroredRestored = DPQ.restoreFormalJobQueue(JSON.parse(DPQ.serializeDistributedQueue(errored)));
  assert.equal(admission.jobOccupiesUnifiedSlot(erroredRestored.plans[0], erroredRestored.plans[0].jobs[0]), true, "未知/查询错仍占位");
  assert.equal(sameSlotReceipt(erroredRestored).approved.length, 0, "未知状态不得再批同卡");
});

test("P0-2 返修交错窗口：开始零登记的真实子进程保存持统一资源到 atomicWrite 完成，首次登记两根不得在其间滑入；随后同卡拒双批", async () => {
  const dir = tempDir("se-unified-race-");
  const storage = path.join(dir, "storage"), apiDir = path.join(dir, "api");
  fs.mkdirSync(apiDir, { recursive: true });
  const rootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "se-unified-raceA-")));
  const rootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "se-unified-raceB-")));
  const canonical = require("../../dist/project/BranchProjectStore.js").canonicalComparablePath;
  const harnessPath = path.join(dir, "unified-host.js");
  fs.writeFileSync(harnessPath, UNIFIED_HOST_HARNESS, "utf8");
  const childPath = path.join(dir, "unified-child.js");
  fs.writeFileSync(childPath, UNIFIED_CHILD_SOURCE, "utf8");
  const distDir = path.join(__dirname, "..", "..", "dist");
  const rootsFile = path.join(dir, "registry-roots.json");
  fs.writeFileSync(rootsFile, "[]", "utf8");
  const eventLog = path.join(dir, "events.log");
  fs.writeFileSync(eventLog, "", "utf8");
  const leasePath = path.join(dir, "host-operation-lease.json");
  const inputs = admission.buildPolicyInputs({ gpuJobsPerCard: 1 }, { gpuQuotaConfigured: true, gpuJobsPerCard: 1 });
  const now = () => new Date().toISOString();
  fs.writeFileSync(path.join(apiDir, admission.UNIFIED_POLICY_FILE_NAME), JSON.stringify({ schemaVersion: 1, savedAt: now(), savedFromRoot: rootA,
    servers: { "gpu-host:22": { workerId: "w", inputs } } }));
  const mapPath = path.join(apiDir, admission.UNIFIED_SERVER_MAP_FILE_NAME);
  fs.writeFileSync(mapPath, JSON.stringify(admission.mergeServerMapRoots(
    admission.mergeServerMapRoots(null, canonical(rootA), { w: "gpu-host:22" }, now()), canonical(rootB), { w: "gpu-host:22" }, now())));
  const fileFor = root => DPQ.distributedQueuePath(storage, root);
  const seed = (root, planId) => {
    const q = DPQ.enqueuePlan(DPQ.emptyDistributedQueue(), { projectId: DPQ.canonicalProjectId(root), executionMode: "train", planFile: planId + ".yaml",
      revision: "r", codeFingerprint: "f", resultPathPolicy: "declared", jobs: [{ index: 0, case: "a", seed: 1, outputDir: "work/0" }] }, planId);
    fs.mkdirSync(path.dirname(fileFor(root)), { recursive: true });
    fs.writeFileSync(fileFor(root), DPQ.serializeDistributedQueue(q), "utf8");
  };
  seed(rootA, "plan-a");
  seed(rootB, "plan-b");
  const base = { harness: harnessPath, ts: require.resolve("typescript"), legacy: path.join(__dirname, "..", "..", "src", "extension", "legacy.ts"),
    dist: distDir, storage, apiDir, rootsFile, leasePath };
  const readEvents = () => fs.readFileSync(eventLog, "utf8").split(/\r?\n/).filter(Boolean).map(line => line.split(" ")[0]);
  // —— 窗口 B（真实子进程）：登记表为空时带新意图保存；真实跨进程资源锁 + 700ms 延迟写制造交错窗口。
  let childOut = "", childErr = "", childExit = null;
  const childPromise = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, JSON.stringify({ ...base, root: rootB, planId: "plan-b", jobIndex: 0, commandId: "cmd-r1",
      gpuId: "0", manual: false, eventLog, writeDelayMs: 700, windowId: "child" })], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    child.stdout.on("data", chunk => { childOut += chunk; });
    child.stderr.on("data", chunk => { childErr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      childExit = code;
      const line = childOut.split("\n").find(row => row.startsWith("RESULT"));
      if (!line) return reject(new Error(`子进程窗口无结果输出（code=${code}）：${childErr}`));
      resolve(JSON.parse(line.slice("RESULT".length)));
    });
  });
  childPromise.catch(() => { /* 防早退断言路径上的未处理拒绝；下方 await 仍按真实结果失败 */ });
  // 等子进程已进入 atomicWrite（判定与计算都已完成、正处于写入中）——返修前登记正好能从这里挤进来。
  const startedAt = Date.now();
  while (!readEvents().includes("write-enter") && Date.now() - startedAt < 15000) {
    if (childExit !== null) {
      const line = childOut.split("\n").find(row => row.startsWith("RESULT"));
      assert.fail(`子进程在进入 write-enter 前已退出（code=${childExit}）——早退真实结果 RESULT=${line || "无"} 事件=${readEvents().join(",")} stderr=${childErr}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(readEvents().includes("write-enter"), `15s 内子进程未进入延迟写入（exit=${childExit}）事件=${readEvents().join(",")} RESULT=${childOut.split("\n").find(row => row.startsWith("RESULT")) || "无"} stderr=${childErr}`);
  const hostParent = require(harnessPath)({ ...base, typescript: base.ts, legacySource: base.legacy, root: rootA, windowId: "parent" });
  await hostParent.withUnifiedAdmissionLease("首次登记两根", async () => {
    fs.appendFileSync(eventLog, "parent-registration-enter\n");
    fs.writeFileSync(rootsFile, JSON.stringify([rootA, rootB]), "utf8");
  });
  const events = readEvents();
  assert.ok(events.includes("write-done") && events.includes("parent-registration-enter"), "事件不齐：" + events.join(","));
  assert.ok(events.indexOf("write-done") < events.indexOf("parent-registration-enter"),
    "带新意图保存必须持统一资源直到 atomicWrite 完成，登记不得插进计算与写入之间：" + events.join(","));
  const rChild = await childPromise;
  assert.equal(rChild.error, undefined, "子进程异常：" + rChild.error);
  assert.equal(rChild.receipt, undefined, "开始时零登记：同意不启用，保持原分配行为");
  assert.equal(rChild.guardAfterSave, false, "未同意不落发送绿灯：p2 未知在飞形态此前被 legacy 状态救援放行（旁路），现由同事务追踪事实如实拒绝");
  const childJob = DPQ.restoreFormalJobQueue(JSON.parse(fs.readFileSync(fileFor(rootB), "utf8"))).plans[0].jobs[0];
  assert.equal(childJob.dispatchConsent, undefined, "零登记窗口不写同意事实");
  assert.equal(childJob.status, "unknown");
  assert.equal(childJob.dispatchAdmissionTrace.commandId, "cmd-r1", "零登记保存同事务写追踪事实——守卫从此如实区分升级前旧任务与从未过准入的新意图（此前旁路 guard=true 即因状态形态救援）");
  assert.equal(childJob.dispatchAdmissionTrace.reason, undefined, "零登记不做准入判定，不伪造原因");
  assert.equal(childJob.startIntent.commandId, "cmd-r1", "零登记保持原派发行为：身份/占位/startIntent 原样");
  // —— 主窗口登记完成后申请同卡：B 的完整身份未知项已先落盘保守占位，A 被拒——两窗口合计不双批。
  const rawParentA = fs.readFileSync(fileFor(rootA), "utf8");
  const diskA = DPQ.setDistributedQueueBaseSignature(DPQ.restoreFormalJobQueue(JSON.parse(rawParentA)), DPQ.distributedQueueDiskSignature(rawParentA));
  Object.assign(diskA.plans[0].jobs[0], { status: "dispatching", workerId: "w", gpuId: "0", commandId: "cmd-p1", lifecycleProtocol: 2 });
  const receiptP = await hostParent.saveDistributedQueue(rootA, diskA, { dispatchAdmission: true });
  assert.ok(receiptP, "登记完成后统一域成立，返回真实回执");
  assert.equal(receiptP.approved.length, 0, "不得双批：B 的未确证完整身份意图已占位");
  assert.match(receiptP.denied[0].reason, /配额已满（1\/1）/);
  const parentJob = DPQ.restoreFormalJobQueue(JSON.parse(fs.readFileSync(fileFor(rootA), "utf8"))).plans[0].jobs[0];
  assert.equal(parentJob.status, "pending", "被拒意图剥回本地等待");
  assert.equal(parentJob.dispatchConsent, undefined);
  assert.equal(parentJob.nextCommandId, "cmd-p1", "剥回保留同命令重试身份");
  assert.equal(parentJob.dispatchAdmissionTrace.commandId, "cmd-p1", "真新意图即使被别的项目占位拦停，追踪事实也已同事务落盘");
  assert.match(String(parentJob.dispatchAdmissionTrace.reason), /配额已满（1\/1）/, "拒绝原因跨窗口可读，不依赖落盘即被洗掉的 blockReason");
  // —— §B4 监控可见性：跨项目投影从持久事实读"上次准入未通过原因，待再判定"，不谎称当前仍满。
  const projection = await hostParent.unifiedDispatchProjection();
  assert.equal(projection.active, true, "登记完成后投影为统一域");
  const projectedA = projection.roots.find(row => row.root === rootA);
  assert.ok(projectedA, "投影含两个登记根：" + JSON.stringify(projection.roots.map(row => row.root)));
  assert.ok(projectedA.blockReasons.some(reason => /上次准入未通过原因，待再判定/.test(reason) && /配额已满/.test(reason)),
    "投影从 trace 持久事实读出等待原因：" + JSON.stringify(projectedA.blockReasons));
  // —— F2 返修：B 的原命令再申请——盘上未知占位是它自己的一个名额：守卫先如实拒绝（旁路已闭），
  //    受控保存内临时自扣后按真实余量获批，同意落盘后才开绿灯。
  const runChild2 = cfg => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, JSON.stringify({ ...base, eventLog, ...cfg })], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "", err = "";
    child.stdout.on("data", c => { out += c; });
    child.stderr.on("data", c => { err += c; });
    child.on("error", reject);
    child.on("close", code => {
      const line = out.split("\n").find(row => row.startsWith("RESULT"));
      if (!line) return reject(new Error(`再申请子进程无结果输出（code=${code}）：${err}`));
      resolve(JSON.parse(line.slice("RESULT".length)));
    });
  });
  const rRe = await runChild2({ root: rootB, planId: "plan-b", jobIndex: 0, commandId: "cmd-r1", gpuId: "0", manual: false, windowId: "child-re" });
  assert.equal(rRe.error, undefined, "再申请子进程异常：" + rRe.error);
  assert.equal(rRe.guardBeforeSave, false, "trace＋无同意：发送守卫如实拒绝（返修前的 legacy 形态旁路已闭合）");
  assert.equal(rRe.receipt.approved.length, 1, "原命令再申请只占自己一个名额：临时自扣后如实可批，不双计也绝不永占又永发不出");
  assert.equal(rRe.receipt.denied.length, 0, JSON.stringify(rRe.receipt.denied));
  assert.equal(rRe.guardAfterSave, true, "再申请把同意事实落盘后守卫开绿灯");
  const reJob = DPQ.restoreFormalJobQueue(JSON.parse(fs.readFileSync(fileFor(rootB), "utf8"))).plans[0].jobs[0];
  assert.equal(reJob.dispatchConsent.commandId, "cmd-r1", "同意事实随再申请落盘");
  assert.equal(reJob.dispatchAdmissionTrace.commandId, "cmd-r1", "再申请保留同一追踪身份");
  assert.equal(reJob.dispatchAdmissionTrace.reason, undefined, "获批清除旧未通过原因");
  assert.equal(reJob.status, "unknown", "磁盘状态照旧被投影清洗，守卫只认持久事实");
  // —— 临时腾出的名额不泄漏：B 合法同意在占后，A 换命令的新意图不能借走该卡（换命令绝不按旧重试）。
  const rawA2 = fs.readFileSync(fileFor(rootA), "utf8");
  const diskA2 = DPQ.setDistributedQueueBaseSignature(DPQ.restoreFormalJobQueue(JSON.parse(rawA2)), DPQ.distributedQueueDiskSignature(rawA2));
  Object.assign(diskA2.plans[0].jobs[0], { status: "dispatching", workerId: "w", gpuId: "0", commandId: "cmd-p2", lifecycleProtocol: 2 });
  const receiptP2 = await hostParent.saveDistributedQueue(rootA, diskA2, { dispatchAdmission: true });
  assert.equal(receiptP2.approved.length, 0, "A 的新命令不得借走/绕过 B 已占的名额");
  assert.match(receiptP2.denied[0].reason, /配额已满（1\/1）/);
});

// ————— 块B返修：追踪事实、守卫收紧、自名额与拒绝分型（纯函数面，同文件同进程，无新测试进程） —————
test("块B返修：trace 同事务落盘且跨清洗免疫；trace≠同意；legacy 状态救援只留给无 trace 旧任务", () => {
  const disk = queueWith([{ status: "pending" }]);
  const outgoing = queueWith([dispatched()]);
  const intents = admission.diffNewDispatchIntents(disk, outgoing);
  const traced = admission.attachAdmissionTraces(outgoing, intents);
  assert.deepEqual(traced.plans[0].jobs[0].dispatchAdmissionTrace, { schemaVersion: 1, commandId: "cmd-0", workerId: "w1", gpuId: "0" });
  assert.equal(admission.attachAdmissionTraces(traced, intents).plans[0].jobs[0].dispatchAdmissionTrace,
    traced.plans[0].jobs[0].dispatchAdmissionTrace, "同身份幂等：不重写、不伪造 reason");
  const text = DPQ.serializeDistributedQueue(traced);
  assert.match(text, /"dispatchAdmissionTrace"/, "追踪事实随队列落盘（不在 native 投影清洗清单内）");
  assert.equal(JSON.parse(text).plans[0].jobs[0].blockReason, undefined, "blockReason 仍按易失类被洗——两者职责不互换");
  const restored = DPQ.restoreFormalJobQueue(JSON.parse(text));
  assert.deepEqual(restored.plans[0].jobs[0].dispatchAdmissionTrace, { schemaVersion: 1, commandId: "cmd-0", workerId: "w1", gpuId: "0" });
  assert.equal(admission.consentPersistedOnDisk(restored.plans[0].jobs[0], "cmd-0", "w1", "0"), false,
    "unknown+startIntent+trace＋无真实同意 → 守卫 false（F2 零登记在飞旁路就此闭合）");
  const legacyInFlight = queueWith([{ status: "unknown", workerId: "w1", gpuId: "0", commandId: "cmd-old", lifecycleProtocol: 2,
    startIntent: { commandId: "cmd-old", workerId: "w1", gpuId: "0" } }]).plans[0].jobs[0];
  assert.equal(admission.consentPersistedOnDisk(legacyInFlight, "cmd-old", "w1", "0"), true, "升级前无 trace 的合法在飞旧任务：兼容保留");
  assert.deepEqual(admission.diffNewDispatchIntents(queueWith([legacyInFlight]), DPQ.cloneDistributedQueue(queueWith([legacyInFlight]), "s")), [],
    "无 trace 旧任务同命令重试仍零新意图（不双计数）");
  const live = queueWith([dispatched()]);
  admission.syncAdmissionTracesInPlace(live, admission.diffNewDispatchIntents(disk, live));
  assert.equal(live.plans[0].jobs[0].dispatchAdmissionTrace.commandId, "cmd-0", "内存观测面与落盘同一来源");
});

test("块B返修：自占用再申请临时自扣——获批计数保持原值、被拒恢复；拒绝分型保身份；换身份不可借槽；显存不足不被自扣打开", () => {
  const base = { serverOf: () => "srv:22", settingsForServer: () => ({ settings: settings(1), rows: gpuRows([0, 1]) }), blockers: [] };
  const diskTraced = queueWith([{ status: "unknown", workerId: "w1", gpuId: "0", commandId: "cmd-0", lifecycleProtocol: 2,
    startIntent: { commandId: "cmd-0", workerId: "w1", gpuId: "0" }, lastDispatchAttemptAt: "2026-01-01T00:00:00.000Z",
    dispatchAdmissionTrace: { schemaVersion: 1, commandId: "cmd-0", workerId: "w1", gpuId: "0", reason: "上次该卡已满" } }]);
  const outgoing = queueWith([dispatched({ lastDispatchAttemptAt: "2026-10-25T09:00:00.000Z" })]);
  const intents = admission.diffNewDispatchIntents(diskTraced, outgoing);
  assert.equal(intents.length, 1, "trace＋无同意不再按旧重试静默去重，必须重新受控准入");
  assert.equal(intents[0].selfReserved, true, "盘上同根同 plan/job/attempt/command/worker/GPU 且实际计占＝只标自名额再申请");
  const occupancy = admission.computeServerOccupancy([{ label: "own", queue: diskTraced }], () => "srv:22").occupancy;
  assert.equal(occupancy.get("srv:22").get("0"), 1, "其占位保守计占不因 trace/无同意被放宽");
  let receipt = admission.admitDispatchIntents({ ...base, occupancy, intents });
  assert.equal(receipt.approved.length, 1, "临时自扣自己 1 后如实可批：不双计，也绝不永占又永发不出");
  const approvedQueue = admission.attachApprovedDispatchConsent(admission.attachAdmissionTraces(outgoing, intents), receipt.approved);
  const aj = approvedQueue.plans[0].jobs[0];
  assert.equal(aj.dispatchConsent.commandId, "cmd-0");
  assert.deepEqual(aj.dispatchAdmissionTrace, { schemaVersion: 1, commandId: "cmd-0", workerId: "w1", gpuId: "0" }, "获批保留追踪身份并清除旧原因");
  assert.equal(admission.consentPersistedOnDisk(DPQ.restoreFormalJobQueue(JSON.parse(DPQ.serializeDistributedQueue(approvedQueue))).plans[0].jobs[0],
    "cmd-0", "w1", "0"), true, "获批落盘后守卫凭持久同意开绿灯");
  receipt = admission.admitDispatchIntents({ ...base, occupancy, intents: [intents[0], intent({ planId: "plan-b", jobIndex: 5, commandId: "cmd-z" })] });
  assert.equal(receipt.approved.length, 1);
  assert.equal(receipt.approved[0].selfReserved, true);
  assert.match(receipt.denied[0].reason, /配额已满（1\/1）/, "自扣逐意图、裁定即恢复：同批其它意图看到的是原占用，不借被临时腾出的卡");
  const twoOccupied = new Map([["srv:22", new Map([["0", 2]])]]);
  receipt = admission.admitDispatchIntents({ ...base, occupancy: twoOccupied, intents: [intents[0], intent({ planId: "plan-b", jobIndex: 5, commandId: "cmd-z" })] });
  assert.equal(receipt.approved.length, 0, "他人还占着一格时再申请如实被拒，自扣不制造第二名额");
  assert.equal(receipt.denied[0].selfReserved, true);
  const selfDeniedRows = receipt.denied.filter(row => row.selfReserved);
  // E 分型：恢复的是盘上原快照（unknown/原 startIntent/原放置元数据），不是本次待发送副本——
  // UI 绝不把"未知且本次未获批"说成"正在派发"，本次副本的时间戳也不得覆盖原不确定事实。
  const deniedSelf = admission.applyDeniedIntents(outgoing, selfDeniedRows, diskTraced);
  const dj = deniedSelf.plans[0].jobs[0];
  assert.equal(dj.status, "unknown", "被拒再申请恢复盘上 unknown，绝不用 outgoing 的 dispatching 冒充");
  assert.equal(dj.commandId, "cmd-0");
  assert.deepEqual(dj.startIntent, { commandId: "cmd-0", workerId: "w1", gpuId: "0" }, "原 startIntent 原样保留");
  assert.equal(dj.lastDispatchAttemptAt, "2026-01-01T00:00:00.000Z", "盘上原放置元数据胜出，本次副本时间戳被恢复掉");
  assert.match(dj.blockReason, /统一派发等待配额/, "仅补记本次原因（内存观测面）");
  assert.equal(dj.dispatchAdmissionTrace.reason, receipt.denied[0].reason, "本次拒绝原因写入持久 trace");
  const deniedWashed = DPQ.restoreFormalJobQueue(JSON.parse(DPQ.serializeDistributedQueue(deniedSelf)));
  assert.equal(admission.computeServerOccupancy([{ label: "own", queue: deniedWashed }], () => "srv:22").occupancy.get("srv:22").get("0"), 1,
    "serialize→restore 后其占位仍恰为 1：拒绝不释放名额");
  assert.equal(admission.consentPersistedOnDisk(deniedWashed.plans[0].jobs[0], "cmd-0", "w1", "0"), false, "被拒后守卫仍如实拒绝");
  // 无可信基线快照＝拒绝写入，不猜。
  assert.throws(() => admission.applyDeniedIntents(queueWith([dispatched()]), selfDeniedRows), /缺少该身份的可信盘上基线快照，拒绝写入/);
  // 原地同步：保留对象身份、字段集合等于恢复结果（本次副本新增字段不得存活）。
  const live = queueWith([dispatched({ lastDispatchAttemptAt: "2026-10-25T09:00:00.000Z" })]);
  const liveJob = live.plans[0].jobs[0];
  admission.syncDeniedIntentsInPlace(live, selfDeniedRows, diskTraced);
  assert.equal(live.plans[0].jobs[0], liveJob, "原地同步保留对象引用");
  assert.equal(liveJob.status, "unknown");
  assert.equal(liveJob.lastDispatchAttemptAt, "2026-01-01T00:00:00.000Z", "内存观测面同样恢复盘上快照，不留在'正在派发'假象");
  for (const [label, swapped] of [["GPU", dispatched({ gpuId: "1" })], ["worker", dispatched({ workerId: "w2" })], ["命令", dispatched({ commandId: "cmd-new" })]]) {
    const swappedIntents = admission.diffNewDispatchIntents(diskTraced, queueWith([swapped]));
    assert.equal(swappedIntents.length, 1, "换 " + label + "＝新意图，绝不按旧重试静默去重");
    assert.equal(swappedIntents[0].selfReserved, undefined, "换 " + label + " 不可借旧身份的自名额");
  }
  const lowMem = [{ index: "0", memoryTotalMb: 40960, memoryUsedMb: 40000 }, { index: "1", memoryTotalMb: 40960, memoryUsedMb: 1024 }];
  const memBase = { serverOf: () => "srv:22", blockers: [],
    settingsForServer: () => ({ settings: quotaSettings({ gpuJobsPerCard: 2 }, { gpuQuotaConfigured: true, gpuJobsPerCard: 2 }, lowMem), rows: lowMem }) };
  const memReceipt = admission.admitDispatchIntents({ ...memBase, occupancy: new Map([["srv:22", new Map([["0", 1]])]]),
    intents: [intents[0], intent({ planId: "plan-b", jobIndex: 5, commandId: "cmd-z", gpuId: "1" })] });
  assert.ok(memReceipt.denied.some(row => row.gpuId === "0" && /并发用卡上限或该卡暂不满足最低空闲显存/.test(row.reason)),
    "GPU0 显存不足：自扣不把它伪造成可发槽位（如实等待）");
  assert.ok(memReceipt.approved.some(row => row.gpuId === "1"), "GPU1 充足照常获批，与自扣判定互不干扰");
});

test("块B主控审核轮：旧同意按本次完整身份替换；未知痕迹不按无痕迹救援；并发卡上限1不被自扣错放", () => {
  const now = "2026-10-25T00:00:00.000Z";
  // —— Fix 1：旧同意＝同命令换 worker/GPU。本次完整批准必须替换磁盘＋内存两套事实为新身份。
  const stale = queueWith([dispatched({ dispatchConsent: { commandId: "cmd-0", workerId: "w9", gpuId: "1", agreedAt: "2026-01-01T00:00:00.000Z" } })]);
  const approvedNew = admission.attachApprovedDispatchConsent(stale, [intent()], now);
  assert.deepEqual(approvedNew.plans[0].jobs[0].dispatchConsent, { commandId: "cmd-0", workerId: "w1", gpuId: "0", agreedAt: now },
    "旧同意与当前身份不完整一致＝用本次获批完整身份替换");
  admission.syncApprovedConsentInPlace(stale, [intent()], now);
  assert.deepEqual(stale.plans[0].jobs[0].dispatchConsent, { commandId: "cmd-0", workerId: "w1", gpuId: "0", agreedAt: now },
    "内存观测面同一规则同一事实");
  const washed = DPQ.restoreFormalJobQueue(JSON.parse(DPQ.serializeDistributedQueue(approvedNew))).plans[0].jobs[0];
  assert.deepEqual(washed.dispatchConsent, { commandId: "cmd-0", workerId: "w1", gpuId: "0", agreedAt: now }, "serialize→restore 磁盘仍持新身份");
  assert.equal(admission.consentPersistedOnDisk(washed, "cmd-0", "w1", "0"), true, "新身份守卫 true");
  assert.equal(admission.consentPersistedOnDisk(washed, "cmd-0", "w9", "1"), false, "旧 worker/GPU 身份绝不借用新同意");
  assert.equal(admission.consentPersistedOnDisk(washed, "cmd-x", "w1", "0"), false, "未获批命令不因旧同意借用");
  // 完全等价的旧同意：保留原 agreedAt（批准轮不重写等价事实）。
  const exact = queueWith([dispatched({ dispatchConsent: { commandId: "cmd-0", workerId: "w1", gpuId: "0", agreedAt: "2026-01-01T00:00:00.000Z" },
    dispatchAdmissionTrace: { schemaVersion: 1, commandId: "cmd-0", workerId: "w1", gpuId: "0" } })]);
  assert.equal(admission.attachApprovedDispatchConsent(exact, [intent()], now).plans[0].jobs[0].dispatchConsent.agreedAt,
    "2026-01-01T00:00:00.000Z", "已有同意与 job/hit 完整相等时才保留原 agreedAt");
  // 盘上 job GPU 与 consent GPU 冲突：无论请求是否省略 gpu 参数，绝不借用该同意。
  const conflict = queueWith([{ status: "unknown", workerId: "w1", gpuId: "0", commandId: "cmd-0",
    dispatchConsent: { commandId: "cmd-0", workerId: "w1", gpuId: "1", agreedAt: "2026-01-01T00:00:00.000Z" } }]).plans[0].jobs[0];
  assert.equal(admission.consentPersistedOnDisk(conflict, "cmd-0", "w1", undefined), false, "consent 与盘上 job GPU 冲突＋请求省略 gpu 仍 false");
  assert.equal(admission.consentPersistedOnDisk(conflict, "cmd-0", "w1", "0"), false, "同上：显式 gpu 参数同样 false");
  assert.equal(admission.consentPersistedOnDisk(conflict, "cmd-0", "w1", "1"), false, "同上：按 consent GPU 请求也 false（盘上 job 并非该卡）");
  // —— Fix 2："缺失才 legacy"按原字段真正缺失判定，不由 traceOf 解码结果反推。
  const weirdJob = queueWith([{ status: "unknown", workerId: "w1", gpuId: "0", commandId: "cmd-0", lifecycleProtocol: 2,
    startIntent: { commandId: "cmd-0", workerId: "w1", gpuId: "0" }, lastDispatchAttemptAt: "2026-01-01T00:00:00.000Z",
    dispatchAdmissionTrace: { schemaVersion: 99, commandId: "cmd-0" } }]).plans[0].jobs[0];
  assert.equal(admission.consentPersistedOnDisk(weirdJob, "cmd-0", "w1", "0"), false, "存在但无法解码的痕迹≠无痕迹：状态形态救援不适用");
  const missingTraceJob = queueWith([{ status: "unknown", workerId: "w1", gpuId: "0", commandId: "cmd-0", lifecycleProtocol: 2,
    startIntent: { commandId: "cmd-0", workerId: "w1", gpuId: "0" } }]).plans[0].jobs[0];
  assert.equal(admission.consentPersistedOnDisk(missingTraceJob, "cmd-0", "w1", "0"), true, "字段真正缺失：升级前旧任务兼容保留");
  const weirdQueue = queueWith([weirdJob]);
  const weirdIntents = admission.diffNewDispatchIntents(weirdQueue, queueWith([dispatched()]));
  assert.equal(weirdIntents.length, 1, "未知痕迹绝不自动当同意：同身份再申请必须重新受控准入");
  assert.equal(weirdIntents[0].selfReserved, true, "其盘上完整身份仍保守计占：只占自己一个名额");
  const weirdDenied = admission.applyDeniedIntents(queueWith([dispatched({ lastDispatchAttemptAt: "2026-10-25T09:00:00.000Z" })]),
    [{ ...weirdIntents[0], reason: "配额已满（1/1）" }], weirdQueue);
  const wj = weirdDenied.plans[0].jobs[0];
  assert.equal(wj.status, "unknown", "未知痕迹的盘上未知项被拒：恢复盘上形态，不剥 pending、不冒充在派发");
  assert.deepEqual(wj.startIntent, { commandId: "cmd-0", workerId: "w1", gpuId: "0" }, "未知痕迹绝不触发 startIntent 剥离");
  assert.equal(wj.lastDispatchAttemptAt, "2026-01-01T00:00:00.000Z", "盘上原放置元数据胜出");
  // —— Fix 4：并发卡上限 1 与自扣叠加：自扣被拒不得把已被旧占位的卡错放给同批新意图。
  const lowMem = [{ index: "0", memoryTotalMb: 40960, memoryUsedMb: 40000 }, { index: "1", memoryTotalMb: 40960, memoryUsedMb: 1024 }];
  const capSettings = quotaSettings({ gpuJobsPerCard: 2 }, { gpuQuotaConfigured: true, gpuJobsPerCard: 2, gpuMaxConcurrentCards: 1 }, lowMem);
  assert.equal(capSettings.gpuMaxConcurrentCards, 1, "并发卡上限走真实 quotaSettings 字段与完整遥测输入");
  const capBase = { serverOf: () => "srv:22", blockers: [], settingsForServer: () => ({ settings: capSettings, rows: lowMem }) };
  const capIntents = [{ ...intent(), selfReserved: true }, intent({ planId: "plan-b", jobIndex: 5, commandId: "cmd-z", gpuId: "1" })];
  const capOccupancy = () => new Map([["srv:22", new Map([["0", 1]])]]);
  const capReceipt = admission.admitDispatchIntents({ ...capBase, occupancy: capOccupancy(), intents: capIntents });
  assert.equal(capReceipt.approved.length, 0, "上限1＋GPU0 已被自己占位：GPU0 显存不足再申请与 GPU1 新意图都不得放行");
  const capGpu0 = capReceipt.denied.find(row => row.gpuId === "0");
  const capGpu1 = capReceipt.denied.find(row => row.gpuId === "1");
  assert.equal(capGpu0.selfReserved, true, "GPU0 是自己那一个名额的再申请");
  assert.match(capGpu0.reason, /并发用卡上限或该卡暂不满足最低空闲显存/, "GPU0 显存不足：自扣不把它伪造成可发槽位");
  assert.match(capGpu1.reason, /并发用卡上限或该卡暂不满足最低空闲显存/, "GPU1 显存充足也被旧 GPU0 占住的并发卡上限阻止：自扣被拒不错放已占的卡");
  const capAgain = admission.admitDispatchIntents({ ...capBase, occupancy: capOccupancy(), intents: capIntents });
  assert.deepEqual(capAgain.denied.map(row => row.gpuId).sort(), ["0", "1"], "自扣逐意图即恢复：裁定不泄漏计数，重复裁定结果一致");
});
