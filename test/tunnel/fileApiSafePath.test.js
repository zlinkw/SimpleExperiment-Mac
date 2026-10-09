const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { isSafeRemotePath } = require("../../dist/tunnel/FileTransferTypes.js");
const source = fs.readFileSync(path.join(__dirname, "../../src/tunnel/FileTransferTypes.ts"), "utf8");

function functionSource(name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "missing " + name);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
}

test("file api safe path blocks traversal and allows project roots", () => {
  assert.equal(isSafeRemotePath("work_dirs/run/metrics.csv"), true);
  assert.equal(isSafeRemotePath("simple_cluster/debug/bundle.zip"), true);
  assert.equal(isSafeRemotePath("../secret"), false);
  assert.equal(isSafeRemotePath("C:/Users/a/key"), false);
  assert.equal(isSafeRemotePath("/etc/passwd"), false);
  assert.equal(isSafeRemotePath("random/file"), false);
});

test("safe path validation reuses fixed allowlists and one path split", () => {
  const validator = functionSource("isSafeRemotePath");
  assert.match(source, /const ROOT_RESULT_FILES: ReadonlySet<string> = new Set\(\[/);
  assert.match(source, /const ALLOWED_REMOTE_PATH_ROOTS: ReadonlySet<string> = new Set\(\[/);
  assert.doesNotMatch(validator, /new Set\(/);
  assert.equal((validator.match(/normalized\.split\("\/"\)/g) || []).length, 1);
  assert.equal(isSafeRemotePath("METRICS_SUMMARY.CSV"), true);
  assert.equal(isSafeRemotePath("./results/run/metrics.csv"), true);
  assert.equal(isSafeRemotePath("."), false);
});
