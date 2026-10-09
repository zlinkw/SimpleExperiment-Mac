export const LONG_RUNNING_PLAN_ACTIONS = new Set(["run-plan", "reproduce-plan"]);
export const RUN_OPERATION_RECONCILE_GRACE_MS = 90_000;
export const RUN_OPERATION_NO_LOG_GROWTH_STALE_MS = 180_000;
export const RUN_OPERATION_CLOCK_SKEW_SECONDS = 300;

export interface RunOperationRecord {
  operationId?: unknown;
  type?: unknown;
  status?: unknown;
  state?: unknown;
  startedAt?: unknown;
  updatedAt?: unknown;
  reconciledAt?: unknown;
  reconcileCheckedAt?: unknown;
}

export interface RemoteRunEvidence {
  operation?: {
    status?: unknown;
    state?: unknown;
    message?: unknown;
    startedAt?: unknown;
    updatedAt?: unknown;
  };
  pidAlive?: unknown;
  tmuxSessionAlive?: unknown;
  tmuxPythonRunning?: unknown;
  checkedPid?: unknown;
  checkedTmuxSession?: unknown;
  schedulerStatesCount?: unknown;
  experimentTracesCount?: unknown;
  workerTasksCount?: unknown;
  liveLogCount?: unknown;
  liveLogTail?: unknown;
  logTail?: unknown;
}

// Hard error markers that, once present in a dead scheduler's log tail, should
// immediately move the operation to a terminal failed state instead of waiting
// out the reconciliation grace period.
export const RUN_OPERATION_ERROR_LOG_PATTERNS: RegExp[] = [
  /Traceback \(most recent call last\)/i,
  /调度器异常/i,
  /psutil\.AccessDenied/i,
  /No such file/i,
  /ModuleNotFoundError/i,
  /CondaValueError/i,
  /EnvironmentNotFound/i,
  /SyntaxError/i,
  /subprocess\.CalledProcessError/i,
  /returned non-zero exit status/i,
  /\bError\s*:/i,
  /\bException\s*:/i,
];

export function runOperationLogShowsError(evidence: RemoteRunEvidence): boolean {
  const raw = String((evidence as any).liveLogTail || (evidence as any).logTail || "");
  if (!raw) return false;
  // 过滤调度等待期探测日志：dispatch_probe / idle=0 / wait pending / rejected 行不应判为错误
  const filtered = raw
    .split(/\r?\n/)
    .filter((line) => {
      if (/dispatch_probe/i.test(line)) return false;
      if (/idle\s*=\s*0/i.test(line)) return false;
      if (/wait pending/i.test(line)) return false;
      if (/rejected/i.test(line)) return false;
      if (/error\s*=/i.test(line) && /dispatch_probe/i.test(raw)) return false;
      return true;
    })
    .join("\n");
  const tail = filtered.trim() ? filtered : "";
  if (!tail) return false;
  // 进一步白名单：若过滤后仅剩探测文本则不判错
  if (/dispatch_probe/i.test(tail) && !RUN_OPERATION_ERROR_LOG_PATTERNS.some((re) => re.test(tail.replace(/dispatch_probe[^\n]*/gi, "")))) {
    const cleaned = tail.replace(/dispatch_probe[^\n]*/gi, "").trim();
    if (!cleaned) return false;
    return RUN_OPERATION_ERROR_LOG_PATTERNS.some((re) => re.test(cleaned));
  }
  return RUN_OPERATION_ERROR_LOG_PATTERNS.some((re) => re.test(tail));
}

export function isLongRunningPlanOperation(record: RunOperationRecord): boolean {
  // 定案：stale 已取消终态且永不新产生；历史已落盘 stale 视为非长任务（兼容读，不复活为 running）。
  const statusText = String(record?.status || record?.state || "").trim().toLowerCase();
  if (statusText === "stale") return false;
  return LONG_RUNNING_PLAN_ACTIONS.has(String(record?.type || "").toLowerCase())
    && !operationTerminalStatus(record?.status || record?.state);
}

export function operationTerminalStatus(value: unknown): boolean {
  // 定案：去掉 stale（兼容读：历史 stale 由调用方自行判断，永不新产生；STALE 阈值仅作提示见 RUN_OPERATION_NO_LOG_GROWTH_STALE_MS）。
  return new Set([
    "completed", "operation_completed", "completed_with_errors", "failed", "operation_failed",
    "cancelled", "canceled", "stalled", "unsupported", "error",
  ]).has(String(value || "").trim().toLowerCase());
}

export function restorePlanOperationsFromWorkerTasks(
  existing: Record<string, any>,
  snapshot: unknown,
  workerId: string,
): Record<string, any> {
  const result = { ...existing };
  const tasks = snapshot && typeof snapshot === "object" && Array.isArray((snapshot as any).tasks)
    ? (snapshot as any).tasks as Array<Record<string, unknown>> : [];
  for (const task of tasks) {
    if (!task || typeof task !== "object" || String(task.kind || "") !== "scheduler") continue;
    const type = String(task.action || "").toLowerCase();
    if (!LONG_RUNNING_PLAN_ACTIONS.has(type)) continue;
    const operationId = String(task.operationId || "").trim();
    const planFile = String(task.planFile || task.plan || "").trim();
    if (!operationId || !planFile) continue;
    const previous = result[operationId] || {};
    if (operationTerminalStatus(previous.status || previous.state)) continue;
    const rawStatus = String(task.status || "running").toLowerCase();
    const status = rawStatus === "running" && previous.status === "interrupted"
      ? "interrupted" : (rawStatus === "stopped" ? "cancelled" : rawStatus);
    const terminal = operationTerminalStatus(status);
    const changedAt = String((terminal ? task.finishedAt : undefined) || task.startedAt || "");
    result[operationId] = {
      ...previous,
      operationId,
      type,
      status,
      planFile,
      schedulerOwnerWorkerId: String(task.workerId || workerId),
      resultOwnerWorkerId: String(task.resultOwnerWorkerId || task.workerId || workerId),
      pid: Number(task.pid || previous.pid || 0),
      tmuxSession: String(task.tmuxSession || previous.tmuxSession || ""),
      logPath: String(task.logPath || previous.logPath || ""),
      startedAt: String(previous.startedAt || task.startedAt || ""),
      updatedAt: terminal ? changedAt : String(previous.updatedAt || changedAt),
      ...(terminal ? { finishedAt: String(task.finishedAt || changedAt) } : {}),
    };
  }
  return result;
}

export function mergeReconciledRunOperation(previous: Record<string, any>, incoming: Record<string, any>): Record<string, any> {
  const merged = { ...previous, ...incoming };
  if (String(previous?.status || "") !== "interrupted" || String(incoming?.status || incoming?.state || "") !== "running") return merged;
  return {
    ...merged,
    status: "interrupted",
    message: previous.message,
    updatedAt: previous.updatedAt,
    evidence: previous.evidence,
    lastReconciledAt: previous.lastReconciledAt,
  };
}

export function hasRemoteRunActivity(evidence: RemoteRunEvidence): boolean {
  // passive_interrupt_requeue / dispatch_probe(目前无空卡)+running>0 / wait+running>0 均为有效进展，即使 liveLogCount 被去噪也视为活动
  if (schedulerLogShowsBusyWaiting(evidence as any) || schedulerLogShowsPassiveRequeue(evidence as any)) return true;
  return Boolean(
    evidence.pidAlive || evidence.tmuxSessionAlive
    || Number(evidence.schedulerStatesCount) > 0
    || Number(evidence.experimentTracesCount) > 0
    || Number(evidence.workerTasksCount) > 0
    || Number(evidence.liveLogCount) > 0,
  );
}

function schedulerLogShowsPassiveRequeue(evidence: any): boolean {
  const tail = String((evidence as any)?.liveLogTail || (evidence as any)?.logTail || "");
  return /passive_interrupt_requeue/i.test(tail);
}

function schedulerLogShowsBusyWaiting(evidence: any): boolean {
  const tail = String((evidence as any)?.liveLogTail || (evidence as any)?.logTail || "");
  if (!tail) return false;
  // wait pending + running>0 正常忙等待
  const runningVals = [...tail.matchAll(/running=(\d+)/gi)].map(m => Number(m[1]));
  const lastRunning = runningVals.length ? runningVals[runningVals.length - 1] : 0;
  if (lastRunning > 0) {
    if (/wait\s+pending/i.test(tail)) return true;
    if (/dispatch_probe/i.test(tail) && /目前无空卡/.test(tail)) return true;
    if (/\bdispatch\b/i.test(tail) || /\bdone\b/i.test(tail)) return true;
  }
  return false;
}

// 判断是否“无日志增长且已超时”需提示用户自行判断：
// 操作启动超过 180s，且日志在 180s 内无新增长（liveLogUpdatedAt 过期/缺失视为不新鲜）。
// 定案：仅作提示阈值，不终结（调用方返回非终态 running + 手动中止/清理提示）；stale 永不新产生。
// 补充：调度期 dispatch_probe(目前无空卡)+running>0 或 passive_interrupt_requeue 属于正常忙等待，禁止提示。
function runOperationShouldStaleByStall(evidence: any, record: any, remote: any, nowMs: number): boolean {
  if (schedulerLogShowsPassiveRequeue(evidence) || schedulerLogShowsBusyWaiting(evidence)) return false;
  const startedTs = Date.parse(String(record.startedAt || remote.startedAt || "")) || 0;
  if (!startedTs) return false;
  if (nowMs - startedTs <= RUN_OPERATION_NO_LOG_GROWTH_STALE_MS) return false;
  const logUpdatedTs = Date.parse(String((evidence as any).liveLogUpdatedAt || "")) || 0;
  const logFresh = logUpdatedTs ? (nowMs - logUpdatedTs < RUN_OPERATION_NO_LOG_GROWTH_STALE_MS) : false;
  return !logFresh;
}

export function reconcileRunOperation(
  record: RunOperationRecord,
  evidence: RemoteRunEvidence,
  reason: string,
  nowMs = Date.now(),
) {
  const remote = evidence.operation || {};
  const remoteStatus = String(remote.status || remote.state || "").trim().toLowerCase();
  const checkedAt = new Date(nowMs).toISOString();
  const counts = {
    checkedWorkerId: "",
    checkedPid: Number(evidence.checkedPid ?? 0),
    checkedTmuxSession: String(evidence.checkedTmuxSession || ""),
    schedulerStatesCount: Number(evidence.schedulerStatesCount || 0),
    experimentTracesCount: Number(evidence.experimentTracesCount || 0),
    liveLogCount: Number(evidence.liveLogCount || 0),
  };
  const tmuxTarget = String(evidence.checkedTmuxSession || (record as any).tmuxSession || "").trim();
  const pidAlive = Boolean(evidence.pidAlive) && !(tmuxTarget && evidence.tmuxPythonRunning === false);
  // Snapshot rows and experiment traces remain after the process exits. They
  // describe history and cannot prove a scheduler is still reserving a Worker.
  const base = { ...record, ...counts, reconcileEvidenceActive: Boolean(pidAlive || evidence.tmuxSessionAlive), lastReconciledAt: checkedAt };
  if (operationTerminalStatus(remoteStatus)) {
    return {
      terminal: true,
      patch: {
        ...base,
        status: remoteStatus,
        message: String(remote.message || "远端操作已终态。"),
        finishedAt: checkedAt,
        reconciledAt: checkedAt,
        reconcileReason: `${reason}:remote_terminal`,
        startedAt: record.startedAt || remote.startedAt || "",
        updatedAt: record.updatedAt || remote.updatedAt || checkedAt,
      },
    };
  }
  const tmuxAlive = Boolean(evidence.tmuxSessionAlive);
  // 关键修复：dispatch_probe(目前无空卡)+running>0 为 GPU 忙正常等待，passive_interrupt_requeue 为主动重入队，均视为有效活动，禁止 90s 误判为假存活
  const busyWaitingActive = schedulerLogShowsBusyWaiting(evidence as any) || schedulerLogShowsPassiveRequeue(evidence as any);
  const hasActivity = Boolean(
    busyWaitingActive
    || Number(evidence.schedulerStatesCount || 0) > 0
    || Number(evidence.experimentTracesCount || 0) > 0
    || Number(evidence.workerTasksCount || 0) > 0
    || Number(evidence.liveLogCount || 0) > 0,
  );
  // 定案：取消 stale 终态。pid 存活但日志 180s 无增长仅提示，不终结；保持 running，由用户自行判断、手动中止/清理。
  // STALE 阈值（RUN_OPERATION_NO_LOG_GROWTH_STALE_MS）仅作提示阈值。
  if (pidAlive) {
    if (runOperationShouldStaleByStall(evidence, record, remote, nowMs)) {
      return {
        terminal: false,
        patch: {
          ...base,
          status: remoteStatus || "running",
          message: "调度进程 pid 存活但日志超过 180s 无新增长，疑似挂死；未自动终结，请用户自行判断，必要时手动中止/清理。",
          reconciledAt: checkedAt,
          reconcileReason: `${reason}:pid_alive_stalled`,
          startedAt: record.startedAt || remote.startedAt || "",
          updatedAt: record.updatedAt || remote.updatedAt || checkedAt,
          reconcileNoActivitySince: 0,
          reconcileCheckedAt: checkedAt,
        },
      };
    }
    return { terminal: false, patch: { ...base, status: remoteStatus || "running", reconcileNoActivitySince: 0 } };
  }
  // tmux session alive but the only thing present is the scheduler shell, and it has
  // produced no real activity (no scheduler states, no experiment traces, no live log).
  // This is the "tmux 假存活" scenario: the command was dropped by a startup race and
  // the shell is just sitting at a prompt. Promote to stale once the no-activity window
  // exceeds the reconciliation grace, so the panel never hangs on "waiting for scheduler".
  if (tmuxAlive && !hasActivity) {
    // 额外 guard：若 liveLogTail 虽被去噪计数为 0，但含 busyWaiting/passiveRequeue 文本，仍视为有活动，不进入 stale 分支
    // 仅当 running==0 且无 dispatch/done/passive_interrupt 等有效进展且超时才判失败
    if (busyWaitingActive) {
      return {
        terminal: false,
        patch: { ...base, status: remoteStatus || "running", reconcileNoActivitySince: 0, reconcileCheckedAt: checkedAt },
      };
    }
    const noActivitySince = Number((record as any).reconcileNoActivitySince) || nowMs;
    if (nowMs - noActivitySince > RUN_OPERATION_RECONCILE_GRACE_MS) {
      // 定案：取消 stale 终态；tmux 存活无活动仅提示，不终结，由用户自行判断、手动中止/清理。
      return {
        terminal: false,
        patch: {
          ...base,
          status: remoteStatus || "running",
          message: "tmux 会话存活但调度器长时间无任何活动证据，疑似启动失败（命令可能被启动竞态丢弃）；未自动终结，请用户自行判断，必要时手动中止/清理。",
          reconciledAt: checkedAt,
          reconcileReason: `${reason}:tmux_alive_no_activity`,
          startedAt: record.startedAt || remote.startedAt || "",
          updatedAt: record.updatedAt || remote.updatedAt || checkedAt,
          reconcileNoActivitySince: noActivitySince,
          reconcileCheckedAt: checkedAt,
        },
      };
    }
    return {
      terminal: false,
      patch: {
        ...base,
        status: remoteStatus || "running",
        reconcileNoActivitySince: noActivitySince,
        reconcileCheckedAt: checkedAt,
        reconcileGraceExpiresAt: new Date(nowMs + RUN_OPERATION_RECONCILE_GRACE_MS).toISOString(),
      },
    };
  }
  if (tmuxAlive && hasActivity) {
    // 定案：取消 stale 终态；有历史活动但 180s 日志无增长仅提示，不终结，由用户自行判断、手动中止/清理。
    if (runOperationShouldStaleByStall(evidence, record, remote, nowMs)) {
      return {
        terminal: false,
        patch: {
          ...base,
          status: remoteStatus || "running",
          message: "tmux 存活且有历史活动，但启动超过 180s 且日志无新增长，疑似挂死/假执行中；未自动终结，请用户自行判断，必要时手动中止/清理。",
          reconciledAt: checkedAt,
          reconcileReason: `${reason}:tmux_alive_stalled`,
          startedAt: record.startedAt || remote.startedAt || "",
          updatedAt: record.updatedAt || remote.updatedAt || checkedAt,
          reconcileNoActivitySince: 0,
          reconcileCheckedAt: checkedAt,
        },
      };
    }
    return { terminal: false, patch: { ...base, status: remoteStatus || "running", reconcileNoActivitySince: 0 } };
  }
  // Process is dead (no pid / no tmux session). If the log already shows a hard
  // error, promote to a terminal failed state immediately so the Operations panel
  // never stays stuck on "waiting for scheduler terminal".
  // 增加 90s grace：启动 90s 内即使日志含错误也不立即判失败，避免将调度等待期探测日志误判为程序错误
  const logTail = String((evidence as any).liveLogTail || (evidence as any).logTail || "");
  if (runOperationLogShowsError(evidence)) {
    const startedRaw = String(record.startedAt || remote.startedAt || record.updatedAt || "");
    const startedMs = Date.parse(startedRaw);
    const age = Number.isFinite(startedMs) ? nowMs - startedMs : RUN_OPERATION_RECONCILE_GRACE_MS + 1;
    if (age >= 0 && age < RUN_OPERATION_RECONCILE_GRACE_MS) {
      return {
        terminal: false,
        patch: {
          ...base,
          reconcileCheckedAt: checkedAt,
          reconcileGraceExpiresAt: new Date(startedMs + RUN_OPERATION_RECONCILE_GRACE_MS).toISOString(),
        },
      };
    }
    return {
      terminal: true,
      patch: {
        ...base,
        status: "failed",
        message: `远端调度进程已退出且日志含错误：\n${logTail.slice(-500)}`,
        finishedAt: checkedAt,
        reconciledAt: checkedAt,
        reconcileReason: `${reason}:dead_process_with_error_log`,
        startedAt: record.startedAt || remote.startedAt || "",
        updatedAt: record.updatedAt || remote.updatedAt || checkedAt,
      },
    };
  }
  const knownScheduler = Number(evidence.checkedPid || (record as any).pid || 0) > 0
    || Boolean(evidence.checkedTmuxSession || (record as any).tmuxSession);
  const startedMs = Date.parse(String(record.startedAt || remote.startedAt || ""));
  if (knownScheduler && Number.isFinite(startedMs) && nowMs - startedMs > RUN_OPERATION_RECONCILE_GRACE_MS) {
    const wasInterrupted = String(record.status || "").toLowerCase() === "interrupted";
    const interruptedAt = wasInterrupted
      ? String((record as any).interruptedAt || (record as any).reconciledAt || record.updatedAt || checkedAt)
      : checkedAt;
    return {
      terminal: false,
      patch: {
        ...base,
        status: "interrupted",
        message: "远端调度进程和 tmux 会话均不可见；调度已中断，已派发的 Worker 任务可能仍在运行。",
        interruptedAt,
        reconciledAt: interruptedAt,
        reconcileCheckedAt: checkedAt,
        reconcileReason: `${reason}:scheduler_missing`,
        updatedAt: wasInterrupted ? String(record.updatedAt || interruptedAt) : checkedAt,
      },
    };
  }
  const referenceRaw = String(record.reconcileCheckedAt || record.startedAt || "");
  const reference = Date.parse(referenceRaw);
  const age = Number.isFinite(reference) ? nowMs - reference : nowMs - (Date.parse(String(record.startedAt || "")) || 0);
  if (age > RUN_OPERATION_RECONCILE_GRACE_MS) {
    // 定案：取消 stale 终态；远端进程不可见且无活动仅提示，不终结，由用户自行判断、手动中止/清理（stale 永不新产生）。
    return {
      terminal: false,
      patch: {
        ...base,
        status: "running",
        message: "远端调度进程已退出（pid/tmux 均不可见）且无活动证据；未自动终结，请用户自行判断，必要时手动中止/清理。",
        reconciledAt: checkedAt,
        reconcileReason: `${reason}:no_remote_activity`,
        startedAt: record.startedAt || remote.startedAt || "",
        updatedAt: record.updatedAt || remote.updatedAt || checkedAt,
        reconcileCheckedAt: checkedAt,
      },
    };
  }
  return {
    terminal: false,
    patch: {
      ...base,
      reconcileCheckedAt: checkedAt,
      reconcileGraceExpiresAt: new Date(nowMs + RUN_OPERATION_RECONCILE_GRACE_MS).toISOString(),
    },
  };
}

export function runOperationMatchesTarget(record: Record<string, unknown>, target: Record<string, string>): boolean {
  const selectors: Array<[string, string]> = [
    ["planFile", String(operationPlanFile(record))],
    ["planId", String(record.planId || record.selectedPlanId || "")],
    ["operationId", String(record.operationId || record.opId || "")],
    ["runKey", String(record.runKey || record.operationId || record.opId || "")],
    ["remoteOperationId", String(record.remoteOperationId || record.operationId || "")],
    ["pid", String(record.pid || record.checkedPid || "")],
    ["tmuxSession", String(record.tmuxSession || record.session || record.checkedTmuxSession || "")],
  ];
  let matched = false;
  for (const [key, value] of selectors) {
    const wanted = String(target[key] || "").trim();
    if (!wanted) continue;
    matched = true;
    if ((key === "planFile" || key === "planId") ? !samePlanSelection(value, wanted) : value !== wanted) return false;
  }
  const status = String(record.status || record.state || "").trim().toLowerCase();
  return matched && (isLongRunningPlanOperation(record as RunOperationRecord) || status === "stale");
}

function operationPlanFile(record: Record<string, unknown>): string {
  return String(record.planFile || record.plan || record.options && (record.options as any).planFile || "");
}

function samePlanSelection(left: string, right: string): boolean {
  const normalize = (value: string) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  return Boolean(left && right && normalize(left) === normalize(right));
}
