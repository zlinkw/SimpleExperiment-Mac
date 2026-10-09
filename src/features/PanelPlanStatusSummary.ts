export type PlanSelectorStatus = "not-started" | "partial" | "running" | "completed" | "failed";

export interface PanelPlanStatusSummary {
  planFile: string;
  revision: string;
  status: PlanSelectorStatus;
  completedCount: number;
  totalCount: number;
  taskCount: number;
  failedCount: number;
  activeCount: number;
  queuedCount: number;
  updatedAt?: string;
}

export interface PanelPlanStatusSummaryInput {
  plans?: readonly unknown[];
  schedulerStates?: unknown;
  workerTasks?: unknown;
  topologyMode?: string;
  operations?: unknown;
  distributedPlans?: unknown;
  executionHistoryCutoffs?: Record<string, unknown>;
  executionHistoryHiddenOperationIds?: readonly unknown[];
}

const SCHEDULER_BUCKETS: Record<string, string> = {
  running_experiments: "running",
  testing_experiments: "testing",
  queued_experiments: "queued",
  pending_experiments: "queued",
  completed_experiments: "completed",
  failed_experiments: "failed",
  stopped_experiments: "stopped",
};
const TASK_COMPLETED = new Set(["completed", "done", "archived"]);
const TASK_FAILED = new Set(["stopped", "cancelled", "failed", "error", "stalled"]);
const TASK_ACTIVE = new Set(["running", "testing", "progress", "in_progress", "operation_started", "started"]);
const TASK_QUEUED = new Set(["accepted", "submitted", "queued", "pending"]);
const OPERATION_ACTIVE_TOKENS = ["accepted", "submitted", "pending", "queued", "running", "in_progress", "started", "progress"];
const OPERATION_FAILURE_TOKENS = ["failed", "failure", "stalled", "interrupted", "timeout", "unsupported", "error"];
const PLAN_RUN_OPERATION_TYPES = new Set(["run-plan", "reproduce-plan"]);

type PlanEntry = {
  file: string;
  plan: Record<string, any>;
  revision: string;
  updatedAt: number;
  tasks: Record<string, any>[];
  operations: Record<string, any>[];
  distributedPlans: Record<string, any>[];
};

export function summarizePlanStatuses(input: PanelPlanStatusSummaryInput = {}): PanelPlanStatusSummary[] {
  const plans = collectPlans(input.plans || []);
  if (!plans.length) return [];

  const byAlias = new Map<string, PlanEntry[]>();
  for (const entry of plans) {
    for (const alias of planFileEquivalenceKeys(entry.file)) {
      const matches = byAlias.get(alias) || [];
      matches.push(entry);
      byAlias.set(alias, matches);
    }
  }

  const candidatesFor = (file: string): PlanEntry[] => {
    const keys = planFileEquivalenceKeys(file);
    const found = new Set<PlanEntry>();
    for (const alias of keys) {
      for (const entry of byAlias.get(alias) || []) found.add(entry);
    }
    const exact = [...found].filter((entry) => normalizePlanFile(entry.file) === normalizePlanFile(file));
    if (exact.length) return exact;
    const qualified = keys.filter((key) => key.includes("/"));
    const matches = [...found].filter((entry) => qualified.length
      ? planFileEquivalenceKeys(entry.file).some((key) => qualified.includes(key))
      : samePlanSelection(file, entry.file));
    return matches.length === 1 ? matches : [];
  };

  const schedulerRows = schedulerRowsForInput(input);
  for (const row of schedulerRows) {
    const file = firstText(row.planFile, row.plan_file, row.planPath, row.plan_path, row.file, row.path, row.plan, row.planName, row.plan_name);
    for (const entry of candidatesFor(file)) {
      if (taskMatchesPlanVersion(row, entry)) entry.tasks.push(row);
    }
  }

  for (const operation of visibleOperationRows(input)) {
    const file = firstText(operation.planFile, operation.plan_file, operation.plan);
    for (const entry of candidatesFor(file)) {
      if (operationMatchesPlanVersion(operation, entry)) entry.operations.push(operation);
    }
  }

  for (const distributedPlan of array(input.distributedPlans)) {
    const file = firstText(distributedPlan.planFile, distributedPlan.plan_file);
    const versionedPlan = {
      ...distributedPlan,
      planRevision: firstText(distributedPlan.planRevision, distributedPlan.plan_revision, distributedPlan.revision),
    };
    for (const entry of candidatesFor(file)) {
      if (taskMatchesPlanVersion(versionedPlan, entry)) entry.distributedPlans.push(distributedPlan);
    }
  }

  return plans.map((entry) => summarizeEntry(entry));
}

function collectPlans(values: readonly unknown[]): PlanEntry[] {
  const entries = new Map<string, PlanEntry>();
  for (const raw of values) {
    const plan = record(raw);
    const file = firstText(plan.file, plan.planFile, plan.plan_file, plan.path, plan.planId, plan.plan_id);
    if (!file) continue;
    const key = normalizePlanFile(file);
    const existing = entries.get(key);
    if (existing) {
      existing.plan = mergePlanMetadata(existing.plan, plan);
      existing.revision = String(existing.plan.revision || "");
      existing.updatedAt = dateValue(existing.plan.updatedAt);
      continue;
    }
    entries.set(key, {
      file: normalizePlanFileForDisplay(file),
      plan: { ...plan },
      revision: String(plan.revision || ""),
      updatedAt: dateValue(plan.updatedAt),
      tasks: [],
      operations: [],
      distributedPlans: [],
    });
  }
  return [...entries.values()];
}

function mergePlanMetadata(primary: Record<string, any>, fallback: Record<string, any>): Record<string, any> {
  const merged = { ...fallback, ...primary };
  for (const key of ["revision", "updatedAt", "cases", "seeds", "caseCount", "case_count", "seedCount", "seed_count", "jobCount", "job_count"]) {
    const current = primary[key];
    if ((current === undefined || current === null || current === "" || Array.isArray(current) && current.length === 0)
      && fallback[key] !== undefined) merged[key] = fallback[key];
  }
  return merged;
}

function summarizeEntry(entry: PlanEntry): PanelPlanStatusSummary {
  const tasks = latestJobRows(entry.tasks, true);
  const distributedJobs = latestJobRows(entry.distributedPlans.flatMap((plan) => array(plan.jobs).map((job) => ({
    planFile: entry.file,
    planRevision: firstText(plan.planRevision, plan.plan_revision, plan.revision),
    ...record(job),
  }))), false);
  const countRows = distributedJobs.length ? distributedJobs : tasks;
  const taskCounts = countTaskStatuses(tasks);
  const distributedCounts = countTaskStatuses(distributedJobs);
  const displayedCounts = distributedJobs.length ? distributedCounts : taskCounts;
  const expectedCount = expectedPlanJobs(entry.plan);
  const totalCount = countRows.length ? Math.max(countRows.length, expectedCount) : expectedCount;
  // Completed job evidence supersedes the submission/progress records of that run.
  // A genuinely newer submission must still remain visible as active.
  const jobEvidenceAt = Math.max(0, ...entry.distributedPlans.map(row => dateValue(row.enqueuedAt) || 0),
    ...distributedJobs.map(row => dateValue(row.finishedAt || row.updatedAt || row.startedAt) || 0));
  const operations = entry.operations.filter(row => !distributedJobs.length || !jobEvidenceAt
    || (dateValue(row.startedAt || row.updatedAt) || 0) > jobEvidenceAt);
  const runOperations = operations.filter((row) => PLAN_RUN_OPERATION_TYPES.has(String(row.type || "").toLowerCase()));
  const pendingOperation = operations.some((row) => operationPending(row.status));
  const latestOperation = latestOperationRow(operations);
  const latestRun = latestOperationRow(runOperations);
  const failedOperation = operationFailureLike(latestOperation && (latestOperation.status || latestOperation.state));
  const latestRunStatus = latestRun && (latestRun.status || latestRun.state);
  const latestRunFailed = operationFailureLike(latestRunStatus);
  const allTasksCompleted = countRows.length > 0 && totalCount > 0 && displayedCounts.completedCount >= totalCount;

  let status: PlanSelectorStatus = "not-started";
  if (displayedCounts.failedCount || failedOperation || latestRunFailed) status = "failed";
  else if (displayedCounts.activeCount || pendingOperation || displayedCounts.queuedCount && !displayedCounts.completedCount) status = "running";
  else if (allTasksCompleted) status = "completed";
  else if (countRows.length || runOperations.length) status = "partial";

  const updatedAt = firstText(entry.plan.updatedAt);
  return {
    planFile: entry.file.slice(0, 512),
    revision: entry.revision.slice(0, 256),
    status,
    completedCount: boundedCount(displayedCounts.completedCount),
    totalCount: boundedCount(totalCount),
    taskCount: boundedCount(countRows.length),
    failedCount: boundedCount(displayedCounts.failedCount),
    activeCount: boundedCount(displayedCounts.activeCount),
    queuedCount: boundedCount(displayedCounts.queuedCount),
    ...(updatedAt ? { updatedAt: updatedAt.slice(0, 64) } : {}),
  };
}

function countTaskStatuses(rows: Record<string, any>[]): { completedCount: number; failedCount: number; activeCount: number; queuedCount: number } {
  const statuses = rows.map((row) => taskStatusToken(row.status));
  return {
    completedCount: statuses.filter((status) => TASK_COMPLETED.has(status)).length,
    failedCount: statuses.filter((status) => TASK_FAILED.has(status)).length,
    activeCount: statuses.filter((status) => TASK_ACTIVE.has(status)).length,
    queuedCount: statuses.filter((status) => TASK_QUEUED.has(status)).length,
  };
}

function expectedPlanJobs(plan: Record<string, any>): number {
  const caseCount = Array.isArray(plan.cases) ? plan.cases.length : number(plan.caseCount || plan.case_count);
  const seedCount = Array.isArray(plan.seeds) ? plan.seeds.length : number(plan.seedCount || plan.seed_count);
  const configuredJobs = number(plan.jobCount || plan.job_count);
  const expandedJobs = caseCount > 0 && seedCount > 0 ? caseCount * seedCount : 0;
  return boundedCount(Math.max(0, Math.trunc(expandedJobs || configuredJobs || 0)));
}

function latestJobRows(rows: Record<string, any>[], normalizeSchedulerRow: boolean): Record<string, any>[] {
  const latestByIndex = new Map<number, { row: Record<string, any>; order: number; attempt: number; time: number }>();
  const withoutIndex: Record<string, any>[] = [];
  rows.forEach((row, order) => {
    const rawIndex = normalizeSchedulerRow
      ? firstDefined(row.experimentIndex, row.experiment_index, row.index, row.jobIndex, row.job_index)
      : firstDefined(row.experimentIndex, row.jobIndex, row.index);
    const index = Number(rawIndex);
    if (rawIndex === undefined || rawIndex === null || String(rawIndex).trim() === "" || !Number.isInteger(index) || index < 0) {
      withoutIndex.push(row);
      return;
    }
    const attemptRaw = normalizeSchedulerRow
      ? firstDefined(row.attempt, row.attemptIndex, row.attempt_index, "")
      : firstDefined(row.attempt, "");
    const attempt = Number(attemptRaw);
    const time = dateValue(row.updatedAt || row.updated_at || row.startedAt || row.started_at);
    const candidate = { row, order, attempt: Number.isFinite(attempt) ? attempt : -1, time: Number.isFinite(time) ? time : -1 };
    const previous = latestByIndex.get(index);
    if (!previous || candidate.attempt > previous.attempt
      || candidate.attempt === previous.attempt && (candidate.time > previous.time || candidate.time === previous.time && order > previous.order)) {
      latestByIndex.set(index, candidate);
    }
  });
  return [...latestByIndex.values()].sort((left, right) => left.order - right.order).map((item) => item.row).concat(withoutIndex);
}

function schedulerRowsForInput(input: PanelPlanStatusSummaryInput): Record<string, any>[] {
  let source = array(input.schedulerStates);
  if (!source.length && input.topologyMode === "single_worker") source = array(input.workerTasks);
  const expanded = source.flatMap((row) => expandSchedulerRow(record(row)));
  return expanded.map((row) => normalizeTaskRow(row)).filter((row) => row.status !== "deleted");
}

function expandSchedulerRow(row: Record<string, any>): Record<string, any>[] {
  const parentPlanFile = firstText(row.planFile, row.plan_file, row.planPath, row.plan_path, row.file, row.path, row.plan);
  const parentPlanRevision = firstText(row.planRevision, row.plan_revision);
  const buckets = Object.keys(SCHEDULER_BUCKETS).filter((key) => Array.isArray(row[key]));
  if (!buckets.length) return [row];
  const children = buckets.flatMap((bucket) => array(row[bucket]).map((child) => {
    const item = record(child);
    return {
      ...item,
      status: picked(item, ["status", "state"], SCHEDULER_BUCKETS[bucket]),
      plan: picked(row, ["plan", "planName", "suite", "file"], ""),
      planFile: picked(item, ["planFile", "plan_file", "file", "path"], parentPlanFile),
      planRevision: picked(item, ["planRevision", "plan_revision"], parentPlanRevision),
    };
  }));
  return children.length ? children : [row];
}

function normalizeTaskRow(row: Record<string, any>): Record<string, any> {
  const status = taskStatusToken(picked(row, ["status", "state", "runStatus", "run_status"], "unknown"));
  return {
    ...row,
    status,
    planFile: picked(row, ["planFile", "plan_file", "planPath", "plan_path", "file", "path"], picked(row, ["plan", "planName", "plan_name"], "")),
    planRevision: picked(row, ["planRevision", "plan_revision"], ""),
    experimentIndex: picked(row, ["experimentIndex", "experiment_index", "index", "jobIndex", "job_index"], "-"),
    attempt: picked(row, ["attempt", "attemptIndex", "attempt_index"], ""),
    startedAt: picked(row, ["startedAt", "started_at"], "") || "-",
    updatedAt: picked(row, ["updatedAt", "updated_at", "finishedAt", "finished_at"], "") || "-",
  };
}

function visibleOperationRows(input: PanelPlanStatusSummaryInput): Record<string, any>[] {
  const hidden = new Set(array(input.executionHistoryHiddenOperationIds).map(String));
  const cutoffs = record(input.executionHistoryCutoffs);
  return objectRows(input.operations).map((row, order) => normalizeOperationRow(row, order)).sort((left, right) =>
    Number(operationIsActive(right.status)) - Number(operationIsActive(left.status))
      || String(right.updatedAt).localeCompare(String(left.updatedAt))
      || Number(right.seq || 0) - Number(left.seq || 0))
    .filter((row) => {
      const active = operationIsActive(row.status) && row.reconcileEvidenceActive !== false;
      if (!active && hidden.has(String(row.operationId || row.id || ""))) return false;
      if (active) return true;
      const planKey = normalizePlanFile(row.planFile || row.plan).toLowerCase();
      const cutoff = Math.max(Date.parse(String(cutoffs.all || "")) || 0, Date.parse(String(cutoffs[planKey] || "")) || 0);
      if (!cutoff) return true;
      const startedAt = dateValue(row.updatedAt);
      return startedAt > cutoff;
    });
}

function normalizeOperationRow(row: Record<string, any>, order: number): Record<string, any> {
  const payload = operationPayload(row);
  const options = operationPayload(payload.options);
  const rowType = picked(row, ["type", "action"], "-");
  const type = rowType !== "-" ? rowType : picked(payload, ["action", "type"], "-");
  const status = picked(row, ["status", "state"], picked(payload, ["status", "state"], operationStatusFromType(type)));
  const updatedAt = picked(row, ["updatedAt", "updated_at", "completedAt", "completed_at", "finishedAt", "finished_at", "generatedAt", "startedAt"],
    picked(payload, ["updatedAt", "updated_at", "completedAt", "completed_at", "finishedAt", "finished_at", "generatedAt", "startedAt"], "-"));
  return {
    ...row,
    id: picked(row, ["operationId", "operation_id", "opId", "id"], picked(payload, ["operationId", "operation_id", "opId", "id"], "-")),
    operationId: picked(row, ["operationId", "operation_id", "opId", "id"], picked(payload, ["operationId", "operation_id", "opId", "id"], "-")),
    type,
    status,
    planFile: picked(row, ["planFile", "plan_file", "plan"], picked(payload, ["planFile", "plan_file", "plan"],
      picked(options, ["planFile", "plan_file", "plan", "selectedPlanId"], ""))),
    planRevision: picked(row, ["planRevision", "plan_revision"], picked(payload, ["planRevision", "plan_revision"], picked(options, ["planRevision", "plan_revision"], ""))),
    updatedAt,
    startedAt: picked(row, ["startedAt", "started_at"], picked(payload, ["startedAt", "started_at"], "")),
    createdAt: picked(row, ["createdAt", "created_at"], picked(payload, ["createdAt", "created_at"], "")),
    finishedAt: picked(row, ["finishedAt", "finished_at"], picked(payload, ["finishedAt", "finished_at"], "")),
    seq: Number(row.seq || 0),
    order,
    reconcileEvidenceActive: firstDefined(row.reconcileEvidenceActive, row.reconcile_evidence_active, payload.reconcileEvidenceActive, payload.reconcile_evidence_active),
  };
}

function operationPayload(row: unknown): Record<string, any> {
  const item = record(row);
  if (item.payload && typeof item.payload === "object") return record(item.payload);
  if (record(item.latestEvent).payload && typeof record(item.latestEvent).payload === "object") return record(record(item.latestEvent).payload);
  return item;
}

function operationStatusFromType(type: unknown): string {
  const text = String(type || "");
  if (text.includes("completed")) return "completed";
  if (text.includes("failed")) return "failed";
  if (text.includes("cancelled") || text.includes("canceled")) return "cancelled";
  if (text.includes("stalled")) return "stalled";
  if (text.includes("started") || text.includes("progress")) return "running";
  return "-";
}

function latestOperationRow(rows: Record<string, any>[]): Record<string, any> | null {
  return rows.reduce<Record<string, any> | null>((latest, row) => !latest || operationAtOrAfter(row, latest) ? row : latest, null);
}

function operationAtOrAfter(candidate: Record<string, any>, reference: Record<string, any>): boolean {
  const candidateAt = dateValue(candidate.updatedAt);
  const referenceAt = dateValue(reference.updatedAt);
  if (Number.isFinite(candidateAt) && Number.isFinite(referenceAt)) return candidateAt >= referenceAt;
  return Number(candidate.seq || 0) >= Number(reference.seq || 0);
}

function operationPending(status: unknown): boolean {
  return operationIsActive(status) || String(status || "").toLowerCase() === "accepted";
}

function operationIsActive(status: unknown): boolean {
  const value = String(status || "").toLowerCase();
  return OPERATION_ACTIVE_TOKENS.some((token) => value.includes(token));
}

function operationFailureLike(status: unknown): boolean {
  const value = String(status || "").toLowerCase();
  return OPERATION_FAILURE_TOKENS.some((token) => value.includes(token));
}

function operationIsCancelled(status: unknown): boolean {
  const value = String(status || "").toLowerCase();
  return value.includes("cancel") || value.includes("stop");
}

function operationSucceeded(status: unknown): boolean {
  const value = String(status || "").toLowerCase();
  return !operationFailureLike(value) && !operationIsCancelled(value)
    && (value.includes("complete") || value === "done" || value === "succeeded");
}

function taskMatchesPlanVersion(row: Record<string, any>, entry: PlanEntry): boolean {
  const revision = String(picked(row, ["planRevision", "plan_revision"], "") || "");
  if (entry.revision && revision) return revision === entry.revision;
  if (Number.isFinite(entry.updatedAt)) {
    const taskAt = dateValue(row.updatedAt || row.updated_at || row.startedAt || row.started_at);
    return Number.isFinite(taskAt) && taskAt >= entry.updatedAt;
  }
  return !entry.revision;
}

function operationMatchesPlanVersion(row: Record<string, any>, entry: PlanEntry): boolean {
  const revision = String(picked(row, ["planRevision", "plan_revision"], "") || "").trim();
  if (revision) return !entry.revision || revision === entry.revision;
  if (Number.isFinite(entry.updatedAt)) {
    const operationAt = dateValue(row.updatedAt || row.updated_at);
    return Number.isFinite(operationAt) && operationAt >= entry.updatedAt;
  }
  return !entry.revision;
}

function taskStatusToken(status: unknown): string {
  const value = String(status || "").trim().toLowerCase();
  if (value === "canceled") return "cancelled";
  if (value === "normal_completed") return "completed";
  if (value === "completed_with_errors") return "failed";
  if (value.includes("manual_interrupted")) return "stopped";
  return value;
}

function planFileEquivalenceKeys(value: unknown): string[] {
  const raw = normalizePlanFile(value);
  if (!raw) return [];
  const base = raw.split("/").pop() || raw;
  const noExt = base.replace(/\.(ya?ml|json)$/i, "");
  const keys = [raw, base, noExt];
  if (raw.startsWith("experiments/plans/")) keys.push(raw.slice("experiments/plans/".length));
  if (raw.startsWith("plans/")) keys.push(raw.slice("plans/".length));
  return [...new Set(keys.filter(Boolean))];
}

function samePlanSelection(left: unknown, right: unknown): boolean {
  const rightKeys = new Set(planFileEquivalenceKeys(right));
  return planFileEquivalenceKeys(left).some((key) => rightKeys.has(key));
}

function normalizePlanFileForDisplay(value: unknown): string {
  return String(value || "").trim().replaceAll("\\", "/");
}

function normalizePlanFile(value: unknown): string {
  return normalizePlanFileForDisplay(value).replace(/^\.\//, "").toLowerCase();
}

function objectRows(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.map(record);
  return Object.entries(record(value)).map(([id, row]) => ({ id, ...record(row) }));
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value as Record<string, unknown>) : [];
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text && text !== "-") return text;
  }
  return "";
}

function firstDefined(...values: unknown[]): any {
  return values.find((value) => value !== undefined && value !== null);
}

function picked(source: Record<string, any>, keys: string[], fallback: unknown): any {
  for (const key of keys) {
    const value = source && source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

function number(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

function boundedCount(value: number): number {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number.isFinite(value) ? value : 0)));
}

function dateValue(value: unknown): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
