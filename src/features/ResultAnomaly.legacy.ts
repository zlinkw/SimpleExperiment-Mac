import { ExperimentResultRecord, ResultMetricValue } from "./Results";

export const RESULT_ANOMALY_DIR = "simple_cluster/results/anomaly";

export interface MetricAnomalySummary {
  metric: string;
  currentValue?: number;
  bestValue?: number;
  delta?: number;
  relativeDelta?: number;
  mean?: number;
  std?: number;
  zScore?: number;
  higherIsBetter: boolean;
}

export interface AnomalyCause {
  severity: "critical" | "warning" | "info";
  category: "metric" | "config" | "env" | "log" | "output_contract" | "comparison";
  code: string;
  message: string;
  evidence?: Record<string, unknown>;
  suggestion?: string;
}

export interface ConfigDiffItem {
  key: string;
  current?: unknown;
  best?: unknown;
  severity: "critical" | "warning" | "info";
  message: string;
}

export interface ResultAnomalyDiagnosis {
  schemaVersion: 1;
  resultId: string;
  comparableResultId?: string;
  comparable: boolean;
  metric?: MetricAnomalySummary;
  configDiffs: ConfigDiffItem[];
  causes: AnomalyCause[];
  generatedAt: string;
  outputFiles: { jsonPath: string; markdownPath: string; configDiffPath: string };
}

export interface AnomalyOptions {
  metric?: string;
  bestDropThreshold?: number;
  stdThreshold?: number;
  currentConfig?: Record<string, unknown>;
  bestConfig?: Record<string, unknown>;
  currentEnv?: Record<string, unknown>;
  bestEnv?: Record<string, unknown>;
  logText?: string;
  outputContractIssues?: Array<{ severity?: string; message?: string; id?: string }>;
}

export function findBestComparableResult(current: ExperimentResultRecord, records: ExperimentResultRecord[], metric = primaryMetricFor(current)): ExperimentResultRecord | undefined {
  const higher = metricHigherIsBetter(current.metrics[metric], metric);
  const sameGroup = records.filter((record) => record.resultId !== current.resultId && isComparableResult(current, record) && Number.isFinite(metricNumber(record.metrics[metric])));
  return sameGroup.sort((a, b) => (metricNumber(b.metrics[metric]) - metricNumber(a.metrics[metric])) * (higher ? 1 : -1))[0];
}

export function detectResultAnomaly(current: ExperimentResultRecord, records: ExperimentResultRecord[], options: AnomalyOptions = {}): ResultAnomalyDiagnosis {
  const metric = options.metric || primaryMetricFor(current);
  const best = findBestComparableResult(current, records, metric);
  const group = records.filter((record) => isComparableResult(current, record) && Number.isFinite(metricNumber(record.metrics[metric])));
  const metricSummary = buildMetricSummary(current, best, group, metric);
  const configDiffs = compareResultToBestConfig(options.currentConfig || {}, options.bestConfig || {});
  const causes = rankAnomalyCauses({
    current,
    best,
    metric: metricSummary,
    configDiffs,
    logText: options.logText || "",
    currentEnv: options.currentEnv || {},
    bestEnv: options.bestEnv || {},
    outputContractIssues: options.outputContractIssues || [],
    bestDropThreshold: options.bestDropThreshold ?? 0.05,
    stdThreshold: options.stdThreshold ?? 2,
  });
  const safeId = safeFileName(current.resultId || current.experimentId || "result");
  return {
    schemaVersion: 1,
    resultId: current.resultId,
    comparableResultId: best?.resultId,
    comparable: Boolean(best),
    metric: metricSummary,
    configDiffs,
    causes,
    generatedAt: new Date().toISOString(),
    outputFiles: {
      jsonPath: `${RESULT_ANOMALY_DIR}/${safeId}.json`,
      markdownPath: `${RESULT_ANOMALY_DIR}/${safeId}.md`,
      configDiffPath: `${RESULT_ANOMALY_DIR}/${safeId}.config_diff.json`,
    },
  };
}

export function compareResultToBestConfig(currentConfig: Record<string, unknown>, bestConfig: Record<string, unknown>): ConfigDiffItem[] {
  const keys = importantConfigKeys(currentConfig, bestConfig);
  return keys.flatMap((key) => {
    const current = getPath(currentConfig, key);
    const best = getPath(bestConfig, key);
    if (JSON.stringify(current) === JSON.stringify(best)) return [];
    const ratio = numericRatio(current, best);
    const severity = ratio >= 10 || ratio <= 0.1 ? "warning" as const : "info" as const;
    const label = configLabel(key);
    const message = ratio && (ratio >= 10 || ratio <= 0.1) ? `${label} 与最优 run 差异 ${formatRatio(ratio)}，需要确认。` : `${label} 与最优 run 不同。`;
    return [{ key, current, best, severity, message }];
  });
}

export function rankAnomalyCauses(input: {
  current: ExperimentResultRecord;
  best?: ExperimentResultRecord;
  metric?: MetricAnomalySummary;
  configDiffs?: ConfigDiffItem[];
  logText?: string;
  currentEnv?: Record<string, unknown>;
  bestEnv?: Record<string, unknown>;
  outputContractIssues?: Array<{ severity?: string; message?: string; id?: string }>;
  bestDropThreshold: number;
  stdThreshold: number;
}): AnomalyCause[] {
  const causes: AnomalyCause[] = [];
  const status = String(input.current.status || "").toLowerCase();
  if (["parse_failed", "failed", "quality_failed"].includes(status)) causes.push(cause("critical", "output_contract", "bad_status", `当前结果状态为 ${input.current.status}，结果可能不可用于比较。`, "先修复解析或质量门禁。"));
  if (!input.best) causes.push(cause("warning", "comparison", "no_comparable_best", "未找到同 suite/dataset/split/metric 的最优结果，不可直接比较。", "先解析同组结果或选择明确对照。"));
  if (input.metric) addMetricCauses(causes, input.metric, input.bestDropThreshold, input.stdThreshold);
  addLogCauses(causes, input.logText || "");
  for (const item of input.configDiffs || []) causes.push({ severity: item.severity, category: "config", code: `config_${item.key}`, message: item.message, evidence: { current: item.current, best: item.best }, suggestion: "复现前确认当前配置是否应改为最优 run 对应值。" });
  addEnvCauses(causes, input.currentEnv || {}, input.bestEnv || {});
  for (const issue of input.outputContractIssues || []) causes.push({ severity: issue.severity === "critical" ? "critical" : "warning", category: "output_contract", code: issue.id || "output_contract_issue", message: issue.message || "输出契约存在缺失项。", suggestion: "补齐 metrics_summary、config_snapshot、env_snapshot 或必要列后重试。" });
  return causes.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || categoryRank(a.category) - categoryRank(b.category) || a.code.localeCompare(b.code));
}

export function renderAnomalyDiagnosisReport(diagnosis: ResultAnomalyDiagnosis): string {
  const metric = diagnosis.metric;
  const metricLines = metric ? [
    `metric: ${metric.metric}`,
    `current: ${metric.currentValue ?? "NA"}`,
    `best: ${metric.bestValue ?? "NA"}`,
    `delta: ${metric.delta ?? "NA"}`,
    `relative_delta: ${metric.relativeDelta ?? "NA"}`,
    `mean/std: ${metric.mean ?? "NA"} / ${metric.std ?? "NA"}`,
    `z_score: ${metric.zScore ?? "NA"}`,
  ] : ["metric: NA"];
  return [
    "# 结果异常诊断报告",
    "",
    `result_id: ${diagnosis.resultId}`,
    `best_result_id: ${diagnosis.comparableResultId || "不可直接比较"}`,
    `generated_at: ${diagnosis.generatedAt}`,
    "",
    "## 指标对比",
    "",
    ...metricLines.map((line) => `- ${line}`),
    "",
    "## 原因排序",
    "",
    ...diagnosis.causes.map((item) => `- [${item.severity}] ${item.category}/${item.code}: ${item.message}${item.suggestion ? ` 建议：${item.suggestion}` : ""}`),
    "",
    "## 配置差异",
    "",
    ...diagnosis.configDiffs.map((item) => `- [${item.severity}] ${item.key}: current=${JSON.stringify(item.current)} best=${JSON.stringify(item.best)}`),
  ].join("\n");
}

function buildMetricSummary(current: ExperimentResultRecord, best: ExperimentResultRecord | undefined, group: ExperimentResultRecord[], metric: string): MetricAnomalySummary {
  const currentValue = metricNumber(current.metrics[metric]);
  const bestValue = best ? metricNumber(best.metrics[metric]) : undefined;
  const values = group.map((record) => metricNumber(record.metrics[metric])).filter(Number.isFinite);
  const mean = avg(values);
  const sd = std(values);
  const higherIsBetter = metricHigherIsBetter(current.metrics[metric], metric);
  const delta = bestValue !== undefined && Number.isFinite(currentValue) ? currentValue - bestValue : undefined;
  const relativeDelta = delta !== undefined && bestValue ? delta / Math.abs(bestValue) : undefined;
  const zScore = Number.isFinite(currentValue) && Number.isFinite(mean) && sd ? (currentValue - mean) / sd : undefined;
  return { metric, currentValue, bestValue, delta, relativeDelta, mean, std: sd, zScore, higherIsBetter };
}

function addMetricCauses(causes: AnomalyCause[], metric: MetricAnomalySummary, bestDropThreshold: number, stdThreshold: number): void {
  if (!Number.isFinite(metric.currentValue)) causes.push(cause("critical", "metric", "missing_metric", `主指标 ${metric.metric} 缺失或不可解析。`, "先修复结果解析。"));
  if (metric.bestValue !== undefined && metric.delta !== undefined) {
    const badDelta = metric.higherIsBetter ? metric.delta < -bestDropThreshold : metric.delta > bestDropThreshold;
    if (badDelta) causes.push(cause("warning", "metric", "behind_best", `当前 ${metric.metric}=${metric.currentValue} 与最优 ${metric.bestValue} 差距超过阈值。`, "查看配置差异和日志异常。", { delta: metric.delta, relativeDelta: metric.relativeDelta }));
  }
  if (metric.zScore !== undefined) {
    const badZ = metric.higherIsBetter ? metric.zScore < -stdThreshold : metric.zScore > stdThreshold;
    if (badZ) causes.push(cause("warning", "metric", "group_outlier", `当前 ${metric.metric} 相对同组均值 z-score=${metric.zScore.toFixed(2)}，属于异常波动。`, "优先检查 seed/fold、数据 split 和环境差异。"));
  }
}

function addLogCauses(causes: AnomalyCause[], text: string): void {
  const rules: Array<[RegExp, AnomalyCause["severity"], string, string]> = [
    [/out of memory|oom/i, "critical", "oom", "当前 run 出现 OOM，结果可能不可信"],
    [/\bnan\b|inf\b/i, "critical", "nan", "日志出现 NaN/Inf，训练可能已经发散"],
    [/traceback|exception|error:/i, "critical", "traceback", "日志出现 Traceback/异常"],
    [/cuda error|cudnn|device-side assert/i, "critical", "cuda_error", "日志出现 CUDA 相关错误"],
    [/missing file|file not found|no such file/i, "warning", "missing_file", "日志出现缺失文件"],
    [/shape mismatch|size mismatch|dimension mismatch/i, "warning", "shape_mismatch", "日志出现 shape/size 不匹配"],
  ];
  for (const [pattern, severity, code, message] of rules) if (pattern.test(text)) causes.push(cause(severity, "log", code, message, "先处理日志错误，再比较指标。"));
}

function addEnvCauses(causes: AnomalyCause[], current: Record<string, unknown>, best: Record<string, unknown>): void {
  for (const key of ["git_commit", "gitCommit", "python", "torch", "cuda", "workerId", "gpu_name", "gpuName"]) {
    const a = current[key];
    const b = best[key];
    if (a && b && String(a) !== String(b)) causes.push(cause("info", "env", `env_${key}`, `当前 ${key} 与最优 run 不同。`, "环境差异可能影响复现，正式结论前需记录。", { current: a, best: b }));
  }
}

function isComparableResult(a: ExperimentResultRecord, b: ExperimentResultRecord): boolean {
  return ["suite", "dataset", "split"].every((key) => String((a as any)[key] ?? a.dimensions[key] ?? "") === String((b as any)[key] ?? b.dimensions[key] ?? ""));
}

function primaryMetricFor(record: ExperimentResultRecord): string {
  if (record.primaryMetric && record.metrics[record.primaryMetric]) return record.primaryMetric;
  return ["AUC", "accuracy", "F1", "DSC", "IoU", "loss", "HD95", "ASD"].find((key) => record.metrics[key]) || Object.keys(record.metrics)[0] || "AUC";
}

function metricNumber(value?: ResultMetricValue): number {
  const n = Number(value?.value);
  return Number.isFinite(n) ? n : NaN;
}

function metricHigherIsBetter(value: ResultMetricValue | undefined, metric: string): boolean {
  if (value?.higherIsBetter !== undefined) return Boolean(value.higherIsBetter);
  return !/loss|hd95|asd|mae|mse|rmse|error|ece|brier|fpr|fnr/i.test(metric);
}

function importantConfigKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const preferred = ["model.name", "model", "learning_rate", "lr", "optimizer.lr", "batch_size", "batchSize", "epochs", "epoch", "loss", "criterion", "augmentation", "seed", "fold", "dataset", "split"];
  const flattened = new Set([...Object.keys(flatten(a)), ...Object.keys(flatten(b))]);
  return Array.from(new Set([...preferred.filter((key) => flattened.has(key)), ...Array.from(flattened).filter((key) => /lr|learning|batch|epoch|loss|augment|model|seed|fold|dataset|split/i.test(key))]));
}

function getPath(source: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((cur, part) => cur && typeof cur === "object" ? (cur as Record<string, unknown>)[part] : undefined, source);
}

function flatten(source: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source || {})) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) Object.assign(out, flatten(value as Record<string, unknown>, next));
    else out[next] = value;
  }
  return out;
}

function numericRatio(a: unknown, b: unknown): number {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && y !== 0 ? x / y : NaN;
}

function configLabel(key: string): string {
  const labels: Record<string, string> = { learning_rate: "学习率", lr: "学习率", "optimizer.lr": "学习率", batch_size: "batch size", batchSize: "batch size", epochs: "epoch 数", epoch: "epoch 数", augmentation: "数据增强", seed: "seed", fold: "fold", dataset: "dataset", split: "split", loss: "loss", criterion: "loss", model: "模型", "model.name": "模型" };
  return labels[key] || key;
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return "未知";
  return value >= 1 ? `${value.toFixed(1)}x` : `${(1 / value).toFixed(1)}x`;
}

function cause(severity: AnomalyCause["severity"], category: AnomalyCause["category"], code: string, message: string, suggestion?: string, evidence?: Record<string, unknown>): AnomalyCause {
  return { severity, category, code, message, suggestion, evidence };
}

function severityRank(value: AnomalyCause["severity"]): number {
  return value === "critical" ? 0 : value === "warning" ? 1 : 2;
}

function categoryRank(value: AnomalyCause["category"]): number {
  return ["log", "output_contract", "metric", "config", "comparison", "env"].indexOf(value);
}

function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = avg(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function safeFileName(value: string): string {
  return String(value || "result").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "result";
}