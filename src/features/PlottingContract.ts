import { datasetPartitions, datasetPathKey, planDirectoryKey } from "../results/ResultLayout";
export const PLOTTING_CONTRACT_DOC_PATH = "docs/output-contract-for-plotting.md";
export const PLOTTING_CONTRACT_JSON_PATH = "simple_cluster/results/plotting_contract.json";
export const plottingContractRequiredFields: string[] = [
    "method",
    "dataset",
    "split",
    "fold",
    "seed",
    "metric",
    "value",
    "mean",
    "std",
    "ci",
    "pValue",
    "adjustedPValue",
    "significant",
    "case_id",
    "patient_id",
    "subgroup",
    "error_type",
];

export function planSlugFromPlanFile(planFile: string): string {
    const text = String(planFile || "").trim().replace(/\\/g, "/");
    if (!text) return "";
    const base = text.split("/").pop() || text;
    const stem = base.replace(/\.[^.]+$/, "");
    return stem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

export function planResultsArtifactRelPath(planFile: string, filename: string): string {
    const slug = planSlugFromPlanFile(planFile);
    const name = String(filename || "").replace(/^\/+/, "");
    if (!name) throw new Error("artifact filename required");
    if (!slug) return `simple_cluster/results/${name}`;
    return `simple_cluster/results/by_plan/${slug}/${name}`;
}

export function plottingContractJsonPath(planFile: string): string {
    return planResultsArtifactRelPath(planFile, "plotting_contract.json");
}

export function plottingContractMarkdownPath(planFile: string): string {
    return planResultsArtifactRelPath(planFile, "output_contract_for_plotting.md");
}

export function statisticsJsonPath(planFile: string): string {
    return planResultsArtifactRelPath(planFile, "statistics.json");
}

export function resultRegistryJsonPath(planFile: string): string {
    return planResultsArtifactRelPath(planFile, "result_registry.json");
}

export function caseLevelIndexJsonPath(planFile: string): string {
    return planResultsArtifactRelPath(planFile, "case_level_index.json");
}

export function paperTableCsvPath(planFile: string, dataset: string = ""): string {
    return `paper/tables/${datasetPathKey(dataset)}/simple_results_table__${planFile ? planDirectoryKey(planFile) : "project"}.csv`;
}

export function datasetProfileJsonPath(planFile: string): string {
    const slug = planSlugFromPlanFile(planFile);
    if (!slug) return "simple_cluster/datasets/profile.json";
    return `simple_cluster/datasets/by_plan/${slug}/profile.json`;
}

export interface PlottingFileContract {
    path: string;
    paths?: string[];
    description: string;
    fields: string[];
}

export interface PlottingOutputContract {
    schemaVersion: number;
    generatedAt: string;
    consumer: string;
    planFile: string;
    requiredFields: string[];
    files: Record<string, PlottingFileContract>;
    notes: string[];
}

export function buildPlottingOutputContract(generatedAt: string = new Date().toISOString(), planFile: string = "", datasets: string[] = []): PlottingOutputContract {
    const plan = String(planFile || "").trim();
    const paperPaths = datasetPartitions(datasets).map(({dataset}) => paperTableCsvPath(plan, dataset));
    return {
        schemaVersion: 1,
        generatedAt,
        consumer: "D:/GitRepo/my_ppt_app",
        planFile: plan || "",
        requiredFields: plottingContractRequiredFields,
        files: {
            resultRegistry: {
                path: resultRegistryJsonPath(plan),
                description: "实验注册表，适配 PPT 可视化的所有可绘图实验。",
                fields: ["resultId", "experimentId", "suite", "method", "dataset", "split", "fold", "seed", "metrics", "dimensions", "sourceFiles"],
            },
            statistics: {
                path: statisticsJsonPath(plan),
                description: "聚合统计，PPT 均值图默认使用该文件的 mean/std/ci，避免单 seed 原始数据。",
                fields: ["suite", "group", "method", "dataset", "split", "metric", "value", "mean", "std", "ci", "n", "pValue", "adjustedPValue", "significant", "aggregationPolicy"],
            },
            paperTable: {
                path: paperPaths.length === 1 ? paperPaths[0] : "",
                paths: paperPaths,
                description: "按数据集选择独立论文表格 CSV，聚合后可直接按 mean/std 绘制柱状图、箱线图等。",
                fields: ["method", "dataset", "split", "suite", "group", "metric", "mean", "std", "ci", "n", "direction", "pValue", "adjustedPValue", "significant"],
            },
            caseLevel: {
                path: caseLevelIndexJsonPath(plan),
                description: "病例级索引，适合大样本与亚组漏斗图。",
                fields: ["case_id", "patient_id", "method", "dataset", "split", "metric", "value", "subgroup", "error_type"],
            },
            datasetProfile: {
                path: datasetProfileJsonPath(plan),
                description: "数据集分布，适合类别与 split 分布漏斗摘要图。",
                fields: ["dataset", "split", "class", "case_id", "patient_id", "classDistribution", "splitDistribution"],
            },
        },
        notes: [
            "字段使用 camelCase 或 snake_case 时 PPT 端需按本契约归一化。",
            "所有文件均为原始数据聚合或 checkpoint 映射，源数据仅保留 manifest 与统计摘要。",
            "集群只负责文件产出与同步，绘图由 VS Code 端调用 PPT 自动化或 Zotero 获取 Zotero DB。",
            "PPT automation discovery 固定为 %LOCALAPPDATA%/RoughPptAddin/automation.json 与 automation.token，通信固定为 GET /health 与 POST /api/simple-experiment/plot。",
            "automation endpoint 固定单一本地地址，所有 /health 与 /api/simple-experiment/plot 请求按 discovery 中的基础 path 拼接协议路径。",
            "绘图参数字段定义为 schemaVersion/requestId/projectRoot/sourcePaths/plottingContractPath/selectedResultId/runKey/archiveKey/chartType/target/styleMode/sourceLabel/markdownSummary，新增字段只做 additive，兼容 optional extensions。",
            "sourcePaths 只需指向已存在的本地 JSON/CSV/Markdown 或 TeX 文件，不许传目录；raw dataset 与 checkpoint 中间文件不得外传。",
            "SCI 均值绘图默认以 statistics.json 与 paper table 的 mean/std/ci 为准，result_registry.json 与单病例 CSV 仅在细分追踪时作为可选绘图值源。",
            "pValue/adjustedPValue 允许为空，significant 仅作可选展示，以统计结果文本为准。",
        ],
    };
}

export function plottingContractMarkdown(contract: PlottingOutputContract = buildPlottingOutputContract()): string {
    const lines: string[] = [
        "# SimpleExperiment 输出与 PPT 绘图契约稳定版",
        "",
        `目标消费端：\`${contract.consumer}\``,
        "",
        "本契约只约束本地聚合产物的路径与结构，不暴露原始数据集与权重或 checkpoint 文件。",
        "",
        "## 关键共享字段",
        "",
        ...contract.requiredFields.map((field: string) => `- \`${field}\``),
        "",
        "## 文件契约",
        "",
    ];
    for (const [key, file] of Object.entries(contract.files) as Array<[string, PlottingFileContract]>) {
        lines.push(`### ${key}`, "", `路径：\`${file.paths?.join("、") || file.path}\``, "", file.description, "", "字段：", ...file.fields.map((field: string) => `- \`${field}\``), "");
    }
    lines.push("## 补充说明", "", ...contract.notes.map((note: string) => `- ${note}`), "");
    return lines.join("\n");
}
