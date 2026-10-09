import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePosixAbsolutePath, normalizePosixRelativePath } from "./PosixPath";

export function isYamlPlanPath(value: string): boolean {
  // A trailing space belongs to the name. Trim only for extension classification.
  return /\.ya?ml$/i.test(value.trimEnd());
}

function workspace(root: string) {
  normalizePosixAbsolutePath(root, "Mac Plan 工作区");
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error("Mac Plan 工作区必须是现有目录。");
  return { canonical: fs.realpathSync(root), dev: stat.dev, ino: stat.ino };
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function checkComponents(root: string, relative: string, directory: boolean, existing: boolean): string {
  const parts = normalizePosixRelativePath(relative, "Mac Plan 路径").split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    const names = fs.readdirSync(current);
    const next = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(next); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing) throw error;
      return path.join(current, ...parts.slice(index));
    }
    // Reject aliases even on a case-insensitive or Unicode-normalizing volume.
    if (!names.includes(part)) throw new Error("Mac Plan 路径拼写与实际目录条目不一致：" + relative);
    if (stat.isSymbolicLink()) throw new Error("Mac Plan 路径不能包含符号链接：" + relative);
    const mustBeDirectory = directory || index < parts.length - 1;
    if (mustBeDirectory ? !stat.isDirectory() : !stat.isFile()) throw new Error("Mac Plan 路径文件类型不符：" + relative);
    current = next;
  }
  return current;
}

export function macPlanDirectory(root: string, planDir: string): string {
  workspace(root);
  return checkComponents(root, planDir, true, false);
}

export function macPlanFile(root: string, file: string, planDir: string, existing = false): string {
  workspace(root);
  const directory = normalizePosixRelativePath(planDir, "Mac Plan 目录");
  const relative = file.startsWith("/") ? path.relative(root, normalizePosixAbsolutePath(file, "Mac Plan 文件")) : file;
  normalizePosixRelativePath(relative, "Mac Plan 文件");
  if (!relative.startsWith(directory + "/") || !isYamlPlanPath(relative))
    throw new Error("只能访问当前实验计划目录下的 YAML Plan。");
  return checkComponents(root, relative, false, existing);
}

export async function readMacPlanPreview(root: string, file: string, planDir: string, maxBytes: number) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("Mac Plan 读取预算无效。");
  const binding = workspace(root), fullPath = macPlanFile(root, file, planDir, true);
  const expected = fs.lstatSync(fullPath);
  const handle = await fs.promises.open(fullPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !sameFile(expected, stat)) throw new Error("Mac Plan 文件身份已变化，未读取。");
    const buffer = Buffer.alloc(maxBytes), result = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (!sameFile(stat, after) || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
      throw new Error("Mac Plan 内容在读取期间变化，未使用读取结果。");
    const currentRoot = workspace(root);
    const currentFile = fs.lstatSync(fullPath);
    if (binding.canonical !== currentRoot.canonical || binding.dev !== currentRoot.dev || binding.ino !== currentRoot.ino
      || macPlanFile(root, file, planDir, true) !== fullPath || !sameFile(after, currentFile)
      || after.size !== currentFile.size || after.mtimeMs !== currentFile.mtimeMs || after.ctimeMs !== currentFile.ctimeMs)
      throw new Error("Mac Plan 工作区或文件身份已变化，未使用读取结果。");
    return { text: buffer.subarray(0, result.bytesRead).toString("utf8"), stat, fullPath };
  } finally { await handle.close(); }
}
