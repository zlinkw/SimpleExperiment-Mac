import * as fs from "fs";
import * as path from "path";
import { normalizePosixRelativePath } from "../mac/PosixPath";
import { datasetPartitions, datasetPathKey, planDirectoryKey, tablePaths, workerDirectoryKey } from "./ResultLayout";
export { datasetPartitions, datasetPathKey, planDirectoryKey, planArtifactPath } from "./ResultLayout";

export type SeedRecord = { planFile: string; workerId: string; case: string; seed: string; method: string; dataset: string; datasetSource?: string; rate: string; endpoint: string; metrics: Record<string, number>; runId?: string; attempt?: string; revision?: string; jobDir?: string; checkpointPath?: string };
export type DerivedMetric = { metric: string; leftEndpoint: string; rightEndpoint: string; outputName: string; scale: number };
export type TableRegistry = { schemaVersion: 1; plans: Record<string, { revision: string; expectedSeeds: number; records: SeedRecord[]; wrapperEvidence?: unknown }>; derivedMetric?: DerivedMetric; publicationGeneration?: string };
export const emptyTableRegistry = (): TableRegistry => ({ schemaVersion: 1, plans: {} });

export function normalizePlanDatasetKey(value: unknown): string {
  if (process.platform === "darwin") return typeof value === "string" ? value : "";
  return path.posix.normalize(String(value || "").trim().replace(/\\/g, "/")).replace(/^\.\//, "").toLowerCase();
}

export type PlanDatasetAssignment = { kind: "single" | "multiple" | "unassigned"; datasets: string[]; source: "result-record" | "dataset-table" | "plan-declaration" | "historical-registry" | "manual-override" | "none"; conflict?: { actual: string[]; mapped: string[] } };
export function resolvePlanDatasetAssignment(input: { resultRecords?: any[]; datasetTables?: any[]; planDeclaration?: unknown; historicalRecords?: any[]; manualMapping?: any }): PlanDatasetAssignment {
  const datasetsOf = (records: any[]) => [...new Set(records.map(row => String(row?.dataset || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const current = datasetsOf(input.resultRecords || []);
  if (current.length) {
    const mapped = datasetsOf((Array.isArray(input.manualMapping?.datasets) ? input.manualMapping.datasets : []).map((dataset: unknown) => ({ dataset })));
    return { kind: current.length === 1 ? "single" : "multiple", datasets: current, source: "result-record", ...(mapped.some(item => !current.includes(item)) ? { conflict: { actual: current, mapped } } : {}) };
  }
  const table = datasetsOf(input.datasetTables || []);
  if (table.length) return { kind: table.length === 1 ? "single" : "multiple", datasets: table, source: "dataset-table" };
  const declared = String(input.planDeclaration || "").trim();
  if (declared) return { kind: "single", datasets: [declared], source: "plan-declaration" };
  const historical = datasetsOf(input.historicalRecords || []);
  if (historical.length) {
    const mapped = datasetsOf((Array.isArray(input.manualMapping?.datasets) ? input.manualMapping.datasets : []).map((dataset: unknown) => ({ dataset })));
    return { kind: historical.length === 1 ? "single" : "multiple", datasets: historical, source: "historical-registry", ...(mapped.some(item => !historical.includes(item)) ? { conflict: { actual: historical, mapped } } : {}) };
  }
  const mapped = datasetsOf((Array.isArray(input.manualMapping?.datasets) ? input.manualMapping.datasets : []).map((dataset: unknown) => ({ dataset })));
  if (mapped.length) return { kind: mapped.length === 1 ? "single" : "multiple", datasets: mapped, source: "manual-override" };
  return { kind: "unassigned", datasets: [], source: "none" };
}

export function applyPlanDatasetOverrides(registry: TableRegistry, mappings: Record<string, any>): TableRegistry {
  const normalized = new Map(Object.entries(mappings || {}).map(([plan, value]) => [normalizePlanDatasetKey(plan), value]));
  const plans: TableRegistry["plans"] = {};
  for (const [planFile, plan] of Object.entries(registry.plans || {})) {
    const mapping = normalized.get(normalizePlanDatasetKey(planFile));
    const mapped = Array.isArray(mapping?.datasets) && mapping.datasets.length === 1 ? String(mapping.datasets[0] || "").trim() : "";
    if (!mapped) { plans[planFile] = plan; continue; }
    datasetPathKey(mapped);
    const records = plan.records.map(record => String(record.dataset || "").trim() ? record : { ...record, dataset: mapped, datasetSource: "manual-plan-mapping" });
    plans[planFile] = { ...plan, records };
  }
  return { ...registry, plans };
}

export function registeredPlanSummary(registry: TableRegistry, planFile: string): any | undefined {
  const plan = registry.plans?.[planFile];
  if (!plan?.records?.length || !plan.revision) return undefined;
  const records = plan.records;
  if (records.some((row) => row.planFile !== planFile || !row.workerId || !row.case || !String(row.seed ?? "").trim()
    || !Object.values(row.metrics || {}).some((value) => typeof value === "number" && Number.isFinite(value)))) return undefined;
  const source = "simple_cluster/results/project_table_registry.json";
  return {
    planFile, planRevision: plan.revision, source: "registered-local-seeds",
    ...(plan.wrapperEvidence ? { wrapperEvidence: plan.wrapperEvidence } : {}),
    rawResultCsvPath: source,
    workerResultTables: [...new Set(records.map((row) => row.workerId))].map((workerId) => ({ workerId, aggregateStatus: "ready", rawResultCsvPath: source })),
    results: records.map((row) => ({
      workerId: row.workerId, runId: row.runId || "", attempt: row.attempt || "", planRevision: row.revision || plan.revision,
      ...(row.jobDir ? { jobDir: row.jobDir } : {}), ...(row.checkpointPath ? { checkpointPath: row.checkpointPath } : {}),
      ...(row.datasetSource ? { datasetSource: row.datasetSource } : {}),
      dimensions: { case: row.case, seed: row.seed, method: row.method, dataset: row.dataset, rate_percent: row.rate, eval_protocol: row.endpoint },
      metrics: row.metrics, sourceFiles: [{ path: source }],
    })),
  };
}

export function summaryMatchesPlanRevision(summary: any, plan: any): boolean {
  const current = String(plan?.revision || "").trim();
  const reported = String(summary?.planRevision || "").trim();
  return !current || !reported || current === reported;
}

export function safeTableName(value: string): string {
  const token = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+|\.+$/g, "").slice(0, 80);
  if (!token || token === "." || token === "..") throw new Error("结果名称不能映射到安全文件夹。");
  return token;
}
export function methodTableName(value: string): string {
  const name = safeTableName(value);
  return name === "final" ? "_method_final" : name;
}

export function methodForSummary(summary: any, planFile: string): string {
  const names = new Set<string>();
  for (const row of Array.isArray(summary?.results) ? summary.results : []) {
    const name = String(row?.dimensions?.method || row?.method || "").trim();
    if (name) names.add(name);
  }
  if (names.size > 1) throw new Error("当前 Plan 包含多个方法，请分别配置方法结果路径：" + [...names].join("、"));
  return methodTableName([...names][0] || path.posix.basename(planFile, path.posix.extname(planFile)));
}

function ratePercent(dims: any): string {
  if (dims.rate_percent !== undefined && dims.rate_percent !== null && String(dims.rate_percent).trim()) return String(dims.rate_percent).trim();
  if (dims.train_rate === undefined || dims.train_rate === null || String(dims.train_rate).trim() === "") return "";
  const n = Number(dims.train_rate);
  return Number.isFinite(n) ? String(Number((n * (Math.abs(n) <= 1 ? 100 : 1)).toPrecision(12))) : String(dims.train_rate).trim();
}

function recordRunId(row: any, summary: any): string {
  const own = String(row?.runId || row?.run_id || row?.provenance?.runId || "").trim();
  if (own) return own;
  const selected = String(summary?.completedRunId || summary?.runId || "").trim();
  const contradictory = (Array.isArray(summary?.results) ? summary.results : []).some((item: any) => {
    const runId = String(item?.runId || item?.run_id || item?.provenance?.runId || "").trim();
    return runId && selected && runId !== selected;
  });
  return selected && !contradictory ? selected : "";
}
function recordAttempt(row: any, summary: any): string {
  return String(row?.attempt || row?.attemptId || row?.provenance?.attempt || summary?.attempt || "").trim();
}
function attemptOrder(value: string): { rank: number; at: number } | undefined {
  const text = String(value || "").trim();
  if (/^\d+$/.test(text)) return { rank: Number(text), at: 0 };
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return { rank: 0, at: parsed };
  return undefined;
}
function seedIdentity(record: SeedRecord): string {
  return [record.workerId, record.method, record.dataset, record.rate, record.endpoint, record.case, record.seed].join("\0");
}
export function selectLatestCompletedRun(records: SeedRecord[], selectedRunId = ""): SeedRecord[] {
  const identified = records.filter((record) => record.runId);
  const anonymous = records.filter((record) => !record.runId);
  const requested = String(selectedRunId || "").trim();
  let chosen = "";
  if (requested) {
    chosen = requested;
  } else {
    const runs = [...new Set(identified.map((record) => record.runId as string))];
    if (runs.length > 1)
      throw new Error("结果包含多个完成 run（" + runs.join("、") + "），没有明确的完成运行选择，保留旧表。下一步：由 ledger 或摘要标明要展示的完成 run。");
    chosen = runs[0] || "";
  }
  const selected = chosen ? identified.filter((record) => record.runId === chosen) : anonymous;
  if (chosen && !selected.length && anonymous.length)
    throw new Error("完成运行 " + chosen + " 没有带 run 身份的指标，不能把未知记录当成该次运行。下一步：重新同步该完成运行的指标。");
  const revisions = [...new Set(selected.map((record) => record.revision || "").filter(Boolean))];
  if (revisions.length > 1)
    throw new Error("同一次完成运行包含多个 revision，已保留旧表。下一步：核对该 Plan 的完成 run。");
  const bySeed = new Map<string, SeedRecord>();
  for (const record of selected) {
    const key = seedIdentity(record);
    const previous = bySeed.get(key);
    if (!previous) { bySeed.set(key, record); continue; }
    const left = attemptOrder(previous.attempt || "");
    const right = attemptOrder(record.attempt || "");
    let winner = record;
    let loser = previous;
    if (previous.attempt === record.attempt) {
      const metrics = { ...previous.metrics };
      for (const [name, value] of Object.entries(record.metrics)) {
        if (metrics[name] !== undefined && metrics[name] !== value)
          throw new Error("同一完成运行的 seed 指标冲突：" + record.case + "/" + record.seed + "/" + name + "。已保留旧表。");
        metrics[name] = value;
      }
      bySeed.set(key, { ...record, metrics });
      continue;
    }
    if (left && right && (left.rank !== right.rank || left.at !== right.at)) {
      const rightNewer = right.rank > left.rank || right.at > left.at;
      bySeed.set(key, rightNewer ? record : previous);
      continue;
    }
    throw new Error("同一完成运行的 seed 有无法比较的 attempt：" + record.case + "/" + record.seed + "。下一步：为该 seed 保留唯一可排序的 attempt。");
  }
  return [...bySeed.values()];
}
function rawSources(table: any): string[] {
  return [table?.rawResultCsvPath, ...(table?.rawResultCsvPaths || []), ...(table?.datasetResultTables || []).map((row: any) => row.rawResultCsvPath)].filter(Boolean).map(String);
}
export function recordsForSummary(summary: any, planFile: string, manualMappings: Record<string, any> = {}): SeedRecord[] {
  const mac = process.platform === "darwin";
  if (mac) normalizePosixRelativePath(planFile, "结果 Plan 路径");
  if (!summary || (mac ? summary.planFile !== planFile
    : String(summary.planFile || "").replace(/\\/g, "/") !== planFile.replace(/\\/g, "/"))) throw new Error("结果摘要与所选 Plan 不匹配。");
  if ((summary.incompleteAggregate && summary.verifiedPartial !== true) || (Array.isArray(summary.unavailableWorkerIds) && summary.unavailableWorkerIds.length && summary.verifiedPartial !== true)) throw new Error("部分 Worker 离线，暂不覆盖总表。");
  const tables = Array.isArray(summary.workerResultTables) ? summary.workerResultTables : [];
  if (tables.some((row: any) => row.aggregateStatus && row.aggregateStatus !== "ready")) throw new Error("部分 Worker 的当前 Plan 汇总未就绪。");
  const sources = new Map<string, Set<string>>();
  for (const row of tables) {
    const worker = String(row.workerId || "").toLowerCase();
    if (!sources.has(worker)) sources.set(worker, new Set());
    rawSources(row).forEach(source => sources.get(worker)!.add(source));
  }
  const records: SeedRecord[] = [];
  const summaryRows = Array.isArray(summary.results) ? summary.results : [];
  const summaryDatasets: string[] = [...new Set<string>(summaryRows.map((row: any) => String(row?.dimensions?.dataset || "").trim()).filter(Boolean))];
  for (const row of summaryRows) {
    const workerId = String(row?.workerId || row?.resultOwnerWorkerId || summary.resultOwnerWorkerId || "").trim();
    const declared = sources.get(workerId.toLowerCase()) || new Set(rawSources(summary));
    const source = String(row?.sourceFiles?.[0]?.path || "");
    if (!source || !declared.has(source)) continue;
    const dims = row?.dimensions || {};
    const caseName = String(dims.case || "").trim();
    const seed = String(dims.seed ?? "").trim();
    if (!caseName || !seed) throw new Error("原始结果缺少可信 case 或 seed，请先设置列映射。");
    const metrics: Record<string, number> = {};
    for (const [name, payload] of Object.entries(row?.metrics || {})) {
      const raw = (payload as any)?.value ?? payload;
      if (raw === "" || raw === null || raw === undefined) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) metrics[name] = value;
    }
    if (!Object.keys(metrics).length) continue;
    const runId = recordRunId(row, summary);
    const attempt = recordAttempt(row, summary);
    const revision = String(row?.planRevision || row?.provenance?.planRevision || summary.planRevision || "").trim();
    const declaredDataset = String(dims.dataset || "").trim();
    const mapping = Object.entries(manualMappings || {}).find(([file]) => normalizePlanDatasetKey(file) === normalizePlanDatasetKey(planFile))?.[1];
    const mappedDataset = summaryDatasets.length === 1 ? summaryDatasets[0] : summaryDatasets.length ? "" : Array.isArray(mapping?.datasets) && mapping.datasets.length === 1 ? String(mapping.datasets[0] || "").trim() : "";
    const dataset = declaredDataset || mappedDataset;
    const isManual = row?.datasetSource === "manual-plan-mapping" || (!declaredDataset && summaryDatasets.length === 0 && Boolean(mappedDataset));
    records.push({ planFile, workerId, case: caseName, seed, method: String(dims.method || row.method || "").trim() || path.posix.basename(planFile, path.posix.extname(planFile)), dataset, ...(isManual ? { datasetSource: "manual-plan-mapping" } : {}), rate: ratePercent(dims), endpoint: String(dims.eval_protocol || dims.split || "").trim(), metrics, runId, attempt, revision,
      ...(row.jobDir ? { jobDir: row.jobDir } : {}), ...(row.checkpointPath ? { checkpointPath: row.checkpointPath } : {}) });
  }
  if (!records.length) throw new Error("当前 Plan 没有可核对的逐 seed 原始记录。");
  const selected = selectLatestCompletedRun(records, String(summary.completedRunId || summary.selectedRunId || ""));
  if (!selected.length) throw new Error("当前 Plan 没有可核对的逐 seed 原始记录。");
  return selected;
}

function assertWrapperRecordIdentity(evidence: any, records: SeedRecord[]): void {
  if (!evidence) return;
  if (evidence.status !== 'formal' || !evidence.runId || records.some(record => {
    const job = evidence.jobs?.find((item: any) => item.job?.case === record.case && String(item.job?.seed) === record.seed);
    return record.runId !== evidence.runId || !job || record.workerId !== job.job.workerId
      || record.jobDir && record.jobDir !== job.job.outputDir || record.checkpointPath && record.checkpointPath !== job.checkpointPath;
  })) throw new Error("wrapper 与端点运行身份不一致，保留原有完整结果");
}

export function updateRegistry(registry: TableRegistry, summary: any, planFile: string, expectedSeeds = 0, manualMappings: Record<string, any> = {}): TableRegistry {
  if (registry.plans?.[planFile]?.wrapperEvidence && !summary?.wrapperEvidence || summary?.wrapperEvidence?.status === 'preview')
    throw new Error("wrapper 完整结果证明缺失或仅为预览，保留已发布的完整结果");
  const records = recordsForSummary(summary, planFile, manualMappings);
  assertWrapperRecordIdentity(summary.wrapperEvidence, records);
  return { schemaVersion: 1, ...(registry?.publicationGeneration ? { publicationGeneration: registry.publicationGeneration } : {}), plans: { ...(registry?.plans || {}), [planFile]: { revision: String(summary.planRevision || ""), expectedSeeds: Math.max(0, Math.floor(expectedSeeds)), records,
    ...(summary.wrapperEvidence ? { wrapperEvidence: summary.wrapperEvidence } : {}) } } };
}

export function summaryForWorker(summary: any, workerId: string): any | undefined {
  const id = String(workerId || "").toLowerCase();
  const tables = (Array.isArray(summary?.workerResultTables) ? summary.workerResultTables : []).filter((row: any) => String(row?.workerId || "").toLowerCase() === id && row?.aggregateStatus === "ready" && rawSources(row).length > 0);
  const results = (Array.isArray(summary?.results) ? summary.results : []).filter((row: any) => String(row?.workerId || row?.resultOwnerWorkerId || "").toLowerCase() === id);
  if (!tables.length || !results.length) return undefined;
  return { ...summary, workerResultTables: tables, results, availableWorkerIds: [workerId], unavailableWorkerIds: [], incompleteAggregate: false, resultOwnerWorkerId: workerId };
}

export function mergeAvailableWorkerResults(registry: TableRegistry, summary: any, planFile: string, expectedSeeds = 0, manualMappings: Record<string, any> = {}): TableRegistry {
  const tables = Array.isArray(summary?.workerResultTables) ? summary.workerResultTables : [];
  const ready = tables.filter((table: any) => table?.aggregateStatus === "ready" && rawSources(table).length > 0);
  const owners = new Set(ready.map((table: any) => String(table.workerId || "").toLowerCase()));
  const rows = (Array.isArray(summary?.results) ? summary.results : []).filter((row: any) => owners.has(String(row?.workerId || row?.resultOwnerWorkerId || "").toLowerCase()));
  if (!rows.length) {
    const evidence = summary?.wrapperEvidence;
    if (evidence?.status !== 'formal' || !evidence.runId || !evidence.jobs?.length) return registry;
    if (registry.plans?.[planFile]?.records?.length) throw new Error("新 wrapper 缺少既有端点指标，保留原有完整结果");
    return { ...registry, plans: { ...registry.plans, [planFile]: { revision: String(summary.planRevision || ''),
      expectedSeeds: Math.max(0, Math.floor(expectedSeeds)), records: [], wrapperEvidence: evidence } } };
  }
  const partial = { ...summary, workerResultTables: ready, results: rows, unavailableWorkerIds: [], incompleteAggregate: false };
  const incoming = recordsForSummary({ ...partial, completedRunId: summary.completedRunId || summary.selectedRunId || "", stampCompletedRunId: summary.stampCompletedRunId === true }, planFile, manualMappings);
  assertWrapperRecordIdentity(summary.wrapperEvidence, incoming);
  const incomingRun = String(summary.completedRunId || summary.selectedRunId || incoming.find((record) => record.runId)?.runId || "");
  const previous = registry.plans?.[planFile];
  if ((summary.wrapperEvidence as any)?.status === 'preview' || previous?.wrapperEvidence && !summary.wrapperEvidence)
    throw new Error("wrapper 完整结果证明缺失或仅为预览，保留已发布的完整结果");
  const revision = String(incoming.find((record) => record.revision)?.revision || summary.planRevision || "");
  const sameRevision = !previous?.revision || !revision || previous.revision === revision;
  const covered = (record: SeedRecord) => incoming.some((item) => seedIdentity(item) === seedIdentity(record));
  const realIncoming = incoming.filter(record => record.dataset && record.datasetSource !== "manual-plan-mapping");
  const sameSeedWithoutDataset = (left: SeedRecord, right: SeedRecord) => [left.workerId, left.method, left.rate, left.endpoint, left.case, left.seed].join("\0") === [right.workerId, right.method, right.rate, right.endpoint, right.case, right.seed].join("\0");
  const belongsToIncomingRun = (record: SeedRecord) => incomingRun ? record.runId === incomingRun : !record.runId;
  // A complete recovery is the canonical endpoint set for its verified wrapper generation.
  // Keeping old same-run rows can retain legacy endpoint names without job/checkpoint provenance.
  const completeRecovery = summary.recoveredCompletedJobs === true && summary.wrapperEvidence?.status === 'formal';
  const kept = sameRevision && !completeRecovery
    ? (previous?.records || []).filter((record) => !covered(record) && !(record.datasetSource === "manual-plan-mapping" && realIncoming.some(item => sameSeedWithoutDataset(record, item))) && record.revision === revision && belongsToIncomingRun(record))
    : [];
  return { schemaVersion: 1, ...(registry?.publicationGeneration ? { publicationGeneration: registry.publicationGeneration } : {}), plans: { ...(registry?.plans || {}), [planFile]: {
    revision: revision || previous?.revision || "",
    expectedSeeds: Math.max(0, Math.floor(expectedSeeds || previous?.expectedSeeds || 0)),
    records: selectLatestCompletedRun([...kept, ...incoming], incomingRun),
    ...(summary.wrapperEvidence ? { wrapperEvidence: summary.wrapperEvidence } : {}),
  } } };
}

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function writeCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
export function readCsv(text: string, delimiter = ","): { header: string[]; rows: string[][] } {
  if (delimiter !== "," && delimiter !== "\t") throw new Error("结果表分隔符不支持。");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') { if (cell) throw new Error("CSV 引号格式无效。"); quoted = true; }
    else if (c === delimiter) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (quoted) throw new Error("CSV 末尾引号未闭合。");
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  const [header = [], ...data] = rows;
  if (!header.length || new Set(header).size !== header.length || data.some((item) => item.length !== header.length)) throw new Error("CSV 表头或列数无效。");
  return { header, rows: data };
}

export type ResultTable = { header: string[]; rows: (string | number)[][]; markdown: string };
const METRIC_EQUIVALENCE_GROUPS: Record<string, string[]> = {
  AUC: ["auc", "auroc", "roc_auc"],
  AUPRC: ["ap", "average_precision", "auprc", "pr_auc"],
  accuracy: ["acc", "accuracy"],
  brier: ["brier", "brier_score"],
  ECE: ["ece"],
  F1: ["f1", "f1_score"],
  macro_f1: ["f1_macro", "macro_f1"],
  micro_f1: ["f1_micro", "micro_f1"],
  weighted_f1: ["f1_score_weighted", "f1_weighted", "weighted_f1"],
  recall: ["recall", "sensitivity"],
};
const METRIC_EQUIVALENCE = new Map(Object.entries(METRIC_EQUIVALENCE_GROUPS).flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical] as const)));
function canonicalMetricName(value: string): string {
  const name = String(value || "").trim();
  return METRIC_EQUIVALENCE.get(name.toLowerCase()) || name;
}
function canonicalMetricValues(metrics: Record<string, number>): Record<string, number> {
  const values: Record<string, number> = {};
  const sources = new Map<string, string>();
  for (const [source, value] of Object.entries(metrics || {})) {
    const name = canonicalMetricName(source);
    if (values[name] !== undefined && values[name] !== value)
      throw new Error("同一完成运行的等价指标值冲突：" + sources.get(name) + " / " + source + "。已保留旧表。");
    values[name] = value;
    sources.set(name, source);
  }
  return values;
}
function buildDatasetTables(registry: TableRegistry): Record<string, ResultTable> {
  type Group = { record: SeedRecord; expected: number; seeds: Map<string, Record<string, number>>; derived?: number[] };
  const grouped = new Map<string, Group>();
  for (const plan of Object.values(registry.plans || {})) for (const record of plan.records) {
    const identity = JSON.stringify([record.planFile, record.method, record.dataset, record.rate, record.endpoint, record.case]);
    const group = grouped.get(identity) || { record, expected: 0, seeds: new Map() };
    group.expected = Math.max(group.expected, plan.expectedSeeds);
    const values = group.seeds.get(record.seed) || {};
    for (const [name, value] of Object.entries(canonicalMetricValues(record.metrics))) {
      if (values[name] !== undefined && values[name] !== value) throw new Error("重复 seed 的指标冲突：" + record.method + "/" + record.case + "/" + record.seed + "/" + name);
      values[name] = value;
    }
    group.seeds.set(record.seed, values);
    grouped.set(identity, group);
  }
  const groups = [...grouped.values()];
  const derived = registry.derivedMetric;
  if (derived && derived.metric && derived.leftEndpoint && derived.rightEndpoint && derived.outputName) {
    if (![1, 100].includes(Number(derived.scale)) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(derived.outputName)) throw new Error("派生指标配置无效。");
    for (const group of groups) {
      const base = group.record;
      const key = (endpoint: string) => JSON.stringify([base.planFile, base.method, base.dataset, base.rate, endpoint, base.case]);
      const left = grouped.get(key(derived.leftEndpoint));
      const right = grouped.get(key(derived.rightEndpoint));
      if (!left || !right) continue;
      const values: number[] = [];
      for (const [seed, metrics] of left.seeds) {
        const other = right.seeds.get(seed);
        const metric = canonicalMetricName(derived.metric);
        if (other && Number.isFinite(metrics[metric]) && Number.isFinite(other[metric]))
          values.push((metrics[metric] - other[metric]) * Number(derived.scale));
      }
      group.derived = values;
    }
  }
  const methodNames = new Map<string, string>();
  for (const group of groups) {
    const token = methodTableName(group.record.method);
    const previous = methodNames.get(token.toLowerCase());
    if (previous && previous !== group.record.method) throw new Error("不同方法映射到同一文件夹：" + previous + "、" + group.record.method);
    methodNames.set(token.toLowerCase(), group.record.method);
  }
  const shortKeys = groups.map((group) => JSON.stringify([group.record.method, group.record.dataset, group.record.rate, group.record.endpoint]));
  const showCase = new Set(shortKeys).size !== shortKeys.length;
  const make = (chosen: Group[]): ResultTable => {
    const metrics = [...new Set(chosen.flatMap((group) => [...group.seeds.values()].flatMap((seed) => Object.keys(seed))))].sort();
    const label = (name: string) => {
      const preferred: Record<string, string> = { AUC: "roc_auc", AUPRC: "auprc", accuracy: "accuracy", F1: "f1_score", macro_f1: "macro_f1", micro_f1: "micro_f1", weighted_f1: "weighted_f1", ECE: "ece", brier: "brier_score", recall: "recall" };
      return (preferred[name] || name).replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "metric";
    };
    const labels = metrics.map(label);
    if (new Set(labels).size !== labels.length) throw new Error("多个原始指标映射到同一结果列。");
    const derivedName = derived?.outputName ? label(derived.outputName) : "";
    if (derivedName && labels.includes(derivedName)) throw new Error("派生指标输出列名与原始指标冲突。");
    const showPlan = true;
    const header = ["result_family", ...(showPlan ? ["plan_file"] : []), "dataset", "rate_percent", "eval_protocol", ...(showCase ? ["case"] : []), "jobs", ...labels.flatMap((name) => [name + "_mean", name + "_sd"]), ...(derivedName ? [derivedName + "_mean", derivedName + "_sd"] : [])];
    const ordered = [...chosen].sort((a, b) => a.record.method.localeCompare(b.record.method) || a.record.dataset.localeCompare(b.record.dataset) || Number(a.record.rate) - Number(b.record.rate) || a.record.endpoint.localeCompare(b.record.endpoint) || a.record.case.localeCompare(b.record.case));
    const rows = ordered.map((group) => {
      const seeds = [...group.seeds.values()];
      const expected = group.expected || seeds.length;
      const counts = metrics.map((name) => seeds.filter((seed) => name in seed).length).filter(Boolean);
      const jobs = counts.length ? Math.min(...counts) : seeds.length;
      const row: (string | number)[] = [group.record.method, ...(showPlan ? [group.record.planFile] : []), group.record.dataset, group.record.rate, group.record.endpoint, ...(showCase ? [group.record.case] : []), jobs === expected ? String(jobs) : String(jobs) + "/" + expected];
      for (const name of metrics) {
        const values = seeds.map((seed) => seed[name]).filter(Number.isFinite);
        const complete = values.length === expected;
        const mean = complete ? values.reduce((a, b) => a + b, 0) / values.length : "";
        const sd = complete && values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - Number(mean)) ** 2, 0) / (values.length - 1)) : "";
        row.push(mean, sd);
      }
      if (derivedName) {
        const values = group.derived || [];
        const complete = values.length === expected;
        const mean = complete ? values.reduce((a, b) => a + b, 0) / values.length : "";
        const sd = complete && values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - Number(mean)) ** 2, 0) / (values.length - 1)) : "";
        row.push(mean, sd);
      }
      return row;
    });
    const mdHeader = header.filter((field) => !field.endsWith("_sd"));
    const mdRows = rows.map((row) => mdHeader.map((field) => {
      const index = header.indexOf(field);
      if (field.endsWith("_mean")) {
        const mean = row[index], sd = row[header.indexOf(field.slice(0, -5) + "_sd")];
        return mean === "" ? "—" : Number(mean).toFixed(4) + (sd === "" ? "" : " ± " + Number(sd).toFixed(4));
      }
      return String(row[index]).replace(/\|/g, "\\|");
    }));
    const markdown = "| " + mdHeader.join(" | ") + " |\n| " + mdHeader.map(() => "---").join(" | ") + " |\n" + mdRows.map((row) => "| " + row.join(" | ") + " |").join("\n") + "\n";
    return { header, rows, markdown };
  };
  const out: Record<string, ResultTable> = {};
  if (groups.length) out.final = make(groups);
  const methods = new Set(groups.map((group) => methodTableName(group.record.method)));
  for (const method of methods) out[method] = make(groups.filter((group) => methodTableName(group.record.method) === method));
  return out;
}

export type ResultTableArtifact = ResultTable & { dataset: string; datasetKey: string; name: string; kind: "final" | "method"; tableKey: string; relativePath: string; markdownPath: string };
export function buildTables(registry: TableRegistry): Record<string, ResultTableArtifact> {
  const datasets = datasetPartitions(Object.values(registry.plans || {}).flatMap(plan => plan.records.map(row => row.dataset)));
  const output: Record<string, ResultTableArtifact> = {};
  for (const { dataset, datasetKey } of datasets) {
    const plans = Object.fromEntries(Object.entries(registry.plans || {}).map(([file, plan]) => [file, { ...plan, records: plan.records.filter(row => String(row.dataset || "").trim() === dataset).map(row => ({...row, dataset})) }]));
    for (const [name, table] of Object.entries(buildDatasetTables({ ...registry, plans }))) {
      const kind: "final" | "method" = name === "final" ? "final" : "method";
      const artifact = { ...table, dataset, datasetKey, name, kind, ...tablePaths(datasetKey, name, kind) };
      output[artifact.tableKey] = artifact;
    }
  }
  return output;
}

export function splitCsvByValues(csv: string, field: string, values: string[], columns: string[]): Record<string, string> {
  const { header, rows } = readCsv(csv);
  const index = header.indexOf(field);
  if (index < 0) throw new Error("拆表列不存在：" + field);
  const selected = new Set(values);
  if (!selected.size || selected.size > 100) throw new Error("请选择 1 至 100 个拆表值。");
  const kept = columns;
  if (!kept.length || kept.some((name) => !header.includes(name)) || new Set(kept).size !== kept.length) throw new Error("保留列无效。");
  const indices = kept.map((name) => header.indexOf(name));
  const output: Record<string, string> = {};
  for (const value of selected) {
    const matches = rows.filter((row) => row[index] === value);
    if (matches.length) output[value] = writeCsv(kept, matches.map((row) => indices.map((column) => row[column])));
  }
  if (!Object.keys(output).length) throw new Error("所选词条没有对应数据行。");
  return output;
}

export type CatalogRow = { tableKey: string; dataset: string; datasetKey: string; name: string; kind: "final" | "method"; path: string; markdownPath: string; header: string[]; values: Record<string, string[]>; rowCount: number };
const LIMIT = 500;
function controlledRoot(root: string, resultDir: string): string {
  if (!resultDir || path.isAbsolute(resultDir) || resultDir.replace(/\\/g, "/").split("/").some(item => !item || item === "." || item === "..")) throw new Error("结果根目录无效。");
  const directory = path.resolve(root, resultDir);
  let current = path.resolve(root);
  for (const part of resultDir.replace(/\\/g, "/").split("/")) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("结果目录不能经过链接。");
  }
  return directory;
}
function childDirs(directory: string, limit = LIMIT): string[] {
  if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory() && !item.isSymbolicLink()).map(item => item.name).sort().slice(0, limit);
}
function smallFile(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024;
}
export function resultCatalog(root: string, resultDir: string, manualMappings: Record<string, any> = {}): { datasets: any[]; legacyTables: any[]; unassignedPlans: any[]; multiDatasetPlans: any[]; mappingConflicts: any[]; autoRecoverableCount: number; catalogLimits?: Record<string, number>; omittedCounts?: Record<string, number> } {
  const directory = controlledRoot(root, resultDir);
  const registryFile = path.join(controlledRoot(root, "simple_cluster/results"), "project_table_registry.json");
  let registry: TableRegistry = emptyTableRegistry();
  if (smallFile(registryFile)) { try { registry = JSON.parse(fs.readFileSync(registryFile, "utf8")); } catch {} }
  const knownDatasets = new Map(datasetPartitions(Object.values(registry.plans || {}).flatMap(plan => plan.records.map(row => row.dataset))).map(row => [row.datasetKey, row.dataset]));
  const knownWorkers = new Map(Object.values(registry.plans || {}).flatMap(plan => plan.records.map(row => [workerDirectoryKey(row.workerId), row.workerId] as [string, string])));
  const knownPlans = new Map(Object.keys(registry.plans || {}).map(file => [planDirectoryKey(file), file]));
  // A published registry owns current tables; old directories remain available as history.
  const currentTableKeys = registry.publicationGeneration ? new Set(Object.values(registry.plans || {}).flatMap(plan => plan.records.flatMap(record => {
    const datasetKey = datasetPathKey(record.dataset);
    return [tablePaths(datasetKey, "final", "final").tableKey, tablePaths(datasetKey, methodTableName(record.method), "method").tableKey];
  }))) : undefined;
  const datasets: any[] = [], legacyTables: any[] = [];
  let artifactCount = 0;
  for (const datasetKey of childDirs(directory)) {
    const datasetRoot = path.join(directory, datasetKey);
    const tables: CatalogRow[] = [];
    let dataset = knownDatasets.get(datasetKey) ?? (datasetKey === "_unassigned" ? "" : datasetKey);
    const metaFile = path.join(datasetRoot, ".dataset.json");
    if (smallFile(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      if (datasetPathKey(meta.dataset) !== datasetKey) throw new Error("数据集目录索引冲突：" + datasetKey);
      dataset = String(meta.dataset || "");
    }
    const candidates = [{ name: "final", kind: "final" as const }, ...childDirs(path.join(datasetRoot, "methods"), 200).map(name => ({ name, kind: "method" as const }))];
    for (const candidate of candidates) {
      const paths = tablePaths(datasetKey, candidate.name, candidate.kind);
      if (currentTableKeys && !currentTableKeys.has(paths.tableKey)) continue;
      const file = path.join(directory, paths.relativePath);
      if (!smallFile(file)) continue;
      const parent = path.dirname(file);
      if (fs.lstatSync(parent).isSymbolicLink()) continue;
      const parsed = readCsv(fs.readFileSync(file, "utf8"));
      const datasetIndex = parsed.header.indexOf("dataset");
      if (datasetIndex < 0) continue;
      const names = [...new Set(parsed.rows.map(row => String(row[datasetIndex] || "").trim()))];
      if (names.length > 1 || (names.length && datasetPathKey(names[0]) !== datasetKey)) throw new Error("结果表数据集与目录不一致：" + paths.relativePath);
      if (names.length) dataset = names[0];
      const values: Record<string, string[]> = {};
      for (const [i, field] of parsed.header.entries()) values[field] = [...new Set(parsed.rows.map(row => row[i]))].slice(0, 200);
      tables.push({ tableKey: paths.tableKey, dataset, datasetKey, ...candidate, path: path.posix.join(resultDir, paths.relativePath), markdownPath: path.posix.join(resultDir, paths.markdownPath), header: parsed.header, values, rowCount: parsed.rows.length });
    }
    const plans: any[] = [];
    for (const planKey of childDirs(path.join(datasetRoot, "plans"))) {
      const artifacts: any[] = [];
      for (const kind of ["raw", "detail", "trace"]) {
        if (artifactCount >= 2000) break;
        const base = path.join(datasetRoot, "plans", planKey, kind);
        const collect = (folder: string, workerId = "") => {
          if (!fs.existsSync(folder) || !fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) return;
          for (const entry of fs.readdirSync(folder, { withFileTypes: true }).slice(0, 200)) {
            if (artifactCount >= 2000) break;
            const file = path.join(folder, entry.name);
            if (!entry.isFile() || !/\.[A-Za-z0-9]+$/.test(entry.name) || entry.name.endsWith('.provenance.json') || !smallFile(file)) continue;
            const relative = path.relative(root, file).replace(/\\/g, "/");
            artifacts.push({ artifactKey: relative, kind, workerId: knownWorkers.get(workerId) || workerId, path: relative, format: path.extname(file).slice(1) });
            artifactCount++;
          }
        };
        collect(base);
        for (const worker of childDirs(base, 100)) {
          if (artifactCount >= 2000) break;
          collect(path.join(base, worker), worker.startsWith('preview__') ? '' : worker);
        }
      }
      // Limit the raw file list independently. Current tables and registered
      // Plan identities must remain discoverable after that list is full.
      if (artifacts.length || knownPlans.has(planKey)) {
        let metadataPlanFiles: string[] = [];
        let metadataDatasets: string[] = [];
        if (!knownPlans.has(planKey)) {
          for (const artifact of artifacts.slice(0, 12)) {
            if (artifact.format !== "csv") continue;
            try {
              const parsed = readCsv(fs.readFileSync(path.join(root, artifact.path), "utf8"));
              const planIndex = parsed.header.indexOf("plan_file");
              const datasetIndex = parsed.header.indexOf("dataset");
              if (planIndex >= 0) metadataPlanFiles.push(...parsed.rows.map(row => process.platform === "darwin" ? String(row[planIndex] || "") : String(row[planIndex] || "").trim()).filter(Boolean));
              if (datasetIndex >= 0) metadataDatasets.push(...parsed.rows.map(row => String(row[datasetIndex] || "").trim()).filter(Boolean));
            } catch {}
          }
        }
        const planFiles = [...new Set(metadataPlanFiles.map(normalizePlanDatasetKey))];
        const planFile = knownPlans.get(planKey) || (planFiles.length === 1 ? metadataPlanFiles.find(value => normalizePlanDatasetKey(value) === planFiles[0]) || "" : "");
        const evidence: any = registry.plans?.[planFile]?.wrapperEvidence;
        for (const view of evidence?.views || []) {
          if (artifactCount >= 2000) break;
          if (typeof view !== 'string' || !view.startsWith(resultDir + '/') || view.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) continue;
          let cursor = root, valid = true;
          for (const part of view.split('/')) { cursor = path.join(cursor, part); if (!fs.existsSync(cursor) || fs.lstatSync(cursor).isSymbolicLink()) { valid = false; break; } }
          if (!valid || !smallFile(cursor) || artifacts.some(artifact => artifact.path === view)) continue;
          artifacts.push({ artifactKey: view, kind: evidence.status === 'preview' ? 'preview' : 'wrapper', path: view,
            format: path.extname(view).slice(1), runId: evidence.runId });
          artifactCount++;
        }
        plans.push({ planKey, planFile, label: planFile || planKey, sourceDatasetKey: datasetKey, artifacts, artifactMetadataDatasets: [...new Set(metadataDatasets)] });
      }
    }
    if (tables.length || plans.length) datasets.push({ dataset, datasetKey, root: path.posix.join(resultDir, datasetKey), tables, plans });
    const oldFile = path.join(datasetRoot, datasetKey + ".csv");
    if (smallFile(oldFile)) legacyTables.push({ name: datasetKey, path: path.posix.join(resultDir, datasetKey, datasetKey + ".csv") });
  }
  const plansByDestination = new Map<string, Map<string, any>>();
  for (const group of datasets) for (const plan of group.plans) {
    const planFile = normalizePlanDatasetKey(plan.planFile);
    const registryPlan = Object.entries(registry.plans || {}).find(([file]) => normalizePlanDatasetKey(file) === planFile)?.[1];
    const historicalRecords = (registryPlan?.records || []).filter(row => row.dataset && row.datasetSource !== "manual-plan-mapping");
    const artifactRecords = plan.artifactMetadataDatasets?.map((dataset: string) => ({ dataset })) || [];
    const assignment = resolvePlanDatasetAssignment({ resultRecords: historicalRecords.length ? [] : artifactRecords, historicalRecords, manualMapping: Object.entries(manualMappings || {}).find(([file]) => normalizePlanDatasetKey(file) === planFile)?.[1] });
    const destinationKeys = assignment.kind === "single" ? [datasetPathKey(assignment.datasets[0])] : assignment.kind === "multiple" ? ["_shared"] : ["_unassigned"];
    for (const destinationKey of destinationKeys) {
      let byPlan = plansByDestination.get(destinationKey);
      if (!byPlan) plansByDestination.set(destinationKey, byPlan = new Map());
      const identity = normalizePlanDatasetKey(plan.planFile) || String(plan.planKey);
      const existing = byPlan.get(identity);
      byPlan.set(identity, existing ? { ...existing, artifacts: [...existing.artifacts, ...plan.artifacts], artifactMetadataDatasets: [...new Set([...(existing.artifactMetadataDatasets || []), ...(plan.artifactMetadataDatasets || [])])], assignment } : { ...plan, dataset: assignment.datasets[0] || "", datasets: assignment.datasets, assignment });
    }
  }
  for (const group of datasets) group.plans = [];
  for (const [key, plans] of plansByDestination) {
    let group = datasets.find(item => item.datasetKey === key);
    if (!group) {
      const firstPlan = plans.values().next().value;
      group = { dataset: key === "_shared" ? "跨数据集" : String(firstPlan?.assignment?.datasets?.[0] || ""), datasetKey: key, root: path.posix.join(resultDir, key), tables: [], plans: [] };
      datasets.push(group);
    }
    group.plans = [...plans.values()];
  }
  const allPlans = [...plansByDestination.values()].flatMap(group => [...group.values()]);
  const unassignedPlans = allPlans.filter(plan => plan.assignment?.kind === "unassigned" && Boolean(plan.planFile));
  const multiDatasetPlans = allPlans.filter(plan => plan.assignment?.kind === "multiple");
  const mappingConflicts = allPlans.filter(plan => plan.assignment?.conflict).map(plan => ({ planFile: plan.planFile, ...plan.assignment.conflict }));
  const autoRecoverableCount = new Set([...plansByDestination.values()].flatMap(group => [...group.values()]).filter(plan => plan.sourceDatasetKey === "_unassigned" && plan.assignment?.kind !== "unassigned").map(plan => plan.planFile || plan.planKey)).size;
  datasetPartitions(datasets.filter(item => !["_shared", "_unassigned"].includes(item.datasetKey)).map(item => item.dataset));
  const datasetLimit = 32, tableLimit = 500, planLimit = 500, artifactLimit = 2000;
  let remainingTables = tableLimit, remainingPlans = planLimit, remainingArtifacts = artifactLimit;
  const boundedDatasets = datasets.slice(0, datasetLimit).map(dataset => {
    const tables = (dataset.tables || []).slice(0, remainingTables);
    remainingTables -= tables.length;
    const plans = [];
    for (const plan of (dataset.plans || [])) {
      if (remainingPlans <= 0) break;
      const artifacts = (plan.artifacts || []).slice(0, remainingArtifacts);
      remainingArtifacts -= artifacts.length;
      plans.push({ ...plan, artifacts });
      remainingPlans -= 1;
    }
    return { ...dataset, tables, plans };
  });
  return {
    datasets: boundedDatasets,
    legacyTables: datasets.length ? [] : legacyTables.slice(0, tableLimit),
    unassignedPlans: unassignedPlans.slice(0, planLimit),
    multiDatasetPlans: multiDatasetPlans.slice(0, planLimit),
    mappingConflicts: mappingConflicts.slice(0, planLimit),
    autoRecoverableCount,
    catalogLimits: { datasets: datasetLimit, tables: tableLimit, plans: planLimit, artifacts: artifactLimit },
    omittedCounts: { datasets: Math.max(0, datasets.length - datasetLimit), tables: Math.max(0, Object.values(datasets).reduce((count, item) => count + (item.tables || []).length, 0) - tableLimit), plans: Math.max(0, allPlans.length - planLimit), artifacts: Math.max(0, artifactCount - artifactLimit) },
  };
}
export function tableCatalog(root: string, resultDir: string): CatalogRow[] {
  return resultCatalog(root, resultDir).datasets.flatMap(dataset => dataset.tables);
}
