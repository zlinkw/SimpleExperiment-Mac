import { normalizePosixRelativePath } from "./PosixPath";

type Row = Record<string, any>;
const records = ["results", "finalResults", "final_results", "pendingReviewRecords", "pending_review_records"];
const datasets = ["datasetResultTables", "projectDatasetTables", "paperDatasetTables"];
const object = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function macResultSummaryPlan(value: unknown): string {
  try { return value === "-" ? "" : normalizePosixRelativePath(value, "结果 Plan"); }
  catch { return ""; }
}

function identity(row: Row): { plan: string; invalid: boolean } {
  const owners = [row];
  if (row.provenance !== undefined && row.provenance !== null) {
    if (!object(row.provenance)) return { plan: "", invalid: true };
    owners.push(row.provenance);
  }
  const values = owners.flatMap(owner => [owner.planFile, owner.plan_file]).filter(value => value !== undefined && value !== "");
  const paths = values.map(macResultSummaryPlan);
  return { plan: paths[0] || "", invalid: paths.some(path => !path) || new Set(paths).size > 1 };
}

/** Keep only evidence owned by the exact selected Plan. Never stamp anonymous
 * top-level artifact paths with a selected Plan or repair conflicting aliases.
 */
export function scopeMacResultSummary(summary: unknown, selectedPlan: unknown): Row | unknown {
  if (!object(summary)) return summary;
  const plan = macResultSummaryPlan(selectedPlan);
  const empty = (reason: string): Row => ({ schemaVersion: summary.schemaVersion || 1, planFile: plan,
    resultCount: 0, parsedResults: 0, finalResultCount: 0, pendingReviewCount: 0,
    results: [], finalResults: [], final_results: [], pendingReviewRecords: [], pending_review_records: [],
    workerResultTables: [], sources: [], macResultScopeSuppressed: true, message: reason });
  if (!plan) return empty("当前结果 Plan 路径无效，摘要与结果来源已隐藏。");
  const root = identity(summary);
  if (root.invalid || (root.plan && root.plan !== plan)) return empty("结果摘要的 Plan 身份不符或别名冲突，未授权其结果来源。");
  const rootOwned = root.plan === plan;
  const owned = (row: unknown, inherit: boolean): row is Row => {
    if (!object(row)) return false;
    const id = identity(row);
    return !id.invalid && (id.plan ? id.plan === plan : inherit);
  };
  let changed = !rootOwned;
  const arrays: Row = {};
  for (const key of [...records, ...datasets]) {
    if (summary[key] !== undefined && !Array.isArray(summary[key])) { arrays[key] = []; changed = true; continue; }
    if (!Array.isArray(summary[key])) continue;
    arrays[key] = summary[key].filter((row: unknown) => owned(row, rootOwned));
    changed ||= arrays[key].length !== summary[key].length;
  }
  if (Array.isArray(summary.workerResultTables)) {
    arrays.workerResultTables = summary.workerResultTables.filter((table: unknown) => {
      if (!owned(table, rootOwned)) return false;
      // A contradictory nested dataset or completed job invalidates the table's
      // scalar paths and hash hints too; they cannot authorize another Plan.
      return datasets.every(key => table[key] === undefined || (Array.isArray(table[key]) && table[key].every((row: unknown) => owned(row, true))))
        && (table.completedJob == null || owned(table.completedJob, true));
    });
    changed ||= arrays.workerResultTables.length !== summary.workerResultTables.length;
  }
  else if (summary.workerResultTables !== undefined) { arrays.workerResultTables = []; changed = true; }
  for (const key of ["claimEvidence", "claim_evidence"]) {
    if (summary[key] !== undefined && (!owned(summary[key], rootOwned)
      || ["claims", "preview", "catalog"].some(field => Array.isArray(summary[key]?.[field])
        && !summary[key][field].every((row: unknown) => !object(row) || owned(row, true))))) changed = true;
  }
  if (!changed) return summary;
  // Mixed/anonymous aggregate paths, counts and analyses have no independent
  // proof. Preserve scoped rows/tables, not the original top-level artifacts.
  const out = { ...empty("已隔离当前 Plan 的结果记录；混合或匿名分析产物需按该 Plan 重新生成。"), ...arrays };
  for (const key of ["planRevision", "plan_revision", "generatedAt", "generated_at", "lastParsedAt", "last_parsed_at", "completedRunId"])
    if (rootOwned && summary[key] !== undefined) out[key] = summary[key];
  const rows = Array.isArray(arrays.results) ? arrays.results
    : [...(arrays.finalResults || arrays.final_results || []), ...(arrays.pendingReviewRecords || arrays.pending_review_records || [])];
  out.results = rows;
  out.resultCount = rows.length; out.parsedResults = rows.length;
  out.finalResults = rows.filter((row: Row) => String(row.finalEvidenceState || row.final_evidence_state || "").toLowerCase() === "archived");
  out.pendingReviewRecords = rows.filter((row: Row) => !out.finalResults.includes(row));
  out.final_results = out.finalResults; out.pending_review_records = out.pendingReviewRecords;
  out.finalResultCount = out.finalResults.length; out.pendingReviewCount = out.pendingReviewRecords.length;
  return out;
}
