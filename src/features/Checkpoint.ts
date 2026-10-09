export const CHECKPOINT_DELETE_PLAN_PATH = "simple_cluster/checkpoints/delete_plan.json";
export const CHECKPOINT_RETENTION_REPORT_PATH = "simple_cluster/checkpoints/retention_report.md";
const CHECKPOINT_FORBIDDEN_PATH_SEGMENTS = new Set([".git", ".ssh", "node_modules", ".venv", "venv"]);
const CHECKPOINT_ALLOWED_ROOTS = new Set(["work_dirs", "experiments", "simple_cluster", "outputs", "runs", "checkpoints", "weights", "results"]);
const CHECKPOINT_TRUE_TOKENS = new Set(["1", "true", "yes", "on", "paper_ready"]);

export interface CheckpointRecord {
  path: string;
  runId?: string;
  resultId?: string;
  type?: "best" | "latest" | "top" | "regular" | string;
  score?: number;
  epoch?: number;
  createdAt?: string;
  updatedAt?: string;
  paperReady?: boolean;
  frozen?: boolean;
  status?: string;
  size?: number;
}

export interface CheckpointRetentionPolicy {
  keepBest?: boolean;
  keepLatest?: boolean;
  topK?: number;
  minAgeDays?: number;
  protectPaperReady?: boolean;
  protectRunning?: boolean;
  protectFrozen?: boolean;
}

export interface CheckpointDeletePlanItem extends CheckpointRecord {
  normalizedPath: string;
  action: "keep" | "delete" | "skip";
  reasons: string[];
  safe: boolean;
}

export interface CheckpointDeletePlan {
  schemaVersion: 1;
  generatedAt: string;
  dryRun: true;
  policy: Required<CheckpointRetentionPolicy>;
  deletePlanPath: string;
  retentionReportPath: string;
  total: number;
  keepCount: number;
  deleteCount: number;
  skipCount: number;
  items: CheckpointDeletePlanItem[];
  warnings: string[];
}

export function defaultCheckpointRetentionPolicy(input: CheckpointRetentionPolicy = {}): Required<CheckpointRetentionPolicy> {
  return {
    keepBest: input.keepBest ?? true,
    keepLatest: input.keepLatest ?? true,
    topK: Math.max(0, Math.floor(input.topK ?? 1)),
    minAgeDays: Math.max(0, Number(input.minAgeDays ?? 0)),
    protectPaperReady: input.protectPaperReady ?? true,
    protectRunning: input.protectRunning ?? true,
    protectFrozen: input.protectFrozen ?? true,
  };
}

export function checkpointRecordsFromManifest(value: unknown): CheckpointRecord[] {
  const records: CheckpointRecord[] = [];
  const visit = (node: unknown, inherited: Partial<CheckpointRecord> = {}) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, inherited));
      return;
    }
    if (typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const path = firstText(record, ["path", "file", "checkpoint", "checkpointPath", "checkpoint_path", "relativePath", "relative_path"]);
    const nextInherited = {
      ...inherited,
      runId: firstText(record, ["runId", "run_id", "runKey", "run_key"]) || inherited.runId,
      resultId: firstText(record, ["resultId", "result_id", "experimentId", "experiment_id"]) || inherited.resultId,
      status: firstText(record, ["status", "state"]) || inherited.status,
    };
    if (path) {
      records.push({
        ...nextInherited,
        path,
        type: firstText(record, ["type", "kind", "checkpointType", "checkpoint_type"]) || inherited.type,
        score: finiteNumber(record.score ?? record.metric ?? record.value ?? record.bestScore ?? record.best_score),
        epoch: finiteNumber(record.epoch ?? record.step),
        createdAt: firstText(record, ["createdAt", "created_at", "mtime", "updatedAt", "updated_at"]),
        updatedAt: firstText(record, ["updatedAt", "updated_at", "mtime"]),
        paperReady: boolValue(record.paperReady ?? record.paper_ready),
        frozen: boolValue(record.frozen),
        size: finiteNumber(record.size),
      });
    }
    for (const key of ["checkpoints", "files", "artifacts", "targets", "runs", "items"]) visit(record[key], nextInherited);
  };
  visit(value);
  return dedupeCheckpoints(records);
}

export function buildCheckpointRetentionPlan(input: {
  checkpoints: CheckpointRecord[];
  policy?: CheckpointRetentionPolicy;
  runningRunIds?: string[];
  paperReadyResultIds?: string[];
  frozenResultIds?: string[];
  now?: Date;
}): CheckpointDeletePlan {
  const policy = defaultCheckpointRetentionPolicy(input.policy);
  const now = input.now || new Date();
  const running = new Set((input.runningRunIds || []).map(String));
  const paperReady = new Set((input.paperReadyResultIds || []).map(String));
  const frozen = new Set((input.frozenResultIds || []).map(String));
  const rows = dedupeCheckpoints(input.checkpoints);
  const latestPath = policy.keepLatest ? latestCheckpoint(rows)?.path : "";
  const topPaths = new Set(policy.topK ? [...rows].filter((row) => row.score !== undefined).sort((a, b) => Number(b.score) - Number(a.score)).slice(0, policy.topK).map((row) => row.path) : []);
  const items = rows.map((row) => {
    const normalizedPath = normalizeCheckpointPath(row.path);
    const safe = Boolean(normalizedPath);
    const reasons: string[] = [];
    const type = String(row.type || "").toLowerCase();
    if (!safe) reasons.push("路径不在项目安全范围内");
    if (policy.keepBest && (row.path === latestBest(rows)?.path || row.paperReady || type === "best")) reasons.push("保留 best");
    if (policy.keepLatest && row.path === latestPath) reasons.push("保留 latest");
    if (topPaths.has(row.path)) reasons.push(`保留 top${policy.topK}`);
    if (policy.minAgeDays && checkpointAgeDays(row, now) < policy.minAgeDays) reasons.push(`未超过 ${policy.minAgeDays} 天`);
    if (policy.protectPaperReady && (row.paperReady || (row.resultId && paperReady.has(row.resultId)))) reasons.push("paper ready 保护");
    if (policy.protectRunning && ((row.runId && running.has(row.runId)) || /running|queued|testing/i.test(String(row.status || "")))) reasons.push("运行中保护");
    if (policy.protectFrozen && (row.frozen || (row.resultId && frozen.has(row.resultId)))) reasons.push("paper freeze 保护");
    const action = !safe ? "skip" : reasons.length ? "keep" : "delete";
    return { ...row, normalizedPath, safe, action, reasons: reasons.length ? reasons : ["可 dry-run 删除"] } as CheckpointDeletePlanItem;
  });
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    dryRun: true,
    policy,
    deletePlanPath: CHECKPOINT_DELETE_PLAN_PATH,
    retentionReportPath: CHECKPOINT_RETENTION_REPORT_PATH,
    total: items.length,
    keepCount: items.filter((item) => item.action === "keep").length,
    deleteCount: items.filter((item) => item.action === "delete").length,
    skipCount: items.filter((item) => item.action === "skip").length,
    items,
    warnings: items.filter((item) => !item.safe).map((item) => `${item.path}: 路径不安全，已跳过`),
  };
}

export function checkpointRetentionReportMarkdown(plan: CheckpointDeletePlan): string {
  const lines = [
    "# Checkpoint 保留报告",
    "",
    `生成时间：${plan.generatedAt}`,
    "模式：dry-run，不会删除文件。",
    "",
    `总数：${plan.total}，保留：${plan.keepCount}，计划删除：${plan.deleteCount}，跳过：${plan.skipCount}`,
    "",
    "## 删除候选",
    ...plan.items.filter((item) => item.action === "delete").map((item) => `- ${item.normalizedPath}：${item.reasons.join("；")}`),
    "",
    "## 保留或跳过",
    ...plan.items.filter((item) => item.action !== "delete").map((item) => `- [${item.action}] ${item.normalizedPath || item.path}：${item.reasons.join("；")}`),
  ];
  return lines.join("\n");
}

function latestCheckpoint(rows: CheckpointRecord[]): CheckpointRecord | undefined {
  return [...rows].sort((a, b) => checkpointSortValue(b) - checkpointSortValue(a))[0];
}

function latestBest(rows: CheckpointRecord[]): CheckpointRecord | undefined {
  return [...rows].filter((row) => String(row.type || "").toLowerCase() === "best" || row.paperReady).sort((a, b) => checkpointSortValue(b) - checkpointSortValue(a))[0];
}

function checkpointSortValue(row: CheckpointRecord): number {
  if (row.epoch !== undefined) return row.epoch;
  const stamp = Date.parse(row.updatedAt || row.createdAt || "");
  return Number.isFinite(stamp) ? stamp : 0;
}

function checkpointAgeDays(row: CheckpointRecord, now: Date): number {
  const stamp = Date.parse(row.updatedAt || row.createdAt || "");
  if (!Number.isFinite(stamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - stamp) / 86400000);
}

function normalizeCheckpointPath(value: string): string {
  const rel = String(value || "").replace(/\\/g, "/").replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "");
  const parts = rel.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.includes("..")) return "";
  const lowered = parts.map((part) => part.toLowerCase());
  if (lowered.some((part) => CHECKPOINT_FORBIDDEN_PATH_SEGMENTS.has(part))) return "";
  if (!CHECKPOINT_ALLOWED_ROOTS.has(lowered[0])) return "";
  if (!/\.(pt|pth|ckpt|bin|safetensors|onnx|pkl|pickle)$/i.test(parts[parts.length - 1])) return "";
  return parts.join("/");
}

function dedupeCheckpoints(rows: CheckpointRecord[]): CheckpointRecord[] {
  const map = new Map<string, CheckpointRecord>();
  rows.filter((row) => row.path).forEach((row) => map.set(row.path.replace(/\\/g, "/"), row));
  return Array.from(map.values());
}

function firstText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  return CHECKPOINT_TRUE_TOKENS.has(String(value).toLowerCase());
}
