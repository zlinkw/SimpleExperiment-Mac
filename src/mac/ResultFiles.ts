import * as fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { normalizePosixRelativePath } from "./PosixPath";

type Binding = { full: string; stat: Stats; chain: Array<{ full: string; dev: number; ino: number }> };
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const sameContents = (a: Stats, b: Stats) => sameFile(a, b) && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function bind(root: string, relative: string): Promise<Binding | undefined> {
  const parts = normalizePosixRelativePath(relative, "Mac 结果读取路径").split("/");
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Mac 结果工作区必须是普通目录。");
  let current = await fs.realpath(root);
  const chain = [{ full: current, dev: rootStat.dev, ino: rootStat.ino }];
  let stat = rootStat;
  for (const [index, part] of parts.entries()) {
    const names = await fs.readdir(current), next = path.join(current, part);
    const info = await fs.lstat(next).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) return undefined;
    if (!names.includes(part)) throw new Error("Mac 结果路径拼写与已有磁盘条目不一致：" + relative);
    if (info.isSymbolicLink()) throw new Error("Mac 结果读取路径包含符号链接：" + relative);
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
      throw new Error("Mac 结果读取路径文件类型不符：" + relative);
    const real = await fs.realpath(next), within = path.relative(chain[0].full, real);
    if (within === ".." || within.startsWith(".." + path.sep) || path.isAbsolute(within))
      throw new Error("Mac 结果读取路径超出工作区：" + relative);
    current = real; stat = info; chain.push({ full: real, dev: info.dev, ino: info.ino });
  }
  return { full: current, stat, chain };
}

/** The callback reads the checked descriptor. Its result is used only after rechecking every directory and the file. */
export async function withMacResultFile<T>(root: string, relative: string, maxBytes: number,
  read: (handle: fs.FileHandle) => Promise<T>, expectedBytes?: number): Promise<T | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024
    || expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes))
    throw new Error("Mac 结果读取预算无效。");
  const before = await bind(root, relative);
  if (!before || expectedBytes !== undefined && before.stat.size !== expectedBytes) return undefined;
  if (before.stat.size > maxBytes) throw new Error("Mac 结果文件超过读取上限：" + relative);
  const handle = await fs.open(before.full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameContents(before.stat, opened)) throw new Error("Mac 结果文件身份在打开时变化：" + relative);
    const result = await read(handle), after = await handle.stat(), current = await bind(root, relative);
    if (!sameContents(opened, after) || !current || !sameContents(after, current.stat)
      || before.chain.length !== current.chain.length || before.chain.some((item, index) => {
        const next = current.chain[index]; return item.full !== next.full || item.dev !== next.dev || item.ino !== next.ino;
      })) throw new Error("Mac 结果工作区、目录或文件在读取期间变化：" + relative);
    return result;
  } finally { await handle.close(); }
}

export async function readMacResultSnapshot(root: string, relative: string, maxBytes: number, expectedBytes?: number) {
  return withMacResultFile(root, relative, maxBytes, async handle => {
    const buffer = Buffer.alloc((expectedBytes ?? maxBytes) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > maxBytes || expectedBytes !== undefined && length !== expectedBytes)
      throw new Error("Mac 结果内容在读取期间超出预算或改变大小：" + relative);
    return { bytes: buffer.subarray(0, length), mtimeMs: (await handle.stat()).mtimeMs };
  }, expectedBytes);
}

export async function readMacResultBytes(root: string, relative: string, maxBytes: number, expectedBytes?: number) {
  return (await readMacResultSnapshot(root, relative, maxBytes, expectedBytes))?.bytes;
}

export async function hashMacResultFile(root: string, relative: string, maxBytes: number) {
  return withMacResultFile(root, relative, maxBytes, async handle => {
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let length = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
      if (length > maxBytes) throw new Error("Mac 结果内容超过 hash 核验上限：" + relative);
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    return hash.digest("hex");
  });
}
