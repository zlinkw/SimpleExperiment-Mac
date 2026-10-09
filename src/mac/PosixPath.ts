import * as path from "node:path";

export function normalizePosixAbsolutePath(value: unknown, label = "路径", allowRoot = false): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")
    || /[\x00-\x1f\x7f\\]/.test(value) || value.split("/").some(part => part === "." || part === "..")) {
    throw new Error(`${label} 必须是无 . 或 ..、反斜杠或控制字符的单根绝对 POSIX 路径。`);
  }
  const normalized = path.posix.normalize(value).replace(/\/+$/, "") || "/";
  if (!allowRoot && normalized === "/") throw new Error(`${label} 不能使用根目录。`);
  return normalized;
}

export function posixProjectName(value: unknown): string {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f/\\]/.test(value) || value === "." || value === "..")
    throw new Error("项目名称必须是单个有效 POSIX 文件夹名称。");
  return value;
}
