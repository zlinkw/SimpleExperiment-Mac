import { createHash } from "node:crypto";
import { isAttemptOutputDir, type OutputRetirementCandidate } from "../features/PlanOutputRetention";
import { selectLatestCompletePlanRunIdentity, selectLatestPlanRunPreview, type AuthoritativePlanRun } from "./PlanRunFreshness";
import { buildTables, emptyTableRegistry, readCsv, updateRegistry } from "./ProjectResultTables";

export type ComparisonRun = {
  runId: string; planFile: string; code: string; revision: string; enqueuedAt: string;
  completed: number; expected: number; eligible: boolean; authority?: AuthoritativePlanRun;
};
export type ComparisonView = { title: string; header?: string[]; rows?: (string | number)[][]; text?: string };
export type RunComparison = { runId: string; status: "formal" | "preview"; views: ComparisonView[]; sources: unknown[] };
export type PlanComparisonTable = {
  planFile: string;
  columns: { key: string; label: string }[];
  rows: { runId: string; values: (string | number)[] }[];
};

/** One run per row, with adapter statistics aligned across versions of the same Plan. */
export function planComparisonTables(runs: ComparisonRun[], results: Map<string, RunComparison>): PlanComparisonTable[] {
  const groups = new Map<string, { table: PlanComparisonTable; values: Map<string, Map<string, string | number>> }>();
  for (const run of runs) {
    if (!groups.has(run.planFile)) groups.set(run.planFile, {
      table: { planFile: run.planFile, columns: [], rows: [] }, values: new Map(),
    });
    const group = groups.get(run.planFile)!, cells = new Map<string, string | number>();
    group.values.set(run.runId, cells);
    const result = results.get(run.runId);
    // Preview values remain in their labelled detail view, never in formal version columns.
    if (result?.status !== "formal") continue;
    for (const view of result.views) {
      if (!view.header || !view.rows || !view.title.endsWith("/final.csv")) continue;
      const dimensions = view.header.map((_name, index) => index).filter(index => view.rows!.some(row => String(row[index] ?? "").trim())
        && view.rows!.every(row => {
          const value = row[index];
          return value === undefined || !String(value).trim() || typeof value === "string"
            && !Number.isFinite(Number(value)) && !value.includes("±") && value !== "未计算";
        }));
      const measures = view.header.map((_name, index) => index).filter(index => !dimensions.includes(index));
      const occurrences = new Map<string, number>();
      for (const row of view.rows) {
        const identity = dimensions.map(index => [view.header![index], row[index] ?? ""]);
        const rowKey = JSON.stringify(identity), occurrence = (occurrences.get(rowKey) || 0) + 1;
        occurrences.set(rowKey, occurrence);
        const label = [view.title.split(" / ")[0], ...identity.map(([_name, value]) => String(value)),
          ...(occurrence > 1 ? [`第 ${occurrence} 行`] : [])].filter(Boolean).join(" / ");
        for (const index of measures) {
          const key = JSON.stringify([view.title, identity, occurrence, view.header[index]]);
          if (!group.table.columns.some(column => column.key === key))
            group.table.columns.push({ key, label: `${label} / ${view.header[index]}` });
          const value = row[index];
          cells.set(key, value === undefined || value === null || !String(value).trim() ? "未计算" : value);
        }
      }
    }
  }
  for (const group of groups.values()) group.table.rows = runs.filter(run => run.planFile === group.table.planFile)
    .map(run => ({ runId: run.runId, values: group.table.columns.map(column => group.values.get(run.runId)!.get(column.key) ?? "—") }));
  return [...groups.values()].map(group => group.table);
}

/** Display only: retain adapter values unchanged, combine means and deviations at four decimals. */
export function statisticsComparisonView(table: { header: string[]; rows: (string | number)[][] }): Pick<ComparisonView, "header" | "rows"> {
  const pairs = new Map<number, number>();
  for (const [index, name] of table.header.entries()) if (name.endsWith("_mean")) {
    const base = name.slice(0, -5);
    const deviation = table.header.findIndex(column => column === base + "_sd" || column === base + "_std");
    if (deviation >= 0) pairs.set(index, deviation);
  }
  const omitted = new Set(pairs.values());
  const indices = table.header.map((_name, index) => index).filter(index => !omitted.has(index));
  const decimal = (value: string | number | undefined) => value === undefined || value === null || !String(value).trim()
    || !Number.isFinite(Number(value)) ? "未计算" : Number(value).toFixed(4);
  return { header: indices.map(index => pairs.has(index) ? table.header[index].slice(0, -5) : table.header[index]),
    rows: table.rows.map(row => indices.map(index => pairs.has(index)
      ? `${decimal(row[index])}±${decimal(row[pairs.get(index)!])}` : row[index])) };
}

/** Stable review identity excludes sync receipts and our own retirement marks. */
export function comparisonQueueIdentity(queue: any): string {
  return createHash("sha256").update(JSON.stringify((queue.plans || []).map((plan: any) => [
    plan.id, plan.planFile, plan.codeFingerprint, plan.revision, plan.fullPlanJobCount, plan.enqueuedAt,
    (plan.jobs || []).map((job: any) => [job.index, job.case, job.seed, job.attempt, job.workerId, job.commandId,
      job.outputDir, job.status, job.recoveryConflict, (job.history || []).map((old: any) => [old.outputDir, old.status, old.workerId])]),
  ]))).digest("hex");
}

export function comparisonRuns(queue: any, candidates: OutputRetirementCandidate[]): ComparisonRun[] {
  return (queue.plans || []).filter((plan: any) => plan.jobs?.some((job: any) => !job.outputRetiredAt && isAttemptOutputDir(job.outputDir)))
    .map((plan: any) => {
      const one = { plans: [plan] };
      const complete = selectLatestCompletePlanRunIdentity(one, plan.planFile, plan.revision);
      const authority = complete || selectLatestPlanRunPreview(one, plan.planFile, plan.revision);
      // Do not offer partially retired runs or failed/unknown identities for deletion.
      const eligible = Boolean(plan.codeFingerprint && plan.revision && complete && plan.jobs.every((job: any) => !job.outputRetiredAt
        && candidates.some(candidate => candidate.planFile === plan.planFile && candidate.outputDir === job.outputDir)));
      return { runId: String(plan.id), planFile: String(plan.planFile), code: String(plan.codeFingerprint || "未知代码身份"),
        revision: String(plan.revision || ""), enqueuedAt: String(plan.enqueuedAt || ""), eligible, authority,
        completed: authority?.jobs.length || 0, expected: Number(plan.fullPlanJobCount || plan.planJobCount || plan.jobs.length) };
    }).sort((a: ComparisonRun, b: ComparisonRun) => a.planFile.localeCompare(b.planFile) || b.enqueuedAt.localeCompare(a.enqueuedAt));
}

/** Reuse the existing statistics and lossless wrapper views entirely in memory. */
export function comparisonFromSummary(run: ComparisonRun, summary: any, adapter: any = {}): RunComparison {
  if (!run.authority || !summary?.wrapperEvidence || summary.wrapperEvidence.runId !== run.runId
    || summary.runId !== run.runId || summary.planRevision !== run.revision
    || !["formal", "preview"].includes(summary.wrapperEvidence.status))
    throw new Error("审核结果缺少匹配的运行/配置身份；保留该版本。");
  const preview = run.authority.jobs.length !== run.expected || summary.wrapperEvidence.status === "preview";
  const jobs = summary.wrapperEvidence.jobs || [];
  if (!jobs.length || !preview && jobs.length !== run.expected || jobs.some((item: any) => {
    const job = item.job;
    return !job || job.runId !== run.runId || !run.authority!.jobs.some(expected => expected.index === job.index
      && expected.case === job.case && expected.seed === job.seed && expected.attempt === job.attempt
      && expected.outputDir === job.outputDir && expected.workerId === (job.ownerWorkerId || job.workerId));
  })) throw new Error("审核 wrapper 作业身份不匹配；保留该版本。");
  if (!preview && (summary.completedMetricFilesMissing?.length || summary.incompleteAggregate))
    throw new Error("该版本必需产物不完整；保留原始结果。");
  const views: ComparisonView[] = [];
  if (!preview && summary.results?.length) {
    const seeds = new Set(run.authority.jobs.map(job => job.seed)).size;
    const registry = updateRegistry(emptyTableRegistry(), summary, run.planFile, seeds, adapter.planDatasetMapping || {});
    registry.derivedMetric = adapter.derivedMetric;
    for (const table of Object.values(buildTables(registry))) {
      // A version-local table never borrows records from another run or the live registry.
      views.push({ title: `${table.dataset} / ${table.relativePath}`, ...statisticsComparisonView(table) });
    }
  }
  const declared = new Set(summary.wrapperEvidence.views || []);
  for (const file of summary._wrapperFiles || []) {
    if (!declared.has(file.relativePath)) continue;
    const contents = String(file.contents);
    if (file.relativePath.endsWith(".csv")) {
      const table = readCsv(contents);
      views.push({ title: file.relativePath, header: table.header, rows: table.rows });
    } else views.push({ title: file.relativePath, text: contents });
  }
  if (!views.length) throw new Error("该版本尚无可核验的 wrapper 结果视图；保留原始结果。");
  const sources = (summary.wrapperEvidence.jobs || []).map((job: any) => ({ job: job.job, checkpointPath: job.checkpointPath, sources: job.sources }));
  return { runId: run.runId, status: preview ? "preview" : "formal", views, sources };
}

/** Selection is an explicit allow-list; retained, protected and failed runs cannot leak into cleanup. */
export function selectedComparisonCandidates(runs: ComparisonRun[], results: Map<string, RunComparison>, selected: unknown,
  candidates: OutputRetirementCandidate[]): OutputRetirementCandidate[] {
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length
    || selected.some(id => typeof id !== "string" || !runs.some(run => run.runId === id && run.eligible)
      || results.get(id)?.status !== "formal")) throw new Error("版本选择尚未核验或已失效；未删除任何产物。");
  const dirs = new Set(runs.filter(run => selected.includes(run.runId)).flatMap(run =>
    (run.authority!.plan.jobs || []).flatMap((job: any) => [job.outputDir, ...(job.history || []).map((old: any) => old.outputDir)])));
  return candidates.filter(candidate => dirs.has(candidate.outputDir));
}
