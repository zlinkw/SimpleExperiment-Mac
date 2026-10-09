import path from "path";

type InventoryEntry = { sha256?: string };

export function collectDistributedJobArtifacts(outputDir: string, inventory: Record<string, InventoryEntry>, requireLog = true): Record<string, string> {
  const prefix = `${outputDir}/`;
  const artifacts: Record<string, string> = {};
  for (const [file, entry] of Object.entries(inventory)) {
    if (!file.startsWith(prefix) || /(?:\.lock|\.pid|\.exit_code)$/i.test(path.posix.basename(file))) continue;
    const hash = String(entry?.sha256 || "").toLowerCase();
    if (/^[a-f0-9]{64}$/.test(hash)) artifacts[file] = hash;
  }
  if (requireLog && !Object.keys(artifacts).some((file) => /\.log$/i.test(file)))
    throw new Error(`job 产物目录缺少独立运行日志：${outputDir}`);
  return artifacts;
}
