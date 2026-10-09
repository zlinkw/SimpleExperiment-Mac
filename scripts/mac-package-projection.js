"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const MAX_FILES = 8192, MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
function relativePath(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || /[\\:\x00-\x1f\x7f]/.test(value)
    || value.split("/").some(part => !part || part === "." || part === "..")
    || /^(?:\.git|node_modules|release-artifacts)(?:\/|$)/.test(value)) throw new Error("Unsafe package source path");
  return value;
}
function ordinaryDirectory(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Package directory identity is unsafe");
  return stat;
}
function trackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, timeout: 8000, windowsHide: true });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr?.toString("utf8") || "Cannot list package sources");
  return new TextDecoder("utf8", { fatal: true }).decode(result.stdout).split("\0").filter(Boolean);
}
function sourceFiles(root, tracked) {
  const files = new Set(tracked.map(relativePath));
  function walk(relative) {
    const directory = path.join(root, ...relative.split("/"));
    ordinaryDirectory(directory);
    for (const name of fs.readdirSync(directory)) {
      const child = relativePath(relative + "/" + name), stat = fs.lstatSync(path.join(root, ...child.split("/")));
      if (stat.isSymbolicLink()) throw new Error("Package runtime contains a link");
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) files.add(child);
      else throw new Error("Package runtime contains a special file");
      if (files.size > MAX_FILES) throw new Error("Package source file budget exceeded");
    }
  }
  if (fs.existsSync(path.join(root, "dist"))) walk("dist");
  if (files.size > MAX_FILES) throw new Error("Package source file budget exceeded");
  return [...files].sort();
}
function snapshotFiles(root) {
  const files = [];
  function walk(directory, relative) {
    ordinaryDirectory(directory);
    for (const name of fs.readdirSync(directory)) {
      const child = relativePath(relative ? relative + "/" + name : name), file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Package snapshot contains a link");
      if (stat.isDirectory()) walk(file, child);
      else if (stat.isFile()) files.push(child);
      else throw new Error("Package snapshot contains a special file");
      if (files.length > MAX_FILES) throw new Error("Package snapshot file budget exceeded");
    }
  }
  walk(root, "");
  return files.sort();
}
function checkedBytes(root, relative, directories) {
  let current = root;
  for (const part of relative.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const stat = ordinaryDirectory(current), previous = directories.get(current);
    const key = `${stat.dev}:${stat.ino}`;
    if (previous && previous !== key) throw new Error("Package source directory changed");
    directories.set(current, key);
  }
  const file = path.join(root, ...relative.split("/")), before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) throw new Error("Package source file identity or budget is unsafe");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || identity(opened) !== identity(before)) throw new Error("Package source changed before read");
    const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== before.size || identity(fs.fstatSync(fd)) !== identity(before)
      || identity(fs.lstatSync(file)) !== identity(before)) throw new Error("Package source changed during read");
    return { bytes: buffer.subarray(0, offset), identity: identity(before) };
  } finally { fs.closeSync(fd); }
}

/** Retained source/build snapshot. VSCE's own rules still determine the package;
 * large ignored evidence trees and machine state are never traversed or copied.
 */
function createPackageProjection(sourceRoot, options = {}) {
  const root = path.resolve(sourceRoot), rootStat = ordinaryDirectory(root);
  const tracked = options.trackedFiles || trackedFiles(root), files = sourceFiles(root, tracked);
  if (!files.includes("package.json") || !files.includes(".vscodeignore")) throw new Error("Package source manifest or ignore policy is absent");
  let parent = root;
  for (const name of ["release-artifacts", "package-sources"]) {
    parent = path.join(parent, name);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent);
    ordinaryDirectory(parent);
  }
  const directory = path.join(parent, crypto.randomUUID()); fs.mkdirSync(directory);
  const directories = new Map([[root, `${rootStat.dev}:${rootStat.ino}`]]), records = [];
  let total = 0;
  for (const relative of files) {
    const source = checkedBytes(root, relative, directories); total += source.bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Package source byte budget exceeded");
    const target = path.join(directory, ...relative.split("/")); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source.bytes, { flag: "wx" });
    records.push({ relative, size: source.bytes.length, sha256: hash(source.bytes), identity: source.identity });
  }
  const snapshotStat = ordinaryDirectory(directory);
  const projection = { root, directory, records, directories, tracked: options.trackedFiles, total,
    snapshotIdentity: `${snapshotStat.dev}:${snapshotStat.ino}` };
  assertPackageProjection(projection);
  fs.writeFileSync(directory + ".binding.json", JSON.stringify({ capturedAt: new Date().toISOString(), root, directory, total, records }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  return projection;
}
function assertPackageProjection(projection) {
  for (const [directory, expected] of projection.directories) {
    const stat = ordinaryDirectory(directory);
    if (`${stat.dev}:${stat.ino}` !== expected) throw new Error("Package source directory changed");
  }
  const names = sourceFiles(projection.root, projection.tracked || trackedFiles(projection.root));
  if (JSON.stringify(names) !== JSON.stringify(projection.records.map(record => record.relative))) throw new Error("Package source file set changed");
  const snapshotStat = ordinaryDirectory(projection.directory);
  if (`${snapshotStat.dev}:${snapshotStat.ino}` !== projection.snapshotIdentity
    || JSON.stringify(snapshotFiles(projection.directory)) !== JSON.stringify(names)) throw new Error("Package snapshot identity or file set changed");
  const snapshotDirectories = new Map();
  for (const record of projection.records) {
    const source = checkedBytes(projection.root, record.relative, projection.directories);
    const snapshot = checkedBytes(projection.directory, record.relative, snapshotDirectories);
    if (source.identity !== record.identity || source.bytes.length !== record.size || hash(source.bytes) !== record.sha256
      || !snapshot.bytes.equals(source.bytes)) throw new Error("Package source or snapshot bytes changed");
  }
  return true;
}
module.exports = { createPackageProjection, assertPackageProjection };
