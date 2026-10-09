import type { ScopeEntry } from "./SyncScopeTree";

/** SimpleSFTP sync.serverToServerFpsync rejects more than 5000 relative paths per call. */
export const SYNC_SCOPE_FPSYNC_PATH_LIMIT = 5000;
export const SYNC_SCOPE_BATCH_BYTE_LIMIT = 128 * 1024 * 1024;
/** Keep projectInventory scopePaths inside one SSH command. */
export const SYNC_SCOPE_INVENTORY_PATH_LIMIT = 48;
export const SYNC_SCOPE_INVENTORY_ARG_LIMIT = 6000;

export type SyncScopeWorkItem = ScopeEntry & { endpointId?: string };

export type SyncScopeFileRecord = { sha256: string; size?: number };

export type SyncScopeTransferGroup = {
  kind: "files";
  files: string[];
  directories: string[];
  manifest: Record<string, { size?: number; sha256: string }>;
  sourceSnapshot: string;
  expectedByPath: Record<string, string>;
  batch: number;
  batchCount: number;
};

export type SyncScopeTransferPlan = {
  groups: SyncScopeTransferGroup[];
  /** Destination directories that must be removed before the aggregated file archive. */
  directoryDeletes: string[];
  files: Record<string, SyncScopeFileRecord>;
};

function snapshotOf(files: Array<[string, string]>): string {
  return JSON.stringify([...files].sort((a, b) => a[0].localeCompare(b[0])));
}

function recordHash(info: SyncScopeFileRecord | undefined, pathName: string): string {
  const hash = String(info?.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`来源文件不存在或尚未完成 SHA256 校验：${pathName}`);
  return hash;
}

/** Split a file list into bounded fpsync batches. A single file is never split. */
export function partitionSyncScopeTransferPaths(files: string[], limit = SYNC_SCOPE_FPSYNC_PATH_LIMIT): string[][] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("批量传输上限无效。");
  const groups: string[][] = [];
  for (let offset = 0; offset < files.length; offset += limit) groups.push(files.slice(offset, offset + limit));
  return groups;
}

/** Unknown or oversized files stay alone; the transport streams those files. */
function partitionTransferFiles(files: Record<string, SyncScopeFileRecord>, pathLimit: number): string[][] {
  if (!Number.isInteger(pathLimit) || pathLimit < 1) throw new Error("批量传输上限无效。");
  const groups: string[][] = [];
  let group: string[] = [], bytes = 0;
  const flush = () => { if (group.length) groups.push(group); group = []; bytes = 0; };
  for (const file of Object.keys(files).sort()) {
    const size = files[file].size;
    if (!Number.isSafeInteger(size) || Number(size) < 0 || Number(size) > SYNC_SCOPE_BATCH_BYTE_LIMIT) {
      flush(); groups.push([file]); continue;
    }
    if (group.length >= pathLimit || bytes + Number(size) > SYNC_SCOPE_BATCH_BYTE_LIMIT) flush();
    group.push(file); bytes += Number(size);
  }
  flush();
  return groups;
}

function fileInSelection(file: string, itemPath: string, directory: boolean): boolean {
  return directory ? file.startsWith(`${itemPath}/`) : file === itemPath;
}

function commonInventoryDirectory(paths: string[]): string {
  if (paths.length < 2) return "";
  const parts = paths.map((item) => item.split("/"));
  const shared: string[] = [];
  for (let index = 0; ; index += 1) {
    const part = parts[0][index];
    if (!part || parts.some((row) => row[index] !== part || row.length === index + 1)) break;
    shared.push(part);
  }
  return shared.join("/");
}

function parentOf(relative: string): string {
  const index = relative.lastIndexOf("/");
  return index < 0 ? "" : relative.slice(0, index);
}

function dedupeCoveredPaths(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return unique.filter((item, index) => !unique.slice(0, index).some((ancestor) => item === ancestor || item.startsWith(`${ancestor}/`)));
}

function inventoryArgLength(paths: string[]): number {
  return JSON.stringify(paths).length;
}

function inventoryTooLarge(paths: string[], maxPaths: number, maxArgLength: number): boolean {
  return paths.length > maxPaths || inventoryArgLength(paths) > maxArgLength;
}

/**
 * Small selections stay on the confirmed file or directory.
 * Larger selections fold siblings into their common directory until the SSH argument fits.
 * A single deep file is never widened to an ancestor.
 */
export function compressSyncScopeInventoryPaths(
  paths: string[],
  options: { maxPaths?: number; maxArgLength?: number } = {},
): string[] {
  const maxPaths = options.maxPaths ?? SYNC_SCOPE_INVENTORY_PATH_LIMIT;
  const maxArgLength = options.maxArgLength ?? SYNC_SCOPE_INVENTORY_ARG_LIMIT;
  if (!Number.isInteger(maxPaths) || maxPaths < 1 || !Number.isInteger(maxArgLength) || maxArgLength < 2) throw new Error("清单范围上限无效。");
  let current = dedupeCoveredPaths(paths);
  while (inventoryTooLarge(current, maxPaths, maxArgLength)) {
    const grouped = new Map<string, string[]>();
    for (const item of current) {
      const parent = parentOf(item);
      if (!parent) continue;
      grouped.set(parent, [...(grouped.get(parent) || []), item]);
    }
    const merge = [...grouped.entries()].filter(([, children]) => children.length >= 2)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
    if (!merge) {
      const common = commonInventoryDirectory(current);
      if (!common) break;
      current = [common];
      continue;
    }
    const [parent, children] = merge;
    current = dedupeCoveredPaths(current.filter((item) => !children.includes(item)).concat(parent));
  }
  return current.sort((a, b) => a.localeCompare(b));
}

/** Split a still-too-long scope list into SSH-sized inventory calls. */
export function batchSyncScopeInventoryPaths(
  paths: string[],
  options: { maxPaths?: number; maxArgLength?: number } = {},
): string[][] {
  const maxPaths = options.maxPaths ?? SYNC_SCOPE_INVENTORY_PATH_LIMIT;
  const maxArgLength = options.maxArgLength ?? SYNC_SCOPE_INVENTORY_ARG_LIMIT;
  const compressed = compressSyncScopeInventoryPaths(paths, options);
  if (!inventoryTooLarge(compressed, maxPaths, maxArgLength)) return [compressed];
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const item of compressed) {
    const next = [...batch, item];
    if (batch.length && inventoryTooLarge(next, maxPaths, maxArgLength)) {
      batches.push(batch);
      batch = [item];
    } else batch = next;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Keep only files inside the confirmed selection.
 * A shared inventory may contain siblings; those siblings stay out of the archive.
 */
export function selectConfirmedScopeFiles(
  files: Record<string, SyncScopeFileRecord | undefined>,
  items: SyncScopeWorkItem[],
): { files: Record<string, SyncScopeFileRecord>; directoryDeletes: string[] } {
  const selected: Record<string, SyncScopeFileRecord> = {};
  const directoryDeletes: string[] = [];
  for (const item of items) {
    if (item.directory) {
      directoryDeletes.push(item.path);
      const children = Object.keys(files).filter((file) => fileInSelection(file, item.path, true)).sort();
      if (!children.length) throw new Error(`来源目录没有可同步文件：${item.path}`);
      for (const file of children) selected[file] = { sha256: recordHash(files[file], file), size: files[file]?.size };
    } else {
      selected[item.path] = { sha256: recordHash(files[item.path], item.path), size: files[item.path]?.size };
    }
  }
  if (!Object.keys(selected).length) throw new Error("所选范围内没有可同步的文件。");
  return { files: selected, directoryDeletes: [...new Set(directoryDeletes)].sort() };
}

/**
 * Directories and loose files share archives bounded by path count and bytes.
 * Directory replacement stays a separate confirmed delete list; it is not one transfer per directory.
 */
export function planSyncScopeTransferGroups(
  items: SyncScopeWorkItem[],
  files: Record<string, SyncScopeFileRecord | undefined>,
  pathLimit = SYNC_SCOPE_FPSYNC_PATH_LIMIT,
): SyncScopeTransferPlan {
  const selected = selectConfirmedScopeFiles(files, items);
  const slices = partitionTransferFiles(selected.files, pathLimit);
  const groups = slices.map((paths, index) => {
    const rows = paths.map((file) => [file, selected.files[file].sha256] as [string, string]);
    return {
      kind: "files" as const,
      files: paths,
      directories: selected.directoryDeletes.filter((directory) => paths.some((file) => file.startsWith(`${directory}/`))),
      manifest: Object.fromEntries(paths.map((file) => [file, { size: selected.files[file].size, sha256: selected.files[file].sha256 }])),
      sourceSnapshot: snapshotOf(rows),
      expectedByPath: Object.fromEntries(rows),
      batch: index + 1,
      batchCount: slices.length,
    };
  });
  return { groups, directoryDeletes: selected.directoryDeletes, files: selected.files };
}

export function scopeInventorySnapshot(files: Record<string, SyncScopeFileRecord | undefined>, paths: string[]): string {
  return snapshotOf(paths.map((file) => [file, String(files[file]?.sha256 || "").toLowerCase()]));
}
