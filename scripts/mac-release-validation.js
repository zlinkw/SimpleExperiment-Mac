"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const identity = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
function safeRelative(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || /[\\:\x00-\x1f]/.test(value)
    || value.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Unsafe validation evidence path");
  return value;
}
function readBound(root, relative) {
  safeRelative(relative);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Validation root is not ordinary");
  let parent = root;
  for (const segment of relative.split("/").slice(0, -1)) {
    parent = path.join(parent, segment);
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Validation directory is not ordinary");
  }
  const file = path.join(root, ...relative.split("/")), before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 32 * 1024 * 1024) throw new Error("Validation file identity or budget is unsafe");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (identity(fs.fstatSync(fd)) !== identity(before)) throw new Error("Validation file changed before read");
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    if (offset !== before.size || identity(fs.fstatSync(fd)) !== identity(before) || identity(fs.lstatSync(file)) !== identity(before)) throw new Error("Validation file changed during read");
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
function captureValidationInputs(roots) {
  const records = [];
  for (const component of ["experiment", "sftp"]) {
    const root = path.resolve(roots[component]), stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Validation root is not ordinary");
    const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, timeout: 8000, windowsHide: true });
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr?.toString() || "Validation Git inventory failed");
    const names = new Set(new TextDecoder("utf8", { fatal: true }).decode(result.stdout).split("\0").filter(Boolean).map(safeRelative));
    function walk(relative) {
      const full = path.join(root, relative), info = fs.lstatSync(full);
      if (info.isSymbolicLink()) throw new Error("Validation build contains a link");
      if (info.isDirectory()) for (const name of fs.readdirSync(full)) walk(relative + "/" + name);
      else if (info.isFile()) names.add(safeRelative(relative));
      else throw new Error("Validation build contains a special file");
      if (names.size > 8192) throw new Error("Validation input file budget exceeded");
    }
    if (fs.existsSync(path.join(root, "dist"))) walk("dist");
    else if (component === "experiment") throw new Error("Validation build is absent");
    let total = 0;
    for (const file of [...names].sort()) {
      const bytes = readBound(root, file); total += bytes.length;
      if (total > 256 * 1024 * 1024) throw new Error("Validation input byte budget exceeded");
      records.push({ component, file, size: bytes.length, sha256: hash(bytes) });
    }
  }
  return { digest: hash(Buffer.from(JSON.stringify(records))), records };
}
function testCounts(stdout) {
  const counts = {};
  for (const field of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const matches = [...String(stdout).matchAll(new RegExp("^(?:#|ℹ) " + field + " (\\d+)\\s*$", "gm"))];
    if (matches.length !== 1) throw new Error("Missing or ambiguous test summary: " + field);
    counts[field] = Number(matches[0][1]);
  }
  if (!counts.tests || counts.pass !== counts.tests || counts.fail || counts.cancelled || counts.skipped || counts.todo) throw new Error("Validation requires actual success without failed, cancelled, skipped or todo tests");
  return counts;
}
const nativeWindows = new Set([
  "experiment:test/features/projectResultPublication.test.js", "experiment:test/core/hostOperationLease.test.js",
  "experiment:test/core/resourceLeaseCompatibility.test.js", "sftp:test/hostOperationLease.test.js",
  "sftp:test/installPolicy.test.js", "sftp:test/mappedBatchDownload.test.js", "sftp:test/cleanupFiles.test.js", "sftp:test/macAuthentication.test.js",
]);
function verifyValidationRecords(proof, expected, digest, commits, readReceipt) {
  if (proof?.protocolVersion !== 1 || proof.inputDigest !== digest || JSON.stringify(proof.commits) !== JSON.stringify(commits)
    || !Array.isArray(proof.gates) || proof.gates.length !== expected.length) throw new Error("Validation proof does not bind this exact candidate and complete gate inventory");
  const seen = new Set();
  for (const row of proof.gates) {
    const key = row.component + ":" + row.file;
    const item = expected.find(item => item.component === row.component && item.file === row.file);
    if (!item || seen.has(key)) throw new Error("Validation gate is foreign or duplicated");
    seen.add(key);
    const bytes = readReceipt(safeRelative(row.evidence));
    if (hash(bytes) !== row.evidenceSha256) throw new Error("Validation receipt bytes changed");
    const receipt = JSON.parse(bytes.toString("utf8"));
    if (receipt.exitCode !== 0 || receipt.timedOut !== false || receipt.inputDigest !== digest
      || receipt.component !== row.component || receipt.file !== row.file
      || !["linux", "win32", "darwin"].includes(receipt.platform)
      || JSON.stringify(receipt.argv) !== JSON.stringify(["--test", "--test-force-exit", "--test-timeout", "20000", row.file])) throw new Error("Validation command, input binding or actual exit is invalid");
    if (nativeWindows.has(key) && receipt.platform !== "win32") throw new Error("Required native Windows validation is absent");
    testCounts(receipt.stdout);
  }
  return seen;
}
function assertValidationProof(file, roots, inventory, commits) {
  const directory = path.dirname(path.resolve(file)), proof = JSON.parse(readBound(directory, path.basename(file)).toString("utf8"));
  const input = captureValidationInputs(roots);
  const expected = inventory.map(item => {
    const component = path.resolve(item.cwd) === path.resolve(roots.experiment) ? "experiment" : "sftp";
    return { component, file: path.relative(roots[component], item.file).split(path.sep).join("/") };
  });
  verifyValidationRecords(proof, expected, input.digest, commits, relative => readBound(directory, relative));
  return new Set(inventory.map(item => item.file));
}
module.exports = { captureValidationInputs, testCounts, verifyValidationRecords, assertValidationProof };
