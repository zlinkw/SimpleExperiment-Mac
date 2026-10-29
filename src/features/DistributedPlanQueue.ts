import { createHash } from "node:crypto";
import * as path from "node:path";
import { PlanExecutionMode } from "./PlanExecutionMode";
import { observationMatches, taskLifecycle, TaskObservation } from "./TaskLifecycle";
import type { RuntimeDiagnostics, CompletionState } from "./RuntimeDiagnostics";
import { freshTaskObservation } from "./WorkerProgressEvidence";
import { hasVerifiedCompletion, nextVerifiedCompletion, verifiedCompletionProjection, trustedTerminalProofFor, type TrustedTerminalProof, type VerifiedCompletion } from "./VerifiedCompletion";
import { projectStateFile, projectStateId } from "./ProjectStatePaths";
import { budgetEvidence, mergeBudgetEvidence, retainPlanMemoryEstimates, type PlanGpuMemoryEstimates, type GpuBudgetEvidence, type GpuBudgetReservation } from "./GpuMemoryBudget";

export type JobState = "pending" | "dispatching" | "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
export type JobFailureClass = "deterministic" | "resource" | "transient" | "unknown";
export type AutomaticJobRetry = { failureCount: number; failedAttempt: number; retryAt?: string; exhausted?: boolean; lastError?: string;
  failureClass?: JobFailureClass; blockedReason?: string };
export type QueuedJob = {
  gpuMemoryProfile?: GpuBudgetEvidence;
  gpuMemoryReservation?: GpuBudgetReservation;
  gpuMemoryWaitReason?: string;
  index: number;
  case: string;
  seed: number;
  outputDir: string;
  resultPathPolicy?: "declared";
  collectionResultCsv?: string;
  checkpointSource?: Record<string, string>;
  globalJobId?: string;
  /** Zero is the historical schema compatibility sentinel, never an execution version. */
  attempt: number;
  status: JobState;
  lifecycleProtocol?: 2;
  manualDispatch?: { workerId: string; gpuId: string; gpuSelection?: "automatic"; stage: "preparing" | "ready" | "sent"; origin?: "server_queue"; batchId?: string };
  /** User-selected Worker; GPU selection stays in the normal local budgeted queue. */
  automaticWorkerId?: string;
  manualDispatchNotice?: string;
  retainExistingOutputs?: boolean;
  /** r82（0.5.414）job 级显式隔离阻断：旧产物隔离未完成或核验未知——job 保持可见 pending，
   * 但四条派发路径（自动 tick、服务器队列、手动 ready、失败恢复）一律不得派发。
   * 本字段本身不是授权凭证；缺失也不等于"已证明隔离成功"（准入只由本轮隔离结果的结构化
   * blocked 划分）。解除仅发生在用户走既有审核路径、精确声明未变且隔离完成核验通过时，
   * 随接受事务性写回（置 undefined）。传输忙可由当前全节点精确路径不存在证明解除；
   * 投影、历史回执和单纯传输空闲均不得清除。 */
  outputIsolationBlocked?: { reason: string; stage: "preview" | "execute" | "verify"; code?: string; operationId?: string;
    declarationKey: string; observedAt: string; codes?: string[]; busyOnly?: boolean;
    recovery?: { state: "waiting_transfer" | "review_required" | "unknown"; checkedAt: string; nextCheckAt: string; detail?: string } };
  executionState?: string;
  resultState?: string;
  runtimeDiagnostics?: RuntimeDiagnostics;
  completionState?: CompletionState;
  verifiedCompletion?: VerifiedCompletion;
  trustedTerminalProof?: TrustedTerminalProof;
  verificationQueryError?: string;
  exitCode?: number | null;
  statusQueryError?: string;
  lastObservedAt?: string;
  tmuxPane?: string;
  tmuxWindowId?: string;
  tmuxSession?: string;
  /** 本次观察报出的全部查询错误（含 result/runtime），供账本等下游拒绝假证据；空=本轮四类查询都干净。 */
  observationErrors?: string[];
  /** 粘性原生启动证明：worker 快照中身份匹配的任务且物理窗口存在或执行中、四类查询错误全空才置位；
   * 置位后不因后续终态/取消丢失（仅 commandId 换代失效）。终态/取消标记本身绝不反推启动。 */
  nativeStartProof?: { source: "worker_snapshot_task_l2"; commandId: string; workerId: string; observedAt: string; windowSeen: boolean };
  /** Explicit local exclusion of this exact attempt; never a successful result. */
  unavailable?: { identity: string; reason: string; markedAt: string; previousStatus: JobState;
    previousFinishedAt?: string; previousTrustedTerminalStatus?: "completed" | "failed" | "cancelled" };
  projectId?: string;
  actualExecutionMode?: PlanExecutionMode;
  trainingRecovery?: Record<string, unknown>;
  originalExecution?: { status: string; error?: string; mode?: PlanExecutionMode; exitCode?: number };
  /** Exact failed-job manual cleanup; never a whole-PLAN lifecycle change. */
  cleanup?: QueuedPlan["cleanup"];
  recoveryConflict?: boolean;
  trustedTerminalStatus?: "completed" | "failed" | "cancelled";
  runKey?: string;
  workerId?: string;
  gpuId?: string;
  commandId?: string;
  /** Local unresolved start input, never proof that the remote command is running. */
  startIntent?: { commandId: string; workerId: string; gpuId: string };
  /**
   * 块B返修P0-1：本机已同意该精确 job 身份（command/worker/GPU）占用统一派发名额的紧凑持久事实。
   * 它只表示本机占名额，不冒充 Worker 运行态：native 投影清空、窗口重开、查询未知都不释放它；
   * 释放只来自既有证据（确证未发送、准入拒绝剥回、终态/停止证明、已核实完成）。
   * 绝不参与 completionIdentity 或 Worker 协议。
   */
  dispatchConsent?: { commandId: string; workerId: string; gpuId: string; agreedAt: string };
  /**
   * 块B返修：本机统一派发准入对该 job 当前命令身份的紧凑追踪事实（仅本机，非同意、非第二账本）。
   * 每次 dispatchAdmission 保存对"盘上基线→即将写入"的真新意图同事务写入（域未成立/零登记同样写）；
   * 获批保留并清 reason，被拒保留并记本次拒绝原因。守卫绝不因它开绿灯，名额计算不读它；
   * 缺失＝升级前从未经过准入的旧任务（其合法在飞兼容按既有语义）。
   * 绝不参与 completionIdentity 或 Worker 协议。
   */
  dispatchAdmissionTrace?: { schemaVersion: 1; commandId: string; workerId: string; gpuId: string; reason?: string };
  nextCommandId?: string;
  reassignmentPending?: boolean;
  /** The verified migration destination must survive the release RPC and a restart. */
  reassignmentWorkerId?: string;
  lastDispatchAttemptAt?: string;
  dispatchAcknowledgedAt?: string;
  localQueueOnly?: boolean;
  recallRequested?: boolean;
  recallOperationId?: string;
  legacyOwnership?: boolean;
  logPath?: string;
  historyLogIdentity?: { commandId: string; outputDir: string; runId: string };
  error?: string;
  failureDiagnostic?: Record<string, unknown>;
  formalConflictEvidence?: Record<string, unknown>;
  admissionRejection?: { code: string; message: string; rejectedAt: string };
  finishedAt?: string;
  artifacts?: Record<string, string>;
  fragmentWorkerIds?: string[];
  mirroredWorkerIds?: string[];
  artifactError?: string;
  artifactRetryAfter?: string;
  /** 0.2.113 配套：暂存槽卡点结构化证据（schemaVersion 1，白名单净化后持久化）。
   * 仅随 artifactError 失败/成功同写同清；释放执行的完整路径绑定只读本字段，绝不解析错误文本。 */
  artifactStageBlock?: import("./JobArtifactSyncIdentity").JobArtifactStageBlock;
  latestArtifactSync?: { key: string; state: "synced" | "partial" | "excluded"; scopes: string[]; checkedAt: string;
    workerIds?: string[]; error?: string; retryAfter?: string; artifactDigest?: string;
    /** r10：仅 completedJob 同步成功且分类出"只存在于其它端点的历史保留副本"时写入（路径+原因）。 */
    skipped?: string[] };
  outputRetiredAt?: string;
  reconciliationAttempts?: number;
  lastReconciliationAt?: string;
  blockReason?: string;
  stopReason?: string;
  stopIntent?: { commandId: string; workerId: string; requestedAt: string; state: "pending" };
  automaticRetry?: AutomaticJobRetry;
  history?: Array<{ attempt: number; status: JobState; workerId?: string; commandId?: string; outputDir: string; logPath?: string; tmuxSession?: string; finishedAt?: string; stopReason?: string; error?: string; outputRetiredAt?: string; admissionRejection?: QueuedJob["admissionRejection"]; cleanupOperationId?: string }>;
};
export type QueuedPlan = {
  gpuMemoryEstimates?: PlanGpuMemoryEstimates;
  executionSource?: { digest: string; manifest: Record<string, { size: number; sha256: string }> };
  /** 提交时的本机 Git 溯源（分支/HEAD/脏状态/时间；origin 已剥离凭证）。纯本机展示与绑定用，
   * 绝不参与 completionIdentity、job 身份或 Worker 协议。dirty 缺失=当时未知。 */
  gitProvenance?: { schemaVersion?: number; recordedAt?: string; planFile?: string; branch?: string; localCommit?: string; dirty?: boolean; originUrl?: string };
  id: string;
  /** Explicit top-level PLAN identity, retained across a recorded rename. */
  stablePlanId?: string;
  /** Retain ownership even when the activity directory is archived or partly cleared. */
  cleanup?: { operationId: string; state: "archived" | "deleted" | "partial"; completedTargets: string[]; pendingNodes: string[] };
  /** Requested mode, frozen from validation or the identical original PLAN content. */
  executionMode?: PlanExecutionMode;
  resultPathPolicy?: "declared";
  executionModeSource?: "validation" | "matching_plan_revision" | "worker_receipt";
  executionModeBlocked?: boolean;
  schedulingMode?: "local_idle" | "server_prequeue";
  localDispatchOverride?: boolean;
  prequeueWeights?: Record<string, number>;
  projectId?: string;
  planJobCount?: number;
  /** Full validation count, even when this submission only fills missing jobs. */
  fullPlanJobCount?: number;
  remoteAcceptedJobCount?: number;
  recoveryMissingCount?: number;
  /** Confirmed removal is accounted for without inventing a remote receipt. */
  clearedJobIndices?: number[];
  recoveryConflict?: string;
  planFile: string;
  revision: string;
  codeFingerprint: string;
  enqueuedAt: string;
  overwriteExisting?: boolean;
  automaticRetry?: { enabledAt: string; healthyAt?: string; healthyReason?: "completed" | "majority_running"; disabledAt?: string };
  jobs: QueuedJob[];
};
export type DeferredPlan = { id: string; planFile: string; revision: string; codeFingerprint: string;
  body: Record<string, unknown>; enqueuedAt: string; status: "pending" | "processing" | "blocked" | "superseded"; error?: string; retryAfter?: string; supersededBy?: string;
  confirmedOutputChoice?: boolean; overwriteExisting?: boolean; distributedSkipJobIndices?: number[];
  waitingForPlanId?: string; waitingForPlanFile?: string; waitingForRevision?: string; waitingForFingerprint?: string; reason?: string };
export type ClearedDistributedJob = { projectId: string; workflowId: string; planFile: string; planRevision: string;
  codeFingerprint: string; experimentIndex: number; case: string; seed: number; attempt?: number;
  resultPathPolicy?: "declared"; globalJobId?: string; outputDir: string;
  collectionResultCsv?: string; status?: JobState; actualExecutionMode?: PlanExecutionMode;
  checkpointSource?: QueuedJob["checkpointSource"]; mirroredWorkerIds?: string[]; fragmentWorkerIds?: string[];
  cleanup?: QueuedJob["cleanup"]; outputRetiredAt?: string;
  stopBoundary?: "local_command";
  workerId: string; commandId: string; runKey: string; clearedAt: string;
  clearMode?: "terminal_history"; remoteClosureConfirmed?: false; activeReceiptObservedAt?: string };
export type FailedAttemptRecovery = {
  id: string; plan: Pick<QueuedPlan, "id" | "projectId" | "planFile" | "revision" | "codeFingerprint" | "planJobCount">;
  job: Pick<QueuedJob, "index" | "case" | "seed" | "attempt" | "outputDir" | "workerId" | "commandId" | "runKey" | "gpuId">;
  serverIdentity: string; remoteRoot: string; absolutePath: string; destination: string; authorizedAt: string;
  status: "pending" | "completed" | "blocked"; tries?: number; retryAt?: string; error?: string;
  receipt?: Record<string, unknown>;
};
export type DistributedQueue = { schemaVersion: 1; plans: QueuedPlan[]; deferred?: DeferredPlan[];
  failedAttemptRecoveries?: FailedAttemptRecovery[];
  clearedJobs?: ClearedDistributedJob[]; publishedSignature?: string; previewSignature?: string;
  localMetricsSignature?: string;
  publishedWorkerId?: string; publishedWorkerIds?: string[]; publishedPaths?: string[];
  previewWorkerId?: string; previewWorkerIds?: string[]; previewPaths?: string[] };

const QUEUE_BASE_DISK_SIGNATURE = Symbol("distributedQueueBaseDiskSignature");

export function distributedQueueDiskSignature(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function distributedQueueBaseSignature(queue: DistributedQueue): string | undefined {
  const signature = (queue as any)?.[QUEUE_BASE_DISK_SIGNATURE];
  return typeof signature === "string" ? signature : undefined;
}

export function setDistributedQueueBaseSignature<T extends DistributedQueue>(queue: T, signature: string): T {
  Object.defineProperty(queue, QUEUE_BASE_DISK_SIGNATURE, { value: signature, enumerable: true, configurable: true, writable: true });
  return queue;
}

export function cloneDistributedQueue(queue: DistributedQueue, baseSignature = distributedQueueBaseSignature(queue)): DistributedQueue {
  const copy = JSON.parse(JSON.stringify(queue)) as DistributedQueue;
  if (typeof baseSignature === "string") setDistributedQueueBaseSignature(copy, baseSignature);
  return copy;
}

/** Internal zero only bridges the old schema; new persisted jobs have no attempt version. */
export function restoreFormalJobQueue(queue: DistributedQueue): DistributedQueue {
  for (const plan of queue.plans || []) if (plan.resultPathPolicy === "declared") {
    for (const job of plan.jobs || []) {
      if (job.resultPathPolicy === "declared" && job.attempt === undefined) job.attempt = 0;
      if (job.lifecycleProtocol === 2) clearNativeProjection(job, plan);
      // r82：恢复投影对任何协议版本都保留隔离阻断并重建其解释（lifecycle 2 已在上方投影过，此处幂等）。
      if (job.outputIsolationBlocked) job.blockReason = outputIsolationNotice(job);
      for (const record of job.history || []) if (record.attempt === undefined && !record.outputDir.split("/").includes("attempts")) record.attempt = 0;
    }
  }
  return queue;
}

function clearNativeProjection(job: QueuedJob, plan: QueuedPlan) {
  job.status = job.unavailable || job.retainExistingOutputs ? "cancelled" : job.commandId ? "unknown" : "pending";
  for (const key of ["executionState", "resultState", "completionState", "runtimeDiagnostics", "exitCode", "statusQueryError", "verificationQueryError", "lastObservedAt", "trustedTerminalStatus", "error", "blockReason",
    "tmuxPane", "tmuxWindowId", "tmuxSession", "logPath", "finishedAt"] as const) delete job[key];
  if (job.gpuMemoryWaitReason) job.blockReason = job.gpuMemoryWaitReason;
  // r82：隔离阻断是本机持久事实而非远端运行投影——投影可以清原生运行字段，但不得抹掉
  // outputIsolationBlocked 或它的解释；重载后必须仍能回答"为何未启动、下一步做什么"。
  if (job.outputIsolationBlocked) job.blockReason = outputIsolationNotice(job);
  if (hasVerifiedCompletion(plan, job)) Object.assign(job, verifiedCompletionProjection(plan, job));
  else delete job.verifiedCompletion;
}

/** Metadata writes keep the current in-memory observation; disk history never supplies runtime truth. */
export function keepCurrentObservations(queue: DistributedQueue, live: DistributedQueue | undefined, now = Date.now()): DistributedQueue {
  if (!live) return queue;
  const keys = ["status", "executionState", "resultState", "completionState", "runtimeDiagnostics", "exitCode", "statusQueryError", "lastObservedAt", "error", "blockReason",
    "tmuxPane", "tmuxWindowId", "tmuxSession", "logPath", "finishedAt"] as const;
  for (const plan of queue.plans) for (const job of plan.jobs) {
    const current = live.plans.find(row => row.id === plan.id && row.projectId === plan.projectId)?.jobs.find(row => row.index === job.index);
    if (job.lifecycleProtocol !== 2 || !job.commandId || !current || current.commandId !== job.commandId || current.workerId !== job.workerId
      || !current.lastObservedAt || now - Date.parse(current.lastObservedAt) > 30000 || !Number.isFinite(Date.parse(current.lastObservedAt))) continue;
    for (const key of keys) (job as any)[key] = current[key];
    job.gpuMemoryProfile = mergeBudgetEvidence(job.gpuMemoryProfile, current.gpuMemoryProfile);
    Object.assign(job, verifiedCompletionProjection(plan, job));
  }
  return queue;
}

export function serializeDistributedQueue(queue: DistributedQueue): string {
  const copy = cloneDistributedQueue(queue);
  copy.plans = copy.plans.map(plan => retainPlanMemoryEstimates(plan));
  for (const plan of copy.plans) if (plan.resultPathPolicy === "declared") for (const job of plan.jobs) {
    if (job.lifecycleProtocol === 2) {
      clearNativeProjection(job, plan);
    }
    // r82：落盘前把隔离阻断的解释持久化进 blockReason——清原生投影删掉的是运行观测，
    // 不得连带删掉"为何未启动"的持久解释（现场缺口：重载后 job 只剩无声 pending）。
    if (job.outputIsolationBlocked) job.blockReason = outputIsolationNotice(job);
    if (job.attempt === 0) delete (job as Partial<QueuedJob>).attempt;
    for (const record of job.history || []) if (record.attempt === 0) delete (record as { attempt?: number }).attempt;
  }
  return JSON.stringify(copy, null, 2) + "\n";
}

export function retainQueueMemoryEstimates(queue: DistributedQueue, prior?: DistributedQueue): DistributedQueue {
  return { ...queue, plans: queue.plans.map(plan => retainPlanMemoryEstimates(plan, prior?.plans.find(old => old.id === plan.id))) };
}

/** Persist only compact confirmed facts into the existing queue, never raw
 * observations, log text, metrics or a replayable remote task registration. */
export function updateVerifiedCompletions(queue: DistributedQueue, snapshot: any, projectId: string, now = Date.now(), maxAgeMs = 20_000): DistributedQueue | undefined {
  const projected = mergeDurableWorkerSnapshots(queue, [snapshot], projectId, now, maxAgeMs);
  let changed = false;
  const next = { ...queue, plans: queue.plans.map(plan => ({ ...plan, jobs: plan.jobs.map(job => {
    if (plan.projectId !== projectId || job.workerId !== snapshot.workerId || job.lifecycleProtocol !== 2) return job;
    const observed = projected.plans.find(row => row.id === plan.id)?.jobs.find(row => row.index === job.index && row.commandId === job.commandId);
    if (!observed || JSON.stringify(observed.verifiedCompletion) === JSON.stringify(job.verifiedCompletion)) return job;
    changed = true;
    return { ...job, verifiedCompletion: observed.verifiedCompletion, ...verifiedCompletionProjection(plan, observed) };
  }) })) };
  return changed ? next : undefined;
}

export function taskAttempt(task: Record<string, unknown>): number {
  return task.resultPathPolicy === "declared" && task.globalJobId === `${task.workflowId}:${task.experimentIndex}`
    && task.attempt === undefined ? 0 : Number(task.attempt);
}

/** Only our recorded metadata-only commits can advance a business working copy's base. */
export function queueMetadataAdvanceRecorded(writes: readonly { root: string; from: string; to: string }[],
  root: string, from: string, to: string): boolean {
  let signature = from;
  for (const write of writes) {
    if (write.root === root && write.from === signature) signature = write.to;
    if (signature === to) return true;
  }
  return false;
}

export function terminalHistoryLogBinding(plan: Pick<QueuedPlan, "id">, job: Pick<QueuedJob, "status" | "outputDir" | "commandId">):
  { logPath: string; historyLogIdentity: { commandId: string; outputDir: string; runId: string } } | undefined {
  const status = String(job?.status || "").toLowerCase();
  if (!["completed", "failed", "cancelled"].includes(status)) return undefined;
  const outputDir = String(job?.outputDir || "").replace(/\\/g, "/").trim();
  if (!outputDir || outputDir.startsWith("/") || /^[A-Za-z]:/.test(outputDir)
    || outputDir.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  const runId = String(plan?.id || "").trim();
  const commandId = String(job?.commandId || "").trim();
  if (!runId || !commandId) return undefined;
  return {
    logPath: `${outputDir}/${status === "completed" ? "stdout.log" : "stderr.log"}`,
    historyLogIdentity: { commandId, outputDir, runId },
  };
}

export function workerTaskLogBinding(plan: Pick<QueuedPlan, "id">, job: Pick<QueuedJob, "status" | "outputDir" | "commandId">,
  taskLogPath: unknown): { logPath: string; historyLogIdentity?: { commandId: string; outputDir: string; runId: string } } | undefined {
  const status = String(job?.status || "").toLowerCase();
  if (["completed", "failed", "cancelled"].includes(status)) return terminalHistoryLogBinding(plan, job) || { logPath: "" };
  const logPath = typeof taskLogPath === "string" ? taskLogPath.replace(/\\/g, "/").trim() : "";
  if (!logPath || logPath.startsWith("/") || /^[A-Za-z]:/.test(logPath)
    || logPath.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  return { logPath };
}

export type WorkerSlots = { workerId: string; idleGpuIds: string[]; gpuSlots?: string[]; online: boolean; capacity?: number; codeFingerprint?: string; idleGpuAdmission?: boolean; declaredJobPaths?: boolean; compatiblePlans?: string[]; codeScopeErrors?: Record<string,string>; codeScopePending?: Record<string,boolean> };
export function workerCanRunPlan(queue: DistributedQueue, worker: Pick<WorkerSlots,"workerId"|"codeFingerprint"|"compatiblePlans"|"codeScopeErrors"|"codeScopePending">, plan: QueuedPlan): boolean {
  if (worker.codeScopeErrors?.[plan.id] || worker.codeScopePending?.[plan.id]) return false;
  return worker.compatiblePlans?.includes(plan.id) === true || worker.codeFingerprint === plan.codeFingerprint
    && workerCodeVersionAvailable(queue, worker.workerId, plan.codeFingerprint);
}
export type DurableWorkerSnapshot = {
  workerId: string;
  capabilities?: { durablePlanQueue?: boolean; idleGpuAdmission?: boolean; queuedJobRecall?: boolean; declaredJobPaths?: boolean; gpuMemoryRatioScheduling?: number; schemaVersion?: number };
  generatedAt?: string;
  fetchedAt?: string;
  error?: string;
  tasks?: Array<Record<string, unknown>>;
};

export function hasFreshDurableSnapshot(snapshot: DurableWorkerSnapshot | undefined, now = Date.now(), maxAgeMs = 180_000): boolean {
  const generatedAt = Date.parse(String(snapshot?.generatedAt || ""));
  const fetchedAt = Date.parse(String(snapshot?.fetchedAt || ""));
  if ((snapshot?.capabilities as any)?.taskLifecycle === 2) return Boolean(snapshot && !snapshot.error && !(snapshot as any).pending
    && (snapshot as any).queryComplete === true && Number.isFinite(fetchedAt) && now - fetchedAt <= maxAgeMs && fetchedAt <= now + 30_000);
  return Boolean(snapshot && !snapshot.error && snapshot.capabilities?.durablePlanQueue === true
    && snapshot.capabilities.schemaVersion === 1 && Number.isFinite(generatedAt) && Number.isFinite(fetchedAt)
    && now - generatedAt <= maxAgeMs && now - fetchedAt <= maxAgeMs
    && generatedAt <= now + 30_000 && fetchedAt <= now + 30_000);
}
export const CODE_FINGERPRINT_MISMATCH = "代码指纹不匹配：Worker 当前代码版本与该 Plan 不一致。任务仍保留为排队，不会自动失败或重发。请用当前代码重新提交该 Plan，或恢复提交前的代码版本并重新同步 Worker 后再继续。";
export const CODE_FINGERPRINT_WAITING = "等待当前代码版本的任务结束：匹配的 Worker 上旧版本仍有活动或待核实任务。仅这些 Worker 保留版本锁，其他匹配版本的 Worker 可并行派发。任务仍保留为排队。";
const UNFINISHED_JOB: readonly JobState[] = ["pending", "dispatching", "queued", "running", "unknown"];
export const DISPATCH_RECONCILIATION_DELAY_MS = 10_000;

export function dispatchReconciliationDue(job: QueuedJob, now = Date.now()): boolean {
  const attemptedAt = Date.parse(String(job.lastDispatchAttemptAt || ""));
  return !Number.isFinite(attemptedAt) || now - attemptedAt >= DISPATCH_RECONCILIATION_DELAY_MS;
}

export function canonicalProjectId(projectRoot: string): string {
  const resolved = path.resolve(String(projectRoot || "")).replace(/\\/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function jobAvailabilityIdentity(plan: QueuedPlan, job: QueuedJob): string {
  return JSON.stringify([plan.projectId, plan.id, plan.planFile, plan.revision, plan.codeFingerprint,
    job.index, job.case, job.seed, job.attempt, job.outputDir, job.workerId, job.commandId, job.runKey, job.gpuId]);
}

export function jobIsUnavailable(plan: QueuedPlan, job: QueuedJob): boolean {
  return Boolean(job.status === "cancelled" && !job.recoveryConflict && job.unavailable?.reason
    && job.unavailable.identity === jobAvailabilityIdentity(plan, job));
}

export function markJobUnavailable(queue: DistributedQueue, planId: string, index: number,
  expectedIdentity: string, reason: string, markedAt: string, terminalReceipt?: Record<string, unknown>): DistributedQueue {
  const plan = queue.plans.find(row => row.id === planId), job = plan?.jobs.find(row => row.index === index);
  const text = String(reason || "").trim();
  if (!plan || !job || jobAvailabilityIdentity(plan, job) !== expectedIdentity || job.unavailable
    || job.recoveryConflict || plan.recoveryConflict || !text || text.length > 500 || !Number.isFinite(Date.parse(markedAt)))
    throw new Error("job 身份或状态已变化，或缺少不可用原因；未修改。");
  const unsent = !job.workerId && !job.commandId && job.gpuId === undefined
    && ["pending", "failed", "cancelled"].includes(job.status);
  const terminal = terminalReceipt && durableStatus(terminalReceipt.status);
  if (!unsent && (!job.workerId || !job.commandId || !["failed", "cancelled"].includes(job.status)
    || !terminalReceipt || terminalReceipt.identityConflict || !remoteTaskMatchesJob(plan, job, terminalReceipt)
    || terminal !== job.status || !(Number.isFinite(Date.parse(String(terminalReceipt.finishedAt || "")))
      || typeof terminalReceipt.exitCode === "number")))
    throw new Error("仅可标记未派发或已核验结束的失败/中止 job；活动或待核实任务须先停止。");
  const nextPlan: QueuedPlan = { ...plan,
    jobs: plan.jobs.map(item => item.index !== index ? item : { ...item, status: "cancelled" as const,
      unavailable: { identity: expectedIdentity, reason: text, markedAt, previousStatus: item.status,
        previousFinishedAt: item.finishedAt, previousTrustedTerminalStatus: item.trustedTerminalStatus },
      finishedAt: item.finishedAt || markedAt, automaticRetry: undefined, blockReason: undefined,
      // P0-R：terminalReceipt 已在上方按身份/状态/finishedAt|exitCode 核验；随之持久紧凑证明（未派发 unsent 无 commandId，本就不占名额）。
      ...(terminal ? { trustedTerminalStatus: terminal as "failed" | "cancelled",
        trustedTerminalProof: trustedTerminalProofFor(plan, item, terminal as "failed" | "cancelled", Date.parse(markedAt)) } : {}) }) };
  nextPlan.recoveryMissingCount = distributedPlanRecoveryMissingCount(nextPlan);
  return { ...queue, plans: queue.plans.map(row => row.id !== planId ? row : nextPlan) };
}

/** Undo only the local decision, without restarting or inventing a Worker completion. */
export function restoreJobAvailability(queue: DistributedQueue, planId: string, index: number, expectedIdentity: string): DistributedQueue {
  const plan = queue.plans.find(row => row.id === planId), job = plan?.jobs.find(row => row.index === index);
  if (!plan || !job || !jobIsUnavailable(plan, job) || jobAvailabilityIdentity(plan, job) !== expectedIdentity)
    throw new Error("不可用 job 身份已变化，未撤销。");
  const nextPlan: QueuedPlan = { ...plan,
    jobs: plan.jobs.map(item => item.index !== index ? item : { ...item, status: item.unavailable!.previousStatus,
      finishedAt: item.unavailable!.previousFinishedAt, trustedTerminalStatus: item.unavailable!.previousTrustedTerminalStatus,
      unavailable: undefined, automaticRetry: item.unavailable!.previousStatus === "failed"
        ? { failureCount: 0, failedAttempt: item.attempt, failureClass: "unknown" as const,
          blockedReason: "已撤销不可用标记；如需重跑，请手动召回。" } : undefined }) };
  nextPlan.recoveryMissingCount = distributedPlanRecoveryMissingCount(nextPlan);
  return { ...queue, plans: queue.plans.map(row => row.id !== planId ? row : nextPlan) };
}

export function durableCommandId(plan: Pick<QueuedPlan, "id" | "projectId" | "planFile" | "revision" | "codeFingerprint">,
  job: Pick<QueuedJob, "index" | "case" | "seed" | "attempt" | "outputDir" | "nextCommandId">, workerId: string, gpuId?: string): string {
  if (job.nextCommandId) return job.nextCommandId;
  return createHash("sha256").update([plan.projectId || "", plan.id, plan.planFile,
    plan.revision, plan.codeFingerprint, job.index, job.case, job.seed, job.attempt, job.outputDir, workerId, gpuId || ""].join("\0")).digest("hex").slice(0, 32);
}

export function freshIdleGpuEvidence(gpuSnapshot: Record<string, unknown>, workerIds: readonly string[],
  idleUtilThreshold: number, idleMemThresholdMb: number): { complete: boolean; idleGpuIdsByWorker: Map<string, string[]> } {
  const idleGpuIdsByWorker = new Map<string, string[]>();
  for (const workerId of workerIds) {
    const rows = gpuSnapshot?.[workerId];
    if (!Array.isArray(rows) || rows.length === 0) return { complete: false, idleGpuIdsByWorker };
    const idle: string[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") return { complete: false, idleGpuIdsByWorker };
      const item = raw as Record<string, unknown>;
      const gpuId = String(item.index ?? item.gpu_id ?? item.gpuId ?? item.id ?? "").trim();
      const utilRaw = item.utilizationPercent ?? item.utilization ?? item.gpu_util;
      const memRaw = item.memoryUsedMb ?? item.memory_used_mb ?? item.memoryUsed;
      const util = Number(utilRaw);
      const mem = Number(memRaw);
      const processes = Array.isArray(item.processes) ? item.processes : Array.isArray(item.procs) ? item.procs : undefined;
      const processCountRaw = item.processCount ?? item.process_count ?? processes?.length;
      const processCount = Number(processCountRaw);
      if (!gpuId || utilRaw == null || memRaw == null || processCountRaw == null
        || typeof utilRaw === "string" && !utilRaw.trim() || typeof memRaw === "string" && !memRaw.trim()
        || typeof processCountRaw === "string" && !processCountRaw.trim()
        || !Number.isFinite(util) || util < 0 || !Number.isFinite(mem) || mem < 0
        || !Number.isInteger(processCount) || processCount < 0)
        return { complete: false, idleGpuIdsByWorker };
      if (!(processes?.length) && processCount === 0 && util < idleUtilThreshold && mem < idleMemThresholdMb) idle.push(gpuId);
    }
    idleGpuIdsByWorker.set(workerId, [...new Set(idle)]);
  }
  return { complete: workerIds.length > 0, idleGpuIdsByWorker };
}

function durableStatus(value: unknown): JobState | undefined {
  const status = String(value || "").toLowerCase();
  if (status === "queued" || status === "pending") return "queued";
  if (status === "running" || status === "starting") return "running";
  if (status === "completed") return "completed";
  if (status === "failed" || status === "stopped") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "unknown" || status === "dispatching") return "unknown";
  return undefined;
}

/** Missing recovery is a gap in job identities, not the absence of a terminal receipt from this snapshot. */
export function distributedPlanRecoveryMissingCount(plan: QueuedPlan, acceptedIndices: ReadonlySet<number> = new Set()): number {
  const expected = Number(plan.planJobCount);
  if (!Number.isInteger(expected) || expected < 1) return Math.max(0, Number(plan.recoveryMissingCount) || 0);
  const known = new Set(acceptedIndices);
  for (const index of plan.clearedJobIndices || []) {
    if (Number.isInteger(index) && index >= 0 && index < expected && !plan.jobs.some(job => job.index === index)) known.add(index);
  }
  const latestAttempts = new Map<number, number>();
  for (const job of plan.jobs) {
    if (Number.isInteger(job.index) && job.index >= 0 && Number.isInteger(job.attempt) && job.attempt >= 0)
      latestAttempts.set(job.index, Math.max(latestAttempts.get(job.index) || 0, job.attempt));
  }
  for (const job of plan.jobs) {
    if (job.recoveryConflict || !Number.isInteger(job.index) || job.index < 0
      || !Number.isInteger(job.attempt) || job.attempt < 0 || job.attempt !== latestAttempts.get(job.index)) continue;
    const localPending = job.status === "pending" && !job.workerId && !job.commandId;
    const terminalReceipt = ["completed", "failed", "cancelled"].includes(job.status)
      && (!job.trustedTerminalStatus || job.trustedTerminalStatus === job.status)
      && Boolean(job.workerId && job.commandId && job.outputDir && job.case) && Number.isInteger(job.seed);
    if (localPending || terminalReceipt || jobIsUnavailable(plan, job)) known.add(job.index);
  }
  return Math.max(0, expected - known.size);
}

export function hasUnresolvedPlanRecovery(plan: QueuedPlan): boolean {
  return Boolean(plan.recoveryConflict || plan.jobs.some(job => job.recoveryConflict)
    || Number(plan.recoveryMissingCount) > 0 && distributedPlanRecoveryMissingCount(plan) > 0);
}

function clearedJobIdentityKey(identity: Record<string, unknown>): string {
  const fields = [identity.projectId, identity.workflowId, identity.planFile, identity.planRevision,
    identity.codeFingerprint, identity.experimentIndex, identity.case, identity.seed,
    identity.outputDir, identity.workerId, identity.commandId, identity.runKey];
  // Retain real historical version distinctions. Zero was only the retired
  // formal schema sentinel; its old audit record must remain readable unchanged.
  return JSON.stringify(identity.resultPathPolicy !== "declared" && Number(identity.attempt) > 0
    ? [...fields, Number(identity.attempt)] : fields);
}

function clearedJobBelongsToPlan(entry: ClearedDistributedJob, plan: QueuedPlan, projectId: string): boolean {
  return !entry.activeReceiptObservedAt && entry.projectId === projectId && entry.workflowId === plan.id && entry.planFile === plan.planFile
    && entry.planRevision === plan.revision && entry.codeFingerprint === plan.codeFingerprint;
}

/** A confirmed Worker adoption may supersede the original failed test receipt after a Host crash. */
function reviewedTrainingCompletion(plan: QueuedPlan, job: QueuedJob, task: Record<string, unknown>): boolean {
  const proof = task.trainingRecovery as Record<string, unknown> | undefined;
  const original = task.originalExecution as QueuedJob["originalExecution"];
  if (plan.executionMode !== "train" || task.executionMode !== "train" || task.status !== "completed"
      || !remoteTaskMatchesJob(plan, job, task) || proof?.kind !== "validation_adapter_checkpoint"
      || !Number.isFinite(Date.parse(String(proof.confirmedAt))) || proof.metricSplit !== "val"
      || original?.status !== "failed" || original.mode !== "train_test"
      || !original.error?.includes("Validation-only tuning cannot access test patients")) return false;
  const expected = { projectId: plan.projectId, workflowId: plan.id, planFile: plan.planFile, planRevision: plan.revision,
    codeFingerprint: plan.codeFingerprint, experimentIndex: job.index, case: job.case, seed: job.seed,
    attempt: job.attempt, commandId: job.commandId, workerId: job.workerId, outputDir: job.outputDir };
  if (Object.entries(expected).some(([key, value]) => value === undefined || proof[key] !== value)) return false;
  const hashes = proof.sha256 as Record<string, unknown> | undefined;
  const checkpoint = String(proof.checkpointPath || "");
  return Boolean(hashes && Object.entries(hashes).every(([file, hash]) => file.startsWith(job.outputDir + "/")
    && !file.split("/").includes("..") && /^[a-f0-9]{64}$/.test(String(hash)))
    && checkpoint.startsWith(job.outputDir + "/") && hashes[checkpoint]
    && ["config.yaml", "config_snapshot.yaml", "metrics_summary.csv", "artifact_manifest.json", "checkpoint_manifest.json"]
      .every(file => hashes[job.outputDir + "/" + file]));
}

/** Merge only fresh, capability-bearing server snapshots for this exact project. */
export function mergeDurableWorkerSnapshots(queue: DistributedQueue, snapshots: readonly DurableWorkerSnapshot[], projectId: string,
  now = Date.now(), maxAgeMs = 180_000): DistributedQueue {
  const pulled = snapshots.filter(snapshot => (snapshot.capabilities as any)?.taskLifecycle === 2);
  // Rebuild control inputs from authenticated live window bindings when a local card is absent.
  // Never invent missing jobs or replay a saved Worker queue.
  if (pulled.length) {
    queue = cloneDistributedQueue(queue);
    for (const snapshot of pulled) {
      const fresh = Date.parse(String(snapshot.fetchedAt || snapshot.generatedAt || ""));
      if (snapshot.error || !Number.isFinite(fresh) || now - fresh > maxAgeMs) continue;
      for (const raw of snapshot.tasks || []) {
        const task = raw as any, index = Number(task.experimentIndex);
        if (!task.observation?.tmux || !observationMatches(task.observation, { commandId: task.commandId, workerId: snapshot.workerId, projectId })
          || !task.workflowId || task.globalJobId !== task.workflowId + ":" + index || !Number.isInteger(index) || index < 0
          || !task.planFile || !task.planRevision || !task.codeFingerprint || task.resultPathPolicy !== "declared"
          || [task.outputDir, task.collectionResultCsv, task.planFile].some(value => typeof value !== "string" || !value || value.startsWith("/")
            || /[:\\\x00-\x1f]/.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || part === "attempts"))) continue;
        let plan = queue.plans.find(row => row.id === task.workflowId);
        if (!plan) {
          plan = { id: task.workflowId, projectId, planFile: task.planFile, revision: task.planRevision, codeFingerprint: task.codeFingerprint,
            enqueuedAt: task.enqueuedAt || task.observation.observedAt, resultPathPolicy: "declared", executionMode: task.executionMode || task.mode,
            planJobCount: task.planJobCount, fullPlanJobCount: task.fullPlanJobCount, jobs: [] };
          queue.plans.push(plan);
        }
        if (plan.projectId !== projectId || plan.jobs.some(job => job.index === index)) continue;
        plan.jobs.push({ index, case: task.case, seed: Number(task.seed), attempt: 0, commandId: task.commandId, workerId: snapshot.workerId,
          runKey: task.commandId, globalJobId: task.globalJobId, outputDir: task.outputDir, collectionResultCsv: task.collectionResultCsv,
          resultPathPolicy: "declared", lifecycleProtocol: 2, status: "unknown", actualExecutionMode: task.mode,
          checkpointSource: task.checkpointSource });
      }
    }
  }
  queue = { ...queue, plans: queue.plans.map(plan => ({ ...plan, jobs: plan.jobs.map(job =>
    job.lifecycleProtocol === 2 && !hasVerifiedCompletion(plan, job) && job.workerId && job.commandId && !pulled.some(row => row.workerId === job.workerId)
      && !snapshots.some(row => row.workerId === job.workerId && (row as any).pending === true)
      ? { ...job, status: "unknown" as const, executionState: "unknown" as const, resultState: "unverified" as const,
          error: undefined, statusQueryError: "当前 Worker 主动查询不可用；原任务未重复派发", blockReason: "查询失败，可刷新或中止原任务" } : job) })) };
  if (pulled.length) {
    queue = { ...queue, plans: queue.plans.map(plan => ({ ...plan, jobs: plan.jobs.map(job => {
      const snapshot = pulled.find(row => row.workerId === job.workerId);
      if (!snapshot || (snapshot as any).pending === true || !job.commandId || !job.workerId || !["dispatching", "queued", "running", "unknown", "failed", "completed"].includes(job.status)) return job;
      const fresh = Date.parse(String(snapshot.fetchedAt || snapshot.generatedAt || ""));
      const task = (snapshot.tasks || []).find(row => row.commandId === job.commandId && row.projectId === projectId);
      const observation: TaskObservation = freshTaskObservation(snapshot, task, { lifecycleProtocol: 2, commandId: job.commandId,
        projectId, workerId: job.workerId, observedAt: String(snapshot.generatedAt || ""),
        queryError: snapshot.error || (!Number.isFinite(fresh) || now - fresh > maxAgeMs ? "状态查询已过期" : undefined) }, now, maxAgeMs);
      if (!observationMatches(observation, { commandId: job.commandId, workerId: job.workerId, projectId }))
        observation.queryError = "任务查询身份与当前任务不符；请刷新核实";
      if (task && ["outputDir", "collectionResultCsv"].some(field => typeof (task as any)[field] === "string"
        && typeof (job as any)[field] === "string" && (task as any)[field] !== (job as any)[field]))
        observation.queryError = "任务产物路径与当前任务不符；请刷新核实";
      // Narrow stop/read queries may omit historical metadata. When the Worker
      // does return a binding, a contradictory declaration must never borrow
      // this command's live pane or final result for another case/seed/PLAN.
      // Historical source revision/hash are provenance, not live control identity.
      const declaredIdentity: Array<[string, unknown]> = [["workflowId", plan.id], ["planFile", plan.planFile], ["experimentIndex", job.index],
        ["globalJobId", job.globalJobId], ["case", job.case], ["seed", job.seed], ["workerId", job.workerId]];
      if (task && declaredIdentity.some(([field, expected]) => expected !== undefined && (task as any)[field] !== undefined
        && String((task as any)[field]) !== String(expected)))
        observation.queryError = "任务声明身份与当前任务不符；请刷新核实";
      if (task && job.gpuId !== undefined && String(job.gpuId) !== "" && (task as any).gpuId !== undefined
        && String((task as any).gpuId) !== String(job.gpuId))
        observation.queryError = "任务 GPU 归属与当前任务不符；请刷新核实";
      // 原生启动证明（账本消费）：身份匹配任务 + 物理窗口存在 + 四类查询错误全空才置位；一旦置位粘性保留，
      // 后续取消/终态不抹掉已发生过的启动事实；终态/取消标记本身绝不反推启动。
      // 必须在上面的声明身份/GPU 归属核对之后计算：身份矛盾的观察同样不得置位启动证明或流入 observationErrors。
      const cleanNativeErrors = [observation.queryError, observation.executionQueryError, observation.resultQueryError, observation.runtimeQueryError]
        .filter(Boolean) as string[];
      const state = taskLifecycle(observation);
      const nativeWindowSeen = observation.tmux?.dead === false && ["starting", "running"].includes(state.execution);
      const verifiedCompletion = nextVerifiedCompletion(plan, job, observation, state, now);
      const fixed = verifiedCompletionProjection(plan, { ...job, verifiedCompletion });
      // P0-R：四类查询全净且身份核对通过的终态＝远端证实的物理退出/确证停止；持久化紧凑证明，
      // 使确证释放跨 clearNativeProjection 落盘/重读仍存在（未知或任一查询错误不产生证明）。
      const terminalProof = cleanNativeErrors.length === 0 && ["completed", "failed", "cancelled"].includes(state.status)
        ? trustedTerminalProofFor(plan, job, state.status as "completed" | "failed" | "cancelled", now) : undefined;
      return { ...job, lifecycleProtocol: 2 as const, status: state.status, executionState: state.execution, resultState: state.result,
        runtimeDiagnostics: state.runtimeDiagnostics, completionState: state.completionState, exitCode: state.exitCode,
        startIntent: !observation.queryError && !observation.executionQueryError && (observation.tmux || observation.cancelled || state.result === "complete") ? undefined : job.startIntent,
        ...( !observation.queryError && ["train", "test", "train_test"].includes(String(task?.actualExecutionMode)) ? { actualExecutionMode: task!.actualExecutionMode as PlanExecutionMode } : {}),
        recoveryConflict: undefined, trustedTerminalStatus: undefined,
        statusQueryError: observation.queryError || observation.executionQueryError, lastObservedAt: snapshot.fetchedAt || observation.observedAt,
        observationErrors: cleanNativeErrors,
        gpuMemoryProfile: !observation.queryError && !observation.executionQueryError
          ? mergeBudgetEvidence(job.gpuMemoryProfile, budgetEvidence(task?.gpuMemoryProfile, job.commandId || "", projectId)) : job.gpuMemoryProfile,
        nativeStartProof: job.nativeStartProof && job.nativeStartProof.commandId === job.commandId
          && job.nativeStartProof.workerId === job.workerId ? job.nativeStartProof
          : (cleanNativeErrors.length === 0 && nativeWindowSeen)
            ? { source: "worker_snapshot_task_l2" as const, commandId: String(observation.commandId), workerId: String(observation.workerId),
                observedAt: String(snapshot.fetchedAt || observation.observedAt), windowSeen: true }
            : undefined,
        error: state.status === "failed" ? String(task?.error || `任务退出码 ${task?.exitCode ?? "未知"}`) : undefined,
        blockReason: state.message, verifiedCompletion,
        ...(terminalProof ? { trustedTerminalProof: terminalProof } : {}),
        verificationQueryError: verifiedCompletion ? observation.queryError || observation.executionQueryError || observation.resultQueryError || observation.runtimeQueryError : undefined,
        ...fixed, ...(task && !observation.queryError ? { gpuId: String(task.gpuId ?? job.gpuId ?? ""),
          tmuxPane: String(task.tmuxPane || ""), tmuxWindowId: String(task.tmuxWindowId || ""), tmuxSession: String(task.tmuxSession || "") } : {}) };
    }) })) };
    snapshots = snapshots.filter(snapshot => (snapshot.capabilities as any)?.taskLifecycle !== 2);
    if (!snapshots.length) return queue;
  }
  const clearedJobs = Array.isArray(queue.clearedJobs) ? queue.clearedJobs.map(entry => ({ ...entry })) : [];
  const clearedByKey = new Map(clearedJobs.map(entry => [clearedJobIdentityKey(entry), entry]));
  const clearedKeys = new Set(clearedJobs.filter(entry => !entry.activeReceiptObservedAt).map(entry => clearedJobIdentityKey(entry)));
  const locallyStopped = new Set(clearedJobs.filter(entry => entry.stopBoundary === "local_command").map(entry =>
    JSON.stringify([entry.projectId, entry.workflowId, entry.workerId, entry.commandId])));
  const acceptedRows: Array<{ workerId: string; task: Record<string, unknown>; status: JobState }> = [];
  for (const snapshot of snapshots) {
    if (snapshot.error || snapshot.capabilities?.durablePlanQueue !== true || snapshot.capabilities.schemaVersion !== 1) continue;
    const generatedAt = Date.parse(String(snapshot.generatedAt || ""));
    const fetchedAt = Date.parse(String(snapshot.fetchedAt || ""));
    if (!Number.isFinite(generatedAt) || !Number.isFinite(fetchedAt) || now - generatedAt > maxAgeMs || now - fetchedAt > maxAgeMs
      || generatedAt > now + 30_000 || fetchedAt > now + 30_000) continue;
    for (const rawTask of snapshot.tasks || []) {
      const task: Record<string, unknown> = { ...rawTask, attempt: taskAttempt(rawTask) };
      const status = durableStatus(task.status);
      if (!status || String(task.projectId || "") !== projectId || String(task.workerId || snapshot.workerId) !== snapshot.workerId) continue;
      // Once this exact local command was closed, stale terminal metadata cannot recreate its card.
      if (["completed", "failed", "cancelled"].includes(status) && locallyStopped.has(JSON.stringify([
        task.projectId, task.workflowId, snapshot.workerId, task.commandId]))) continue;
      if (task.durableAccepted === false && !preflightRejectionEvidence(task)) continue;
      const localPlan = queue.plans.find(plan => plan.id === task.workflowId);
      const localJob = localPlan?.jobs.find(job => job.index === Number(task.experimentIndex));
      if (localJob?.lifecycleProtocol === 2) continue;
      if (preflightRejectionEvidence(task) && localPlan && localJob && !preflightRejectionMatchesJob(localPlan, localJob, task)) continue;
      if (!String(task.workflowId || "") || !String(task.planFile || "") || !String(task.planRevision || "")
        || !String(task.codeFingerprint || "") || !String(task.commandId || "") || !String(task.outputDir || "")
        || String(task.runKey || "") !== String(task.commandId || "") || !String(task.enqueuedAt || "")
        || !String(task.case || "") || task.seed == null || !Number.isInteger(Number(task.seed))
        || task.experimentIndex == null || !Number.isInteger(Number(task.experimentIndex)) || Number(task.experimentIndex) < 0
        || task.attempt == null || !Number.isInteger(Number(task.attempt)) || Number(task.attempt) < 0
        || Number(task.attempt) === 0 && (task.resultPathPolicy !== "declared"
          || task.globalJobId !== `${task.workflowId}:${task.experimentIndex}` || String(task.outputDir).split("/").includes("attempts"))
        || !Number.isInteger(Number(task.planJobCount)) || Number(task.planJobCount) < 1) continue;
      // A terminal audit record survives on the server, but must not recreate a user-cleared card.
      // Active/uncertain receipts always remain visible, including contradictory old identities.
      const clearedKey = clearedJobIdentityKey({ ...task, workerId: snapshot.workerId,
        experimentIndex: Number(task.experimentIndex), seed: Number(task.seed), attempt: Number(task.attempt) });
      const cleared = clearedByKey.get(clearedKey);
      if (cleared?.clearMode === "terminal_history" && !["completed", "failed", "cancelled"].includes(status)) {
        // Local history hiding cannot suppress a subsequently verified active task.
        cleared.activeReceiptObservedAt ||= new Date(now).toISOString();
        clearedKeys.delete(clearedKey);
      }
      if (["completed", "failed", "cancelled"].includes(status)
        && clearedKeys.has(clearedJobIdentityKey({ ...task, workerId: snapshot.workerId,
          experimentIndex: Number(task.experimentIndex), seed: Number(task.seed), attempt: Number(task.attempt) }))) continue;
      acceptedRows.push({ workerId: snapshot.workerId, task, status });
    }
  }
  const legacyReceipt = (plan: QueuedPlan, job: QueuedJob): Record<string, unknown> | undefined => job.legacyOwnership === true
    ? snapshots.filter((snapshot) => snapshot.workerId === job.workerId && hasFreshDurableSnapshot(snapshot, now, maxAgeMs))
      .flatMap((snapshot) => (snapshot.tasks || []).map((task) => ({ ...task, workerId: task.workerId || snapshot.workerId })))
      .find((task) => historicalRecallTaskMatchesJob(plan, job, task)) : undefined;
  const retainedPlans = queue.plans.flatMap(plan => {
    if (plan.projectId !== projectId) return [plan];
    const jobs = plan.jobs.filter(job => !(["completed", "failed", "cancelled"].includes(job.status)
      && clearedKeys.has(clearedJobIdentityKey({ projectId, workflowId: plan.id, planFile: plan.planFile,
        planRevision: plan.revision, codeFingerprint: plan.codeFingerprint, experimentIndex: job.index,
        case: job.case, seed: job.seed, attempt: job.attempt, outputDir: job.outputDir,
        workerId: job.workerId || "", commandId: job.commandId || "", runKey: job.runKey || job.commandId || "" }))));
    return jobs.length || !plan.jobs.length ? [{ ...plan, jobs }] : [];
  });
  const plans = retainedPlans.map((plan) => plan.projectId !== projectId ? plan : { ...plan, jobs: plan.jobs.map((job) => {
    if (job.lifecycleProtocol === 2) return job;
    const legacy = legacyReceipt(plan, job);
    const legacyStatus = legacy && durableStatus(legacy.status);
    if (legacyStatus) {
      const terminal = job.trustedTerminalStatus || (["completed", "failed", "cancelled"].includes(job.status) ? job.status : undefined);
      if (terminal && terminal !== legacyStatus) return { ...job, status: "unknown" as const, recoveryConflict: true,
        blockReason: "Fresh historical server state contradicts a trusted terminal receipt." };
      return { ...job, status: jobIsUnavailable(plan, job) ? "cancelled" as const : legacyStatus, blockReason: undefined };
    }
    if (!job.workerId || !job.commandId || !UNFINISHED_JOB.includes(job.status)
      || acceptedRows.some((row) => remoteTaskMatchesJob(plan, job, row.task))) return job;
    const receiptAt = Date.parse(String(job.status === "queued" ? job.dispatchAcknowledgedAt
      : job.status === "dispatching" ? job.lastDispatchAttemptAt : ""));
    const owner = snapshots.find((snapshot) => snapshot.workerId === job.workerId
      && hasFreshDurableSnapshot(snapshot, now, Math.min(maxAgeMs, 5_000)));
    // A cached poll taken before this RPC cannot revoke its just-verified receipt.
    // Errors, expired snapshots and a newer authoritative poll still require reconciliation.
    if (owner && Number.isFinite(receiptAt) && receiptAt <= now && now - receiptAt < DISPATCH_RECONCILIATION_DELAY_MS
      && Date.parse(String(owner.fetchedAt)) <= receiptAt
      && !(owner.tasks || []).some((task) => String(task.commandId || "") === job.commandId)) return job;
    return { ...job, status: "unknown" as const,
      blockReason: "Current server receipt is unavailable; the original owner and command identity are retained." };
  }) });
  const grouped = new Map<string, typeof acceptedRows>();
  for (const row of acceptedRows) {
    const task = row.task;
    const key = [projectId, task.workflowId, task.planFile, task.planRevision, task.codeFingerprint].join("\0");
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  for (const [key, observedRows] of grouped) {
    const first = observedRows[0].task;
    const planIndex = plans.findIndex((plan) => (!plan.projectId || plan.projectId === projectId) && plan.id === String(first.workflowId)
      && plan.planFile === String(first.planFile) && plan.revision === String(first.planRevision)
      && plan.codeFingerprint === String(first.codeFingerprint));
    // A formal retry has a new command, not an attempt number. Keep its exact,
    // locally recorded terminal predecessor as audit rather than current work.
    const rows = observedRows.filter(row => {
      const local = planIndex >= 0 ? plans[planIndex] : undefined;
      if (local?.resultPathPolicy !== "declared" || row.task.resultPathPolicy !== "declared") return true;
      const job = local.jobs.find(item => item.index === Number(row.task.experimentIndex));
      const commandId = String(row.task.commandId || "");
      if (!job || commandId === job.commandId || commandId === job.nextCommandId) return true;
      const prior = job.history?.find(entry => entry.commandId === commandId && entry.workerId === row.workerId
        && entry.outputDir === job.outputDir && entry.status === row.status && ["completed", "failed", "cancelled"].includes(entry.status));
      return !prior || !remoteTaskMatchesJob(local, { ...job, commandId, runKey: commandId, workerId: prior.workerId, gpuId: undefined }, row.task);
    });
    if (!rows.length) continue;
    const declaredCounts = [...new Set([...rows.map((row) => Number(row.task.planJobCount)),
      ...(planIndex >= 0 && plans[planIndex].planJobCount ? [Number(plans[planIndex].planJobCount)] : [])])];
    const acceptedIndices = new Set(rows.map((row) => Number(row.task.experimentIndex)));
    const countConflict = declaredCounts.length !== 1 || acceptedIndices.size > Math.max(...declaredCounts);
    const jobCount = Math.max(...declaredCounts);
    const plan: QueuedPlan = planIndex >= 0 ? { ...plans[planIndex], jobs: [...plans[planIndex].jobs] } : {
      id: String(first.workflowId), projectId, planFile: String(first.planFile), revision: String(first.planRevision),
      codeFingerprint: String(first.codeFingerprint), enqueuedAt: String(first.enqueuedAt || ""), planJobCount: jobCount, jobs: [],
    };
    plan.projectId = projectId;
    if (rows.every(row => row.task.resultPathPolicy === "declared")) plan.resultPathPolicy = "declared";
    plan.clearedJobIndices = [...new Set(clearedJobs.filter(entry => clearedJobBelongsToPlan(entry, plan, projectId))
      .map(entry => entry.experimentIndex))];
    if (!plan.schedulingMode && !plan.localDispatchOverride && (first.schedulingMode === "server_prequeue" || first.schedulingMode === "local_idle"))
      plan.schedulingMode = first.schedulingMode;
    const modes = [...new Set(rows.map(row => row.task.executionMode).filter(mode => ["train", "test", "train_test"].includes(String(mode))))];
    if (!plan.executionMode && modes.length === 1) {
      plan.executionMode = modes[0] as PlanExecutionMode;
      plan.executionModeSource = "worker_receipt";
      plan.executionModeBlocked = false;
    }
    if (modes.length > 1 || modes.some(mode => plan.executionMode && mode !== plan.executionMode))
      plan.recoveryConflict = "Worker execution mode conflicts with the validated Plan; redispatch is blocked.";
    plan.planJobCount = jobCount;
    const fullCounts = [...new Set([...rows.map((row) => Number(row.task.fullPlanJobCount)), Number(plan.fullPlanJobCount)]
      .filter((count) => Number.isInteger(count) && count >= jobCount))];
    if (fullCounts.length === 1) plan.fullPlanJobCount = fullCounts[0];
    if (fullCounts.length > 1) plan.recoveryConflict = "Server summaries disagree on the full configured Plan job count.";
    else if (plan.recoveryConflict === "Server summaries disagree on the full configured Plan job count.") delete plan.recoveryConflict;
    if (countConflict) plan.recoveryConflict = `Server summaries disagree on expected Plan job count: ${declaredCounts.join(", ")}.`;
    const terminalStates = new Set<JobState>(["completed", "failed", "cancelled"]);
    const latestAttempts = new Map<number, number>();
    for (const job of plan.jobs) latestAttempts.set(job.index, Math.max(latestAttempts.get(job.index) || 0, job.attempt));
    for (const row of rows) {
      const index = Number(row.task.experimentIndex);
      latestAttempts.set(index, Math.max(latestAttempts.get(index) || 0, Number(row.task.attempt)));
    }
    const olderRows = rows.filter((row) => Number(row.task.attempt) < latestAttempts.get(Number(row.task.experimentIndex))!);
    const contradictoryHistory = olderRows.some((row) => plan.jobs.some((job) => {
      const terminal = job.trustedTerminalStatus || (terminalStates.has(job.status) ? job.status : undefined);
      return terminal && remoteTaskMatchesJob(plan, job, row.task) && terminal !== row.status;
    }));
    const changedSeedIdentity = rows.some((row) => rows.some((other) => Number(other.task.experimentIndex) === Number(row.task.experimentIndex)
      && (String(other.task.case) !== String(row.task.case) || Number(other.task.seed) !== Number(row.task.seed))));
    const overlappingAttempts = olderRows.some((row) => !terminalStates.has(row.status)) || contradictoryHistory || changedSeedIdentity;
    if (!countConflict && overlappingAttempts) plan.recoveryConflict = "Server summaries show overlapping or contradictory job attempts.";
    if (!overlappingAttempts && plan.recoveryConflict === "Server summaries show overlapping or contradictory job attempts.") delete plan.recoveryConflict;
    const historicalRows = overlappingAttempts ? [] : olderRows;
    // A verified older terminal attempt remains provenance, rather than another current job.
    plan.jobs = plan.jobs.filter((job) => !historicalRows.some((row) => remoteTaskMatchesJob(plan, job, row.task)));
    plan.jobs = plan.jobs.map((job) => {
      const history = historicalRows.filter((row) => Number(row.task.experimentIndex) === job.index);
      if (!history.length) return job;
      const entries = [...(job.history || []), ...history.map((row) => ({ attempt: Number(row.task.attempt), status: row.status,
        workerId: row.workerId, commandId: String(row.task.commandId), outputDir: String(row.task.outputDir),
        ...(terminalHistoryLogBinding(plan, { status: row.status, outputDir: String(row.task.outputDir), commandId: String(row.task.commandId) })?.logPath
          ? { logPath: terminalHistoryLogBinding(plan, { status: row.status, outputDir: String(row.task.outputDir), commandId: String(row.task.commandId) })!.logPath } : {}),
        ...(typeof row.task.tmuxSession === "string" && /^[A-Za-z0-9._-]+$/.test(String(row.task.tmuxSession)) ? { tmuxSession: String(row.task.tmuxSession) } : {}),
        ...(typeof row.task.error === "string" ? { error: String(row.task.error) } : {}),
        ...(typeof row.task.finishedAt === "string" ? { finishedAt: String(row.task.finishedAt) } : {}),
        ...(typeof row.task.stopReason === "string" ? { stopReason: String(row.task.stopReason) } : {}) }))];
      return { ...job, history: entries.filter((entry, index) => entries.findIndex((other) => other.commandId === entry.commandId
        && other.workerId === entry.workerId && other.attempt === entry.attempt) === index) };
    });
    const byJob = new Map<string, typeof rows>();
    for (const row of rows) {
      if (historicalRows.includes(row)) continue;
      const task = row.task;
      const key = `${Number(task.experimentIndex)}\0${Number(task.attempt)}`;
      byJob.set(key, [...(byJob.get(key) || []), row]);
    }
    for (const [jobKey, jobRows] of byJob) {
      const task = jobRows[0].task;
      const index = Number(task.experimentIndex);
      const attempt = Number(task.attempt);
      const existing = plan.jobs.findIndex((job) => job.index === index && job.attempt === attempt);
      const identities = new Set(jobRows.map(({ workerId, task: item }) => [workerId, item.commandId, item.case, item.seed, item.outputDir].join("\0")));
      const statuses = new Set(jobRows.map((row) => row.status));
      const conflict = countConflict || overlappingAttempts || identities.size !== 1 || statuses.size > 1;
      const source = jobRows.sort((a, b) => a.workerId.localeCompare(b.workerId))[0];
      const terminalStatus = !conflict && terminalStates.has(source.status) ? source.status as "completed" | "failed" | "cancelled" : undefined;
      const taskLogPath = typeof task.logPath === "string" ? task.logPath : undefined;
      const logBinding = terminalStatus
        ? terminalHistoryLogBinding(plan, { status: terminalStatus, outputDir: String(task.outputDir), commandId: String(task.commandId) })
        : workerTaskLogBinding(plan, { status: "running", outputDir: String(task.outputDir), commandId: String(task.commandId) }, taskLogPath);
      const recoveredMode = (task.originalExecution as QueuedJob["originalExecution"])?.mode || task.mode || task.stage;
      const merged: QueuedJob = {
        index, case: String(task.case || ""), seed: Number(task.seed), attempt, outputDir: String(task.outputDir),
        ...(task.resultPathPolicy === "declared" ? { resultPathPolicy: "declared" as const,
          globalJobId: String(task.globalJobId), collectionResultCsv: String(task.collectionResultCsv || ""),
          checkpointSource: task.checkpointSource as QueuedJob["checkpointSource"] } : {}),
        ...(["train", "test", "train_test"].includes(String(recoveredMode))
          ? { actualExecutionMode: recoveredMode as PlanExecutionMode } : {}),
        status: conflict ? "unknown" : source.status, workerId: source.workerId,
        commandId: String(task.commandId), runKey: String(task.runKey), projectId,
        ...(task.gpuId !== undefined && task.gpuId !== null ? { gpuId: String(task.gpuId) } : {}),
        ...(logBinding || {}),
        ...(typeof task.finishedAt === "string" ? { finishedAt: task.finishedAt } : {}),
        ...(typeof task.error === "string" ? { error: task.error } : {}),
        ...(task.failureDiagnostic && typeof task.failureDiagnostic === "object" ? { failureDiagnostic: task.failureDiagnostic as Record<string, unknown> } : {}),
        ...(task.formalConflictEvidence && typeof task.formalConflictEvidence === "object" ? { formalConflictEvidence: task.formalConflictEvidence as Record<string, unknown> } : {}),
        ...(preflightRejectionEvidence(task) ? { admissionRejection: {
          code: String(task.errorCode), message: String(task.error || task.message), rejectedAt: String(task.finishedAt) } } : {}),
        ...(typeof task.stopReason === "string" ? { stopReason: task.stopReason } : {}),
        ...(terminalStatus ? { trustedTerminalStatus: terminalStatus } : {}),
        ...(historicalRows.some((row) => Number(row.task.experimentIndex) === index) ? {
          history: historicalRows.filter((row) => Number(row.task.experimentIndex) === index).map((row) => ({
            attempt: Number(row.task.attempt), status: row.status, workerId: row.workerId,
            commandId: String(row.task.commandId), outputDir: String(row.task.outputDir),
            ...(terminalHistoryLogBinding(plan, { status: row.status, outputDir: String(row.task.outputDir), commandId: String(row.task.commandId) })?.logPath
              ? { logPath: terminalHistoryLogBinding(plan, { status: row.status, outputDir: String(row.task.outputDir), commandId: String(row.task.commandId) })!.logPath } : {}),
            ...(typeof row.task.tmuxSession === "string" && /^[A-Za-z0-9._-]+$/.test(String(row.task.tmuxSession)) ? { tmuxSession: String(row.task.tmuxSession) } : {}),
            ...(typeof row.task.error === "string" ? { error: String(row.task.error) } : {}),
            ...(typeof row.task.stopReason === "string" ? { stopReason: String(row.task.stopReason) } : {}),
            ...(typeof row.task.finishedAt === "string" ? { finishedAt: row.task.finishedAt } : {}),
          })),
        } : {}),
        ...(conflict ? { recoveryConflict: true } : {}),
        ...(conflict ? { blockReason: "Conflicting fresh server summaries for the same durable job identity." } : {}),
      };
      // P0-R：无冲突的服务端持久终态记录同样是远端确证；持久紧凑证明供统一名额跨落盘释放（未知/冲突不产生）。
      if (terminalStatus) merged.trustedTerminalProof = trustedTerminalProofFor(plan, merged, terminalStatus, now);
      const trainingAdopted = reviewedTrainingCompletion(plan, merged, task);
      if (trainingAdopted) Object.assign(merged, { trainingRecovery: task.trainingRecovery, originalExecution: task.originalExecution });
      if (existing >= 0) {
        const local = plan.jobs[existing];
        const localIdentity = [local.workerId, local.commandId, local.case, local.seed, local.outputDir].join("\0");
        const remoteIdentity = [merged.workerId, merged.commandId, merged.case, merged.seed, merged.outputDir].join("\0");
        const sameJob = local.index === merged.index && local.attempt === merged.attempt && local.case === merged.case
          && local.seed === merged.seed && local.outputDir === merged.outputDir;
        const unassignedLocalIntent = !local.workerId && !local.commandId && ["pending", "dispatching"].includes(local.status);
        const terminal = local.trustedTerminalStatus || (["completed", "failed", "cancelled"].includes(local.status)
          ? local.status as "completed" | "failed" | "cancelled" : undefined);
        const terminalConflict = Boolean(terminal && merged.status !== terminal && !(terminal === "failed" && trainingAdopted));
        plan.jobs[existing] = (localIdentity === remoteIdentity || unassignedLocalIntent && sameJob) && !conflict && !terminalConflict ? {
          ...local, ...merged, ...(jobIsUnavailable(plan, local) ? { status: "cancelled" as const } : {}),
          localQueueOnly: local.localQueueOnly, recallRequested: local.recallRequested,
          ...(local.error?.startsWith("code-sync proof") && typeof task.error !== "string"
            && ["queued", "running", "completed"].includes(merged.status) ? { error: undefined } : {}),
          ...(merged.history ? { history: [...(local.history || []), ...merged.history].filter((entry, index, entries) =>
            entries.findIndex(other => other.commandId === entry.commandId && other.workerId === entry.workerId
              && other.attempt === entry.attempt) === index) } : {}),
          recallOperationId: local.recallOperationId, reassignmentPending: local.reassignmentPending,
          recoveryConflict: undefined, blockReason: undefined,
          ...(terminal ? { trustedTerminalStatus: trainingAdopted ? "completed" : terminal } : {}),
        } : {
          ...local, status: "unknown", recoveryConflict: true,
          ...(terminal ? { trustedTerminalStatus: terminal } : {}),
          blockReason: terminalConflict ? "Fresh server state contradicts a trusted terminal receipt; redispatch is blocked."
            : "Server and local durable job identities conflict.",
        };
      } else plan.jobs.push(merged);
    }
    plan.planJobCount = jobCount;
    const currentAcceptedIndices = new Set(rows.filter((row) => Number(row.task.attempt) === latestAttempts.get(Number(row.task.experimentIndex)))
      .map((row) => Number(row.task.experimentIndex)));
    for (const job of plan.jobs) if (legacyReceipt(plan, job)) currentAcceptedIndices.add(job.index);
    const remoteAcceptedIndices = new Set(rows.filter(row => row.task.durableAccepted !== false
      && Number(row.task.attempt) === latestAttempts.get(Number(row.task.experimentIndex)))
      .map(row => Number(row.task.experimentIndex)));
    for (const job of plan.jobs) if (legacyReceipt(plan, job)) remoteAcceptedIndices.add(job.index);
    plan.remoteAcceptedJobCount = remoteAcceptedIndices.size;
    plan.recoveryMissingCount = distributedPlanRecoveryMissingCount(plan, currentAcceptedIndices);
    if (!countConflict && plan.recoveryConflict?.startsWith("Server summaries disagree on expected Plan job count")) delete plan.recoveryConflict;
    if (planIndex < 0) plans.push(plan); else plans[planIndex] = plan;
  }
  return { ...queue, plans, clearedJobs };
}

export function unfinishedJobs(plan: QueuedPlan, states: readonly JobState[] = UNFINISHED_JOB): boolean {
  return plan.jobs.some((job) => states.includes(job.status));
}

/** Local persistence retains unassigned jobs offline for later realtime scheduling; durableAccepted means server acceptance only. */
export function distributedSubmissionDisposition(plan: QueuedPlan | undefined) {
  const acceptedStatuses = new Set<JobState>(["queued", "running", "completed", "failed", "cancelled"]);
  return { localQueued: Boolean(plan), durableAccepted: Boolean(plan && plan.jobs.length > 0
      && plan.jobs.length === Number(plan.planJobCount || plan.jobs.length) && !plan.recoveryConflict
      && plan.jobs.every((job) => acceptedStatuses.has(job.status) && !job.admissionRejection)),
    rejectedCount: plan?.jobs.filter(job => job.status === "failed" && job.admissionRejection).length || 0,
    pendingCount: plan?.jobs.filter((job) => job.status === "pending" && !job.workerId && !job.commandId).length || 0 };
}

export function distributedSubmissionResult(plan: QueuedPlan | undefined, dispatchError = "") {
  const disposition = distributedSubmissionDisposition(plan);
  const unresolved = plan?.jobs.find((job) => !["queued", "running", "completed", "failed", "cancelled"].includes(job.status)
    && !(job.status === "pending" && !job.workerId && !job.commandId && !job.blockReason));
  // r82：隔离暂停 job 必须计入提交结果，否则部分提交会被呈现成无等待的全量接收（现场 r81d）。
  return { ...disposition, blockedCount: plan?.jobs.filter((job) => job.outputIsolationBlocked).length || 0,
    dispatchError: dispatchError || (!disposition.durableAccepted && unresolved
      ? unresolved.blockReason || "持久接收状态仍待核对" : "") };
}

/** r82（0.5.414）三类如实文案的唯一投影源：未启动+原因+下一步 / 令牌过期须重新生成预览并核对
 * 精确路径 / 其余按记录原因照实说明。绝不出现"已成功/已完成本次"类措辞，也不做会自动消失的装饰。 */
export function outputIsolationNotice(job: Pick<QueuedJob, "outputIsolationBlocked"> | undefined): string {
  const blocked = job?.outputIsolationBlocked;
  if (!blocked) return "";
  if (blocked.recovery?.state === "waiting_transfer") return "等待传输结束后自动核实旧产物；核实安全后回到自动队列，训练尚未启动。";
  if (blocked.recovery?.state === "review_required") return "传输已结束，当前仍存在旧产物；请点击“审核旧产物”核对精确路径，原有确认和产物保护保留。";
  if (blocked.recovery?.state === "unknown") return "旧产物状态本轮未核实，将自动重查；可点击“重新核实”。" + String(blocked.recovery.detail || "").slice(0,300);
  if (blocked.code === "PREVIEW_EXPIRED")
    return "旧产物隔离未完成：隔离预览确认已过期（PREVIEW_EXPIRED），训练未启动；请重新生成预览并重新核对精确路径后再确认，未复用旧令牌。";
  return "旧产物隔离未完成，训练未启动：" + String(blocked.reason || blocked.code || "隔离结果未核实").slice(0, 300)
    + "。请通过“重新核实/审核旧产物”重新审核（覆盖须重走完整两次确认）。";
}

/** r82（0.5.414）提交体→入队→派发共用的唯一事实源：划分 可执行 / 隔离暂停（可见 pending 但不得
 * 派发，携带 job 级标记）/ 有意跳过（用户选择沿用完成，不入队）。blocked 源仅认隔离流程
 * （flow==="isolate"）的结构化阻断；标记缺失≠已证明隔离成功——它由本函数按当轮提交体生成，
 * 任何派发路径都不得用"没有标记"反推准入。 */
export function planDispatchSelection(validation: { jobs?: Array<Record<string, unknown>> } | undefined, body: any): {
  selectedJobs: Array<Record<string, unknown>>; launchableJobs: Array<Record<string, unknown>>;
  userSkipped: Set<number>; blockedMarkers: Map<number, NonNullable<QueuedJob["outputIsolationBlocked"]>> } {
  const jobs = validation?.jobs || [];
  const blockedRows = body?.runReplacement?.flow === "isolate" && Array.isArray(body.runReplacement.blocked) ? body.runReplacement.blocked : [];
  const blockedMarkers = new Map<number, NonNullable<QueuedJob["outputIsolationBlocked"]>>();
  const observedAt = new Date().toISOString();
  for (const row of blockedRows) {
    const index = Number(row?.index);
    if (!Number.isInteger(index)) continue;
    const declaration = jobs.find(job => Number(job.index) === index);
    const declarationKey = String(declaration?.output_dir || declaration?.outputDir || row?.declarationKey || "");
    const stage = row?.stage === "preview" || row?.stage === "execute" || row?.stage === "verify" ? row.stage : "execute";
    blockedMarkers.set(index, { reason: String(row?.reason || "隔离结果未核实"), stage,
      ...(row?.code ? { code: String(row.code) } : {}), ...(row?.operationId ? { operationId: String(row.operationId) } : {}),
      ...(Array.isArray(row?.codes) ? { codes: row.codes.map(String) } : {}), ...(typeof row?.busyOnly === "boolean" ? { busyOnly: row.busyOnly } : {}),
      declarationKey, observedAt: String(row?.observedAt || observedAt) });
  }
  const userSkipped = new Set<number>(body?.existingOutputChoice === "rerun_missing"
    ? (Array.isArray(body.distributedSkipJobIndices) ? body.distributedSkipJobIndices.map(Number) : []).filter(Number.isInteger) : []);
  const selectedJobs = jobs.filter(job => !userSkipped.has(Number(job.index)));
  return { selectedJobs, launchableJobs: selectedJobs.filter(job => !blockedMarkers.has(Number(job.index))), userSkipped, blockedMarkers };
}

export function distributedSubmissionProgress(submission: { enqueued?: boolean; localQueued?: boolean; pendingCount?: number; rejectedCount?: number; dispatchError?: string; blockedCount?: number; skippedCount?: number } | undefined) {
  if (!submission) return { status: "failed" as const, waiting: false, message: "本机未能确认保存调度意图：未返回提交记录。" };
  if (submission.enqueued === false) return { status: "succeeded" as const, waiting: false,
    message: "已有产物覆盖本次全部任务；按所选“跳过已有”处理，未创建新调度任务。" };
  if (submission.localQueued !== true) return { status: "failed" as const, waiting: false,
    message: `本机未能确认保存调度意图：${submission.dispatchError || "状态未知"}。` };
  if (Number(submission.rejectedCount || 0) > 0) return { status: "failed" as const, waiting: false,
    message: `${submission.rejectedCount} 个 job 被 Worker 启动前预检拒绝，未启动训练。具体原因见 Plan 卡片；这些 job 不会自动重派。` };
  // r82：部分提交如实呈现——存在隔离暂停 job 时绝不沿用"调度队列已接收"的全量接收文案；
  // 计数区分 可执行（等待派发）/ 隔离暂停（须重新审核）/ 有意跳过（沿用完成），进持久操作日志。
  if (Number(submission.blockedCount || 0) > 0) {
    const pending = Number(submission.pendingCount || 0) > 0 ? `${submission.pendingCount} 个可执行 job 等待派发` : "本批没有可立即派发的 job";
    const skipped = Number(submission.skippedCount || 0) > 0 ? `，${submission.skippedCount} 个按所选沿用完成产物` : "";
    const detail = submission.dispatchError ? `状态核对仍有待处理项：${submission.dispatchError}。` : "";
    return { status: "succeeded" as const, waiting: true,
      message: `本机调度队列已保存：${pending}${skipped}；另有 ${submission.blockedCount} 个 job 旧产物隔离未完成，训练未启动、不会自动重派，请在 Plan 卡片通过“重新排队此 job”重新审核产物处理。${detail}刷新状态可查看进度。` };
  }
  if (Number(submission.pendingCount || 0) > 0 || Boolean(submission.dispatchError)) {
    const pending = Number(submission.pendingCount || 0) > 0 ? ` ${submission.pendingCount} 个 job 保持未绑定，等待新鲜空闲 GPU。` : "";
    const detail = submission.dispatchError ? ` 状态核对仍有待处理项：${submission.dispatchError}。` : "";
    return { status: "succeeded" as const, waiting: true,
      message: `本机调度队列已保存。${pending}${detail}实时连接恢复后继续派发；刷新状态可查看进度。` };
  }
  return { status: "succeeded" as const, waiting: false,
    message: "调度队列已接收；面板继续显示 Worker 回传的任务状态。" };
}

export function fingerprintStillMounted(queue: DistributedQueue, fingerprint: string, workerFingerprints: readonly string[]): boolean {
  const unfinished = queue.plans.filter((plan) => plan.codeFingerprint === fingerprint && unfinishedJobs(plan));
  if (!unfinished.length) return false;
  if (!workerFingerprints.length) return true;
  return workerFingerprints.includes(fingerprint);
}

/** Pending code only occupies the queue when a verified Worker still has that fingerprint. Running work always occupies it. Missing version evidence stays conservative. */
export function queueOccupiesCodeVersion(queue: DistributedQueue, verifiedWorkerFingerprints: ReadonlyMap<string, string> | Record<string, string>): boolean {
  const verified = verifiedWorkerFingerprints instanceof Map
    ? [...verifiedWorkerFingerprints.values()]
    : Object.values(verifiedWorkerFingerprints || {});
  const known = verified.filter(Boolean);
  return queue.plans.some((plan) => plan.jobs.some((job) => {
    if (jobHasLiveExecution(job)) return true;
    if (job.status !== "pending") return false;
    if (!known.length) return true;
    return known.includes(plan.codeFingerprint);
  }));
}
export type Dispatch = { planId: string; jobIndex: number; workerId: string; gpuId: string; attempt: number; commandId: string };

/** Current windows or an exact unresolved local start reserve capacity; history alone never does. */
export function jobHasLiveExecution(job: QueuedJob): boolean {
  if (job.lifecycleProtocol === 2 && job.executionState === "missing" && !job.statusQueryError) return false;
  const intent = job.startIntent;
  const starting = Boolean(intent && ["dispatching", "unknown", "queued"].includes(job.status)
    && intent.commandId === job.commandId && intent.workerId === job.workerId && intent.gpuId === job.gpuId);
  return job.lifecycleProtocol === 2 ? starting || ["queued", "starting", "running"].includes(job.executionState || "")
    || job.executionState === "unknown" && Boolean(job.statusQueryError || job.tmuxWindowId && job.tmuxPane)
    || job.status === "dispatching" && !job.lastObservedAt
    : ["dispatching", "queued", "running", "unknown"].includes(job.status);
}

/** Reserve automatic slots from current execution evidence, never from historical unknown labels. */
export function activeGpuReservations(queue: DistributedQueue) {
  const activeByWorker = new Map<string, number>(), occupiedGpuIds = new Set<string>();
  for (const plan of queue.plans) for (const job of plan.jobs) {
    if (job.manualDispatch || !job.workerId || !jobHasLiveExecution(job)) continue;
    activeByWorker.set(job.workerId, (activeByWorker.get(job.workerId) || 0) + 1);
    if (job.gpuId !== undefined) occupiedGpuIds.add(`${job.workerId}:${job.gpuId}`);
  }
  return { activeByWorker, occupiedGpuIds };
}

/** A project root on one Worker may host only one live code version. Other Workers are independent. */
export function workerCodeVersionAvailable(queue: DistributedQueue, workerId: string, fingerprint: string): boolean {
  return Boolean(workerId && fingerprint) && !queue.plans.some((plan) => {
    if (plan.recoveryConflict && plan.jobs.some(job => job.lifecycleProtocol !== 2) && plan.codeFingerprint !== fingerprint) return true;
    return plan.jobs.some((job) => {
      if (!jobHasLiveExecution(job)) return false;
      if (job.workerId && job.workerId !== workerId) return false;
      return !plan.codeFingerprint || plan.codeFingerprint !== fingerprint;
    });
  });
}

export const emptyDistributedQueue = (): DistributedQueue => ({ schemaVersion: 1, plans: [] });

export function completedJobOutputs(queue: DistributedQueue, planFile: string, jobs: Array<Pick<QueuedJob, "index" | "case" | "seed">>) {
  // Historical status has no current Worker config/checkpoint/file-hash proof.
  // Keep this entry point for compatibility, but never use it to adopt/skip a new job.
  // Current declared outputs are inspected by the Worker validation/admission path.
  return [] as Array<{ index: number; case: string; seed: number; output_dir: string }>;
}

/** r17-A: the live queue lives inside the CONSUMED project (simple_cluster/state/…), one per
 * projectRoot; storageRoot is retained only to locate the known legacy snapshot for a
 * one-time migration read. Two windows share one queue per project, and projects never
 * share queue files. */
export function distributedQueuePath(storageRoot: string, projectRoot: string): string {
  return projectStateFile(projectRoot, "simple-experiment", "distributed-plan-queues", projectStateId(projectRoot) + ".json");
}

/** Exact legacy location (globalStorage) — read-only migration source, never written again. */
export function legacyDistributedQueuePath(storageRoot: string, projectRoot: string): string {
  const root = path.resolve(projectRoot);
  const key = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
  return path.join(storageRoot, "distributed-plan-queues", key + ".json");
}

export function enqueuePlan(queue: DistributedQueue, plan: Omit<QueuedPlan, "id" | "enqueuedAt" | "jobs"> & { jobs: Array<Pick<QueuedJob, "index" | "case" | "seed" | "outputDir" | "collectionResultCsv" | "checkpointSource" | "outputIsolationBlocked">> }, id: string, enqueuedAt = new Date().toISOString()): DistributedQueue {
  if (!plan.revision || !plan.codeFingerprint || !plan.planFile || !id) throw new Error("Plan identity and code fingerprint are required.");
  const registered = queue.plans.find(item => item.id === id);
  if (registered) {
    if (registered.planFile !== plan.planFile || registered.revision !== plan.revision || registered.codeFingerprint !== plan.codeFingerprint
      || registered.executionMode !== plan.executionMode || registered.jobs.length !== plan.jobs.length
      || plan.jobs.some(job => !registered.jobs.some(prior => prior.index === job.index && prior.case === job.case && prior.seed === job.seed
        && prior.outputDir === job.outputDir && prior.collectionResultCsv === job.collectionResultCsv
        && JSON.stringify(prior.checkpointSource || null) === JSON.stringify(job.checkpointSource || null))))
      throw new Error("FORMAL_JOB_IDENTITY_CONFLICT: duplicate workflow has different declarations.");
    return queue;
  }
  const indices = new Set<number>();
  const jobs = plan.jobs.map((job) => {
    if (!Number.isInteger(job.index) || job.index < 0 || indices.has(job.index) || !job.case || !Number.isInteger(job.seed) || !job.outputDir) throw new Error("Invalid or repeated Plan job.");
    indices.add(job.index);
    if (job.outputDir.split("/").includes("attempts") || job.outputDir.startsWith("/") || /^[A-Za-z]:/.test(job.outputDir)
      || job.outputDir.split("/").some(part => !part || part === "." || part === "..")) throw new Error("FORMAL_JOB_PATH_REQUIRED: historical attempts are read-only.");
    if (job.collectionResultCsv && (job.collectionResultCsv.includes("\\") || job.collectionResultCsv.startsWith("/")
      || /^[A-Za-z]:/.test(job.collectionResultCsv) || job.collectionResultCsv.split("/").some(part => !part || part === "." || part === ".." || part === "attempts")))
      throw new Error("FORMAL_JOB_CSV_PATH_REQUIRED");
    if (plan.jobs.some(other => other !== job && (other.outputDir === job.outputDir
        || job.collectionResultCsv && other.collectionResultCsv === job.collectionResultCsv))
      || queue.plans.some(other => !(other.cleanup && ["archived", "deleted"].includes(other.cleanup.state)
        && other.cleanup.operationId && !other.cleanup.pendingNodes?.length) && other.jobs.some(prior => !(prior.outputRetiredAt
        && ["completed", "failed", "cancelled"].includes(prior.status) && prior.cleanup && ["archived", "deleted"].includes(prior.cleanup.state)
        && prior.cleanup.operationId && prior.cleanup.completedTargets?.length && !prior.cleanup.pendingNodes?.length)
        && prior.lifecycleProtocol === 2 && prior.status === "pending" && !prior.workerId && !prior.commandId
        && (prior.outputDir === job.outputDir || job.collectionResultCsv && prior.collectionResultCsv === job.collectionResultCsv))))
      throw new Error("FORMAL_JOB_CONFLICT: duplicate local pending job declarations; cancel the unsent duplicate first.");
    return { index: job.index, case: job.case, seed: job.seed, outputDir: job.outputDir,
      ...(job.collectionResultCsv ? { collectionResultCsv: job.collectionResultCsv } : {}),
      ...(job.checkpointSource ? { checkpointSource: job.checkpointSource } : {}),
      // r82：隔离阻断 job 照常入队（可见、pending），标记随行持久化；派发过滤、面板解释与
      // 发送前复查都读这份队列事实，而不是提交内存。
      ...(job.outputIsolationBlocked ? { outputIsolationBlocked: job.outputIsolationBlocked } : {}),
      lifecycleProtocol: 2 as const, resultPathPolicy: "declared" as const, globalJobId: `${id}:${job.index}`, attempt: 0, status: "pending" as const };
  });
  if (!jobs.length) throw new Error("Plan has no jobs.");
  const planJobCount = Number(plan.planJobCount || plan.jobs.length);
  if (!Number.isInteger(planJobCount) || planJobCount < jobs.length) throw new Error("Plan expected job count is invalid.");
  return { ...queue, plans: [...queue.plans, { ...plan, planJobCount, id, enqueuedAt,
    resultPathPolicy: "declared", automaticRetry: { enabledAt: enqueuedAt }, jobs }] };
}

function usableSlots(row: WorkerSlots) {
  return row.online && (row.gpuSlots ?? [...new Set(row.idleGpuIds)]).slice(0, Math.max(0, row.capacity ?? row.gpuSlots?.length ?? row.idleGpuIds.length)).length > 0;
}

export function pinnedRetryPlanAllowed(plan: QueuedPlan): boolean {
  return plan.resultPathPolicy === "declared" && !plan.executionModeBlocked && (plan.schedulingMode !== "server_prequeue" || plan.localDispatchOverride === true
    || plan.jobs.some((job) => job.localQueueOnly === true && ["dispatching", "unknown"].includes(job.status)));
}

export function hostedRetryCandidates(plan: QueuedPlan, now = Date.now()): QueuedJob[] {
  if (plan.resultPathPolicy !== "declared" || plan.executionModeBlocked || plan.schedulingMode !== "server_prequeue" || plan.localDispatchOverride === true || plan.recoveryConflict) return [];
  return plan.jobs.filter((job) => job.localQueueOnly !== true && job.recallRequested !== true && !job.stopIntent
    && Boolean(job.workerId && job.commandId) && ["dispatching", "unknown"].includes(job.status)
    && dispatchReconciliationDue(job, now));
}

function noteFingerprintMismatch(plans: QueuedPlan[], workers: readonly WorkerSlots[]) {
  if (!workers.some((row) => row.codeFingerprint || row.codeScopeErrors || row.compatiblePlans?.length)) return;
  const anyOnline = workers.some((row) => row.online);
  for (const plan of plans) {
    if (plan.resultPathPolicy !== "declared") continue; // Retain old queue records, never resume their execution.
    const matched = workers.some((row) => row.online && workerCanRunPlan({schemaVersion:1,plans},row,plan));
    const held = plan.jobs.some(jobHasLiveExecution);
    const waiting = !matched && workers.some(row => row.online && row.codeFingerprint === plan.codeFingerprint);
    for (const job of plan.jobs) {
      if (job.status !== "pending" || job.outputIsolationBlocked) continue;
      const scopeErrors = workers.filter(row=>row.online).map(row=>row.codeScopeErrors?.[plan.id]).filter(Boolean);
      // Refresh-in-flight is a gate, not evidence of changed/missing source.
      // Preserve the existing queue reason until a real outcome is available.
      if (!matched && !scopeErrors.length && workers.some(row => row.online && row.codeScopePending?.[plan.id])) continue;
      if (!matched && scopeErrors.length) { job.blockReason = "PLAN 所需源码待核实：" + scopeErrors.slice(0,3).join("；"); continue; }
      if (waiting) job.blockReason = CODE_FINGERPRINT_WAITING;
      else if (anyOnline && !matched && !held) job.blockReason = CODE_FINGERPRINT_MISMATCH;
      else if (job.blockReason === CODE_FINGERPRINT_MISMATCH || String(job.blockReason || "").startsWith("等待当前代码版本")
        || matched && String(job.blockReason || "").startsWith("PLAN 所需源码待核实")) delete job.blockReason;
    }
  }
}

export function allocateAvailable(queue: DistributedQueue, workers: readonly WorkerSlots[], options: { requireIdleGpuAdmission?: boolean; localIdleOnly?: boolean;
  memoryBudget?: ReturnType<typeof import("./GpuMemoryBudget").memoryBudgetAdmission> } = {}): { queue: DistributedQueue; dispatches: Dispatch[] } {
  const versioned = workers.some((row) => row.codeFingerprint);
  const plans = queue.plans.map((plan) => ({ ...plan, jobs: plan.jobs.map((job) => ({ ...job })) }));
  const dispatches: Dispatch[] = [];
  const activeFingerprint = plans.find((plan) => plan.jobs.some(jobHasLiveExecution))?.codeFingerprint;
  const runnableFingerprint = !versioned && (activeFingerprint || plans.find((plan) => (!options.localIdleOnly || plan.schedulingMode !== "server_prequeue" || plan.localDispatchOverride === true
    || plan.jobs.some((job) => job.status === "pending" && job.localQueueOnly === true && !job.recallRequested))
    && plan.jobs.some((job) => job.status === "pending" && !job.recallRequested
      && (!options.localIdleOnly || plan.schedulingMode !== "server_prequeue" || plan.localDispatchOverride === true || job.localQueueOnly === true))
    && (!versioned || workers.some((row) => usableSlots(row)
      && (!options.requireIdleGpuAdmission || row.idleGpuAdmission === true) && row.codeFingerprint === plan.codeFingerprint)))?.codeFingerprint);
  const slots = new Map(workers.filter((row) => row.online && (!options.requireIdleGpuAdmission || row.idleGpuAdmission === true)
    && (!versioned || Boolean(row.codeFingerprint) || Boolean(row.compatiblePlans?.length)))
    .map((row) => [row.workerId, (row.gpuSlots ?? [...new Set(row.idleGpuIds)]).slice(0, Math.max(0, row.capacity ?? row.gpuSlots?.length ?? row.idleGpuIds.length))]));
  for (const plan of options.memoryBudget?.sortPlans(plans) || plans) {
    if (plan.executionModeBlocked || plan.recoveryConflict) continue;
    if (plan.resultPathPolicy !== "declared") continue;
    if (options.localIdleOnly && plan.schedulingMode === "server_prequeue" && plan.localDispatchOverride !== true
      && !plan.jobs.some((job) => job.status === "pending" && job.localQueueOnly === true && !job.recallRequested)) continue;
    if (!versioned && (!runnableFingerprint || plan.codeFingerprint !== runnableFingerprint)
      && !workers.some(row=>row.online&&row.compatiblePlans?.includes(plan.id))) continue;
    // r82：隔离暂停 job 不得进入自动派发候选（现场 03:25:27Z：阻断 job 照常派发→远端 FORMAL_JOB_CONFLICT 退出 1）。
    const pending = plan.jobs.filter((job) => !job.manualDispatch && job.status === "pending" && !job.recallRequested && !job.stopIntent
      && !job.outputIsolationBlocked
      && (!options.localIdleOnly || plan.schedulingMode !== "server_prequeue" || plan.localDispatchOverride === true || job.localQueueOnly === true));
    if (!pending.length) continue;
    const eligibleWorkerIds = new Set(workers.filter(row => row.declaredJobPaths === true
      && !row.codeScopeErrors?.[plan.id] && !row.codeScopePending?.[plan.id] && (!versioned || workerCanRunPlan({ ...queue, plans }, row, plan))).map(row => row.workerId));
    const ranked = () => [...slots].filter(([id, gpuIds]) => gpuIds.length && eligibleWorkerIds.has(id))
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const assignedWorkerIds = [...new Set(plan.jobs.filter((job) => job.workerId).map((job) => job.workerId!))];
    const primary = assignedWorkerIds.find((id) => eligibleWorkerIds.has(id) && (slots.get(id)?.length || 0) > 0) || ranked()[0]?.[0];
    if (!primary) continue;
    const cases = [...new Set(pending.map((job) => job.case))];
    for (const caseName of cases) {
      const caseJobs = pending.filter((job) => job.case === caseName).sort((a, b) => a.index - b.index);
      const whole = ranked().find(([workerId, ids]) => workerId === primary && ids.length >= caseJobs.length)
        || ranked().find(([, ids]) => ids.length >= caseJobs.length);
      for (const job of caseJobs) {
        const allowedWorkers = workers.filter(worker => eligibleWorkerIds.has(worker.workerId)
          && (!job.automaticWorkerId || worker.workerId === job.automaticWorkerId));
        const budgetChoice = options.memoryBudget?.choose(plan, job, allowedWorkers, slots);
        const chosen = options.memoryBudget ? budgetChoice?.workerId : job.automaticWorkerId ? allowedWorkers.some(worker => worker.workerId === job.automaticWorkerId)
          && slots.get(job.automaticWorkerId)?.length ? job.automaticWorkerId : undefined
          : job.reassignmentWorkerId ? eligibleWorkerIds.has(job.reassignmentWorkerId)
          && slots.get(job.reassignmentWorkerId)?.length ? job.reassignmentWorkerId : undefined
          : whole?.[0] && slots.get(whole[0])?.length ? whole[0]
          : slots.get(primary)?.length ? primary : ranked()[0]?.[0];
        if (!chosen) continue;
        const gpuId = options.memoryBudget ? budgetChoice?.gpuId : slots.get(chosen)?.shift();
        if (gpuId === undefined) break;
        if (options.memoryBudget) slots.get(chosen)!.splice(slots.get(chosen)!.indexOf(gpuId), 1);
        const commandId = durableCommandId(plan, job, chosen, gpuId);
        if (commandId !== job.commandId) Object.assign(job, { runtimeDiagnostics: undefined, completionState: undefined, exitCode: undefined });
        Object.assign(job, { status: "dispatching", workerId: chosen, gpuId, commandId, blockReason: undefined,
          ...(job.lifecycleProtocol === 2 ? { startIntent: { commandId, workerId: chosen, gpuId } } : {}),
          reassignmentWorkerId: undefined });
        options.memoryBudget?.reserve(plan, job, chosen, gpuId);
        dispatches.push({ planId: plan.id, jobIndex: job.index, workerId: chosen, gpuId, attempt: job.attempt, commandId });
      }
    }
  }
  noteFingerprintMismatch(plans, workers);
  return { queue: { ...queue, plans }, dispatches };
}

export function previewAvailable(queue: DistributedQueue, plan: Omit<QueuedPlan, "id" | "enqueuedAt" | "jobs"> & { jobs: Array<Pick<QueuedJob, "index" | "case" | "seed" | "outputDir">> }, workers: readonly WorkerSlots[]) {
  const previewId = "distributed-preview";
  // Capacity preview does not authorize a writer. Retain original terminal rows
  // in the real queue and surface their conflicts for the explicit output review.
  const reviewedIndices = new Set<number>();
  const capacityQueue = { ...queue, plans: queue.plans.map(prior => ({ ...prior, jobs: prior.jobs.filter(job => {
    const conflicts = plan.jobs.filter(current => current.outputDir === job.outputDir);
    if (["completed", "failed", "cancelled"].includes(job.status) && conflicts.length) {
      conflicts.forEach(current => reviewedIndices.add(current.index)); return false;
    }
    return true;
  }) })).filter(prior => prior.jobs.length) };
  const candidate = enqueuePlan(capacityQueue, plan, previewId);
  const { dispatches } = allocateAvailable(candidate, workers);
  const selected = dispatches.filter((item) => item.planId === previewId);
  return { totalJobs: plan.jobs.length, outputReviewIndices: [...reviewedIndices], dispatchableCount: selected.length,
    queuedCount: plan.jobs.length - selected.length,
    assignments: selected.map(({ jobIndex, workerId, gpuId }) => ({ jobIndex, workerId, gpuId })) };
}

export function setJobState(queue: DistributedQueue, planId: string, jobIndex: number, status: JobState, commandId: string): DistributedQueue {
  let found = false;
  const plans = queue.plans.map((plan) => plan.id !== planId ? plan : { ...plan, jobs: plan.jobs.map((job) => {
    if (job.index !== jobIndex || job.commandId !== commandId) return job;
    found = true;
    return { ...job, status };
  }) });
  if (!found) throw new Error("Job command identity does not match persisted queue.");
  return { ...queue, plans };
}

export function remoteTaskMatchesJob(plan: QueuedPlan, job: QueuedJob, task: Record<string, unknown>): boolean {
  const gpuMatches = job.gpuId === undefined || plan.schedulingMode === "server_prequeue" && job.gpuId === ""
    || String(task.gpuId ?? "") === String(job.gpuId);
  return Boolean(job.commandId && job.workerId && gpuMatches
    && String(task.commandId || "") === job.commandId
    && String(task.workflowId || "") === plan.id
    && (!plan.projectId || String(task.projectId || "") === plan.projectId)
    && (!plan.projectId || String(task.planFile || "") === plan.planFile)
    && String(task.planRevision || "") === plan.revision
    && (!plan.executionMode || task.executionMode === undefined || task.executionMode === plan.executionMode)
    && (!plan.projectId || String(task.codeFingerprint || "") === plan.codeFingerprint)
    && (!plan.projectId || Number(task.planJobCount) === Number(plan.planJobCount))
    && (!plan.projectId || Number(task.experimentIndex) === job.index)
    && (!plan.projectId || String(task.runKey || "") === String(job.runKey || job.commandId))
    && String(task.case || "") === job.case
    && Number(task.seed) === job.seed
    && (plan.resultPathPolicy === "declared" ? formalStopIdentityMatches(plan, job, task) : taskAttempt(task) === job.attempt)
    && String(task.outputDir || "") === job.outputDir
    && String(task.workerId || "") === job.workerId);
}

export function hasLegacyOwnership(job: QueuedJob): boolean {
  return job.legacyOwnership === true && Boolean(job.workerId && job.commandId);
}

export function resetUnsentDispatch(queue: DistributedQueue, planId: string, jobIndex: number, commandId: string, reason?: string): DistributedQueue {
  const plan = queue.plans.find(row => row.id === planId), job = plan?.jobs.find(row => row.index === jobIndex && row.commandId === commandId);
  if (!job || job.status !== "dispatching" && !(job.lifecycleProtocol === 2 && job.status === "unknown" && job.startIntent?.commandId === commandId)
    || job.stopIntent || job.recallRequested || job.dispatchAcknowledgedAt || job.executionState && job.executionState !== "missing") return queue;
  return { ...queue, plans: queue.plans.map((plan) => plan.id !== planId ? plan : { ...plan,
    jobs: plan.jobs.map((row) => row !== job ? row : { ...row, status: "pending" as const, workerId: undefined, gpuId: undefined,
      commandId: undefined, startIntent: undefined, runKey: undefined, lastDispatchAttemptAt: undefined,
      executionState: undefined, statusQueryError: undefined, lastObservedAt: undefined,
      ...(row.lifecycleProtocol === 2 ? { nextCommandId: commandId } : {}),
      blockReason: reason ? "尚未发送，等待重新核实：" + reason : undefined }) }) };
}

export function resetBusyRejectedDispatch(queue: DistributedQueue, dispatch: Dispatch, receipt: Record<string, unknown>): DistributedQueue {
  if (receipt?.durableAccepted !== false || receipt?.admissionRejected !== true || String(receipt?.status || "") !== "pending"
    || String(receipt?.reason || "") !== "gpu_busy" || String(receipt?.commandId || "") !== dispatch.commandId
    || String(receipt?.workerId || "") !== dispatch.workerId || String(receipt?.gpuId || "") !== dispatch.gpuId) return queue;
  const plan = queue.plans.find((row) => row.id === dispatch.planId);
  const job = plan?.jobs.find((row) => row.index === dispatch.jobIndex && row.attempt === dispatch.attempt);
  if (!plan || !job || !remoteTaskMatchesJob(plan, job, receipt)) return queue;
  return { ...queue, plans: queue.plans.map((plan) => plan.id !== dispatch.planId ? plan : { ...plan,
    jobs: plan.jobs.map((job) => job.index !== dispatch.jobIndex || job.attempt !== dispatch.attempt
      || job.commandId !== dispatch.commandId || job.workerId !== dispatch.workerId || job.gpuId !== dispatch.gpuId
      || !["dispatching", "unknown"].includes(job.status) ? job : { ...job, status: "pending" as const, workerId: undefined,
        gpuId: undefined, commandId: undefined, startIntent: undefined, runKey: undefined, lastDispatchAttemptAt: undefined, dispatchAcknowledgedAt: undefined,
        blockReason: "Worker confirmed the requested GPU was busy; awaiting fresh availability." }) }) };
}

function preflightRejectionEvidence(receipt: Record<string, unknown>): boolean {
  return receipt.durableAccepted === false && receipt.admissionRejected === true && receipt.status === "failed"
    && receipt.reason === "formal_preflight_rejected" && receipt.neverStarted === true
    && receipt.neverStartedEvidence === "formal_preflight_rejected" && receipt.resultPathPolicy === "declared"
    && /^[A-Z][A-Z0-9_]{2,80}$/.test(String(receipt.errorCode || ""))
    && Number.isFinite(Date.parse(String(receipt.finishedAt || ""))) && Boolean(receipt.error || receipt.message);
}

/** Only a durable, exact pre-execution rejection can resolve uncertain dispatch as failed. */
export function applyPreflightRejectedDispatch(queue: DistributedQueue, plan: QueuedPlan, job: QueuedJob,
  receipt: Record<string, unknown>): DistributedQueue {
  if (!preflightRejectionMatchesJob(plan, job, receipt) || !["dispatching", "unknown"].includes(job.status)) return queue;
  const rejection = { code: String(receipt.errorCode), message: String(receipt.error || receipt.message),
    rejectedAt: String(receipt.finishedAt) };
  return { ...queue, plans: queue.plans.map(row => row.id !== plan.id ? row : { ...row,
    jobs: row.jobs.map(item => item.index !== job.index || item.commandId !== job.commandId ? item : {
      ...item, status: "failed" as const, trustedTerminalStatus: "failed" as const, error: rejection.message,
      admissionRejection: rejection, finishedAt: rejection.rejectedAt, blockReason: undefined, startIntent: undefined,
      formalConflictEvidence: receipt.formalConflictEvidence as Record<string, unknown> | undefined,
      dispatchAcknowledgedAt: new Date().toISOString(),
    }) }) };
}

function preflightRejectionMatchesJob(plan: QueuedPlan, job: QueuedJob, receipt: Record<string, unknown>): boolean {
  return preflightRejectionEvidence(receipt) && remoteTaskMatchesJob(plan, job, receipt)
    && receipt.executionMode === plan.executionMode && receipt.globalJobId === job.globalJobId
    && receipt.collectionResultCsv === job.collectionResultCsv;
}

export function retryPinnedDispatch(queue: DistributedQueue, planId: string, jobIndex: number,
  snapshot: DurableWorkerSnapshot | undefined, idleGpuIds: readonly string[], now = Date.now()): Dispatch | undefined {
  const plan = queue.plans.find((row) => row.id === planId);
  const job = plan?.jobs.find((row) => row.index === jobIndex);
  if (!plan || !job || plan.recoveryConflict || job.recoveryConflict || job.recallRequested === true || job.stopIntent || !["dispatching", "unknown"].includes(job.status)
    || !job.workerId || !job.commandId || !String(job.gpuId || "").trim()
    || !dispatchReconciliationDue(job, now)
    || !snapshotAllowsPinnedRetry(snapshot, job, now)) return undefined;
  const occupiedByOther = queue.plans.some((candidatePlan) => candidatePlan.jobs.some((candidate) =>
    !(candidatePlan.id === planId && candidate.index === jobIndex && candidate.attempt === job.attempt)
    && candidate.workerId === job.workerId && String(candidate.gpuId ?? "") === String(job.gpuId)
    && ["dispatching", "queued", "running", "unknown"].includes(candidate.status)));
  if (occupiedByOther || !idleGpuIds.some((id) => String(id) === String(job.gpuId))) return undefined;
  return { planId, jobIndex, workerId: job.workerId, gpuId: job.gpuId!, attempt: job.attempt, commandId: job.commandId };
}

function snapshotAllowsPinnedRetry(snapshot: DurableWorkerSnapshot | undefined, job: QueuedJob, now: number): boolean {
  if (!snapshot || !hasFreshDurableSnapshot(snapshot, now) || snapshot.workerId !== job.workerId
    || snapshot.capabilities?.idleGpuAdmission !== true) return false;
  const sameCommand = (snapshot.tasks || []).find((task) => String(task.commandId || "") === job.commandId);
  return !sameCommand;
}

export function releaseQueuedForReassignment(queue: DistributedQueue, planId: string, jobIndex: number,
  receipt: Record<string, unknown>, nextRunId: string): DistributedQueue {
  const plan = queue.plans.find((row) => row.id === planId);
  const job = plan?.jobs.find((row) => row.index === jobIndex);
  if (!plan || !job || !["queued", "cancelled", "unknown"].includes(job.status) || job.reassignmentPending !== true
    || !isExactQueuedReleaseProof(plan, job, receipt)
    || String(receipt?.status || "").toLowerCase() !== "cancelled" || String(receipt?.stopReason || "") !== "requeue"
    || !/^[a-zA-Z0-9-]{8,80}$/.test(nextRunId))
    throw new Error("Queued job release proof does not match the exact persisted job identity.");
  const outputDir = nextAttemptOutputDir(job.outputDir, nextRunId);
  return { ...queue, plans: queue.plans.map((row) => row.id !== planId ? row : { ...row,
    jobs: row.jobs.map((item) => item.index !== jobIndex ? item : {
      ...item, outputDir, attempt: 0, nextCommandId: nextRunId, workerId: undefined, commandId: undefined, runKey: undefined, gpuId: undefined, manualDispatch: undefined,
      runtimeDiagnostics: undefined, completionState: undefined, exitCode: undefined,
      status: "pending" as const, projectId: item.projectId, localQueueOnly: true, recallRequested: undefined,
      recallOperationId: undefined, reassignmentPending: undefined,
      reassignmentWorkerId: item.reassignmentWorkerId,
      automaticRetry: item.automaticRetry,
      history: [...(item.history || []), { attempt: item.attempt,
        status: "cancelled" as const, workerId: item.workerId, commandId: item.commandId, outputDir: item.outputDir,
        ...(item.logPath ? { logPath: String(item.logPath) } : {}),
        ...(item.tmuxSession && /^[A-Za-z0-9._-]+$/.test(String(item.tmuxSession)) ? { tmuxSession: String(item.tmuxSession) } : {}),
        finishedAt: typeof receipt.finishedAt === "string" ? receipt.finishedAt : item.finishedAt, stopReason: "requeue" }],
    }) }) };
}

export function isExactQueuedReleaseProof(plan: QueuedPlan, job: QueuedJob, proof: Record<string, unknown>): boolean {
  if (proof.durableReleased !== true || proof.neverStarted !== true || !recognizedNeverStartedEvidence(proof.neverStartedEvidence)) return false;
  if (proof.legacyReleased === true)
    return historicalRecallIdentityMatchesJob(plan, job, proof);
  const modernIdentity = [proof.projectId, proof.codeFingerprint, proof.workflowId, proof.planRevision,
    proof.planFile, proof.experimentIndex, proof.runKey, proof.case, proof.seed,
    ...(plan.resultPathPolicy === "declared" ? [proof.globalJobId, proof.collectionResultCsv] : [taskAttempt(proof)]),
    proof.outputDir, proof.workerId, proof.targetCommandId, proof.planJobCount];
  if (modernIdentity.some((value) => value === undefined || value === null || value === "")) return false;
  return proof.durableAccepted === true && recallResponseMatchesJob(plan, job, proof)
    && stopIdentityMatchesJob(plan, job, { ...proof, commandId: proof.targetCommandId })
    && Number(proof.planJobCount) === Number(plan.planJobCount || plan.jobs.length);
}

export function recallResponseMatchesJob(plan: QueuedPlan, job: QueuedJob, identity: Record<string, unknown>): boolean {
  const targetCommandId = String(identity.targetCommandId || "");
  if (!targetCommandId || targetCommandId !== job.commandId) return false;
  const normalized = { ...identity, commandId: targetCommandId };
  return identityAliasesMatchJob(plan, job, identity) && (stopIdentityMatchesJob(plan, job, normalized)
    || historicalRecallTaskMatchesJob(plan, job, normalized));
}

function identityAliasesMatchJob(plan: QueuedPlan, job: QueuedJob, identity: Record<string, unknown>): boolean {
  const equalsAll = (keys: string[], expected: unknown, normalize: (value: unknown) => string = (value) => String(value ?? "")) =>
    keys.every((key) => identity[key] === undefined || identity[key] === null || normalize(identity[key]) === normalize(expected));
  return equalsAll(["workflowId", "planId"], plan.id)
    && ["planFile", "plan"].every((key) => identity[key] === undefined || identity[key] === null
      || samePlanFile(String(identity[key]), plan.planFile))
    && equalsAll(["projectId"], plan.projectId)
    && equalsAll(["planRevision"], plan.revision)
    && equalsAll(["codeFingerprint"], plan.codeFingerprint)
    && equalsAll(["experimentIndex", "jobIndex"], job.index)
    && equalsAll(["case", "caseName"], job.case)
    && equalsAll(["seed"], job.seed)
    && (plan.resultPathPolicy === "declared" || equalsAll(["attempt"], job.attempt))
    && equalsAll(["outputDir"], job.outputDir)
    && equalsAll(["workerId"], job.workerId)
    && equalsAll(["runKey"], job.runKey || job.commandId)
    && (job.gpuId !== undefined ? equalsAll(["gpuId"], job.gpuId) : equalsAll(["gpuId"], ""));
}

export function historicalRecallIdentityMatchesJob(plan: QueuedPlan, job: QueuedJob, identity: Record<string, unknown>): boolean {
  const commandId = String(identity.targetCommandId || "");
  const workerId = String(identity.workerId || "");
  if (!job.commandId || commandId !== job.commandId || !job.workerId || workerId !== job.workerId) return false;
  const planId = String(identity.workflowId || identity.planId || "");
  const planFile = String(identity.planFile || identity.plan || "");
  if (!identityAliasesMatchJob(plan, job, identity)) return false;
  if (!planId && !planFile || !planId || !planFile) return false;
  const required = [identity.planRevision, identity.case ?? identity.caseName, identity.seed, identity.attempt, identity.outputDir];
  if (required.some((value) => value === undefined || value === null || value === "")) return false;
  if (String(identity.planRevision || "") !== String(plan.revision || "")
    || String(identity.case ?? identity.caseName) !== job.case
    || Number(identity.seed) !== job.seed || Number(identity.attempt) !== job.attempt
    || String(identity.outputDir) !== job.outputDir
    || identity.planJobCount !== undefined && Number(identity.planJobCount) !== Number(plan.planJobCount || plan.jobs.length)) return false;
  if (job.gpuId !== undefined && String(identity.gpuId ?? "") !== String(job.gpuId)) return false;
  if (job.gpuId === undefined && identity.gpuId !== undefined && identity.gpuId !== null && String(identity.gpuId) !== "") return false;
  return true;
}

export function historicalRecallTaskMatchesJob(plan: QueuedPlan, job: QueuedJob, task: Record<string, unknown>): boolean {
  const commandId = String(task.commandId || task.operationId || task.opId || "");
  const workerId = String(task.workerId || "");
  if (!job.commandId || commandId !== job.commandId || !job.workerId || workerId !== job.workerId) return false;
  const planId = String(task.workflowId || task.planId || "");
  const planFile = String(task.planFile || task.plan || "");
  if (planId && planId !== plan.id || planFile && !samePlanFile(planFile, plan.planFile)) return false;
  if (!planId && !planFile) return false;
  if (!identityAliasesMatchJob(plan, job, task)) return false;
  const checks: Array<[unknown, unknown]> = [
    [task.projectId, plan.projectId], [task.codeFingerprint, plan.codeFingerprint], [task.planRevision, plan.revision],
    [task.experimentIndex ?? task.jobIndex, job.index], [task.runKey, job.runKey || job.commandId],
    [task.case ?? task.caseName, job.case], [task.seed, job.seed], [task.attempt, job.attempt],
    [task.outputDir, job.outputDir], [task.gpuId, job.gpuId],
  ];
  return checks.every(([observed, expected]) => observed === undefined || observed === null
    || String(observed) === String(expected ?? ""));
}

function recognizedNeverStartedEvidence(value: unknown): boolean {
  return ["durable_queued_row", "worker_task_queued", "worker_task_pending", "worker_command_queued"].includes(String(value || ""));
}

export function nextAttemptOutputDir(outputDir: string, runId: string): string {
  const prefix = String(outputDir || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const parts = prefix.split("/");
  if (!prefix || prefix.startsWith("/") || /^[a-zA-Z]:/.test(prefix)
    || parts.some((part) => part === ".." || part === "." || !part || part.includes(":")))
    throw new Error("Job output directory is invalid.");
  if (parts.includes("attempts")) throw new Error("HISTORICAL_ATTEMPT_READ_ONLY: create a formal PLAN job instead.");
  return prefix;
}

export function sameDeferredPlanFile(left: string, right: string): boolean {
  return samePlanFile(left, right);
}

export function sameDistributedPlanFile(left: string, right: string): boolean {
  return samePlanFile(left, right);
}

export function matchingActiveDeferred(queue: DistributedQueue, identity: { id?: string; planFile: string; revision: string }) {
  // 29：接续只看 PLAN 身份与 revision；代码指纹只是同步时快照，不再是冻结条件。
  const rows = queue.deferred || [];
  const id = String(identity.id || "");
  if (id) {
    const row = rows.find((item) => item.id === id);
    if (!row) return null;
    const same = samePlanFile(row.planFile, identity.planFile)
      && row.revision === identity.revision
      && row.confirmedOutputChoice !== true
      && (row.status === "pending" || row.status === "blocked");
    return same ? row : null;
  }
  return rows.find((item) => samePlanFile(item.planFile, identity.planFile)
    && item.revision === identity.revision
    && item.confirmedOutputChoice !== true
    && (item.status === "pending" || item.status === "blocked"));
}

export function planFileIdentityKey(value: string): string {
  // POSIX spelling is an identity: case, whitespace and literal percent escapes matter.
  return process.platform === "darwin" ? value : value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function samePlanFile(left: string, right: string): boolean {
  const a = planFileIdentityKey(left);
  const b = planFileIdentityKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (process.platform === "darwin") return false;
  const absolute = (value: string) => /^(?:[a-z]:\/|\/)/i.test(value);
  return absolute(a) !== absolute(b) && (absolute(a) ? a.endsWith("/" + b) : b.endsWith("/" + a));
}

export type DistributedStopTarget = {
  kind: "job" | "deferred";
  planId: string;
  planFile: string;
  revision: string;
  codeFingerprint: string;
  jobIndex?: number;
  jobKey?: string;
  attempt?: number;
  commandId?: string;
  workerId?: string;
  gpuId?: string;
  caseName?: string;
  seed?: number;
  outputDir?: string;
  status: string;
  active: boolean;
};

const ACTIVE_JOB: readonly JobState[] = ["dispatching", "queued", "running", "unknown"];
const LOCAL_CLEAR_JOB: ReadonlySet<string> = new Set(["pending", "blocked"]);

/** A job can leave the queue without a Worker receipt only while it has never been assigned. */
export function jobClearableWithoutRemoteReceipt(job: { status?: string; workerId?: string; commandId?: string; gpuId?: string }): boolean {
  return LOCAL_CLEAR_JOB.has(String(job?.status || ""))
    && !String(job?.workerId || "").trim()
    && !String(job?.commandId || "").trim()
    && job?.gpuId === undefined;
}

export function distributedStopTargets(queue: DistributedQueue, planFile: string): DistributedStopTarget[] {
  const selected = process.platform === "darwin" ? String(planFile || "") : String(planFile || "").trim();
  if (!selected) return [];
  const jobs = (queue?.plans || []).filter((plan) => samePlanFile(plan.planFile, selected)).flatMap((plan) => plan.jobs.map((job) => ({
    kind: "job" as const,
    planId: plan.id,
    planFile: plan.planFile,
    revision: plan.revision,
    codeFingerprint: plan.codeFingerprint,
    jobIndex: job.index,
    jobKey: distributedJobControlKey(plan, job),
    ...(plan.resultPathPolicy !== "declared" ? { attempt: job.attempt } : {}),
    commandId: job.commandId,
    workerId: job.workerId,
    gpuId: job.gpuId,
    caseName: job.case,
    seed: job.seed,
    outputDir: job.outputDir,
    status: job.status,
    active: ACTIVE_JOB.includes(job.status),
  })));
  const deferred = (queue?.deferred || []).filter((row) => samePlanFile(row.planFile, selected)).map((row) => ({
    kind: "deferred" as const,
    planId: row.id,
    planFile: row.planFile,
    revision: row.revision,
    codeFingerprint: row.codeFingerprint,
    status: row.status,
    active: row.status === "processing",
  }));
  return [...jobs, ...deferred];
}

/** A frozen formal command identifies a control target, without a synthetic attempt version. */
export function distributedJobControlKey(plan: Pick<QueuedPlan, "id" | "revision" | "codeFingerprint" | "resultPathPolicy">,
  job: Pick<QueuedJob, "index" | "attempt" | "globalJobId" | "commandId" | "outputDir">): string {
  return plan.resultPathPolicy === "declared"
    ? JSON.stringify([plan.id, plan.revision, plan.codeFingerprint, job.globalJobId, job.index, job.commandId || "", job.outputDir])
    : `${plan.id}\0${job.index}\0${job.attempt}`;
}

/** Drop only confirmed plan runs. A partial stop keeps every unconfirmed job and deferred row. */
export function removeConfirmedDistributedPlan(queue: DistributedQueue, planFile: string, confirmed: {
  jobKeys: ReadonlySet<string>; deferredIds: ReadonlySet<string>; projectId?: string; historyOnlyJobKeys?: ReadonlySet<string>; localControlJobKeys?: ReadonlySet<string> }): DistributedQueue {
  const selected = process.platform === "darwin" ? String(planFile || "") : String(planFile || "").trim();
  const clearedJobs = [...(queue.clearedJobs || [])];
  const clearedKeys = new Set(clearedJobs.map(entry => clearedJobIdentityKey(entry)));
  const clearedAt = new Date().toISOString();
  const plans = (queue.plans || []).flatMap((plan) => {
    if (!samePlanFile(plan.planFile, selected)) return [plan];
    const jobs = plan.jobs.filter((job) => {
      if (!confirmed.jobKeys.has(distributedJobControlKey(plan, job))) return true;
      const records = [job, ...(job.history || []).filter(entry => ["completed", "failed", "cancelled"].includes(entry.status))];
      for (const record of records) {
        const formalRecord = plan.resultPathPolicy === "declared" && (record === job || !(Number(record.attempt) > 0));
        const entry: ClearedDistributedJob = { projectId: plan.projectId || job.projectId || confirmed.projectId || "",
          workflowId: plan.id, planFile: plan.planFile, planRevision: plan.revision, codeFingerprint: plan.codeFingerprint,
          experimentIndex: job.index, case: job.case, seed: job.seed,
          ...(formalRecord ? { resultPathPolicy: "declared" as const, globalJobId: job.globalJobId,
            collectionResultCsv: job.collectionResultCsv, status: record.status, actualExecutionMode: job.actualExecutionMode || plan.executionMode,
            checkpointSource: job.checkpointSource, mirroredWorkerIds: job.mirroredWorkerIds, fragmentWorkerIds: job.fragmentWorkerIds,
            cleanup: job.cleanup, outputRetiredAt: record.outputRetiredAt } : { attempt: record.attempt }),
          outputDir: record.outputDir,
          workerId: record.workerId || "", commandId: record.commandId || "",
          runKey: record === job ? job.runKey || job.commandId || "" : record.commandId || "", clearedAt,
          ...(record === job && job.workerId && job.commandId && confirmed.localControlJobKeys?.has(distributedJobControlKey(plan, job)) ? { stopBoundary: "local_command" as const } : {}),
          ...(confirmed.historyOnlyJobKeys?.has(distributedJobControlKey(plan, job))
            ? { clearMode: "terminal_history" as const, remoteClosureConfirmed: false as const } : {}) };
        const key = clearedJobIdentityKey(entry);
        if (!clearedKeys.has(key)) { clearedJobs.push(entry); clearedKeys.add(key); }
      }
      return false;
    });
    const clearedJobIndices = [...new Set([...(plan.clearedJobIndices || []), ...plan.jobs.filter(job =>
      confirmed.jobKeys.has(distributedJobControlKey(plan, job))).map(job => job.index)])];
    return jobs.length ? [{ ...plan, jobs, clearedJobIndices }] : [];
  });
  const deferred = (queue.deferred || []).filter((row) => !samePlanFile(row.planFile, selected) || !confirmed.deferredIds.has(row.id));
  return { ...queue, plans, deferred, clearedJobs };
}

export function workerStopJobIdentity(plan: QueuedPlan, job: QueuedJob): Record<string, unknown> {
  return {
    targetCommandId: job.commandId, runKey: job.runKey || job.commandId,
    workflowId: plan.id, planId: plan.id, projectId: plan.projectId,
    planRevision: plan.revision, codeFingerprint: plan.codeFingerprint,
    planJobCount: Number(plan.planJobCount || plan.jobs.length), planFile: plan.planFile,
    experimentIndex: job.index, case: job.case, seed: job.seed,
    ...(plan.resultPathPolicy === "declared" ? { resultPathPolicy: "declared", globalJobId: job.globalJobId,
      collectionResultCsv: job.collectionResultCsv } : { attempt: job.attempt }),
    outputDir: job.outputDir, workerId: job.workerId,
    ...(job.gpuId !== undefined ? { gpuId: String(job.gpuId) } : {}),
  };
}

function formalStopIdentityMatches(plan: QueuedPlan, job: QueuedJob, identity: Record<string, unknown>): boolean {
  return identity.resultPathPolicy === "declared"
    && Boolean(job.globalJobId && job.collectionResultCsv)
    && String(identity.globalJobId || "") === job.globalJobId
    && String(identity.collectionResultCsv || "") === job.collectionResultCsv
    && Number(identity.planJobCount) === Number(plan.planJobCount || plan.jobs.length);
}

export function stopIdentityMatchesJob(plan: QueuedPlan, job: QueuedJob, identity: Record<string, unknown>): boolean {
  const gpuMatches = job.gpuId === undefined || String(identity.gpuId ?? "") === String(job.gpuId);
  const formalMatches = plan.resultPathPolicy !== "declared" || formalStopIdentityMatches(plan, job, identity);
  return Boolean(job.commandId && job.workerId && gpuMatches && formalMatches
    && String(identity.commandId || identity.targetCommandId || "") === job.commandId
    && String(identity.workflowId || identity.planId || "") === plan.id
    && (!plan.projectId || String(identity.projectId || "") === plan.projectId)
    && (!plan.projectId || String(identity.codeFingerprint || "") === plan.codeFingerprint)
    && (!plan.projectId || Number(identity.experimentIndex) === job.index)
    && (!plan.projectId || String(identity.runKey || "") === String(job.runKey || job.commandId))
    && String(identity.planRevision || "") === plan.revision
    && String(identity.planFile || identity.plan || "") === plan.planFile
    && String(identity.case || identity.caseName || "") === job.case
    && Number(identity.seed) === job.seed
    && (plan.resultPathPolicy === "declared" || taskAttempt(identity) === job.attempt)
    && String(identity.outputDir || "") === job.outputDir
    && String(identity.workerId || "") === job.workerId);
}

export function retryVerifiedJob(queue: DistributedQueue, planId: string, jobIndex: number, runId: string): DistributedQueue {
  const plan = queue.plans.find((row) => row.id === planId);
  const job = plan?.jobs.find((row) => row.index === jobIndex);
  if (!job || job.unavailable || job.cleanup?.state === "partial" || job.cleanup?.pendingNodes.length || !["failed", "unknown"].includes(job.status) || !/^[a-zA-Z0-9-]{8,80}$/.test(runId))
    throw new Error("Only a verified stopped job can be retried.");
  const prefix = job.outputDir.replace(/\\/g, "/");
  if (plan?.resultPathPolicy !== "declared") throw new Error("HISTORICAL_ATTEMPT_READ_ONLY");
  const outputDir = nextAttemptOutputDir(prefix, "");
  return { ...queue, plans: queue.plans.map((row) => row.id !== planId ? row : { ...row,
    jobs: row.jobs.map((item) => item.index !== jobIndex ? item : {
      ...item, outputDir, attempt: 0, nextCommandId: runId, workerId: undefined, commandId: undefined, runKey: undefined, gpuId: undefined, manualDispatch: undefined,
      runtimeDiagnostics: undefined, completionState: undefined, exitCode: undefined,
      trustedTerminalStatus: undefined, admissionRejection: undefined, error: undefined, finishedAt: undefined,
      failureDiagnostic: undefined, formalConflictEvidence: undefined, blockReason: undefined, recoveryConflict: undefined,
      stopReason: undefined, automaticRetry: undefined, dispatchAcknowledgedAt: undefined, lastDispatchAttemptAt: undefined,
      cleanup: undefined,
      artifacts: undefined, artifactError: undefined, artifactRetryAfter: undefined, artifactStageBlock: undefined, latestArtifactSync: undefined, outputRetiredAt: undefined,
      historyLogIdentity: undefined, logPath: undefined,
      status: "pending" as const, history: [...(item.history || []), { attempt: item.attempt,
        status: item.status, workerId: item.workerId, commandId: item.commandId, outputDir: item.outputDir,
        finishedAt: item.finishedAt, stopReason: item.stopReason, error: item.error, admissionRejection: item.admissionRejection, cleanupOperationId: item.cleanup?.operationId }],
    }) }) };
}

export const AUTOMATIC_JOB_RETRY_MAX_FAILURES = 5;
export const AUTOMATIC_JOB_RETRY_BASE_DELAY_MS = 30_000;

/** A successful sibling cannot prove that a different code path or configuration is valid. */
export function classifyAutomaticJobFailure(error: unknown): { failureClass: JobFailureClass; blockedReason?: string } {
  const text = String(error || "");
  if (/\b(?:AttributeError|SyntaxError|IndentationError|TabError|ImportError|ModuleNotFoundError|NameError|UnboundLocalError|TypeError|ValueError|KeyError|IndexError|AssertionError|NotImplementedError|FileNotFoundError|PermissionError|ZeroDivisionError)\b/i.test(text)
    || /mat1 and mat2 shapes cannot be multiplied|size mismatch|sizes? of tensors? must match|shape .*invalid|expected scalar type|device-side assert|does not require grad|no grad_fn/i.test(text))
    return { failureClass: "deterministic", blockedReason: "代码、配置、依赖或输入错误，自动重试已停止；请检查日志，修复后手动重试。" };
  if (/out of memory|\bMemoryError\b|CUBLAS_STATUS_ALLOC_FAILED|CUDNN_STATUS_ALLOC_FAILED|CUDA_ERROR_OUT_OF_MEMORY|all CUDA-capable devices are busy or unavailable|resource temporarily unavailable/i.test(text))
    return { failureClass: "resource" };
  if (/CUBLAS_STATUS_NOT_INITIALIZED|CUDNN_STATUS_NOT_INITIALIZED|CUDA[^\n]*(?:initialization error|driver shutting down)|CUDA_ERROR_(?:NOT_READY|SYSTEM_NOT_READY)|NCCL[^\n]*(?:connection closed|connection reset|remote error)|\b(?:ConnectionResetError|ConnectionAbortedError|BrokenPipeError)\b|temporary failure in name resolution/i.test(text))
    return { failureClass: "transient" };
  return { failureClass: "unknown", blockedReason: "无法确认是偶发错误，自动重试已停止；请查看日志后手动处理。" };
}

/** A stopped or unverified process must never be launched again by this policy. */
export function scheduleAutomaticJobRetries(queue: DistributedQueue, snapshots: readonly DurableWorkerSnapshot[],
  projectId: string, options: { now?: number; selectedPlanFile?: string; excludedPlanFiles?: readonly string[];
    makeAttemptId: () => string }): DistributedQueue {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) return queue;
  const at = new Date(now).toISOString();
  const next = { ...queue, plans: [...queue.plans] };
  let changed = false;
  const latest = new Map<string, QueuedPlan>();
  for (const plan of next.plans) {
    if (plan.projectId !== projectId || !Number.isFinite(Date.parse(plan.enqueuedAt))) continue;
    const key = planFileIdentityKey(plan.planFile);
    const prior = latest.get(key);
    if (!prior || Date.parse(plan.enqueuedAt) >= Date.parse(prior.enqueuedAt)) latest.set(key, plan);
  }
  const freshTasks = new Map<string, Record<string, unknown>[]>();
  for (const snapshot of snapshots) {
    if (!hasFreshDurableSnapshot(snapshot, now)) continue;
    for (const task of snapshot.tasks || []) {
      const key = `${snapshot.workerId}\0${task.commandId}`;
      freshTasks.set(key, [...(freshTasks.get(key) || []), task]);
    }
  }
  const proof = (plan: QueuedPlan, job: QueuedJob) => (freshTasks.get(`${job.workerId}\0${job.commandId}`) || [])
    .find(task => remoteTaskMatchesJob(plan, job, task) && !task.identityConflict && !task.manualStopType
      && !task.stopReason && !job.stopReason && !job.recallRequested && !job.recoveryConflict);
  for (const original of latest.values()) {
    if (original.jobs.some(job => job.lifecycleProtocol === 2)) continue;
    if (original.resultPathPolicy !== "declared") continue;
    if (hasUnresolvedPlanRecovery(original) || original.automaticRetry?.disabledAt
      || options.excludedPlanFiles?.some(file => samePlanFile(file, original.planFile))) continue;
    const plan = { ...original, automaticRetry: original.automaticRetry ? { ...original.automaticRetry } : undefined,
      jobs: original.jobs.map(job => ({ ...job })) };
    next.plans[next.plans.indexOf(original)] = plan;
    // Upgrade only live/current runs. Old abandoned history is not revived on reload.
    if (!plan.automaticRetry) {
      const active = plan.jobs.some(job => UNFINISHED_JOB.includes(job.status));
      if (!active && !samePlanFile(options.selectedPlanFile || "", plan.planFile)) continue;
      plan.automaticRetry = { enabledAt: at };
      changed = true;
    }
    const evidence = new Map(plan.jobs.map(job => [job.index, proof(plan, job)]));
    if (!plan.automaticRetry.healthyAt) {
      const completed = plan.jobs.some(job => job.status === "completed" && evidence.get(job.index)?.status === "completed"
        && (job.lifecycleProtocol !== 2 || job.completionState === "verified"));
      const running = plan.jobs.filter(job => job.status === "running" && evidence.get(job.index)?.status === "running"
        && !evidence.get(job.index)?.error).length;
      const total = Math.max(plan.jobs.length, Number(plan.fullPlanJobCount || plan.planJobCount || plan.jobs.length));
      if (completed || running > total / 2) {
        plan.automaticRetry.healthyAt = at;
        plan.automaticRetry.healthyReason = completed ? "completed" : "majority_running";
        changed = true;
      }
    }
    for (let index = 0; index < plan.jobs.length; index++) {
      const job = plan.jobs[index], task = evidence.get(job.index);
      if (job.unavailable) continue;
      if (job.status === "failed" && (plan.resultPathPolicy === "declared" || job.outputDir.split("/").includes("attempts"))) {
        const blockedReason = plan.resultPathPolicy === "declared"
          ? "FORMAL_JOB_CONFLICT: failed output must be reviewed or explicitly cleaned before rerunning the same formal job."
          : "HISTORICAL_ATTEMPT_READ_ONLY";
        if (job.automaticRetry?.blockedReason !== blockedReason) {
          job.automaticRetry = { failureCount: job.automaticRetry?.failureCount || 0, failedAttempt: job.attempt, blockedReason };
          changed = true;
        }
        continue;
      }
      if (job.status === "completed" && task?.status === "completed") {
        if (job.automaticRetry) { delete job.automaticRetry; changed = true; }
        continue;
      }
    }
  }
  return changed ? next : queue;
}

/** Explicit stop intent persists even if a remote cleanup fails partway through. */
export function disableAutomaticJobRetries(queue: DistributedQueue, planFile: string, at = new Date().toISOString()): DistributedQueue {
  return { ...queue, plans: queue.plans.map(plan => !samePlanFile(plan.planFile, planFile) ? plan : { ...plan,
    automaticRetry: { ...plan.automaticRetry, enabledAt: plan.automaticRetry?.enabledAt || at, disabledAt: at },
    jobs: plan.jobs.map(job => job.automaticRetry?.retryAt ? { ...job,
      automaticRetry: { ...job.automaticRetry, retryAt: undefined } } : job) }) };
}
