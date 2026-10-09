import { PlanSyncLedger, latestPlanSyncEntry } from "./PlanArtifactSync";
import { ScopeStatus } from "./SyncScopeTree";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SyncHolds, chosenSyncHash, isSyncHeld, safeSyncPath } from "./SyncResolution";
import { HostOperationLeaseManager } from "../core/HostOperationLease";
import { atomicWriteText } from "../state/StateStore";

type File = { sha256: string; size: number; modifiedAtMs?: number };
type ScopeHashIdentity = { dev: string; ino: string; size: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number };
type ScopeHashRow = ScopeHashIdentity & { sha256: string; modifiedAtMs?: number };
type ScopeHashDocument = { schemaVersion: 1; files: Record<string, ScopeHashRow> };

const SCOPE_HASH_SCHEMA_VERSION = 1;
const LOCAL_SCOPE_MAX_DIRECTORIES = 10_000;
const LOCAL_SCOPE_MAX_ENTRIES = 100_000;
const LOCAL_SCOPE_MAX_FILES = 50_000;
const SCOPE_HASH_CACHE_MAX_FILES = 50_000;
const SCOPE_HASH_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const LOCAL_SCOPE_MAX_RELATIVE_PATH_LENGTH = 4096;
/** Process-local mirror. Persistence lives beside the code-manifest cache and is the restart source. */
const localHashCache = new Map<string, { identity: string; file: File }>();
const LOCAL_HASH_CACHE_LIMIT = 8192;
function rememberLocalScopeHash(full: string, identity: string, file: File): void {
  localHashCache.delete(full);
  localHashCache.set(full, { identity, file });
  while (localHashCache.size > LOCAL_HASH_CACHE_LIMIT) localHashCache.delete(localHashCache.keys().next().value!);
}

export function localScopeHashCachePath(storageRoot: string, projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const id = crypto.createHash("sha256").update(process.platform === "win32" ? resolved.toLowerCase() : resolved).digest("hex");
  return path.join(storageRoot, "scope-hash-cache", `${id}.json`);
}

function bigintString(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return Number.isSafeInteger(value) ? String(value) : value.toFixed(0);
  return "";
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function scopeHashIdentity(stat: { dev: unknown; ino: unknown; size: number; mtimeMs: unknown; ctimeMs: unknown; birthtimeMs: unknown }): ScopeHashIdentity | undefined {
  const dev = bigintString(stat.dev);
  const ino = bigintString(stat.ino);
  const mtimeMs = finiteTime(stat.mtimeMs);
  const ctimeMs = finiteTime(stat.ctimeMs);
  const birthtimeMs = finiteTime(stat.birthtimeMs);
  if (!dev || !ino || mtimeMs === undefined || ctimeMs === undefined || birthtimeMs === undefined || !Number.isSafeInteger(stat.size)) return undefined;
  return { dev, ino, size: stat.size, mtimeMs, ctimeMs, birthtimeMs };
}

function scopeHashIdentityKey(identity: ScopeHashIdentity): string {
  return `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}:${identity.birthtimeMs}`;
}

function sameScopeHashIdentity(row: ScopeHashRow | undefined, identity: ScopeHashIdentity | undefined): row is ScopeHashRow {
  return Boolean(row && identity
    && row.dev === identity.dev
    && row.ino === identity.ino
    && row.size === identity.size
    && row.mtimeMs === identity.mtimeMs
    && row.ctimeMs === identity.ctimeMs
    && row.birthtimeMs === identity.birthtimeMs
    && /^[a-f0-9]{64}$/i.test(String(row.sha256 || "")));
}

async function readScopeHashCache(file: string): Promise<ScopeHashDocument> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SCOPE_HASH_CACHE_MAX_BYTES) return { schemaVersion: SCOPE_HASH_SCHEMA_VERSION, files: {} };
    const flags = fsConstants.O_RDONLY | (process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
    handle = await fs.open(file, flags);
    const opened = await handle.stat();
    if (!opened.isFile() || bigintString(opened.dev) !== bigintString(stat.dev) || bigintString(opened.ino) !== bigintString(stat.ino)
      || opened.size > SCOPE_HASH_CACHE_MAX_BYTES) return { schemaVersion: SCOPE_HASH_SCHEMA_VERSION, files: {} };
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, SCOPE_HASH_CACHE_MAX_BYTES + 1 - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      totalBytes += bytesRead;
      if (totalBytes > SCOPE_HASH_CACHE_MAX_BYTES) return { schemaVersion: SCOPE_HASH_SCHEMA_VERSION, files: {} };
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const parsed = JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
    if (parsed?.schemaVersion === SCOPE_HASH_SCHEMA_VERSION && parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files)) {
      const files: Record<string, ScopeHashRow> = {};
      for (const [relative, raw] of Object.entries(parsed.files).slice(-SCOPE_HASH_CACHE_MAX_FILES)) {
        try {
          if (safeSyncPath(relative) !== relative || relative.length > LOCAL_SCOPE_MAX_RELATIVE_PATH_LENGTH) continue;
        } catch { continue; }
        const row = raw as ScopeHashRow | undefined;
        if (!row || typeof row !== "object" || !/^[a-f0-9]{64}$/i.test(String(row.sha256 || ""))
          || !/^\d+$/.test(String(row.dev || "")) || !/^\d+$/.test(String(row.ino || ""))
          || !Number.isSafeInteger(row.size) || row.size < 0
          || ![row.mtimeMs, row.ctimeMs, row.birthtimeMs].every((value) => typeof value === "number" && Number.isFinite(value))) continue;
        files[relative] = { ...row, sha256: row.sha256.toLowerCase() };
      }
      return { schemaVersion: SCOPE_HASH_SCHEMA_VERSION, files };
    }
  }
  catch {
    // A missing or damaged cache only forces a rehash.
  }
  finally { await handle?.close().catch(() => undefined); }
  return { schemaVersion: SCOPE_HASH_SCHEMA_VERSION, files: {} };
}

async function writeScopeHashCache(file: string, document: ScopeHashDocument): Promise<void> {
  if (Object.keys(document.files).length > SCOPE_HASH_CACHE_MAX_FILES) throw new Error("同步范围哈希缓存超过文件数上限。");
  const serialized = JSON.stringify(document);
  if (Buffer.byteLength(serialized, "utf8") > SCOPE_HASH_CACHE_MAX_BYTES) throw new Error("同步范围哈希缓存超过字节上限。");
  const fullPath = path.resolve(file);
  const root = path.dirname(fullPath);
  await new HostOperationLeaseManager().run({
    pluginId: "simple-local.simple-experiment-mac",
    workspaceUri: root,
    hostProjectPath: root,
    actionType: "scope-hash-cache-write",
    actionLabel: "保存同步清单哈希缓存",
    waitForConflict: true,
    resources: [{ server: "local", project: root, target: fullPath }],
  }, () => atomicWriteText(fullPath, serialized));
}

export function requireCompleteScopeInventory<T extends { unverifiedFiles?: Record<string, string> }>(result: T, location = ""): T {
  const unverified = Object.entries(result.unverifiedFiles || {});
  if (unverified.length)
    throw new Error(`${location ? `${location}：` : ""}清单有 ${unverified.length} 个未验证路径（${unverified[0][0]}：${unverified[0][1]}），请确认该路径后刷新重试。`);
  return result;
}
export type ScopeInventories = {
  local: Record<string, File>;
  workers: Record<string, Record<string, File>>;
  unverified?: Record<string, Record<string, string>>;
};
export function scopeInventoryPathAllowed(relative: string, directory = false): boolean {
  const parts = relative.toLowerCase().split("/");
  const basename = parts.at(-1) || "";
  if (!directory && (basename.endsWith(".writing") || basename.endsWith(".pending") || /\.tmp(?:\.|$)/.test(basename) || basename.includes(".upload."))) return false;
  if (parts[0] === "tmp" || parts.some((part) => [".git", ".vscode", ".codex", ".agents", ".coding-tools", ".local-gpt", ".runtime", "clean_dir", "zlk_cluster", ".venv", "venv", "env", "node_modules", "__pycache__", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox"].includes(part))) return false;
  if (parts[0] === "experiments" && parts[1] === "results" && parts.at(-1)?.endsWith(".csv.lock")) return false;
  if (parts[0] === "work_dirs" && parts.at(-1) === ".tb_mean.lock") return false;
  if (parts.at(-1)?.startsWith(".env")) return false;
  if (["plan_sync_ledger.json", "project_mirror_state.json"].includes(parts.at(-1) || "")) return false;
  if (parts[0] !== "simple_cluster" || parts.length < 2) return true;
  if (["results", "debug_runs"].includes(parts[1])) return true;
  if (parts[1] !== "tmp") return false;
  if (parts.length === 2 || parts[2] === "tmux_logs") return true;
  if (parts[2] === "cluster_scheduler") return parts.length === 3 && directory || parts[3] === "logs" || parts.length === 4 && parts.at(-1)?.endsWith(".log") === true;
  return false;
}

export async function collectLocalScopeInventory(
  root: string, relative = ".", recursive = true, onUnverified?: (relative: string, reason: string) => void, cacheFile?: string,
): Promise<Record<string, File>> {
  const names = await listLocalScopeFileNames(root, relative, recursive, onUnverified);
  return hashLocalScopeNames(root, names, onUnverified, cacheFile);
}

/** One hash pool for every confirmed file and directory. Directory walks only list names. */
export async function collectSelectedLocalScopeFiles(
  root: string,
  items: Array<{ path: string; directory?: boolean }>,
  cacheFile?: string,
): Promise<Record<string, File>> {
  const names = new Set<string>();
  const budget = { directories: 0, entries: 0, files: 0 };
  for (const item of items) {
    if (item.directory) {
      const found = await listLocalScopeFileNames(root, item.path, true, undefined, budget);
      if (!found.length) throw new Error(`来源目录没有可同步文件：${item.path}`);
      for (const relative of found) {
        names.add(relative);
        if (names.size > LOCAL_SCOPE_MAX_FILES) throw new Error(`本机选择超过文件上限 ${LOCAL_SCOPE_MAX_FILES}。`);
      }
    } else {
      names.add(normalizeLocalScopeRelative(item.path));
      if (names.size > LOCAL_SCOPE_MAX_FILES) throw new Error(`本机选择超过文件上限 ${LOCAL_SCOPE_MAX_FILES}。`);
    }
  }
  return hashLocalScopeNames(root, [...names], undefined, cacheFile);
}

type LocalScopeRoot = { realPath: string; device: string };
type LocalScopeScanBudget = { directories: number; entries: number; files: number };

function normalizeLocalScopeRelative(relative: string): string {
  if (relative === ".") return "";
  const safe = safeSyncPath(relative);
  if (safe.length > LOCAL_SCOPE_MAX_RELATIVE_PATH_LENGTH) throw new Error("本机清单路径超过长度上限。");
  return safe;
}

function sameLocalPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithinLocalRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveLocalScopeRoot(root: string): Promise<LocalScopeRoot> {
  const rootPath = path.resolve(root);
  const stat = await fs.lstat(rootPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`本机同步根目录不存在：${rootPath}`);
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`本机同步根目录不是普通目录：${rootPath}`);
  return { realPath: await fs.realpath(rootPath), device: bigintString(stat.dev) };
}

async function verifyLocalScopeEntry(
  root: LocalScopeRoot, relative: string, expected: "file" | "directory",
): Promise<{ fullPath: string; stat: Stats }> {
  const normalized = normalizeLocalScopeRelative(relative);
  if (!normalized) throw new Error("本机同步根目录不能作为文件或子目录目标。");
  const parts = normalized.split("/");
  let current = root.realPath;
  let finalStat: Stats | undefined;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current, { bigint: false });
    if (stat.isSymbolicLink() || (root.device && bigintString(stat.dev) !== root.device))
      throw new Error(`本机清单路径包含符号链接或跨设备目录：${normalized}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`本机清单父路径不是目录：${normalized}`);
    const real = await fs.realpath(current);
    if (!isWithinLocalRoot(root.realPath, real) || !sameLocalPath(real, current))
      throw new Error(`本机清单路径越出所选根目录：${normalized}`);
    finalStat = stat;
  }
  if (!finalStat || (expected === "file" ? !finalStat.isFile() : !finalStat.isDirectory()))
    throw new Error(`本机清单目标类型发生变化：${normalized}`);
  return { fullPath: current, stat: finalStat };
}

async function listLocalScopeFileNames(
  rootPath: string, relative: string, recursive = true, onUnverified?: (relative: string, reason: string) => void,
  budget: LocalScopeScanBudget = { directories: 0, entries: 0, files: 0 },
): Promise<string[]> {
  const root = await resolveLocalScopeRoot(rootPath);
  const start = normalizeLocalScopeRelative(relative);
  const names: string[] = [];
  const pending = [start];
  const unverified = (child: string, reason: string): void => {
    if (!onUnverified) throw new Error(`本机清单无法完整验证（${child || "."}）：${reason}`);
    onUnverified(child || ".", reason);
  };
  while (pending.length) {
    const current = pending.pop()!;
    const currentPath = current || ".";
    const candidate = path.join(root.realPath, ...current.split("/").filter(Boolean));
    const initial = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && current) { unverified(current, "扫描期间目录已消失"); return undefined; }
      throw error;
    });
    if (!initial) continue;
    if (initial.isSymbolicLink() || (root.device && bigintString(initial.dev) !== root.device)) {
      unverified(currentPath, "目录是符号链接或跨设备挂载");
      continue;
    }
    if (initial.isFile()) {
      if (current && scopeInventoryPathAllowed(current, false)) names.push(current);
      continue;
    }
    if (!initial.isDirectory()) { unverified(currentPath, "目标不是普通文件或目录"); continue; }
    if (++budget.directories > LOCAL_SCOPE_MAX_DIRECTORIES) throw new Error(`本机清单超过目录上限 ${LOCAL_SCOPE_MAX_DIRECTORIES}，拒绝生成不完整清单。`);
    const real = await fs.realpath(candidate);
    if (!isWithinLocalRoot(root.realPath, real) || !sameLocalPath(real, candidate)) {
      unverified(currentPath, "目录解析后越出所选根目录");
      continue;
    }
    const directory = await fs.opendir(candidate, { bufferSize: 32 });
    try {
      for await (const entry of directory) {
        if (++budget.entries > LOCAL_SCOPE_MAX_ENTRIES) throw new Error(`本机清单超过目录项上限 ${LOCAL_SCOPE_MAX_ENTRIES}，拒绝生成不完整清单。`);
        const child = current ? `${current}/${entry.name}` : entry.name;
        let safeChild: string;
        try { safeChild = normalizeLocalScopeRelative(child); }
        catch (error) { unverified(child, error instanceof Error ? error.message : String(error)); continue; }
        if (!scopeInventoryPathAllowed(safeChild, entry.isDirectory())) continue;
        const childPath = path.join(candidate, entry.name);
        const childStat = await fs.lstat(childPath);
        if (childStat.isSymbolicLink() || (root.device && bigintString(childStat.dev) !== root.device)) {
          unverified(safeChild, "路径是符号链接或跨设备挂载");
          continue;
        }
        const childReal = await fs.realpath(childPath);
        if (!isWithinLocalRoot(root.realPath, childReal) || !sameLocalPath(childReal, childPath)) {
          unverified(safeChild, "路径解析后越出所选根目录");
          continue;
        }
        if (childStat.isDirectory()) {
          if (recursive) pending.push(safeChild);
        } else if (childStat.isFile()) {
          if (++budget.files > LOCAL_SCOPE_MAX_FILES) throw new Error(`本机清单超过文件上限 ${LOCAL_SCOPE_MAX_FILES}，拒绝生成不完整清单。`);
          names.push(safeChild);
        } else unverified(safeChild, "路径不是普通文件或目录");
      }
    } finally { await directory.close().catch(() => undefined); }
    const afterRead = await fs.lstat(candidate);
    if (afterRead.isSymbolicLink() || !afterRead.isDirectory() || bigintString(afterRead.dev) !== bigintString(initial.dev)
      || bigintString(afterRead.ino) !== bigintString(initial.ino) || afterRead.mtimeMs !== initial.mtimeMs
      || (root.device && bigintString(afterRead.dev) !== root.device))
      throw new Error(`本机目录在清单扫描期间发生变化：${currentPath}`);
  }
  return names;
}

export async function hashLocalScopeNames(
  root: string, names: string[], onUnverified?: (relative: string, reason: string) => void, cacheFile?: string,
): Promise<Record<string, File>> {
  if (names.length > LOCAL_SCOPE_MAX_ENTRIES) throw new Error(`本机哈希清单超过输入上限 ${LOCAL_SCOPE_MAX_ENTRIES}。`);
  const normalizedNames = [...new Set(names.map(normalizeLocalScopeRelative))];
  if (normalizedNames.length > LOCAL_SCOPE_MAX_FILES) throw new Error(`本机哈希清单超过文件上限 ${LOCAL_SCOPE_MAX_FILES}。`);
  const requestedNames = new Set(normalizedNames);
  const rootInfo = await resolveLocalScopeRoot(root);
  const persisted: ScopeHashDocument = cacheFile ? await readScopeHashCache(cacheFile) : { schemaVersion: SCOPE_HASH_SCHEMA_VERSION, files: {} };
  const activeRows: Record<string, ScopeHashRow> = {};
  const files: Record<string, File> = {};
  let next = 0;
  let failed = false;
  let fatalError: unknown;
  await Promise.all(Array.from({ length: Math.min(8, Math.max(1, normalizedNames.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= normalizedNames.length || fatalError) break;
      const relative = normalizedNames[index];
      let full = path.join(rootInfo.realPath, ...relative.split("/"));
      try {
      if (!scopeInventoryPathAllowed(relative, false)) throw new Error(`本机清单路径属于排除项：${relative}`);
      const verified = await verifyLocalScopeEntry(rootInfo, relative, "file");
      full = verified.fullPath;
      const beforeStat = verified.stat;
      const before = scopeHashIdentity(beforeStat);
      if (!before) throw new Error(`本机文件身份不完整，无法复用哈希：${relative}`);
      const identity = scopeHashIdentityKey(before);
      const memory = localHashCache.get(full);
      const stored = persisted.files[relative];
      const reusable = memory?.identity === identity
        ? memory.file
        : sameScopeHashIdentity(stored, before)
          ? { sha256: stored.sha256.toLowerCase(), size: stored.size, modifiedAtMs: Number.isFinite(stored.modifiedAtMs) ? stored.modifiedAtMs : before.mtimeMs }
          : undefined;
      if (reusable) {
        const confirmed = scopeHashIdentity(await fs.lstat(full));
        if (!confirmed || !sameScopeHashIdentity({ ...before, sha256: reusable.sha256 }, confirmed))
          throw new Error(`本机文件在复用哈希前发生变化：${relative}`);
        files[relative] = reusable;
        activeRows[relative] = { ...confirmed, sha256: reusable.sha256, modifiedAtMs: reusable.modifiedAtMs };
        rememberLocalScopeHash(full, identity, reusable);
        continue;
      }
      const hash = crypto.createHash("sha256");
      const openFlags = fsConstants.O_RDONLY | (process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
      const handle = await fs.open(full, openFlags);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || bigintString(opened.dev) !== bigintString(beforeStat.dev) || bigintString(opened.ino) !== bigintString(beforeStat.ino))
          throw new Error(`本机文件在打开时发生替换：${relative}`);
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let remaining = beforeStat.size;
        while (remaining > 0) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
          if (!bytesRead) throw new Error(`本机文件在校验期间被截断：${relative}`);
          hash.update(buffer.subarray(0, bytesRead));
          remaining -= bytesRead;
        }
      } finally { await handle.close(); }
      const afterStat = await fs.lstat(full);
      const after = scopeHashIdentity(afterStat);
      if (!afterStat.isFile() || afterStat.isSymbolicLink() || bigintString(afterStat.dev) !== rootInfo.device || !after || !sameScopeHashIdentity({ ...before, sha256: "0".repeat(64) }, after))
        throw new Error(`本机文件在校验时变更：${relative}`);
      const file = { sha256: hash.digest("hex"), size: after.size, modifiedAtMs: afterStat.mtimeMs };
      rememberLocalScopeHash(full, identity, file);
      activeRows[relative] = { ...after, sha256: file.sha256, modifiedAtMs: file.modifiedAtMs };
      files[relative] = file;
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
        if (missing) localHashCache.delete(full);
        else failed = true;
        if (!onUnverified) { fatalError ??= error; continue; }
        try { onUnverified(relative, error instanceof Error ? error.message : String(error)); }
        catch (callbackError) { fatalError ??= callbackError; }
      }
    }
  }));
  if (fatalError) throw fatalError;
  if (cacheFile && !failed) {
    try {
      await writeScopeHashCache(cacheFile, { schemaVersion: SCOPE_HASH_SCHEMA_VERSION, files: boundedScopeHashRows(activeRows, persisted.files, requestedNames) });
    }
    catch (error) {
      console.warn(`[SimpleExperiment] local scope hash cache write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return files;
}

function boundedScopeHashRows(
  active: Record<string, ScopeHashRow>, previous: Record<string, ScopeHashRow>, requested: Set<string>,
): Record<string, ScopeHashRow> {
  const files: Record<string, ScopeHashRow> = {};
  let bytes = Buffer.byteLength(`{"schemaVersion":${SCOPE_HASH_SCHEMA_VERSION},"files":{}}`, "utf8");
  let count = 0;
  const add = (relative: string, row: ScopeHashRow): void => {
    if (count >= SCOPE_HASH_CACHE_MAX_FILES || relative.length > LOCAL_SCOPE_MAX_RELATIVE_PATH_LENGTH) return;
    const entryBytes = Buffer.byteLength(`${JSON.stringify(relative)}:${JSON.stringify(row)}`, "utf8") + (count ? 1 : 0);
    if (bytes + entryBytes > SCOPE_HASH_CACHE_MAX_BYTES) return;
    files[relative] = row;
    bytes += entryBytes;
    count++;
  };
  for (const [relative, row] of Object.entries(active)) add(relative, row);
  for (const [relative, row] of Object.entries(previous).reverse()) if (!files[relative] && !requested.has(relative)) add(relative, row);
  return files;
}

function ownerForPath(path: string, ledger: PlanSyncLedger): string | undefined {
  const plans = new Set(Object.values(ledger.entries || {}).map((entry) => entry.planFile));
  for (const plan of plans) {
    const latest = latestPlanSyncEntry(ledger, plan);
    if (latest && (latest.artifactPaths.includes(path) || latest.directoryPaths.some((directory) => path.startsWith(`${directory}/`))))
      return latest.sourceWorkerId;
  }
  return undefined;
}

export function buildScopeStatuses(
  inventories: ScopeInventories,
  mode: "local-server" | "server-server",
  selectedPaths: string[],
  localDefaultPaths: Set<string>,
  ledger: PlanSyncLedger,
  offlineWorkerIds = new Set<string>(),
  holds: SyncHolds = {},
  authoritativeWorkers: Record<string, string> = {},
): Record<string, ScopeStatus> {
  const workers = Object.keys(inventories.workers).sort();
  const all = new Set([
    ...(mode === "local-server" ? Object.keys(inventories.local) : []),
    ...workers.flatMap((id) => Object.keys(inventories.workers[id] || {})),
    ...Object.entries(inventories.unverified || {}).flatMap(([id, files]) => id === "local" && mode === "server-server" ? [] : Object.keys(files)),
  ]);
  const statuses: Record<string, ScopeStatus> = {};
  const inSelectedScope = (path: string) => selectedPaths.some((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`));
  for (const path of [...all].sort()) {
    const inScope = mode === "server-server"
      ? inSelectedScope(path)
      : localDefaultPaths.has(path) || inSelectedScope(path);
    if (!inScope) { statuses[path] = { state: "unknown", detail: "当前同步范围外" }; continue; }
    if (!workers.length) { statuses[path] = { state: "unknown", detail: "尚未配置 Worker" }; continue; }
    const localHash = inventories.local[path]?.sha256?.toLowerCase();
    const remote = workers.map((id) => ({ id, hash: inventories.workers[id]?.[path]?.sha256?.toLowerCase() }));
    const versions: NonNullable<ScopeStatus["versions"]> = {};
    const addVersion = (id: string, file?: File) => { if (file?.sha256) versions[id] = { sha256: file.sha256, modifiedAtMs: Number(file.modifiedAtMs || 0) }; };
    if (mode === "local-server") addVersion("local", inventories.local[path]);
    for (const id of workers) if (!offlineWorkerIds.has(id)) addVersion(id, inventories.workers[id]?.[path]);
    const held = isSyncHeld(path, holds);
    const unstable = Object.entries(inventories.unverified || {}).filter(([id, files]) => (mode === "local-server" || id !== "local") && files[path]);
    if (unstable.length) {
      const detail = unstable.map(([id, files]) => `${id === "local" ? "本机" : id} ${files[path]}，待重试`).join(" · ");
      statuses[path] = { state: "unknown", detail, versions, held, unverified: true };
      continue;
    }
    if (mode === "local-server") {
      const detail = [`本机 ${localHash ? "最新版" : "缺失"}`, ...remote.map(({ id, hash }) => `${id} ${offlineWorkerIds.has(id) ? "未校验，待核对" : !hash ? "待更新" : hash === localHash ? "最新版" : "待更新"}`)].join(" · ");
      const state = localHash && remote.every(({ hash }) => hash === localHash) ? "same" : offlineWorkerIds.size && localHash && remote.every(({ id, hash }) => offlineWorkerIds.has(id) || hash === localHash) ? "unknown" : "different";
      if (versions.local) versions.local.latest = "local";
      statuses[path] = { state, detail: held ? `${detail} · 自动同步已暂停` : detail, versions, held };
      continue;
    }
    const owner = authoritativeWorkers[path] || ownerForPath(path, ledger);
    const ownerHash = owner ? inventories.workers[owner]?.[path]?.sha256?.toLowerCase() : undefined;
    const present = remote.filter(({ hash }) => hash);
    const unique = new Set(present.map(({ hash }) => hash));
    const manualHash = chosenSyncHash(path, holds)?.toLowerCase();
    const reference = manualHash || (owner ? ownerHash : unique.size === 1 ? present[0]?.hash : undefined);
    const remoteSame = Boolean(reference) && remote.every(({ hash }) => hash === reference);
    const detail = !reference
      ? `${owner && offlineWorkerIds.has(owner) ? `Plan 归属 ${owner} 未校验，待核对` : "内容冲突，无法判定最新版"} · ${remote.map(({ id, hash }) => `${id} ${offlineWorkerIds.has(id) ? "未校验" : hash ? "冲突" : "缺失"}`).join(" · ")}`
      : [manualHash ? "手动保留版本" : owner ? `Plan 归属：${owner}` : "Worker 内容基准",
        ...remote.map(({ id, hash }) => `${id} ${offlineWorkerIds.has(id) ? "未校验，待核对" : hash === reference ? "最新版" : "待更新"}`)].join(" · ");
    const activeMatch = Boolean(reference) && remote.every(({ id, hash }) => offlineWorkerIds.has(id) || hash === reference);
    const state = remoteSame ? "same"
      : offlineWorkerIds.size && activeMatch || owner && offlineWorkerIds.has(owner) ? "unknown" : "different";
    if (manualHash) {
      for (const file of Object.values(versions)) if (file.sha256.toLowerCase() === manualHash) file.latest = "manual";
    } else if (owner && versions[owner]) versions[owner].latest = "plan";
    else if (!owner && unique.size > 1) {
      const candidates = Object.entries(versions).filter(([id]) => id !== "local");
      const newest = Math.max(...candidates.map(([, file]) => file.modifiedAtMs));
      if (newest > 0 && candidates.filter(([, file]) => file.modifiedAtMs === newest).length === 1)
        for (const [, file] of candidates) if (file.modifiedAtMs === newest) file.latest = "candidate";
    } else if (!owner && unique.size === 1) for (const [id, file] of Object.entries(versions)) if (id !== "local" && file.sha256.toLowerCase() === reference) file.latest = "same";
    statuses[path] = { state, detail: held ? `${detail} · 自动同步已暂停` : detail, versions, held };
  }
  const folders = new Map<string, { total: number; failed: number; remoteOnly: number; unknown: number; outside: number; copies: NonNullable<ScopeStatus["copies"]> }>();
  const count = (folder: string, path: string, status: ScopeStatus) => {
    const row = folders.get(folder) || { total: 0, failed: 0, remoteOnly: 0, unknown: 0, outside: 0, copies: {} };
    const reference = Object.values(status.versions || {}).find((version) => version.latest && version.latest !== "candidate")?.sha256.toLowerCase();
    for (const id of mode === "local-server" ? ["local", ...workers] : workers) {
      const copy = row.copies[id] || { modifiedAtMs: 0, present: 0, missing: 0, needsSync: 0, conflict: 0, unverified: 0 };
      const file = id === "local" ? inventories.local[path] : inventories.workers[id]?.[path];
      if (file) copy.modifiedAtMs = Math.max(copy.modifiedAtMs, Number(file.modifiedAtMs || 0));
      if (status.detail !== "当前同步范围外") {
        if (id !== "local" && offlineWorkerIds.has(id) || inventories.unverified?.[id]?.[path]) copy.unverified++;
        else if (!file) copy.missing++;
        else {
          copy.present++;
          if (reference && file.sha256.toLowerCase() !== reference) copy.needsSync++;
          else if (!reference && mode === "server-server" && status.state === "different") copy.conflict++;
        }
      }
      row.copies[id] = copy;
    }
    if (status.detail === "当前同步范围外") { row.outside++; folders.set(folder, row); return; }
    row.total++;
    if (status.state === "different") row.failed++;
    if (status.state === "remote-only") row.remoteOnly++;
    if (status.state === "unknown") row.unknown++;
    folders.set(folder, row);
  };
  for (const path of all) {
    count(".", path, statuses[path]);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) count(parts.slice(0, i).join("/"), path, statuses[path]);
  }
  for (const [folder, { total, failed, remoteOnly, unknown, outside, copies }] of folders) {
    const same = total - failed - remoteOnly - unknown;
    statuses[folder] = {
      state: !total ? "unknown" : failed ? "different" : unknown ? "unknown" : remoteOnly ? "remote-only" : "same",
      detail: total ? `同步范围内 ${total} 个文件 · ${same} 一致 · ${failed} 待更新或冲突 · ${remoteOnly} 仅 Worker 一致 · ${unknown} 未确认${outside ? ` · ${outside} 范围外` : ""}`
        : `当前同步范围外 · ${outside} 个文件`,
      copies,
      held: isSyncHeld(folder, holds),
      unverified: unknown > 0,
    };
  }
  return statuses;
}
