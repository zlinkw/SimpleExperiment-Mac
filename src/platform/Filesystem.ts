import path from "node:path";

/** Native filesystem syntax only; workspace mapping rules remain in the shared mapper. */
export const hostPathApi = path.posix;
export function normalizeHostAbsolutePath(value: unknown, label: string): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(raw)
    || raw.split("/").some(part => part === "." || part === "..")) throw new Error(`${label} 必须是无越界路径段的 POSIX 绝对路径。`);
  return path.posix.normalize(raw);
}
