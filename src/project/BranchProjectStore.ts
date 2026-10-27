/**
 * src/project/BranchProjectStore.ts - the minimal ancestor/branch project model and its local file
 * persistence for the multi-project branch panel. Pure Node (no vscode import) so tests, the CLI
 * and later block B/C code share one source of truth.
 *
 * Storage is one JSON file under the plugin's existing local API directory
 * (%APPDATA%/SimpleExperiment/branch-projects.json). Registration is the ONLY way a directory ever
 * enters this model; nothing here scans or mutates user projects. Removal calls forget a
 * registration — never a file, worktree, branch or commit.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { atomicWriteText } from "../state/StateStore";

export const BRANCH_PROJECT_SCHEMA_VERSION = 1;
export const BRANCH_PROJECT_FILE_NAME = "branch-projects.json";

export interface AncestorProjectRecord {
  id: string;
  label: string;
  /** Absolute path the user picked; identity is re-derived from git on every verification. */
  gitRoot: string;
  /** Branch the ancestor integrates into; captured at registration, shown for preview/PR later. */
  targetBranch: string;
  remoteName: string;
  remoteUrl: string;
  registeredAt: string;
  updatedAt: string;
}

export type BranchProjectSource = "registered-existing" | "created-worktree";

export interface BranchProjectRecord {
  id: string;
  ancestorId: string;
  label: string;
  /** Independent working copy: a worktree of the ancestor repo or a separate clone. */
  workspaceRoot: string;
  branch: string;
  /** Commit the registration/creation was made against; drift is reported, never auto-fixed. */
  createdFromCommit: string;
  source: BranchProjectSource;
  registeredAt: string;
  updatedAt: string;
}

export interface BranchProjectFile {
  schemaVersion: number;
  ancestors: AncestorProjectRecord[];
  branches: BranchProjectRecord[];
}

export function emptyBranchProjectFile(): BranchProjectFile {
  return { schemaVersion: BRANCH_PROJECT_SCHEMA_VERSION, ancestors: [], branches: [] };
}

/** Case-insensitive only on win32; separators normalized; no realpath (identity stays what the user sees). */
export function canonicalComparablePath(value: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = String(value || "").trim().replace(/[\\/]+$/, "");
  const unified = trimmed.replace(/\\/g, "/");
  return platform === "win32" ? unified.toLowerCase() : unified;
}

export function sameComparablePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const left = canonicalComparablePath(a, platform);
  const right = canonicalComparablePath(b, platform);
  return left.length > 0 && left === right;
}

function assertSafeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{16,64}$/.test(value)) throw new Error(`${field} 标识不合法。`);
  return value;
}

function assertSafeText(value: unknown, field: string, max = 300): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} 不能为空。`);
  if (text.length > max) throw new Error(`${field} 超长。`);
  return text;
}

function assertAbsolute(value: unknown, field: string): string {
  const text = assertSafeText(value, field, 1000);
  if (!path.isAbsolute(text)) throw new Error(`${field} 必须是绝对路径。`);
  return path.normalize(text);
}

function assertTimestamp(value: unknown, field: string): string {
  const text = assertSafeText(value, field, 64);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${field} 不是有效时间。`);
  return text;
}

export function validateAncestorRecord(value: unknown): AncestorProjectRecord {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const remoteName = String(row.remoteName ?? "").trim();
  return {
    id: assertSafeId(row.id, "祖先项目"),
    label: assertSafeText(row.label, "祖先项目名称"),
    gitRoot: assertAbsolute(row.gitRoot, "祖先项目目录"),
    targetBranch: assertSafeText(row.targetBranch, "祖先目标分支"),
    remoteName: remoteName.length > 0 && remoteName.length <= 200 ? remoteName : "",
    remoteUrl: String(row.remoteUrl ?? "").trim().slice(0, 600),
    registeredAt: assertTimestamp(row.registeredAt, "祖先登记时间"),
    updatedAt: assertTimestamp(row.updatedAt, "祖先更新时间"),
  };
}

export function validateBranchRecord(value: unknown): BranchProjectRecord {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const source = String(row.source ?? "");
  if (source !== "registered-existing" && source !== "created-worktree") throw new Error("分支来源不合法。");
  return {
    id: assertSafeId(row.id, "分支项目"),
    ancestorId: assertSafeId(row.ancestorId, "祖先关联"),
    label: assertSafeText(row.label, "分支项目名称"),
    workspaceRoot: assertAbsolute(row.workspaceRoot, "分支项目目录"),
    branch: assertSafeText(row.branch, "分支名"),
    createdFromCommit: String(row.createdFromCommit ?? "").trim().slice(0, 64),
    source,
    registeredAt: assertTimestamp(row.registeredAt, "分支登记时间"),
    updatedAt: assertTimestamp(row.updatedAt, "分支更新时间"),
  };
}

export function parseBranchProjectFile(text: string): BranchProjectFile {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("branch-projects.json 内容损坏；为避免覆盖登记数据，已停止读写。"); }
  const file = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const schemaVersion = Number(file.schemaVersion);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("branch-projects.json 缺少有效 schemaVersion。");
  // Future versions are refused, never silently rewritten by this build.
  if (schemaVersion > BRANCH_PROJECT_SCHEMA_VERSION) throw new Error(`branch-projects.json schemaVersion=${schemaVersion} 比当前插件更新；请先升级插件。`);
  if (!Array.isArray(file.ancestors) || !Array.isArray(file.branches)) throw new Error("branch-projects.json 缺少 ancestors/branches 数组。");
  const ancestors = file.ancestors.map(validateAncestorRecord);
  const branches = file.branches.map(validateBranchRecord);
  const ancestorIds = new Set(ancestors.map((row) => row.id));
  for (const branch of branches)
    if (!ancestorIds.has(branch.ancestorId)) throw new Error(`分支 ${branch.label} 的祖先关联缺失；请先重新登记祖先。`);
  const byRoot = new Map<string, string>();
  for (const row of [...ancestors.map((r) => ({ id: r.id, label: r.label, root: r.gitRoot })), ...branches.map((r) => ({ id: r.id, label: r.label, root: r.workspaceRoot }))]) {
    const key = canonicalComparablePath(row.root);
    if (byRoot.has(key)) throw new Error(`目录 ${row.root} 已登记为 ${byRoot.get(key)}；同一目录不能重复登记。`);
    byRoot.set(key, row.label);
  }
  return { schemaVersion: BRANCH_PROJECT_SCHEMA_VERSION, ancestors, branches };
}

export function serializeBranchProjectFile(file: BranchProjectFile): string {
  return `${JSON.stringify({ schemaVersion: BRANCH_PROJECT_SCHEMA_VERSION, ancestors: file.ancestors, branches: file.branches }, null, 2)}\n`;
}

export function newRecordId(seed: string): string {
  return crypto.createHash("sha256").update(`${seed}|${Date.now()}|${crypto.randomBytes(16).toString("hex")}`).digest("hex").slice(0, 32);
}

/** Stable digest binding a create-branch preview; confirm must echo the same digest. */
export function createBranchPreviewDigest(request: { ancestorId: string; ancestorRoot: string; baseRef: string; baseCommit: string; branch: string; targetPath: string }): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    ancestorId: request.ancestorId,
    ancestorRoot: canonicalComparablePath(request.ancestorRoot),
    baseRef: request.baseRef,
    baseCommit: request.baseCommit,
    branch: request.branch,
    targetPath: canonicalComparablePath(request.targetPath),
  })).digest("hex").slice(0, 32);
}

export class BranchProjectStore {
  private readonly file: string;
  private cached: BranchProjectFile | undefined;
  private cachedMtimeMs = -1;

  constructor(filePath: string) {
    if (!filePath || !path.isAbsolute(filePath)) throw new Error("登记文件路径必须是绝对路径。");
    this.file = filePath;
  }

  get filePath(): string { return this.file; }

  /** Read-through with an mtime guard so repeated panel refreshes do not re-parse unchanged files. */
  load(): BranchProjectFile {
    let stat: fs.Stats | undefined;
    try { stat = fs.statSync(this.file); }
    catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "ENOENT") { this.cached = emptyBranchProjectFile(); this.cachedMtimeMs = -1; return this.cached; }
      throw error;
    }
    if (this.cached && stat.mtimeMs === this.cachedMtimeMs) return this.cached;
    const text = fs.readFileSync(this.file, "utf8");
    this.cached = parseBranchProjectFile(text);
    this.cachedMtimeMs = stat.mtimeMs;
    return this.cached;
  }

  /** Atomic whole-file write after full validation; readers of other schema versions refuse to load. */
  async save(file: BranchProjectFile): Promise<BranchProjectFile> {
    const validated = parseBranchProjectFile(serializeBranchProjectFile(file));
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await atomicWriteText(this.file, serializeBranchProjectFile(validated));
    this.cached = validated;
    try { this.cachedMtimeMs = fs.statSync(this.file).mtimeMs; } catch { this.cachedMtimeMs = -1; }
    return validated;
  }

  /**
   * Read-modify-write under the caller's mutator. Registration/forgetting is user-driven and rare;
   * cross-window concurrent edits are detected via the pre-mutation digest and surface as a refuse
   * (recheck) instead of a silent last-writer-wins.
   */
  async mutate(mutator: (file: BranchProjectFile) => BranchProjectFile, expectedDigest?: string): Promise<BranchProjectFile> {
    const before = this.load();
    if (expectedDigest !== undefined && expectedDigest !== branchProjectFileDigest(before))
      throw new Error("项目登记在他处刚被修改；请刷新后重新确认。");
    return await this.save(mutator(before));
  }
}

export function branchProjectFileDigest(file: BranchProjectFile): string {
  return crypto.createHash("sha256").update(serializeBranchProjectFile(file)).digest("hex").slice(0, 32);
}
