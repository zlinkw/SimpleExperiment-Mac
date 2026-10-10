import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

type Approval = { root: string; relative: string; fullPath: string; token: string; sha256: string;
  confirm: boolean; secondConfirmation: boolean; confirmedAbsolutePath: string };

function identity(relative: string, stat: any): string {
  return createHash("sha256").update(`${relative}|${stat.dev}|${stat.ino}|${stat.size}|${stat.mtimeNs}|${stat.nlink}`).digest("hex");
}

export function fingerprintCacheFile(file: string, relative: string, disk: any = fs): { token: string; sha256: string } {
  const descriptor = disk.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = disk.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error("TARGET_CHANGED");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let count;
    while ((count = disk.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    const after = disk.fstatSync(descriptor, { bigint: true });
    if (identity(relative, after) !== identity(relative, before)) throw new Error("TARGET_CHANGED");
    return { token: identity(relative, before), sha256: hash.digest("hex") };
  } finally { disk.closeSync(descriptor); }
}

// Called only by the isolated Mac child after the panel's two exact-path confirmations.
export function deleteApprovedCacheFile(approval: Approval, disk: any = fs, host: any = process): void {
  const parts = typeof approval.relative === "string" ? approval.relative.split("/") : [];
  if (!parts.length || parts.some(part => !part || [".", ".."].includes(part) || /[\\\x00-\x1f\x7f]/.test(part))
    || !(parts[0] === "tmp" && parts.length >= 2 || parts[0] === "simple_cluster" && parts[1] === "tmp" && parts.length >= 3)) throw new Error("TARGET_CHANGED");
  const root = approval.root, full = path.posix.join(root, ...parts), parent = path.posix.dirname(full), leaf = path.posix.basename(full);
  if (!path.posix.isAbsolute(root) || root === "/" || path.posix.normalize(root) !== root || full !== approval.fullPath
    || approval.confirm !== true || approval.secondConfirmation !== true || approval.confirmedAbsolutePath !== full) throw new Error("CONFIRM_REQUIRED");
  const relativeParent = path.posix.relative(root, parent);
  if (!relativeParent || relativeParent === ".." || relativeParent.startsWith("../") || path.posix.isAbsolute(relativeParent)) throw new Error("PARENT_CD_FAILED");
  const verifyParent = () => {
    try {
      const rootInfo = disk.lstatSync(root), parentInfo = disk.lstatSync(parent);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()
        || rootInfo.dev !== parentInfo.dev || disk.realpathSync(root) !== root || disk.realpathSync(parent) !== parent) throw new Error("PARENT_CD_FAILED");
    } catch { throw new Error("PARENT_CD_FAILED"); }
  };
  verifyParent();
  try { host.chdir(parent); if (host.cwd() !== parent || disk.realpathSync(".") !== parent) throw new Error("PARENT_CD_FAILED"); }
  catch { throw new Error("PARENT_CD_FAILED"); }
  verifyParent();
  const target = "./" + leaf;
  const before = disk.lstatSync(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.dev !== BigInt(disk.lstatSync(root).dev)
    || Number(before.mtimeMs) > Date.now() - 7 * 86400000 || identity(approval.relative, before) !== approval.token) throw new Error("TARGET_CHANGED");
  const fingerprint = fingerprintCacheFile(target, approval.relative, disk);
  if (fingerprint.token !== approval.token || fingerprint.sha256 !== approval.sha256) throw new Error("TARGET_CHANGED");
  verifyParent();
  if (host.cwd() !== parent || disk.realpathSync(".") !== parent || identity(approval.relative, disk.lstatSync(target, { bigint: true })) !== approval.token) throw new Error("TARGET_CHANGED");
  disk.unlinkSync(target);
  try { disk.lstatSync(target); } catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error("TARGET_STILL_PRESENT");
}

if (require.main === module) {
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Unsupported Mac cleanup host");
    deleteApprovedCacheFile(JSON.parse(process.argv[2]));
  } catch (error: any) { process.stderr.write(String(error.message) + "\n"); process.exitCode = 1; }
}
