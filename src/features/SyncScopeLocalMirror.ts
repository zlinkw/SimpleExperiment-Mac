import { safeSyncPath } from "./SyncResolution";

type FileHash = { sha256: string };
const MAX_REVIEWED_STALE_FILES = 2_000;

export async function mirrorChosenWorkerVersionToLocal(
  relative: string,
  directory: boolean,
  source: Record<string, FileHash>,
  transfer: () => Promise<void>,
  inventory: () => Promise<Record<string, FileHash>>,
  remove: (relative: string) => Promise<void>,
  report: (stage: string) => void = () => {},
  expectedFiles?: string[],
  authorizeStaleRemoval?: (files: string[]) => Promise<void>,
): Promise<void> {
  safeSyncPath(relative);
  const expected = directory ? source : expectedFiles?.length
    ? Object.fromEntries(expectedFiles.map((file) => [file, source[file]]))
    : { [relative]: source[relative] };
  if (!directory && !source[relative]?.sha256) throw new Error("来源文件缺少 SHA256。");
  for (const [file, info] of Object.entries(expected)) {
    safeSyncPath(file);
    if (!info?.sha256 || directory && !file.startsWith(`${relative}/`)) throw new Error(`来源清单路径或 SHA256 无效：${file}`);
  }
  const reviewedStale = new Map<string, string>();
  if (directory) {
    const before = await inventory();
    const stale = Object.keys(before).filter((file) => !expected[file]).sort();
    if (stale.length) {
      if (stale.length > MAX_REVIEWED_STALE_FILES) throw new Error(`本机旧文件有 ${stale.length} 个，超过逐路径审核上限 ${MAX_REVIEWED_STALE_FILES}；请缩小同步目录范围。`);
      if (!authorizeStaleRemoval) throw new Error("目标目录含来源不存在的旧文件；缺少逐路径删除确认，已停止同步。");
      for (const file of stale) {
        safeSyncPath(file);
        if (!file.startsWith(`${relative}/`) || !before[file]?.sha256) throw new Error(`本机旧文件身份无法审核：${file}`);
      }
      await authorizeStaleRemoval(stale);
      stale.forEach((file) => reviewedStale.set(file, before[file].sha256.toLowerCase()));
    }
  }
  await transfer();
  let actual = await inventory();
  for (const [file, info] of Object.entries(expected))
    if (actual[file]?.sha256?.toLowerCase() !== info.sha256.toLowerCase()) throw new Error(`本机 ${file} SHA256 校验不一致；保留待同步状态。`);
  if (directory) {
    const stale = Object.keys(actual).filter((file) => !expected[file]);
    const unreviewed = stale.filter((file) => !reviewedStale.has(file));
    if (unreviewed.length) throw new Error(`同步期间出现未审核的本机旧文件；未删除：${unreviewed.slice(0, 20).join("、")}`);
    const changed = stale.filter((file) => reviewedStale.get(file) !== actual[file]?.sha256?.toLowerCase());
    if (changed.length) throw new Error(`本机已审核旧文件在同步期间发生变化；未删除：${changed.slice(0, 20).join("、")}`);
    const remainingReviewed = [...reviewedStale.keys()].filter((file) => stale.includes(file));
    for (const [index, file] of remainingReviewed.entries()) {
      safeSyncPath(file);
      if (!file.startsWith(`${relative}/`)) throw new Error(`本机旧文件超出所选目录：${file}`);
      report(`正在清理本机旧文件 ${index + 1}/${stale.length}：${file}`);
      await remove(file);
    }
    actual = await inventory();
    const signature = (files: Record<string, FileHash>) => JSON.stringify(Object.entries(files).map(([file, info]) => [file, info.sha256.toLowerCase()]).sort());
    if (signature(actual) !== signature(expected)) throw new Error("本机目录内容校验不一致；保留待同步状态。");
  }
}
