// @ts-nocheck
export {};

export interface ExperimentMatrix {
  baseConfig: string;
  suite: string;
  variables: Array<{ name: string; key?: string; values?: string[]; mode: "grid" | "paired" | "fixed" | "derived" | "conditional"; expression?: string; when?: string }>;
  seeds: string[];
  constraints?: string[];
  namingRule?: { pattern: string; sanitize?: boolean };
}

export interface GeneratedExperiment {
  experimentIndex: number;
  name: string;
  runKey: string;
  experimentKey?: string;
  configOverrides: Record<string, unknown>;
  commandPreview: string;
  filteredBy?: string;
}

export interface PlanBuildResult {
  experiments: GeneratedExperiment[];
  duplicateRunKeys: string[];
  filteredCount?: number;
  errors?: string[];
  yaml: string;
  previewCsv?: string;
}

export interface PlanSummary {
  suite: string;
  mode: string;
  modeRaw: string;
  modeValid: boolean;
  baseConfig: string;
  inlineConfig: boolean;
  caseConfig: boolean;
  hasConfigSource: boolean;
  configSource: string;
  seeds: string[];
  cases: string[];
  trainCommand: string;
  testCommand: string;
  outputCandidates: string[];
  outputSignals: string[];
}

export interface PlannedExperimentSummary {
  experimentKey: string;
  name: string;
  runKey: string;
  status?: "planned" | "queued" | "running" | "completed" | "failed" | "skipped";
  stageId?: string;
  tags?: string[];
}

export interface PlanResourceEstimate {
  experimentCount: number;
  estimatedGpuHours?: number;
  estimatedWallTimeHours?: number;
  estimatedDiskGb?: number;
  estimatedCheckpointGb?: number;
  estimatedLogMb?: number;
  requiredGpuMemoryMb?: number;
  suggestedWorkers?: string[];
  warnings?: string[];
}

export interface ExperimentPlanRecord {
  schemaVersion: 1;
  planId: string;
  planName: string;
  suite: string;
  project?: string;
  status: "draft" | "validated" | "scheduled" | "running" | "completed" | "partially_completed" | "failed" | "archived" | "deprecated";
  source: { type: "manual_yaml" | "template_generated" | "imported" | "cloned" | "ui_builder"; path?: string; templateId?: string; generatedFrom?: string };
  planFile: string;
  planSha256?: string;
  schemaId?: string;
  templateId?: string;
  variables: Record<string, unknown>;
  dimensions: Record<string, string | number | boolean>;
  experimentCount: number;
  plannedExperiments: PlannedExperimentSummary[];
  resourceEstimate?: PlanResourceEstimate;
  createdAt: string;
  updatedAt: string;
  validatedAt?: string;
  lastRunAt?: string;
  tags?: string[];
  favorite?: boolean;
  notes?: string;
  locked?: boolean;
  provenance: { baseConfig?: string; gitCommit?: string; branch?: string; author?: string; parentPlanId?: string; parentRevisionId?: string };
  revisions?: PlanRevision[];
  dependencies?: PlanDependency[];
  stages?: PlanStage[];
}

export interface PlanFieldDefinition {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "path" | "enum" | "array" | "object";
  required?: boolean;
  defaultValue?: unknown;
  enumValues?: string[];
  description?: string;
}

export interface PlanVariableDefinition {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  mode: "single" | "grid" | "paired" | "derived";
  values?: unknown[];
  defaultValue?: unknown;
  required?: boolean;
  description?: string;
}

export interface PlanConstraint {
  id: string;
  expression: string;
  message: string;
}

export interface SchedulingPolicy {
  priority?: "high" | "normal" | "low";
  runPolicy?: "sequential" | "parallel" | "manual";
  maxConcurrentJobs?: number;
  retryFailed?: boolean;
}

export interface PlanSchema {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  appliesTo?: { projects?: string[]; suites?: string[]; tags?: string[] };
  fields: PlanFieldDefinition[];
  variables: PlanVariableDefinition[];
  constraints: PlanConstraint[];
  defaultSchedulingPolicy?: SchedulingPolicy;
  defaultResultSchemaId?: string;
  defaultPlanTemplateId?: string;
  display?: { pinnedFields?: string[]; hiddenFields?: string[]; defaultGroupBy?: string[] };
}

export interface PlanTemplate {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  schemaId?: string;
  templateType: "yaml_template" | "json_template" | "command_template";
  variables: PlanVariableDefinition[];
  files: Array<{ relativePath: string; contentTemplate: string; overwritePolicy: "never" | "prompt" | "overwrite" }>;
  commandTemplates?: { train?: string; test?: string; resume?: string; evaluate?: string };
  defaultTags?: string[];
  resultParserPresetId?: string;
  resultSchemaId?: string;
}

export interface PlanMatrix {
  variables: Array<{ key: string; mode: "grid" | "paired" | "fixed" | "derived" | "conditional"; values?: unknown[]; expression?: string; when?: string }>;
  constraints?: Array<{ id: string; expression: string; message: string }>;
  namingRule?: { pattern: string; sanitize?: boolean };
}

export interface PlanValidationIssue {
  id: string;
  severity: "info" | "warning" | "critical";
  path?: string;
  message: string;
  suggestion?: string;
}

export interface PlanValidationResult {
  planId?: string;
  status: "ok" | "warning" | "failed";
  experimentCount: number;
  warnings: PlanValidationIssue[];
  errors: PlanValidationIssue[];
  duplicateExperiments: Array<{ experimentKey: string; existingExperimentId?: string; reason: string }>;
}

export interface PlanDependency {
  id: string;
  from: string;
  to: string;
  type: "plan" | "experiment" | "stage";
  condition: { type: "completed" } | { type: "metric_threshold"; metric: string; op: ">=" | "<="; value: number } | { type: "manual_approval" };
}

export interface PlanStage {
  stageId: string;
  name: string;
  experiments: string[];
  dependsOn?: string[];
  runPolicy: "sequential" | "parallel" | "manual";
}

export interface PlanRevision {
  revisionId: string;
  planId: string;
  createdAt: string;
  reason: string;
  source: "manual_edit" | "template_generate" | "schema_migration" | "clone" | "import";
  planSha256: string;
  diffSummary?: string;
  changedFields?: string[];
}

export interface ReproducePlanOptions {
  sourcePlanId?: string;
  sourceExperimentIds?: string[];
  mode: "rerun_all" | "retry_failed" | "missing_results_only" | "new_seeds" | "new_dataset";
  overrides: Record<string, unknown>;
  skipCompleted: boolean;
}

export interface PlanResultCoverage {
  planId: string;
  experimentCount: number;
  completedCount: number;
  parsedResultCount: number;
  missingResultCount: number;
  missingPrimaryMetric: string[];
  bestByMetric: Record<string, { experimentId: string; value: number }>;
}

import { createHash } from "crypto";
import { normalizeMacResultCandidatePath } from "../mac/ResultCandidatePath";
import { decodeMacResultYamlScalar } from "../mac/ResultCandidateYaml";

export const PLAN_REGISTRY_PATH = "simple_cluster/plans/plan_registry.json";
export const PLAN_REGISTRY_LOCAL_PATH = "simple_cluster/plans/plan_registry.local.json";
export const PLAN_EXPORT_DIR = "simple_cluster/plans/exports";
export const builtInPlanSchemas: PlanSchema[] = [
    {
        schemaVersion: 1,
        id: "generic_experiment_plan",
        name: "Generic experiment plan",
        fields: [
            { key: "suite", label: "Suite", type: "string", required: true },
            { key: "base_config", label: "Base config", type: "path", required: true },
            { key: "mode", label: "Mode", type: "enum", enumValues: ["train", "test", "train_test"], defaultValue: "train_test" },
        ],
        variables: [
            { key: "seed", label: "Seed", type: "string", mode: "grid", values: ["1", "2", "3"] },
            { key: "learning_rate", label: "Learning rate", type: "number", mode: "grid", values: [0.001] },
        ],
        constraints: [],
        defaultSchedulingPolicy: { priority: "normal", runPolicy: "parallel", maxConcurrentJobs: 1 },
        defaultPlanTemplateId: "generic_grid_search",
        display: { pinnedFields: ["suite", "base_config"], defaultGroupBy: ["suite", "status"] },
    },
    {
        schemaVersion: 1,
        id: "medical_segmentation_plan",
        name: "Medical segmentation plan",
        fields: [
            { key: "suite", label: "Suite", type: "string", required: true },
            { key: "base_config", label: "Base config", type: "path", required: true },
            { key: "dataset", label: "Dataset", type: "enum", enumValues: ["VinDr", "PAD-UFES", "VinDr-CXR"], required: true },
        ],
        variables: [
            { key: "model", label: "Model", type: "enum", mode: "grid", values: ["baseline", "fusion"] },
            { key: "missing_rate", label: "Missing rate", type: "number", mode: "grid", values: [0, 0.3, 0.5] },
            { key: "noise_type", label: "Noise type", type: "enum", mode: "paired", values: ["none", "gaussian"] },
            { key: "noise_level", label: "Noise level", type: "number", mode: "paired", values: [0, 0.1] },
        ],
        constraints: [
            { id: "missing_zero_none", expression: "missing_rate == 0 -> missing_strategy == none", message: "missing_rate=0 requires missing_strategy=none" },
            { id: "noise_none_zero", expression: "noise_type == none -> noise_level == 0", message: "noise_type=none requires noise_level=0" },
        ],
        defaultSchedulingPolicy: { priority: "normal", runPolicy: "parallel", maxConcurrentJobs: 1 },
        defaultResultSchemaId: "medical_segmentation",
        defaultPlanTemplateId: "medical_segmentation_ablation",
    },
];
export const builtInPlanTemplates: PlanTemplate[] = [
    template("generic_grid_search", "Generic grid search", "generic_experiment_plan", "{{suite}}.generated.yaml"),
    template("medical_segmentation_ablation", "Medical segmentation ablation", "medical_segmentation_plan", "{{suite}}.ablation.yaml"),
    template("missing_modality_experiment", "Missing modality experiment", "medical_segmentation_plan", "{{suite}}.missing_modality.yaml"),
    template("noisy_clinical_data_experiment", "Noisy clinical data experiment", "medical_segmentation_plan", "{{suite}}.noise.yaml"),
    template("cross_dataset_evaluation", "Cross dataset evaluation", "medical_segmentation_plan", "{{suite}}.cross_dataset.yaml"),
    template("seed_repeat_experiment", "Seed repeat experiment", "generic_experiment_plan", "{{suite}}.seeds.yaml"),
];
export function buildExperimentMatrix(matrix, existingRunKeys = []) {
    const existing = new Set(existingRunKeys);
    const advanced = expandPlanMatrix({
        variables: [
            ...matrix.variables.map((item) => ({ key: item.key || item.name, mode: item.mode, values: item.values, expression: item.expression, when: item.when })),
            ...(matrix.seeds.length ? [{ key: "seed", mode: "grid", values: matrix.seeds }] : [{ key: "seed", mode: "fixed", values: ["0"] }]),
        ],
        constraints: (matrix.constraints || []).map((expression, index) => ({ id: `constraint_${index}`, expression, message: expression })),
        namingRule: matrix.namingRule,
    }, existing, matrix.suite);
    const experiments = [];
    let index = 0;
    for (const item of advanced.experiments) {
        experiments.push({
            experimentIndex: index++,
            name: item.name,
            runKey: item.runKey,
            experimentKey: item.experimentKey,
            configOverrides: item.configOverrides,
            commandPreview: `config=${matrix.baseConfig} ${Object.entries(item.configOverrides).map(([k, v]) => `${k}=${v}`).join(" ")}`,
        });
    }
    return { experiments, duplicateRunKeys: advanced.duplicateRunKeys, filteredCount: advanced.filteredCount, errors: advanced.errors, yaml: renderPlanYaml(matrix, experiments), previewCsv: matrixPreviewCsv(experiments) };
}
export function renderPlanYaml(matrix, experiments) {
    const cases = caseEntriesForPlanYaml(matrix, experiments);
    const lines = [
        `suite: ${quoteYaml(matrix.suite)}`,
        "mode: train_test",
        `base_config: ${quoteYaml(matrix.baseConfig)}`,
        "paper:",
        `  result_csv: ${quoteYaml("{output_dir}/metrics_summary.csv")}`,
        "runner:",
        `  train_command: ${quoteYaml("python train.py --config {config} --seed {seed} --output-dir {output_dir}")}`,
        `  test_command: ${quoteYaml("python test.py --config {config} --seed {seed} --output-dir {output_dir} --result-csv {result_csv}")}`,
        "naming:",
        `  sweep_dir: ${quoteYaml("work_dirs/multirun/{suite}")}`,
        `  job_name: ${quoteYaml("{index}_{case}_seed{seed}")}`,
        `  experiment_name: ${quoteYaml("{suite}/{case}/seed_{seed}")}`,
        "seeds:",
        ...Array.from(new Set(experiments.map((item) => String(item.configOverrides.seed || "0")))).map((seed) => `  - ${quoteYaml(seed)}`),
        "cases:",
        ...cases.map((item) => [
            `  - case: ${quoteYaml(item.caseName)}`,
            `    outputDir: ${quoteYaml("work_dirs/multirun/{suite}/{case}_seed{seed}")}`,
            "    expectedResults:",
            `      - ${quoteYaml("work_dirs/multirun/{suite}/{case}_seed{seed}/metrics_summary.csv")}`,
            "    overrides:",
            ...Object.entries(item.overrides).map(([key, value]) => `      ${key}: ${quoteYaml(String(value))}`),
        ].join("\n")),
    ];
    return `${lines.join("\n")}\n`;
}
function caseEntriesForPlanYaml(matrix, experiments) {
    const cases = new Map();
    const usedNames = new Map();
    for (const item of experiments) {
        const overrides = sortObject(Object.fromEntries(Object.entries(item.configOverrides).filter(([key]) => key !== "seed")));
        const key = JSON.stringify(overrides);
        if (cases.has(key))
            continue;
        const baseName = planYamlCaseName(matrix, overrides);
        const seen = usedNames.get(baseName) || 0;
        usedNames.set(baseName, seen + 1);
        cases.set(key, { caseName: seen ? `${baseName}_${seen + 1}` : baseName, overrides });
    }
    return Array.from(cases.values());
}
function planYamlCaseName(matrix, overrides) {
    const fromRule = renderNamingRule(matrix.namingRule?.pattern, matrix.suite, overrides).trim();
    if (fromRule)
        return fromRule;
    return Object.keys(overrides).length ? experimentName(matrix.suite, overrides) : `${matrix.suite}__baseline`;
}
export function parsePlanCases(yaml) {
    const cases = [];
    let sectionIndent = -1;
    let inPlanList = false;
    let currentItemIndent = -1;
    let currentItemHasLabel = false;
    let mapItemIndent = -1;
    let sawCaseSection = false;
    for (const rawLine of yaml.split(/\r?\n/)) {
        const line = rawLine.replace(/\t/g, "  ");
        if (!line.trim() || /^\s*#/.test(line))
            continue;
        const indent = line.match(/^\s*/)?.[0].length || 0;
        const inlineSection = line.match(/^(\s*)(cases|experiments)\s*:\s*(\[[^\r\n]*\])\s*(?:#.*)?$/);
        if (inlineSection) {
            sawCaseSection = true;
            cases.push(...planCaseInlineListValues(inlineSection[3]));
            inPlanList = false;
            currentItemIndent = -1;
            currentItemHasLabel = false;
            mapItemIndent = -1;
            continue;
        }
        const section = line.match(/^(\s*)(cases|experiments)\s*:\s*(?:#.*)?$/);
        if (section) {
            sawCaseSection = true;
            sectionIndent = section[1].length;
            inPlanList = true;
            currentItemIndent = -1;
            currentItemHasLabel = false;
            mapItemIndent = -1;
            continue;
        }
        if (!inPlanList)
            continue;
        if (indent <= sectionIndent) {
            inPlanList = false;
            currentItemIndent = -1;
            currentItemHasLabel = false;
            mapItemIndent = -1;
            continue;
        }
        const listItem = line.match(/^(\s*)-\s*(.*)$/);
        if (listItem) {
            if (currentItemIndent >= 0 && indent > currentItemIndent)
                continue;
            currentItemIndent = listItem[1].length;
            currentItemHasLabel = false;
            mapItemIndent = -1;
            const inlineLabel = planCaseLabelValue(listItem[2]);
            if (inlineLabel) {
                cases.push(inlineLabel);
                currentItemHasLabel = true;
            }
            else {
                const scalarLabel = planCaseScalarListValue(listItem[2]);
                if (scalarLabel) {
                    cases.push(scalarLabel);
                    currentItemHasLabel = true;
                }
            }
            continue;
        }
        if (currentItemIndent >= 0 && indent === currentItemIndent + 2 && !currentItemHasLabel) {
            const nestedLabel = planCaseLabelValue(line.trim());
            if (nestedLabel) {
                cases.push(nestedLabel);
                currentItemHasLabel = true;
            }
            continue;
        }
        if (currentItemIndent < 0) {
            const mapItem = line.match(/^\s*([A-Za-z0-9_.:-]+)\s*:\s*(?:.*)?$/);
            if (mapItem) {
                if (mapItemIndent < 0)
                    mapItemIndent = indent;
                if (indent === mapItemIndent)
                    cases.push(stripYamlScalar(mapItem[1]));
            }
        }
    }
    if (cases.length || sawCaseSection || !planHasImplicitSingleCase(yaml))
        return cases;
    return [scalar(yaml, "case") || scalar(yaml, "name") || scalar(yaml, "id") || "baseline"];
}
function planHasImplicitSingleCase(yaml) {
    const clean = stripYamlComments(yaml);
    return /^(?:base_config|config|command|train_command|trainCommand|test_command|testCommand|runner)\s*:/im.test(clean);
}
const directResultKeys = [
    "result_csv",
    "resultCsv",
    "results_csv",
    "resultsCsv",
    "metrics_csv",
    "metricsCsv",
    "summary_csv",
    "summaryCsv",
    "output_csv",
    "outputCsv",
    "result_json",
    "resultJson",
    "metrics_json",
    "metricsJson",
    "summary_txt",
    "summaryTxt",
    "log_file",
    "logFile",
];
const resultListKeys = [
    "expectedResults",
    "expected_results",
    "resultFiles",
    "result_files",
    "outputFiles",
    "output_files",
];
const outputRuleListKeys = ["candidateCsv", "candidateJson", "consoleLogs", "textLogs"];
const objectResultPathKeys = new Set([
    "path",
    "file",
    "result",
    "resultFile",
    "result_file",
    "output",
    "outputFile",
    "output_file",
    "log",
    "log_file",
    "csv",
    "metrics_summary",
    "metricsSummary",
    "metrics_case",
    "metricsCase",
    "artifact",
    "artifact_manifest",
    "artifactManifest",
    "summary",
    "metrics",
    ...directResultKeys,
]);
const resultDirKeys = ["output_dir", "outputDir", "output-dir", "result_dir", "resultDir", "results_dir", "resultsDir", "work_dir", "workDir", "workdir", "save_dir", "saveDir", "log_dir", "logDir", "sweep_dir", "sweepDir", "default_root_dir", "defaultRootDir", "run_dir", "runDir"];
const commandResultFlags = new Map([
    ["result-csv", "result_csv"],
    ["result_csv", "result_csv"],
    ["results-csv", "results_csv"],
    ["results_csv", "results_csv"],
    ["metrics-csv", "metrics_csv"],
    ["metrics_csv", "metrics_csv"],
    ["summary-csv", "summary_csv"],
    ["summary_csv", "summary_csv"],
    ["output-csv", "output_csv"],
    ["output_csv", "output_csv"],
    ["result-json", "result_json"],
    ["result_json", "result_json"],
    ["metrics-json", "metrics_json"],
    ["metrics_json", "metrics_json"],
    ["summary-txt", "summary_txt"],
    ["summary_txt", "summary_txt"],
    ["log-file", "log_file"],
    ["log_file", "log_file"],
    ["stdout", "stdout"],
    ["stderr", "stderr"],
]);
const commandResultDirFlags = new Set([
    "output",
    "out",
    "output-dir",
    "output_dir",
    "out-dir",
    "out_dir",
    "result-dir",
    "result_dir",
    "results-dir",
    "results_dir",
    "work-dir",
    "work_dir",
    "workdir",
    "save-dir",
    "save_dir",
    "log-dir",
    "log_dir",
    "logging-dir",
    "logging_dir",
    "loggingdir",
    "tensorboard-log-dir",
    "tensorboard_log_dir",
    "tensorboardlogdir",
    "tb-log-dir",
    "tb_log_dir",
    "tblogdir",
    "run-dir",
    "run_dir",
    "rundir",
    "default-root-dir",
    "default_root_dir",
    "defaultrootdir",
    "dirpath",
    "hydra.run.dir",
    "hydra.sweep.dir",
    "logger.save_dir",
    "logger.save-dir",
    "trainer.default_root_dir",
    "trainer.default-root-dir",
]);
// 终版5文件契约（2026-09）：{output_dir}/metrics_summary.csv、{output_dir}/metrics_case.csv、
// {output_dir}/stdout.log、{output_dir}/stderr.log、experiments/results/<method>.csv（+Plan声明路径）。
// 根文件名仅保留前4种契约 basename（任意目录深度均可）；第5种大表走 experiments/results/ 声明前缀，不靠脑补。
const planResultRootFiles = new Set([
    "metrics_summary.csv",
    "metrics_case.csv",
    "stdout.log",
    "stderr.log",
]);
// 白名单收敛：TopDirs 仅保留 output_dir 常用宿主（work_dirs/results/outputs），其余
// lightning_logs/test_results/custom_results/reports/artifacts/evals/predictions 等一律走声明，不再默认放行。
// PrefixPairs 仅保留 experiments/results（终版第5文件大表前缀）；simple_cluster/* 与 experiments/runs 走声明。
const planResultTopDirs = new Set([
    "work_dirs",
    "results",
    "outputs",
]);
const planResultPrefixPairs = new Set([
    "experiments/results",
]);
const planResultExactPairs = new Set(["experiments/results.csv"]);
export function parsePlanOutputEvidence(yaml, commands = {}) {
    const clean = stripYamlComments(yaml);
    const trainCommand = commands.trainCommand || firstPlanCommand(clean, ["train_command", "trainCommand", "command"]);
    const testCommand = commands.testCommand || firstPlanCommand(clean, ["test_command", "testCommand"]);
    const declaredMode = commands.mode || firstTopLevelPlanScalar(clean, collectYamlScalarAnchors(clean), "mode");
    const inferredMode = trainCommand && testCommand ? "train_test" : trainCommand ? "train" : testCommand ? "test" : "train_test";
    const mode = normalizePlanMode(declaredMode || inferredMode);
    const commandKeys = mode === "train" ? ["command", "train_command", "trainCommand"] : mode === "test" ? ["test_command", "testCommand"] : ["command", "train_command", "trainCommand", "test_command", "testCommand"];
    const direct = directResultKeys.flatMap((key) => [
        ...extractYamlStringValues(clean, key),
        ...extractYamlFlowMapValues(clean, key),
    ].map((value) => ({ key, value: normalizePlanCandidatePath(value) }))).filter((item) => isPlanParseableResultCandidate(item.value));
    const listed = resultListKeys.flatMap((key) => [
        ...extractYamlResultListValues(clean, key),
        ...extractYamlFlowResultListValues(clean, key),
    ].map((value) => ({ key, value: normalizePlanCandidatePath(value) }))).filter((item) => isPlanParseableResultCandidate(item.value));
    const outputRules = outputRuleListKeys.flatMap((key) => [
        ...extractYamlResultListValues(clean, key),
        ...extractYamlFlowResultListValues(clean, key),
    ].map((value) => ({ key, value: normalizePlanCandidatePath(value) }))).filter((item) => isPlanParseableResultCandidate(item.value));
    const declaredOutputs = (process.platform === "darwin" ? dedupOutputCandidates : uniquePlanStrings)([
        ...extractYamlResultListValues(clean, "outputs"),
        ...extractYamlFlowResultListValues(clean, "outputs"),
    ].map((value) => process.platform === "darwin" ? normalizeMacResultCandidatePath(value) : stripYamlScalar(value).replace(/\\/g, "/"))
        .filter((value) => value && !/^(?:[A-Za-z]:|\/)/.test(value) && !value.split("/").includes("..")));
    const dirs = resultDirKeys.flatMap((key) => [
        ...extractYamlStringValues(clean, key),
        ...extractYamlFlowMapValues(clean, key),
    ]).map(normalizePlanCandidateDir).filter(Boolean);
    const outputCandidates = dedupOutputCandidates([
        ...direct.map((item) => item.value),
        ...listed.map((item) => item.value),
        ...outputRules.map((item) => item.value),
        ...dirs.flatMap((dir) => defaultResultCandidatesForDir(dir)),
    ]);
    const signals = new Set();
    for (const item of [...direct, ...listed]) {
        if (isPlanParseableResultCandidate(item.value))
            signals.add(`结果文件: ${item.key}=${item.value}`);
    }
    for (const item of outputRules) {
        if (isPlanParseableResultCandidate(item.value))
            signals.add(`结果文件: ${item.key}=${item.value}`);
    }
    for (const dir of dirs) {
        if (dir)
            signals.add(`结果目录: ${dir}`);
    }
    if (declaredOutputs.length)
        signals.add(`任务产物: runner.outputs (${declaredOutputs.length})`);
    const commandValues = uniquePlanStrings([
        ...(mode !== "test" ? [commands.trainCommand || ""] : []),
        ...(mode !== "train" ? [commands.testCommand || ""] : []),
        ...extractYamlCommandValues(clean, commandKeys),
        ...extractYamlFlowMapValues(clean, ...commandKeys),
    ]);
    const commandCandidates = extractCommandResultCandidates(commandValues);
    const knownOutputKeys = new Set(outputCandidates.map((item) => normalizeOutputCandidateKey(item)));
    for (const item of dedupOutputCandidates(commandCandidates.map((entry) => entry.value))) {
        const key = normalizeOutputCandidateKey(item);
        if (!key || knownOutputKeys.has(key))
            continue;
        knownOutputKeys.add(key);
        outputCandidates.push(item);
    }
    for (const item of commandCandidates) {
        signals.add(`结果文件: runner_command=${item.value}`);
    }
    const combinedCommand = commandValues.join("\n");
    if (/(?:\{(?:result_csv|resultCsv|results_csv|resultsCsv|metrics_csv|metricsCsv|summary_csv|summaryCsv|output_csv|outputCsv|result_json|resultJson|metrics_json|metricsJson|summary_txt|summaryTxt|log_file|logFile)\}|--(?:result|results|metrics|summary)[-_](?:csv|json)|metrics_summary\.csv|metrics_case\.csv|stdout\.log|stderr\.log)/i.test(combinedCommand) || commandCandidates.length)
        signals.add("命令参数: result_csv");
    if (commandCandidates.some((item) => /\.(txt|log|out)$/i.test(item.value)) || hasCommandTextOutputTarget(combinedCommand) || /\b(tee)\b/i.test(clean))
        signals.add("文本日志: stdout/stderr");
    const metricRegexValues = [
        ...extractYamlStringValues(clean, "metricRegex"),
        ...extractYamlFlowMapValues(clean, "metricRegex"),
    ].map((value) => stripYamlScalar(value)).filter(isMeaningfulYamlValue);
    const evidenceCandidates = dedupOutputCandidates([...listed, ...direct, ...outputRules, ...commandCandidates].map((item) => item.value).filter(isPlanParseableResultCandidate));
    if (metricRegexValues.length && evidenceCandidates.length)
        signals.add("metricRegex: 自定义指标正则");
    return { outputCandidates, outputSignals: [...signals].sort(), evidenceCandidates, declaredOutputs };
}
export function parsePlanSummary(yaml) {
    const clean = stripYamlComments(yaml);
    const anchors = collectYamlScalarAnchors(clean);
    const modeRaw = firstTopLevelPlanScalar(clean, anchors, "mode");
    const trainCommand = firstPlanCommand(clean, ["train_command", "trainCommand", "command"]);
    const testCommand = firstPlanCommand(clean, ["test_command", "testCommand"]);
    const inferredMode = trainCommand && testCommand ? "train_test" : trainCommand ? "train" : testCommand ? "test" : "train_test";
    const mode = normalizePlanMode(modeRaw || inferredMode);
    const evidence = parsePlanOutputEvidence(clean, { mode, trainCommand, testCommand });
    const baseConfig = firstTopLevelPlanScalar(clean, anchors, "base_config", "config");
    const configSources = planConfigSources(clean);
    const existingCandidates = new Set(evidence.outputCandidates.map((item) => process.platform === "darwin" ? item : String(item || "").trim()).filter(Boolean));
    const existingCandidateKeys = new Set(evidence.outputCandidates.map((item) => normalizeOutputCandidateKey(String(item || ""))).filter(Boolean));
    const outputSignals = evidence.outputSignals.filter((signal) => {
        const rawCandidate = signal.match(process.platform === "darwin" ? /^结果文件:\s*[^=]+=([\s\S]+)$/ : /^结果文件:\s*[^=]+=([^=]+)$/)?.[1];
        const candidate = process.platform === "darwin" ? rawCandidate : rawCandidate?.trim();
        if (!candidate || existingCandidates.size === 0)
            return true;
        return existingCandidates.has(candidate) || existingCandidateKeys.has(normalizeOutputCandidateKey(candidate));
    });
    return {
        suite: firstTopLevelPlanScalar(clean, anchors, "suite"),
        mode,
        modeRaw,
        modeValid: !modeRaw || Boolean(normalizePlanMode(modeRaw, "")),
        baseConfig,
        inlineConfig: configSources.topLevelInline,
        caseConfig: configSources.caseLevel,
        hasConfigSource: Boolean(baseConfig || configSources.topLevelInline || configSources.caseLevel),
        declaredOutputs: evidence.declaredOutputs,
        hasGenericRunnerContract: Boolean((trainCommand || testCommand) && evidence.declaredOutputs.length),
        configSource: baseConfig ? baseConfig : configSources.topLevelInline ? "Plan 内联配置" : configSources.caseLevel ? "case 级配置" : "",
        seeds: planStringList(clean, anchors, "seeds"),
        cases: parsePlanCases(clean),
        trainCommand,
        testCommand,
        outputCandidates: evidence.outputCandidates,
        outputSignals,
    };
}
function planConfigSources(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    let topLevelInline = false;
    let caseLevel = false;
    let caseSectionIndent = -1;
    let currentItemIndent = -1;
    let mapItemIndent = -1;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim() || /^\s*#/.test(line))
            continue;
        const indent = line.match(/^\s*/)?.[0].length || 0;
        const topConfig = line.match(/^(base_config|config)\s*:\s*(.*)$/);
        if (topConfig) {
            const rest = stripYamlLineComment(topConfig[2]).trim();
            if ((!rest || /^[&*]/.test(rest) || rest.startsWith("{")) && yamlConfigValueHasContent(lines, index, 0, rest))
                topLevelInline = true;
        }
        const inlineCases = line.match(/^(\s*)(cases|experiments)\s*:\s*(\[[\s\S]*\])\s*$/);
        if (inlineCases) {
            caseLevel ||= flowCaseHasConfigSource(inlineCases[3]);
            caseSectionIndent = -1;
            continue;
        }
        const section = line.match(/^(\s*)(cases|experiments)\s*:\s*$/);
        if (section) {
            caseSectionIndent = section[1].length;
            currentItemIndent = -1;
            mapItemIndent = -1;
            continue;
        }
        if (caseSectionIndent < 0)
            continue;
        if (indent <= caseSectionIndent) {
            caseSectionIndent = -1;
            currentItemIndent = -1;
            mapItemIndent = -1;
            continue;
        }
        const listItem = line.match(/^(\s*)-\s*(.*)$/);
        if (listItem) {
            currentItemIndent = listItem[1].length;
            mapItemIndent = -1;
            caseLevel ||= flowCaseHasConfigSource(listItem[2]);
            continue;
        }
        if (currentItemIndent >= 0 && indent === currentItemIndent + 2) {
            const config = line.trim().match(/^(base_config|config)\s*:\s*(.*)$/);
            if (config && yamlConfigValueHasContent(lines, index, indent, stripYamlLineComment(config[2]).trim()))
                caseLevel = true;
            continue;
        }
        if (currentItemIndent < 0) {
            if (mapItemIndent < 0)
                mapItemIndent = indent;
            if (indent === mapItemIndent + 2) {
                const config = line.trim().match(/^(base_config|config)\s*:\s*(.*)$/);
                if (config && yamlConfigValueHasContent(lines, index, indent, stripYamlLineComment(config[2]).trim()))
                    caseLevel = true;
            }
        }
    }
    return { topLevelInline, caseLevel };
}
function flowCaseHasConfigSource(value) {
    const text = String(value || "");
    const pattern = /(?:^|[{,]\s*)(?:base_config|config)\s*:\s*/gi;
    let match;
    while ((match = pattern.exec(text))) {
        const start = pattern.lastIndex;
        const first = text[start] || "";
        if (first === "{") {
            let depth = 0;
            let quoted = "";
            for (let cursor = start; cursor < text.length; cursor++) {
                const char = text[cursor];
                if (quoted) {
                    if (char === quoted && text[cursor - 1] !== "\\")
                        quoted = "";
                    continue;
                }
                if (char === '"' || char === "'") {
                    quoted = char;
                    continue;
                }
                if (char === "{")
                    depth += 1;
                else if (char === "}") {
                    depth -= 1;
                    if (depth === 0) {
                        if (text.slice(start + 1, cursor).trim())
                            return true;
                        pattern.lastIndex = cursor + 1;
                        break;
                    }
                }
            }
            continue;
        }
        const scalar = text.slice(start).split(/[,}\]]/, 1)[0].trim().replace(/^['"]|['"]$/g, "");
        if (scalar && !/^(?:null|none)$/i.test(scalar))
            return true;
    }
    return false;
}
function yamlConfigValueHasContent(lines, index, baseIndent, rest) {
    const value = String(rest || "").trim();
    if (value) {
        if (value === "{}" || /^(?:null|none)$/i.test(value))
            return false;
        if (!/^&[A-Za-z0-9_.-]+$/.test(value))
            return true;
    }
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
        const nested = lines[cursor];
        if (!nested.trim() || /^\s*#/.test(nested))
            continue;
        const indent = nested.match(/^\s*/)?.[0].length || 0;
        if (indent <= baseIndent)
            return false;
        return true;
    }
    return false;
}
export function normalizePlanMode(value, fallback = "train_test") {
    const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!normalized)
        return fallback;
    if (["train", "training", "train_only"].includes(normalized))
        return "train";
    if (["test", "eval", "evaluate", "evaluation", "test_only", "eval_only"].includes(normalized))
        return "test";
    if (["train_test", "train_and_test", "both", "all"].includes(normalized))
        return "train_test";
    return fallback;
}
export function validateDeepLearningPlanContract(yaml) {
    const clean = stripYamlComments(yaml);
    const summary = parsePlanSummary(clean);
    const evidence = parsePlanOutputEvidence(clean, { mode: summary.mode, trainCommand: summary.trainCommand, testCommand: summary.testCommand });
    const issues = [];
    const addIssue = (field, label, message, fix) => {
        issues.push({ field, label, message, fix });
    };
    if (!summary.suite && !summary.hasGenericRunnerContract) {
        addIssue("suite", "suite", "缺少实验套件名。", "在 plan 顶层补充 suite，例如 suite: cls_smoke。");
    }
    if (!summary.hasConfigSource && !summary.hasGenericRunnerContract) {
        addIssue("base_config", "base_config/config", "缺少基础配置文件或通用命令产物声明。", "配置型项目补充 base_config；通用命令项目至少声明 runner.outputs。");
    }
    if (!summary.modeValid) {
        addIssue("mode", "mode", `不支持运行模式 ${summary.modeRaw}。`, "mode 只能使用 train、test 或 train_test。");
    }
    if (!summary.seeds.length && !summary.hasGenericRunnerContract) {
        addIssue("seeds", "seeds", "缺少随机种子列表。", "补充 seeds: [0, 1, 2]；即使只跑一次也写 seeds: [0]。");
    }
    if (!summary.cases.length) {
        addIssue("cases", "cases/experiments", "缺少实验 case。", "补充 cases 或 experiments；单实验 plan 也应保留可命名 case。");
    }
    if (summary.mode !== "test" && !summary.trainCommand) {
        addIssue("train_command", "训练命令", "缺少训练入口命令。", "在 runner.train_command、trainCommand 或 command 中写明训练命令。");
    }
    if (summary.mode !== "train" && !summary.testCommand) {
        addIssue("test_command", "测试命令", "缺少测试或评估入口命令。", "在 runner.test_command 或 testCommand 中写明测试命令，并输出 metrics_summary.csv、result_csv 或 --output-dir。");
    }
    if (!evidence.evidenceCandidates.length && !summary.outputSignals.some((signal) => signal.startsWith("任务产物:"))) {
        addIssue("result_output", "结果输出", "未声明可解析结果输出。", "写 expectedResults、paper.result_csv、metrics_summary.csv、metrics_case.csv、JSON/TXT/LOG 输出，或在测试命令中显式传 --result-csv/--metrics-json/--output-dir。");
    }
    return {
        ok: issues.length === 0,
        missing: issues.map((item) => item.label),
        issues,
        summary,
        outputCandidates: summary.outputCandidates,
        outputSignals: summary.outputSignals,
    };
}
function firstTopLevelPlanScalar(text, anchors, ...keys) {
    for (const key of keys) {
        const value = extractYamlTopLevelStringValue(text, key, anchors);
        if (value)
            return value;
    }
    return "";
}
function firstPlanCommand(text, keys) {
    return uniquePlanStrings([
        ...extractYamlCommandValues(text, keys),
        ...extractYamlFlowMapValues(text, ...keys),
    ]).find(Boolean) || "";
}
function extractYamlTopLevelStringValue(text, key, anchors) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*)$`);
    for (const line of lines) {
        const match = line.match(pattern);
        if (!match)
            continue;
        const rest = stripYamlLineComment(match[1]).trim();
        if (!rest || /^[|>\[{]/.test(rest))
            return "";
        return normalizePlanScalar(rest, anchors);
    }
    return "";
}
function planStringList(text, anchors, key) {
    const values = [];
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*)$`));
        if (!match)
            continue;
        const rest = stripYamlLineComment(match[1]).trim();
        if (rest.startsWith("[") && rest.endsWith("]")) {
            values.push(...splitTopLevelYamlList(rest.slice(1, -1)).map((item) => normalizePlanScalar(item, anchors)));
            continue;
        }
        if (rest && rest !== "[]" && rest !== "{}") {
            const scalarValue = normalizePlanScalar(rest, anchors);
            if (scalarValue)
                values.push(scalarValue);
            continue;
        }
        for (let cursor = index + 1; cursor < lines.length; cursor++) {
            const nested = lines[cursor];
            if (!nested.trim())
                continue;
            const indent = nested.match(/^\s*/)?.[0].length || 0;
            if (indent === 0)
                break;
            const item = nested.match(/^\s*-\s*(.+)$/);
            if (item)
                values.push(normalizePlanScalar(item[1], anchors));
        }
    }
    return uniquePlanStrings(values);
}
function collectYamlScalarAnchors(text) {
    const anchors = new Map();
    for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
        const match = line.match(/^\s*[A-Za-z0-9_.-]+\s*:\s*&([A-Za-z0-9_.-]+)\s+(.+)$/);
        if (!match)
            continue;
        const value = stripYamlScalar(stripYamlLineComment(match[2])).trim();
        if (value)
            anchors.set(match[1], value);
    }
    return anchors;
}
function isMeaningfulYamlValue(value) {
    const text = stripYamlScalar(value).trim();
    return Boolean(text && !["[]", "{}", "null", "none", "false"].includes(text.toLowerCase()));
}
function extractYamlStringValues(text, key) {
    const values = [];
    if (process.platform === "darwin" && [...directResultKeys, ...resultDirKeys].includes(key)) {
        const pattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}:[ \\t]*([^\\r\\n]*)`, "gm");
        for (const match of text.matchAll(pattern)) values.push(decodeMacResultYamlScalar(match[1]));
        return values;
    }
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}:[ \\t]*["']?([^"'#\\r\\n]+)`, "gim");
    let match;
    while ((match = pattern.exec(text)))
        values.push(stripYamlScalar(match[1]));
    return values;
}
function extractYamlCommandValues(text, keys) {
    const keySet = new Set(keys);
    const values = [];
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const match = line.match(/^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
        if (!match || !keySet.has(match[2]))
            continue;
        const baseIndent = match[1].length;
        const rest = match[3].trim();
        if (/^[|>][+-]?\d*$/.test(rest)) {
            const blockLines = [];
            let blockIndent = -1;
            for (let cursor = index + 1; cursor < lines.length; cursor++) {
                const raw = lines[cursor];
                if (!raw.trim()) {
                    if (blockIndent >= 0)
                        blockLines.push("");
                    continue;
                }
                const indent = raw.match(/^\s*/)?.[0].length || 0;
                if (indent <= baseIndent)
                    break;
                if (blockIndent < 0)
                    blockIndent = indent;
                blockLines.push(raw.slice(Math.min(indent, blockIndent)));
            }
            const value = rest.startsWith(">") ? blockLines.map((item) => item.trim()).filter(Boolean).join(" ") : blockLines.join("\n");
            if (value.trim())
                values.push(value.trim());
            continue;
        }
        if (rest)
            values.push(stripYamlScalar(rest));
    }
    return uniquePlanStrings(values);
}
function extractYamlResultListValues(text, key) {
    const values = [];
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const match = line.match(new RegExp(`^(\\s*)${escapeRegExp(key)}:\\s*(.*)$`));
        if (!match)
            continue;
        const sectionIndent = match[1].length;
        const rest = match[2].trim();
        if (rest && rest !== "[]" && rest !== "{}") {
            if (rest.startsWith("["))
                values.push(...splitTopLevelYamlList(rest.slice(1, rest.lastIndexOf("]") >= 0 ? rest.lastIndexOf("]") : undefined)).flatMap(resultValuesFromYamlItem));
            else
                values.push(...resultValuesFromYamlItem(rest));
        }
        let currentItemIndent = -1;
        for (let cursor = index + 1; cursor < lines.length; cursor++) {
            const nested = lines[cursor];
            if (!nested.trim())
                continue;
            const indent = nested.match(/^\s*/)?.[0].length || 0;
            if (indent <= sectionIndent)
                break;
            const item = nested.match(/^(\s*)-\s*(.*)$/);
            if (item) {
                currentItemIndent = item[1].length;
                values.push(...resultValuesFromYamlItem(item[2]));
                continue;
            }
            if (currentItemIndent >= 0 && indent > currentItemIndent)
                values.push(...resultValuesFromYamlItem(nested.trim()));
        }
    }
    return values;
}
function resultValuesFromYamlItem(item) {
    const text = item.trim();
    if (!text || text === "[]" || text === "{}")
        return [];
    if (text.startsWith("{") && text.endsWith("}")) {
        return splitTopLevelYamlList(text.slice(1, -1)).flatMap((part) => resultValuesFromYamlItem(part));
    }
    const pair = text.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
    if (pair)
        return resultPathKey(pair[1]) ? [process.platform === "darwin" ? decodeMacResultYamlScalar(pair[2]) : stripYamlScalar(pair[2])] : [];
    return [process.platform === "darwin" ? decodeMacResultYamlScalar(text) : stripYamlScalar(text)];
}
function resultPathKey(key) {
    return objectResultPathKeys.has(key);
}
function extractYamlFlowMapValues(text, ...keys) {
    const keySet = new Set(keys);
    return yamlFlowMapPairs(text)
        .filter((item) => keySet.has(item.key))
        .map((item) => process.platform === "darwin" && [...directResultKeys, ...resultDirKeys].includes(item.key) ? decodeMacResultYamlScalar(item.value) : stripYamlScalar(item.value))
        .filter(Boolean);
}
function extractYamlFlowResultListValues(text, key) {
    return yamlFlowMapPairs(text)
        .filter((item) => item.key === key)
        .flatMap((item) => {
        const value = item.value.trim();
        if (value.startsWith("[") && value.endsWith("]"))
            return splitTopLevelYamlList(value.slice(1, -1)).flatMap(resultValuesFromYamlItem);
        return resultValuesFromYamlItem(value);
    });
}
function yamlFlowMapPairs(text) {
    const pairs = [];
    const bodies = yamlFlowMapBodies(text);
    for (const body of bodies) {
        for (const part of splitTopLevelYamlList(body)) {
            const match = part.match(/^([A-Za-z0-9_.-]+)\s*:\s*([\s\S]+)$/);
            if (match)
                pairs.push({ key: match[1], value: match[2].trim() });
        }
    }
    return pairs;
}
function yamlFlowMapBodies(text) {
    const bodies = [];
    let quote = "";
    let escape = false;
    let depth = 0;
    let start = -1;
    for (let index = 0; index < text.length; index++) {
        const ch = text[index];
        if (quote) {
            if (escape) {
                escape = false;
            }
            else if (ch === "\\" && (process.platform !== "darwin" || quote === '"')) {
                escape = true;
            }
            else if (process.platform === "darwin" && quote === "'" && ch === "'" && text[index + 1] === "'") {
                index++;
            }
            else if (ch === quote) {
                quote = "";
            }
            continue;
        }
        if ((ch === "\"" || ch === "'") && (process.platform !== "darwin" || index === 0 || /[\s:,[{=]/.test(text[index - 1]))) {
            quote = ch;
            continue;
        }
        if (ch === "{") {
            if (depth === 0)
                start = index + 1;
            depth++;
            continue;
        }
        if (ch === "}" && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                const body = text.slice(start, index);
                bodies.push(body);
                bodies.push(...yamlFlowMapBodies(body));
                start = -1;
            }
        }
    }
    return bodies;
}
function splitTopLevelYamlList(text) {
    const out = [];
    let quote = "";
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (process.platform === "darwin" && quote) {
            if (quote === '"' && ch === "\\") { i++; continue; }
            if (quote === "'" && ch === "'" && text[i + 1] === "'") { i++; continue; }
            if (ch === quote) quote = "";
            continue;
        }
        if ((ch === "\"" || ch === "'") && text[i - 1] !== "\\" && (process.platform !== "darwin" || i === 0 || /[\s:,[{=]/.test(text[i - 1])))
            quote = quote === ch ? "" : quote || ch;
        if (!quote && (ch === "{" || ch === "["))
            depth++;
        if (!quote && (ch === "}" || ch === "]"))
            depth = Math.max(0, depth - 1);
        if (!quote && depth === 0 && ch === ",") {
            out.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    out.push(text.slice(start).trim());
    return out.filter(Boolean);
}
function stripYamlComments(text) {
    return text.split(/\r?\n/).map(stripYamlLineComment).join("\n");
}
function stripYamlLineComment(value) {
    let quote = "";
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (process.platform === "darwin" && quote) {
            if (quote === '"' && ch === "\\") { i++; continue; }
            if (quote === "'" && ch === "'" && value[i + 1] === "'") { i++; continue; }
            if (ch === quote) quote = "";
            continue;
        }
        if ((ch === "\"" || ch === "'") && value[i - 1] !== "\\" && (process.platform !== "darwin" || i === 0 || /[\s:,[{=]/.test(value[i - 1])))
            quote = quote === ch ? "" : quote || ch;
        if (ch === "#" && !quote && (process.platform !== "darwin" || i === 0 || /[ \t]/.test(value[i - 1])))
            return value.slice(0, i);
    }
    return value;
}
function extractCommandResultCandidates(commands) {
    const out = [];
    for (const command of commands) {
        const text = String(command || "").replace(/\\[ \t]*\r?\n[ \t]*/g, " ").replace(/\r?\n/g, " ");
        const flagPattern = /(?:^|[\s;&|])--([A-Za-z][A-Za-z0-9_-]*)(?:=(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))|[ \t]+(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+)))?/g;
        for (const match of text.matchAll(flagPattern)) {
            const flag = String(match[1] || "").trim();
            const normalizedFlag = flag.replace(/_/g, "-").toLowerCase();
            const key = commandResultFlags.get(flag) || commandResultFlags.get(normalizedFlag);
            const raw = match[2] || match[3] || match[4] || match[5] || match[6] || match[7] || "";
            if (key) {
                const value = normalizePlanCandidatePath(raw);
                if (isPlanParseableResultCandidate(value))
                    out.push({ key, value });
                continue;
            }
            if (commandResultDirFlags.has(flag) || commandResultDirFlags.has(normalizedFlag)) {
                for (const value of defaultResultCandidatesForDir(raw))
                    out.push({ key: flag, value });
            }
        }
        for (const match of text.matchAll(commandDirAssignmentPattern())) {
            const key = String(match[1] || "").trim();
            const raw = match[2] || match[3] || match[4] || "";
            for (const value of defaultResultCandidatesForDir(raw))
                out.push({ key, value });
        }
        const redirectPattern = /(?:^|[\s;&|])(?:1?>|2>)[ \t]*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
        for (const match of text.matchAll(redirectPattern)) {
            const value = normalizePlanCandidatePath(match[1] || match[2] || match[3] || "");
            if (isPlanCommandResultLikePath(value))
                out.push({ key: "redirect", value });
        }
    }
    const seen = new Set();
    return out.filter((item) => {
        const id = `${item.key}:${normalizeOutputCandidateKey(item.value) || String(item.value || "").trim().toLowerCase()}`;
        if (seen.has(id))
            return false;
        seen.add(id);
        return true;
    });
}
function commandDirAssignmentPattern() {
    return /(?:^|[\s;&|])([A-Za-z0-9_.-]*(?:output_dir|output-dir|outputDir|out_dir|out-dir|work_dir|work-dir|workDir|workdir|save_dir|save-dir|saveDir|log_dir|log-dir|logDir|logging_dir|logging-dir|loggingDir|tensorboard_log_dir|tensorboard-log-dir|tensorboardLogDir|tb_log_dir|tb-log-dir|tbLogDir|run_dir|run-dir|runDir|rundir|result_dir|result-dir|resultDir|results_dir|results-dir|resultsDir|default_root_dir|default-root-dir|defaultRootDir|dirpath|hydra\.run\.dir|hydra\.sweep\.dir|logger\.save_dir|logger\.save-dir|trainer\.default_root_dir|trainer\.default-root-dir))=(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/gi;
}
function defaultResultCandidatesForDir(value) {
    const raw = normalizePlanCandidatePath(value);
    if (!raw || /\/?[^/]+\.[A-Za-z0-9]{1,8}$/.test(raw))
        return [];
    const dir = normalizePlanCandidateDir(value);
    if (!dir || isPlanParseableResultCandidate(raw))
        return [];
    const prefix = dir === "." ? "" : `${dir}/`;
    // 脑补收敛（二选一之保留 metrics_case 版）：output_dir 仅脑补终版4文件，
    // 大表 experiments/results/<method>.csv 走 Plan 声明（expectedResults/paper.result_csv），不靠脑补。
    return [
        `${prefix}metrics_summary.csv`,
        `${prefix}metrics_case.csv`,
        `${prefix}stdout.log`,
        `${prefix}stderr.log`,
    ].filter(isPlanParseableResultCandidate);
}
function isPlanCommandResultLikePath(value) {
    if (!isPlanParseableResultCandidate(value))
        return false;
    const name = value.split("/").pop() || value;
    return value.includes("/") || /(metric|result|summary|score|classification|stdout|stderr|output|log)/i.test(name);
}
function hasCommandTextOutputTarget(command) {
    const text = String(command || "").replace(/\\[ \t]*\r?\n[ \t]*/g, " ").replace(/\r?\n/g, " ");
    return /--(?:stdout|stderr)(?:=(?:"[^"]+"|'[^']+'|[^\s;&|<>]+)|[ \t]+(?:"[^"]+"|'[^']+'|[^\s;&|<>]+))/i.test(text) ||
        /\{(?:log_file|logFile|summary_txt|summaryTxt)\}/.test(text) ||
        /\b(?:stdout|stderr)\.log\b/i.test(text);
}
function normalizePlanCandidateDir(value) {
    const text = process.platform === "darwin" ? normalizePlanCandidatePath(value) : normalizePlanCandidatePath(value).replace(/\/+$/, "");
    if (!text)
        return "";
    if (/\.(csv|json|txt|log|out)$/i.test(process.platform === "darwin" ? text.trimEnd() : text))
        return text.split("/").slice(0, -1).join("/") || ".";
    return text;
}
function normalizePlanCandidatePath(value) {
    if (process.platform === "darwin") return normalizeMacResultCandidatePath(value);
    const text = stripYamlScalar(value).replace(/\\/g, "/");
    if (!text || /^(none|null|false)$/i.test(text))
        return "";
    if (/^(https?:|s3:|gs:|oss:)/i.test(text))
        return "";
    if (/^(?:[A-Za-z]:)?\//.test(text))
        return "";
    if (text.startsWith("$") || text.includes("://"))
        return "";
    return expandPlanPathPlaceholders(text.replace(/^\.\//, ""));
}
function expandPlanPathPlaceholders(value) {
    return String(value || "")
        .replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, "*")
        .replace(/\{([A-Za-z0-9_.-]+)\}/g, "*")
        .replace(/\*+/g, "*")
        .replace(/\/+/g, "/")
        .replace(/^\.\//, "")
        .replace(/^\/+/, "");
}
function isPlanParseableResultCandidate(value) {
    const text = process.platform === "darwin" ? normalizeMacResultCandidatePath(value) : String(value || "").trim().replace(/\\/g, "/");
    if (!text || isNonResultMetadataPath(text))
        return false;
    return /\.(csv|json|txt|log|out)$/i.test(process.platform === "darwin" ? text.trimEnd() : text) && isPlanAllowedResultCandidate(text);
}
function isNonResultMetadataPath(value) {
    const text = process.platform === "darwin" ? normalizeMacResultCandidatePath(value).trimEnd() : String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    const base = text.split("/").pop() || "";
    return /^simple_cluster\/results\//i.test(text)
        || /^(?:jobs\.csv|artifact_manifest\.json|checkpoint_manifest\.json|manifest\.json|metadata\.json|status\.json|state\.json|progress\.json|job\.json|jobs\.json|env_snapshot\.json|config_snapshot\.(?:json|ya?ml))$/i.test(base)
        || /(?:_snapshot|_manifest|_status|_state|_progress)\.json$/i.test(base);
}
function isPlanAllowedResultCandidate(value) {
    if (process.platform === "darwin") return Boolean(normalizeMacResultCandidatePath(value));
    const text = expandPlanPathPlaceholders(String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, ""));
    const parts = text.split("/").filter((part) => part && part !== ".");
    if (!parts.length || parts.includes(".."))
        return false;
    const lowerParts = parts.map((part) => part.toLowerCase());
    const lower = lowerParts.join("/");
    const base = lowerParts[lowerParts.length - 1];
    // 终版契约判定同步：4种契约 basename 在任意目录深度直接放行（{output_dir}/…）；
    // 第5文件 experiments/results/<method>.csv 走声明前缀（任意 basename）；其余一律拒绝。
    if (planResultRootFiles.has(base))
        return true;
    if (planResultExactPairs.has(lower))
        return true;
    if (planResultTopDirs.has(lowerParts[0])) {
        // 收敛补丁：TopDirs 宿主目录下也只放行契约 basename + experiments/results 前缀，大表/杂散文件走声明
        if (planResultRootFiles.has(base))
            return true;
        return planResultPrefixPairs.has(lowerParts.slice(0, 2).join("/"));
    }
    return planResultPrefixPairs.has(lowerParts.slice(0, 2).join("/"));
}
function uniquePlanStrings(values) {
    return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}
// Mac 使用经校验的完整原始路径键；下列折叠仅为非 Mac 兼容。
// 输出候选归一键（去重×2根因修复）：trim→反斜杠转正斜杠→占位符展开→小写；
// 4种契约文件（metrics_summary.csv/metrics_case.csv/stdout.log/stderr.log）按小写basename折叠，
// 大表（experiments/results/<method>.csv等）走全路径键，避免不同方法名被误折叠。
export function normalizeOutputCandidateKey(value) {
    if (process.platform === "darwin") {
        const raw = normalizeMacResultCandidatePath(value);
        return raw ? `path:${raw}` : "";
    }
    const raw = String(value || "").trim().replace(/\\/g, "/");
    if (!raw)
        return "";
    const expanded = expandPlanPathPlaceholders(raw.replace(/^\.\//, "").replace(/^\/+/, ""));
    const lowered = expanded.toLowerCase().replace(/\/+/g, "/");
    if (!lowered)
        return "";
    const base = lowered.split("/").pop() || lowered;
    if (planResultRootFiles.has(base))
        return `contract:${base}`;
    return `path:${lowered}`;
}
function dedupOutputCandidates(values) {
    const seen = new Set();
    const out = [];
    for (const raw of values || []) {
        const text = process.platform === "darwin" ? normalizeMacResultCandidatePath(raw) : String(raw || "").trim();
        if (!text)
            continue;
        const key = normalizeOutputCandidateKey(text);
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function expandPlanMatrix(matrix: PlanMatrix, existingRunKeys?: Iterable<string>, suite?: string): PlanBuildResult;
export function expandPlanMatrix(matrix, existingRunKeys = [], suite = "suite") {
    const errors = [];
    const existingRunKeySet = existingRunKeys instanceof Set ? existingRunKeys : new Set(existingRunKeys);
    const generatedRunKeys = new Set();
    const paired = matrix.variables.filter((item) => item.mode === "paired");
    const fixed = matrix.variables.filter((item) => item.mode === "fixed");
    const grid = matrix.variables.filter((item) => item.mode === "grid");
    const derived = matrix.variables.filter((item) => item.mode === "derived");
    const conditional = matrix.variables.filter((item) => item.mode === "conditional");
    const pairedRows = paired.length ? pairedCombinations(paired.map(varToLegacy)) : [{}];
    const gridRows = gridCombinations(grid.map(varToLegacy));
    const fixedRow = Object.fromEntries(fixed.map((item) => [item.key, item.values?.[0] ?? ""]));
    const experiments = [];
    const duplicateRunKeys = [];
    let filteredCount = 0;
    let index = 0;
    for (const pairedRow of pairedRows) {
        for (const gridRow of gridRows) {
            let row = { ...fixedRow, ...gridRow, ...pairedRow };
            for (const item of derived)
                row[item.key] = evaluateValueExpression(item.expression || "", row);
            for (const item of conditional)
                if (!item.when || evaluateCondition(item.when, row))
                    row[item.key] = item.expression ? evaluateValueExpression(item.expression, row) : item.values?.[0];
            let failed;
            try {
                failed = (matrix.constraints || []).find((constraint) => !evaluateConstraint(constraint.expression, row));
            }
            catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
                failed = { id: "expression_error", expression: "", message: "Expression error" };
            }
            if (failed) {
                filteredCount++;
                continue;
            }
            const name = renderNamingRule(matrix.namingRule?.pattern, suite, row) || experimentName(suite, row);
            const safeName = matrix.namingRule?.sanitize === false ? name : sanitizeName(name);
            const runKey = `${suite}:${safeName}`;
            const experimentKey = sha256(`${suite}:${JSON.stringify(sortObject(row))}`).slice(0, 16);
            if (existingRunKeySet.has(runKey) || generatedRunKeys.has(runKey))
                duplicateRunKeys.push(runKey);
            generatedRunKeys.add(runKey);
            experiments.push({ experimentIndex: index++, name: safeName, runKey, experimentKey, configOverrides: row, commandPreview: Object.entries(row).map(([k, v]) => `${k}=${v}`).join(" ") });
        }
    }
    return { experiments, duplicateRunKeys: Array.from(new Set(duplicateRunKeys)), filteredCount, errors, yaml: "", previewCsv: matrixPreviewCsv(experiments) };
}
export function renderPlanTemplate(template, variables) {
    validateTemplateVariables(template, variables);
    return template.files.map((file) => ({ relativePath: renderTemplate(file.relativePath, variables), content: renderTemplate(file.contentTemplate, variables), overwritePolicy: file.overwritePolicy }));
}
export function validateTemplateVariables(template, variables) {
    return template.variables.filter((item) => item.required && variables[item.key] === undefined && item.defaultValue === undefined).map((item) => ({ id: `missing_variable_${item.key}`, severity: "critical", path: `variables.${item.key}`, message: `Missing template variable: ${item.key}`, suggestion: "Set variable before generating plan." }));
}
export function importLegacyPlanYamlToRegistry(planFile: string, text: string, existing?: ExperimentPlanRecord[]): ExperimentPlanRecord;
export function importLegacyPlanYamlToRegistry(planFile, text, existing = []) {
    const summary = parsePlanSummary(text);
    const suite = summary.suite || stripExt(planFile);
    const cases = summary.cases;
    const seeds = summary.seeds.map((seed) => String(seed).trim()).filter(Boolean);
    const planId = stablePlanId(planFile, suite);
    const previous = existing.find((item) => item.planId === planId);
    const now = new Date().toISOString();
    const plannedExperiments = expandPlannedExperiments(suite, cases, seeds);
    return {
        schemaVersion: 1,
        planId,
        planName: previous?.planName || pathName(planFile),
        suite,
        status: previous?.status || "draft",
        source: { type: "manual_yaml", path: planFile },
        planFile,
        planSha256: sha256(text),
        variables: seeds.length ? { seeds } : {},
        dimensions: { suite },
        experimentCount: plannedExperiments.length || Number(scalar(text, "job_count") || 0) || 1,
        plannedExperiments,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        provenance: { baseConfig: summary.baseConfig },
        revisions: previous?.revisions || [createPlanRevision(planId, text, "initial import", "import")],
    };
}
function expandPlannedExperiments(suite, cases, seeds) {
    const normalizedCases = cases.length ? cases : ["baseline"];
    const normalizedSeeds = seeds.length ? seeds : [""];
    return normalizedCases.flatMap((name) => normalizedSeeds.map((seed) => {
        const seedSuffix = seed ? `:seed${seed}` : "";
        const displaySeed = seed ? `/seed_${seed}` : "";
        const runKey = `${suite}:${name}${seedSuffix}`;
        return {
            experimentKey: sha256(runKey).slice(0, 16),
            name: `${name}${displaySeed}`,
            runKey,
            status: "planned",
        };
    }));
}
export function upsertPlanRecords(existing, incoming) {
    const map = new Map(existing.map((item) => [item.planId, item]));
    for (const record of incoming) {
        const prev = map.get(record.planId);
        map.set(record.planId, prev ? { ...prev, ...record, createdAt: prev.createdAt, revisions: mergeRevisions(prev.revisions, record.revisions), updatedAt: new Date().toISOString() } : record);
    }
    return Array.from(map.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function deprecatePlan(record, reason = "deprecated") {
    return { ...record, status: "deprecated", notes: [record.notes, reason].filter(Boolean).join("\n"), updatedAt: new Date().toISOString() };
}
export function validatePlanRecord(record, context = {}) {
    const warnings = [];
    const errors = [];
    const duplicates = [];
    if (!record.suite)
        errors.push(planIssue("suite_missing", "critical", "suite", "Plan suite is required", "Set suite."));
    if (!record.planFile)
        errors.push(planIssue("plan_file_missing", "critical", "planFile", "Plan file is required", "Save plan YAML."));
    if (!record.provenance.baseConfig)
        warnings.push(planIssue("base_config_missing", "warning", "provenance.baseConfig", "Base config missing", "Set base_config."));
    if (!record.plannedExperiments.length)
        warnings.push(planIssue("empty_plan", "warning", "plannedExperiments", "No planned experiments", "Add cases or matrix variables."));
    const seen = new Set();
    for (const exp of record.plannedExperiments) {
        if (seen.has(exp.experimentKey))
            duplicates.push({ experimentKey: exp.experimentKey, reason: "duplicate in plan" });
        seen.add(exp.experimentKey);
        if (context.existingExperimentKeys?.includes(exp.experimentKey))
            duplicates.push({ experimentKey: exp.experimentKey, reason: "already exists" });
    }
    if (record.schemaId && context.schemas && !context.schemas.some((item) => item.id === record.schemaId))
        warnings.push(planIssue("schema_missing", "warning", "schemaId", "Plan schema missing", "Import schema or change schemaId."));
    if (record.templateId && context.templates && !context.templates.some((item) => item.id === record.templateId))
        warnings.push(planIssue("template_missing", "warning", "templateId", "Plan template missing", "Import template or change templateId."));
    if (record.resourceEstimate?.warnings?.length)
        warnings.push(...record.resourceEstimate.warnings.map((message, index) => planIssue(`resource_${index}`, "warning", "resourceEstimate", message)));
    return { planId: record.planId, status: errors.length ? "failed" : warnings.length || duplicates.length ? "warning" : "ok", experimentCount: record.experimentCount, warnings, errors, duplicateExperiments: duplicates };
}
export function estimatePlanResources(experimentCount, perExperiment = {}, workers = []) {
    const estimate = {
        experimentCount,
        estimatedGpuHours: multiply(perExperiment.estimatedGpuHours, experimentCount),
        estimatedWallTimeHours: multiply(perExperiment.estimatedWallTimeHours, experimentCount),
        estimatedDiskGb: multiply(perExperiment.estimatedDiskGb, experimentCount),
        estimatedCheckpointGb: multiply(perExperiment.estimatedCheckpointGb, experimentCount),
        estimatedLogMb: multiply(perExperiment.estimatedLogMb, experimentCount),
        requiredGpuMemoryMb: perExperiment.requiredGpuMemoryMb,
        suggestedWorkers: workers.filter((worker) => !perExperiment.requiredGpuMemoryMb || (worker.gpuMemoryMb || 0) >= perExperiment.requiredGpuMemoryMb).map((worker) => worker.serverId),
        warnings: [],
    };
    if (estimate.estimatedDiskGb && workers.length && workers.every((worker) => (worker.freeDiskGb || 0) < estimate.estimatedDiskGb))
        estimate.warnings.push("Estimated disk usage exceeds every worker free disk.");
    if (estimate.requiredGpuMemoryMb && workers.length && !estimate.suggestedWorkers?.length)
        estimate.warnings.push("No worker appears to satisfy GPU memory requirement.");
    return estimate;
}
export function createPlanRevision(planId, planText, reason, source = "manual_edit", previous) {
    const hash = sha256(planText);
    return {
        revisionId: `plan_rev_${hash.slice(0, 12)}`,
        planId,
        createdAt: new Date().toISOString(),
        reason,
        source,
        planSha256: hash,
        diffSummary: previous ? diffPlans(previous, { ...previous, planSha256: hash }) : undefined,
        changedFields: previous && previous.planSha256 !== hash ? ["planSha256"] : [],
    };
}
export function diffPlans(a, b) {
    const changed = ["planName", "suite", "status", "planFile", "planSha256", "schemaId", "templateId", "experimentCount"].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
    const expA = new Set(a.plannedExperiments.map((item) => item.experimentKey));
    const expB = new Set(b.plannedExperiments.map((item) => item.experimentKey));
    const added = Array.from(expB).filter((key) => !expA.has(key)).length;
    const removed = Array.from(expA).filter((key) => !expB.has(key)).length;
    return `fields=${changed.join(",") || "none"} experiments_added=${added} experiments_removed=${removed}`;
}
export function cloneOrReproducePlan(source: ExperimentPlanRecord, options: ReproducePlanOptions): ExperimentPlanRecord;
export function cloneOrReproducePlan(source, options) {
    const now = new Date().toISOString();
    const filtered = source.plannedExperiments.filter((item) => {
        if (options.mode === "retry_failed")
            return item.status === "failed";
        if (options.skipCompleted && item.status === "completed")
            return false;
        return !options.sourceExperimentIds?.length || options.sourceExperimentIds.includes(item.experimentKey);
    });
    const suffix = options.mode.replace(/_/g, "-");
    const planId = `${source.planId}-${suffix}-${sha256(`${now}:${JSON.stringify(options.overrides)}`).slice(0, 8)}`;
    return {
        ...source,
        planId,
        planName: `${source.planName} ${suffix}`,
        status: "draft",
        source: { type: "cloned", generatedFrom: source.planId },
        variables: { ...source.variables, ...options.overrides },
        plannedExperiments: filtered.map((item) => ({ ...item, experimentKey: sha256(`${planId}:${item.experimentKey}`).slice(0, 16), runKey: `${source.suite}:${suffix}:${item.name}`, status: "planned" })),
        experimentCount: filtered.length,
        createdAt: now,
        updatedAt: now,
        lastRunAt: undefined,
        provenance: { ...source.provenance, parentPlanId: source.planId, parentRevisionId: source.revisions?.at(-1)?.revisionId },
        revisions: [createPlanRevision(planId, JSON.stringify({ source: source.planId, options }), "clone/reproduce", "clone")],
    };
}
export function searchPlans(records, query) {
    return records.filter((record) => {
        if (query.suite && record.suite !== query.suite)
            return false;
        if (query.status && record.status !== query.status)
            return false;
        if (query.tag && !record.tags?.includes(query.tag))
            return false;
        if (query.schemaId && record.schemaId !== query.schemaId)
            return false;
        if (query.templateId && record.templateId !== query.templateId)
            return false;
        if (query.favorite !== undefined && record.favorite !== query.favorite)
            return false;
        if (query.hasFailures !== undefined && record.plannedExperiments.some((item) => item.status === "failed") !== query.hasFailures)
            return false;
        if (query.text && !`${record.planName} ${record.suite} ${record.notes || ""}`.toLowerCase().includes(query.text.toLowerCase()))
            return false;
        return true;
    });
}
export function tagPlan(record, tag, enabled = true) {
    const tags = new Set(record.tags || []);
    if (enabled)
        tags.add(tag);
    else
        tags.delete(tag);
    return { ...record, tags: Array.from(tags), updatedAt: new Date().toISOString() };
}
export function computePlanResultCoverage(plan, lifecycles = [], results = [], primaryMetric = "DSC") {
    const aliasesByExperiment = plan.plannedExperiments.map((item) => planExperimentAliases(item));
    const allAliases = new Set(aliasesByExperiment.flatMap((aliases) => Array.from(aliases)));
    const completed = lifecycles.filter((item) => planRecordMatchesAliases(item, allAliases) && ["completed", "archived"].includes(String(item.state || item.status))).length;
    const parsed = results.filter((item) => planRecordMatchesAliases(item, allAliases) && item.status !== "parse_failed");
    const missingPrimaryMetric = plan.plannedExperiments.filter((item, index) => {
        const aliases = aliasesByExperiment[index] || planExperimentAliases(item);
        return !parsed.some((result) => planRecordMatchesAliases(result, aliases) && result.metrics[primaryMetric]);
    }).map((item) => item.experimentKey);
    const missingExperimentCount = plan.plannedExperiments.filter((item, index) => {
        const aliases = aliasesByExperiment[index] || planExperimentAliases(item);
        return !parsed.some((result) => planRecordMatchesAliases(result, aliases));
    }).length;
    const bestByMetric = {};
    for (const result of parsed)
        for (const [metric, value] of Object.entries(result.metrics)) {
            const n = Number(value.value);
            if (Number.isFinite(n) && (!bestByMetric[metric] || n > bestByMetric[metric].value))
                bestByMetric[metric] = { experimentId: result.experimentId, value: n };
        }
    return { planId: plan.planId, experimentCount: plan.experimentCount, completedCount: completed, parsedResultCount: parsed.length, missingResultCount: missingExperimentCount, missingPrimaryMetric, bestByMetric };
}
function planExperimentAliases(item) {
    return new Set([item.experimentKey, item.runKey, item.name].map((value) => String(value || "").trim()).filter(Boolean));
}
function planRecordMatchesAliases(item, aliases) {
    return [item.experimentKey, item.experimentId, item.runKey].some((value) => aliases.has(String(value || "").trim()));
}
export function dependencyBlockedReasons(plan, completedIds, metrics = {}) {
    const completed = new Set(completedIds);
    const blocked = {};
    for (const dep of plan.dependencies || []) {
        let ok = false;
        if (dep.condition.type === "completed")
            ok = completed.has(dep.from);
        if (dep.condition.type === "manual_approval")
            ok = false;
        if (dep.condition.type === "metric_threshold") {
            const value = metrics[dep.from]?.[dep.condition.metric];
            ok = dep.condition.op === ">=" ? value >= dep.condition.value : value <= dep.condition.value;
        }
        if (!ok)
            blocked[dep.to] = [...(blocked[dep.to] || []), `blocked by ${dep.from}:${dep.condition.type}`];
    }
    return blocked;
}
export function readPlanConfigJson(text, validate, lastKnownGood) {
    try {
        const parsed = JSON.parse(text);
        return validate(parsed) ? { ok: true, value: parsed } : { ok: false, value: lastKnownGood, error: "schema validation failed" };
    }
    catch (error) {
        return { ok: false, value: lastKnownGood, error: error instanceof Error ? error.message : String(error) };
    }
}
function gridCombinations(variables) {
    let rows = [{}];
    for (const variable of variables) {
        const next = [];
        for (const row of rows)
            for (const value of variable.values || [])
                next.push({ ...row, [variable.name]: String(value) });
        rows = next;
    }
    return rows.length ? rows : [{}];
}
function pairedCombinations(variables) {
    const length = Math.max(...variables.map((item) => item.values?.length || 0));
    const rows = [];
    for (let i = 0; i < length; i++) {
        const row = {};
        for (const variable of variables)
            row[variable.name] = String(variable.values?.[Math.min(i, (variable.values?.length || 1) - 1)] ?? "");
        rows.push(row);
    }
    return rows;
}
function experimentName(suite, overrides) {
    const body = Object.entries(overrides).map(([key, value]) => `${key}-${String(value).replace(/[^a-zA-Z0-9_.-]/g, "_")}`).join("__");
    return `${suite}__${body}`;
}
function quoteYaml(value) {
    return JSON.stringify(value);
}
function template(id, name, schemaId, relativePath) {
    return {
        schemaVersion: 1,
        id,
        name,
        schemaId,
        templateType: "yaml_template",
        variables: [
            { key: "suite", label: "Suite", type: "string", mode: "single", required: true },
            { key: "base_config", label: "Base config", type: "string", mode: "single", defaultValue: "configs/base.yaml" },
            { key: "dataset", label: "Dataset", type: "string", mode: "single" },
            { key: "seed", label: "Seed", type: "string", mode: "grid", values: ["1", "2", "3"] },
        ],
        files: [{
                relativePath: `simple_cluster/plans/generated/${relativePath}`,
                contentTemplate: [
                    "suite: {{suite}}",
                    "mode: train_test",
                    "base_config: {{base_config}}",
                    "dataset: {{dataset}}",
                    "paper:",
                    "  result_csv: {output_dir}/metrics_summary.csv",
                    "runner:",
                    "  train_command: \"python train.py --config {config} --seed {seed} --output-dir {output_dir}\"",
                    "  test_command: \"python test.py --config {config} --seed {seed} --output-dir {output_dir} --result-csv {result_csv}\"",
                    "naming:",
                    "  sweep_dir: work_dirs/multirun/{suite}",
                    "  job_name: \"{index}_{case}_seed{seed}\"",
                    "  experiment_name: \"{suite}/{case}/seed_{seed}\"",
                    "seeds: [{{seed}}]",
                    "cases:",
                    "  - case: {{suite}}_{{dataset}}",
                    "    outputDir: work_dirs/multirun/{suite}/{case}_seed{seed}",
                    "    expectedResults:",
                    "      - work_dirs/multirun/{suite}/{case}_seed{seed}/metrics_summary.csv",
                    "    overrides:",
                    "      dataset: {{dataset}}",
                ].join("\n"),
                overwritePolicy: "prompt",
            }],
        defaultTags: [schemaId],
        resultParserPresetId: schemaId.includes("medical") ? "medical_segmentation_long_csv" : "generic_metric_long_csv",
        resultSchemaId: schemaId.includes("medical") ? "medical_segmentation" : undefined,
    };
}
function varToLegacy(variable) {
    return { name: variable.key, values: variable.values };
}
function renderTemplate(text, values) {
    return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => String(values[key] ?? ""));
}
function planCaseLabelValue(text) {
    const match = text.match(/^(?:case|name|id)\s*:\s*(.+)$/);
    if (match)
        return stripYamlScalar(match[1]);
    const inlineMap = text.match(/^\{\s*(.+?)\s*\}$/)?.[1] || text;
    for (const key of ["case", "name", "id"]) {
        const inline = inlineMap.match(new RegExp(`(?:^|,)\\s*${key}\\s*:\\s*("[^"]+"|'[^']+'|[^,#{}]+)`));
        if (inline)
            return stripYamlScalar(inline[1]);
    }
    return "";
}
function planCaseScalarListValue(text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("["))
        return "";
    if (!/^["']/.test(trimmed) && /:\s*/.test(trimmed))
        return "";
    const value = stripYamlScalar(trimmed);
    return value && !/^\s*(expectedResults|expected_results|resultFiles|result_files|outputFiles|output_files)\s*$/i.test(value) ? value : "";
}
function planCaseInlineListValues(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]"))
        return [];
    return splitYamlFlowItems(trimmed.slice(1, -1))
        .map((item) => planCaseLabelValue(item) || planCaseScalarListValue(item))
        .filter(Boolean);
}
function splitYamlFlowItems(text) {
    const items = [];
    let current = "";
    let quote = "";
    let escape = false;
    let depth = 0;
    for (const ch of text) {
        if (quote) {
            current += ch;
            if (escape) {
                escape = false;
            }
            else if (ch === "\\") {
                escape = true;
            }
            else if (ch === quote) {
                quote = "";
            }
            continue;
        }
        if (ch === "\"" || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === "{" || ch === "[")
            depth++;
        if (ch === "}" || ch === "]")
            depth = Math.max(0, depth - 1);
        if (ch === "," && depth === 0) {
            if (current.trim())
                items.push(current.trim());
            current = "";
            continue;
        }
        current += ch;
    }
    if (current.trim())
        items.push(current.trim());
    return items;
}
function stripYamlScalar(value) {
    const trimmed = value.replace(/\s+#.*$/, "").trim();
    if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}
function normalizePlanScalar(value, anchors) {
    const stripped = stripYamlScalar(stripYamlLineComment(value)).trim();
    const anchor = stripped.match(/^&([A-Za-z0-9_.-]+)\s+(.+)$/);
    if (anchor) {
        const resolved = stripYamlScalar(anchor[2]).trim();
        if (resolved)
            anchors.set(anchor[1], resolved);
        return resolved;
    }
    const alias = stripped.match(/^\*([A-Za-z0-9_.-]+)$/);
    if (alias)
        return anchors.get(alias[1]) || "";
    return stripped;
}
function renderNamingRule(pattern, suite, row) {
    return pattern ? renderTemplate(pattern, { suite, ...row }) : "";
}
function evaluateValueExpression(expression, row) {
    const trimmed = expression.trim();
    if (!trimmed)
        return undefined;
    const ref = trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
    if (ref)
        return Object.prototype.hasOwnProperty.call(row, trimmed) ? row[trimmed] : trimmed;
    const arithmetic = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*([*+\-/])\s*([a-zA-Z0-9_.-]+)$/);
    if (arithmetic) {
        const a = Number(resolveToken(arithmetic[1], row));
        const b = Number(resolveToken(arithmetic[3], row));
        if (!Number.isFinite(a) || !Number.isFinite(b))
            return undefined;
        if (arithmetic[2] === "*")
            return a * b;
        if (arithmetic[2] === "+")
            return a + b;
        if (arithmetic[2] === "-")
            return a - b;
        return b === 0 ? undefined : a / b;
    }
    return trimmed.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => String(row[key] ?? ""));
}
function evaluateConstraint(expression, row) {
    const implication = expression.split(/\s*->\s*/);
    if (implication.length === 2)
        return !evaluateCondition(implication[0], row) || evaluateCondition(implication[1], row);
    return evaluateCondition(expression, row);
}
function evaluateCondition(expression, row) {
    const match = expression.trim().match(/^([a-zA-Z0-9_.-]+)(?:\s*([*])\s*([a-zA-Z0-9_.-]+))?\s*(==|!=|>=|<=|>|<)\s*["']?([^"']+)["']?$/);
    if (!match)
        throw new Error(`Invalid plan expression: ${expression}`);
    const leftValue = match[2] ? Number(resolveToken(match[1], row)) * Number(resolveToken(match[3], row)) : resolveToken(match[1], row);
    const rightValue = resolveToken(match[5], row);
    return compare(leftValue, match[4], rightValue);
}
function resolveToken(token, row) {
    if (Object.prototype.hasOwnProperty.call(row, token))
        return row[token];
    const n = Number(token);
    return Number.isFinite(n) ? n : token;
}
function compare(left, op, right) {
    if ([">", "<", ">=", "<="].includes(op)) {
        const a = Number(left);
        const b = Number(right);
        if (!Number.isFinite(a) || !Number.isFinite(b))
            return false;
        if (op === ">")
            return a > b;
        if (op === "<")
            return a < b;
        if (op === ">=")
            return a >= b;
        return a <= b;
    }
    return op === "==" ? String(left) === String(right) : String(left) !== String(right);
}
function matrixPreviewCsv(experiments) {
    const keys = Array.from(new Set(experiments.flatMap((item) => Object.keys(item.configOverrides))));
    const rows = [["experimentIndex", "experimentKey", "name", "runKey", ...keys], ...experiments.map((item) => [item.experimentIndex, item.experimentKey || "", item.name, item.runKey, ...keys.map((key) => String(item.configOverrides[key] ?? ""))])];
    return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}
function scalar(text, key) {
    const match = text.match(new RegExp(`^${key}:\\s*["']?([^"'#\\n]+)["']?`, "m"));
    return match?.[1]?.trim();
}
function stablePlanId(planFile, suite) {
    return `plan_${sha256(`${suite}:${planFile}`).slice(0, 12)}`;
}
function pathName(file) {
    return file.replace(/\\/g, "/").split("/").pop() || file;
}
function stripExt(file) {
    return pathName(file).replace(/\.[^.]+$/, "");
}
function sha256(text) {
    return createHash("sha256").update(text).digest("hex");
}
function mergeRevisions(a = [], b = []) {
    const map = new Map([...a, ...b].map((item) => [item.revisionId, item]));
    return Array.from(map.values()).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}
function planIssue(id, severity, path, message, suggestion) {
    return { id, severity, path, message, suggestion };
}
function multiply(value, count) {
    return value === undefined ? undefined : value * count;
}
function sanitizeName(value) {
    return value.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}
function sortObject(input) {
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, input[key]]));
}
function csvEscape(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export {
  buildExperimentMatrix,
  renderPlanYaml,
  parsePlanCases,
  parsePlanOutputEvidence,
  parsePlanSummary,
  normalizePlanMode,
  validateDeepLearningPlanContract,
  expandPlanMatrix,
  renderPlanTemplate,
  validateTemplateVariables,
  importLegacyPlanYamlToRegistry,
  upsertPlanRecords,
  deprecatePlan,
  validatePlanRecord,
  estimatePlanResources,
  createPlanRevision,
  diffPlans,
  cloneOrReproducePlan,
  searchPlans,
  tagPlan,
  computePlanResultCoverage,
  dependencyBlockedReasons,
  readPlanConfigJson,
  normalizeOutputCandidateKey,
};
