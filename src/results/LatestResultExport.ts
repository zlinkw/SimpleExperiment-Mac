import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import { atomicWriteText } from "../state/StateStore";
import { writeCsv, type ResultTableArtifact } from "./ProjectResultTables";
import { resultDigest, resultPath, type FreshResult } from "./FreshResults";
import { ensureProjectManagedDirectory, managedWriteBitsAllowed, projectLocksDir } from "../features/ProjectStatePaths";

export type LatestResultExport = { schemaVersion: 1; source: "active_query"; observedAt: string;
  jobs: FreshResult["jobs"]; errors: string[]; tables: ResultTableArtifact[]; runtimeDiagnosticsProtocol?: 1 };
export const LATEST_RESULT_FILE = "latest-results.json";
const writers = new Map<string, Promise<unknown>>();

/** macOS (r17-B): O_EXLOCK on a stable empty file inside the CONSUMED project. The kernel drops
 * the lock on close or process death — no stale owner, no recovery record, never unlinked.
 * 0x20 is the NUMERIC macOS open(2) O_EXLOCK; every other bit comes from fs.constants. On other
 * platforms 0x20 is NOT O_EXLOCK — the bit means something else entirely (for reference, Linux
 * O_APPEND is 1024, a different value), so resultLockOpenFlags refuses non-darwin platforms and
 * this path is never executed there — Linux keeps the untouched loopback-TCP coordination below. */
export const MACOS_O_EXLOCK = 0x20;
export function resultCoordinationMode(platform: NodeJS.Platform): "pipe" | "exlock" | "tcp" {
  return platform === "win32" ? "pipe" : platform === "darwin" ? "exlock" : "tcp";
}
export function resultLockFile(realRoot: string, digest: string): string {
  return path.join(projectLocksDir(realRoot, "simple-experiment"), "results", digest + ".lock");
}
export function resultLockOpenFlags(constants: { [key: string]: any }, platform: NodeJS.Platform): number {
  if (platform !== "darwin") throw Error("O_EXLOCK 仅 macOS 可用；其他平台不得执行该数值位。");
  return (constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | MACOS_O_EXLOCK) >>> 0;
}
/** Ownership/hardening checks on the opened lock: ordinary single-hardlink file owned by this
 * uid, path and handle still reference the SAME inode, mode normalized to 0600. */
export function assertResultLockStats(held: { isFile(): boolean; nlink: number; uid: number; ino: number | bigint; dev: number | bigint; mode: number },
  listed: { isFile(): boolean; nlink: number; ino: number | bigint; dev: number | bigint }, getuid?: () => number): boolean {
  if (getuid && held.uid !== getuid()) throw Error("RESULT_LOCK_PATH_UNSAFE：锁文件不属于当前用户。");
  if (!held.isFile() || !listed.isFile() || held.nlink !== 1 || listed.nlink !== 1
    || held.ino !== listed.ino || held.dev !== listed.dev) throw Error("RESULT_LOCK_PATH_UNSAFE：锁文件不是当前路径的普通独占文件。");
  return (held.mode & 0o777) !== 0o600;
}
async function openResultLockHandle(lockFile: string): Promise<{ close(): Promise<void> }> {
  const handle = await fs.open(lockFile, resultLockOpenFlags(fs.constants, process.platform), 0o600);
  try {
    const held = await handle.stat({ bigint: false }), listed = await fs.lstat(lockFile);
    if (assertResultLockStats(held, listed, typeof process.getuid === "function" ? process.getuid : undefined)) await handle.chmod(0o600);
    return { close: () => handle.close() };
  } catch (error) { await handle.close().catch(() => undefined); throw error; }
}
/** EAGAIN/EWOULDBLOCK keeps the existing 50ms/5s bounded wait with per-round cancellation;
 * any other open error propagates as-is — never hidden, never a fallback to the TCP channel. */
export async function acquireResultExlock(deadline: number, current: () => boolean,
  openLocked: () => Promise<{ close(): Promise<void> }>): Promise<{ close(): Promise<void> }> {
  for (;;) {
    if (!current()) throw Error("结果导出已取消或工作区已变化");
    try { return await openLocked(); }
    catch (error: any) {
      if (error?.code !== "EAGAIN" && error?.code !== "EWOULDBLOCK") throw error;
      if (Date.now() >= deadline) throw Error("结果文件正在其他窗口更新，请稍后重试；未读取旧锁记录。");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
/** Bit rule single-sourced in ProjectStatePaths (same platform-aware semantics as the managed
 * project tree); re-exported so this module keeps its stable B-contract API. */
export { managedWriteBitsAllowed } from "../features/ProjectStatePaths";
/** Lock directory must be this user's real directory with no group/other write bit; a foreign
 * or world-writable tree fails closed instead of being silently fixed or bypassed. stat/chmod/
 * getuid are injectable so the SAME rule path is verified on every platform; real POSIX chmod
 * effects remain macOS/Linux native acceptance. */
export async function assertResultLockDirectory(dir: string, deps: {
  lstat?: (p: string) => Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; uid: number; mode: number }>,
  chmod?: (p: string, mode: number) => Promise<void>, getuid?: (() => number) | null, platform?: NodeJS.Platform,
} = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const stat = await (deps.lstat || ((p: string) => fs.lstat(p)))(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("RESULT_LOCK_PATH_UNSAFE：锁目录异常。");
  const getuid = deps.getuid !== undefined ? deps.getuid : (typeof process.getuid === "function" ? process.getuid : undefined);
  if (getuid && stat.uid !== getuid()) throw Error("RESULT_LOCK_PATH_UNSAFE：锁目录不属于当前用户。");
  if (!managedWriteBitsAllowed(stat.mode, platform)) throw Error("RESULT_LOCK_PATH_UNSAFE：锁目录允许组/其他用户写入。");
  if (platform !== "win32" && (stat.mode & 0o777) !== 0o700) await (deps.chmod || ((p: string, m: number) => fs.chmod(p, m)))(dir, 0o700); // only reachable for our own tree (uid + write-bit checks above)
}

/** Kernel-owned, crash-released coordination. No lease JSON, PID, or recovery record.
 * macOS: project-internal O_EXLOCK empty file. Windows: named pipe. Linux: loopback TCP (unchanged). */
async function withResultWriter<T>(root: string, directory: string, current: () => boolean, work: () => Promise<T>): Promise<T> {
  const realRoot = await fs.realpath(root);
  let canonical = path.join(realRoot, resultPath(directory));
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const previous = writers.get(canonical) || Promise.resolve();
  const request = previous.catch(() => undefined).then(async () => {
    const digest = resultDigest(canonical), deadline = Date.now() + 5000;
    if (resultCoordinationMode(process.platform) === "exlock") {
      const lockFile = resultLockFile(realRoot, digest);
      // The WHOLE managed chain (simple_cluster/locks/...) is created segment by segment and
      // each existing segment must be a real directory — a symlinked parent could otherwise
      // drop this project's lock into another project (r17 返修: leaf-only checks are not enough).
      await ensureProjectManagedDirectory(realRoot, path.dirname(lockFile));
      await assertResultLockDirectory(path.dirname(lockFile));
      const held = await acquireResultExlock(deadline, current, () => openResultLockHandle(lockFile));
      // The lock path is a permanent, EMPTY project member: close() releases the kernel lock;
      // there is deliberately no unlink/rename and nothing to recover after a crash.
      try { return await work(); } finally { await held.close(); }
    }
    let server: net.Server;
    for (;;) {
      if (!current()) throw Error("结果导出已取消或工作区已变化");
      server = net.createServer(socket => socket.destroy()); server.unref();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          // Windows uses a named pipe. The portable fallback is local IPC, never an Agent tunnel endpoint.
          const address = process.platform === "win32" ? { path: "\\\\.\\pipe\\simpleex-results-" + digest }
            : { host: "127.0.0.1", port: 49152 + parseInt(digest.slice(0, 4), 16) % 16384, exclusive: true };
          server.listen(address, () => { server.removeListener("error", reject); resolve(); });
        });
        break;
      } catch (error: any) {
        server.close(() => undefined);
        if (error.code !== "EADDRINUSE") throw error;
        if (Date.now() >= deadline) throw Error("结果文件正在其他窗口更新，请稍后重试；未读取旧锁记录。");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try { return await work(); } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  writers.set(canonical, request);
  try { return await request; } finally { if (writers.get(canonical) === request) writers.delete(canonical); }
}

async function safeFile(root: string, directory: string, relative: string) {
  const base = await fs.realpath(root), parts = (resultPath(directory) + "/" + resultPath(relative)).split("/");
  let current = base;
  for (const [index, leaf] of parts.entries()) {
    current = path.join(current, leaf);
    const stat = await fs.lstat(current).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
    if (stat && (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1)))
      throw Error("RESULT_EXPORT_PATH_UNSAFE: " + current);
  }
  return current;
}
export async function readLatestResultExport(root: string, directory: string): Promise<LatestResultExport | undefined> {
  const file = await safeFile(root, directory, LATEST_RESULT_FILE);
  const stat = await fs.stat(file).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!stat) return undefined;
  if (stat.size > 32 * 1024 * 1024) throw Error("RESULT_EXPORT_TOO_LARGE");
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  if (value?.schemaVersion !== 1 || value.source !== "active_query" || !Array.isArray(value.jobs) || !Array.isArray(value.tables)) throw Error("RESULT_EXPORT_INVALID");
  for (const table of value.tables) {
    resultPath(table.relativePath); resultPath(table.markdownPath);
    if (!Array.isArray(table.header) || !Array.isArray(table.rows) || typeof table.markdown !== "string") throw Error("RESULT_EXPORT_INVALID");
  }
  return value;
}
async function writeTables(root: string, directory: string, value: LatestResultExport, current: () => boolean) {
  const entries = value.tables.flatMap(table => [[table.relativePath, writeCsv(table.header, table.rows)], [table.markdownPath, table.markdown]]);
  if (new Set(entries.map(([relative]) => relative)).size !== entries.length) throw Error("RESULT_EXPORT_DUPLICATE_PATH");
  for (let offset = 0; offset < entries.length; offset += 4) {
    const settled = await Promise.allSettled(entries.slice(offset, offset + 4).map(async ([relative, text]) => {
      if (!current()) throw Error("结果导出已取消或工作区已变化");
      const file = await safeFile(root, directory, relative);
      // Read actual bytes, never timestamps: unchanged tables need no durable flush/rename.
      const expected = Buffer.from(text, "utf8");
      const stat = await fs.stat(file).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
      const existing = stat?.size === expected.length ? await fs.readFile(file) : undefined;
      if (existing?.equals(expected)) {
        await safeFile(root, directory, relative);
        if (!current()) throw Error("结果导出已取消或工作区已变化");
        return;
      }
      await atomicWriteText(file, text, { beforeRename: async () => { if (!current()) throw Error("结果导出已取消或工作区已变化"); await safeFile(root, directory, relative); } });
    }));
    // Keep the writer until all concurrent writes have drained, including on error.
    const failed = settled.find(row => row.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
export async function regenerateLatestResultTables(root: string, directory: string, _value: LatestResultExport, current = () => true) {
  return withResultWriter(root, directory, current, async () => {
    const value = await readLatestResultExport(root, directory);
    if (!value) throw Error("最终汇总 JSON 已不存在，请重新查询服务器。");
    await writeTables(root, directory, value, current); return value;
  });
}
export async function publishLatestResult(root: string, directory: string, result: FreshResult, tables: Record<string, ResultTableArtifact>, current = () => true) {
  if (!result.querySucceeded) return false;
  return withResultWriter(root, directory, current, async () => {
  const value: LatestResultExport = { schemaVersion: 1, source: "active_query", observedAt: result.observedAt,
    jobs: result.jobs, errors: result.errors, tables: Object.values(tables), runtimeDiagnosticsProtocol: 1 };
  const file = await safeFile(root, directory, LATEST_RESULT_FILE);
  await atomicWriteText(file, JSON.stringify(value, null, 2) + "\n", { beforeRename: async () => {
    if (!current()) throw Error("结果导出已取消或工作区已变化"); await safeFile(root, directory, LATEST_RESULT_FILE);
  } });
  await writeTables(root, directory, value, current);
  return true;
  });
}

/** The saved export lists its own tables. Neither a directory scan nor an old registry can add rows. */
export async function latestResultCatalog(root: string, directory: string) {
  const value = await readLatestResultExport(root, directory);
  const datasets = new Map<string, any>();
  for (const table of value?.tables || []) {
    let dataset = datasets.get(table.datasetKey);
    if (!dataset) { dataset = { dataset: table.dataset, datasetKey: table.datasetKey, tables: [], plans: [] }; datasets.set(table.datasetKey, dataset); }
    const values: Record<string, string[]> = {};
    table.header.forEach((field, index) => { values[field] = [...new Set(table.rows.map(row => String(row[index] ?? "")))]; });
    dataset.tables.push({ ...table, path: path.posix.join(directory, table.relativePath), markdownPath: path.posix.join(directory, table.markdownPath), values, rowCount: table.rows.length });
    for (const planFile of values.plan_file || []) if (planFile && !dataset.plans.some((plan: any) => plan.planFile === planFile))
      dataset.plans.push({ planFile, planKey: planFile, artifacts: [], assignment: { kind: table.dataset ? "single" : "unassigned", datasets: table.dataset ? [table.dataset] : [], source: "result-record" } });
  }
  const planDatasets = new Map<string, Set<string>>();
  for (const dataset of datasets.values()) for (const plan of dataset.plans) {
    if (!planDatasets.has(plan.planFile)) planDatasets.set(plan.planFile, new Set());
    if (dataset.dataset) planDatasets.get(plan.planFile)!.add(dataset.dataset);
  }
  for (const dataset of datasets.values()) for (const plan of dataset.plans) {
    const names = [...planDatasets.get(plan.planFile)!];
    if (names.length > 1) plan.assignment = { kind: "multiple", datasets: names, source: "result-record" };
  }
  return { datasets: [...datasets.values()], legacyTables: [], unassignedPlans: [...datasets.values()].filter(row => !row.dataset).flatMap(row => row.plans),
    multiDatasetPlans: [...planDatasets].filter(([, names]) => names.size > 1).map(([planFile, names]) => ({ planFile, datasets: [...names] })),
    mappingConflicts: [], autoRecoverableCount: 0, observedAt: value?.observedAt, source: "local_export" };
}
