import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// 批次冻结的隔离区删除审核账本 v2（契约 batch-ledger-contract-v1 + r17 独立复审裁决）。
// 语义：入口一次冻结「canonical project/root + 完整初始 PLAN 集合 + 批次 ID」；初始集合不随合并/迟到回执扩展。
// 隔离事实只引用本批已核实完成（completed token）的隔离 operation；同一 operation 的目标集合与 revision/
// codeFingerprint 首写冻结：完全相同幂等，冲突拒绝并保留原记录；新 operation 只能来自本批登记事实。
// 启动证明（父 2026-10-22 裁决）：只有「已登记轮询观察到的原生 running」或「队列粘性原生证明
// （worker 快照匹配任务+物理窗口/执行中，四类查询错误全空）」算本批新执行的启动证明；
// queued/dispatching/pending 是本机意图，completed/failed/cancelled 等终态不得反推启动。
// 逐 job 证明一旦核实即持久入账（先证先存），不等其它 job 同时新鲜；提交链仍不等 GPU/训练完成。
// 存储安全：独占创建锁；只允许创建者在工作结束后释放，绝不自动摘取别人的锁。
// 崩溃或旧协议遗留锁保留原字节，快速 fail closed；TTL、PID 和主机名只作诊断，不能证明可摘锁。
// 因此复核与写盘之间没有另一个合规进程能回收本锁；进程内链不承担跨进程互斥。
// 独立永久删除审核（下一切片）只允许引用这里冻结的 cleanup operation；账本不可读时入口一律关闭。

export type IsolatedFrozenTarget = { nodeId: string; host: string; sourceRelativePath: string; isolationRelativePath: string; archiveBatch?: string };
export type IsolatedCleanupRecord = { cleanupOperationId: string; targets: IsolatedFrozenTarget[] };
export type IsolatedPlanState = "frozen" | "awaiting_dispatch" | "dispatched" | "void" | "unknown";
export type IsolatedStartupProof = { observedAt: string; workerId: string; source: string };
export type IsolatedQueueJobIdentity = { jobIndex: number; expectedCommandId: string; proof?: IsolatedStartupProof };
export type IsolatedFrozenPlan = { planFile: string; submissionOperationId: string; revision: string; codeFingerprint: string;
  state: IsolatedPlanState; cleanup: IsolatedCleanupRecord[]; queuePlanId?: string; jobs?: IsolatedQueueJobIdentity[] };
export type IsolatedFrozenBatch = { batchId: string; projectRoot: string; canonicalProjectId?: string; frozenAt: string; plans: IsolatedFrozenPlan[] };
export type IsolatedReviewEvent = { eventId: string; cleanupOperationId: string; reviewOperationId?: string;
  kind: "opened" | "preview" | "confirmed1" | "confirmed2" | "executing" | "completed" | "busy" | "failed" | "cancelled" | "unknown";
  at: string; detail?: string };
export type ReviewedIsolatedBatch = IsolatedFrozenBatch & { reviews?: IsolatedReviewEvent[] };

export const LEDGER_CORRUPT = "ISOLATED_BATCH_LEDGER_CORRUPT";
export const LEDGER_LOCK_LOST = "ISOLATED_BATCH_LEDGER_LOCK_LOST";
export class IsolatedBatchLedgerCorruptError extends Error {
  detail: string;
  constructor(detail: string) { super(`${LEDGER_CORRUPT}：账本内容不可核实，保留原文件且不覆盖、不视为空；隔离区删除审核入口保持关闭（${detail}）。`); this.detail = detail; }
}

const LEDGER_VERSION = 2;
const STATE_RANK: Record<IsolatedPlanState, number> = { frozen: 0, unknown: 0, awaiting_dispatch: 1, void: 2, dispatched: 2 };
const TERMINAL_STATES: IsolatedPlanState[] = ["void", "dispatched"];

function validTarget(row: any): boolean {
  return !!row && typeof row.nodeId === "string" && typeof row.sourceRelativePath === "string" && typeof row.isolationRelativePath === "string";
}
function validPlan(row: any): row is IsolatedFrozenPlan {
  return !!row && typeof row.planFile === "string" && typeof row.submissionOperationId === "string"
    && typeof row.revision === "string" && typeof row.codeFingerprint === "string"
    && typeof row.state === "string" && Object.hasOwn(STATE_RANK, row.state) && Array.isArray(row.cleanup)
    && row.cleanup.every((entry: any) => !!entry && typeof entry.cleanupOperationId === "string" && Array.isArray(entry.targets) && entry.targets.every(validTarget))
    && (row.jobs === undefined || (Array.isArray(row.jobs) && row.jobs.every((job: any) => !!job && Number.isInteger(job.jobIndex)
      && typeof job.expectedCommandId === "string"
      && (job.proof === undefined || (!!job.proof && typeof job.proof.observedAt === "string" && typeof job.proof.workerId === "string" && typeof job.proof.source === "string")))));
}
function validBatch(row: any): row is IsolatedFrozenBatch {
  return !!row && typeof row.batchId === "string" && typeof row.projectRoot === "string" && typeof row.frozenAt === "string"
    && Array.isArray(row.plans) && row.plans.every(validPlan)
    && (row.reviews === undefined || Array.isArray(row.reviews) && row.reviews.every((event: any) => event
      && typeof event.eventId === "string" && typeof event.cleanupOperationId === "string" && typeof event.at === "string"
      && ["opened","preview","confirmed1","confirmed2","executing","completed","busy","failed","cancelled","unknown"].includes(event.kind)));
}

/** 读取账本：文件缺失=正常空态；JSON/版本/结构不可核实=抛错并保留原字节（调用方禁止随后写盘）。 */
export async function loadIsolatedBatchLedger(file: string): Promise<IsolatedFrozenBatch[]> {
  let rawText: string;
  try { rawText = await fs.readFile(file, "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return []; throw new IsolatedBatchLedgerCorruptError(String(error?.message || error)); }
  let raw: any;
  try { raw = JSON.parse(rawText); }
  catch { throw new IsolatedBatchLedgerCorruptError("JSON 解析失败"); }
  if (!raw || raw.version !== LEDGER_VERSION || !Array.isArray(raw.batches) || !raw.batches.every(validBatch))
    throw new IsolatedBatchLedgerCorruptError("版本或结构不符合可核实形状");
  return raw.batches as IsolatedFrozenBatch[];
}

/** 原子写：临时文件 fsync + rename + 尽力目录 fsync；带 fence 时 rename 前复核锁 token，失主拒绝且不碰原文件。 */
export async function saveIsolatedBatchLedger(file: string, batches: IsolatedFrozenBatch[], fence: { lockPath: string; token: string }): Promise<void> {
  if (!fence?.lockPath || !fence.token) throw new Error(LEDGER_LOCK_LOST);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx");
  try {
    await handle.writeFile(JSON.stringify({ version: LEDGER_VERSION, batches }), "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  if (fence) {
    let ownerToken: unknown;
    try { ownerToken = JSON.parse(await fs.readFile(fence.lockPath, "utf8"))?.token; } catch { ownerToken = undefined; }
    if (ownerToken !== fence.token) {
      // Preserve the uncommitted temporary bytes as evidence; never clean an
      // absolute path after ownership was lost.
      throw new Error(`${LEDGER_LOCK_LOST}：写盘前复核发现账本锁已易主；本轮零写入，原文件保持原样，审核入口本回合关闭。`);
    }
  }
  await fs.rename(temp, file);
  try { const dir = await fs.open(path.dirname(file), "r"); try { await dir.sync(); } finally { await dir.close(); } }
  catch { /* 目录 fsync 平台不支持时忽略；rename 已原子落盘 */ }
}

// 跨进程锁：open(wx) 是唯一取得所有权的边界。持有期间任何竞争者都不得移动/删除锁。
// 不自动恢复遗留锁：无法证明原 owner 身份时牺牲本轮审核可用性，不能牺牲互斥性。
const localChains = new Map<string, Promise<unknown>>();
const LOCK_TTL_MS = 15_000, LOCK_RETRY_MS = 20, LOCK_WAIT_MS = 600;
const lockHost = os.hostname();
const releaseOwnedLock = promisify(execFile);
const releaseScript = `
const fs=require('node:fs'),path=require('node:path');
const [parent,leaf,device,inode,token]=process.argv.slice(1);
const deny=code=>{throw new Error(code)};
if(!leaf||leaf!==path.basename(leaf)||leaf==='.'||leaf==='..')deny('PARENT_CD_FAILED');
if(fs.realpathSync(parent)!==parent)deny('PARENT_CD_FAILED');
process.chdir(parent);
const st=fs.statSync('.');
if(fs.realpathSync(process.cwd())!==parent||String(st.dev)!==device||String(st.ino)!==inode)deny('PARENT_CD_FAILED');
const target='./'+leaf,entry=fs.lstatSync(target);
if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1||entry.dev!==st.dev)deny('ISOLATED_BATCH_LEDGER_LOCK_LOST');
if(JSON.parse(fs.readFileSync(target,'utf8')).token!==token)deny('ISOLATED_BATCH_LEDGER_LOCK_LOST');
fs.unlinkSync(target);
`;
async function acquireLedgerLock(lockPath: string): Promise<{ token: string; release: () => Promise<void> }> {
  const token = randomUUID();
  const parent = path.dirname(lockPath), parentIdentity = await fs.stat(parent);
  const acquireStarted = Date.now();
  for (;;) {
    let created = false;
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ token, host: lockHost, pid: process.pid,
          acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString() }), "utf8");
        await handle.sync();
        created = true;
      } finally { await handle.close(); }
    } catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    if (created) return { token, release: async () => {
      // 先核对再释放；在本协议中其他进程没有摘锁权限，因此不存在回收者插入窗口。
      // A short file utility has its own cwd; the extension's cwd never changes.
      // It checks the physical parent and exact owner, then unlinks ./leaf only.
      await releaseOwnedLock(process.execPath, ["-e", releaseScript, parent, path.basename(lockPath),
        String(parentIdentity.dev), String(parentIdentity.ino), token], { cwd: parent, windowsHide: true,
        timeout: 2000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    } };
    if (Date.now() >= acquireStarted + LOCK_WAIT_MS)
      throw new Error("ISOLATED_BATCH_LEDGER_LOCKED：账本锁仍在位；活锁、遗留锁或未知身份均保留，不自动摘取，审核入口本回合关闭。");
    await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

/** 账本临界区：先进程内链（同实例重入），再跨进程 CAS 锁；锁内写盘一律带 token fencing。 */
export function withIsolatedBatchLedger<T>(file: string, work: (fence: { lockPath: string; token: string }) => Promise<T>): Promise<T> {
  const step = async (): Promise<T> => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const parent = await fs.realpath(path.dirname(file));
    const physicalFile = path.join(parent, path.basename(file));
    const lockPath = `${physicalFile}.lock`;
    const lock = await acquireLedgerLock(lockPath);
    try { return await work({ lockPath, token: lock.token }); } finally { await lock.release(); }
  };
  const key = path.resolve(file);
  const previous = localChains.get(key) ?? Promise.resolve();
  const running = previous.then(step, step);
  localChains.set(key, running.then(() => undefined, () => undefined));
  return running;
}

function planKey(row: { planFile: string; submissionOperationId: string }): string {
  return `${row.planFile}\0${row.submissionOperationId}`;
}
function cloneBatch(batch: IsolatedFrozenBatch): IsolatedFrozenBatch {
  return { ...batch, plans: batch.plans.map(plan => ({ ...plan,
    cleanup: plan.cleanup.map(entry => ({ ...entry, targets: entry.targets.map(t => ({ ...t })) })),
    jobs: plan.jobs?.map(job => ({ ...job, proof: job.proof ? { ...job.proof } : undefined })) })) };
}
function sameTarget(a: IsolatedFrozenTarget, b: IsolatedFrozenTarget): boolean {
  return a.nodeId === b.nodeId && (a.host || "") === (b.host || "") && a.sourceRelativePath === b.sourceRelativePath && a.isolationRelativePath === b.isolationRelativePath
    && (a.archiveBatch || "") === (b.archiveBatch || "");
}
function sameTargets(a: IsolatedFrozenTarget[], b: IsolatedFrozenTarget[]): boolean {
  return a.length === b.length && a.every(left => b.some(right => sameTarget(left, right)));
}

/** 锁内合并（导出 API）：只增未见过的批次；绝不扩初始集合；void/dispatched 终局永不改写；
 * 同 cleanupOperationId 目标集不借合并扩张；jobs 仅缺失时补齐。 */
export function mergeIsolatedBatches(existing: IsolatedFrozenBatch[], incoming: IsolatedFrozenBatch[]): IsolatedFrozenBatch[] {
  const out = existing.map(cloneBatch);
  for (const batch of incoming) {
    const target = out.find(entry => entry.batchId === batch.batchId);
    if (!target) { out.push(cloneBatch(batch)); continue; }
    if (target.projectRoot !== batch.projectRoot || target.canonicalProjectId !== batch.canonicalProjectId
      || target.plans.length !== batch.plans.length || !target.plans.every(plan => batch.plans.some(row => planKey(row) === planKey(plan))))
      throw new Error("ISOLATED_BATCH_SCOPE_CONFLICT：合并输入与冻结项目或完整初始集合不一致。");
    for (const plan of batch.plans) {
      const current = target.plans.find(entry => planKey(entry) === planKey(plan))!;
      const frozenRecords = new Map(current.cleanup.map(record => [record.cleanupOperationId, record]));
      for (const record of plan.cleanup) {
        const seen = frozenRecords.get(record.cleanupOperationId);
        if (seen && !sameTargets(seen.targets, record.targets)) throw new Error("ISOLATED_OPERATION_TARGET_CONFLICT");
        if (!seen) frozenRecords.set(record.cleanupOperationId, record);
      }
      if (TERMINAL_STATES.includes(current.state)) continue; // void/dispatched 不回退、不复活
      if (plan.state === "void") current.state = "void";
      else if (plan.state === "awaiting_dispatch" && STATE_RANK[plan.state] > STATE_RANK[current.state]) current.state = plan.state;
      // dispatched 只能由账本内部逐 job 证明产生，合并输入无权授予。
      if (plan.queuePlanId && !current.queuePlanId) current.queuePlanId = plan.queuePlanId;
      if (plan.jobs?.length && !current.jobs?.length) current.jobs = plan.jobs.map(job => ({ ...job, proof: job.proof ? { ...job.proof } : undefined }));
      for (const record of plan.cleanup) {
        const seen = current.cleanup.find(entry => entry.cleanupOperationId === record.cleanupOperationId);
        if (!seen) current.cleanup.push({ ...record, targets: record.targets.map(t => ({ ...t })) });
        // 同 operation 目标首写冻结，冲突已经整体拒绝。
      }
    }
  }
  return out;
}

/** 入口冻结：完整初始 PLAN 集合一次写入；同批重入完全幂等（初始集合以第一次冻结为准，绝不增补）。 */
export async function freezeBatchScope(file: string, batchInfo: { batchId: string; projectRoot: string; canonicalProjectId?: string },
  plans: Array<{ planFile: string; submissionOperationId: string }>): Promise<IsolatedFrozenBatch> {
  if (!batchInfo.batchId || !plans.length) throw new Error("批次冻结需要批次身份与非空初始 PLAN 集合。");
  return withIsolatedBatchLedger(file, async fence => {
    const batches = await loadIsolatedBatchLedger(file);
    let batch = batches.find(entry => entry.batchId === batchInfo.batchId);
    if (!batch) {
      batch = { batchId: String(batchInfo.batchId), projectRoot: String(batchInfo.projectRoot || ""),
        canonicalProjectId: batchInfo.canonicalProjectId ? String(batchInfo.canonicalProjectId) : undefined,
        frozenAt: new Date().toISOString(),
        plans: plans.map(row => ({ planFile: String(row.planFile), submissionOperationId: String(row.submissionOperationId), revision: "", codeFingerprint: "", state: "frozen" as IsolatedPlanState, cleanup: [] })) };
      batches.push(batch);
      await saveIsolatedBatchLedger(file, batches, fence);
    } else if (batch.projectRoot !== batchInfo.projectRoot || batch.canonicalProjectId !== batchInfo.canonicalProjectId
      || batch.plans.length !== plans.length || !plans.every(row => batch!.plans.some(existing => planKey(existing) === planKey(row)))) {
      throw new Error("ISOLATED_BATCH_SCOPE_CONFLICT：同批次项目身份或初始完整集合冲突，保留原记录。");
    }
    return batch;
  });
}

/** 隔离事实：只挂接到本批初始集合内条目；同一 completed operation 的目标集合与 revision/codeFingerprint 首写冻结，
 * 完全相同幂等，冲突整体拒绝并保留原记录；新 operation 只追加不改动既有记录。 */
export async function attachIsolatedCleanup(file: string, batchInfo: { batchId: string },
  row: { submissionOperationId: string; planFile: string; revision: string; codeFingerprint: string; runReplacement: any }): Promise<boolean> {
  const state = row.runReplacement || {};
  const completed = Array.isArray(state.completed) ? state.completed : [];
  const records: IsolatedCleanupRecord[] = (Array.isArray(state.previews) ? state.previews : [])
    .map((entry: any) => entry?.preview)
    .filter((preview: any) => preview && completed.includes(preview.token) && Array.isArray(preview.rows))
    .map((preview: any) => ({ cleanupOperationId: String(preview.token),
      targets: (preview.rows || []).filter((entry: any) => entry.disposition === "isolate" && entry.relativePath && entry.destination)
        .map((entry: any) => ({ nodeId: String(entry.node?.id || ""), host: String(entry.node?.host || ""),
          sourceRelativePath: String(entry.relativePath), isolationRelativePath: String(entry.destination),
          ...(entry.archiveBatch ? { archiveBatch: String(entry.archiveBatch) } : {}) })) }))
    .filter((entry: IsolatedCleanupRecord) => entry.cleanupOperationId && entry.targets.length);
  return withIsolatedBatchLedger(file, async fence => {
    const batches = await loadIsolatedBatchLedger(file);
    const batch = batches.find(entry => entry.batchId === batchInfo.batchId);
    const plan = batch?.plans.find(entry => entry.submissionOperationId === row.submissionOperationId && entry.planFile === row.planFile);
    if (!plan) return false; // 不在本批初始集合：别批/迟到记录绝不混入
    if (plan.revision && plan.revision !== String(row.revision || "")) return false; // 首写冻结的 revision 冲突：拒收保留
    if (plan.codeFingerprint && plan.codeFingerprint !== String(row.codeFingerprint || "")) return false;
    for (const record of records) {
      if (records.some(other => other.cleanupOperationId === record.cleanupOperationId && !sameTargets(other.targets, record.targets))) return false;
      const seen = plan.cleanup.find(entry => entry.cleanupOperationId === record.cleanupOperationId);
      if (seen && !sameTargets(seen.targets, record.targets)) return false; // 同一隔离 operation 目标集不可扩：整体拒收
    }
    let changed = false;
    if (!plan.revision && String(row.revision || "")) { plan.revision = String(row.revision); changed = true; }
    if (!plan.codeFingerprint && String(row.codeFingerprint || "")) { plan.codeFingerprint = String(row.codeFingerprint); changed = true; }
    for (const record of records)
      if (!plan.cleanup.some(entry => entry.cleanupOperationId === record.cleanupOperationId)) {
        plan.cleanup.push({ ...record, targets: record.targets.map(t => ({ ...t })) }); changed = true;
      }
    if (changed) await saveIsolatedBatchLedger(file, batches, fence);
    return true;
  });
}

/** 提交终局（首写为准，幂等不回退）：committed+真实卡身份→awaiting_dispatch；失败/取消→void；其余 unknown。 */
export async function markPlanTerminal(file: string, batchInfo: { batchId: string }, terminal: {
  submissionOperationId: string; planFile: string; status: "committed" | "failed" | "cancelled" | "unknown";
  identity?: { queuePlanId: string; jobs: IsolatedQueueJobIdentity[] } }): Promise<void> {
  return withIsolatedBatchLedger(file, async fence => {
    const batches = await loadIsolatedBatchLedger(file);
    const plan = batches.find(entry => entry.batchId === batchInfo.batchId)?.plans
      .find(entry => entry.submissionOperationId === terminal.submissionOperationId && entry.planFile === terminal.planFile);
    if (!plan || plan.state !== "frozen") return; // 迟到/别批/重复回执：不改写已定终局
    if (terminal.status === "failed" || terminal.status === "cancelled") plan.state = "void";
    else if (terminal.status === "committed" && terminal.identity?.queuePlanId && terminal.identity.jobs.length
      && terminal.identity.jobs.every(job => Number.isInteger(job.jobIndex) && typeof job.expectedCommandId === "string")) {
      // 落盘点 commandId 可能尚未由派发链生成（enqueuePlan 只建 pending job）：expectedCommandId 允许空串占位，
      // 由首个被接受的原生证明持久绑定；已知则之后必须严格匹配。
      plan.state = "awaiting_dispatch";
      plan.queuePlanId = terminal.identity.queuePlanId;
      plan.jobs = terminal.identity.jobs.map(job => ({ jobIndex: job.jobIndex, expectedCommandId: String(job.expectedCommandId || "") }));
    } else plan.state = "unknown"; // 没有可核卡片+job 结构的「入队」不足信
    await saveIsolatedBatchLedger(file, batches, fence);
  });
}

export type QueueDispatchObservation = { queuePlanId: string; projectId?: string; jobIndex: number; commandId?: string; workerId?: string;
  status?: string; lastObservedAt?: string; statusQueryError?: string; source?: string; windowSeen?: boolean };

// 只有观察到的 running 才是启动证明；queued/pending/dispatching=本机意图，completed/failed/cancelled=终态，
// 一律不得反推「曾启动」（父 2026-10-22 裁决）。
const PROOF_STATUSES = ["running"];
// 无原生来源证明的观察必须有界新鲜；新鲜窗 60s 为自身推导（对齐队列链 30s 判新 + 一轮 tick 余量）。
const OBSERVATION_FRESH_MS = 60_000;

function startupProofMatched(observation: QueueDispatchObservation, plan: IsolatedFrozenPlan, identity: IsolatedQueueJobIdentity,
  batch: IsolatedFrozenBatch, now: number): boolean {
  if (observation.queuePlanId !== plan.queuePlanId || observation.jobIndex !== identity.jobIndex) return false;
  // 已绑定/已知的期望 commandId 必须严格一致；未绑定（派发链尚未生成）时观察必须自带非空 commandId 以便绑定。
  if (identity.expectedCommandId ? observation.commandId !== identity.expectedCommandId : !observation.commandId) return false;
  if (batch.canonicalProjectId && observation.projectId !== batch.canonicalProjectId) return false;
  if (!observation.workerId || observation.statusQueryError) return false;
  if (!PROOF_STATUSES.includes(String(observation.status || ""))) return false;
  const at = Date.parse(String(observation.lastObservedAt || ""));
  if (!Number.isFinite(at) || now - at < 0) return false;
  if (!(observation.source === "worker_snapshot_task_l2" && observation.windowSeen === true)
    && now - at > OBSERVATION_FRESH_MS) return false; // 原生粘性证明可持续补登；普通观察须在新鲜窗内
  return true;
}

/** 每个 PLAN 的首个真实原生启动即达到本 PLAN 边界，不等待所有 seed；逐 job 事实继续持久保存。
 * 新 command 与已绑定身份冲突时撤销旧边界并进入 unknown，不把旧事实授权给新执行。 */
export async function promoteDispatchedPlans(file: string, projectRoot: string, observations: QueueDispatchObservation[],
  now: number = Date.now()): Promise<number> {
  if (!observations.length) return 0;
  return withIsolatedBatchLedger(file, async fence => {
    const batches = await loadIsolatedBatchLedger(file);
    let promoted = 0, changed = false;
    for (const batch of batches.filter(entry => entry.projectRoot && entry.projectRoot === projectRoot)) {
      for (const plan of batch.plans) {
        if (!["awaiting_dispatch", "dispatched"].includes(plan.state) || !plan.queuePlanId || !plan.jobs?.length) continue;
        const changedIdentity = plan.jobs.some(identity => identity.proof && identity.expectedCommandId && observations.some(observation =>
          observation.queuePlanId === plan.queuePlanId && observation.jobIndex === identity.jobIndex
          && observation.projectId === batch.canonicalProjectId && observation.commandId
          && (observation.commandId !== identity.expectedCommandId
            || !!observation.workerId && observation.workerId !== identity.proof!.workerId)));
        if (changedIdentity) {
          plan.state = "unknown";
          for (const identity of plan.jobs) identity.proof = undefined;
          changed = true;
          continue;
        }
        for (const identity of plan.jobs) {
          if (identity.proof) continue; // 已核实事实持久保留，重载/等待后续 GPU 不抹掉
          const matched = observations.find(observation => startupProofMatched(observation, plan, identity, batch, now));
          if (!matched) continue;
          if (!identity.expectedCommandId) identity.expectedCommandId = String(matched.commandId); // 首个原生证明持久绑定
          identity.proof = { observedAt: String(matched.lastObservedAt), workerId: String(matched.workerId),
            source: matched.source ? String(matched.source) : "registered_poll" };
          changed = true;
        }
        if (plan.state !== "dispatched" && plan.jobs.some(job => job.proof)) { plan.state = "dispatched"; promoted += 1; }
      }
    }
    if (changed) await saveIsolatedBatchLedger(file, batches, fence);
    return promoted;
  });
}

/** 审核资格：项目匹配、批次非空、每个初始 PLAN 都 dispatched（frozen/void/unknown/awaiting 一律不合格）、且至少一个隔离目标可审。 */
export function eligibleIsolatedReviews(batches: IsolatedFrozenBatch[], projectRoot: string): IsolatedFrozenBatch[] {
  return batches.filter(batch => batch.projectRoot && batch.projectRoot === projectRoot && batch.plans.length > 0
    && batch.plans.every(plan => plan.state === "dispatched")
    && batch.plans.some(plan => plan.cleanup.length > 0));
}
