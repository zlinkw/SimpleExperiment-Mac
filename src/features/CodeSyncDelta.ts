export type HashedFile = { sha256?: string; size?: number };

export function inventoryFilesByPath(inventory: { files?: Record<string, HashedFile> | Array<{ path?: string; relativePath?: string; sha256?: string; size?: number }> } | null | undefined): Record<string, HashedFile> {
  const files = inventory?.files;
  if (!files || typeof files !== "object") throw new Error("远端项目清单未返回文件哈希。");
  if (!Array.isArray(files)) return files;
  const mapped: Record<string, HashedFile> = {};
  for (const row of files) {
    const key = String(row?.path || row?.relativePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (key) mapped[key] = { sha256: row.sha256, size: row.size };
  }
  return mapped;
}

export function changedManifestFiles(local: Record<string, HashedFile>, remote: Record<string, HashedFile> = {}): Record<string, HashedFile> {
  const changed: Record<string, HashedFile> = {};
  for (const [file, info] of Object.entries(local || {})) {
    const localHash = String(info?.sha256 || "").toLowerCase();
    const remoteHash = String(remote?.[file]?.sha256 || "").toLowerCase();
    if (!localHash || localHash !== remoteHash) changed[file] = info;
  }
  return changed;
}
