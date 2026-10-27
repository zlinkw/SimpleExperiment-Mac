/**
 * src/project/UnifiedDispatchAdmission.ts - 块B：本机统一派发准入的纯计算模块。
 *
 * 唯一同意入口的语义在这里成形，但本模块不做任何 IO/RPC/用户交互：调用方（legacy.ts 保存事务）
 * 在持有本项目队列写资源 + 统一派发逻辑资源锁的同一临界区内，传入自己即将落盘的队列、
 * 从登记表读到的成员队列快照与本机遥测/策略；本模块只回答“这批新意图里哪些能同意”，
 * 拒绝必须带真实原因。损坏成员队列/策略缺失一律不得当零占用或静默放行（主控批准方案§1/§3/§6）。
 *
 * 新意图的判定以“盘上基线 vs 即将写入”为唯一渠道，因此自动/旧兼容/pinned 同命令重试/
 * ready-manual/服务器队列共用同一入口且同命令重试天然不双计数（同 commandId 已在盘上=非新意图）。
 */
import { DistributedQueue, QueuedJob, QueuedPlan, jobHasLiveExecution } from "../features/DistributedPlanQueue";
import { hasTrustedTerminalProof, hasVerifiedCompletion } from "../features/VerifiedCompletion";
import { GpuQuotaSettings, quotaPlacement } from "../features/GpuQuotaScheduling";

export type DispatchIntent = { planId: string; jobIndex: number; attempt: number; commandId: string; workerId: string; gpuId: string; manual: boolean;
  /** 块B返修：该精确身份已在盘上实际计占自己一个名额（再申请）；仅逐意图临时自扣，获批/被拒后计数不变。 */
  selfReserved?: boolean };
export type DeniedIntent = DispatchIntent & { reason: string };
export type UnifiedAdmissionReceipt = { dispatchAdmission: true; intents: number; approved: DispatchIntent[]; denied: DeniedIntent[]; blockers: string[] };

export type UnifiedResourceTarget = { server: "local"; project: string; target: string };

/** 所有管理项目共用同一规范目标：本机 API 登记目录下的固定“统一派发”逻辑资源。 */
export function unifiedDispatchResource(apiDir: string): UnifiedResourceTarget {
  return { server: "local", project: apiDir, target: apiDir + "/unified-dispatch" };
}

/**
 * 逻辑服务器身份与 withRemoteActionResource 完全同构（host 小写 + SSH 端口），
 * 保证跨项目不同 worker 别名指向同一物理机时冲突判定一致；无 host 可解析时退回 workerId
 * （与既有资源锁语义一致），调用方对无法在别名表映射的 workerId 必须按未就绪拒绝而非猜测。
 */
export function logicalServerKey(setup: { workerHost?: string; hubHost?: string; host?: string; workerSshPort?: number; hubSshPort?: number; port?: number } | undefined,
  workerIdFallback: string): string {
  const host = String(setup?.workerHost || setup?.hubHost || setup?.host || workerIdFallback || "hub").toLowerCase();
  const port = Number(setup?.workerSshPort || setup?.hubSshPort || setup?.port || 22);
  return host + ":" + (Number.isFinite(port) ? port : 22);
}

const dispatchKey = (row: { planId: string; jobIndex: number; commandId: string }) => `${row.planId}|${row.jobIndex}|${row.commandId}`;

/** 回执中该意图是否被拒（调用方发送前过滤用；同 plan/job/command 精确匹配）。 */
export function dispatchAdmissionDenied(receipt: unknown, planId: string, jobIndex: number, commandId: string): boolean {
  const entry = receipt as { dispatchAdmission?: boolean; denied?: DeniedIntent[] } | undefined;
  if (!entry || entry.dispatchAdmission !== true || !Array.isArray(entry.denied)) return false;
  return entry.denied.some((row) => dispatchKey(row) === dispatchKey({ planId, jobIndex, commandId }));
}

/** 持久同意事实与该 job 当前身份精确一致（P0-1：落盘/重读/投影清空后仍是同一份名额事实）。 */
export function dispatchConsentMatches(job: QueuedJob): boolean {
  const consent = job.dispatchConsent;
  return Boolean(consent && job.commandId && consent.commandId === job.commandId && consent.workerId === job.workerId
    && String(consent.gpuId ?? "") === String(job.gpuId ?? ""));
}

export type DispatchAdmissionTrace = NonNullable<QueuedJob["dispatchAdmissionTrace"]>;

function traceOf(job: QueuedJob): DispatchAdmissionTrace | undefined {
  return job.dispatchAdmissionTrace && job.dispatchAdmissionTrace.schemaVersion === 1 ? job.dispatchAdmissionTrace : undefined;
}

const traceIdentityEquals = (trace: DispatchAdmissionTrace, commandId: string, workerId: string, gpuId: string) =>
  trace.commandId === commandId && String(trace.workerId || "") === String(workerId || "") && String(trace.gpuId ?? "") === String(gpuId ?? "");

/**
 * 块B返修：对"盘上基线→即将写入"的真新意图，在同一保存事务内写本机追踪事实（含域未成立/零登记）。
 * trace 不是同意、不是第二账本：守卫绝不因它开绿灯，名额计算不读它；它唯一的作用是让后续保存能把
 * "无 trace 的升级前旧任务（合法在飞重试照旧）"与"有 trace 却从未获批的新身份"如实分开。
 * 幂等：同身份已存在则原样保留（reason 只由批准/拒绝路径改写，绝不在此伪造）；身份变化＝本次新事实覆盖。
 */
export function attachAdmissionTraces(queue: DistributedQueue, intents: DispatchIntent[]): DistributedQueue {
  if (!intents.length) return queue;
  return { ...queue, plans: queue.plans.map((plan) => {
    const rows = intents.filter((row) => row.planId === plan.id);
    if (!rows.length) return plan;
    return { ...plan, jobs: plan.jobs.map((job) => {
      const hit = rows.find((row) => job.index === row.jobIndex && job.attempt === row.attempt && job.commandId === row.commandId
        && job.workerId === row.workerId && String(job.gpuId ?? "") === row.gpuId && job.status === "dispatching");
      if (!hit) return job;
      const prior = traceOf(job);
      if (prior && traceIdentityEquals(prior, hit.commandId, hit.workerId, hit.gpuId)) return job;
      return { ...job, dispatchAdmissionTrace: { schemaVersion: 1, commandId: hit.commandId, workerId: hit.workerId, gpuId: hit.gpuId } };
    }) };
  }) };
}

/** 原地版本：同一追踪事实同步回调用方内存队列（观测面与落盘同一来源，无第二真值）。 */
export function syncAdmissionTracesInPlace(liveQueue: DistributedQueue | undefined, intents: DispatchIntent[]): void {
  if (!liveQueue || !intents.length) return;
  for (const plan of liveQueue.plans) {
    const rows = intents.filter((row) => row.planId === plan.id);
    if (!rows.length) continue;
    for (const job of plan.jobs) {
      const hit = rows.find((row) => job.index === row.jobIndex && job.attempt === row.attempt && job.commandId === row.commandId
        && job.workerId === row.workerId && String(job.gpuId ?? "") === row.gpuId && job.status === "dispatching");
      if (!hit) continue;
      const prior = traceOf(job);
      if (prior && traceIdentityEquals(prior, hit.commandId, hit.workerId, hit.gpuId)) continue;
      job.dispatchAdmissionTrace = { schemaVersion: 1, commandId: hit.commandId, workerId: hit.workerId, gpuId: hit.gpuId };
    }
  }
}

/**
 * 发送守卫用：盘上 job 是否已持有该精确命令身份的本机同意。
 * 块B返修（两半与 diskConsentMatches 同收紧）：
 * - 持久 dispatchConsent 必须同时等于盘上当前 job 与请求身份（命令/worker/GPU 逐项，防借用他身份）；
 * - legacy 状态形态救援（dispatching / p2 unknown+startIntent）只属于从未过准入的升级前旧任务：
 *   有本机 trace 的 job＝升级后派发过的新身份，无真实同意一律 false，绝不因状态形态开绿灯。
 */
export function consentPersistedOnDisk(diskJob: QueuedJob | undefined, commandId: string, workerId: string, gpuId: string | undefined): boolean {
  if (!diskJob || !commandId) return false;
  const gpuMatches = gpuId === undefined || String(diskJob.gpuId ?? "") === String(gpuId);
  const legacy = gpuMatches && String(diskJob.commandId || "") === commandId && String(diskJob.workerId || "") === workerId
    && (diskJob.status === "dispatching"
      || diskJob.lifecycleProtocol === 2 && diskJob.status === "unknown" && diskJob.startIntent?.commandId === commandId)
    // "缺失才 legacy"按原字段确实缺失判定：存在但无法解码的痕迹（未知 schema/null 等）同样不得被当成无痕迹。
    && diskJob.dispatchAdmissionTrace === undefined;
  const consent = diskJob.dispatchConsent;
  // 持久同意必须先与"盘上当前 job"完整一致（命令/worker/GPU 逐项，不受调用方省略 GPU 参数影响）——
  // 盘上 job GPU 与 consent GPU 冲突时绝不借用该同意；之后才按请求身份匹配（GPU 参数可选为既有 API 规则）。
  const consentMatchesDisk = Boolean(consent && String(diskJob.commandId || "") === String(consent.commandId)
    && String(diskJob.workerId || "") === String(consent.workerId) && String(diskJob.gpuId ?? "") === String(consent.gpuId ?? ""));
  const persisted = consentMatchesDisk && Boolean(consent && consent.commandId === commandId && String(consent.workerId || "") === String(workerId)
    && (gpuId === undefined || String(consent.gpuId ?? "") === String(gpuId)));
  return legacy || persisted;
}

function diskConsentMatches(diskJob: QueuedJob | undefined, job: QueuedJob): boolean {
  // 同 commandId 已在盘上处于 dispatching（或 p2 已核实未决的 unknown+startIntent）＝ 同命令重试，
  // 不消费新槽位；未知接收不重派/不释放的既有围栏负责其生命周期。
  if (!diskJob || !job.commandId) return false;
  if (diskJob.commandId !== job.commandId || diskJob.attempt !== job.attempt) return false;
  // 块B返修：重试去重同样要求 worker/GPU 与命令身份逐项一致——换 worker/GPU/命令绝不是"旧重试"。
  if (String(diskJob.workerId || "") !== String(job.workerId || "") || String(diskJob.gpuId ?? "") !== String(job.gpuId ?? "")) return false;
  // P0-1：盘上已有该精确身份的持久同意事实＝同样按重试处理（序列化把状态洗成 unknown 也不双计数）。
  if (dispatchConsentMatches(diskJob)) return true;
  // 块B返修：盘上存在任何 trace 字段（含无法解码的未知 schema）都不再享受状态形态救援——
  // trace+无同意＝必须重新受控准入的新意图（其自身占位由 selfReserved 走"只占自己一个名额"路径，
  // 绝不静默双计也绝不永占又永发不出）；"缺失才 legacy"以字段真正缺失为准，不由解码结果反推。
  if (diskJob.dispatchAdmissionTrace !== undefined) return false;
  return diskJob.status === "dispatching"
    || job.lifecycleProtocol === 2 && diskJob.status === "unknown" && diskJob.startIntent?.commandId === job.commandId;
}

/** 即将写入的队列相对盘上基线新增的派发意图（含手动 stage=sent 与自动/pinned 重派候选）。 */
export function diffNewDispatchIntents(diskQueue: DistributedQueue, outgoingQueue: DistributedQueue): DispatchIntent[] {
  const diskPlans = new Map(diskQueue.plans.map((plan) => [plan.id, plan]));
  const intents: DispatchIntent[] = [];
  for (const plan of outgoingQueue.plans) {
    const diskPlan = diskPlans.get(plan.id);
    for (const job of plan.jobs) {
      if (job.status !== "dispatching" || !job.commandId || !job.workerId) continue;
      const diskJob = diskPlan?.jobs.find((row) => row.index === job.index && row.attempt === job.attempt);
      if (diskConsentMatches(diskJob, job)) continue;
      // 块B返修（D）：盘上已存在同一精确身份（同根 plan/job/attempt/command/worker/GPU）且按统一口径
      // 实际计占的预留＝该意图已占自己一个名额；仅此情形自扣，其它根/命令/worker/GPU 一律不可借用。
      const selfReserved = Boolean(diskPlan && diskJob && diskJob.commandId === job.commandId && diskJob.attempt === job.attempt
        && String(diskJob.workerId || "") === String(job.workerId || "") && String(diskJob.gpuId ?? "") === String(job.gpuId ?? "")
        && jobOccupiesUnifiedSlot(diskPlan, diskJob));
      intents.push({ planId: plan.id, jobIndex: job.index, attempt: job.attempt, commandId: job.commandId,
        workerId: job.workerId, gpuId: String(job.gpuId ?? ""), manual: Boolean(job.manualDispatch), ...(selfReserved ? { selfReserved: true } : {}) });
    }
  }
  return intents;
}

export type OccupancyResult = { occupancy: Map<string, Map<string, number>>;
  unmapped: Array<{ label: string; workerId: string; planId: string; jobIndex: number }> };

/**
 * P0-1/P0-R 统一名额占用判定（跨落盘/重读稳定）：
 * - 释放证据必须能跨 clearNativeProjection 落盘清洗仍然成立：身份绑定的 verifiedCompletion（成功，exit 0）
 *   或 trustedTerminalProof（远端确证的物理退出/确证停止/服务端终态记录，含非 0 退出）。
 *   仅内存里的 status=failed/cancelled 或 trustedTerminalStatus 不足以作证——它们落盘即被洗成
 *   unknown，若不当持久事实处理，下一窗口读盘会永久保守计占该 GPU；未知/查询错误路径从不产生证明；
 * - 确证未发送/准入拒绝剥回（这些路径把身份洗回 pending/清 commandId）同样不再占名额；
 * - jobHasLiveExecution（内存态或新鲜观测的运行/排队事实）→ 占名额（与终态证明矛盾时保守计占）；
 * - 其余带完整身份（command/worker/GPU）的未知项按"无法确认保留"保守计占，绝不直接当零占位。
 * 手动 stage=ready（尚无 commandId）尚未消费槽位，不计。
 */
export function jobOccupiesUnifiedSlot(plan: QueuedPlan, job: QueuedJob): boolean {
  if (!job.workerId || job.gpuId === undefined || !job.commandId) return false;
  if (job.trustedTerminalStatus) return false;
  if (["completed", "failed", "cancelled"].includes(String(job.status || ""))) return false;
  if (hasVerifiedCompletion(plan, job)) return false;
  if (jobHasLiveExecution(job)) return true;
  if (hasTrustedTerminalProof(plan, job)) return false;
  if (dispatchConsentMatches(job)) return true;
  return job.status === "unknown" || job.status === "dispatching";
}

/**
 * 跨成员队列按逻辑服务器统计每卡占用。计入一切仍可能启动/运行/未核实的 job（含 Worker 可自启的
 * queued 与手动已同意 stage=sent 的未核实项，以及经 serialize/restore 洗成 unknown 的持久同意项）
 * ——不得照抄 memoryCounts 排除 queued 的口径，否则同一物理名额会被重复许给另一分支。
 */
export function computeServerOccupancy(queues: Array<{ label: string; queue: DistributedQueue }>,
  aliasOf: (label: string, workerId: string) => string | undefined): OccupancyResult {
  const occupancy = new Map<string, Map<string, number>>();
  const unmapped: OccupancyResult["unmapped"] = [];
  for (const entry of queues) {
    for (const plan of entry.queue.plans) for (const job of plan.jobs) {
      if (!jobOccupiesUnifiedSlot(plan, job)) continue;
      const server = aliasOf(entry.label, job.workerId!);
      if (!server) { unmapped.push({ label: entry.label, workerId: job.workerId!, planId: plan.id, jobIndex: job.index }); continue; }
      const perCard = occupancy.get(server) || new Map<string, number>();
      perCard.set(String(job.gpuId), (perCard.get(String(job.gpuId)) || 0) + 1);
      occupancy.set(server, perCard);
    }
  }
  return { occupancy, unmapped };
}

export type AdmitInput = {
  intents: DispatchIntent[];
  occupancy: Map<string, Map<string, number>>;
  /** worker 别名 → 逻辑服务器；undefined 表示本机当前配置映射不出来（该意图按未就绪拒绝）。 */
  serverOf: (intent: DispatchIntent) => string | undefined;
  /** 服务器 → 现有用户配额策略的已解析设置（quotaSettings 产物）；缺失=策略不可用，全拒。 */
  settingsForServer: (serverKey: string) => { settings: GpuQuotaSettings; rows: any[] } | undefined;
  blockers: string[];
};

/**
 * 逐服务器发放：以 quotaPlacement 的剩余槽位为准（保持现有 gpuJobsPerCard/逐卡 override/
 * gpuMaxConcurrentCards/gpuMinFreeMemoryGb 本义），按稳定顺序逐个发放并把已发意图计入占用，
 * 因此同 GPU 单槽并发申请只会同意一个；不同 GPU/多槽允许多个并行。任何阻断项存在时整批拒绝。
 */
export function admitDispatchIntents(input: AdmitInput): UnifiedAdmissionReceipt {
  const blockers = input.blockers.filter(Boolean);
  const approved: DispatchIntent[] = [];
  const denied: DeniedIntent[] = [];
  const ordered = [...input.intents].sort((a, b) => a.planId.localeCompare(b.planId) || a.jobIndex - b.jobIndex || a.commandId.localeCompare(b.commandId));
  if (blockers.length) {
    for (const intent of ordered) denied.push({ ...intent, reason: `统一派发域存在阻断项：${blockers.join("；")}` });
    return { dispatchAdmission: true, intents: ordered.length, approved, denied, blockers };
  }
  const granted = new Map<string, Map<string, number>>();
  const countsFor = (serverKey: string): Map<string, number> => {
    let live = granted.get(serverKey);
    if (!live) {
      live = new Map(input.occupancy.get(serverKey) || []);
      granted.set(serverKey, live);
    }
    return live;
  };
  for (const intent of ordered) {
    const serverKey = input.serverOf(intent);
    if (!serverKey) { denied.push({ ...intent, reason: `本机配置无法把 Worker「${intent.workerId}」映射为已配置的服务器身份；该分支未就绪，不猜测、不探测。` }); continue; }
    const placement = input.settingsForServer(serverKey);
    if (!placement) { denied.push({ ...intent, reason: `服务器 ${serverKey} 缺少已登记的统一配额策略；请先刷新统一策略。` }); continue; }
    const counts = countsFor(serverKey);
    // 块B返修（D）：自占用身份的再申请只借自己那 1 个名额——检查前临时自扣、裁定后立刻恢复：
    // 获批＝计数保持原值（其盘上预留本就该计 1，不额外 +1），被拒＝恢复原值。逐意图、不整批预扣，
    // 同批其它意图与后续申请看到的占用永不含"被临时腾出的卡"。
    const selfSlot = intent.selfReserved === true && (counts.get(intent.gpuId) || 0) > 0;
    if (selfSlot) counts.set(intent.gpuId, (counts.get(intent.gpuId) || 0) - 1);
    const { slots, limits } = quotaPlacement(placement.rows, counts, placement.settings);
    if (slots.includes(intent.gpuId)) {
      counts.set(intent.gpuId, (counts.get(intent.gpuId) || 0) + 1);
      approved.push(intent);
      continue;
    }
    if (selfSlot) counts.set(intent.gpuId, (counts.get(intent.gpuId) || 0) + 1);
    const limit = limits[intent.gpuId];
    const inUse = counts.get(intent.gpuId) || 0;
    const reason = limit === undefined
      ? `服务器 ${serverKey} 当前 GPU 遥测未见卡 ${intent.gpuId}（离线或配置已变）；留在本地等待重新核实。`
      : inUse >= limit
        ? `服务器 ${serverKey} GPU ${intent.gpuId} 的每卡配额已满（${inUse}/${limit}）；留在本地队列等待。`
        : `服务器 ${serverKey} 达到并发用卡上限或该卡暂不满足最低空闲显存要求；留在本地队列等待。`;
    denied.push({ ...intent, reason });
  }
  return { dispatchAdmission: true, intents: ordered.length, approved, denied, blockers };
}

function deniedResetFields(denied: DeniedIntent): Partial<QueuedJob> {
  // 与 resetUnsentDispatch 同形：pending + 保留 commandId 为 nextCommandId（同命令重试不换新身份），
  // 并清掉所有会伪装“已启动”的观察字段；绝不伪造发送或释放。准入拒绝＝该身份从未获得名额，
  // 同命令重试将来可重新申请，故持久同意事实（若存在同身份残留）一并剥除。
  return { status: "pending", workerId: undefined, gpuId: undefined, commandId: undefined, startIntent: undefined,
    dispatchConsent: undefined,
    runKey: undefined, lastDispatchAttemptAt: undefined, executionState: undefined, statusQueryError: undefined,
    lastObservedAt: undefined, nextCommandId: denied.commandId, blockReason: "统一派发等待配额：" + denied.reason };
}

/**
 * P0-1：获批意图在即将落盘的队列上写入紧凑持久事实（plan/job/attempt/command/worker/GPU 精确一致）。
 * 只写仍处该申请身份的 job；发送守卫、同命令去重与跨项目占位从此共用同一份落盘事实，
 * native 投影清空/窗口重开/查询未知都无法把它洗成零占位。
 */
export function attachApprovedDispatchConsent(queue: DistributedQueue, approved: DispatchIntent[], now = new Date().toISOString()): DistributedQueue {
  if (!approved.length) return queue;
  return { ...queue, plans: queue.plans.map((plan) => {
    const rows = approved.filter((row) => row.planId === plan.id);
    if (!rows.length) return plan;
    return { ...plan, jobs: plan.jobs.map((job) => {
      const hit = rows.find((row) => job.index === row.jobIndex && job.attempt === row.attempt && job.commandId === row.commandId
        && job.workerId === row.workerId && String(job.gpuId ?? "") === row.gpuId);
      if (!hit) return job;
      // 块B返修：获批身份保留 trace、清除旧的"上次未通过"原因（不伪造同意——同意只来自 dispatchConsent）。
      const nextTrace = approvedTrace(job, hit);
      // 旧同意只有与该 job（＝hit）命令+worker+GPU 完整一致时保留原 agreedAt；
      // 同 command 换 worker/GPU 的新批准必须用本次完整身份替换磁盘同意，否则内存/磁盘两套事实、守卫永拒。
      if (job.dispatchConsent && dispatchConsentMatches(job) && job.dispatchConsent.commandId === hit.commandId)
        return traceOf(job) && !traceOf(job)!.reason ? job : { ...job, dispatchAdmissionTrace: nextTrace };
      return { ...job, dispatchConsent: { commandId: hit.commandId, workerId: hit.workerId, gpuId: hit.gpuId, agreedAt: now }, dispatchAdmissionTrace: nextTrace };
    }) };
  }) };
}

function approvedTrace(job: QueuedJob, hit: DispatchIntent): DispatchAdmissionTrace {
  const prior = traceOf(job);
  if (prior && traceIdentityEquals(prior, hit.commandId, hit.workerId, hit.gpuId) && !prior.reason) return prior;
  return { schemaVersion: 1, commandId: hit.commandId, workerId: hit.workerId, gpuId: hit.gpuId };
}

/** 原地版本：把同意事实同步回调用方内存队列（与落盘对象保持同一份事实）。 */
export function syncApprovedConsentInPlace(liveQueue: DistributedQueue | undefined, approved: DispatchIntent[], now = new Date().toISOString()): void {
  if (!liveQueue || !approved.length) return;
  for (const plan of liveQueue.plans) {
    const rows = approved.filter((row) => row.planId === plan.id);
    if (!rows.length) continue;
    for (const job of plan.jobs) {
      const hit = rows.find((row) => job.index === row.jobIndex && job.attempt === row.attempt && job.commandId === row.commandId
        && job.workerId === row.workerId && String(job.gpuId ?? "") === row.gpuId);
      if (hit) {
        // 与磁盘副本同一规则：旧同意与该 job（＝hit）完整一致才保留原 agreedAt；否则按本次获批完整身份替换。
        if (!(job.dispatchConsent && dispatchConsentMatches(job) && job.dispatchConsent.commandId === hit.commandId))
          job.dispatchConsent = { commandId: hit.commandId, workerId: hit.workerId, gpuId: hit.gpuId, agreedAt: now };
        // 块B返修：内存观测面与落盘同一事务——获批即清"上次未通过"原因，保留追踪身份。
        job.dispatchAdmissionTrace = approvedTrace(job, hit);
      }
    }
  }
}

function deniedTrace(job: QueuedJob, denied: DeniedIntent): DispatchAdmissionTrace {
  const prior = traceOf(job);
  if (prior && traceIdentityEquals(prior, denied.commandId, denied.workerId, denied.gpuId)) return { ...prior, reason: denied.reason };
  return { schemaVersion: 1, commandId: denied.commandId, workerId: denied.workerId, gpuId: denied.gpuId, reason: denied.reason };
}

/** 自占用拒绝所需的基线快照：同一事务已持有的盘上队列里精确匹配（plan/job/attempt/command/worker/GPU）的原 job。 */
function deniedBaselineJob(baseline: DistributedQueue | undefined, denied: DeniedIntent): QueuedJob | undefined {
  if (!baseline) return undefined;
  const basePlan = baseline.plans.find((row) => row.id === denied.planId);
  const baseJob = basePlan?.jobs.find((row) => row.index === denied.jobIndex && row.attempt === denied.attempt);
  if (!baseJob || String(baseJob.commandId || "") !== denied.commandId || String(baseJob.workerId || "") !== denied.workerId
    || String(baseJob.gpuId ?? "") !== denied.gpuId) return undefined;
  return baseJob;
}

function applyDeniedToJob(job: QueuedJob, plan: QueuedPlan, denied: DeniedIntent, baseline: DistributedQueue | undefined): QueuedJob | undefined {
  if (job.index !== denied.jobIndex || job.attempt !== denied.attempt || job.commandId !== denied.commandId) return undefined;
  if (job.status !== "dispatching") return undefined;
  if (denied.selfReserved) {
    // 块B返修（E）：盘上已持该精确完整身份并实占自己一个名额的再申请被拒＝恢复盘上原快照
    // （unknown/命令/worker/GPU/startIntent/放置原样，绝不用本次待发送副本冒充"正在派发"），
    // 只补记本次原因（trace 持久 + 内存观察）；无可信基线快照即拒绝写入，不猜。
    const snapshot = deniedBaselineJob(baseline, denied);
    if (!snapshot) throw new Error("统一派发准入：自占用再申请被拒但本事务缺少该身份的可信盘上基线快照，拒绝写入（不猜测、不发送）。");
    const restored = JSON.parse(JSON.stringify(snapshot)) as QueuedJob;
    restored.blockReason = "统一派发等待配额：" + denied.reason;
    restored.dispatchAdmissionTrace = deniedTrace(snapshot, denied);
    return restored;
  }
  const fields: Partial<QueuedJob> = { ...deniedResetFields(denied), dispatchAdmissionTrace: deniedTrace(job, denied) };
  if (denied.manual) {
    // 手动/服务器队列：保留用户选定的 worker/GPU 放置，回到 stage=ready 等下一次统一准入。
    const placement = job.manualDispatch;
    if (placement) return { ...job, ...fields, manualDispatch: { ...placement, stage: "ready" },
      manualDispatchNotice: "已在统一队列中等待配额，保留所选服务器/GPU。" };
  }
  return { ...job, ...fields };
}

/**
 * 把被拒意图从队列里剥回本地等待态（纯函数；用于即将序列化的最终队列对象）。
 * baseline＝本事务已持有的盘上基线队列（同一 diskCurrent）：自占用再申请被拒时据此恢复原快照，
 * 不重新读盘、不另造账本；非自占用拒绝不需要基线。
 */
export function applyDeniedIntents(queue: DistributedQueue, denied: DeniedIntent[], baseline?: DistributedQueue): DistributedQueue {
  if (!denied.length) return queue;
  return { ...queue, plans: queue.plans.map((plan) => {
    const rows = denied.filter((row) => row.planId === plan.id);
    if (!rows.length) return plan;
    return { ...plan, jobs: plan.jobs.map((job) => {
      for (const deniedRow of rows) {
        const reset = applyDeniedToJob(job, plan, deniedRow, baseline);
        if (reset) return reset;
      }
      return job;
    }) };
  }) };
}

/**
 * 同一拒绝同步回调用方在内存里持有的队列对象（调用方发送循环与后续 save 继续用它）。
 * 逐对象定位后原地改写，避免“盘上已剥回、内存还写着 dispatching”的分裂状态。
 */
export function syncDeniedIntentsInPlace(liveQueue: DistributedQueue | undefined, denied: DeniedIntent[], baseline?: DistributedQueue): void {
  if (!liveQueue || !denied.length) return;
  for (const plan of liveQueue.plans) {
    const rows = denied.filter((row) => row.planId === plan.id);
    if (!rows.length) continue;
    for (const job of plan.jobs) for (const deniedRow of rows) {
      if (job.index !== deniedRow.jobIndex || job.attempt !== deniedRow.attempt || job.commandId !== deniedRow.commandId || job.status !== "dispatching") continue;
      const reset = applyDeniedToJob(job, plan, deniedRow, baseline);
      if (!reset) continue;
      // 原地保留对象身份（发送循环/后续 save 继续持引用），但字段集合必须等于恢复结果：
      // 自占用拒绝＝盘上快照＋本次原因，本次副本新增的字段（如新 startIntent 时间戳）不得存活。
      for (const key of Object.keys(job)) if (!Object.prototype.hasOwnProperty.call(reset, key)) delete (job as unknown as Record<string, unknown>)[key];
      Object.assign(job, reset);
    }
  }
}

/* ------------------------------------------------------------------ 策略/别名快照 */

export const UNIFIED_POLICY_FILE_NAME = "unified-dispatch-policy.json";
export const UNIFIED_SERVER_MAP_FILE_NAME = "unified-dispatch-servers.json";
export const UNIFIED_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

export type UnifiedPolicy = { schemaVersion: 1; savedAt: string; savedFromRoot: string;
  servers: Record<string, { workerId: string; inputs: UnifiedPolicyInputs }> };
export type UnifiedPolicyInputs = { global: Record<string, unknown>; worker: Record<string, unknown> };
export type UnifiedServerMap = { schemaVersion: 1; savedAt: string;
  roots: Record<string, { savedAt: string; aliases: Record<string, string> }> };

/** 配额策略的原始输入（未经 telemetry 迁移的输出比较会产生假漂移，必须比输入）。 */
export function buildPolicyInputs(globalConfig: Record<string, unknown>, workerConfig: Record<string, unknown>): UnifiedPolicyInputs {
  const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
  return { global: pick(globalConfig, ["gpuJobsPerCard", "gpuMinFreeMemoryGb"]),
    worker: pick(workerConfig, ["gpuQuotaConfigured", "gpuMemoryRatioEnabled", "gpuJobsPerCard", "gpuMinFreeMemoryGb", "gpuCardOverrides", "gpuMaxConcurrentCards"]) };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const entries = Object.keys(value as Record<string, unknown>).sort().map((key) => JSON.stringify(key) + ":" + stableStringify((value as Record<string, unknown>)[key]));
  return "{" + entries.join(",") + "}";
}

export function policyInputsDrift(existing: UnifiedPolicyInputs | undefined, current: UnifiedPolicyInputs): boolean {
  if (!existing) return true;
  return stableStringify(existing) !== stableStringify(current);
}

export type PolicyMergeResult = { policy: UnifiedPolicy; conflicts: string[] };

/**
 * 登记/刷新时的合并。默认（自动登记）：已有服务器条目输入不同即记冲突并保留原条目
 * （漂移会在准入时如实阻断）。P1-3：replaceKeys=用户在预览确认后显式核实的服务器——
 * 这些条目按当前配置替换（只替换核实目标，绝不暗改其它窗口登记的条目）。
 */
export function mergePolicyServers(existing: UnifiedPolicy | null, incoming: UnifiedPolicy, replaceKeys: string[] = []): PolicyMergeResult {
  const servers: UnifiedPolicy["servers"] = { ...(existing?.servers || {}) };
  const conflicts: string[] = [];
  const replace = new Set(replaceKeys);
  for (const [key, row] of Object.entries(incoming.servers)) {
    const prior = servers[key];
    if (!prior || replace.has(key)) { servers[key] = row; continue; }
    if (policyInputsDrift(prior.inputs, row.inputs)) conflicts.push(`服务器 ${key} 已有策略快照与当前配置不同（保留原快照；如需换策略请显式刷新统一策略）`);
  }
  return { policy: { schemaVersion: 1, savedAt: existing?.savedAt || incoming.savedAt, savedFromRoot: existing?.savedFromRoot || incoming.savedFromRoot, servers }, conflicts };
}

/** 快照条目的稳定指纹：用于“写前再核”（预览时看到的条目必须仍然未被并发修改）。 */
export function policyEntryDigest(entry: unknown): string {
  return stableStringify(entry ?? null);
}

export function mergeServerMapRoots(existing: UnifiedServerMap | null, rootKey: string, aliases: Record<string, string>, now: string): UnifiedServerMap {
  const roots = { ...(existing?.roots || {}) };
  roots[rootKey] = { savedAt: now, aliases };
  return { schemaVersion: 1, savedAt: now, roots };
}

/** 只接受形状正确的快照；损坏/未知结构按 corrupt 处理，绝不当空表放行。 */
export function parseUnifiedPolicy(text: string): UnifiedPolicy | "corrupt" | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.servers !== "object" || parsed.servers === null || Array.isArray(parsed.servers)) return "corrupt";
    for (const [key, row] of Object.entries(parsed.servers as Record<string, any>)) {
      if (!key || !row || typeof row !== "object" || typeof row.workerId !== "string" || !row.inputs || typeof row.inputs !== "object") return "corrupt";
    }
    return parsed as UnifiedPolicy;
  } catch { return "corrupt"; }
}

export function parseUnifiedServerMap(text: string): UnifiedServerMap | "corrupt" | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.roots !== "object" || parsed.roots === null || Array.isArray(parsed.roots)) return "corrupt";
    for (const row of Object.values(parsed.roots as Record<string, any>))
      if (!row || typeof row !== "object" || !row.aliases || typeof row.aliases !== "object" || Array.isArray(row.aliases)) return "corrupt";
    return parsed as UnifiedServerMap;
  } catch { return "corrupt"; }
}
