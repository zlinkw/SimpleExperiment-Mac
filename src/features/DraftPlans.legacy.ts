import * as fs from "fs/promises";
import * as fsNode from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { atomicWriteText } from "../state/StateStore";
import { parsePlanSummary, validateDeepLearningPlanContract } from "./PlanBuilder";

export const DRAFT_PLAN_ROOT = "tmp/plan";
export const DRAFT_CONFIG_ROOT = "tmp/config";
export const DRAFT_RESULT_ROOT = "tmp/result";
export const DRAFT_STATE_DIR = "simple_cluster/drafts";
export const DRAFT_METADATA_PATH = `${DRAFT_STATE_DIR}/drafts.json`;
export const PROMOTION_LEDGER_PATH = `${DRAFT_STATE_DIR}/promotions.jsonl`;
export const DRAFT_CLEANUP_JOURNAL_PATH = "clean_dir/.draft-cleanup-journal.json";

export const DRAFT_STATUSES = Object.freeze([
  "draft", "validated", "debug_running", "debug_completed",
  "ready_for_review", "promoted", "rejected", "stale",
] as const);
export type DraftStatus = typeof DRAFT_STATUSES[number];

const TERMINAL_DRAFT_STATUSES = new Set<DraftStatus>(["promoted", "rejected"]);
const CLEANABLE_DRAFT_STATUSES = new Set<DraftStatus>(["rejected", "stale"]);
const MAX_DRAFT_TEXT_BYTES = 512 * 1024;
const MAX_DRAFT_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_DRAFT_FILES = 500;
const MAX_DRAFT_SCAN_ENTRIES = 10_000;
const MAX_DRAFT_METADATA_BYTES = 4 * 1024 * 1024;
const promotionLedgerQueues = new Map<string, Promise<void>>();
const draftMetadataQueues = new Map<string, Promise<unknown>>();

export interface DraftConfigRef {
  path: string;
  source: string;
}

export interface DraftIssue {
  code: string;
  message: string;
}

export interface DraftValidation {
  ok: boolean;
  status: DraftStatus;
  configRefs: string[];
  issues: DraftIssue[];
}

export interface DraftRecord {
  draftPlanPath: string;
  draftConfigPaths: string[];
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  lastDebugRunId?: string;
  lastDebugStatus?: string;
  promotionTargetPaths: string[];
  reviewedAt?: string;
  reviewedBy?: string;
  promotionDecision?: "promoted" | "rejected" | "replaced";
  status: DraftStatus;
  issues?: DraftIssue[];
  suite?: string;
  jobCount?: number;
  missing?: boolean;
}

export interface PromotionTarget {
  kind: "plan" | "config";
  sourcePath: string;
  targetPath: string;
  exists: boolean;
  sourceHash: string;
  diff: { added: string[]; removed: string[] };
}

export interface PromotionPreview {
  schemaVersion: 1;
  draftPlanPath: string;
  contentHash: string;
  debugRunId: string;
  debugStatus: string;
  metricsSummary: Record<string, unknown>;
  targets: PromotionTarget[];
  conflicts: Array<{ path: string; kind: "plan" | "config" }>;
}

export interface PromotionResult {
  ok: true;
  decision: "promoted" | "replaced";
  planPath: string;
  configPaths: string[];
  renamedTargets: Array<{ from: string; to: string }>;
  ledgerPath: string;
}

export interface CleanupCandidate {
  path: string;
  kind: "file";
  reason: string;
}

function normalizeWorkspacePath(value: unknown): string {
  const raw = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw) return "";
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) return "";
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../")) return "";
  return normalized.replace(/\/+$/, "");
}

export function isDraftPlanPath(value: unknown): boolean {
  const normalized = normalizeWorkspacePath(value);
  return normalized === DRAFT_PLAN_ROOT || normalized.startsWith(`${DRAFT_PLAN_ROOT}/`);
}

function isDraftPlanFilePath(value: unknown): boolean {
  const normalized = normalizeWorkspacePath(value);
  return normalized !== DRAFT_PLAN_ROOT && isDraftPlanPath(normalized) && /\.(?:ya?ml)$/i.test(normalized);
}

export function isDraftConfigPath(value: unknown): boolean {
  const normalized = normalizeWorkspacePath(value);
  return normalized === DRAFT_CONFIG_ROOT || normalized.startsWith(`${DRAFT_CONFIG_ROOT}/`);
}

export function safeDraftWorkspaceChild(root: string, relative: string): string {
  const normalized = normalizeWorkspacePath(relative);
  if (!normalized) throw new Error(`非法草稿路径：${relative}`);
  const full = path.resolve(root, normalized);
  const rootFull = path.resolve(root);
  const rel = path.relative(rootFull, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`草稿路径必须位于工作区内：${relative}`);
  return full;
}

function yamlScalarValue(value: string): string {
  return String(value || "").trim()
    .replace(/(^|[^\\])#.*$/, "$1")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\(["'])/g, "$1")
    .trim();
}

function addConfigCandidate(out: Map<string, string>, source: string, value: string): void {
  const token = yamlScalarValue(value).split(/\s+/)[0] || "";
  if (!token || token.includes("{") || token.includes("$")) return;
  const normalized = normalizeWorkspacePath(token.replace(/^["']|["']$/g, ""));
  if (!/\.(?:ya?ml)$/i.test(normalized)) return;
  if (!out.has(normalized)) out.set(normalized, source);
}

export function extractDraftConfigRefs(planFile: string, text: string): DraftConfigRef[] {
  const candidates = new Map<string, string>();
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const scalar = line.match(/^\s*-?\s*(?:base_config|base-config|config_file|config-file|config_path|config-path|cfg|config)\s*:\s*(.+?)\s*(?:#.*)?$/i);
    if (scalar?.[1] && !/^[{&*]/.test(scalar[1])) addConfigCandidate(candidates, `yaml:${line.trim()}`, scalar[1]);
    for (const match of line.matchAll(/(?:^|[\s;&|(])(?:--)?(?:base[-_]config|config[-_]file|config[-_]path|cfg|config)(?:=|\s*=\s*|\s+)("[^"]+"|'[^']+'|[^\s;&|]+)/gi)) {
      addConfigCandidate(candidates, `command:${line.trim()}`, match[1]);
    }
  }
  return [...candidates].map(([itemPath, source]) => ({ path: itemPath, source }));
}

export function validateDraftReferences(planFile: string, text: string): DraftValidation {
  const refs = extractDraftConfigRefs(planFile, text);
  const issues: DraftIssue[] = [];
  const configRefs: string[] = [];
  for (const ref of refs) {
    if (isDraftConfigPath(ref.path)) configRefs.push(ref.path);
    else issues.push({ code: "CONFIG_OUTSIDE_TMP", message: `配置引用不在 ${DRAFT_CONFIG_ROOT}/：${ref.path}` });
  }
  if (!refs.length) issues.push({ code: "NO_DRAFT_CONFIG", message: `草稿 Plan 必须引用 ${DRAFT_CONFIG_ROOT}/ 下的配置。` });
  const contract = validateDeepLearningPlanContract(text);
  for (const issue of contract.issues || []) issues.push({ code: "PLAN_CONTRACT", message: issue.message || issue.label });
  return { ok: issues.length === 0, status: issues.length ? "draft" : "validated", configRefs: unique(configRefs), issues };
}

export function draftContentHash(files: Array<{ path: string; text: string }>): string {
  const stable = files
    .map((item) => ({ path: normalizeWorkspacePath(item.path), text: String(item.text || "") }))
    .filter((item) => item.path)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((item) => `${item.path}\n${sha256Text(item.text)}`);
  return sha256Text(JSON.stringify(stable));
}

async function safeWorkspaceDirectory(root: string, relative: string): Promise<string | undefined> {
  const rootFull = path.resolve(root);
  const rootStat = await fs.lstat(rootFull);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("项目根目录不是可安全扫描的普通目录。");
  const rootReal = await fs.realpath(rootFull);
  const normalized = normalizeWorkspacePath(relative);
  if (!normalized) throw new Error(`非法项目内目录路径：${relative}`);
  const full = path.resolve(rootFull, normalized);
  const rel = path.relative(rootFull, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`目录路径必须位于工作区内：${relative}`);
  let current = rootFull;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootStat.dev)
      throw new Error(`草稿目录包含链接、非目录或跨设备路径：${current}`);
    const real = await fs.realpath(current);
    if (!isStrictPhysicalChild(rootReal, real)) throw new Error(`草稿目录物理越界：${current}`);
  }
  return current;
}

async function walkYamlFiles(root: string, relativeDirectory: string): Promise<string[]> {
  const base = await safeWorkspaceDirectory(root, relativeDirectory);
  if (!base) return [];
  const out: string[] = [];
  const pending = [base];
  let scanned = 0;
  while (pending.length) {
    const dir = pending.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    scanned += entries.length;
    if (scanned > MAX_DRAFT_SCAN_ENTRIES) throw new Error(`草稿目录超过 ${MAX_DRAFT_SCAN_ENTRIES} 个目录项扫描上限。`);
    for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const relative = path.relative(root, full).split(path.sep).join("/");
        const safe = await safeWorkspaceDirectory(root, relative);
        if (!safe) throw new Error(`草稿目录在扫描期间消失：${relative}`);
        pending.push(safe);
      } else if (entry.isFile() && /\.(?:ya?ml)$/i.test(entry.name)) {
        const info = await fs.lstat(full);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error(`草稿 PLAN 不是独占普通文件：${full}`);
        out.push(full);
        if (out.length > MAX_DRAFT_FILES) throw new Error(`草稿 Plan 超过 ${MAX_DRAFT_FILES} 个扫描上限。`);
      }
    }
  }
  return out.sort((left, right) => left.localeCompare(right));
}

function promotionTargetFor(source: string): string {
  const normalized = normalizeWorkspacePath(source);
  if (isDraftPlanPath(normalized)) return normalized.replace(new RegExp(`^${DRAFT_PLAN_ROOT}/`), "experiments/plans/");
  if (isDraftConfigPath(normalized)) return normalized.replace(new RegExp(`^${DRAFT_CONFIG_ROOT}/`), "configs/");
  return "";
}

function metadataMap(records: unknown): Map<string, any> {
  let rows: unknown[];
  if (Array.isArray(records)) rows = records; // Pre-envelope format from older plugin versions.
  else if (records && typeof records === "object" && !Array.isArray(records) && Array.isArray((records as any).drafts)) rows = (records as any).drafts;
  else throw new Error("草稿元数据格式无效。");
  if (rows.length > MAX_DRAFT_FILES * 2) throw new Error("草稿元数据记录数超过上限。");
  const output = new Map<string, any>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("草稿元数据包含无效记录。");
    const draft = row as Record<string, any>;
    const key = normalizeWorkspacePath(draft.draftPlanPath);
    const folded = process.platform === "win32" ? key.toLowerCase() : key;
    if (!isDraftPlanFilePath(key) || seen.has(folded)) throw new Error(`草稿元数据包含非法或重复 Plan 路径：${String(draft.draftPlanPath || "")}`);
    seen.add(folded);
    output.set(key, draft);
  }
  return output;
}

async function loadMetadata(root: string): Promise<Map<string, any>> {
  try {
    const text = await readSafeWorkspaceText(root, DRAFT_METADATA_PATH, MAX_DRAFT_METADATA_BYTES);
    return text === undefined ? new Map() : metadataMap(JSON.parse(text));
  } catch (error: any) {
    if (error?.code === "ENOENT") return new Map();
    throw new Error(`草稿元数据不可安全读取：${String(error?.message || error)}`);
  }
}

async function saveMetadata(root: string, drafts: DraftRecord[]): Promise<void> {
  if (!Array.isArray(drafts) || drafts.length > MAX_DRAFT_FILES * 2) throw new Error("草稿元数据记录数无效或超过上限。");
  const paths = new Set<string>();
  for (const draft of drafts) {
    const key = normalizeWorkspacePath(draft?.draftPlanPath);
    const folded = process.platform === "win32" ? key.toLowerCase() : key;
    if (!isDraftPlanFilePath(key) || paths.has(folded)) throw new Error(`草稿元数据不能保存非法或重复 Plan 路径：${String(draft?.draftPlanPath || "")}`);
    paths.add(folded);
  }
  const target = await ensureSafeWorkspaceChild(root, DRAFT_METADATA_PATH, { createParents: true });
  await atomicWriteJson(target, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    drafts,
  });
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await atomicWriteText(target, `${JSON.stringify(value, null, 2)}\n`);
}

function baseRecord(row: unknown, now: string): Partial<DraftRecord> {
  const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
  const createdAt = String(item.createdAt || item.created_at || "") && validIso(String(item.createdAt || item.created_at)) ? String(item.createdAt || item.created_at) : now;
  return {
    createdAt,
    lastDebugRunId: optionalString(item.lastDebugRunId || item.last_debug_run_id),
    lastDebugStatus: optionalString(item.lastDebugStatus || item.last_debug_status),
    reviewedAt: optionalString(item.reviewedAt),
    reviewedBy: optionalString(item.reviewedBy),
    promotionDecision: ["promoted", "rejected", "replaced"].includes(String(item.promotionDecision)) ? item.promotionDecision as DraftRecord["promotionDecision"] : undefined,
  };
}

function validIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function optionalString(value: unknown): string | undefined {
  const text = String(value || "").trim();
  return text || undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeWorkspacePath(value)).filter(Boolean))];
}

export function reconcileDraftPlans(root: string, activity: Array<{ draftPlanPath: string; debugRunId?: string; debugStatus?: string }> = []): Promise<{ enabled: boolean; drafts: DraftRecord[] }> {
  return withDraftMetadataMutation(root, () => reconcileDraftPlansCore(root, activity));
}

async function reconcileDraftPlansCore(root: string, activity: Array<{ draftPlanPath: string; debugRunId?: string; debugStatus?: string }>): Promise<{ enabled: boolean; drafts: DraftRecord[] }> {
  const plans = await walkYamlFiles(root, DRAFT_PLAN_ROOT);
  const metadata = await loadMetadata(root);
  const now = new Date().toISOString();
  const drafts: DraftRecord[] = [];
  const seen = new Set<string>();
  for (const full of plans) {
    const relative = path.relative(root, full).replace(/\\/g, "/");
    seen.add(relative.toLowerCase());
    const stat = await fs.stat(full);
    const planText = await readSafeWorkspaceText(root, relative, MAX_DRAFT_TEXT_BYTES);
    if (planText === undefined) throw new Error(`草稿 PLAN 在扫描期间消失：${relative}`);
    const validation = validateDraftReferences(relative, planText);
    const configTexts = new Map<string, string>();
    for (const configRef of validation.configRefs) {
      const configText = await readSafeWorkspaceText(root, configRef, MAX_DRAFT_CONFIG_BYTES);
      if (configText === undefined) {
        validation.issues.push({ code: "CONFIG_MISSING", message: `草稿配置不存在：${configRef}` });
        validation.ok = false;
        validation.status = "draft";
      } else {
        configTexts.set(configRef, configText);
      }
    }
    const contentHash = draftContentHash([{ path: relative, text: planText }, ...[...configTexts].map(([itemPath, text]) => ({ path: itemPath, text }))]);
    const previous = metadata.get(relative) || {};
    const prior = baseRecord(previous, now);
    const active = activity.find((item) => normalizeWorkspacePath(item.draftPlanPath) === relative && !["completed", "failed", "cancelled", "canceled", "stalled", "stale"].includes(String(item.debugStatus || "").toLowerCase()));
    let status: DraftStatus = validation.ok ? "validated" : "draft";
    if (active) status = "debug_running";
    else if (!validation.ok && !TERMINAL_DRAFT_STATUSES.has(previous.status)) status = "draft";
    else if (validation.ok && String(previous.contentHash || "") === contentHash && DRAFT_STATUSES.includes(previous.status)) status = previous.status;
    else if (!validation.ok && DRAFT_STATUSES.includes(previous.status)) status = previous.status;
    else if (validation.ok && String(previous.contentHash || "") !== contentHash && TERMINAL_DRAFT_STATUSES.has(previous.status)) status = "stale";
    const summary = parsePlanSummary(planText);
    const record: DraftRecord = {
      ...prior,
      draftPlanPath: relative,
      draftConfigPaths: validation.configRefs,
      contentHash,
      createdAt: prior.createdAt || stat.birthtime?.toISOString?.() || now,
      updatedAt: stat.mtime?.toISOString?.() || now,
      promotionTargetPaths: unique([relative, ...validation.configRefs].map(promotionTargetFor).filter(Boolean)),
      status,
      issues: validation.issues,
      suite: summary.suite || "",
      jobCount: Math.max(1, summary.seeds.length || 1) * Math.max(1, summary.cases.length),
      missing: false,
    };
    drafts.push(record);
  }
  for (const [relative, previous] of metadata) {
    if (seen.has(relative.toLowerCase())) continue;
    if (TERMINAL_DRAFT_STATUSES.has(previous.status)) continue;
    const prior = baseRecord(previous, now);
    drafts.push({
      ...prior,
      draftPlanPath: relative,
      draftConfigPaths: unique(previous.draftConfigPaths || []),
      contentHash: String(previous.contentHash || ""),
      createdAt: prior.createdAt || now,
      updatedAt: now,
      promotionTargetPaths: unique(previous.promotionTargetPaths || []),
      status: "stale",
      issues: [{ code: "PLAN_MISSING", message: "草稿 PLAN 文件不存在。" }],
      missing: true,
    } as DraftRecord);
  }
  await saveMetadata(root, drafts);
  return { enabled: Boolean(drafts.length), drafts: drafts.sort((left, right) => left.draftPlanPath.localeCompare(right.draftPlanPath)) };
}

async function readFileIfExists(root: string, relative: string): Promise<string | undefined> {
  try {
    const normalized = normalizeWorkspacePath(relative);
    const limit = isDraftConfigPath(normalized) || normalized.startsWith("configs/") ? MAX_DRAFT_CONFIG_BYTES : MAX_DRAFT_TEXT_BYTES;
    return await readSafeWorkspaceText(root, normalized, limit);
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureSafeWorkspaceChild(root: string, relative: string, options: { createParents?: boolean } = {}): Promise<string> {
  const rootFull = path.resolve(root);
  const rootStat = await fs.lstat(rootFull);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("项目根目录不是可安全访问的普通目录。");
  const rootReal = await fs.realpath(rootFull);
  const target = safeDraftWorkspaceChild(rootFull, relative);
  const relativeTarget = path.relative(rootFull, target);
  const parts = relativeTarget.split(path.sep).filter(Boolean);
  if (parts.length < 1) throw new Error(`非法项目内文件路径：${relative}`);
  let current = rootFull;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error: any) {
      if (error?.code !== "ENOENT" || !options.createParents) throw error;
      await fs.mkdir(current);
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`项目内父路径包含符号链接或非目录：${relative}`);
    const real = await fs.realpath(current);
    if (!isStrictPhysicalChild(rootReal, real)) throw new Error(`项目内父路径物理越界：${relative}`);
  }
  const parentReal = await fs.realpath(path.dirname(target));
  if (!isStrictPhysicalChild(rootReal, parentReal)) throw new Error(`项目内父路径物理越界：${relative}`);
  try {
    const targetStat = await fs.lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink > 1)
      throw new Error(`项目内目标不是独占普通文件：${relative}`);
    const targetReal = await fs.realpath(target);
    if (!isStrictPhysicalChild(rootReal, targetReal)) throw new Error(`项目内目标物理越界：${relative}`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

async function readSafeWorkspaceText(root: string, relative: string, maxBytes: number): Promise<string | undefined> {
  const target = await ensureSafeWorkspaceChild(root, relative);
  let handle: fs.FileHandle | undefined;
  try {
    const noFollow = Number((fsNode.constants as any).O_NOFOLLOW || 0);
    handle = await fs.open(target, fsNode.constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    const before = await fs.lstat(target);
    if (!opened.isFile() || opened.nlink > 1 || before.isSymbolicLink() || !before.isFile() || before.nlink > 1
      || (opened.dev && before.dev && opened.dev !== before.dev) || (opened.ino && before.ino && opened.ino !== before.ino))
      throw new Error(`草稿文件身份发生变化：${relative}`);
    if (opened.size > maxBytes) throw new Error(`草稿文件超过 ${maxBytes} 字节读取上限：${relative}`);
    const text = await handle.readFile("utf8");
    const after = await fs.lstat(target);
    const openedAfter = await handle.stat();
    if (after.isSymbolicLink() || !after.isFile() || after.nlink > 1
      || (before.dev && after.dev && before.dev !== after.dev) || (before.ino && after.ino && before.ino !== after.ino)
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || (openedAfter.dev && before.dev && openedAfter.dev !== before.dev) || (openedAfter.ino && before.ino && openedAfter.ino !== before.ino))
      throw new Error(`草稿文件在读取期间发生变化：${relative}`);
    return text;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isStrictPhysicalChild(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function diffLines(left: string, right: string): { added: string[]; removed: string[] } {
  const oldLines = String(left || "").split(/\r?\n/);
  const newLines = String(right || "").split(/\r?\n/);
  const cap = 2000;
  const a = oldLines.slice(0, cap);
  const b = newLines.slice(0, cap);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  while (i < a.length) removed.push(a[i++]);
  while (j < b.length) added.push(b[j++]);
  if (oldLines.length > cap) removed.push(`... (${oldLines.length - cap} more lines)`);
  if (newLines.length > cap) added.push(`... (${newLines.length - cap} more lines)`);
  return { added, removed };
}

export async function buildPromotionPreview(root: string, draftPlanPath: string, context: {
  metricsSummary?: Record<string, unknown>;
  debugRunId?: string;
  debugStatus?: string;
} = {}): Promise<PromotionPreview> {
  const planPath = normalizeWorkspacePath(draftPlanPath);
  if (!isDraftPlanPath(planPath)) throw new Error(`不是合法的草稿 PLAN：${draftPlanPath}`);
  const planText = await readFileIfExists(root, planPath);
  if (planText === undefined) throw new Error(`草稿 PLAN 不存在：${planPath}`);
  const refs = extractDraftConfigRefs(planPath, planText).map((ref) => ref.path);
  const invalidRefs = refs.filter((ref) => !isDraftConfigPath(ref));
  if (invalidRefs.length || !refs.length) throw new Error(`草稿配置引用无效：${invalidRefs.join(", ") || "缺少引用"}`);
  const targets: PromotionTarget[] = [];
  const sourceFiles: Array<{ path: string; text: string }> = [];
  for (const source of unique([planPath, ...refs])) {
    const sourceText = await readFileIfExists(root, source);
    if (sourceText === undefined) throw new Error(`草稿文件不存在：${source}`);
    const targetPath = promotionTargetFor(source);
    const existing = await readFileIfExists(root, targetPath);
    targets.push({
      kind: isDraftPlanPath(source) ? "plan" : "config",
      sourcePath: source,
      targetPath,
      exists: existing !== undefined,
      sourceHash: sha256Text(sourceText),
      diff: diffLines(existing ?? "", sourceText),
    });
    sourceFiles.push({ path: source, text: sourceText });
  }
  return {
    schemaVersion: 1,
    draftPlanPath: planPath,
    contentHash: draftContentHash(sourceFiles),
    debugRunId: String(context.debugRunId || ""),
    debugStatus: String(context.debugStatus || ""),
    metricsSummary: context.metricsSummary || {},
    targets,
    conflicts: targets.filter((target) => target.exists).map((target) => ({ path: target.targetPath, kind: target.kind })),
  };
}

async function nextAvailableWorkspaceFile(root: string, target: string): Promise<string> {
  const parsed = path.posix.parse(normalizeWorkspacePath(target));
  for (let index = 1; index < 10000; index += 1) {
    const candidate = path.posix.join(parsed.dir, `${parsed.name}_draft_${index}${parsed.ext}`);
    if (!await readFileIfExists(root, candidate)) return candidate;
  }
  throw new Error(`无法为 ${target} 找到可用的转正文件名。`);
}

export async function promoteDraft(root: string, preview: PromotionPreview, options: {
  conflictMode: "rename" | "replace" | "cancel";
  reviewedBy?: string;
}): Promise<PromotionResult> {
  if (options.conflictMode === "cancel") throw new Error("用户取消转正。");
  const draftPlanPath = normalizeWorkspacePath(preview?.draftPlanPath);
  if (!isDraftPlanPath(draftPlanPath)) throw new Error(`不是合法的草稿 PLAN：${preview?.draftPlanPath || ""}`);
  const currentPreview = await buildPromotionPreview(root, draftPlanPath, {
    debugRunId: preview.debugRunId,
    debugStatus: preview.debugStatus,
    metricsSummary: preview.metricsSummary,
  });
  if (currentPreview.contentHash !== preview.contentHash) throw new Error("转正预览已过期，请重新生成预览并再次确认。");
  const targetSignature = (targets: PromotionTarget[]) => targets.map((item) => [
    normalizeWorkspacePath(item.sourcePath), normalizeWorkspacePath(item.targetPath), item.kind, item.sourceHash,
  ].join("\n")).sort().join("\n\n");
  if (!Array.isArray(preview.targets) || targetSignature(currentPreview.targets) !== targetSignature(preview.targets))
    throw new Error("转正预览目标与当前草稿不一致，已停止发布。");
  const conflicts = currentPreview.conflicts;
  if (conflicts.length && options.conflictMode !== "replace" && options.conflictMode !== "rename") {
    throw new Error(`正式目标已存在，需要选择 rename、replace 或取消：${conflicts.map((item) => item.path).join(", ")}`);
  }
  const renames: Array<{ from: string; to: string }> = [];
  const copyPlan: Array<{ source: string; target: string; expected: string }> = [];
  for (const target of currentPreview.targets) {
    const sourceText = await readFileIfExists(root, target.sourcePath);
    if (sourceText === undefined || sha256Text(sourceText) !== target.sourceHash) throw new Error(`转正预览后草稿已变化：${target.sourcePath}`);
    let destination = target.targetPath;
    if (target.exists) {
      if (options.conflictMode === "replace") {
        destination = target.targetPath;
      } else {
        destination = await nextAvailableWorkspaceFile(root, target.targetPath);
        renames.push({ from: target.targetPath, to: destination });
      }
    }
    copyPlan.push({ source: target.sourcePath, target: destination, expected: target.sourceHash });
  }
  const destinations = new Set(copyPlan.map((item) => item.target));
  if (destinations.size !== copyPlan.length) throw new Error("转正目标路径重复，已停止。");
  // Publish configs before Plans so a newly visible Plan never references a config
  // that has not yet been installed. The Plan file is the final entry-point write.
  const publishOrder = [...copyPlan].sort((left, right) => Number(isDraftPlanPath(left.source)) - Number(isDraftPlanPath(right.source)));
  for (const item of publishOrder) {
    const sourceText = await readSafeWorkspaceText(root, item.source, MAX_DRAFT_TEXT_BYTES);
    if (sourceText === undefined) throw new Error(`转正源文件不存在：${item.source}`);
    if (sha256Text(sourceText) !== item.expected) throw new Error(`转正源文件在发布前发生变化：${item.source}`);
    const target = await ensureSafeWorkspaceChild(root, item.target, { createParents: true });
    await atomicWriteText(target, sourceText);
  }
  // Rewrite promoted PLAN to reference formal config paths instead of draft tmp/config
  const draftToFormal = new Map(copyPlan.filter((item) => isDraftConfigPath(item.source)).map((item) => [item.source, item.target]));
  if (draftToFormal.size) {
    for (const item of copyPlan) {
      if (!isDraftPlanPath(item.source)) continue;
      const formalPlanFull = safeFormalWorkspaceChild(root, item.target);
      let planText = await readSafeWorkspaceText(root, item.target, MAX_DRAFT_TEXT_BYTES) || "";
      if (!planText) continue;
      let rewritten = planText;
      for (const [draftRef, formalRef] of draftToFormal) {
        // replace all occurrences of draft config path with formal path
        rewritten = rewritten.split(draftRef).join(formalRef);
      }
      if (rewritten !== planText) {
        await atomicWriteText(formalPlanFull, rewritten);
      }
    }
  }
  const ledgerRecord = {
    schemaVersion: 1,
    promotedAt: new Date().toISOString(),
    sourceHash: preview.contentHash,
    sourceFiles: preview.targets.map((target) => ({ path: target.sourcePath, sha256: target.sourceHash })),
    targetPaths: copyPlan.map((item) => item.target),
    renamedExistingTargets: renames,
    debugRunId: preview.debugRunId,
    metricsSummary: preview.metricsSummary,
    userConfirmed: true,
    reviewedBy: options.reviewedBy || "local-user",
    decision: options.conflictMode,
  };
  await appendPromotionLedger(root, ledgerRecord);
  await updateDraftMetadata(root, preview.draftPlanPath, (record) => ({
    ...record,
    status: "promoted",
    reviewedAt: ledgerRecord.promotedAt,
    reviewedBy: ledgerRecord.reviewedBy,
    promotionDecision: options.conflictMode === "replace" ? "replaced" : "promoted",
    promotionTargetPaths: ledgerRecord.targetPaths,
  }));
  return {
    ok: true,
    decision: options.conflictMode === "replace" ? "replaced" : "promoted",
    planPath: copyPlan.find((item) => isDraftPlanPath(item.source))?.target || "",
    configPaths: copyPlan.filter((item) => isDraftConfigPath(item.source)).map((item) => item.target),
    renamedTargets: renames,
    ledgerPath: PROMOTION_LEDGER_PATH,
  };
}

async function appendPromotionLedger(root: string, record: Record<string, unknown>): Promise<void> {
  const target = await ensureSafeWorkspaceChild(root, PROMOTION_LEDGER_PATH, { createParents: true });
  const key = process.platform === "win32" ? target.toLowerCase() : target;
  const previous = promotionLedgerQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const verifiedTarget = await ensureSafeWorkspaceChild(root, PROMOTION_LEDGER_PATH, { createParents: true });
    const before = await fs.lstat(verifiedTarget).catch((error: any) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink > 1)) throw new Error("草稿转正记录不是独占普通文件。");
    const noFollow = Number((fsNode.constants as any).O_NOFOLLOW || 0);
    const handle = await fs.open(verifiedTarget, fsNode.constants.O_WRONLY | fsNode.constants.O_APPEND | fsNode.constants.O_CREAT | noFollow, 0o600);
    try {
      const opened = await handle.stat();
      const currentStat = await fs.lstat(verifiedTarget);
      if (!opened.isFile() || opened.nlink > 1 || currentStat.isSymbolicLink() || !currentStat.isFile() || currentStat.nlink > 1
        || (before?.dev && opened.dev && before.dev !== opened.dev) || (before?.ino && opened.ino && before.ino !== opened.ino)
        || (opened.dev && currentStat.dev && opened.dev !== currentStat.dev) || (opened.ino && currentStat.ino && opened.ino !== currentStat.ino))
        throw new Error("草稿转正记录身份在追加前发生变化。");
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  promotionLedgerQueues.set(key, current);
  try {
    await current;
  } finally {
    if (promotionLedgerQueues.get(key) === current) promotionLedgerQueues.delete(key);
  }
}

function safeFormalWorkspaceChild(root: string, relative: string): string {
  const normalized = normalizeWorkspacePath(relative);
  if (!normalized || normalized.startsWith("tmp/") || normalized.startsWith("simple_cluster/debug_runs/")) {
    throw new Error(`非法正式目标：${relative}`);
  }
  return safeDraftWorkspaceChild(root, normalized);
}

export function updateDraftMetadata(root: string, draftPlanPath: string, updater: (record: DraftRecord) => DraftRecord): Promise<DraftRecord[]> {
  return withDraftMetadataMutation(root, async () => {
  const current = await loadMetadata(root);
  const key = normalizeWorkspacePath(draftPlanPath);
  if (!isDraftPlanFilePath(key)) throw new Error(`草稿元数据更新路径无效：${draftPlanPath}`);
  const existing = current.get(key) || { draftPlanPath: key, createdAt: new Date().toISOString() };
  const next = updater(existing as DraftRecord);
  if (!next || normalizeWorkspacePath(next.draftPlanPath) !== key) throw new Error("草稿元数据更新不得更改 Plan 身份。");
  current.set(key, next);
  await saveMetadata(root, [...current.values()].sort((left, right) => String(left.draftPlanPath).localeCompare(String(right.draftPlanPath))));
  return [...current.values()];
  });
}

function withDraftMetadataMutation<T>(root: string, work: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(root);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = draftMetadataQueues.get(key) as Promise<unknown> | undefined;
  const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(work);
  draftMetadataQueues.set(key, current);
  void current.finally(() => {
    if (draftMetadataQueues.get(key) === current) draftMetadataQueues.delete(key);
  }).catch(() => undefined);
  return current;
}

export async function rejectDraft(root: string, draftPlanPath: string, reviewedBy = "local-user"): Promise<void> {
  const now = new Date().toISOString();
  await updateDraftMetadata(root, draftPlanPath, (record) => ({
    ...record,
    draftPlanPath: normalizeWorkspacePath(draftPlanPath),
    status: "rejected",
    reviewedAt: now,
    reviewedBy,
    promotionDecision: "rejected",
  }));
}

export async function markDraftReviewed(root: string, draftPlanPath: string, reviewedBy = "local-user"): Promise<void> {
  const now = new Date().toISOString();
  await updateDraftMetadata(root, draftPlanPath, (record) => ({
    ...record,
    status: record.status === "debug_completed" || record.status === "ready_for_review" ? "ready_for_review" : record.status,
    reviewedAt: now,
    reviewedBy,
  }));
}

export async function listCleanupCandidates(root: string, drafts: DraftRecord[]): Promise<CleanupCandidate[]> {
  const protectedConfigs = new Set<string>();
  for (const draft of drafts) {
    if (!CLEANABLE_DRAFT_STATUSES.has(draft.status)) {
      for (const config of draft.draftConfigPaths || []) protectedConfigs.add(normalizeWorkspacePath(config));
    }
  }
  const candidates: CleanupCandidate[] = [];
  for (const draft of drafts) {
    if (!CLEANABLE_DRAFT_STATUSES.has(draft.status) || draft.missing) continue;
    if (isDraftPlanPath(draft.draftPlanPath) && await fileExists(safeDraftWorkspaceChild(root, draft.draftPlanPath))) {
      candidates.push({ path: draft.draftPlanPath, kind: "file", reason: `状态 ${draft.status} 且未被活动草稿引用` });
    }
    for (const configPath of draft.draftConfigPaths || []) {
      const normalized = normalizeWorkspacePath(configPath);
      if (!isDraftConfigPath(normalized)) continue;
      if (protectedConfigs.has(normalized)) continue;
      if (await fileExists(safeDraftWorkspaceChild(root, normalized))) {
        candidates.push({ path: normalized, kind: "file", reason: `仅被 ${draft.status} 草稿 ${draft.draftPlanPath} 引用` });
      }
    }
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

export async function cleanupApprovedDrafts(root: string, drafts: DraftRecord[], approvedPaths: string[]): Promise<{ moved: string[] }> {
  const candidates = await listCleanupCandidates(root, drafts);
  const allowed = new Map(candidates.map((candidate) => [normalizeWorkspacePath(candidate.path), candidate]));
  const requested = approvedPaths.map((value) => normalizeWorkspacePath(value)).filter(Boolean);
  if (new Set(requested).size !== requested.length) throw new Error("清理请求包含重复路径。");
  if (!requested.length) throw new Error("清理请求必须包含精确文件路径。");
  const rootFull = path.resolve(root);
  const rootStat = await fs.lstat(rootFull);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("项目根目录不是普通目录，已停止清理。");
  const rootReal = await fs.realpath(rootFull);
  const journalPath = safeDraftWorkspaceChild(rootFull, DRAFT_CLEANUP_JOURNAL_PATH);
  if (await exists(journalPath)) {
    const journalStat = await fs.lstat(journalPath);
    if (journalStat.isSymbolicLink() || !journalStat.isFile() || journalStat.nlink > 1 || journalStat.size > 1024 * 1024)
      throw new Error("草稿清理恢复记录不是可安全读取的普通文件。");
    let previous: any;
    try { previous = JSON.parse(await fs.readFile(journalPath, "utf8")); }
    catch { throw new Error("草稿清理恢复记录损坏；已停止后续移动，请检查 clean_dir 中的文件。"); }
    if (previous.status === "pending" || previous.status === "recovery_required")
      throw new Error(`上一批草稿移动需要人工核对，状态 ${previous.status}；本次未改文件。记录：${DRAFT_CLEANUP_JOURNAL_PATH}`);
  }
  const batch: Array<{ relative: string; source: string; destination: string; sha256: string; bytes: number; dev: number; ino: number }> = [];
  for (const requestedPath of requested) {
    const candidate = allowed.get(requestedPath);
    if (!candidate || candidate.kind !== "file") throw new Error(`清理候选不匹配或已变化：${requestedPath}`);
    const target = safeDraftWorkspaceChild(root, requestedPath);
    const relative = path.relative(rootFull, target).split(path.sep).join("/");
    const destination = path.join(rootFull, "clean_dir", ...relative.split("/"));
    const destinationRelative = path.relative(rootFull, destination);
    if (!destinationRelative || destinationRelative.startsWith("..") || path.isAbsolute(destinationRelative))
      throw new Error(`清理目标越过项目根：${requestedPath}`);
    await ensureCleanDestinationParent(rootFull, path.dirname(destination));
    if (await exists(destination)) throw new Error(`clean_dir 中已存在对应目标，未覆盖：${destinationRelative.split(path.sep).join("/")}`);
    const identity = await inspectDraftCleanupSource(rootFull, rootReal, relative);
    batch.push({ relative, source: target, destination, sha256: identity.sha256,
      bytes: identity.bytes, dev: identity.dev, ino: identity.ino });
  }
  const manifestPath = path.join(rootFull, "clean_dir", "MANIFEST.md");
  let existingManifest = "# Clean directory manifest\n";
  if (await exists(manifestPath)) {
    const manifestStat = await fs.lstat(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.nlink > 1 || manifestStat.size > 4 * 1024 * 1024)
      throw new Error("clean_dir/MANIFEST.md 不是可安全复用的普通文件。");
    existingManifest = await fs.readFile(manifestPath, "utf8");
  }
  const createdAt = new Date().toISOString();
  const entries = batch.map((item) => `- ${createdAt} | file | ${item.relative} -> ${path.relative(rootFull, item.destination).split(path.sep).join("/")} | ${item.bytes} bytes | sha256 ${item.sha256}`);
  const manifestLines = existingManifest.split(/\r?\n/).filter(Boolean);
  const boundedLines = [...manifestLines, ...entries].slice(-5000);
  const manifestText = `${boundedLines.join("\n")}\n`;
  const moved: typeof batch = [];
  const journalBase = { schemaVersion: 1, createdAt, entries: batch.map((item) => ({
    source: item.relative,
    destination: path.relative(rootFull, item.destination).split(path.sep).join("/"),
    sha256: item.sha256,
    bytes: item.bytes,
  })) };
  await atomicWriteText(journalPath, JSON.stringify({ ...journalBase, status: "pending" }, null, 2));
  let manifestCommitted = false;
  try {
    for (const item of batch) {
      const current = await inspectDraftCleanupSource(rootFull, rootReal, item.relative);
      if (current.dev !== item.dev || current.ino !== item.ino || current.bytes !== item.bytes || current.sha256 !== item.sha256)
        throw new Error(`清理候选在移动前发生变化：${item.relative}`);
      if (await exists(item.destination)) throw new Error(`clean_dir 中目标已出现，未覆盖：${path.relative(rootFull, item.destination).split(path.sep).join("/")}`);
      await fs.rename(item.source, item.destination);
      moved.push(item);
    }
    await atomicWriteText(manifestPath, manifestText);
    manifestCommitted = true;
    await atomicWriteText(journalPath, JSON.stringify({ ...journalBase, status: "committed", completedAt: new Date().toISOString() }, null, 2));
  } catch (error) {
    if (manifestCommitted) {
      throw new Error(`文件已安全移入 clean_dir 且清单已写入，但恢复记录未收口：${errorMessage(error)}。不要重复提交；核对 ${DRAFT_CLEANUP_JOURNAL_PATH}。`);
    }
    const rollbackErrors: string[] = [];
    for (const item of [...moved].reverse()) {
      try {
        if (await exists(item.source)) throw new Error("原路径已被其他内容占用");
        const parentStat = await fs.lstat(path.dirname(item.source));
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error("原路径父目录不安全");
        const parentReal = await fs.realpath(path.dirname(item.source));
        const parentRelative = path.relative(rootReal, parentReal);
        if (parentRelative && (parentRelative.startsWith("..") || path.isAbsolute(parentRelative))) throw new Error("原路径父目录越过项目根");
        const destinationStat = await fs.lstat(item.destination);
        if (destinationStat.isSymbolicLink() || !destinationStat.isFile() || destinationStat.nlink > 1
            || destinationStat.size !== item.bytes || await hashFile(item.destination) !== item.sha256)
          throw new Error("clean_dir 文件身份或指纹变化");
        await fs.rename(item.destination, item.source);
      } catch (rollbackError) {
        rollbackErrors.push(`${item.relative}: ${errorMessage(rollbackError)}`);
      }
    }
    await atomicWriteText(journalPath, JSON.stringify({ ...journalBase,
      status: rollbackErrors.length ? "recovery_required" : "rolled_back",
      completedAt: new Date().toISOString(), rollbackErrors,
    }, null, 2)).catch((journalError) => rollbackErrors.push(`恢复记录写入失败：${errorMessage(journalError)}`));
    throw new Error(`清理到 clean_dir 失败，已尝试恢复文件：${errorMessage(error)}${rollbackErrors.length ? `；未恢复项：${rollbackErrors.join("；")}` : ""}`);
  }
  return { moved: moved.map((item) => path.relative(rootFull, item.destination).split(path.sep).join("/")) };
}

async function inspectDraftCleanupSource(root: string, rootReal: string, relative: string): Promise<{ sha256: string; bytes: number; dev: number; ino: number }> {
  const target = safeDraftWorkspaceChild(root, relative);
  const parts = path.relative(root, target).split(path.sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) || (index === parts.length - 1 && !stat.isFile()))
      throw new Error(`清理候选包含符号链接或非普通文件：${relative}`);
  }
  const sourceStat = await fs.lstat(target);
  if (sourceStat.nlink > 1) throw new Error(`清理候选是硬链接文件，已停止：${relative}`);
  const parentReal = await fs.realpath(path.dirname(target));
  const parentRelative = path.relative(rootReal, parentReal);
  if (parentRelative && (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)))
    throw new Error(`清理候选父目录越过项目根：${relative}`);
  return { sha256: await hashFile(target), bytes: sourceStat.size, dev: sourceStat.dev, ino: sourceStat.ino };
}

async function ensureCleanDestinationParent(root: string, parent: string): Promise<void> {
  const relative = path.relative(root, parent);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("clean_dir 目标父目录越过项目根。");
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`clean_dir 路径不是普通目录：${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      await fs.mkdir(current);
    }
  }
  const rootReal = await fs.realpath(root);
  const parentReal = await fs.realpath(parent);
  const parentRelative = path.relative(rootReal, parentReal);
  if (!parentRelative || parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) throw new Error("clean_dir 物理目标父目录越过项目根。");
}

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false; throw error; }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
