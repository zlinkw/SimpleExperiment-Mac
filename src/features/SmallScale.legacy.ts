import { createHash } from "crypto";
import { ComparisonStudyRecord } from "./Comparison";
import { ExperimentPlanRecord, importLegacyPlanYamlToRegistry } from "./PlanBuilder";
import { ExperimentResultRecord } from "./Results";
import { ContractCheckResult, QualityGateResult, StatisticalTestResult } from "./Quality";

export type ExperimentScaleMode = "small" | "medium" | "custom";

export interface SmallScaleSettings {
  scaleMode: ExperimentScaleMode;
  maxConcurrentExperiments: number;
  maxVisibleExperimentsWithoutPaging: number;
  useFileBasedRegistryOnly: boolean;
  enableHeavyIndexing: boolean;
  enableExternalDatabase: boolean;
  autoRefreshResultsAfterRun: boolean;
}

export const defaultSmallScaleSettings: SmallScaleSettings = {
  scaleMode: "small",
  maxConcurrentExperiments: 10,
  maxVisibleExperimentsWithoutPaging: 200,
  useFileBasedRegistryOnly: true,
  enableHeavyIndexing: false,
  enableExternalDatabase: false,
  autoRefreshResultsAfterRun: true,
};

export interface CompletenessMatrixConfig {
  id: string;
  name: string;
  scope: { planId?: string; studyId?: string; suite?: string };
  axes: Array<"method" | "dataset" | "split" | "fold" | "seed" | "missing_rate" | "noise_level">;
  requiredMetrics: string[];
  requireQualityGatePassed: boolean;
}

export interface CompletenessCell {
  key: Record<string, string | number | boolean>;
  status: "not_planned" | "planned" | "queued" | "running" | "completed_no_result" | "parse_failed" | "result_available" | "quality_failed" | "ready_for_analysis" | "excluded";
  experimentIds: string[];
  resultIds: string[];
  missingMetrics?: string[];
  warnings?: string[];
}

export interface PreRunChecklistResult {
  planId: string;
  status: "ok" | "warning" | "failed";
  checkedAt: string;
  items: Array<{ id: string; category: "plan" | "dataset" | "output_contract" | "environment" | "resource" | "duplicate" | "result" | "safety"; status: "ok" | "warning" | "failed" | "skipped"; message: string; suggestion?: string }>;
}

export interface PostRunChecklistResult {
  experimentId: string;
  attemptId?: string;
  status: "ok" | "warning" | "failed";
  checkedAt: string;
  items: Array<{ id: string; category: "result_file" | "metric" | "case_level" | "checkpoint" | "log" | "quality_gate" | "statistics" | "paper_table"; status: "ok" | "warning" | "failed" | "skipped"; message: string; suggestion?: string }>;
}

export interface MissingRerunOptions {
  sourceStudyId?: string;
  sourcePlanId?: string;
  completenessMatrixId?: string;
  missingTypes: Array<"not_planned" | "failed" | "completed_no_result" | "parse_failed" | "quality_failed" | "missing_primary_metric">;
  skipLockedResults: boolean;
  keepSameSeed: boolean;
  keepSameSplit: boolean;
  generateNewAttemptId: boolean;
}

export type ManualReviewState = "unreviewed" | "manual_verified" | "paper_ready" | "needs_rerun" | "suspect_result" | "do_not_use";

export interface ManualReviewRecord {
  targetType: "experiment" | "result" | "case" | "study" | "paper_table";
  targetId: string;
  state: ManualReviewState;
  reason?: string;
  reviewer?: string;
  reviewedAt: string;
}

export interface PaperFreezeRecord {
  freezeId: string;
  studyId?: string;
  leaderboardIds: string[];
  paperTableIds: string[];
  resultIds: string[];
  statisticalResultIds: string[];
  configSnapshot: { resultSchemaId?: string; parserPresetIds: string[]; inclusionPolicyIds: string[]; statisticalPlanIds: string[]; paperTableConfigIds: string[] };
  createdAt: string;
  label: string;
  notes?: string;
  sha256?: string;
  frozenMarkdown?: string;
  frozenLatex?: string;
}

export interface SmallScaleExperimentReportConfig {
  id: string;
  scope: { planId?: string; studyId?: string; suite?: string };
  sections: Array<"overview" | "completeness" | "pre_run_checklist" | "post_run_checklist" | "quality_gate" | "leaderboard" | "statistics" | "paper_tables" | "missing_items" | "failed_experiments" | "manual_review" | "next_actions">;
}

export interface OutputCapability {
  capability:
    | "summary_metrics"
    | "leaderboard"
    | "paper_table"
    | "quality_gate"
    | "paired_statistics"
    | "case_level_analysis"
    | "subgroup_analysis"
    | "patient_leakage_check"
    | "checkpoint_management"
    | "training_curve"
    | "environment_reproducibility";
  status: "available" | "partial" | "unavailable";
  requiredFiles: string[];
  requiredColumns: string[];
  missingFiles: string[];
  missingColumns: string[];
  message: string;
  suggestion: string;
}

export function normalizeSmallScaleSettings(input: Partial<SmallScaleSettings> = {}): SmallScaleSettings {
  return {
    ...defaultSmallScaleSettings,
    ...input,
    maxConcurrentExperiments: Math.min(input.maxConcurrentExperiments ?? defaultSmallScaleSettings.maxConcurrentExperiments, 10),
    useFileBasedRegistryOnly: true,
    enableHeavyIndexing: false,
    enableExternalDatabase: false,
  };
}

export function buildCompletenessMatrix(config: CompletenessMatrixConfig, input: { plans?: ExperimentPlanRecord[]; studies?: ComparisonStudyRecord[]; results?: ExperimentResultRecord[]; gateResults?: QualityGateResult[]; lifecycles?: Array<{ experimentId: string; status?: string; state?: string }> }): CompletenessCell[] {
  const plans = (input.plans || []).filter((plan) => (!config.scope.planId || plan.planId === config.scope.planId) && (!config.scope.suite || plan.suite === config.scope.suite));
  const study = (input.studies || []).find((item) => item.studyId === config.scope.studyId);
  const planned = [
    ...plans.flatMap((plan) => plan.plannedExperiments.map((exp) => ({ ...dimsFromRun(exp.runKey), experimentId: exp.experimentKey, status: exp.status || "planned" }))),
    ...(study ? study.methods.flatMap((method) => study.datasets.flatMap((dataset) => study.splits.flatMap((split) => study.seeds.map((seed) => ({ method: method.methodId, dataset: dataset.name, split: split.name, seed, experimentId: `${study.studyId}:${method.methodId}:${dataset.name}:${split.name}:${seed}`, status: "planned" as const }))))) : []),
  ];
  const planKeys = new Map<string, typeof planned>();
  for (const item of planned) {
    const key = keyFor(config.axes, item);
    const plannedItems = planKeys.get(key);
    if (plannedItems) plannedItems.push(item);
    else planKeys.set(key, [item]);
  }
  const resultKeys = new Map<string, ExperimentResultRecord[]>();
  for (const record of input.results || []) {
    if (config.scope.suite && record.suite !== config.scope.suite) continue;
    const key = keyFor(config.axes, { ...record.dimensions, ...dimsFromRun(record.runKey) });
    const records = resultKeys.get(key);
    if (records) records.push(record);
    else resultKeys.set(key, [record]);
  }
  const gateResultsByExperiment = new Map<string, Array<{ order: number; value: QualityGateResult }>>();
  for (const [order, value] of (input.gateResults || []).entries()) {
    const gates = gateResultsByExperiment.get(value.experimentId);
    if (gates) gates.push({ order, value });
    else gateResultsByExperiment.set(value.experimentId, [{ order, value }]);
  }
  type Lifecycle = NonNullable<typeof input.lifecycles>[number];
  const lifecyclesByExperiment = new Map<string, Array<{ order: number; value: Lifecycle }>>();
  for (const [order, value] of (input.lifecycles || []).entries()) {
    const lifecycles = lifecyclesByExperiment.get(value.experimentId);
    if (lifecycles) lifecycles.push({ order, value });
    else lifecyclesByExperiment.set(value.experimentId, [{ order, value }]);
  }
  const allKeys = new Set([...planKeys.keys(), ...resultKeys.keys()]);
  return Array.from(allKeys).map((key) => {
    const plannedItems = planKeys.get(key) || [];
    const records = resultKeys.get(key) || [];
    const missingMetrics = Array.from(new Set(records.flatMap((record) => config.requiredMetrics.filter((metric) => !record.metrics[metric]))));
    const gates = Array.from(new Set(records.map((record) => record.experimentId)))
      .flatMap((experimentId) => gateResultsByExperiment.get(experimentId) || [])
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.value);
    const lifecycle = Array.from(new Set(plannedItems.map((item) => String(item.experimentId))))
      .flatMap((experimentId) => lifecyclesByExperiment.get(experimentId) || [])
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.value);
    const status = completenessStatus(plannedItems, records, gates, lifecycle, missingMetrics, config.requireQualityGatePassed);
    return { key: parseKey(key), status, experimentIds: Array.from(new Set([...plannedItems.map((item) => String(item.experimentId)), ...records.map((record) => record.experimentId)])), resultIds: records.map((record) => record.resultId), missingMetrics, warnings: gates.filter((g) => g.status === "warning").map((g) => `${g.gateId}: warning`) };
  }).sort((a, b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)));
}

export function completenessMatrixToMarkdown(cells: CompletenessCell[]): string {
  const headers = ["Key", "Status", "Experiments", "Results", "Missing"];
  const rows = cells.map((cell) => [JSON.stringify(cell.key), cell.status, cell.experimentIds.join(";"), cell.resultIds.join(";"), (cell.missingMetrics || []).join(";")]);
  return [headers.join(" | "), headers.map(() => "---").join(" | "), ...rows.map((row) => row.join(" | "))].join("\n");
}

export function completenessMatrixToCsv(cells: CompletenessCell[]): string {
  return [["key", "status", "experimentIds", "resultIds", "missingMetrics"], ...cells.map((cell) => [JSON.stringify(cell.key), cell.status, cell.experimentIds.join(";"), cell.resultIds.join(";"), (cell.missingMetrics || []).join(";")])].map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function buildPreRunChecklist(plan: ExperimentPlanRecord, context: { planValidationStatus?: "ok" | "warning" | "failed"; datasetPathsOk?: boolean; splitFilesOk?: boolean; outputContractOk?: boolean; gpuAvailable?: boolean; diskEnough?: boolean; duplicateCompleted?: string[]; lockedResultIds?: string[]; resultParserPresetMissing?: boolean; resultSchemaMissing?: boolean; statisticalPlanMissing?: boolean }): PreRunChecklistResult {
  const items: PreRunChecklistResult["items"] = [
    item("plan_validation", "plan", context.planValidationStatus === "failed" ? "failed" : context.planValidationStatus === "warning" ? "warning" : "ok", `plan validation ${context.planValidationStatus || "ok"}`),
    item("dataset_paths", "dataset", context.datasetPathsOk === false ? "failed" : "ok", "dataset paths checked", "Fix dataset paths."),
    item("split_files", "dataset", context.splitFilesOk === false ? "failed" : "ok", "split files checked", "Create split files."),
    item("output_contract", "output_contract", context.outputContractOk === false ? "warning" : "ok", "output contract configured", "Select output contract."),
    item("gpu_available", "resource", context.gpuAvailable === false ? "warning" : "ok", "GPU availability checked"),
    item("disk_space", "resource", context.diskEnough === false ? "warning" : "ok", "disk space checked"),
    item("duplicates", "duplicate", context.duplicateCompleted?.length ? "warning" : "ok", `${context.duplicateCompleted?.length || 0} completed duplicates`),
    item("locked_results", "result", context.lockedResultIds?.length ? "warning" : "ok", `${context.lockedResultIds?.length || 0} locked/frozen results`),
    item("parser_preset", "result", context.resultParserPresetMissing ? "warning" : "ok", "result parser preset checked"),
    item("result_schema", "result", context.resultSchemaMissing ? "warning" : "ok", "result schema checked"),
    item("statistical_plan", "result", context.statisticalPlanMissing ? "warning" : "ok", "statistical plan checked"),
    item("small_scale_limit", "safety", plan.experimentCount > 10 ? "warning" : "ok", `experiment count=${plan.experimentCount}, small-scale concurrent cap=10`),
  ];
  return { planId: plan.planId, status: checklistStatus(items), checkedAt: new Date().toISOString(), items };
}

export function buildPostRunChecklist(record: ExperimentResultRecord, context: { files?: Record<string, string>; primaryMetric?: string; gate?: QualityGateResult; statisticsUpdated?: boolean; paperTableUpdated?: boolean; logText?: string }): PostRunChecklistResult {
  const files = context.files || {};
  const primary = context.primaryMetric || record.primaryMetric || "DSC";
  const log = context.logText || files["logs/train.log"] || files["train.log"] || "";
  const items: PostRunChecklistResult["items"] = [
    item("metrics_summary", "result_file", files["metrics_summary.csv"] ? "ok" : "warning", "metrics_summary.csv checked"),
    item("primary_metric", "metric", record.metrics[primary] ? "ok" : "failed", `primary metric ${primary} checked`),
    item("finite_metrics", "metric", Object.values(record.metrics).every((m) => Number.isFinite(Number(m.value))) ? "ok" : "failed", "finite metrics checked"),
    item("metrics_case", "case_level", files["metrics_case.csv"] ? "ok" : "warning", "metrics_case.csv checked"),
    item("checkpoint_manifest", "checkpoint", files["checkpoint_manifest.json"] ? "ok" : "warning", "checkpoint manifest checked"),
    item("train_log_errors", "log", /nan|oom|traceback/i.test(log) ? "warning" : "ok", "train log scanned"),
    item("quality_gate", "quality_gate", context.gate?.status === "failed" ? "failed" : context.gate?.status === "warning" ? "warning" : "ok", `quality gate ${context.gate?.status || "ok"}`),
    item("statistics_update", "statistics", context.statisticsUpdated === false ? "warning" : "ok", "statistics update checked"),
    item("paper_table_update", "paper_table", context.paperTableUpdated === false ? "warning" : "ok", "paper table update checked"),
  ];
  return { experimentId: record.experimentId, attemptId: record.attemptId, status: checklistStatus(items), checkedAt: new Date().toISOString(), items };
}

export function generateMissingOnlyRerunPlan(cells: CompletenessCell[], options: MissingRerunOptions): ExperimentPlanRecord {
  const selected = cells.filter((cell) => shouldRerunCell(cell, options));
  const suite = `missing_rerun_${Date.now()}`;
  const yaml = [
    `suite: ${JSON.stringify(suite)}`,
    "mode: train_test",
    "base_config: configs/base.yaml",
    `parent_plan_id: ${JSON.stringify(options.sourcePlanId || "")}`,
    `parent_study_id: ${JSON.stringify(options.sourceStudyId || "")}`,
    "cases:",
    ...selected.map((cell, index) => [
      `  - name: ${JSON.stringify(`rerun_${index}_${Object.values(cell.key).join("_")}`)}`,
      "    overrides:",
      ...Object.entries(cell.key).map(([key, value]) => `      ${key}: ${JSON.stringify(String(value))}`),
      `      attempt_id: ${JSON.stringify(options.generateNewAttemptId ? `rerun-${Date.now()}-${index}` : "")}`,
    ].join("\n")),
  ].join("\n") + "\n";
  const record = importLegacyPlanYamlToRegistry(`simple_cluster/plans/generated/${suite}.yaml`, yaml);
  record.source = { type: "cloned", generatedFrom: options.sourcePlanId || options.sourceStudyId };
  record.provenance.parentPlanId = options.sourcePlanId;
  record.provenance.parentRevisionId = options.completenessMatrixId;
  return record;
}

export function upsertManualReview(records: ManualReviewRecord[], review: Omit<ManualReviewRecord, "reviewedAt"> & { reviewedAt?: string }): ManualReviewRecord[] {
  const next = { ...review, reviewedAt: review.reviewedAt || new Date().toISOString() };
  const key = `${next.targetType}:${next.targetId}`;
  const map = new Map(records.map((item) => [`${item.targetType}:${item.targetId}`, item]));
  map.set(key, next);
  return Array.from(map.values());
}

export function filterByManualReview<T extends { resultId?: string; experimentId?: string }>(items: T[], reviews: ManualReviewRecord[], policy: "paper_ready_only" | "verified_or_ready" | "exclude_do_not_use" = "exclude_do_not_use"): T[] {
  const stateOf = (item: T) => reviews.find((r) => r.targetId === item.resultId || r.targetId === item.experimentId)?.state || "unreviewed";
  return items.filter((item) => {
    const state = stateOf(item);
    if (policy === "paper_ready_only") return state === "paper_ready";
    if (policy === "verified_or_ready") return state === "paper_ready" || state === "manual_verified";
    return state !== "do_not_use";
  });
}

export function createPaperFreeze(input: { studyId?: string; leaderboardIds?: string[]; paperTableIds?: string[]; resultIds?: string[]; statisticalResultIds?: string[]; configSnapshot?: PaperFreezeRecord["configSnapshot"]; label: string; notes?: string; markdown?: string; latex?: string }): PaperFreezeRecord {
  const base = { studyId: input.studyId, leaderboardIds: input.leaderboardIds || [], paperTableIds: input.paperTableIds || [], resultIds: input.resultIds || [], statisticalResultIds: input.statisticalResultIds || [], configSnapshot: input.configSnapshot || { parserPresetIds: [], inclusionPolicyIds: [], statisticalPlanIds: [], paperTableConfigIds: [] }, label: input.label, notes: input.notes };
  const sha = sha256(JSON.stringify({ ...base, markdown: input.markdown, latex: input.latex }));
  return { freezeId: `freeze_${sha.slice(0, 12)}`, ...base, createdAt: new Date().toISOString(), sha256: sha, frozenMarkdown: input.markdown, frozenLatex: input.latex };
}

export function compareFreezeToCurrent(freeze: PaperFreezeRecord, current: { resultIds?: string[]; statisticalResultIds?: string[]; markdown?: string; latex?: string }): { changed: boolean; differences: string[] } {
  const differences: string[] = [];
  if (current.resultIds && setDiff(freeze.resultIds, current.resultIds)) differences.push("resultIds changed");
  if (current.statisticalResultIds && setDiff(freeze.statisticalResultIds, current.statisticalResultIds)) differences.push("statisticalResultIds changed");
  if (current.markdown !== undefined && current.markdown !== freeze.frozenMarkdown) differences.push("markdown changed");
  if (current.latex !== undefined && current.latex !== freeze.frozenLatex) differences.push("latex changed");
  return { changed: differences.length > 0, differences };
}

export function buildSmallScaleReport(config: SmallScaleExperimentReportConfig, input: { plans?: ExperimentPlanRecord[]; results?: ExperimentResultRecord[]; cells?: CompletenessCell[]; preRun?: PreRunChecklistResult[]; postRun?: PostRunChecklistResult[]; gates?: QualityGateResult[]; stats?: StatisticalTestResult[]; reviews?: ManualReviewRecord[] }): { markdown: string; json: string; csv: string } {
  const plans = input.plans || [];
  const results = input.results || [];
  const cells = input.cells || [];
  const failed = cells.filter((cell) => ["quality_failed", "parse_failed"].includes(cell.status));
  const missing = cells.filter((cell) => ["not_planned", "planned", "completed_no_result"].includes(cell.status) || (cell.missingMetrics || []).length);
  const lines: string[] = [`# Small-scale Experiment Report`, "", `scope=${JSON.stringify(config.scope)}`, ""];
  if (config.sections.includes("overview")) lines.push("## Overview", `plans=${plans.length}`, `results=${results.length}`, `complete=${cells.filter((c) => c.status === "ready_for_analysis").length}`, "");
  if (config.sections.includes("completeness")) lines.push("## Completeness", completenessMatrixToMarkdown(cells), "");
  if (config.sections.includes("pre_run_checklist")) lines.push("## Pre-run Checklist", ...((input.preRun || []).map((r) => `- ${r.planId}: ${r.status}`)), "");
  if (config.sections.includes("post_run_checklist")) lines.push("## Post-run Checklist", ...((input.postRun || []).map((r) => `- ${r.experimentId}: ${r.status}`)), "");
  if (config.sections.includes("quality_gate")) lines.push("## Quality Gate", ...((input.gates || []).map((g) => `- ${g.experimentId}: ${g.status}`)), "");
  if (config.sections.includes("statistics")) lines.push("## Statistics", ...((input.stats || []).map((s) => `- ${s.metric} ${s.methodA} vs ${s.methodB}: p=${s.adjustedPValue ?? s.pValue ?? "NA"}`)), "");
  if (config.sections.includes("missing_items")) lines.push("## Missing Items", ...missing.map((cell) => `- ${JSON.stringify(cell.key)}: ${cell.status} ${(cell.missingMetrics || []).join(",")}`), "");
  if (config.sections.includes("failed_experiments")) lines.push("## Failed Experiments", ...failed.map((cell) => `- ${JSON.stringify(cell.key)}: ${cell.status}`), "");
  if (config.sections.includes("manual_review")) lines.push("## Manual Review", ...((input.reviews || []).map((r) => `- ${r.targetType}:${r.targetId}: ${r.state}`)), "");
  if (config.sections.includes("next_actions")) lines.push("## Next Actions", missing.length ? "- Generate missing-only rerun plan." : "- Freeze paper results.", failed.length ? "- Inspect failed or suspect results." : "- Review paper-ready results.", "");
  const summary = { plans: plans.length, results: results.length, missing: missing.length, failed: failed.length, ready: cells.filter((c) => c.status === "ready_for_analysis").length };
  const csv = [["metric", "value"], ...Object.entries(summary)].map((row) => row.map(csvEscape).join(",")).join("\n");
  return { markdown: lines.join("\n"), json: JSON.stringify({ config, summary, cells, preRun: input.preRun, postRun: input.postRun }, null, 2), csv };
}

export function buildOutputCapabilityMatrix(report: ContractCheckResult): OutputCapability[] {
  const missingFileIds = new Set<string>();
  for (const file of report.files) {
    if (file.status !== "found") missingFileIds.add(file.specId);
  }
  const missingColumnNames = new Set<string>();
  for (const column of report.columns) {
    if (column.status === "missing") missingColumnNames.add(column.column);
  }
  const cap = (capability: OutputCapability["capability"], requiredFiles: string[], requiredColumns: string[], message: string, suggestion: string): OutputCapability => {
    const mf = requiredFiles.filter((id) => missingFileIds.has(id));
    const mc = requiredColumns.filter((column) => missingColumnNames.has(column));
    return { capability, status: mf.length || mc.length ? mf.length === requiredFiles.length || mc.length === requiredColumns.length ? "unavailable" : "partial" : "available", requiredFiles, requiredColumns, missingFiles: mf, missingColumns: mc, message, suggestion };
  };
  return [
    cap("summary_metrics", ["metrics_summary"], ["metric", "value"], "Summary metrics power result parsing.", "Write metrics_summary.csv with metric/value columns."),
    cap("leaderboard", ["metrics_summary"], ["method", "dataset", "metric", "value"], "Leaderboard requires method/dataset metrics.", "Add method, dataset, metric and value columns."),
    cap("paper_table", ["metrics_summary"], ["method", "dataset", "seed", "metric", "value"], "Paper table requires grouped metrics.", "Add seed and method metadata."),
    cap("quality_gate", ["metrics_summary", "env_snapshot"], ["split", "seed", "metric", "value"], "Quality gate checks result integrity.", "Add env_snapshot.json and split/seed columns."),
    cap("paired_statistics", ["metrics_summary"], ["seed", "dataset", "metric", "value"], "Paired statistics need pairing keys.", "Add seed/fold/case_id or patient_id."),
    cap("case_level_analysis", ["metrics_case"], ["case_id", "metric", "value"], "Case-level analysis requires metrics_case.csv.", "Write metrics_case.csv with case_id."),
    cap("subgroup_analysis", ["metrics_case"], ["case_id", "subgroup"], "Subgroup analysis needs case-level subgroup fields.", "Add subgroup columns such as sex/age_group/missing_rate."),
    cap("patient_leakage_check", ["metrics_case"], ["patient_id", "split"], "Patient leakage check needs patient_id and split.", "Add patient_id to metrics_case.csv."),
    cap("checkpoint_management", ["checkpoint_manifest"], [], "Checkpoint management needs checkpoint manifest.", "Write checkpoint_manifest.json."),
    cap("training_curve", ["training_curve"], ["epoch", "metric", "value"], "Training curve needs per-epoch values.", "Write training_curve.csv."),
    cap("environment_reproducibility", ["env_snapshot"], ["git_commit"], "Environment reproducibility needs env snapshot.", "Write env_snapshot.json with git_commit."),
  ];
}

function completenessStatus(plannedItems: Array<{ status?: string }>, records: ExperimentResultRecord[], gates: QualityGateResult[], lifecycle: Array<{ status?: string; state?: string }>, missingMetrics: string[], requireGate: boolean): CompletenessCell["status"] {
  if (!plannedItems.length && !records.length) return "not_planned";
  if (records.some((record) => record.status === "excluded")) return "excluded";
  if (records.some((record) => record.status === "parse_failed")) return "parse_failed";
  if (gates.some((gate) => gate.status === "failed")) return "quality_failed";
  if (records.length && missingMetrics.length) return "result_available";
  if (records.length && (!requireGate || gates.every((gate) => gate.status === "passed"))) return "ready_for_analysis";
  if (records.length) return "result_available";
  if (lifecycle.some((item) => ["completed", "archived"].includes(String(item.status || item.state)))) return "completed_no_result";
  if (lifecycle.some((item) => ["running"].includes(String(item.status || item.state))) || plannedItems.some((item) => item.status === "running")) return "running";
  if (plannedItems.some((item) => item.status === "queued")) return "queued";
  return "planned";
}

function shouldRerunCell(cell: CompletenessCell, options: MissingRerunOptions): boolean {
  if (options.missingTypes.includes(cell.status as any)) return true;
  if (options.missingTypes.includes("missing_primary_metric") && (cell.missingMetrics || []).length) return true;
  return false;
}

function dimsFromRun(runKey: string): Record<string, string> {
  const text = runKey.toLowerCase();
  const out: Record<string, string> = {};
  for (const key of ["method", "dataset", "split", "fold", "seed", "missing_rate", "noise_level"]) {
    const match = text.match(new RegExp(`${key}[-_:]([^_:/]+)`));
    if (match) out[key] = match[1];
  }
  return out;
}

function keyFor(axes: CompletenessMatrixConfig["axes"], values: Record<string, unknown>): string {
  return axes.map((axis) => `${axis}=${String(values[axis] ?? "")}`).join("|");
}

function parseKey(key: string): Record<string, string> {
  return Object.fromEntries(key.split("|").map((part) => {
    const [k, ...rest] = part.split("=");
    return [k, rest.join("=")];
  }));
}

function item<T extends string>(id: string, category: T, status: "ok" | "warning" | "failed" | "skipped", message: string, suggestion?: string): { id: string; category: T; status: "ok" | "warning" | "failed" | "skipped"; message: string; suggestion?: string } {
  return { id, category, status, message, suggestion };
}

function checklistStatus(items: Array<{ status: string }>): "ok" | "warning" | "failed" {
  if (items.some((i) => i.status === "failed")) return "failed";
  if (items.some((i) => i.status === "warning")) return "warning";
  return "ok";
}

function setDiff(a: string[], b: string[]): boolean {
  return a.length !== b.length || a.some((item) => !b.includes(item));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
