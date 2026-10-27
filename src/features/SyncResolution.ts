import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { atomicWriteText } from "../state/StateStore";
import { assertDarwinCleanupHandles } from "../platform/CleanupHandles";
import { ensureProjectSnapshotMigrated, projectStateFile, projectStateId } from "./ProjectStatePaths";

export type SyncHold = { endpointId: string; deletedAt: string; directory: boolean; codeOwned?: boolean; status?: "pending" | "resolved"; sha256?: string; fileHashes?: Record<string, string> };
export type SyncHolds = Record<string, SyncHold>;

export function safeSyncPath(relative: string): string {
  const value = String(relative || "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[a-z]:/i.test(value) || value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error(`同步路径不安全：${relative}`);
  return value;
}

export function isSyncHeld(relative: string, holds: SyncHolds): boolean {
  return Object.entries(holds).some(([held, row]) => row.status !== "resolved" && (relative === held || row.directory && relative.startsWith(`${held}/`)));
}

export function chosenSyncHash(relative: string, holds: SyncHolds): string | undefined {
  const exact = holds[relative];
  if (exact?.status === "resolved" && !exact.directory) return exact.sha256;
  for (const [held, row] of Object.entries(holds))
    if (row.status === "resolved" && row.directory && relative.startsWith(`${held}/`)) return row.fileHashes?.[relative];
  return undefined;
}

export function filterHeldFiles<T>(files: Record<string, T>, holds: SyncHolds): Record<string, T> {
  return Object.fromEntries(Object.entries(files).filter(([relative]) => !isSyncHeld(relative, holds)));
}

/** r17-A: holds live inside the CONSUMED project; storageRoot only locates the known legacy
 * snapshot for one read-only migration. A corrupt legacy file keeps its original error
 * semantics via "invalid-legacy" — it is never silently replaced by an empty holds set. */
export function syncHoldsStoragePath(storageRoot: string, projectRoot: string): string {
  return projectStateFile(projectRoot, "simple-experiment", "sync-holds", `${projectStateId(projectRoot)}.json`);
}

export function legacySyncHoldsStoragePath(storageRoot: string, projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const id = crypto.createHash("sha256").update(process.platform === "win32" ? resolved.toLowerCase() : resolved).digest("hex");
  return path.join(storageRoot, "sync-holds", `${id}.json`);
}

function validSyncHoldsShape(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function loadSyncHolds(storageRoot: string, projectRoot: string): Promise<SyncHolds> {
  const file = syncHoldsStoragePath(storageRoot, projectRoot);
  const migration = await ensureProjectSnapshotMigrated(projectRoot, legacySyncHoldsStoragePath(storageRoot, projectRoot), file, validSyncHoldsShape);
  const content = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return migration === "invalid-legacy" ? undefined : "{}";
    throw error;
  });
  if (content === undefined) throw new Error("同步暂停记录格式无效。");
  const value = JSON.parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("同步暂停记录格式无效。");
  for (const [relative, row] of Object.entries(value)) {
    safeSyncPath(relative);
    if (!row || typeof row !== "object" || typeof (row as SyncHold).endpointId !== "string") throw new Error("同步暂停记录条目无效。");
    const item = row as SyncHold;
    if (item.status === "resolved" && (item.directory ? !item.fileHashes || typeof item.fileHashes !== "object" : !/^[a-f0-9]{64}$/i.test(item.sha256 || "")))
      throw new Error("同步保留版本记录无效。");
    for (const [file, hash] of Object.entries(item.fileHashes || {})) if (!safeSyncPath(file) || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error("同步保留目录记录无效。");
  }
  return value;
}

export async function saveSyncHolds(storageRoot: string, projectRoot: string, holds: SyncHolds): Promise<void> {
  const file = syncHoldsStoragePath(storageRoot, projectRoot);
  await atomicWriteText(file, JSON.stringify(holds, null, 2) + "\n");
}

function psLiteral(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

function checkLocalDeleteTarget(root: string, relative: string): void {
  safeSyncPath(relative);
  if (relative.replace(/\\/g, "/").split("/").some(part => [".git", "clean_dir"].includes(part.toLowerCase())))
    throw new Error(`PROTECTED_PATH：仓库元数据或归档区不可作为独立删除目标；阻拦路径：${path.resolve(root, ...relative.replace(/\\/g, "/").split("/"))}`);
}

export function localDeleteScript(root: string, relative: string, expected?: { type: "file" | "directory"; size: string; modifiedTicks: string }): string {
  checkLocalDeleteTarget(root, relative);
  const full = path.resolve(root, ...relative.split("/"));
  const parent = path.dirname(full);
  const leaf = `./${path.basename(full)}`;
  if (path.relative(root, full).startsWith("..") || full === path.resolve(root)) throw new Error("删除目标超出项目根目录。");
  const identity = expected
    ? `$item=Get-Item -LiteralPath ${psLiteral(leaf)} -Force -ErrorAction Stop; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'TARGET_CHANGED' }; if (${expected.type === "directory" ? "$item -isnot [IO.DirectoryInfo]" : "$item -isnot [IO.FileInfo]"}) { throw 'TARGET_CHANGED' }; if ([string]$item.LastWriteTimeUtc.Ticks -ne ${psLiteral(expected.modifiedTicks)} -or ${expected.type === "file" ? `$item.Length -ne ${psLiteral(expected.size)}` : "$false"}) { throw 'TARGET_CHANGED' }; `
    : "";
  return `$ErrorActionPreference = 'Stop'; try { Set-Location -LiteralPath ${psLiteral(parent)}; $cwd=[IO.Path]::GetFullPath((Get-Location).ProviderPath).TrimEnd('\\'); if (-not [string]::Equals($cwd, ${psLiteral(parent)}, [StringComparison]::OrdinalIgnoreCase)) { throw 'PARENT_CD_FAILED' } } catch { [Console]::Error.WriteLine('PARENT_CD_FAILED'); exit 75 }; ${identity}Remove-Item -LiteralPath ${psLiteral(leaf)} -Recurse -Force -ErrorAction Stop`;
}

export async function deleteLocalSyncPath(root: string, relative: string): Promise<string> {
  checkLocalDeleteTarget(root, relative);
  if (process.platform === "darwin") return await macDeleteLocalSyncPath(root, relative);
  // Non-Windows, non-macOS executors have no Darwin handle proof; fail closed.
  if (process.platform !== "win32") throw Object.assign(new Error("HANDLE_CHECK_UNAVAILABLE：同步范围直接删除仅支持 Windows 与 macOS；当前平台未执行删除。"), { code: "HANDLE_CHECK_UNAVAILABLE" });
  const full = path.resolve(root, ...relative.split("/"));
  const parent = path.dirname(full);
  const rootStat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => { throw new Error(`PARENT_CD_FAILED：无法核验项目根目录：${error.message}`); });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("PARENT_CD_FAILED：项目根目录不是普通目录；禁止删除。");
  const rootReal = await fs.realpath(root);
  const relativeParent = path.relative(root, path.dirname(full));
  let checkedParent = rootReal;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    checkedParent = path.join(checkedParent, part);
    const component = await fs.lstat(checkedParent).catch((error: NodeJS.ErrnoException) => { throw new Error(`PARENT_CD_FAILED：无法核验父目录 ${checkedParent}：${error.message}`); });
    if (!component.isDirectory() || component.isSymbolicLink() || component.dev !== rootStat.dev)
      throw new Error(`PARENT_CD_FAILED：父目录不是项目内普通目录：${checkedParent}`);
  }
  const parentReal = await fs.realpath(path.dirname(full)).catch((error: NodeJS.ErrnoException) => { throw new Error(`PARENT_CD_FAILED：无法进入父目录 ${path.dirname(full)}：${error.message}`); });
  if (parentReal !== checkedParent) throw new Error(`PARENT_CD_FAILED：物理父目录发生变化：${parentReal}`);
  const within = path.relative(rootReal, parentReal);
  if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error("删除目标超出项目根目录。");
  const target = await fs.lstat(full, { bigint: true });
  const targetType = target.isDirectory() ? "directory" : target.isFile() ? "file" : undefined;
  if (!targetType || target.isSymbolicLink() || (targetType === "file" && target.nlink > 1n)) throw new Error("删除目标不是独占普通文件/目录，或是符号链接；禁止删除。");
  const modifiedTicks = (621355968000000000n + target.mtimeNs / 100n).toString();
  const recheck = await fs.lstat(full, { bigint: true });
  if (recheck.dev !== target.dev || recheck.ino !== target.ino || recheck.size !== target.size || recheck.mtimeMs !== target.mtimeMs
    || recheck.mtimeNs !== target.mtimeNs || recheck.isSymbolicLink() || recheck.isDirectory() !== (targetType === "directory") || (targetType === "file" && recheck.nlink > 1n)) throw new Error("删除目标身份在执行前发生变化；禁止删除。");
  try { await promisify(execFile)("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", localDeleteScript(rootReal, relative, { type: targetType, size: target.size.toString(), modifiedTicks })], { cwd: parentReal, windowsHide: true, timeout: 0 }); }
  catch (error) {
    const detail = `${String(error)} ${String((error as NodeJS.ErrnoException & { stderr?: string }).stderr || "")}`;
    if (detail.includes("PARENT_CD_FAILED")) throw new Error(`PARENT_CD_FAILED：无法进入父目录 ${parentReal}；禁止删除。`);
    if (detail.includes("TARGET_CHANGED")) throw new Error(`删除目标身份已变化，未执行删除：${relative}`);
    throw error;
  }
  try { await fs.lstat(full); } catch (error: any) { if (error?.code === "ENOENT") return full; throw error; }
  throw new Error(`删除后目标仍存在：${relative}`);
}

/* macOS direct local delete: bounded frozen directory inventory plus the shared
 * Darwin libproc handle proof, executed in an isolated child after the tree's
 * two exact-path confirmations. The parent only verifies and spawns. */

const MAC_INVENTORY_ENTRY_LIMIT = 20000;
const MAC_INVENTORY_DEPTH_LIMIT = 64;

type MacDeleteHost = { handleProbe: () => string };
let macDeleteHost: MacDeleteHost | undefined;

export function configureMacSyncDeleteHost(host: MacDeleteHost | undefined): void { macDeleteHost = host; }

function unavailableMacDelete(detail: string): never {
  throw Object.assign(new Error(`HANDLE_CHECK_UNAVAILABLE：${detail}`), { code: "HANDLE_CHECK_UNAVAILABLE" });
}

type MacExpectedIdentity = { type: "file" | "directory"; dev: string; ino: string; size: string; mtimeNs: string; nlink: string };

function sameMacIdentity(stat: any, expected: MacExpectedIdentity): boolean {
  return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino && String(stat.size) === expected.size
    && String(stat.mtimeNs) === expected.mtimeNs && String(stat.nlink) === expected.nlink;
}

/** Re-runs the shared safety-root/physical-parent checks inside the deleting process. */
function verifyMacDeletePosition(disk: typeof nodeFs, root: string, parts: string[]): { full: string; parent: string; leaf: string; rootDev: bigint; target: any; type: "file" | "directory" } {
  const rootStat = disk.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || disk.realpathSync(root) !== root) throw new Error("PARENT_CD_FAILED：项目根目录不是已核验的普通目录；禁止删除。");
  const full = path.posix.join(root, ...parts);
  const parent = path.posix.dirname(full);
  const relativeParent = path.posix.relative(root, parent);
  if (relativeParent === ".." || relativeParent.startsWith("../") || path.posix.isAbsolute(relativeParent)) throw new Error("删除目标超出项目根目录。");
  const parentStat = disk.lstatSync(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.dev !== rootStat.dev || disk.realpathSync(parent) !== parent)
    throw new Error(`PARENT_CD_FAILED：物理直接父目录校验失败：${parent}`);
  const target = disk.lstatSync(full, { bigint: true });
  const type = target.isDirectory() ? "directory" as const : target.isFile() ? "file" as const : undefined;
  if (!type || target.isSymbolicLink() || target.dev !== rootStat.dev || (type === "file" && target.nlink !== 1n))
    throw new Error("删除目标不是项目内独占普通文件/目录，或是符号链接；禁止删除。");
  return { full, parent, leaf: path.posix.basename(full), rootDev: rootStat.dev, target, type };
}

export type MacFrozenEntry = { path: string; type: "file" | "directory"; device: string; inode: string; size: string; mtimeNs: string; nlink: string };

/** Bounded frozen full-tree inventory: path, kind and complete identity for every
 * descendant. Symlinks, irregular files, hardlinks, foreign devices and protected
 * segments block; the proof covers the whole tree, not only the top entry. */
function walkMacDeleteInventory(disk: typeof nodeFs, start: string, rootDev: bigint): MacFrozenEntry[] {
  const entries: MacFrozenEntry[] = [];
  const record = (file: string, stat: any): void => {
    if (entries.length >= MAC_INVENTORY_ENTRY_LIMIT) throw new Error("INVENTORY_UNBOUNDED：删除目录条目超过冻结证明上限；未执行删除。");
    const type = stat.isDirectory() ? "directory" as const : "file" as const;
    entries.push({ path: file, type, device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), nlink: String(stat.nlink) });
  };
  const walk = (directory: string, depth: number): void => {
    if (depth > MAC_INVENTORY_DEPTH_LIMIT) throw new Error("INVENTORY_UNBOUNDED：删除目录层级超过冻结证明上限；未执行删除。");
    for (const name of disk.readdirSync(directory).sort()) {
      const file = path.join(directory, String(name));
      if (String(name).toLowerCase() === ".git" || String(name).toLowerCase() === "clean_dir")
        throw new Error(`PROTECTED_PATH：删除目标树包含仓库元数据或归档目录；禁止删除：${file}`);
      const stat = disk.lstatSync(file, { bigint: true });
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.dev !== rootDev)
        throw new Error(`删除目标树包含符号链接、特殊文件或跨设备条目；禁止删除：${file}`);
      if (stat.isFile() && stat.nlink !== 1n) throw new Error(`删除目标树包含硬链接文件；未获得独占证明；禁止删除：${file}`);
      record(file, stat);
      if (stat.isDirectory()) walk(file, depth + 1);
    }
  };
  const startStat = disk.lstatSync(start, { bigint: true });
  if (startStat.isFile() && startStat.nlink !== 1n) throw new Error("删除目标是硬链接文件；未获得独占证明；禁止删除。");
  record(start, startStat);
  if (startStat.isDirectory()) walk(start, 1);
  return entries;
}

/** Child-side executor. Every caller-provided fact is re-verified here. */
export function macDeleteChild(request: any, disk: any = nodeFs, host: any = process,
  proof: (file: string, fullPath: string, expected: { dev: bigint; ino: bigint }, inventory?: Array<{ device: string; inode: string }>) => void = assertDarwinCleanupHandles): void {
  const root = typeof request?.root === "string" ? request.root : "";
  if (!path.posix.isAbsolute(root) || root === "/" || path.posix.normalize(root) !== root) throw new Error("PARENT_CD_FAILED：根目录必须是规范绝对路径。");
  const parts = safeSyncPath(String(request?.relative || "")).split("/");
  if (parts.some(part => [".git", "clean_dir"].includes(part.toLowerCase())))
    throw new Error(`PROTECTED_PATH：仓库元数据或归档区不可作为独立删除目标；阻拦路径：${request?.relative}`);
  const position = verifyMacDeletePosition(disk, root, parts);
  const expected: MacExpectedIdentity = {
    type: position.type, dev: String(position.target.dev), ino: String(position.target.ino), size: String(position.target.size),
    mtimeNs: String(position.target.mtimeNs), nlink: String(position.target.nlink),
  };
  if (request.expected && JSON.stringify(request.expected) !== JSON.stringify(expected))
    throw new Error(`删除目标身份在启动删除程序后发生变化：${request.relative}`);
  const verifyParent = (): void => {
    const check = verifyMacDeletePosition(disk, root, parts);
    if (String(check.target.dev) !== expected.dev || String(check.target.ino) !== expected.ino) throw new Error("TARGET_CHANGED：删除目标身份已变化。");
  };
  verifyParent();
  try { host.chdir(position.parent); if (host.cwd() !== position.parent || disk.realpathSync(".") !== position.parent) throw new Error("PARENT_CD_FAILED：当前物理工作目录不是已核验父目录。"); }
  catch (error: any) { throw error?.message === "PARENT_CD_FAILED：当前物理工作目录不是已核验父目录。" ? error : new Error(`PARENT_CD_FAILED：无法进入父目录 ${position.parent}。`); }
  const inventory = walkMacDeleteInventory(disk, position.full, position.rootDev);
  const compareInventory = (): void => {
    if (JSON.stringify(inventory) !== JSON.stringify(walkMacDeleteInventory(disk, position.full, position.rootDev)))
      throw new Error("TARGET_CHANGED：目录内容在冻结证明前后发生变化；未执行删除。");
  };
  compareInventory();
  const after = disk.lstatSync(position.full, { bigint: true });
  if (!sameMacIdentity(after, expected))
    throw new Error("TARGET_CHANGED：目录清单或目标身份在冻结证明期间发生变化；未执行删除。");
  proof(String(request?.handleProbe || ""), position.full, { dev: position.target.dev, ino: position.target.ino },
    inventory.map(entry => ({ device: entry.device, inode: entry.inode })));
  // The proof covered only the frozen tree; the whole tree must still be byte-identical now.
  compareInventory();
  verifyParent();
  const leaf = `./${position.leaf}`;
  if (host.cwd() !== position.parent || disk.realpathSync(".") !== position.parent || !sameMacIdentity(disk.lstatSync(leaf, { bigint: true }), expected))
    throw new Error("TARGET_CHANGED：删除前最后一刻目标身份或父目录工作目录已变化。");
  disk.rmSync(leaf, { recursive: true, force: false, maxRetries: 0 });
  try { disk.lstatSync(leaf); } catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error("TARGET_STILL_PRESENT：删除后目标仍存在。");
}

async function macDeleteLocalSyncPath(root: string, relative: string): Promise<string> {
  if (!macDeleteHost) unavailableMacDelete("同步范围直接删除缺少配套句柄证明入口，未执行删除。");
  const rootReal = await fs.realpath(root).catch(() => unavailableMacDelete(`无法解析项目根目录：${root}`)) as string;
  const handleProbe = macDeleteHost!.handleProbe();
  let probeStat: nodeFs.Stats;
  try { probeStat = await fs.lstat(handleProbe); } catch { unavailableMacDelete("缺少配套 SimpleSFTP Mac 的原生句柄证明脚本，未执行删除。"); }
  if (!probeStat!.isFile() || probeStat!.isSymbolicLink()) unavailableMacDelete("原生句柄证明入口身份无效，未执行删除。");
  const parts = safeSyncPath(relative).split("/");
  const position = verifyMacDeletePosition(nodeFs, rootReal, parts);
  const request = { root: rootReal, relative, handleProbe,
    expected: { type: position.type, dev: String(position.target.dev), ino: String(position.target.ino), size: String(position.target.size), mtimeNs: String(position.target.mtimeNs), nlink: String(position.target.nlink) } as MacExpectedIdentity };
  const child = spawnSync(process.execPath, [__filename, JSON.stringify(request)], {
    cwd: position.parent, timeout: 10000, maxBuffer: 262144, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const stderrText = String(child.stderr || "");
  if (child.error || child.status !== 0 || child.signal) {
    const detail = (stderrText.split("\n").filter(Boolean).pop() || "").slice(0, 400);
    if (child.signal || (child.error as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT")
      throw new Error(`删除结果未知：本机删除程序${child.signal ? `被信号 ${child.signal} 终止` : "超时"}，删除可能部分发生；请按实际状态复核。`);
    if (child.error) throw new Error(`PARENT_CD_FAILED：无法在已核验父目录启动删除程序：${String(child.error)}`);
    throw new Error(detail || `HANDLE_CHECK_UNAVAILABLE：本机删除程序未成功退出（状态 ${child.status}），未确认删除结果。`);
  }
  try { await fs.lstat(position.full); } catch (error: any) { if (error?.code === "ENOENT") return position.full; throw error; }
  throw new Error(`删除后目标仍存在：${relative}`);
}

if (require.main === module) {
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Unsupported Mac cleanup host");
    macDeleteChild(JSON.parse(process.argv[2]));
  } catch (error: any) { process.stderr.write(String(error?.message || error) + "\n"); process.exitCode = 1; }
}
