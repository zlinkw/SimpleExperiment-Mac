export type PlanCleanupTarget = {
  operationId: string;
  planFile: string;
  workerId: string;
  active: boolean;
  tmuxSession: string;
  tmuxTarget: string;
  nativeTask?: Record<string, any>;
};

/** Stop authority comes from the current window binding, not a former scheduler operation. */
export function nativePlanStopTargets(snapshot: any, workerId: string, planFile: string, projectId: string): PlanCleanupTarget[] {
  if (snapshot?.queryComplete !== true || snapshot?.error || snapshot?.capabilities?.taskLifecycle !== 2) return [];
  return (snapshot.tasks || []).flatMap((task: any) => {
    if (!samePlan(text(task.planFile), planFile) || !task.observation?.tmux) return [];
    const evidence = task.observation, pane = evidence.tmux;
    const safe = (value: any) => typeof value === "string" && value.length > 0 && !value.startsWith("/")
      && !/[:\\\x00-\x1f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
    if (task.lifecycleProtocol !== 2 || task.projectId !== projectId || task.workerId !== workerId || !text(task.commandId)
      || !text(task.workflowId) || evidence.commandId !== task.commandId || evidence.projectId !== projectId
      || evidence.workerId !== workerId || evidence.queryError || !/^%\d+$/.test(pane.paneId) || !/^@\d+$/.test(pane.windowId)
      || !safe(task.outputDir) || (task.collectionResultCsv && !safe(task.collectionResultCsv)))
      throw new Error(`Worker ${workerId} 的 ${planFile} 窗口绑定不完整，未关闭窗口；请刷新后核对具体窗口。`);
    return [{ operationId: task.commandId, planFile: task.planFile, workerId, active: !pane.dead,
      tmuxSession: "", tmuxTarget: pane.windowId, nativeTask: task }];
  });
}

const PLAN_RUN_TYPES = new Set(["run-plan", "reproduce-plan"]);
const PLAN_HISTORY_TYPES = new Set([...PLAN_RUN_TYPES, "validate-plan", "dry-run-plan"]);

function text(value: unknown): string {
  return String(value || "").trim();
}

function samePlan(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const absolute = (value: string) => /^(?:[a-z]:\/|\/)/i.test(value);
  return absolute(a) !== absolute(b) && (absolute(a) ? a.endsWith("/" + b) : b.endsWith("/" + a));
}

export function planCleanupTargets(operations: Record<string, any>, planFile: string, terminal: (row: any) => boolean): PlanCleanupTarget[] {
  const selected = text(planFile);
  return Object.values(operations || {}).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const type = text(row.type || row.action).toLowerCase();
    if (!PLAN_RUN_TYPES.has(type)) return [];
    const file = text(row.planFile || row.plan);
    if (selected && !samePlan(file, selected)) return [];
    const operationId = text(row.operationId || row.id);
    if (!operationId || !file) return [];
    const tmuxSession = text(row.tmuxSession || row.session || row.checkedTmuxSession);
    const tmuxTarget = text(row.tmuxTarget || row.tmuxWindow || row.window);
    return [{
      operationId,
      planFile: file,
      workerId: text(row.schedulerOwnerWorkerId || row.resultOwnerWorkerId || row.workerId),
      active: !terminal(row),
      tmuxSession,
      tmuxTarget: tmuxTarget.includes(":") ? tmuxTarget : (tmuxSession.includes(":") ? tmuxSession : ""),
    }];
  });
}

export type TerminalPlanHistorySelection = {
  operationIds: string[];
  jobs: Array<Record<string, any>>;
  deferredIds: string[];
  signature: string;
};

/** Local display/index removal only; this is never evidence of remote termination. */
export function terminalPlanHistorySelection(operations: Record<string, any>, distributed: Array<Record<string, any>>,
  planFile: string, terminal: (row: any) => boolean): TerminalPlanHistorySelection | undefined {
  const ended: Array<Record<string, any>> = [];
  for (const [key, row] of Object.entries(operations || {})) {
    if (!row || typeof row !== "object") continue;
    const payload = row.payload && typeof row.payload === "object" ? row.payload : row.latestEvent?.payload || {};
    const options = payload.options || row.options || {};
    const type = text(row.type || row.action || payload.action || payload.type).toLowerCase();
    const file = text(row.planFile || row.plan || payload.planFile || payload.plan || options.planFile || options.plan);
    if (!PLAN_HISTORY_TYPES.has(type) || !samePlan(file, planFile)) continue;
    if (!terminal(row) || row.reconcileEvidenceActive === true || payload.reconcileEvidenceActive === true) return undefined;
    ended.push({ id: text(row.operationId || row.id || row.opId || payload.operationId || payload.opId || key),
      type, file, status: text(row.status || row.state || payload.status),
      revision: text(row.planRevision || payload.planRevision || options.planRevision),
      workerId: text(row.schedulerOwnerWorkerId || row.workerId || payload.workerId),
      projectId: text(row.projectId || payload.projectId), commandId: text(row.commandId || payload.commandId),
      codeFingerprint: text(row.codeFingerprint || payload.codeFingerprint) });
  }
  const jobs = [], deferredIds = [];
  let terminalJobs = 0;
  for (const row of distributed || []) {
    if (row.active) return undefined;
    if (row.kind === "deferred") {
      if (!["pending", "blocked", "superseded"].includes(text(row.status))) return undefined;
      deferredIds.push(text(row.planId));
    } else if (["completed", "failed", "cancelled"].includes(text(row.status))) {
      terminalJobs += 1;
      jobs.push({ ...row });
    } else if (["pending", "blocked"].includes(text(row.status)) && !row.workerId && !row.commandId && row.gpuId === undefined) {
      jobs.push({ ...row });
    } else return undefined;
  }
  if (!ended.length && !terminalJobs) return undefined;
  ended.sort((a, b) => a.id.localeCompare(b.id));
  jobs.sort((a, b) => text(a.jobKey).localeCompare(text(b.jobKey)));
  deferredIds.sort();
  return { operationIds: ended.map(row => row.id), jobs, deferredIds,
    signature: JSON.stringify([ended, jobs, deferredIds]) };
}

export type TrustedRemotePlanEvidence = {
  operationId: string;
  planFile: string;
  type: string;
  status: string;
  workerId: string;
  pid?: number;
  tmuxSession?: string;
  tmuxTarget?: string;
  logPath?: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  source: "worker-task";
};

export function planEvidenceMatchesFile(left: string, right: string): boolean {
  return samePlan(left, right);
}

function remoteTaskRows(snapshot: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(snapshot)) return snapshot.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>;
  if (!snapshot || typeof snapshot !== "object") return [];
  const record = snapshot as Record<string, unknown>;
  for (const key of ["tasks", "workerTasks", "worker_tasks", "rows"]) {
    if (Array.isArray(record[key])) return record[key].filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>;
  }
  return [];
}

function declaredWorkerIds(record: Record<string, unknown>): string[] {
  return [record.schedulerOwnerWorkerId, record.resultOwnerWorkerId, record.workerId].map(text).filter(Boolean);
}

export function remotePlanIdentityConflict(previous: unknown, incoming: { operationId: string; planFile: string; workerId: string }): "" | "operation" | "plan" | "worker" {
  if (!previous || typeof previous !== "object") return "";
  const record = previous as Record<string, unknown>;
  const previousId = text(record.operationId || record.id);
  if (previousId && previousId !== incoming.operationId) return "operation";
  const previousFile = text(record.planFile || record.plan);
  if (previousFile && !samePlan(previousFile, incoming.planFile)) return "plan";
  const workers = declaredWorkerIds(record);
  if (workers.some((id) => id.toLowerCase() !== text(incoming.workerId).toLowerCase())) return "worker";
  return "";
}

export function planRecoveryConflicts(existing: Record<string, any>, recovered: TrustedRemotePlanEvidence[]): Array<{ operationId: string; reason: "operation" | "plan" | "worker" }> {
  const conflicts: Array<{ operationId: string; reason: "operation" | "plan" | "worker" }> = [];
  const seen = new Map<string, TrustedRemotePlanEvidence>();
  for (const row of recovered || []) {
    const prior = seen.get(row.operationId);
    if (prior) {
      const reason = remotePlanIdentityConflict({
        operationId: prior.operationId,
        planFile: prior.planFile,
        schedulerOwnerWorkerId: prior.workerId,
      }, row);
      if (reason && reason !== "operation") conflicts.push({ operationId: row.operationId, reason });
    } else {
      seen.set(row.operationId, row);
    }
    const reason = remotePlanIdentityConflict(existing?.[row.operationId], row);
    if (reason) conflicts.push({ operationId: row.operationId, reason });
  }
  return conflicts;
}

export function trustedRemotePlanOperations(snapshot: unknown, workerId: string, planFile: string): TrustedRemotePlanEvidence[] {
  const owner = text(workerId);
  const selected = text(planFile);
  if (!owner || !selected) return [];
  const out: TrustedRemotePlanEvidence[] = [];
  for (const task of remoteTaskRows(snapshot)) {
    if (text(task.kind).toLowerCase() !== "scheduler") continue;
    const type = text(task.action || task.type).toLowerCase();
    if (!PLAN_RUN_TYPES.has(type)) continue;
    const operationId = text(task.operationId || task.opId);
    const file = text(task.planFile || task.plan);
    const declared = [text(task.workerId), text(task.schedulerOwnerWorkerId)].filter(Boolean);
    if (!operationId || !file || !samePlan(file, selected) || !declared.length || declared.some((id) => id.toLowerCase() !== owner.toLowerCase())) continue;
    const rawStatus = text(task.status || "running").toLowerCase() || "running";
    const status = rawStatus === "stopped" ? "cancelled" : rawStatus;
    const tmuxSession = text(task.tmuxSession || task.session);
    const tmuxTarget = text(task.tmuxTarget || task.tmuxWindow || task.window);
    const pid = Number(task.pid || 0);
    out.push({
      operationId,
      planFile: file,
      type,
      status,
      workerId: owner,
      ...(Number.isFinite(pid) && pid > 0 ? { pid } : {}),
      ...(tmuxSession ? { tmuxSession } : {}),
      ...(tmuxTarget.includes(":") ? { tmuxTarget } : {}),
      ...(text(task.logPath) ? { logPath: text(task.logPath) } : {}),
      ...(text(task.startedAt) ? { startedAt: text(task.startedAt) } : {}),
      ...(text(task.updatedAt || task.finishedAt || task.startedAt) ? { updatedAt: text(task.updatedAt || task.finishedAt || task.startedAt) } : {}),
      ...(text(task.finishedAt) ? { finishedAt: text(task.finishedAt) } : {}),
      source: "worker-task",
    });
  }
  return out;
}

export function mergeTrustedPlanOperations(operations: Record<string, any>, recovered: TrustedRemotePlanEvidence[]): Record<string, any> {
  if (planRecoveryConflicts(operations, recovered).length) return { ...(operations || {}) };
  const merged = { ...(operations || {}) };
  for (const row of recovered) {
    const previous = merged[row.operationId];
    if (previous && typeof previous === "object") {
      if (remotePlanIdentityConflict(previous, row)) continue;
      const previousFile = text(previous.planFile || previous.plan);
      merged[row.operationId] = {
        ...previous,
        ...row,
        operationId: row.operationId,
        planFile: previousFile || row.planFile,
        type: text(previous.type || previous.action) || row.type,
        schedulerOwnerWorkerId: text(previous.schedulerOwnerWorkerId) || row.workerId,
        resultOwnerWorkerId: text(previous.resultOwnerWorkerId) || row.workerId,
        workerId: text(previous.workerId) || row.workerId,
      };
      continue;
    }
    merged[row.operationId] = {
      operationId: row.operationId,
      type: row.type,
      status: row.status,
      planFile: row.planFile,
      schedulerOwnerWorkerId: row.workerId,
      resultOwnerWorkerId: row.workerId,
      workerId: row.workerId,
      ...(row.pid ? { pid: row.pid } : {}),
      ...(row.tmuxSession ? { tmuxSession: row.tmuxSession } : {}),
      ...(row.tmuxTarget ? { tmuxTarget: row.tmuxTarget } : {}),
      ...(row.logPath ? { logPath: row.logPath } : {}),
      ...(row.startedAt ? { startedAt: row.startedAt } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
      restoredFrom: row.source,
    };
  }
  return merged;
}

export function planStopIdentityConflictMessage(planFile: string, conflicts: Array<{ operationId: string; reason: string }>): string {
  const label = text(planFile) || "所选 Plan";
  const lines = (conflicts || []).map((item) => `${item.operationId}：${item.reason === "worker" ? "Worker 归属不一致" : item.reason === "plan" ? "Plan 路径不一致" : "operationId 不一致"}`);
  return [
    `不能中止 ${label}：同一 operationId 的本机进度与远端 scheduler 身份冲突。`,
    ...lines,
    "未发送停止命令，也未用冲突的远端状态覆盖本机进度。",
  ].join("\n");
}

export function planStopMissingEvidenceMessage(planFile: string, detail: { realtime: boolean; workersChecked: number; failures: string[] }): string {
  const label = text(planFile) || "所选 Plan";
  const reasons = [
    `没有找到 ${label} 的本机运行进度条目。`,
    detail.realtime
      ? `已查询 ${detail.workersChecked} 个已启用 Worker，但尚未完整核实当前任务窗口。`
      : "当前不是实时连接，不能读取远端 Worker 任务，因此不能凭 Plan 路径中止。",
    "未发送停止命令。确认对应 Worker 隧道在线后点「刷新状态」，再重试中止并清理；不需要恢复旧操作记录。",
  ];
  if (detail.failures.length) reasons.splice(2, 0, `查询失败：${detail.failures.join("；")}`);
  return reasons.join("\n");
}

export type DistributedCleanupLine = {
  planId: string;
  planFile: string;
  label: string;
  active: boolean;
  workerId?: string;
};

const QUEUE_ONLY_CLEAR_STATUSES = new Set(["pending", "blocked", "deferred"]);

/** Queue rows that have never been dispatched can be cleared without a Worker snapshot. */
export function distributedQueueOnlyClearable(distributed: Array<{ kind?: string; status?: string; active?: boolean; workerId?: string; commandId?: string; gpuId?: string }>): boolean {
  if (!distributed.length) return false;
  return distributed.every((row) => {
    if (row.active) return false;
    if (row.kind === "deferred") return ["pending", "blocked", "processing"].includes(String(row.status || ""));
    if (row.workerId || row.commandId || row.gpuId !== undefined) return false;
    return QUEUE_ONLY_CLEAR_STATUSES.has(String(row.status || ""));
  });
}

export type PlanStopClearOutcome = "completed" | "partial" | "failed" | "cancelled";

export type PlanStopClearFeedback = {
  planFile: string;
  phase: string;
  outcome: PlanStopClearOutcome | "running";
  message: string;
  nextStep: string;
  updatedAt: string;
  clearedOperations?: number;
  clearedJobs?: number;
  clearedDeferred?: number;
  stopped?: number;
  closedTmux?: number;
  retained?: number;
  failures?: string[];
};

export function planStopClearFeedback(input: {
  planFile: string;
  phase: string;
  outcome: PlanStopClearFeedback["outcome"];
  message: string;
  nextStep: string;
  clearedOperations?: number;
  clearedJobs?: number;
  clearedDeferred?: number;
  stopped?: number;
  closedTmux?: number;
  retained?: number;
  failures?: string[];
  now?: string;
}): PlanStopClearFeedback {
  const failures = (input.failures || []).map((item) => text(item)).filter(Boolean).slice(0, 8);
  return {
    planFile: text(input.planFile),
    phase: text(input.phase) || "stop-clear",
    outcome: input.outcome,
    message: text(input.message),
    nextStep: text(input.nextStep),
    updatedAt: input.now || new Date().toISOString(),
    clearedOperations: input.clearedOperations,
    clearedJobs: input.clearedJobs,
    clearedDeferred: input.clearedDeferred,
    stopped: input.stopped,
    closedTmux: input.closedTmux,
    retained: input.retained,
    ...(failures.length ? { failures } : {}),
  };
}

export function planStopClearUiResult(feedback: PlanStopClearFeedback): { status: "completed" | "failed" | "cancelled"; message: string; planStopClear: PlanStopClearFeedback } {
  const status = feedback.outcome === "completed" ? "completed" : feedback.outcome === "cancelled" ? "cancelled" : "failed";
  const headline = status === "completed" ? "已清除" : status === "cancelled" ? "已取消" : "未完成清除";
  return {
    status,
    message: [`${headline} ${feedback.planFile}`, `阶段：${feedback.phase}`, feedback.message, feedback.nextStep ? `下一步：${feedback.nextStep}` : ""].filter(Boolean).join("\n"),
    planStopClear: feedback,
  };
}

export function planStopClearPreview(planFile: string, targets: PlanCleanupTarget[], distributed: DistributedCleanupLine[] = []): string {
  const label = text(planFile) || "所选 Plan";
  const lines = targets.map((target) => `${target.planFile} · ${target.operationId}${target.active ? " · 仍在运行，将先中止" : " · 已结束"}${target.tmuxTarget ? " · tmux " + target.workerId + ":" + target.tmuxTarget : (target.tmuxSession ? " · tmux 窗口未定位：" + target.tmuxSession : "")}`);
  const queueLines = distributed.map((row) => `${row.planFile} · ${row.planId} · ${row.label}${row.active ? " · 将先按 job 身份停止，并只关闭该 job 的 tmux 标签" : " · 将取消排队"}`);
  return [
    `一键中止并清除 ${label}`,
    `将处理 ${targets.length} 条运行进度、${distributed.length} 条分布式调度：仍在运行的先向对应 Worker 发送停止，再从本机进度和队列清除已确认条目。`,
    "远端审计、日志和训练产物保留。关闭对应 tmux 标签前会再次确认完整目标。未确认停止的 job、deferred 和进度保持可见。",
    ...lines,
    ...queueLines,
  ].filter(Boolean).join("\n");
}
