type Row = Record<string, any>;
const object = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const records = ["results", "finalResults", "final_results", "pendingReviewRecords", "pending_review_records"];
const datasets = ["datasetResultTables", "projectDatasetTables", "paperDatasetTables"];
const links = ["payload", "latestEvent", "contractReport"];
export function resultPlanPath(value: unknown): string {
  if (typeof value !== "string" || !value || value === "-" || /[\x00-\x1f\x7f]/.test(value)) return "";
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some(p => !p || p === "." || p === "..") ? "" : path;
}
const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
function alias(row: Row, keys: string[], ownerKey: string, plan: boolean): string {
  const owners = [row];
  if (row[ownerKey] != null) { if (!object(row[ownerKey])) throw Error("Invalid receipt owner"); owners.push(row[ownerKey]); }
  const values: string[] = [];
  for (const owner of owners) for (const name of keys) {
    const value = owner[name]; if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value === "-" || /[\x00-\x1f\x7f]/.test(value)) throw Error("Invalid receipt identity");
    const normalized = plan ? resultPlanPath(value) : value;
    if (!normalized) throw Error("Invalid receipt path"); values.push(plan ? key(normalized) : normalized);
  }
  if (new Set(values).size > 1) throw Error("Conflicting receipt aliases");
  return values[0] || "";
}
/** Exact ownership scopes viewing/temporary reads; it does not modify results or manifests. */
export function scopeResultSummary(summary: unknown, selectedPlan: unknown): any {
  if (!object(summary)) return summary;
  const plan = resultPlanPath(selectedPlan);
  const empty = () => ({ schemaVersion: summary.schemaVersion || 1, planFile: plan, resultCount: 0, parsedResults: 0, finalResultCount: 0, pendingReviewCount: 0,
    results: [], finalResults: [], final_results: [], pendingReviewRecords: [], pending_review_records: [], workerResultTables: [], sources: [], resultScopeSuppressed: true,
    message: "摘要缺少当前 PLAN 的唯一归属；已隐藏混合或匿名产物，请按当前 PLAN 重新汇总。" });
  if (!plan) return empty();
  try {
    const identity = (r: Row) => alias(r, ["planFile", "plan_file", "plan", "selectedPlanId"], "provenance", true);
    const root = identity(summary); if (root && root !== key(plan)) return empty();
    const rootOwned = root === key(plan), owned = (r: unknown, inherit: boolean): r is Row => {
      if (!object(r)) return false;
      try { const id = identity(r); return id ? id === key(plan) : inherit; } catch { return false; }
    };
    let changed = !rootOwned; const arrays: Row = {};
    for (const name of [...records, ...datasets]) {
      if (summary[name] === undefined) continue;
      arrays[name] = Array.isArray(summary[name]) ? summary[name].filter((r: unknown) => owned(r, rootOwned)) : [];
      changed ||= !Array.isArray(summary[name]) || arrays[name].length !== summary[name].length;
    }
    if (summary.workerResultTables !== undefined) {
      arrays.workerResultTables = Array.isArray(summary.workerResultTables) ? summary.workerResultTables.filter((r: unknown) => owned(r, rootOwned)
        && datasets.every(name => r[name] === undefined || Array.isArray(r[name]) && r[name].every((child: unknown) => owned(child, true)))
        && (r.completedJob == null || owned(r.completedJob, true))) : [];
      changed ||= !Array.isArray(summary.workerResultTables) || arrays.workerResultTables.length !== summary.workerResultTables.length;
    }
    for (const name of ["claimEvidence", "claim_evidence"]) if (summary[name] !== undefined && (!owned(summary[name], rootOwned)
      || ["claims", "preview", "catalog"].some(k => Array.isArray(summary[name][k]) && !summary[name][k].every((r: unknown) => !object(r) || owned(r, true))))) changed = true;
    if (!changed) return summary;
    const out: Row = { ...empty(), ...arrays };
    out.unverifiedResults = Array.isArray(summary.results) ? summary.results.filter((r: unknown) => {
      try { return object(r) && !identity(r); } catch { return false; }
    }).slice(0, 30).map((r: Row) => ({
      ownershipState: "unverified", experimentId: r.experimentId || r.runKey || "", dimensions: r.dimensions || {}, metrics: r.metrics || {},
    })) : [];
    if (out.unverifiedResults.length) out.message = "部分历史结果归属待核实；保留指标预览，不授权原始文件读取或作为当前作业完成证据。";
    for (const name of ["planRevision", "plan_revision", "generatedAt", "generated_at", "lastParsedAt", "last_parsed_at", "completedRunId"]) if (rootOwned && summary[name] !== undefined) out[name] = summary[name];
    const rows = arrays.results || [...(arrays.finalResults || arrays.final_results || []), ...(arrays.pendingReviewRecords || arrays.pending_review_records || [])];
    out.results = rows; out.resultCount = out.parsedResults = rows.length;
    out.finalResults = rows.filter((r: Row) => String(r.finalEvidenceState || r.final_evidence_state || "").toLowerCase() === "archived");
    out.pendingReviewRecords = rows.filter((r: Row) => !out.finalResults.includes(r));
    out.final_results = out.finalResults; out.pending_review_records = out.pendingReviewRecords;
    out.finalResultCount = out.finalResults.length; out.pendingReviewCount = out.pendingReviewRecords.length;
    return out;
  } catch { return empty(); }
}
export function scopeResultOperation(row: unknown, selectedPlan: unknown): { payloads: Row[]; contractCheck: boolean } {
  const empty = { payloads: [], contractCheck: false }, plan = resultPlanPath(selectedPlan);
  if (!object(row) || !plan) return empty;
  try {
    const payloads: Row[] = [], revisions = new Set<string>(), active = new Set<Row>(); let nodes = 0, contractCheck = false;
    const planKeys = ["planFile", "plan_file", "plan", "selectedPlanId", "selected_plan_id"], revKeys = ["planRevision", "plan_revision"];
    function visit(item: Row, inherited: boolean, contract: boolean, depth: number): boolean {
      if (++nodes > 64 || depth > 8 || active.has(item)) throw Error("Invalid receipt tree"); active.add(item);
      const id = alias(item, planKeys, "options", true); if (id && id !== key(plan)) throw Error("Foreign receipt PLAN");
      const owned = Boolean(id || inherited), check = contract || [item.type, item.action].some(v => typeof v === "string" && v.toLowerCase() === "check-output-contract");
      if (owned) {
        const revision = alias(item, revKeys, "options", false); if (revision) revisions.add(revision);
        for (const entry of Array.isArray(item.unparseable) ? item.unparseable : []) if (object(entry)) {
          const entryPlan = alias(entry, planKeys, "options", true); if (entryPlan && entryPlan !== key(plan)) throw Error("Foreign result entry");
          const entryRev = alias(entry, revKeys, "options", false); if (entryRev) revisions.add(entryRev);
        }
        const copy: Row = { ...item, planFile: plan }; for (const name of [...links, "options"]) delete copy[name];
        if (revision) copy.planRevision = revision; payloads.push(copy); contractCheck ||= check;
      }
      let descendantOwned = owned;
      for (const name of links) if (item[name] != null) { if (!object(item[name])) throw Error("Invalid receipt wrapper"); descendantOwned = visit(item[name], owned, check || name === "contractReport", depth + 1) || descendantOwned; }
      if (descendantOwned) contractCheck ||= check; active.delete(item); return descendantOwned;
    }
    visit(row, false, false, 0); return revisions.size > 1 ? empty : { payloads, contractCheck };
  } catch { return empty; }
}
