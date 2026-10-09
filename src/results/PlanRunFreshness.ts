import { normalizePosixRelativePath } from "../mac/PosixPath";

export type AuthoritativeJobIdentity = {
  index: number;
  case: string;
  seed: number;
  attempt: number;
  workerId: string;
  outputDir: string;
  commandId: string;
  artifactHashes: Record<string, string>;
};

export type AuthoritativePlanRun = {
  runId: string;
  planFile: string;
  revision: string;
  enqueuedAt: string;
  expectedJobCount: number;
  jobs: AuthoritativeJobIdentity[];
  plan: Record<string, any>;
};

function normalizedPlanFile(value: unknown): string {
  if (process.platform === "darwin") {
    try { return normalizePosixRelativePath(value, "结果 Plan 路径"); }
    catch { return ""; }
  }
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim().toLowerCase();
}

function normalizedOutputPath(value: unknown): string {
  if (process.platform === "darwin") {
    try { return normalizePosixRelativePath(value, "结果输出路径"); }
    catch { return ""; }
  }
  return String(value || "").replace(/\\/g, "/");
}

function timestamp(value: unknown): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function authoritativeJob(plan: Record<string, any>, job: Record<string, any>, requireArtifactHashes: boolean): AuthoritativeJobIdentity | undefined {
  const index = Number(job?.index);
  const seed = Number(job?.seed);
  const attempt = Number(job?.attempt);
  const workerId = String(job?.workerId || "").trim();
  const outputDir = process.platform === "darwin" ? normalizedOutputPath(job?.outputDir)
    : String(job?.outputDir || "").replace(/\\/g, "/").trim();
  if (!Number.isInteger(index) || index < 0 || !String(job?.case || "").trim() || !Number.isInteger(seed)
    || !Number.isInteger(attempt) || attempt < 1 || !workerId || !outputDir
    || outputDir.startsWith("/") || /^[A-Za-z]:/.test(outputDir)
    || outputDir.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  const artifactHashes: Record<string, string> = {};
  for (const [file, hash] of Object.entries(job?.artifacts || {})) {
    if (/^[a-f0-9]{64}$/i.test(String(hash || ""))) {
      if (process.platform === "darwin" && !normalizedOutputPath(file)) return undefined;
      artifactHashes[String(file)] = String(hash).toLowerCase();
    }
  }
  const commandId = String(job.commandId || "").trim();
  if (!commandId || requireArtifactHashes && !Object.keys(artifactHashes).length) return undefined;
  return {
    index,
    case: String(job.case).trim(),
    seed,
    attempt,
    workerId,
    outputDir,
    commandId,
    artifactHashes,
  };
}

/** Select the newest complete distributed run for a Plan/revision, never a shared result CSV. */
export function selectLatestCompletePlanRun(queue: unknown, planFile: string, expectedRevision = ""): AuthoritativePlanRun | undefined {
  return selectLatestCompletePlanRunInternal(queue, planFile, expectedRevision, true);
}

/** Select completion identity before discovering metrics; empty hashes do not prove artifact availability. */
export function selectLatestCompletePlanRunIdentity(queue: unknown, planFile: string, expectedRevision = ""): AuthoritativePlanRun | undefined {
  return selectLatestCompletePlanRunInternal(queue, planFile, expectedRevision, false);
}

/** A retry namespace belongs to a job attempt, while publication still belongs to its Plan run. */
export function hasExclusiveAttemptOutput(queue: unknown, run: AuthoritativePlanRun, job: AuthoritativeJobIdentity): boolean {
  const output = normalizedOutputPath(job.outputDir);
  const parts = output.split("/");
  if (!run.runId || !output || !normalizedPlanFile(run.plan.planFile || run.plan.file) || output.startsWith("/") || parts.some(part => !part || part === "." || part === ".." || /[:\x00-\x1f]/.test(part))) return false;
  const scoped = parts.some((part, index) => part === "attempts" && (parts[index + 1] === run.runId
    || job.attempt > 1 && /^(?:distributed-attempt|auto-retry)-[0-9]+-[a-z0-9]+$/.test(parts[index + 1] || "")));
  if (!scoped) return false;
  const identity = (plan: Record<string, any>, row: Record<string, any>) => JSON.stringify([
    normalizedPlanFile(plan.planFile || plan.file), String(plan.revision || ""), String(plan.codeFingerprint || ""), String(plan.id || ""),
    Number(row.index), String(row.case || ""), Number(row.seed), Number(row.attempt), String(row.workerId || ""), String(row.commandId || ""),
  ]);
  const expected = identity(run.plan, job);
  if (!run.jobs.some(row => row.outputDir === output && identity(run.plan, row) === expected)) return false;
  const plans = Array.isArray((queue as any)?.plans) ? (queue as any).plans : [];
  let found = false;
  for (const plan of plans) for (const row of Array.isArray(plan.jobs) ? plan.jobs : []) {
    if (normalizedOutputPath(row.outputDir) === output) {
      if (identity(plan, row) !== expected || plan.recoveryConflict || row.recoveryConflict || row.outputRetiredAt
        || !["completed", "succeeded", "success"].includes(String(row.status || "").toLowerCase())
        || row.trustedTerminalStatus && row.trustedTerminalStatus !== "completed") return false;
      found = true;
    }
    if ((Array.isArray(row.history) ? row.history : []).some((previous: Record<string, any>) => normalizedOutputPath(previous.outputDir) === output)) return false;
  }
  return found;
}

/** Incomplete newest runs have a separate preview; never lend their seeds to formal results. */
export function selectLatestPlanRunPreview(queue: unknown, planFile: string, expectedRevision = ""): AuthoritativePlanRun | undefined {
  const selectedPlan = normalizedPlanFile(planFile);
  if (!selectedPlan) return undefined;
  const rows: Record<string, any>[] = Array.isArray((queue as any)?.plans) ? (queue as any).plans : [];
  const selected = rows.map((plan, order) => ({ plan, order })).filter(({ plan }) =>
    normalizedPlanFile(plan.planFile || plan.file) === selectedPlan && plan.id && plan.revision
    && (!expectedRevision || plan.revision === expectedRevision) && !plan.recoveryConflict)
    .sort((left, right) => timestamp(right.plan.enqueuedAt) - timestamp(left.plan.enqueuedAt) || right.order - left.order)[0]?.plan;
  if (!selected) return undefined;
  const all = Array.isArray(selected.jobs) ? selected.jobs : [];
  const expected = Number(selected.fullPlanJobCount || selected.planJobCount || all.length);
  if (all.length !== expected || !all.length || new Set(all.map(job => job.case + "\0" + job.seed)).size !== expected) return undefined;
  const completed = all.filter(job => ["completed", "succeeded", "success"].includes(String(job.status)) && !job.outputRetiredAt && !job.recoveryConflict);
  if (!completed.length || completed.length === expected) return undefined;
  const jobs = completed.map(job => authoritativeJob(selected, job, false));
  if (jobs.some(job => !job)) return undefined;
  return { runId: String(selected.id), planFile, revision: String(selected.revision), enqueuedAt: String(selected.enqueuedAt || ""),
    expectedJobCount: expected, jobs: (jobs as AuthoritativeJobIdentity[]).sort((left, right) => left.index - right.index), plan: selected };
}

function selectLatestCompletePlanRunInternal(queue: unknown, planFile: string, expectedRevision: string, requireArtifactHashes: boolean): AuthoritativePlanRun | undefined {
  const rows: Record<string, any>[] = Array.isArray((queue as any)?.plans) ? (queue as any).plans : [];
  const selectedPlan = normalizedPlanFile(planFile);
  if (!selectedPlan) return undefined;
  const revision = String(expectedRevision || "").trim();
  const candidates = rows.map((plan: Record<string, any>, order: number) => ({ plan, order }))
    .filter(({ plan }) => normalizedPlanFile(plan?.planFile || plan?.file) === selectedPlan
      && Boolean(String(plan?.id || "").trim())
      && Boolean(String(plan?.revision || "").trim())
      && (!revision || String(plan.revision) === revision)
      && !plan.recoveryConflict && Number(plan.recoveryMissingCount || 0) === 0)
    .map(({ plan, order }) => {
      const jobs = Array.isArray(plan.jobs) ? plan.jobs : [];
      const expectedJobCount = Number(plan.fullPlanJobCount || plan.planJobCount || jobs.length);
      if (!Number.isInteger(expectedJobCount) || expectedJobCount <= 0 || jobs.length !== expectedJobCount) return undefined;
      const normalized = jobs.map((job: Record<string, any>) => authoritativeJob(plan, job, requireArtifactHashes));
      if (normalized.some((job: AuthoritativeJobIdentity | undefined) => !job)
        || jobs.some((job: Record<string, any>) => job.outputRetiredAt || !["completed", "succeeded", "success"].includes(String(job.status || "").toLowerCase()))) return undefined;
      const typedJobs = normalized as AuthoritativeJobIdentity[];
      if (new Set(typedJobs.map((job) => job.index)).size !== expectedJobCount
        || new Set(typedJobs.map((job) => `${job.case}\0${job.seed}`)).size !== expectedJobCount) return undefined;
      if (!requireArtifactHashes && (jobs.some((job: Record<string, any>) => job.recoveryConflict
        || job.trustedTerminalStatus && job.trustedTerminalStatus !== "completed")
        || typedJobs.some(job => job.index >= expectedJobCount)
        || new Set(typedJobs.map(job => `${job.workerId}\0${job.commandId}`)).size !== expectedJobCount)) return undefined;
      const latestFinishedAt = Math.max(...jobs.map((job: Record<string, any>) => timestamp(job.finishedAt)));
      return {
        runId: String(plan.id),
        planFile: String(plan.planFile || plan.file),
        revision: String(plan.revision),
        enqueuedAt: String(plan.enqueuedAt || ""),
        expectedJobCount,
        jobs: typedJobs.sort((left, right) => left.index - right.index),
        plan,
        order,
        queuedAt: timestamp(plan.enqueuedAt),
        latestFinishedAt,
      };
    })
    .filter(Boolean)
    .sort((left: any, right: any) => right.queuedAt - left.queuedAt
      || right.latestFinishedAt - left.latestFinishedAt || right.order - left.order);
  const selected = candidates[0] as (AuthoritativePlanRun & { order: number; queuedAt: number; latestFinishedAt: number }) | undefined;
  if (!selected) return undefined;
  const { order: _order, queuedAt: _queuedAt, latestFinishedAt: _finished, ...selectedRun } = selected;
  return selectedRun.runId ? selectedRun : undefined;
}

export function reportedRunIds(summary: unknown): string[] {
  const value = summary && typeof summary === "object" ? summary as Record<string, any> : {};
  const ids = new Set<string>();
  const add = (entry: unknown) => {
    const id = String(entry || "").trim();
    if (id) ids.add(id);
  };
  add(value.completedRunId);
  add(value.runId);
  add(value.selectedRunId);
  add(value.planRunId || value.plan_run_id);
  for (const row of Array.isArray(value.results) ? value.results : [])
    add(row?.runId || row?.run_id || row?.provenance?.runId);
  for (const row of Array.isArray(value.workerResultTables) ? value.workerResultTables : [])
    add(row?.runId || row?.run_id || row?.completedJob?.runId || row?.provenance?.runId);
  return [...ids];
}

export function summaryProvesRun(summary: unknown, run: AuthoritativePlanRun): boolean {
  const value = summary && typeof summary === "object" ? summary as Record<string, any> : {};
  const ids = reportedRunIds(value);
  const reportedRevision = String(value.planRevision || value.plan_revision || "").trim();
  return ids.length === 1 && ids[0] === run.runId && (!reportedRevision || reportedRevision === run.revision);
}

const RESULT_PATH_FIELDS = [
  "previewCsvPath", "rawResultCsvPath", "aggregateCsvPath", "projectAggregateCsvPath", "finalCsvPath", "finalMarkdownPath",
  "projectFinalCsvPath", "projectFinalMarkdownPath", "preview_csv_path", "effectiveResultsCsvPath", "effective_results_csv_path",
  "qualityGatePath", "quality_gate_path", "statisticsPath", "statistics_path", "paperTablePath", "paper_table_path",
  "paperTableCsvPath", "paper_table_csv_path", "claimEvidencePath", "claim_evidence_path",
];

/** Drop all summary-owned result sources before recovering files from a different authoritative run. */
export function summaryForRunRecovery(summary: unknown, planFile: string, run: AuthoritativePlanRun): Record<string, any> {
  const value = summary && typeof summary === "object" && !Array.isArray(summary) ? summary as Record<string, any> : {};
  const next = { ...value };
  for (const field of RESULT_PATH_FIELDS) delete next[field];
  for (const field of ["results", "workerResultTables", "datasetResultTables", "projectDatasetTables", "paperDatasetTables", "metricPaths", "outputCandidates", "resultCandidates"])
    next[field] = [];
  delete next.claimEvidence;
  delete next.claim_evidence;
  return {
    ...next,
    planFile,
    planRevision: run.revision,
    completedRunId: run.runId,
    runId: run.runId,
    selectedRunId: run.runId,
    mixedPlanRevision: false,
    results: [],
    workerResultTables: [],
  };
}
