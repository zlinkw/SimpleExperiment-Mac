export function normalizeRemotePath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

export function safeRemoteProjectChild(projectDir: string, child: string): string {
  const root = normalizeRemotePath(projectDir);
  const full = normalizeRemotePath(child.startsWith("/") ? child : `${root}/${child}`);
  if (!root || root === "/" || root === "~") throw new Error("invalid projectDir");
  if (full !== root && !full.startsWith(`${root}/`)) throw new Error(`remote path escapes projectDir: ${child}`);
  if (["/", "/home", "/data", "/mnt", "work_dirs", "simple_cluster"].includes(full)) throw new Error(`unsafe remote path: ${full}`);
  return full;
}

export function isSafeRuntimePath(projectDir: string, remotePath: string): boolean {
  try {
    const full = safeRemoteProjectChild(projectDir, remotePath);
    return /\/simple_cluster\/runtime\/[^/]+$/.test(full) || /\/simple_cluster\/runtime\/backups\/[^/]+\/[^/]+$/.test(full);
  } catch {
    return false;
  }
}
