import { createHash } from "crypto";

export const RESULT_REGISTRY_PATH = "simple_cluster/results/result_registry.json";
export const RESULT_REGISTRY_LOCAL_PATH = "simple_cluster/results/result_registry.local.json";
export const RESULT_EXPORT_DIR = "simple_cluster/results/exports";

export type ResultEndpoint = "local" | "hub" | "worker" | "archive";
export type ResultFileType = "csv" | "json" | "log" | "manual";

export interface ResultMetricValue {
  value: number | string | boolean | null;
  unit?: string;
  higherIsBetter?: boolean;
  sourceColumn?: string;
  sourceFile?: string;
  split?: "train" | "val" | "test" | "external" | string;
  dataset?: string;
  fold?: string | number;
  seed?: string | number;
}

export interface ResultParserConfig {
  presetId?: string;
  columnMapping?: ResultParserPreset["columnMapping"];
  metricColumns?: string[];
  dimensions?: ResultDimensionConfig[];
}

export interface ExperimentResultRecord {
  schemaVersion: 1;
  resultId: string;
  experimentId: string;
  attemptId?: string;
  runKey: string;
  suite: string;
  experimentName: string;
  status: "pending" | "parsed" | "parse_failed" | "validated" | "excluded" | "warning" | "manual_verified";
  tags?: string[];
  schemaId?: string;
  locked?: boolean;
  paperCandidate?: boolean;
  sourceFiles: Array<{ path: string; type: ResultFileType; endpoint: ResultEndpoint; sha256?: string; mtime?: string; size?: number }>;
  parserPresetId?: string;
  parserConfig?: ResultParserConfig;
  metrics: Record<string, ResultMetricValue>;
  dimensions: Record<string, string | number | boolean>;
  manualOverrides?: string[];
  revisions?: ResultRevision[];
  eligibleForFinalAnalysis?: boolean;
  finalEvidenceState?: "archived" | "manual_verified" | "pending_review" | string;
  primaryMetric?: string;
  higherIsBetter?: boolean;
  parsedAt?: string;
  validatedAt?: string;
  createdAt: string;
  updatedAt: string;
  provenance: {
    planFile?: string;
    configPath?: string;
    workerId?: string;
    gpuIds?: string[];
    commit?: string;
    command?: string;
    artifactKey?: string;
  };
  notes?: string;
}

export interface ResultParserPreset {
  id: string;
  name: string;
  description?: string;
  format: "long_csv" | "wide_csv" | "json" | "custom_csv";
  filePatterns: string[];
  columnMapping: {
    experimentId?: string;
    attemptId?: string;
    suite?: string;
    runKey?: string;
    dataset?: string;
    split?: string;
    fold?: string;
    seed?: string;
    metric?: string;
    value?: string;
    epoch?: string;
    step?: string;
    timestamp?: string;
  };
  metricColumns?: string[];
  metricAliases?: Record<string, string>;
  metricDirections?: Record<string, "higher" | "lower">;
  requiredColumns?: string[];
  filters?: Array<{ column: string; op: "==" | "!=" | "in" | "not_in" | "contains"; value: string | string[] }>;
  finalRowSelector?: { type: "last_epoch" | "max_epoch" | "step_equals" | "column_filter"; column?: string; value?: string | number };
  groupByDefaults?: string[];
  primaryMetric?: string;
}

export interface ResultDimensionConfig {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "category";
  required?: boolean;
  source?:
    | { type: "csv_column"; column: string }
    | { type: "config_path"; jsonPath: string }
    | { type: "plan_variable"; name: string }
    | { type: "regex_from_path"; pattern: string; group?: number | string }
    | { type: "experiment_field"; field: string }
    | { type: "expression"; expression: string }
    | { type: "manual" };
  sources?: Array<
    | { type: "csv_column"; column: string }
    | { type: "config_path"; jsonPath: string }
    | { type: "plan_variable"; name: string }
    | { type: "regex_from_path"; pattern: string; group?: number | string }
    | { type: "experiment_field"; field: string }
    | { type: "expression"; expression: string }
    | { type: "manual" }
  >;
  defaultValue?: string | number | boolean;
  aliases?: Record<string, string>;
  categories?: string[];
  displayOrder?: string[];
}

export interface ResultMetricDefinition {
  key: string;
  label: string;
  aliases?: string[];
  type: "number" | "string" | "boolean";
  unit?: string;
  higherIsBetter?: boolean;
  decimals?: number;
  format?: "float" | "percent" | "scientific" | "integer";
  validRange?: { min?: number; max?: number };
  category?: "segmentation" | "classification" | "regression" | "loss" | "runtime" | "custom";
  required?: boolean;
  primary?: boolean;
}

export interface ResultSchema {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  appliesTo?: { suites?: string[]; projects?: string[]; tags?: string[] };
  dimensions: ResultDimensionConfig[];
  metrics: ResultMetricDefinition[];
  validationRules: ResultValidationRule[];
  defaultLeaderboards: LeaderboardConfig[];
  defaultPaperTables: PaperTableConfig[];
  display?: {
    defaultGroupBy?: string[];
    defaultSortMetric?: string;
    hiddenDimensions?: string[];
    pinnedMetrics?: string[];
  };
}

export interface MetricAliasRule {
  from: string;
  to: string;
  caseInsensitive: boolean;
  trim?: boolean;
  regex?: boolean;
}

export interface ResultRevision {
  revisionId: string;
  resultId: string;
  createdAt: string;
  author?: string;
  reason: string;
  changes: Array<{ path: string; before: unknown; after: unknown }>;
  source: "parser" | "manual_edit" | "schema_migration" | "reparse" | "validation_fix";
}

export interface ResultParsePreview {
  presetId: string;
  format: ResultParserPreset["format"];
  rows: number;
  records: number;
  columns: string[];
  missingRequiredColumns: string[];
  warnings: string[];
  sampleMetrics: Record<string, ResultMetricValue>;
}

export interface TextMetricSample {
  metric: string;
  value: number;
  line: number;
  snippet: string;
  higherIsBetter: boolean;
}

export interface TextMetricParsePreview {
  ruleId: "custom_regex" | "summary_text_regex" | "console_regex";
  sourceFile: string;
  lines: number;
  records: number;
  metrics: string[];
  samples: TextMetricSample[];
  warnings: string[];
  parsedAt: string;
}

export const defaultTextMetricPattern = /\b(?<metric>(?:accuracy|acc|auc|auroc|roc_auc|auprc|f1|precision|recall|sensitivity|specificity|balanced_accuracy|loss|dice|dsc|iou|hd95|asd|mae|mse|rmse|r2))\b\s*[:=]\s*(?<value>-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:\s*%)?/gi;

export interface ResultValidationRule {
  id: string;
  enabled: boolean;
  metric?: string;
  dimensionFilter?: Record<string, string | number | boolean>;
  check:
    | { type: "range"; min?: number; max?: number }
    | { type: "not_null" }
    | { type: "is_finite_number" }
    | { type: "monotonic"; direction: "increasing" | "decreasing" }
    | { type: "custom_expression"; expression: string };
  severity: "info" | "warning" | "critical";
  message: string;
}

export interface ResultValidationIssue {
  id: string;
  resultId: string;
  metric?: string;
  severity: "info" | "warning" | "critical";
  message: string;
  evidence?: unknown;
  ignored?: boolean;
}

export interface ResultInclusionPolicy {
  id: string;
  name: string;
  includeStatuses: Array<"parsed" | "validated" | "warning" | "manual_verified">;
  excludeTags?: string[];
  includeTags?: string[];
  excludeIfValidationSeverityAtLeast?: "warning" | "critical";
  requireMetrics?: string[];
  requireDimensions?: string[];
  allowManualOverride?: boolean;
  requireFinalEvidence?: boolean;
}

export interface LeaderboardConfig {
  id: string;
  name: string;
  filter: { suite?: string[]; dataset?: string[]; split?: string[]; tags?: string[]; status?: string[]; includeWarnings?: boolean };
  groupBy: string[];
  metrics: Array<{ key: string; label?: string; higherIsBetter: boolean; format?: "float" | "percent" | "scientific"; decimals?: number }>;
  aggregate: "mean_std" | "mean_ci" | "best" | "median_iqr" | "raw" | "mean_ci95" | "last" | "weighted_mean" | "paired_diff" | "relative_improvement";
  primarySortMetric?: string;
}

export type AggregationMethod = "raw" | "mean_std" | "mean_ci95" | "median_iqr" | "best" | "last" | "weighted_mean" | "paired_diff" | "relative_improvement";

export interface AggregationConfig {
  method: AggregationMethod;
  groupBy: string[];
  aggregateOver?: string[];
  baselineFilter?: Record<string, string | number | boolean>;
  weightDimension?: string;
  confidenceLevel?: number;
}

export interface ResultLeaderboardRow {
  groupKey: string;
  dimensions: Record<string, string | number | boolean>;
  count: number;
  values: Record<string, { mean?: number; std?: number; best?: number; median?: number; raw?: Array<number | string | boolean | null> }>;
  bestResultId?: string;
}

export interface PaperTableConfig {
  id: string;
  title: string;
  leaderboardId: string;
  rowDimension: string;
  columnDimension?: string;
  metrics: string[];
  boldBest: boolean;
  underlineSecondBest?: boolean;
  showMeanStd: boolean;
  decimals: Record<string, number>;
  metricDisplayNames: Record<string, string>;
  datasetDisplayNames?: Record<string, string>;
  methodDisplayNames?: Record<string, string>;
}

export interface PaperTableTemplate {
  id: string;
  name: string;
  description?: string;
  source: { leaderboardId?: string; filter?: Record<string, unknown>; inclusionPolicyId?: string };
  layout: { rows: string[]; columns?: string[]; metrics: string[]; splitBy?: string };
  formatting: {
    decimals: Record<string, number>;
    metricLabels: Record<string, string>;
    dimensionLabels: Record<string, string>;
    valueFormat?: "mean_std" | "mean_ci" | "raw";
    boldBest: boolean;
    underlineSecondBest: boolean;
    lowerIsBetterMarkers?: boolean;
    missingValue: string;
  };
  export: { formats: Array<"markdown" | "csv" | "latex_tabular" | "latex_booktabs" | "json">; filenamePattern: string };
}

export interface ResultDashboardSummary {
  totalExperiments: number;
  parsedResults: number;
  parseFailed: number;
  validationWarnings: number;
  paperCandidates: number;
  bestBySuite: Array<{ suite: string; metric: string; resultId: string; value: number }>;
  coverage: Array<{ dimension: string; value: string; count: number; missingMetrics: string[] }>;
}

export interface ResultConsistencyIssue {
  id: string;
  severity: "info" | "warning" | "critical";
  resultId?: string;
  configId?: string;
  message: string;
  suggestion: string;
  autoFixAvailable?: boolean;
}

export const segmentationMetricDirections: Record<string, "higher" | "lower"> = {
  DSC: "higher",
  Dice: "higher",
  ASD: "lower",
  HD95: "lower",
  IoU: "higher",
  precision: "higher",
  recall: "higher",
};

export const classificationMetricDirections: Record<string, "higher" | "lower"> = {
  accuracy: "higher",
  AUC: "higher",
  AUROC: "higher",
  ROC_AUC: "higher",
  AUPRC: "higher",
  F1: "higher",
  precision: "higher",
  recall: "higher",
  sensitivity: "higher",
  specificity: "higher",
  balanced_accuracy: "higher",
  macro_f1: "higher",
  micro_f1: "higher",
  mcc: "higher",
  kappa: "higher",
  ece: "lower",
  brier: "lower",
  loss: "lower",
};

export const builtInResultPresets: ResultParserPreset[] = [
  preset("classification_long_csv", "Classification long CSV", "long_csv", classificationMetricDirections, ["accuracy", "AUC", "AUROC", "ROC_AUC", "AUPRC", "F1", "precision", "recall", "sensitivity", "specificity", "balanced_accuracy", "loss"]),
  preset("classification_wide_csv", "Classification wide CSV", "wide_csv", classificationMetricDirections, ["accuracy", "AUC", "AUROC", "ROC_AUC", "AUPRC", "F1", "precision", "recall", "sensitivity", "specificity", "balanced_accuracy", "loss"]),
  preset("medical_segmentation_long_csv", "Medical segmentation long CSV", "long_csv", segmentationMetricDirections, ["DSC", "ASD", "HD95", "IoU", "Dice"]),
  preset("medical_segmentation_wide_csv", "Medical segmentation wide CSV", "wide_csv", segmentationMetricDirections, ["DSC", "ASD", "HD95", "IoU", "Dice"]),
  preset("regression_wide_csv", "Regression wide CSV", "wide_csv", { MAE: "lower", MSE: "lower", RMSE: "lower", R2: "higher", loss: "lower" }, ["MAE", "MSE", "RMSE", "R2", "loss"]),
  preset("generic_metric_long_csv", "Generic metric long CSV", "long_csv", {}, []),
  preset("generic_metric_wide_csv", "Generic metric wide CSV", "wide_csv", {}, []),
];

export const defaultValidationRules: ResultValidationRule[] = [
  ...["accuracy", "AUC", "AUROC", "ROC_AUC", "AUPRC", "F1", "precision", "recall", "sensitivity", "specificity", "balanced_accuracy", "DSC", "Dice", "IoU"].map((metric) => ({ id: `${metric}_range`, enabled: true, metric, check: { type: "range" as const, min: 0, max: 1 }, severity: "warning" as const, message: `${metric} should be in [0,1]` })),
  ...["loss", "ASD", "HD95", "ece", "brier"].map((metric) => ({ id: `${metric}_nonnegative`, enabled: true, metric, check: { type: "range" as const, min: 0 }, severity: "warning" as const, message: `${metric} should be non-negative` })),
  { id: "primary_metric_present", enabled: true, check: { type: "not_null" }, severity: "warning", message: "Primary metric missing" },
];

export const defaultInclusionPolicy: ResultInclusionPolicy = {
  id: "default_results",
  name: "Default results",
  includeStatuses: ["parsed", "validated", "warning", "manual_verified"],
  excludeTags: ["deleted", "excluded"],
  excludeIfValidationSeverityAtLeast: "critical",
};

export const finalResultInclusionPolicy: ResultInclusionPolicy = {
  id: "final_results_only",
  name: "Final archived results only",
  includeStatuses: ["parsed", "validated", "warning", "manual_verified"],
  excludeTags: ["deleted", "excluded"],
  excludeIfValidationSeverityAtLeast: "critical",
  requireFinalEvidence: true,
};

export const builtInResultSchemas: ResultSchema[] = [
  {
    schemaVersion: 1,
    id: "medical_segmentation",
    name: "Medical segmentation",
    dimensions: commonDimensions(),
    metrics: [
      metricDef("DSC", "DSC", "number", true, 3, "segmentation", ["dice", "Dice", "mean_dice"], { min: 0, max: 1 }, true),
      metricDef("ASD", "ASD", "number", false, 2, "segmentation", [], { min: 0 }),
      metricDef("HD95", "HD95", "number", false, 2, "segmentation", ["hd95", "hausdorff95"], { min: 0 }),
      metricDef("IoU", "IoU", "number", true, 3, "segmentation", [], { min: 0, max: 1 }),
    ],
    validationRules: defaultValidationRules,
    defaultLeaderboards: [{
      id: "medical_main",
      name: "Medical main",
      filter: { includeWarnings: true },
      groupBy: ["method", "dataset"],
      metrics: [{ key: "DSC", higherIsBetter: true, decimals: 3 }, { key: "ASD", higherIsBetter: false, decimals: 2 }, { key: "HD95", higherIsBetter: false, decimals: 2 }],
      aggregate: "mean_std",
      primarySortMetric: "DSC",
    }],
    defaultPaperTables: [{ id: "medical_main_table", title: "Medical segmentation", leaderboardId: "medical_main", rowDimension: "method", metrics: ["DSC", "ASD", "HD95"], boldBest: true, underlineSecondBest: true, showMeanStd: true, decimals: { DSC: 3, ASD: 2, HD95: 2 }, metricDisplayNames: {} }],
    display: { defaultGroupBy: ["method", "dataset"], defaultSortMetric: "DSC", pinnedMetrics: ["DSC", "ASD", "HD95"] },
  },
  {
    schemaVersion: 1,
    id: "classification",
    name: "Classification",
    dimensions: commonDimensions(),
    metrics: [
      metricDef("accuracy", "Accuracy", "number", true, 3, "classification", ["acc"], { min: 0, max: 1 }, true),
      metricDef("AUC", "AUC", "number", true, 3, "classification", ["auc", "AUROC", "roc_auc"], { min: 0, max: 1 }),
      metricDef("AUPRC", "AUPRC", "number", true, 3, "classification", ["auprc", "pr_auc"], { min: 0, max: 1 }),
      metricDef("F1", "F1", "number", true, 3, "classification", ["f1", "macro_f1", "micro_f1"], { min: 0, max: 1 }),
      metricDef("precision", "Precision", "number", true, 3, "classification", ["ppv"], { min: 0, max: 1 }),
      metricDef("recall", "Recall", "number", true, 3, "classification", ["sensitivity", "tpr"], { min: 0, max: 1 }),
      metricDef("specificity", "Specificity", "number", true, 3, "classification", ["tnr"], { min: 0, max: 1 }),
      metricDef("balanced_accuracy", "Balanced accuracy", "number", true, 3, "classification", ["bal_acc", "balanced_acc"], { min: 0, max: 1 }),
      metricDef("loss", "Loss", "number", false, 4, "loss", [], { min: 0 }),
    ],
    validationRules: defaultValidationRules,
    defaultLeaderboards: [{
      id: "classification_main",
      name: "Classification main",
      filter: { includeWarnings: true },
      groupBy: ["method", "dataset"],
      metrics: [{ key: "AUC", higherIsBetter: true, decimals: 3 }, { key: "accuracy", higherIsBetter: true, decimals: 3 }, { key: "F1", higherIsBetter: true, decimals: 3 }, { key: "AUPRC", higherIsBetter: true, decimals: 3 }],
      aggregate: "mean_std",
      primarySortMetric: "AUC",
    }],
    defaultPaperTables: [{ id: "classification_main_table", title: "Classification", leaderboardId: "classification_main", rowDimension: "method", metrics: ["AUC", "accuracy", "F1", "AUPRC"], boldBest: true, underlineSecondBest: true, showMeanStd: true, decimals: { AUC: 3, accuracy: 3, F1: 3, AUPRC: 3 }, metricDisplayNames: {} }],
    display: { defaultGroupBy: ["method", "dataset"], defaultSortMetric: "AUC", pinnedMetrics: ["AUC", "accuracy", "F1", "AUPRC", "precision", "recall", "specificity"] },
  },
];

export const builtInPaperTableTemplates: PaperTableTemplate[] = [
  paperTemplate("medical_segmentation_main_table", "Medical segmentation main table", ["method"], ["dataset"], ["DSC", "ASD", "HD95"]),
  paperTemplate("medical_segmentation_ablation_table", "Medical segmentation ablation table", ["method"], undefined, ["DSC", "ASD"]),
  paperTemplate("classification_main_table", "Classification main table", ["method"], ["dataset"], ["accuracy", "AUC", "F1"]),
  paperTemplate("cross_dataset_summary", "Cross dataset summary", ["method"], ["dataset"], ["DSC"]),
  paperTemplate("missing_modality_robustness_table", "Missing modality robustness", ["method"], ["missing_rate"], ["DSC", "ASD"]),
  paperTemplate("noise_robustness_table", "Noise robustness", ["method"], ["noise_level"], ["DSC", "ASD"]),
];

export function selectResultPreset(fileName: string, presets: ResultParserPreset[] = builtInResultPresets): ResultParserPreset {
  return presets.find((item) => item.filePatterns.some((pattern) => globMatch(fileName, pattern))) || presets[0];
}

export function previewResultParse(text: string, sourceFile: string, preset: ResultParserPreset, parserConfig: ResultParserConfig = {}): ResultParsePreview {
  const isJson = /\.json$/i.test(sourceFile) || preset.format === "json";
  const rows = isJson ? [] : csvRows(text);
  const headers = isJson ? jsonPreviewColumns(text) : rows[0] || [];
  const missingRequiredColumns = isJson ? [] : (preset.requiredColumns || []).filter((column) => !headers.includes(column));
  const records = parseResultFile(text, { path: sourceFile, type: isJson ? "json" : "csv", endpoint: "local" }, preset, parserConfig);
  const inputWarnings = isJson ? [] : resultInputWarnings(rows.slice(1), headers, preset, parserConfig);
  return {
    presetId: preset.id,
    format: isJson ? "json" : preset.format,
    rows: isJson ? records.length : Math.max(0, rows.length - 1),
    records: records.length,
    columns: headers,
    missingRequiredColumns,
    warnings: [
      ...(isCaseLevelMetricsFile(sourceFile) ? ["metrics_case.csv 是 case-level 明细，只用于错误样本、子组和泄漏检查；论文级汇总请写 metrics_summary.csv。"] : []),
      ...(missingRequiredColumns.length ? [`missing required columns: ${missingRequiredColumns.join(", ")}`] : []),
      ...inputWarnings,
      ...records.filter((record) => record.notes).map((record) => `${record.resultId}: ${record.notes}`),
    ],
    sampleMetrics: records[0]?.metrics || {},
  };
}

export function previewTextMetricParse(
  text: string,
  sourceFile: string,
  options: { metricRegex?: string; metricAliases?: Record<string, string> } = {},
): TextMetricParsePreview {
  const customPattern = compileTextMetricPattern(options.metricRegex);
  const ruleId = customPattern ? "custom_regex" : /summary\.txt$/i.test(sourceFile) ? "summary_text_regex" : "console_regex";
  const samples: TextMetricSample[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const pattern = new RegExp((customPattern || defaultTextMetricPattern).source, "gi");
    for (const match of line.matchAll(pattern)) {
      const metric = normalizeTextMetricName(match.groups?.metric || "", options.metricAliases);
      const raw = Number(match.groups?.value);
      if (!metric || !Number.isFinite(raw)) continue;
      const matchedText = line.slice(match.index || 0, (match.index || 0) + match[0].length);
      samples.push({
        metric,
        value: /%\s*$/.test(matchedText) ? raw / 100 : raw,
        line: index + 1,
        snippet: compactSnippet(line),
        higherIsBetter: !["loss", "log_loss", "cross_entropy", "ce_loss", "asd", "hd95", "mae", "mse", "rmse"].includes(metric.toLowerCase()),
      });
    }
  });
  return {
    ruleId,
    sourceFile,
    lines: lines.length,
    records: samples.length,
    metrics: unique(samples.map((item) => item.metric)),
    samples: samples.slice(0, 8),
    warnings: [
      ...(options.metricRegex && !customPattern ? ["自定义指标正则无效，已回退到默认正则。"] : []),
      ...(samples.length ? [] : ["未从文本中捕获指标；可配置自定义正则。"]),
    ],
    parsedAt: new Date().toISOString(),
  };
}

export function parseResultFile(text: string, sourceFile: ExperimentResultRecord["sourceFiles"][number], preset: ResultParserPreset, parserConfig: ResultParserConfig = {}): ExperimentResultRecord[] {
  if (isCaseLevelMetricsFile(sourceFile.path)) return [];
  if (preset.format === "json" || sourceFile.type === "json") return parseJsonResult(text, sourceFile, preset, parserConfig);
  const rows = csvRows(text);
  const headers = rows[0] || [];
  const data = rows.slice(1).map((cols) => Object.fromEntries(headers.map((header, index) => [header, cols[index] || ""])));
  const filtered = finalRows(applyFilters(data, preset), preset);
  return isLongFormat(headers, preset)
    ? parseLongRows(filtered, sourceFile, preset, parserConfig)
    : parseWideRows(filtered, headers, sourceFile, preset, parserConfig);
}

export function upsertExperimentResults(existing: ExperimentResultRecord[], incoming: ExperimentResultRecord[]): ExperimentResultRecord[] {
  const map = new Map(existing.map((item) => [item.resultId, item]));
  for (const record of incoming) {
    const previous = map.get(record.resultId);
    map.set(record.resultId, previous ? { ...previous, ...record, createdAt: previous.createdAt, updatedAt: new Date().toISOString() } : record);
  }
  return Array.from(map.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function validateResultRecords(records: ExperimentResultRecord[], rules: ResultValidationRule[] = defaultValidationRules): ResultValidationIssue[] {
  const issues: ResultValidationIssue[] = [];
  const seen = new Map<string, ResultMetricValue>();
  for (const record of records) {
    if (record.primaryMetric && !record.metrics[record.primaryMetric]) issues.push(issue(record, "primary_metric", undefined, "warning", `Primary metric missing: ${record.primaryMetric}`));
    for (const [metric, value] of Object.entries(record.metrics)) {
      const key = `${record.experimentId}:${metric}:${value.dataset || ""}:${value.split || ""}:${value.fold || ""}:${value.seed || ""}`;
      const previous = seen.get(key);
      if (previous && previous.value !== value.value) issues.push(issue(record, "duplicate_conflict", metric, "warning", `Conflicting duplicate metric: ${metric}`, { previous, value }));
      seen.set(key, value);
      for (const rule of rules.filter((item) => item.enabled && (!item.metric || metricAlias(item.metric) === metricAlias(metric)))) {
        if (!dimensionMatches(record, rule.dimensionFilter)) continue;
        if (!checkMetric(value.value, rule.check)) issues.push(issue(record, rule.id, metric, rule.severity, rule.message, value));
      }
    }
  }
  return issues;
}

export function buildResultLeaderboard(records: ExperimentResultRecord[], config: LeaderboardConfig, issues: ResultValidationIssue[] = []): ResultLeaderboardRow[] {
  const issueIds = new Set(issues.filter((item) => !config.filter.includeWarnings && ["warning", "critical"].includes(item.severity)).map((item) => item.resultId));
  const filtered = records.filter((record) => {
    if (record.status === "excluded" || record.status === "parse_failed") return false;
    if (issueIds.has(record.resultId)) return false;
    if (config.filter.suite?.length && !config.filter.suite.includes(record.suite)) return false;
    if (config.filter.status?.length && !config.filter.status.includes(record.status)) return false;
    if (config.filter.tags?.length && !config.filter.tags.some((tag) => record.tags?.includes(tag))) return false;
    if (config.filter.dataset?.length && !config.filter.dataset.includes(String(record.dimensions.dataset || ""))) return false;
    if (config.filter.split?.length && !config.filter.split.includes(String(record.dimensions.split || ""))) return false;
    return true;
  });
  const groups = new Map<string, ExperimentResultRecord[]>();
  for (const record of filtered) {
    const groupKey = config.groupBy.map((key) => String(record.dimensions[key] ?? record[key as keyof ExperimentResultRecord] ?? "")).join(" | ");
    groups.set(groupKey, [...(groups.get(groupKey) || []), record]);
  }
  return Array.from(groups.entries()).map(([groupKey, items]) => {
    const values: ResultLeaderboardRow["values"] = {};
    for (const metric of config.metrics) {
      const nums = items.map((item) => Number(item.metrics[metric.key]?.value)).filter(Number.isFinite);
      values[metric.key] = aggregate(nums, config.aggregate);
    }
    const primary = config.primarySortMetric || config.metrics[0]?.key;
    const primaryCfg = config.metrics.find((metric) => metric.key === primary);
    const best = primary ? [...items].filter((item) => Number.isFinite(Number(item.metrics[primary]?.value))).sort((a, b) => {
      const av = Number(a.metrics[primary]?.value);
      const bv = Number(b.metrics[primary]?.value);
      return primaryCfg?.higherIsBetter === false ? av - bv : bv - av;
    })[0] : undefined;
    return {
      groupKey,
      dimensions: Object.fromEntries(config.groupBy.map((key) => [key, items[0]?.dimensions[key] ?? ""])),
      count: items.length,
      values,
      bestResultId: best?.resultId,
    };
  }).sort((a, b) => sortLeaderboard(a, b, config));
}

export function leaderboardToCsv(rows: ResultLeaderboardRow[], config: LeaderboardConfig): string {
  const headers = ["group", "count", ...config.metrics.map((metric) => metric.label || metric.key), "bestResultId"];
  const body = rows.map((row) => [row.groupKey, row.count, ...config.metrics.map((metric) => formatAggregate(row.values[metric.key], metric.decimals ?? 4)), row.bestResultId || ""]);
  return [headers, ...body].map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function leaderboardToMarkdownTable(rows: ResultLeaderboardRow[], config: LeaderboardConfig): string {
  const headers = ["Group", "N", ...config.metrics.map((metric) => metric.label || metric.key), "Best"];
  const sep = headers.map((_, index) => index < 2 ? "---" : "---:").join(" | ");
  const body = rows.map((row) => [row.groupKey, String(row.count), ...config.metrics.map((metric) => formatAggregate(row.values[metric.key], metric.decimals ?? 4)), row.bestResultId || ""].join(" | "));
  return [headers.join(" | "), sep, ...body].join("\n");
}

export function exportPaperTable(rows: ResultLeaderboardRow[], leaderboard: LeaderboardConfig, table: PaperTableConfig, format: "markdown" | "csv" | "latex" | "latex_booktabs" = "markdown"): string {
  if (format === "csv") return leaderboardToCsv(rows, leaderboard);
  if (format === "markdown") return leaderboardToMarkdownTable(withBestFormatting(rows, leaderboard, table, false), leaderboard);
  const cols = ["Method", ...table.metrics.map((metric) => table.metricDisplayNames[metric] || metric)];
  const body = withBestFormatting(rows, leaderboard, table, true).map((row) => [
    displayName(String(row.dimensions[table.rowDimension] || row.groupKey), table.methodDisplayNames),
    ...table.metrics.map((metric) => formatAggregate(row.values[metric], table.decimals[metric] ?? 4)),
  ]);
  const line = format === "latex_booktabs" ? "\\toprule" : "\\hline";
  const mid = format === "latex_booktabs" ? "\\midrule" : "\\hline";
  const bottom = format === "latex_booktabs" ? "\\bottomrule" : "\\hline";
  return [
    `\\begin{tabular}{l${"r".repeat(table.metrics.length)}}`,
    line,
    `${cols.join(" & ")} \\\\`,
    mid,
    ...body.map((row) => `${row.join(" & ")} \\\\`),
    bottom,
    "\\end{tabular}",
  ].join("\n");
}

export function readResultConfigJson<T>(text: string, validate: (value: unknown) => value is T, lastKnownGood: T): { ok: true; value: T } | { ok: false; value: T; error: string } {
  try {
    const parsed = JSON.parse(text);
    return validate(parsed) ? { ok: true, value: parsed } : { ok: false, value: lastKnownGood, error: "schema validation failed" };
  } catch (error) {
    return { ok: false, value: lastKnownGood, error: error instanceof Error ? error.message : String(error) };
  }
}

export function normalizeMetricKey(metric: string, schema?: ResultSchema, extraRules: MetricAliasRule[] = []): string {
  const rules: MetricAliasRule[] = [
    ...(schema?.metrics.flatMap((item) => (item.aliases || []).map((from) => ({ from, to: item.key, caseInsensitive: true, trim: true }))) || []),
    { from: "dice", to: "DSC", caseInsensitive: true, trim: true },
    { from: "mean_dice", to: "DSC", caseInsensitive: true, trim: true },
    { from: "hd95", to: "HD95", caseInsensitive: true, trim: true },
    { from: "hausdorff95", to: "HD95", caseInsensitive: true, trim: true },
    { from: "top1", to: "top1_accuracy", caseInsensitive: true, trim: true },
    { from: "top_1", to: "top1_accuracy", caseInsensitive: true, trim: true },
    { from: "top1_acc", to: "top1_accuracy", caseInsensitive: true, trim: true },
    { from: "top5", to: "top5_accuracy", caseInsensitive: true, trim: true },
    { from: "top_5", to: "top5_accuracy", caseInsensitive: true, trim: true },
    { from: "top5_acc", to: "top5_accuracy", caseInsensitive: true, trim: true },
    { from: "auroc", to: "AUC", caseInsensitive: true, trim: true },
    { from: "roc_auc", to: "AUC", caseInsensitive: true, trim: true },
    { from: "average_precision", to: "AUPRC", caseInsensitive: true, trim: true },
    { from: "ap", to: "AUPRC", caseInsensitive: true, trim: true },
    { from: "pr_auc", to: "AUPRC", caseInsensitive: true, trim: true },
    { from: "weighted_f1", to: "F1", caseInsensitive: true, trim: true },
    { from: "f1_macro", to: "F1", caseInsensitive: true, trim: true },
    { from: "f1_micro", to: "F1", caseInsensitive: true, trim: true },
    { from: "f1_weighted", to: "F1", caseInsensitive: true, trim: true },
    { from: "macro_precision", to: "precision", caseInsensitive: true, trim: true },
    { from: "macro_recall", to: "recall", caseInsensitive: true, trim: true },
    { from: "mcc", to: "MCC", caseInsensitive: true, trim: true },
    { from: "matthews_corrcoef", to: "MCC", caseInsensitive: true, trim: true },
    { from: "cohen_kappa", to: "kappa", caseInsensitive: true, trim: true },
    { from: "log_loss", to: "loss", caseInsensitive: true, trim: true },
    { from: "cross_entropy", to: "loss", caseInsensitive: true, trim: true },
    { from: "ce_loss", to: "loss", caseInsensitive: true, trim: true },
    ...extraRules,
  ];
  for (const rule of rules) {
    const from = rule.trim ? rule.from.trim() : rule.from;
    const value = rule.trim ? metric.trim() : metric;
    const flags = rule.caseInsensitive ? "i" : "";
    if (rule.regex ? new RegExp(from, flags).test(value) : (rule.caseInsensitive ? from.toLowerCase() === value.toLowerCase() : from === value)) return rule.to;
  }
  return metric.trim();
}

export function detectMetricAliasConflicts(schema: ResultSchema): Array<{ alias: string; targets: string[] }> {
  const aliases = new Map<string, Set<string>>();
  for (const metric of schema.metrics) {
    for (const aliasValue of metric.aliases || []) {
      const key = aliasValue.trim().toLowerCase();
      aliases.set(key, aliases.get(key) || new Set());
      aliases.get(key)!.add(metric.key);
    }
  }
  return Array.from(aliases.entries()).filter(([, targets]) => targets.size > 1).map(([aliasValue, targets]) => ({ alias: aliasValue, targets: Array.from(targets) }));
}

export function applyResultSchema(record: ExperimentResultRecord, schema: ResultSchema, context: { row?: Record<string, unknown>; sourcePath?: string; config?: unknown; planVariables?: Record<string, unknown> } = {}): ExperimentResultRecord {
  const metrics: Record<string, ResultMetricValue> = {};
  for (const [key, value] of Object.entries(record.metrics)) {
    const normalized = normalizeMetricKey(key, schema);
    const def = schema.metrics.find((item) => item.key === normalized);
    metrics[normalized] = { ...value, higherIsBetter: def?.higherIsBetter ?? value.higherIsBetter, unit: value.unit || def?.unit, sourceColumn: value.sourceColumn || key };
  }
  const dimensions = { ...record.dimensions };
  for (const dimension of schema.dimensions) {
    const value = extractDimension(context.row || {}, dimension, { ...context, record });
    if (value !== undefined) dimensions[dimension.key] = value;
  }
  const primary = schema.metrics.find((item) => item.primary || item.required)?.key || record.primaryMetric;
  return { ...record, schemaId: schema.id, metrics, dimensions, primaryMetric: primary, higherIsBetter: primary ? schema.metrics.find((item) => item.key === primary)?.higherIsBetter ?? record.higherIsBetter : record.higherIsBetter, updatedAt: new Date().toISOString() };
}

export function extractDimension(row: Record<string, unknown>, config: ResultDimensionConfig, context: { sourcePath?: string; record?: ExperimentResultRecord; config?: unknown; planVariables?: Record<string, unknown> } = {}): string | number | boolean | undefined {
  const sources = config.sources?.length ? config.sources : config.source ? [config.source] : [];
  let raw: unknown = undefined;
  for (const source of sources) {
    raw = readDimensionSource(row, source, context);
    if (raw !== undefined && raw !== "") break;
  }
  if ((raw === undefined || raw === "") && config.defaultValue !== undefined) raw = config.defaultValue;
  if (raw === undefined || raw === "") return undefined;
  const aliasValue = config.aliases?.[String(raw)] || config.aliases?.[String(raw).toLowerCase()] || raw;
  return coerceDimension(aliasValue, config.type);
}

export function createResultRevision(record: ExperimentResultRecord, changes: ResultRevision["changes"], reason: string, source: ResultRevision["source"] = "manual_edit", author?: string): ResultRevision {
  return { revisionId: `rev_${sha256(`${record.resultId}:${Date.now()}:${changes.length}`).slice(0, 12)}`, resultId: record.resultId, createdAt: new Date().toISOString(), author, reason, changes, source };
}

export function applyResultRevision(record: ExperimentResultRecord, revision: ResultRevision): ExperimentResultRecord {
  let next: ExperimentResultRecord = { ...record, metrics: { ...record.metrics }, dimensions: { ...record.dimensions }, tags: [...(record.tags || [])], revisions: [...(record.revisions || []), revision], manualOverrides: [...(record.manualOverrides || [])], updatedAt: revision.createdAt };
  for (const change of revision.changes) {
    next = setResultPath(next, change.path, change.after);
    if (revision.source === "manual_edit" && !next.manualOverrides!.includes(change.path)) next.manualOverrides!.push(change.path);
  }
  return next;
}

export function reparseResultRecords(existing: ExperimentResultRecord[], incoming: ExperimentResultRecord[], options: { force?: boolean } = {}): ExperimentResultRecord[] {
  const map = new Map(existing.map((item) => [item.resultId, item]));
  for (const record of incoming) {
    const previous = map.get(record.resultId);
    if (!previous) {
      map.set(record.resultId, record);
      continue;
    }
    if (previous.locked && !options.force) {
      map.set(record.resultId, { ...previous, updatedAt: new Date().toISOString() });
      continue;
    }
    let merged: ExperimentResultRecord = { ...previous, ...record, createdAt: previous.createdAt, revisions: previous.revisions, manualOverrides: previous.manualOverrides, locked: previous.locked };
    if (!options.force) {
      for (const path of previous.manualOverrides || []) merged = setResultPath(merged, path, getResultPath(previous, path));
    }
    map.set(record.resultId, { ...merged, updatedAt: new Date().toISOString() });
  }
  return Array.from(map.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function explainInclusion(record: ExperimentResultRecord, issues: ResultValidationIssue[] = [], policy: ResultInclusionPolicy = defaultInclusionPolicy): { included: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!policy.includeStatuses.includes(record.status as any)) reasons.push(`status ${record.status} not included`);
  if (record.status === "excluded" || record.status === "parse_failed") reasons.push(`status ${record.status}`);
  if (policy.excludeTags?.some((tag) => record.tags?.includes(tag))) reasons.push("excluded tag");
  if (policy.includeTags?.length && !policy.includeTags.some((tag) => record.tags?.includes(tag))) reasons.push("missing required tag");
  if (policy.requireMetrics?.some((metric) => !record.metrics[metric])) reasons.push("missing required metric");
  if (policy.requireDimensions?.some((dimension) => record.dimensions[dimension] === undefined)) reasons.push("missing required dimension");
  if (policy.requireFinalEvidence && (String(record.finalEvidenceState || "").toLowerCase() !== "archived" || record.eligibleForFinalAnalysis === false)) reasons.push("final evidence not archived");
  const minSeverity = policy.excludeIfValidationSeverityAtLeast;
  if (minSeverity) {
    const rank = { info: 0, warning: 1, critical: 2 };
    if (issues.some((issueItem) => issueItem.resultId === record.resultId && !issueItem.ignored && rank[issueItem.severity] >= rank[minSeverity])) reasons.push(`validation ${minSeverity} or higher`);
  }
  return { included: reasons.length === 0, reasons };
}

export function filterByInclusionPolicy(records: ExperimentResultRecord[], issues: ResultValidationIssue[] = [], policy: ResultInclusionPolicy = defaultInclusionPolicy): ExperimentResultRecord[] {
  return records.filter((record) => explainInclusion(record, issues, policy).included);
}

export function aggregateMetricValues(values: number[], method: AggregationMethod, options: { higherIsBetter?: boolean; baseline?: number; weights?: number[]; confidenceLevel?: number } = {}): ResultLeaderboardRow["values"][string] {
  if (!values.length) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const mean = avg(values);
  const std = Math.sqrt(avg(values.map((value) => (value - mean) ** 2)));
  if (method === "raw") return { raw: values };
  if (method === "best") return { best: options.higherIsBetter === false ? sorted[0] : sorted[sorted.length - 1] };
  if (method === "last") return { best: values[values.length - 1] };
  if (method === "median_iqr") return { median: percentile(sorted, 0.5), raw: [percentile(sorted, 0.25), percentile(sorted, 0.75)] };
  if (method === "mean_ci95") return { mean, std: 1.96 * std / Math.sqrt(values.length) };
  if (method === "weighted_mean" && options.weights?.length === values.length) {
    const weightSum = options.weights.reduce((a, b) => a + b, 0);
    return { mean: weightSum ? values.reduce((sum, value, index) => sum + value * options.weights![index], 0) / weightSum : mean, std };
  }
  if (method === "relative_improvement" && Number.isFinite(options.baseline)) {
    const baseline = Number(options.baseline);
    return { mean: baseline === 0 ? NaN : ((mean - baseline) / Math.abs(baseline)) * 100, std };
  }
  if (method === "paired_diff" && Number.isFinite(options.baseline)) return { mean: mean - Number(options.baseline), std };
  return { mean, std };
}

export function buildAdvancedLeaderboard(records: ExperimentResultRecord[], config: LeaderboardConfig & { aggregation?: AggregationConfig }, issues: ResultValidationIssue[] = [], policy?: ResultInclusionPolicy): ResultLeaderboardRow[] {
  const filtered = policy ? filterByInclusionPolicy(records, issues, policy) : records;
  const base = buildResultLeaderboard(filtered, { ...config, aggregate: config.aggregate === "mean_ci95" ? "mean_std" : config.aggregate }, []);
  if (!config.aggregation || !["relative_improvement", "paired_diff", "weighted_mean", "mean_ci95"].includes(config.aggregation.method)) return base;
  const baseline = findBaseline(records, config.aggregation.baselineFilter, config.metrics[0]?.key);
  const itemsByGroup = new Map<string, ExperimentResultRecord[]>();
  for (const record of filtered) {
    const groupKey = config.groupBy.map((key) => String(record.dimensions[key] ?? record[key as keyof ExperimentResultRecord] ?? "")).join(" | ");
    const items = itemsByGroup.get(groupKey);
    if (items) items.push(record);
    else itemsByGroup.set(groupKey, [record]);
  }
  return base.map((row) => {
    const items = itemsByGroup.get(row.groupKey) || [];
    const values: ResultLeaderboardRow["values"] = {};
    for (const metric of config.metrics) {
      const nums = items.map((item) => Number(item.metrics[metric.key]?.value)).filter(Number.isFinite);
      const weights = config.aggregation?.weightDimension ? items.map((item) => Number(item.dimensions[config.aggregation!.weightDimension!])).filter(Number.isFinite) : undefined;
      values[metric.key] = aggregateMetricValues(nums, config.aggregation!.method, { higherIsBetter: metric.higherIsBetter, baseline, weights });
    }
    return { ...row, values };
  }).sort((a, b) => sortLeaderboard(a, b, config));
}

export function renderPaperTableTemplate(records: ExperimentResultRecord[], schema: ResultSchema, template: PaperTableTemplate, format: "markdown" | "csv" | "latex_tabular" | "latex_booktabs" | "json" = "markdown"): string {
  const schemaMetricsByKey = new Map<string, ResultMetricDefinition>();
  for (const metric of schema.metrics) {
    if (!schemaMetricsByKey.has(metric.key)) schemaMetricsByKey.set(metric.key, metric);
  }
  const leaderboard: LeaderboardConfig = {
    id: template.source.leaderboardId || `${template.id}_leaderboard`,
    name: template.name,
    filter: { includeWarnings: true },
    groupBy: template.layout.rows,
    metrics: template.layout.metrics.map((key) => {
      const metric = schemaMetricsByKey.get(key);
      return { key, label: template.formatting.metricLabels[key] || metric?.label || key, higherIsBetter: metric?.higherIsBetter !== false, decimals: template.formatting.decimals[key] ?? metric?.decimals ?? 4 };
    }),
    aggregate: template.formatting.valueFormat === "mean_ci" ? "mean_ci95" : template.formatting.valueFormat === "raw" ? "raw" : "mean_std",
    primarySortMetric: template.layout.metrics[0],
  };
  const rows = buildAdvancedLeaderboard(records, leaderboard, [], finalResultInclusionPolicy);
  if (format === "json") return JSON.stringify({ template, rows }, null, 2);
  if (format === "csv") return leaderboardToCsv(rows, leaderboard);
  const table: PaperTableConfig = { id: template.id, title: template.name, leaderboardId: leaderboard.id, rowDimension: template.layout.rows[0] || "method", metrics: template.layout.metrics, boldBest: template.formatting.boldBest, underlineSecondBest: template.formatting.underlineSecondBest, showMeanStd: template.formatting.valueFormat !== "raw", decimals: template.formatting.decimals, metricDisplayNames: template.formatting.metricLabels, methodDisplayNames: template.formatting.dimensionLabels };
  return exportPaperTable(rows, leaderboard, table, format === "latex_booktabs" ? "latex_booktabs" : format === "latex_tabular" ? "latex" : "markdown");
}

export function buildResultDashboard(records: ExperimentResultRecord[], issues: ResultValidationIssue[] = [], schema?: ResultSchema): ResultDashboardSummary {
  const primary = schema?.display?.defaultSortMetric || schema?.metrics.find((item) => item.primary)?.key || records[0]?.primaryMetric || "DSC";
  const primaryDefinition = schema?.metrics.find((metric) => metric.key === primary);
  const experimentIds = new Set<string>();
  const bestBySuite = new Map<string, { record: ExperimentResultRecord; value: number } | null>();
  let parsedResults = 0;
  let parseFailed = 0;
  let paperCandidates = 0;
  for (const record of records) {
    experimentIds.add(record.experimentId);
    if (record.status === "parsed" || record.status === "validated" || record.status === "warning" || record.status === "manual_verified") parsedResults += 1;
    if (record.status === "parse_failed") parseFailed += 1;
    if (record.paperCandidate || record.tags?.includes("paper-candidate")) paperCandidates += 1;
    if (!bestBySuite.has(record.suite)) bestBySuite.set(record.suite, null);
    const value = Number(record.metrics[primary]?.value);
    if (!Number.isFinite(value)) continue;
    const current = bestBySuite.get(record.suite);
    if (!current || (primaryDefinition?.higherIsBetter === false ? value < current.value : value > current.value)) bestBySuite.set(record.suite, { record, value });
  }
  return {
    totalExperiments: experimentIds.size,
    parsedResults,
    parseFailed,
    validationWarnings: issues.filter((issue) => issue.severity === "warning" && !issue.ignored).length,
    paperCandidates,
    bestBySuite: Array.from(bestBySuite.entries()).map(([suite, best]) => best ? { suite, metric: primary, resultId: best.record.resultId, value: best.value } : { suite, metric: primary, resultId: "", value: NaN }),
    coverage: coverageSummary(records, schema),
  };
}

export function filterResultsByDsl(records: ExperimentResultRecord[], query: string, issues: ResultValidationIssue[] = []): ExperimentResultRecord[] {
  const orParts = query.split(/\s+OR\s+/i).map((part) => part.trim()).filter(Boolean);
  if (!orParts.length) return records;
  return records.filter((record) => orParts.some((part) => part.split(/\s+AND\s+|\s+/i).filter(Boolean).every((token) => matchDslToken(record, token, issues))));
}

export function exportResultBundle(input: { schemas?: ResultSchema[]; presets?: ResultParserPreset[]; templates?: PaperTableTemplate[]; records?: ExperimentResultRecord[] }, options: { includeValues?: boolean } = {}): string {
  const records = options.includeValues === false ? input.records?.map((record) => ({ ...record, metrics: {} })) : input.records;
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), ...input, records }, null, 2);
}

export function importResultBundle<T extends { id?: string; resultId?: string }>(existing: T[], incoming: T[], strategy: "merge" | "replace" | "skip" = "merge"): T[] {
  if (strategy === "replace") return [...incoming];
  const keyOf = (item: T) => item.id || item.resultId || JSON.stringify(item);
  const map = new Map(existing.map((item) => [keyOf(item), item]));
  for (const item of incoming) {
    const key = keyOf(item);
    if (strategy === "skip" && map.has(key)) continue;
    map.set(key, { ...(map.get(key) as any), ...item });
  }
  return Array.from(map.values());
}

export function checkResultConsistency(input: { records: ExperimentResultRecord[]; schemas?: ResultSchema[]; presets?: ResultParserPreset[]; leaderboards?: LeaderboardConfig[]; paperTables?: PaperTableConfig[]; experimentIds?: string[] }): ResultConsistencyIssue[] {
  const issues: ResultConsistencyIssue[] = [];
  const seen = new Set<string>();
  const schemaIds = new Set((input.schemas || []).map((item) => item.id));
  const presetIds = new Set((input.presets || []).map((item) => item.id));
  const metricKeys = new Set((input.schemas || []).flatMap((schema) => schema.metrics.map((metric) => metric.key)));
  for (const record of input.records) {
    if (seen.has(record.resultId)) issues.push(consistency("duplicate_result", "critical", "Duplicate resultId", "Merge or rename duplicate result", record.resultId));
    seen.add(record.resultId);
    if (input.experimentIds && !input.experimentIds.includes(record.experimentId)) issues.push(consistency("missing_experiment", "warning", "Experiment not found", "Check registry/runKey mapping", record.resultId));
    if (record.schemaId && input.schemas && !schemaIds.has(record.schemaId)) issues.push(consistency("missing_schema", "warning", "Result schema not found", "Import schema or change schemaId", record.resultId));
    if (record.parserPresetId && input.presets && !presetIds.has(record.parserPresetId)) issues.push(consistency("missing_preset", "warning", "Parser preset not found", "Import preset or reparse with existing preset", record.resultId));
    for (const metric of Object.keys(record.metrics)) {
      if (metricKeys.size && !metricKeys.has(metric)) issues.push(consistency("unknown_metric", "info", `Metric not in schema: ${metric}`, "Add metric definition or alias", record.resultId));
    }
  }
  for (const leaderboard of input.leaderboards || []) {
    for (const metric of leaderboard.metrics) if (metricKeys.size && !metricKeys.has(metric.key)) issues.push(consistency("leaderboard_metric", "warning", `Leaderboard metric not in schema: ${metric.key}`, "Update leaderboard config", undefined, leaderboard.id));
  }
  for (const table of input.paperTables || []) {
    for (const metric of table.metrics) if (metricKeys.size && !metricKeys.has(metric)) issues.push(consistency("paper_metric", "warning", `Paper table metric not in schema: ${metric}`, "Update paper table config", undefined, table.id));
  }
  return issues;
}

function preset(id: string, name: string, format: ResultParserPreset["format"], metricDirections: Record<string, "higher" | "lower">, metricColumns: string[]): ResultParserPreset {
  return {
    id,
    name,
    format,
    filePatterns: ["results*.csv", "metrics*.csv", "*.metrics.csv", "*.json"],
    columnMapping: {
      experimentId: "experiment_id",
      attemptId: "attempt_id",
      suite: "suite",
      runKey: "run_key",
      dataset: "dataset",
      split: "split",
      fold: "fold",
      seed: "seed",
      metric: "metric",
      value: "value",
      epoch: "epoch",
      step: "step",
      timestamp: "timestamp",
    },
    metricColumns,
    metricAliases: {
      Dice: "DSC", dice: "DSC", acc: "accuracy", top1: "top1_accuracy", top_1: "top1_accuracy", top1_acc: "top1_accuracy",
      top5: "top5_accuracy", top_5: "top5_accuracy", top5_acc: "top5_accuracy", auc: "AUC", auroc: "AUC", roc_auc: "AUC",
      average_precision: "AUPRC", ap: "AUPRC", pr_auc: "AUPRC", auprc: "AUPRC", macro_f1: "F1", micro_f1: "F1",
      weighted_f1: "F1", f1_macro: "F1", f1_micro: "F1", f1_weighted: "F1", macro_precision: "precision", micro_precision: "precision",
      weighted_precision: "precision", macro_recall: "recall", micro_recall: "recall", weighted_recall: "recall", bal_acc: "balanced_accuracy",
      balanced_acc: "balanced_accuracy", sensitivity: "recall", tpr: "recall", ppv: "precision", tnr: "specificity", mcc: "MCC",
      matthews_corrcoef: "MCC", cohen_kappa: "kappa", brier_score: "brier", log_loss: "loss", cross_entropy: "loss", ce_loss: "loss",
    },
    metricDirections,
    requiredColumns: format === "long_csv" ? ["metric", "value"] : [],
    finalRowSelector: { type: "step_equals", column: "step", value: "final" },
    groupByDefaults: ["suite", "dataset", "method", "seed", "fold"],
    primaryMetric: metricColumns[0],
  };
}

function inferWideMetricColumns(headers: string[], rows: Record<string, string>[], dimensionColumns: Set<string>, preset: ResultParserPreset, parserConfig: ResultParserConfig): string[] {
  if (parserConfig.metricColumns?.length) return parserConfig.metricColumns;
  const configured = new Set((preset.metricColumns || []).map((item) => item.toLowerCase()));
  return headers.filter((header) => {
    if (dimensionColumns.has(header)) return false;
    const sample = rows.find((row) => row[header] !== undefined && row[header] !== "")?.[header];
    if (!Number.isFinite(Number(sample))) return false;
    if (!configured.size) return true;
    const info = metricFromName(header, preset);
    return configured.has(header.toLowerCase()) || info.metric !== header || configured.has(info.metric.toLowerCase());
  });
}

function parseLongRows(rows: Record<string, string>[], sourceFile: ExperimentResultRecord["sourceFiles"][number], preset: ResultParserPreset, parserConfig: ResultParserConfig): ExperimentResultRecord[] {
  const map = new Map<string, ExperimentResultRecord>();
  for (const [index, row] of rows.entries()) {
    const m = { ...preset.columnMapping, ...parserConfig.columnMapping };
    const rawMetric = String(row[m.metric || "metric"] || "").trim();
    const value = finiteMetricNumber(row[m.value || "value"]);
    if (!rawMetric || value === undefined) continue;
    const metricInfo = metricFromName(rawMetric, preset);
    const ids = idsFromRow(row, m, sourceFile.path, index);
    const record = map.get(ids.resultId) || baseRecord(ids, sourceFile, preset, parserConfig, row, m);
    const metric = metricStorageKey(record.metrics, metricInfo.metric, metricInfo.split, rawMetric);
    record.metrics[metric] = metricValue(value, metric, row, m, sourceFile.path, preset, metricInfo.split);
    record.dimensions = { ...record.dimensions, ...dimensionsFromRow(row, parserConfig.dimensions || [], sourceFile.path), ...standardDimensions(row, m) };
    finalizeRecordSemantics(record);
    map.set(ids.resultId, record);
  }
  return Array.from(map.values());
}

function parseWideRows(rows: Record<string, string>[], headers: string[], sourceFile: ExperimentResultRecord["sourceFiles"][number], preset: ResultParserPreset, parserConfig: ResultParserConfig): ExperimentResultRecord[] {
  const m = { ...preset.columnMapping, ...parserConfig.columnMapping };
  const dimensionColumns = new Set(Object.values(m).filter(Boolean));
  const metricColumns = inferWideMetricColumns(headers, rows, dimensionColumns, preset, parserConfig);
  return rows.map((row, index) => {
    const ids = idsFromRow(row, m, sourceFile.path, index);
    const record = baseRecord(ids, sourceFile, preset, parserConfig, row, m);
    for (const column of metricColumns) {
      const metricInfo = metricFromName(column, preset);
      const value = finiteMetricNumber(row[column]);
      if (value === undefined) continue;
      const metric = metricStorageKey(record.metrics, metricInfo.metric, metricInfo.split, column);
      record.metrics[metric] = metricValue(value, metric, row, { ...m, value: column }, sourceFile.path, preset, metricInfo.split);
    }
    record.dimensions = { ...record.dimensions, ...dimensionsFromRow(row, parserConfig.dimensions || [], sourceFile.path), ...standardDimensions(row, m) };
    finalizeRecordSemantics(record);
    return record;
  });
}

function parseJsonResult(text: string, sourceFile: ExperimentResultRecord["sourceFiles"][number], preset: ResultParserPreset, parserConfig: ResultParserConfig): ExperimentResultRecord[] {
  const parsed = JSON.parse(text);
  const rows = normalizeJsonResultRows(parsed).map(normalizeJsonResultRow);
  return rows.map((row: Record<string, any>, index) => {
    const m = { ...preset.columnMapping, ...parserConfig.columnMapping };
    const ids = idsFromRow(row, m, sourceFile.path, index);
    const record = baseRecord(ids, sourceFile, preset, parserConfig, row, m);
    for (const [metric, raw] of Object.entries(jsonMetricObject(row, m))) {
      const value = parseValue(raw);
      if (typeof value === "number") {
        const metricInfo = metricFromName(metric, preset);
        const key = metricStorageKey(record.metrics, metricInfo.metric, metricInfo.split, metric);
        record.metrics[key] = metricValue(value, key, row, m, sourceFile.path, preset, metricInfo.split);
      }
    }
    finalizeRecordSemantics(record);
    return record;
  }).filter((record) => Object.keys(record.metrics || {}).length > 0);
}

function normalizeJsonResultRows(parsed: unknown): Record<string, any>[] {
  if (Array.isArray(parsed)) return parsed.filter((item) => item && typeof item === "object");
  const root = parsed as Record<string, unknown> | undefined;
  for (const key of ["results", "records", "runs", "items"]) {
    if (Array.isArray(root?.[key])) return (root[key] as unknown[]).filter((item) => item && typeof item === "object") as Record<string, any>[];
  }
  return root && typeof root === "object" ? [root] : [];
}

function normalizeJsonResultRow(row: Record<string, any>): Record<string, any> {
  const out = { ...row };
  const aliases: Record<string, string[]> = {
    experiment_id: ["experiment_id", "experimentId", "id"], run_key: ["run_key", "runKey", "run_id", "runId", "id"],
    experiment_name: ["experiment_name", "experimentName"], suite: ["suite", "study"], method: ["method", "approach", "algorithm"],
    dataset: ["dataset", "data_name", "dataName"], split: ["split", "partition"], fold: ["fold", "cv_fold", "cvFold"],
    seed: ["seed", "random_seed", "randomSeed"], case: ["case", "case_name", "caseName", "case_id", "caseId"],
    model: ["model", "model_name", "modelName"], tag: ["tag", "variant", "label"],
  };
  for (const containerName of ["dimensions", "metadata", "config", "params", "run", "context"]) {
    const container = row[containerName];
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const [target, candidates] of Object.entries(aliases)) {
      if (out[target] !== undefined && out[target] !== "") continue;
      const value = candidates.map((key) => container[key]).find(jsonScalarPresent);
      if (value !== undefined) out[target] = value;
    }
  }
  const model = row.model;
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const modelName = [model.name, model.type, model.model_name, model.modelName].find(jsonScalarPresent);
    if (modelName !== undefined) {
      if (out.model === undefined || typeof out.model === "object") out.model = modelName;
      if (out.method === undefined || out.method === "") out.method = modelName;
    }
  }
  return out;
}

const jsonNonMetricNames = new Set([
  "experiment_id", "experimentid", "attempt_id", "attemptid", "run_key", "runkey", "run_id", "runid", "suite", "method", "dataset", "split", "fold", "seed", "case", "model", "tag", "index",
  "experiment_index", "job_index", "job_count", "gpu_id", "gpu", "pid", "exit_code", "status", "state", "epoch", "step", "timestamp", "output_dir", "log_path",
  "command",
]);

function jsonMetricObject(row: Record<string, any>, m: ResultParserPreset["columnMapping"]): Record<string, unknown> {
  for (const key of ["metrics", "metric_values", "scores", "summary", "results"]) {
    if (row[key] && typeof row[key] === "object") {
      const entries = jsonMetricEntries(row[key], [key]).filter((entry) => jsonMetricNameAllowed(entry.name));
      if (entries.length) return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
    }
  }
  const dimensionKeys = new Set(Object.values(m).filter(Boolean));
  return Object.fromEntries(Object.entries(row).filter(([key, value]) => !dimensionKeys.has(key) && !jsonNonMetricNames.has(key.toLowerCase()) && finiteMetricNumber(value) !== undefined));
}

function jsonMetricNameAllowed(name: string): boolean {
  const normalized = String(name || "").toLowerCase().replace(/^(?:train|val|valid|validation|test|external|ext)[_.-]+/, "");
  return !jsonNonMetricNames.has(normalized);
}

function jsonMetricEntries(value: any, path: string[] = [], out: Array<{ name: string; value: unknown }> = [], depth = 0): Array<{ name: string; value: unknown }> {
  if (depth > 8 || out.length >= 200 || value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const name = item.metric ?? item.metric_name ?? item.metricName ?? item.name ?? item.key ?? item.label;
      const raw = item.value ?? item.score ?? item.result ?? item.val;
      if (jsonScalarPresent(name) && jsonScalarPresent(raw)) out.push({ name: jsonMetricNameWithContext(name, item), value: raw });
      else jsonMetricEntries(item, path, out, depth + 1);
    }
    return out;
  }
  if (typeof value === "object") {
    const name = value.metric ?? value.metric_name ?? value.metricName ?? value.name ?? value.key ?? value.label;
    const raw = value.value ?? value.score ?? value.result ?? value.val;
    if (jsonScalarPresent(name) && jsonScalarPresent(raw)) {
      out.push({ name: jsonMetricNameWithContext(name, value), value: raw });
      return out;
    }
    for (const [key, child] of Object.entries(value)) jsonMetricEntries(child, [...path, key], out, depth + 1);
    return out;
  }
  if (finiteMetricNumber(value) === undefined || !path.length) return out;
  const leaf = path[path.length - 1];
  const split = [...path.slice(0, -1)].reverse().find((item) => /^(train|val|valid|validation|test|external|ext)$/i.test(item));
  out.push({ name: split ? `${split}_${leaf}` : leaf, value });
  return out;
}

function jsonMetricNameWithContext(name: unknown, item: Record<string, any>): string {
  const value = String(name || "");
  const split = item.split ?? item.partition ?? item.phase ?? item.stage;
  return !jsonScalarPresent(split) || /^(?:train|val|valid|validation|test|external|ext)[_.-]/i.test(value) ? value : `${split}_${value}`;
}

function jsonScalarPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "" && (typeof value !== "object" || value instanceof Date);
}

function jsonPreviewColumns(text: string): string[] {
  try {
    const rows = normalizeJsonResultRows(JSON.parse(text)).map(normalizeJsonResultRow);
    const keys = new Set<string>();
    for (const row of rows.slice(0, 5)) {
      for (const key of Object.keys(row)) keys.add(key);
      for (const key of Object.keys(jsonMetricObject(row, {}))) keys.add(`metrics.${key}`);
    }
    return Array.from(keys);
  } catch {
    return [];
  }
}

function baseRecord(ids: ReturnType<typeof idsFromRow>, sourceFile: ExperimentResultRecord["sourceFiles"][number], preset: ResultParserPreset, parserConfig: ResultParserConfig, row: Record<string, any>, m: ResultParserPreset["columnMapping"]): ExperimentResultRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    resultId: ids.resultId,
    experimentId: ids.experimentId,
    attemptId: ids.attemptId,
    runKey: ids.runKey,
    suite: ids.suite,
    experimentName: ids.experimentName,
    status: "parsed",
    sourceFiles: [{ ...sourceFile, sha256: sourceFile.sha256 || sha256(sourceFile.path) }],
    parserPresetId: preset.id,
    parserConfig,
    metrics: {},
    dimensions: standardDimensions(row, m),
    primaryMetric: preset.primaryMetric,
    higherIsBetter: preset.primaryMetric ? directionFor(preset.primaryMetric, preset) !== "lower" : true,
    parsedAt: now,
    createdAt: now,
    updatedAt: now,
    provenance: {},
    notes: ids.inferred ? "experiment_id inferred from path/runKey" : undefined,
  };
}

function idsFromRow(row: Record<string, any>, m: ResultParserPreset["columnMapping"], sourcePath: string, index = 0) {
  const explicitRunKey = String(row[m.runKey || "run_key"] || row.runKey || "").trim();
  const explicitExperimentId = String(row[m.experimentId || "experiment_id"] || row.experimentId || "").trim();
  const inferredIdentity = inferredResultIdentity(row, m, sourcePath, index);
  const runKey = explicitRunKey || explicitExperimentId || inferredIdentity;
  const experimentId = explicitExperimentId || runKey;
  const attemptId = String(row[m.attemptId || "attempt_id"] || row.attemptId || "attempt-1");
  const suite = String(row[m.suite || "suite"] || inferSuite(sourcePath));
  const experimentName = String(row.experiment_name || row.experimentName || runKey);
  const variant = explicitExperimentId || explicitRunKey ? explicitResultVariantSuffix(row, m) : "";
  return { resultId: [experimentId, attemptId, runKey, variant].filter(Boolean).join(":"), experimentId, attemptId, runKey, suite, experimentName, inferred: !explicitExperimentId };
}

function explicitResultVariantSuffix(row: Record<string, any>, m: ResultParserPreset["columnMapping"]): string {
  const parts: string[] = [];
  for (const key of ["method", "dataset", "split", "fold", "seed"]) {
    const mapped = (m as Record<string, string | undefined>)[key];
    const value = row[mapped || key] ?? row[key] ?? row[key.replace(/_([a-z])/g, (_, char) => String(char).toUpperCase())];
    if (value !== undefined && value !== "") parts.push(`${key}=${String(value)}`);
  }
  return parts.join("|");
}

function inferredResultIdentity(row: Record<string, any>, m: ResultParserPreset["columnMapping"], sourcePath: string, index: number): string {
  const parts: string[] = [];
  for (const key of ["suite", "method", "dataset", "split", "fold", "seed", "case", "case_name", "model", "tag", "config", "variant"]) {
    const mapped = (m as Record<string, string | undefined>)[key];
    const value = row[mapped || key] ?? row[key] ?? row[key.replace(/_([a-z])/g, (_, char) => String(char).toUpperCase())];
    if (value !== undefined && value !== "") parts.push(`${key}=${String(value)}`);
  }
  const base = inferRunKey(sourcePath) || sourcePath.replace(/\.[^.]+$/, "");
  return parts.length ? `${base}:${parts.join("|")}` : `${base}:row${index + 1}`;
}

function finalizeRecordSemantics(record: ExperimentResultRecord): void {
  const metrics = Object.keys(record.metrics || {});
  const classification = metrics.filter(isClassificationMetric);
  const segmentation = metrics.filter(isSegmentationMetric);
  if (classification.length) {
    record.schemaId = "classification";
    record.primaryMetric = firstExistingMetric(record.metrics, ["AUC", "accuracy", "F1", "AUPRC", ...classification]) || record.primaryMetric;
  } else if (segmentation.length) {
    record.schemaId = "medical_segmentation";
    record.primaryMetric = firstExistingMetric(record.metrics, ["DSC", "IoU", "HD95", "ASD", ...segmentation]) || record.primaryMetric;
    if (record.parserPresetId?.startsWith("classification")) record.notes = appendNote(record.notes, "检测到分割指标，已按 medical_segmentation 语义处理；若这是分类实验，请在 simple_project.yaml 配置 metricAliases。");
  }
  if (record.primaryMetric) record.higherIsBetter = directionFor(record.primaryMetric, builtInResultPresets.find((item) => item.id === record.parserPresetId) || builtInResultPresets[0]) !== "lower";
  if (record.notes?.includes("experiment_id inferred")) record.notes = record.notes.replace("experiment_id inferred from path/runKey", "缺少 experiment_id (inferred)，已按路径、维度或行号生成临时记录；建议在 metrics_summary.csv 中补充 experiment_id，避免共享 CSV 合并。");
}

function metricValue(value: ResultMetricValue["value"], metric: string, row: Record<string, any>, m: ResultParserPreset["columnMapping"], sourceFile: string, preset: ResultParserPreset, split?: string): ResultMetricValue {
  return {
    value,
    unit: row.unit || undefined,
    higherIsBetter: directionFor(metric, preset) !== "lower",
    sourceColumn: m.value,
    sourceFile,
    split: split || row[m.split || "split"] || undefined,
    dataset: row[m.dataset || "dataset"] || undefined,
    fold: row[m.fold || "fold"] || undefined,
    seed: row[m.seed || "seed"] || undefined,
  };
}

function standardDimensions(row: Record<string, any>, m: ResultParserPreset["columnMapping"]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of ["suite", "method", "dataset", "split", "fold", "seed", "case", "model", "tag"]) {
    const mapped = (m as Record<string, string | undefined>)[key];
    const camel = key.replace(/_([a-z])/g, (_, char) => String(char).toUpperCase());
    const value = row[mapped || key] ?? row[key] ?? row[camel];
    if (value !== undefined && value !== "") out[key] = parseDimensionValue(value);
  }
  return out;
}

function dimensionsFromRow(row: Record<string, string>, configs: ResultDimensionConfig[], sourcePath: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const config of configs) {
    const value = extractDimension(row, config, { sourcePath });
    if (value !== undefined) out[config.key] = value;
  }
  return out;
}

function checkMetric(value: ResultMetricValue["value"], check: ResultValidationRule["check"]): boolean {
  if (check.type === "not_null") return value !== null && value !== undefined && value !== "";
  if (check.type === "is_finite_number") return Number.isFinite(Number(value));
  if (check.type === "range") {
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    if (check.min !== undefined && n < check.min) return false;
    if (check.max !== undefined && n > check.max) return false;
    return true;
  }
  return true;
}

function issue(record: ExperimentResultRecord, id: string, metric: string | undefined, severity: ResultValidationIssue["severity"], message: string, evidence?: unknown): ResultValidationIssue {
  return { id: `${record.resultId}:${id}:${metric || ""}`, resultId: record.resultId, metric, severity, message, evidence };
}

function dimensionMatches(record: ExperimentResultRecord, filter: ResultValidationRule["dimensionFilter"]): boolean {
  return !filter || Object.entries(filter).every(([key, value]) => record.dimensions[key] === value);
}

function aggregate(values: number[], mode: LeaderboardConfig["aggregate"]): ResultLeaderboardRow["values"][string] {
  if (!values.length) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const mean = avg(values);
  const std = Math.sqrt(avg(values.map((value) => (value - mean) ** 2)));
  if (mode === "best") return { best: sorted[sorted.length - 1] };
  if (mode === "last") return { best: values[values.length - 1] };
  if (mode === "mean_ci95" || mode === "mean_ci") return { mean, std: 1.96 * std / Math.sqrt(values.length) };
  if (mode === "median_iqr") return { median: sorted[Math.floor(sorted.length / 2)] };
  if (mode === "raw") return { raw: values };
  return { mean, std };
}

function sortLeaderboard(a: ResultLeaderboardRow, b: ResultLeaderboardRow, config: LeaderboardConfig): number {
  const metric = config.primarySortMetric || config.metrics[0]?.key;
  if (!metric) return a.groupKey.localeCompare(b.groupKey);
  const direction = config.metrics.find((item) => item.key === metric)?.higherIsBetter === false ? 1 : -1;
  return direction * ((a.values[metric]?.mean ?? a.values[metric]?.best ?? -Infinity) - (b.values[metric]?.mean ?? b.values[metric]?.best ?? -Infinity));
}

function withBestFormatting(rows: ResultLeaderboardRow[], leaderboard: LeaderboardConfig, table: PaperTableConfig, latex: boolean): ResultLeaderboardRow[] {
  if (!table.boldBest) return rows;
  const copy = rows.map((row) => ({ ...row, values: { ...row.values } }));
  for (const metric of table.metrics) {
    const cfg = leaderboard.metrics.find((item) => item.key === metric);
    const scored = copy.map((row) => ({ row, value: row.values[metric]?.mean ?? row.values[metric]?.best })).filter((item) => Number.isFinite(item.value as number)).sort((a, b) => cfg?.higherIsBetter === false ? Number(a.value) - Number(b.value) : Number(b.value) - Number(a.value));
    if (scored[0]) (scored[0].row.values[metric] as any).decorator = latex ? "latex_bold" : "bold";
  }
  return copy;
}

function formatAggregate(value: ResultLeaderboardRow["values"][string] | undefined, decimals = 4): string {
  if (!value) return "-";
  const fmt = (n?: number) => Number.isFinite(n) ? Number(n).toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "") : "-";
  const body = value.mean !== undefined ? `${fmt(value.mean)} ± ${fmt(value.std)}` : value.best !== undefined ? fmt(value.best) : value.median !== undefined ? fmt(value.median) : value.raw?.join(";") || "-";
  const decorator = (value as any).decorator;
  if (decorator === "latex_bold") return `\\textbf{${body}}`;
  if (decorator === "bold") return `**${body}**`;
  return body;
}

function applyFilters(rows: Record<string, string>[], preset: ResultParserPreset): Record<string, string>[] {
  return rows.filter((row) => (preset.filters || []).every((filter) => {
    const value = row[filter.column] || "";
    if (filter.op === "==") return value === filter.value;
    if (filter.op === "!=") return value !== filter.value;
    if (filter.op === "contains") return value.includes(String(filter.value));
    if (filter.op === "in") return Array.isArray(filter.value) && filter.value.includes(value);
    if (filter.op === "not_in") return Array.isArray(filter.value) && !filter.value.includes(value);
    return true;
  }));
}

function finalRows(rows: Record<string, string>[], preset: ResultParserPreset): Record<string, string>[] {
  const selector = preset.finalRowSelector;
  if (!selector || !rows.length) return rows;
  if (selector.type === "step_equals" && selector.column && rows.some((row) => row[selector.column!] === String(selector.value))) return rows.filter((row) => row[selector.column!] === String(selector.value));
  if (selector.type === "max_epoch" || selector.type === "last_epoch") {
    const column = selector.column || "epoch";
    const max = Math.max(...rows.map((row) => Number(row[column])).filter(Number.isFinite));
    if (Number.isFinite(max)) return rows.filter((row) => Number(row[column]) === max);
  }
  if (selector.type === "column_filter" && selector.column) return rows.filter((row) => row[selector.column!] === String(selector.value));
  return rows;
}

function isLongFormat(headers: string[], preset: ResultParserPreset): boolean {
  return preset.format === "long_csv" || (headers.includes(preset.columnMapping.metric || "metric") && headers.includes(preset.columnMapping.value || "value"));
}

function csvRows(text: string): string[][] {
  return text.trim().split(/\r?\n/).filter(Boolean).map(parseCsvLine);
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
    else if (ch === '"') quote = !quote;
    else if (ch === "," && !quote) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseValue(value: unknown): ResultMetricValue["value"] {
  if (value === "" || value === undefined) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value);
}

function compileTextMetricPattern(pattern?: string): RegExp | undefined {
  if (!pattern?.trim()) return undefined;
  try {
    const compiled = new RegExp(pattern, "gi");
    const groupNames = new Set(Array.from(pattern.matchAll(/\?<([A-Za-z0-9_]+)>/g)).map((match) => match[1]));
    return groupNames.has("metric") && groupNames.has("value") ? compiled : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTextMetricName(metric: string, aliases: Record<string, string> = {}): string {
  const value = metric.trim();
  const lower = value.toLowerCase();
  const custom = aliases[value] || Object.entries(aliases).find(([key]) => key.toLowerCase() === lower)?.[1];
  if (custom) return custom;
  if (lower === "acc") return "accuracy";
  if (lower === "dice") return "DSC";
  if (lower === "dsc") return "DSC";
  if (lower === "auroc" || lower === "roc_auc") return "AUC";
  return value;
}

function compactSnippet(line: string): string {
  const text = line.trim().replace(/\s+/g, " ");
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseDimensionValue(value: unknown): string | number | boolean {
  return coerceDimension(value, "string");
}

function finiteMetricNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resultInputWarnings(rows: string[][], headers: string[], preset: ResultParserPreset, parserConfig: ResultParserConfig): string[] {
  if (!isLongFormat(headers, preset)) return [];
  const mapping = { ...preset.columnMapping, ...parserConfig.columnMapping };
  const metricIndex = headers.indexOf(mapping.metric || "metric");
  const valueIndex = headers.indexOf(mapping.value || "value");
  if (metricIndex < 0 || valueIndex < 0) return [];
  const missingMetric = rows.filter((row) => !String(row[metricIndex] || "").trim()).length;
  const invalidValue = rows.filter((row) => String(row[metricIndex] || "").trim() && finiteMetricNumber(row[valueIndex]) === undefined).length;
  return [
    ...(missingMetric ? [`已跳过 ${missingMetric} 行空指标名。`] : []),
    ...(invalidValue ? [`已跳过 ${invalidValue} 行空值或非有限数值指标。`] : []),
  ];
}

function coerceDimension(value: unknown, type: ResultDimensionConfig["type"]): string | number | boolean {
  if (type === "number") return Number(value);
  if (type === "boolean") return value === true || String(value).toLowerCase() === "true";
  return String(value);
}

const splitNameMap: Record<string, string> = {
  train: "train", val: "val", valid: "val", validation: "val", test: "test", external: "external", ext: "external",
};

const metricDecorators = new Set(["best", "final", "last", "mean", "avg", "average", "eval", "score", "metric", "macro", "micro", "weighted"]);
const segmentationMetricNames = new Set(["DSC", "Dice", "IoU", "HD95", "ASD"]);

function normalizeMetricToken(metric: string, aliases: Record<string, string> = {}): { metric: string; split?: string } {
  const value = metric.trim();
  if (!value) return { metric: "" };
  const direct = aliases[value] || Object.entries(aliases).find(([key]) => key.toLowerCase() === value.toLowerCase())?.[1];
  if (direct && direct !== value) {
    const sourceSplit = splitFromMetricName(value);
    const normalized = normalizeMetricToken(direct);
    return { metric: normalized.metric, split: sourceSplit || normalized.split };
  }
  const parts = value.toLowerCase().replace(/[.\s-]+/g, "_").replace(/__+/g, "_").split("_").filter(Boolean);
  const split = extractSplit(parts);
  const candidates = [parts.join("_"), parts.filter((part) => !metricDecorators.has(part)).join("_")].filter(Boolean);
  for (const candidate of candidates) {
    const normalized = canonicalMetricName(candidate);
    if (normalized) return { metric: normalized, split };
  }
  return { metric: value, split };
}

function metricFromName(metric: string, preset: ResultParserPreset): { metric: string; split?: string } {
  return normalizeMetricToken(metric, preset.metricAliases || {});
}

function extractSplit(parts: string[]): string | undefined {
  const first = parts[0];
  if (first && splitNameMap[first]) return splitNameMap[parts.shift() as string];
  const last = parts[parts.length - 1];
  if (last && splitNameMap[last]) return splitNameMap[parts.pop() as string];
  return undefined;
}

function splitFromMetricName(metric: string): string | undefined {
  const parts = metric.toLowerCase().replace(/[.\s-]+/g, "_").replace(/__+/g, "_").split("_").filter(Boolean);
  return splitNameMap[parts[0]] || splitNameMap[parts[parts.length - 1]];
}

function canonicalMetricName(lower: string): string | undefined {
  if (lower === "accuracy" || lower === "acc") return "accuracy";
  if (["top1", "top_1", "top1_acc", "top1_accuracy"].includes(lower)) return "top1_accuracy";
  if (["top5", "top_5", "top5_acc", "top5_accuracy"].includes(lower)) return "top5_accuracy";
  if (["auc", "auroc", "roc_auc"].includes(lower)) return "AUC";
  if (["auprc", "pr_auc", "average_precision", "ap"].includes(lower)) return "AUPRC";
  if (["f1", "macro_f1", "micro_f1", "weighted_f1", "f1_macro", "f1_micro", "f1_weighted"].includes(lower)) return "F1";
  if (["precision", "macro_precision", "micro_precision", "weighted_precision", "ppv"].includes(lower)) return "precision";
  if (["recall", "macro_recall", "micro_recall", "weighted_recall", "sensitivity", "tpr"].includes(lower)) return "recall";
  if (["specificity", "tnr"].includes(lower)) return "specificity";
  if (["balanced_accuracy", "balanced_acc", "bal_acc"].includes(lower)) return "balanced_accuracy";
  if (["mcc", "matthews_corrcoef"].includes(lower)) return "MCC";
  if (lower === "cohen_kappa") return "kappa";
  if (["npv", "ppv", "fpr", "fnr", "ece"].includes(lower)) return lower.toUpperCase();
  if (["brier", "brier_score"].includes(lower)) return "brier";
  if (["loss", "log_loss", "cross_entropy", "ce_loss"].includes(lower)) return "loss";
  if (["dice", "dsc", "mean_dice"].includes(lower)) return "DSC";
  if (lower === "iou") return "IoU";
  if (lower === "hd95" || lower === "hausdorff95") return "HD95";
  if (lower === "asd") return "ASD";
  if (["mae", "mse", "rmse"].includes(lower)) return lower.toUpperCase();
  if (lower === "r2") return "R2";
  return undefined;
}

function metricStorageKey(metrics: Record<string, ResultMetricValue>, metric: string, split: string | undefined, sourceName: string): string {
  if (!split) {
    if (metrics[metric] && sourceName && /[_-]/.test(sourceName)) {
      const prefix = sourceName.toLowerCase().replace(/[.\s-]+/g, "_").split("_").find((part) => part && !splitNameMap[part] && metricDecorators.has(part));
      if (prefix) return splitMetricKey(prefix, metric);
    }
    return metric;
  }
  const existing = metrics[metric];
  if (!existing) return metric;
  const existingSplit = String(existing.split || "").toLowerCase();
  if (!existingSplit || existingSplit === split) return metric;
  if (split === "test" || (split === "val" && existingSplit === "train")) {
    const backupKey = splitMetricKey(existingSplit, metric);
    if (!metrics[backupKey]) metrics[backupKey] = existing;
    delete metrics[metric];
    return metric;
  }
  return splitMetricKey(split, metric);
}

function alias(metric: string, preset: ResultParserPreset): string {
  return metricFromName(metric, preset).metric;
}

function metricAlias(metric: string): string {
  const normalized = normalizeMetricToken(metric).metric.toLowerCase();
  return normalized === "dice" ? "dsc" : normalized;
}

function directionFor(metric: string, preset: ResultParserPreset): "higher" | "lower" {
  const normalized = normalizeMetricToken(metric, preset.metricAliases || {}).metric;
  return preset.metricDirections?.[metric] || preset.metricDirections?.[normalized] || classificationMetricDirections[metric] || classificationMetricDirections[normalized] || segmentationMetricDirections[metric] || segmentationMetricDirections[normalized] || "higher";
}

function isCaseLevelMetricsFile(sourcePath: string): boolean {
  return sourcePath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() === "metrics_case.csv";
}

function isSegmentationMetric(metric: string): boolean {
  return segmentationMetricNames.has(metric);
}

function isClassificationMetric(metric: string): boolean {
  return Object.prototype.hasOwnProperty.call(classificationMetricDirections, metric);
}

function firstExistingMetric(metrics: Record<string, ResultMetricValue>, candidates: string[]): string | undefined {
  return candidates.find((item) => metrics[item]);
}

function appendNote(existing: string | undefined, note: string): string {
  return existing ? existing.includes(note) ? existing : `${existing}；${note}` : note;
}

function splitMetricKey(split: string, metric: string): string {
  return `${split}_${metric}`;
}

function inferRunKey(sourcePath: string): string {
  return sourcePath.replace(/\\/g, "/").split("/").slice(-3).join("/").replace(/\.[^.]+$/, "");
}

function inferSuite(sourcePath: string): string {
  return sourcePath.replace(/\\/g, "/").split("/").slice(-4, -3)[0] || "unknown";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function commonDimensions(): ResultDimensionConfig[] {
  return [
    { key: "method", label: "Method", type: "category", sources: [{ type: "csv_column", column: "method" }, { type: "regex_from_path", pattern: "(baseline|ours|fusion|ablation)", group: 1 }], defaultValue: "unknown" },
    { key: "dataset", label: "Dataset", type: "category", sources: [{ type: "csv_column", column: "dataset" }, { type: "experiment_field", field: "dimensions.dataset" }], aliases: { vindr: "VinDr", PAD: "PAD-UFES", cxr: "VinDr-CXR" } },
    { key: "split", label: "Split", type: "category", sources: [{ type: "csv_column", column: "split" }], defaultValue: "test" },
    { key: "fold", label: "Fold", type: "string", sources: [{ type: "csv_column", column: "fold" }] },
    { key: "seed", label: "Seed", type: "string", sources: [{ type: "csv_column", column: "seed" }] },
  ];
}

function metricDef(key: string, label: string, type: ResultMetricDefinition["type"], higherIsBetter: boolean, decimals: number, category: ResultMetricDefinition["category"], aliases: string[] = [], validRange?: ResultMetricDefinition["validRange"], primary = false): ResultMetricDefinition {
  return { key, label, type, higherIsBetter, decimals, category, aliases, validRange, primary };
}

function paperTemplate(id: string, name: string, rows: string[], columns: string[] | undefined, metrics: string[]): PaperTableTemplate {
  return {
    id,
    name,
    source: {},
    layout: { rows, columns, metrics },
    formatting: { decimals: Object.fromEntries(metrics.map((metric) => [metric, metric === "DSC" || metric === "accuracy" || metric === "AUC" ? 3 : 2])), metricLabels: {}, dimensionLabels: {}, valueFormat: "mean_std", boldBest: true, underlineSecondBest: true, missingValue: "-" },
    export: { formats: ["markdown", "csv", "latex_booktabs", "json"], filenamePattern: `${id}_{date}` },
  };
}

function readDimensionSource(row: Record<string, unknown>, source: NonNullable<ResultDimensionConfig["sources"]>[number], context: { sourcePath?: string; record?: ExperimentResultRecord; config?: unknown; planVariables?: Record<string, unknown> }): unknown {
  if (source.type === "csv_column") return row[source.column];
  if (source.type === "plan_variable") return context.planVariables?.[source.name];
  if (source.type === "experiment_field") return context.record ? getResultPath(context.record, source.field) : undefined;
  if (source.type === "config_path") return getUnknownPath(context.config, source.jsonPath);
  if (source.type === "regex_from_path") {
    const match = (context.sourcePath || "").match(new RegExp(source.pattern));
    if (!match) return undefined;
    if (typeof source.group === "number") return match[source.group];
    if (typeof source.group === "string") return match.groups?.[source.group];
    return match[1] || match[0];
  }
  if (source.type === "expression") return evalSmallExpression(source.expression, row, context.record);
  if (source.type === "manual") return undefined;
  return undefined;
}

function evalSmallExpression(expression: string, row: Record<string, unknown>, record?: ExperimentResultRecord): unknown {
  const match = expression.match(/^([a-zA-Z0-9_.-]+)\s*\+\s*['"]([^'"]+)['"]$/);
  if (match) return `${getUnknownPath({ row, record }, match[1]) ?? ""}${match[2]}`;
  return getUnknownPath({ row, record }, expression);
}

function getUnknownPath(source: unknown, pathValue: string): unknown {
  return pathValue.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, source);
}

function getResultPath(record: ExperimentResultRecord, pathValue: string): unknown {
  const normalized = pathValue.replace(/\[(.*?)\]/g, ".$1");
  return getUnknownPath(record, normalized);
}

function setResultPath(record: ExperimentResultRecord, pathValue: string, value: unknown): ExperimentResultRecord {
  const next: ExperimentResultRecord = { ...record, metrics: { ...record.metrics }, dimensions: { ...record.dimensions }, provenance: { ...record.provenance }, tags: record.tags ? [...record.tags] : undefined };
  const parts = pathValue.replace(/\[(.*?)\]/g, ".$1").split(".").filter(Boolean);
  let target: any = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    target[part] = Array.isArray(target[part]) ? [...target[part]] : { ...(target[part] || {}) };
    target = target[part];
  }
  target[parts[parts.length - 1]] = value;
  return next;
}

function findBaseline(records: ExperimentResultRecord[], filter: Record<string, string | number | boolean> | undefined, metric?: string): number | undefined {
  if (!filter || !metric) return undefined;
  const match = records.find((record) => Object.entries(filter).every(([key, value]) => (record.dimensions[key] ?? (record as any)[key]) === value));
  const value = match?.metrics[metric]?.value;
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function coverageSummary(records: ExperimentResultRecord[], schema?: ResultSchema): ResultDashboardSummary["coverage"] {
  const required = schema?.metrics.filter((metric) => metric.required || metric.primary).map((metric) => metric.key) || [];
  const dims = schema?.display?.defaultGroupBy || ["dataset", "method"];
  const out: ResultDashboardSummary["coverage"] = [];
  for (const dimension of dims) {
    const groups = new Map<string, ExperimentResultRecord[]>();
    for (const record of records) groups.set(String(record.dimensions[dimension] || "unknown"), [...(groups.get(String(record.dimensions[dimension] || "unknown")) || []), record]);
    for (const [value, items] of groups) {
      out.push({ dimension, value, count: items.length, missingMetrics: required.filter((metric) => items.every((record) => !record.metrics[metric])) });
    }
  }
  return out;
}

function matchDslToken(record: ExperimentResultRecord, token: string, issues: ResultValidationIssue[]): boolean {
  const comparison = token.match(/^([a-zA-Z0-9_.-]+)(>=|<=|>|<|=|:)(.+)$/);
  if (!comparison) throw new Error(`Invalid result search token: ${token}`);
  const [, key, op, raw] = comparison;
  const expected = raw.replace(/^["']|["']$/g, "");
  if (key === "tag") return record.tags?.includes(expected) || false;
  if (key === "status") return compareValue(record.status, op, expected);
  if (key === "validation") return issues.some((issue) => issue.resultId === record.resultId && issue.severity === expected);
  const value = key.startsWith("metric.") ? record.metrics[key.slice("metric.".length)]?.value : key.startsWith("dimension.") ? record.dimensions[key.slice("dimension.".length)] : record.dimensions[key] ?? (record as any)[key];
  return compareValue(value, op, expected);
}

function compareValue(value: unknown, op: string, expected: string): boolean {
  if ([">", "<", ">=", "<="].includes(op)) {
    const left = Number(value);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (op === ">") return left > right;
    if (op === "<") return left < right;
    if (op === ">=") return left >= right;
    return left <= right;
  }
  return String(value ?? "") === expected;
}

function consistency(id: string, severity: ResultConsistencyIssue["severity"], message: string, suggestion: string, resultId?: string, configId?: string): ResultConsistencyIssue {
  return { id: `${id}:${resultId || configId || ""}`, severity, resultId, configId, message, suggestion, autoFixAvailable: severity !== "critical" };
}

function globMatch(fileName: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(fileName.split(/[\\/]/).pop() || fileName);
}

function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function displayName(value: string, map?: Record<string, string>): string {
  return map?.[value] || value;
}
