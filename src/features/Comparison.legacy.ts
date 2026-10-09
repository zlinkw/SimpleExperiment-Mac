import { createHash } from "crypto";
import { ExperimentResultRecord } from "./Results";
import { ExperimentPlanRecord, PlanBuildResult, expandPlanMatrix, importLegacyPlanYamlToRegistry } from "./PlanBuilder";

export const COMPARISON_REGISTRY_PATH = "simple_cluster/comparisons/comparison_registry.json";
export const COMPARISON_STUDY_DIR = "simple_cluster/comparisons/studies";
export const COMPARISON_PROTOCOL_DIR = "simple_cluster/comparisons/protocols";
export const COMPARISON_EXPORT_DIR = "simple_cluster/comparisons/exports";

export interface ExperimentComparisonReport {
  comparedExperimentIds: string[];
  configDiffs: Array<{ key: string; values: Record<string, unknown> }>;
  metricDiffs: Array<{ metric: string; values: Record<string, number | string> }>;
  runtimeDiffs: Record<string, unknown>;
  generatedAt: string;
}

export interface PaperReference {
  title?: string;
  url?: string;
  venue?: string;
  year?: number;
}

export interface ComparisonDataset {
  datasetId: string;
  name: string;
  version?: string;
  preprocessing?: string;
  tags?: string[];
}

export interface ComparisonSplit {
  splitId: string;
  name: string;
  seed?: string | number;
  file?: string;
}

export interface FairnessConstraint {
  id: string;
  field: string;
  expected?: unknown;
  required: boolean;
  message: string;
  accepted?: boolean;
  acceptanceReason?: string;
}

export interface ComparisonMethod {
  methodId: string;
  name: string;
  role: "ours" | "baseline" | "reproduced" | "ablation" | "upper_bound" | "oracle" | "reference";
  description?: string;
  implementation: {
    type: "local_config" | "external_repo" | "paper_only" | "manual_result" | "existing_plan";
    repoUrl?: string;
    commit?: string;
    configPath?: string;
    planId?: string;
    commandTemplate?: string;
  };
  expectedInputs?: { image?: boolean; table?: boolean; missingModality?: boolean; noise?: boolean };
  tags?: string[];
}

export interface ComparisonStudyRecord {
  schemaVersion: 1;
  studyId: string;
  name: string;
  description?: string;
  status: "draft" | "protocol_ready" | "planned" | "running" | "completed" | "partially_completed" | "analysis_ready" | "reported" | "deprecated";
  taskType: "classification" | "segmentation" | "detection" | "regression" | "multimodal_diagnosis" | "custom";
  comparisonType: "baseline_comparison" | "paper_reproduction" | "ablation" | "cross_dataset" | "robustness" | "missing_modality" | "noise_robustness" | "custom";
  protocolId?: string;
  resultSchemaId?: string;
  planSchemaId?: string;
  methods: ComparisonMethod[];
  datasets: ComparisonDataset[];
  seeds: Array<string | number>;
  splits: ComparisonSplit[];
  fairnessConstraints: FairnessConstraint[];
  plannedPlanIds: string[];
  linkedResultIds: string[];
  primaryMetrics: string[];
  secondaryMetrics?: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  tags?: string[];
  notes?: string;
  provenance: { sourcePaper?: PaperReference; parentStudyId?: string; relatedPlanIds?: string[]; relatedLeaderboardIds?: string[] };
}

export interface ComparisonProtocol {
  schemaVersion: 1;
  protocolId: string;
  name: string;
  description?: string;
  taskType: string;
  requiredDatasets: string[];
  requiredSplits: string[];
  requiredSeeds: Array<string | number>;
  sharedSettings: {
    sameDataSplit: boolean;
    samePreprocessing: boolean;
    sameAugmentation?: boolean;
    sameTrainingEpochs?: boolean;
    sameOptimizer?: boolean;
    sameLrSchedule?: boolean;
    sameBatchSize?: boolean;
    sameInputResolution?: boolean;
    sameEvaluationScript: boolean;
    sameMetricDefinition: boolean;
  };
  resourcePolicy?: { sameGpuType?: boolean; maxGpuHoursPerMethod?: number; maxWallTimeHoursPerMethod?: number; maxParams?: number; reportTrainingCost?: boolean };
  allowedDifferences?: Array<{ field: string; reason: string; mustReport: boolean }>;
  metrics: Array<{ key: string; primary?: boolean; higherIsBetter: boolean; decimals?: number }>;
  statisticalTest?: { enabled: boolean; pairedBy: Array<"seed" | "fold" | "dataset" | "case">; method: "paired_t_test" | "wilcoxon" | "bootstrap_ci" | "permutation_test"; alpha: number };
}

export interface ComparisonTemplate {
  id: string;
  name: string;
  protocol: ComparisonProtocol;
  metrics: string[];
  planMatrix: Record<string, unknown>;
  resultSchemaId?: string;
  leaderboardId?: string;
  paperTableId?: string;
  reportSections: ComparisonReportConfig["sections"];
}

export interface ReproductionDeviation {
  id: string;
  severity: "minor" | "moderate" | "major";
  category: "dataset" | "preprocessing" | "model" | "training" | "evaluation" | "hardware" | "missing_detail" | "code_unavailable" | "other";
  description: string;
  reason: string;
  expectedImpact?: string;
  reportedInPaperTable?: boolean;
}

export interface ReproductionChecklistItem {
  id: string;
  label: string;
  status: "unchecked" | "matched" | "deviated" | "not_applicable";
  notes?: string;
}

export interface ReproductionRecord {
  schemaVersion: 1;
  reproductionId: string;
  studyId: string;
  methodId: string;
  target: {
    paperTitle?: string;
    paperUrl?: string;
    venue?: string;
    year?: number;
    officialCodeUrl?: string;
    officialCheckpointUrl?: string;
    reportedMetrics?: Record<string, number | string>;
  };
  implementationStatus: "not_started" | "code_available" | "code_adapted" | "reimplemented" | "manual_result_only" | "failed";
  deviations: ReproductionDeviation[];
  checklist: ReproductionChecklistItem[];
  notes?: string;
}

export interface ComparisonPlanGenerationOptions {
  studyId: string;
  methods: string[];
  datasets: string[];
  seeds: Array<string | number>;
  splits: string[];
  templateId?: string;
  skipExistingCompleted: boolean;
  skipExistingRunning: boolean;
  createSeparatePlanPerMethod?: boolean;
  createSeparatePlanPerDataset?: boolean;
}

export interface FairnessCheckResult {
  studyId: string;
  status: "ok" | "warning" | "failed";
  issues: Array<{ id: string; severity: "info" | "warning" | "critical"; methodId?: string; experimentId?: string; category: string; message: string; suggestion?: string; accepted?: boolean; acceptanceReason?: string }>;
}

export interface LeaderboardRow {
  methodId: string;
  dataset?: string;
  count: number;
  metrics: Record<string, { mean?: number; std?: number; raw?: number[] }>;
}

export interface ComparisonAnalysisResult {
  studyId: string;
  generatedAt: string;
  leaderboard: LeaderboardRow[];
  baselineImprovements: Array<{ methodId: string; baselineMethodId: string; metric: string; absoluteDiff: number; relativeDiffPercent: number; higherIsBetter: boolean }>;
  significance?: Array<{ metric: string; methodA: string; methodB: string; test: string; pValue: number; significant: boolean }>;
  reproductionGap?: Array<{ methodId: string; metric: string; reportedValue: number; reproducedValue: number; gap: number; explanation?: string }>;
  warnings: string[];
}

export interface ComparisonReportConfig {
  id: string;
  studyId: string;
  sections: Array<"overview" | "protocol" | "methods" | "datasets" | "fairness" | "deviations" | "main_table" | "ablation_table" | "robustness" | "statistics" | "reproduction_gap" | "failures" | "notes">;
  exportFormats: Array<"markdown" | "json" | "csv" | "latex">;
  includeAcceptedWarnings: boolean;
  includeFailedExperiments: boolean;
}

export interface ManualComparisonResult {
  studyId: string;
  methodId: string;
  dataset: string;
  split?: string;
  seed?: string | number;
  metric: string;
  value: number | string;
  source: "paper" | "external_csv" | "manual";
  citation?: string;
  notes?: string;
  includeInFairStats?: boolean;
}

export const builtInComparisonProtocols: ComparisonProtocol[] = [
  protocol("medical_segmentation_fair", "Medical segmentation fair comparison", "segmentation", ["DSC", "ASD", "HD95"]),
  protocol("classification_fair", "Classification fair comparison", "classification", ["accuracy", "AUC", "F1"]),
  protocol("paper_reproduction_basic", "Paper reproduction basic", "custom", ["primary"]),
];

export const builtInComparisonTemplates: ComparisonTemplate[] = [
  comparisonTemplate("medical_segmentation_baseline_comparison", "Medical segmentation baseline comparison", builtInComparisonProtocols[0]),
  comparisonTemplate("medical_segmentation_ablation", "Medical segmentation ablation", builtInComparisonProtocols[0]),
  comparisonTemplate("multimodal_missing_modality_comparison", "Multimodal missing modality comparison", builtInComparisonProtocols[0]),
  comparisonTemplate("multimodal_noisy_clinical_data_comparison", "Multimodal noisy clinical data comparison", builtInComparisonProtocols[0]),
  comparisonTemplate("cross_dataset_generalization", "Cross dataset generalization", builtInComparisonProtocols[0]),
  comparisonTemplate("paper_reproduction_basic", "Paper reproduction basic", builtInComparisonProtocols[2]),
  comparisonTemplate("paper_reproduction_with_deviation_log", "Paper reproduction with deviation log", builtInComparisonProtocols[2]),
  comparisonTemplate("robustness_missing_rate_curve", "Robustness missing rate curve", builtInComparisonProtocols[0]),
  comparisonTemplate("robustness_noise_level_curve", "Robustness noise level curve", builtInComparisonProtocols[0]),
];

export const defaultReproductionChecklist: ReproductionChecklistItem[] = [
  "official code checked",
  "official checkpoint checked",
  "dataset version matched",
  "split matched",
  "preprocessing matched",
  "metric definition matched",
  "training epochs matched",
  "optimizer matched",
  "lr schedule matched",
  "input resolution matched",
  "random seeds matched",
  "hardware difference recorded",
  "missing implementation details recorded",
].map((label) => ({ id: slug(label), label, status: "unchecked" as const }));

export interface ComparableExperiment {
  experimentId: string;
  config?: Record<string, unknown>;
  metrics?: Record<string, number>;
  runtime?: Record<string, unknown>;
}

export function compareExperiments(experiments: ComparableExperiment[]): ExperimentComparisonReport {
  const ids = experiments.map((item) => item.experimentId);
  return {
    comparedExperimentIds: ids,
    configDiffs: diffObjects(experiments, "config", "key"),
    metricDiffs: diffObjects(experiments, "metrics", "metric") as Array<{ metric: string; values: Record<string, number | string> }>,
    runtimeDiffs: Object.fromEntries(diffObjects(experiments, "runtime", "key").map((item) => [item.key, item.values])),
    generatedAt: new Date().toISOString(),
  };
}

export function comparisonToMarkdown(report: ExperimentComparisonReport): string {
  const ids = report.comparedExperimentIds;
  const section = (title: string, rows: Array<{ key?: string; metric?: string; values: Record<string, unknown> }>) => [
    `## ${title}`,
    ["Field", ...ids].join(" | "),
    ["---", ...ids.map(() => "---")].join(" | "),
    ...rows.map((row) => [row.key || row.metric || "", ...ids.map((id) => JSON.stringify(row.values[id] ?? ""))].join(" | ")),
  ].join("\n");
  return [`# Experiment Comparison`, `Generated: ${report.generatedAt}`, section("Config", report.configDiffs), section("Metrics", report.metricDiffs)].join("\n\n");
}

export function createComparisonStudy(input: Partial<ComparisonStudyRecord> & { name: string; taskType: ComparisonStudyRecord["taskType"]; comparisonType: ComparisonStudyRecord["comparisonType"] }): ComparisonStudyRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    studyId: input.studyId || `study_${sha256(`${input.name}:${now}`).slice(0, 12)}`,
    name: input.name,
    description: input.description,
    status: input.status || "draft",
    taskType: input.taskType,
    comparisonType: input.comparisonType,
    protocolId: input.protocolId,
    resultSchemaId: input.resultSchemaId,
    planSchemaId: input.planSchemaId,
    methods: input.methods || [],
    datasets: input.datasets || [],
    seeds: input.seeds || [],
    splits: input.splits || [],
    fairnessConstraints: input.fairnessConstraints || [],
    plannedPlanIds: input.plannedPlanIds || [],
    linkedResultIds: input.linkedResultIds || [],
    primaryMetrics: input.primaryMetrics || [],
    secondaryMetrics: input.secondaryMetrics,
    createdAt: input.createdAt || now,
    updatedAt: now,
    completedAt: input.completedAt,
    tags: input.tags,
    notes: input.notes,
    provenance: input.provenance || {},
  };
}

export function upsertComparisonStudies(existing: ComparisonStudyRecord[], incoming: ComparisonStudyRecord[]): ComparisonStudyRecord[] {
  const map = new Map(existing.map((item) => [item.studyId, item]));
  for (const record of incoming) {
    const prev = map.get(record.studyId);
    map.set(record.studyId, prev ? { ...prev, ...record, createdAt: prev.createdAt, updatedAt: new Date().toISOString() } : record);
  }
  return Array.from(map.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deprecateComparisonStudy(study: ComparisonStudyRecord, reason = "deprecated"): ComparisonStudyRecord {
  return { ...study, status: "deprecated", notes: [study.notes, reason].filter(Boolean).join("\n"), updatedAt: new Date().toISOString() };
}

export function addComparisonMethod(study: ComparisonStudyRecord, method: ComparisonMethod): ComparisonStudyRecord {
  const methods = [...study.methods.filter((item) => item.methodId !== method.methodId), method];
  return { ...study, methods, updatedAt: new Date().toISOString() };
}

export function validateComparisonProtocol(study: ComparisonStudyRecord, protocol: ComparisonProtocol): FairnessCheckResult {
  const issues: FairnessCheckResult["issues"] = [];
  for (const dataset of protocol.requiredDatasets) if (!study.datasets.some((item) => item.datasetId === dataset || item.name === dataset)) issues.push(fairIssue("dataset_missing", "critical", "dataset", `Required dataset missing: ${dataset}`, "Add dataset or change protocol."));
  for (const split of protocol.requiredSplits) if (!study.splits.some((item) => item.splitId === split || item.name === split)) issues.push(fairIssue("split_missing", "critical", "split", `Required split missing: ${split}`, "Add split or change protocol."));
  for (const seed of protocol.requiredSeeds) if (!study.seeds.map(String).includes(String(seed))) issues.push(fairIssue("seed_missing", "warning", "seed", `Required seed missing: ${seed}`, "Add seed for fair comparison."));
  for (const metric of protocol.metrics.filter((item) => item.primary)) if (!study.primaryMetrics.includes(metric.key)) issues.push(fairIssue("primary_metric_missing", "warning", "metric", `Primary metric not linked to study: ${metric.key}`));
  return { studyId: study.studyId, status: severityStatus(issues), issues };
}

export function createReproductionRecord(studyId: string, methodId: string, target: ReproductionRecord["target"] = {}): ReproductionRecord {
  return { schemaVersion: 1, reproductionId: `repr_${sha256(`${studyId}:${methodId}`).slice(0, 12)}`, studyId, methodId, target, implementationStatus: "not_started", deviations: [], checklist: defaultReproductionChecklist.map((item) => ({ ...item })) };
}

export function updateReproductionChecklist(record: ReproductionRecord, itemId: string, status: ReproductionChecklistItem["status"], notes?: string): ReproductionRecord {
  return { ...record, checklist: record.checklist.map((item) => item.id === itemId ? { ...item, status, notes } : item) };
}

export function addReproductionDeviation(record: ReproductionRecord, deviation: Omit<ReproductionDeviation, "id"> & { id?: string }): ReproductionRecord {
  const item = { ...deviation, id: deviation.id || `dev_${sha256(`${record.reproductionId}:${deviation.description}`).slice(0, 10)}` };
  return { ...record, deviations: [...record.deviations.filter((existing) => existing.id !== item.id), item] };
}

export function generateComparisonPlans(study: ComparisonStudyRecord, options: ComparisonPlanGenerationOptions, existing: Array<{ experimentKey?: string; runKey?: string; status?: string }> = []): { dryRun: PlanBuildResult; plans: ExperimentPlanRecord[]; protocolIssues: FairnessCheckResult["issues"] } {
  const selectedMethods = study.methods.filter((method) => options.methods.includes(method.methodId));
  const existingKeys = existing.filter((item) => !(options.skipExistingCompleted && item.status === "completed") && !(options.skipExistingRunning && item.status === "running")).map((item) => item.runKey || item.experimentKey || "");
  const matrix = {
    variables: [
      { key: "methodId", mode: "grid" as const, values: selectedMethods.map((item) => item.methodId) },
      { key: "dataset", mode: "grid" as const, values: options.datasets },
      { key: "seed", mode: "grid" as const, values: options.seeds },
      { key: "split", mode: "grid" as const, values: options.splits },
      { key: "comparisonStudyId", mode: "fixed" as const, values: [study.studyId] },
      { key: "protocolId", mode: "fixed" as const, values: [study.protocolId || ""] },
    ],
    namingRule: { pattern: "{{suite}}_{{methodId}}_{{dataset}}_{{split}}_seed{{seed}}", sanitize: true },
  };
  const dryRun = expandPlanMatrix(matrix, existingKeys, study.name);
  const groups = groupGeneratedExperiments(dryRun, options);
  const plans = groups.map(([name, experiments]) => {
    const yaml = renderComparisonPlanYaml(study, name, experiments);
    return importLegacyPlanYamlToRegistry(`simple_cluster/plans/generated/${name}.yaml`, yaml);
  });
  return { dryRun, plans, protocolIssues: [] };
}

export function checkFairness(study: ComparisonStudyRecord, protocol: ComparisonProtocol, records: ExperimentResultRecord[] = [], reproductions: ReproductionRecord[] = []): FairnessCheckResult {
  const issues = [...validateComparisonProtocol(study, protocol).issues];
  const byMethod = new Map<string, ExperimentResultRecord[]>();
  for (const record of records) {
    const methodId = String(record.dimensions.methodId || record.dimensions.method || "");
    if (methodId) byMethod.set(methodId, [...(byMethod.get(methodId) || []), record]);
  }
  for (const method of study.methods) {
    const methodRecords = byMethod.get(method.methodId) || [];
    if (method.implementation.type === "manual_result") issues.push(fairIssue("manual_result", "warning", "manual_result", `Manual result used: ${method.methodId}`, "Do not mix with fair local stats unless explicitly allowed.", method.methodId));
    if (protocol.sharedSettings.sameDataSplit && methodRecords.some((record) => !record.dimensions.split)) issues.push(fairIssue("split_unknown", "warning", "split", `Split unknown for ${method.methodId}`, "Record split for every result.", method.methodId));
    if (protocol.sharedSettings.sameMetricDefinition && protocol.metrics.some((metric) => methodRecords.some((record) => !record.metrics[metric.key]))) issues.push(fairIssue("metric_missing", "warning", "metric", `Protocol metric missing for ${method.methodId}`, "Parse or import missing metric.", method.methodId));
  }
  for (const reproduction of reproductions) {
    for (const deviation of reproduction.deviations) {
      issues.push(fairIssue(`deviation_${deviation.id}`, deviation.severity === "major" ? "critical" : "warning", deviation.category, `${reproduction.methodId}: ${deviation.description}`, deviation.reportedInPaperTable ? undefined : "Report deviation in comparison report.", reproduction.methodId));
    }
  }
  for (const constraint of study.fairnessConstraints.filter((item) => item.required && !item.accepted)) {
    issues.push({ id: constraint.id, severity: "warning", category: constraint.field, message: constraint.message, accepted: constraint.accepted, acceptanceReason: constraint.acceptanceReason });
  }
  return { studyId: study.studyId, status: severityStatus(issues), issues };
}

export function analyzeComparisonResults(study: ComparisonStudyRecord, protocol: ComparisonProtocol, records: ExperimentResultRecord[] = [], manualResults: ManualComparisonResult[] = [], reproductions: ReproductionRecord[] = []): ComparisonAnalysisResult {
  const resultRows = resultValues(study, records, manualResults.filter((item) => item.includeInFairStats));
  const leaderboard = buildComparisonLeaderboard(resultRows, protocol);
  const baseline = study.methods.find((item) => item.role === "baseline")?.methodId || study.methods[0]?.methodId || "";
  const baselineImprovements = improvementRows(leaderboard, protocol, baseline);
  const significance = protocol.statisticalTest?.enabled ? significanceRows(resultRows, protocol, baseline) : undefined;
  const reproductionGap = reproductionGapRows(reproductions, resultRows);
  return { studyId: study.studyId, generatedAt: new Date().toISOString(), leaderboard, baselineImprovements, significance, reproductionGap, warnings: manualResults.filter((item) => !item.includeInFairStats).map((item) => `manual result excluded from fair stats: ${item.methodId}:${item.metric}`) };
}

export function exportComparisonReport(study: ComparisonStudyRecord, protocol: ComparisonProtocol, analysis: ComparisonAnalysisResult, fairness: FairnessCheckResult, reproductions: ReproductionRecord[], config: ComparisonReportConfig, format: "markdown" | "json" | "csv" | "latex" = "markdown"): string {
  const snapshot = { config, exportedAt: new Date().toISOString() };
  if (format === "json") return JSON.stringify({ study, protocol, analysis, fairness, reproductions, snapshot }, null, 2);
  if (format === "csv") return comparisonAnalysisCsv(analysis);
  if (format === "latex") return comparisonLatexTable(analysis, protocol);
  const lines: string[] = [`# ${study.name}`, "", `status: ${study.status}`, `task: ${study.taskType}`, `comparison: ${study.comparisonType}`, ""];
  if (config.sections.includes("protocol")) lines.push("## Protocol", protocol.name, ...protocol.metrics.map((metric) => `- ${metric.key}${metric.primary ? " (primary)" : ""}`), "");
  if (config.sections.includes("methods")) lines.push("## Methods", ...study.methods.map((method) => `- ${method.methodId}: ${method.name} (${method.role})`), "");
  if (config.sections.includes("datasets")) lines.push("## Datasets", ...study.datasets.map((dataset) => `- ${dataset.name}${dataset.version ? ` ${dataset.version}` : ""}`), "");
  if (config.sections.includes("fairness")) lines.push("## Fairness Check", `status: ${fairness.status}`, ...fairness.issues.filter((issue) => config.includeAcceptedWarnings || !issue.accepted).map((issue) => `- [${issue.severity}] ${issue.category}: ${issue.message}`), "");
  if (config.sections.includes("deviations")) lines.push("## Reproduction Deviations", ...reproductions.flatMap((record) => record.deviations.map((dev) => `- ${record.methodId} [${dev.severity}] ${dev.category}: ${dev.description}`)), "");
  if (config.sections.includes("main_table")) lines.push("## Main Results", comparisonMarkdownTable(analysis, protocol), "");
  if (config.sections.includes("statistics") && analysis.significance?.length) lines.push("## Statistical Test", ...analysis.significance.map((item) => `- ${item.metric} ${item.methodA} vs ${item.methodB}: p=${item.pValue.toFixed(4)} significant=${item.significant}`), "");
  if (config.sections.includes("reproduction_gap") && analysis.reproductionGap?.length) lines.push("## Reproduction Gap", ...analysis.reproductionGap.map((item) => `- ${item.methodId} ${item.metric}: reported=${item.reportedValue}, reproduced=${item.reproducedValue}, gap=${item.gap}`), "");
  if (config.sections.includes("notes") && study.notes) lines.push("## Notes", study.notes);
  lines.push("", `<!-- comparison_report_config=${JSON.stringify(snapshot)} -->`);
  return lines.join("\n");
}

export function manualResultToRecord(result: ManualComparisonResult): ExperimentResultRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    resultId: `manual:${result.studyId}:${result.methodId}:${result.dataset}:${result.metric}:${result.seed || ""}`,
    experimentId: `manual:${result.studyId}:${result.methodId}:${result.dataset}:${result.seed || ""}`,
    runKey: `manual:${result.methodId}:${result.dataset}`,
    suite: result.studyId,
    experimentName: `${result.methodId} ${result.dataset}`,
    status: "parsed",
    sourceFiles: [{ path: result.citation || result.source, type: "manual", endpoint: "local" }],
    metrics: { [result.metric]: { value: result.value, dataset: result.dataset, split: result.split, seed: result.seed } },
    dimensions: { methodId: result.methodId, dataset: result.dataset, split: result.split || "", seed: result.seed || "", source: result.source },
    createdAt: now,
    updatedAt: now,
    provenance: {},
    notes: result.notes,
  };
}

function diffObjects(experiments: ComparableExperiment[], field: "config" | "metrics" | "runtime", label: "key" | "metric"): any[] {
  const keys = Array.from(new Set(experiments.flatMap((item) => Object.keys((item as any)[field] || {}))));
  return keys.flatMap((key) => {
    const values = Object.fromEntries(experiments.map((item) => [item.experimentId, (item as any)[field]?.[key]]));
    return new Set(Object.values(values).map((value) => JSON.stringify(value))).size > 1 ? [{ [label]: key, values }] : [];
  });
}

function protocol(protocolId: string, name: string, taskType: string, metrics: string[]): ComparisonProtocol {
  return {
    schemaVersion: 1,
    protocolId,
    name,
    taskType,
    requiredDatasets: [],
    requiredSplits: ["test"],
    requiredSeeds: [1, 2, 3],
    sharedSettings: { sameDataSplit: true, samePreprocessing: true, sameEvaluationScript: true, sameMetricDefinition: true, sameTrainingEpochs: true, sameOptimizer: false, sameBatchSize: false, sameInputResolution: true },
    resourcePolicy: { sameGpuType: false, reportTrainingCost: true },
    allowedDifferences: [],
    metrics: metrics.map((key, index) => ({ key, primary: index === 0, higherIsBetter: !["ASD", "HD95", "loss", "MAE", "MSE"].includes(key), decimals: key === "DSC" || key === "accuracy" || key === "AUC" ? 3 : 2 })),
    statisticalTest: { enabled: true, pairedBy: ["seed", "dataset"], method: "paired_t_test", alpha: 0.05 },
  };
}

function comparisonTemplate(id: string, name: string, protocolValue: ComparisonProtocol): ComparisonTemplate {
  return {
    id,
    name,
    protocol: protocolValue,
    metrics: protocolValue.metrics.map((item) => item.key),
    planMatrix: { methods: ["ours", "baseline"], datasets: [], seeds: protocolValue.requiredSeeds, splits: protocolValue.requiredSplits },
    resultSchemaId: protocolValue.taskType === "segmentation" ? "medical_segmentation" : "classification",
    leaderboardId: `${id}_leaderboard`,
    paperTableId: `${id}_table`,
    reportSections: ["overview", "protocol", "methods", "datasets", "fairness", "deviations", "main_table", "statistics", "reproduction_gap", "notes"],
  };
}

function fairIssue(id: string, severity: FairnessCheckResult["issues"][number]["severity"], category: string, message: string, suggestion?: string, methodId?: string): FairnessCheckResult["issues"][number] {
  return { id, severity, methodId, category, message, suggestion };
}

function severityStatus(issues: FairnessCheckResult["issues"]): FairnessCheckResult["status"] {
  if (issues.some((item) => item.severity === "critical" && !item.accepted)) return "failed";
  if (issues.some((item) => item.severity === "warning" && !item.accepted)) return "warning";
  return "ok";
}

function groupGeneratedExperiments(result: PlanBuildResult, options: ComparisonPlanGenerationOptions): Array<[string, PlanBuildResult["experiments"]]> {
  const groups = new Map<string, PlanBuildResult["experiments"]>();
  for (const exp of result.experiments) {
    const method = String(exp.configOverrides.methodId || "all");
    const dataset = String(exp.configOverrides.dataset || "all");
    const key = [
      "comparison",
      options.studyId,
      options.createSeparatePlanPerMethod ? method : "all_methods",
      options.createSeparatePlanPerDataset ? dataset : "all_datasets",
    ].join("_");
    groups.set(key, [...(groups.get(key) || []), exp]);
  }
  return Array.from(groups.entries());
}

function renderComparisonPlanYaml(study: ComparisonStudyRecord, name: string, experiments: PlanBuildResult["experiments"]): string {
  return [
    `suite: ${JSON.stringify(name)}`,
    "mode: train_test",
    "base_config: configs/base.yaml",
    `comparison_study_id: ${JSON.stringify(study.studyId)}`,
    `protocol_id: ${JSON.stringify(study.protocolId || "")}`,
    "cases:",
    ...experiments.map((exp) => [
      `  - name: ${JSON.stringify(exp.name)}`,
      "    overrides:",
      ...Object.entries(exp.configOverrides).map(([key, value]) => `      ${key}: ${JSON.stringify(String(value))}`),
    ].join("\n")),
  ].join("\n") + "\n";
}

type ResultValueRow = { methodId: string; dataset: string; split: string; seed: string; metric: string; value: number; source: string };

function resultValues(study: ComparisonStudyRecord, records: ExperimentResultRecord[], manual: ManualComparisonResult[]): ResultValueRow[] {
  const rows: ResultValueRow[] = [];
  for (const record of records) {
    if (study.linkedResultIds.length && !study.linkedResultIds.includes(record.resultId)) continue;
    const methodId = String(record.dimensions.methodId || record.dimensions.method || inferMethodFromRunKey(record.runKey, study));
    if (!methodId || !study.methods.some((method) => method.methodId === methodId)) continue;
    for (const [metric, value] of Object.entries(record.metrics)) {
      const n = Number(value.value);
      if (Number.isFinite(n)) rows.push({ methodId, dataset: String(record.dimensions.dataset || value.dataset || ""), split: String(record.dimensions.split || value.split || ""), seed: String(record.dimensions.seed || value.seed || ""), metric, value: n, source: "local" });
    }
  }
  for (const item of manual) {
    const n = Number(item.value);
    if (Number.isFinite(n)) rows.push({ methodId: item.methodId, dataset: item.dataset, split: item.split || "", seed: String(item.seed || ""), metric: item.metric, value: n, source: item.source });
  }
  return rows;
}

function inferMethodFromRunKey(runKey: string, study: ComparisonStudyRecord): string {
  return study.methods.find((method) => runKey.includes(method.methodId) || runKey.includes(method.name))?.methodId || "";
}

function buildComparisonLeaderboard(rows: ResultValueRow[], protocol: ComparisonProtocol): LeaderboardRow[] {
  const groups = new Map<string, ResultValueRow[]>();
  for (const row of rows) groups.set(row.methodId, [...(groups.get(row.methodId) || []), row]);
  return Array.from(groups.entries()).map(([methodId, items]) => {
    const metrics: LeaderboardRow["metrics"] = {};
    for (const metric of protocol.metrics) {
      const values = items.filter((item) => item.metric === metric.key).map((item) => item.value);
      if (values.length) metrics[metric.key] = { mean: avg(values), std: std(values), raw: values };
    }
    return { methodId, count: new Set(items.map((item) => `${item.dataset}:${item.split}:${item.seed}`)).size, metrics };
  }).sort((a, b) => a.methodId.localeCompare(b.methodId));
}

function improvementRows(leaderboard: LeaderboardRow[], protocol: ComparisonProtocol, baselineMethodId: string): ComparisonAnalysisResult["baselineImprovements"] {
  const baseline = leaderboard.find((row) => row.methodId === baselineMethodId);
  if (!baseline) return [];
  const out: ComparisonAnalysisResult["baselineImprovements"] = [];
  for (const row of leaderboard.filter((item) => item.methodId !== baselineMethodId)) {
    for (const metric of protocol.metrics) {
      const current = row.metrics[metric.key]?.mean;
      const base = baseline.metrics[metric.key]?.mean;
      if (Number.isFinite(current) && Number.isFinite(base)) {
        const diff = Number(current) - Number(base);
        out.push({ methodId: row.methodId, baselineMethodId, metric: metric.key, absoluteDiff: diff, relativeDiffPercent: Number(base) === 0 ? NaN : diff / Math.abs(Number(base)) * 100, higherIsBetter: metric.higherIsBetter });
      }
    }
  }
  return out;
}

function significanceRows(rows: ResultValueRow[], protocol: ComparisonProtocol, baselineMethodId: string): NonNullable<ComparisonAnalysisResult["significance"]> {
  const methods = Array.from(new Set(rows.map((row) => row.methodId))).filter((method) => method !== baselineMethodId);
  const out: NonNullable<ComparisonAnalysisResult["significance"]> = [];
  for (const method of methods) {
    for (const metric of protocol.metrics) {
      const pairs = pairedValues(rows, baselineMethodId, method, metric.key, protocol.statisticalTest?.pairedBy || ["seed"]);
      if (pairs.length >= 2) {
        const pValue = pairedTTest(pairs.map((pair) => pair[1] - pair[0]));
        out.push({ metric: metric.key, methodA: baselineMethodId, methodB: method, test: "paired_t_test", pValue, significant: pValue < (protocol.statisticalTest?.alpha || 0.05) });
      }
    }
  }
  return out;
}

function pairedValues(rows: ResultValueRow[], a: string, b: string, metric: string, pairedBy: Array<"seed" | "fold" | "dataset" | "case">): Array<[number, number]> {
  const keyOf = (row: ResultValueRow) => pairedBy.map((key) => key === "dataset" ? row.dataset : key === "seed" ? row.seed : row.split).join("|");
  const amap = new Map<string, number>();
  const bmap = new Map<string, number>();
  for (const row of rows) {
    if (row.metric !== metric) continue;
    const target = row.methodId === a ? amap : row.methodId === b ? bmap : undefined;
    if (target) target.set(keyOf(row), row.value);
  }
  const pairs: Array<[number, number]> = [];
  for (const [key, value] of amap) {
    if (bmap.has(key)) pairs.push([value, bmap.get(key)!]);
  }
  return pairs;
}

function pairedTTest(diffs: number[]): number {
  const n = diffs.length;
  const mean = avg(diffs);
  const sd = std(diffs);
  if (n < 2 || sd === 0) return sd === 0 && mean !== 0 ? 0 : 1;
  const t = Math.abs(mean / (sd / Math.sqrt(n)));
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(t))));
}

function reproductionGapRows(reproductions: ReproductionRecord[], rows: ResultValueRow[]): NonNullable<ComparisonAnalysisResult["reproductionGap"]> {
  const out: NonNullable<ComparisonAnalysisResult["reproductionGap"]> = [];
  for (const reproduction of reproductions) {
    for (const [metric, reported] of Object.entries(reproduction.target.reportedMetrics || {})) {
      const reportedValue = Number(reported);
      const values = rows.filter((row) => row.methodId === reproduction.methodId && row.metric === metric).map((row) => row.value);
      if (Number.isFinite(reportedValue) && values.length) out.push({ methodId: reproduction.methodId, metric, reportedValue, reproducedValue: avg(values), gap: avg(values) - reportedValue, explanation: reproduction.deviations.map((item) => item.category).join(", ") || undefined });
    }
  }
  return out;
}

function comparisonMarkdownTable(analysis: ComparisonAnalysisResult, protocol: ComparisonProtocol): string {
  const headers = ["Method", "N", ...protocol.metrics.map((metric) => metric.key)];
  const sep = headers.map((_, index) => index < 2 ? "---" : "---:").join(" | ");
  const rows = analysis.leaderboard.map((row) => [row.methodId, String(row.count), ...protocol.metrics.map((metric) => formatMeanStd(row.metrics[metric.key]?.mean, row.metrics[metric.key]?.std, metric.decimals ?? 3))].join(" | "));
  return [headers.join(" | "), sep, ...rows].join("\n");
}

function comparisonAnalysisCsv(analysis: ComparisonAnalysisResult): string {
  const metrics = Array.from(new Set(analysis.leaderboard.flatMap((row) => Object.keys(row.metrics))));
  const rows = [["methodId", "count", ...metrics], ...analysis.leaderboard.map((row) => [row.methodId, row.count, ...metrics.map((metric) => row.metrics[metric]?.mean ?? "")])];
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function comparisonLatexTable(analysis: ComparisonAnalysisResult, protocol: ComparisonProtocol): string {
  const lines = [
    `\\begin{tabular}{l${"r".repeat(protocol.metrics.length)}}`,
    "\\toprule",
    ["Method", ...protocol.metrics.map((metric) => metric.key)].join(" & ") + " \\\\",
    "\\midrule",
    ...analysis.leaderboard.map((row) => [row.methodId, ...protocol.metrics.map((metric) => formatMeanStd(row.metrics[metric.key]?.mean, row.metrics[metric.key]?.std, metric.decimals ?? 3))].join(" & ") + " \\\\"),
    "\\bottomrule",
    "\\end{tabular}",
  ];
  return lines.join("\n");
}

function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = avg(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function formatMeanStd(mean: number | undefined, sd: number | undefined, decimals: number): string {
  if (!Number.isFinite(mean)) return "-";
  return `${Number(mean).toFixed(decimals)} +/- ${Number(sd || 0).toFixed(decimals)}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
