const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");
const guide = fs.readFileSync(path.join(__dirname, "../../docs/simple-experiment-setup.md"), "utf8");
const legacyNotes = fs.readFileSync(path.join(__dirname, "../../docs/technical-notes.md"), "utf8");

test("run confirmations explain code fingerprint without renaming the internal field", () => {
  assert.match(extension, /核验代码指纹、校验 Plan、预演调度/);
  assert.match(extension, /同步 Hub\/Worker 代码并核验代码指纹/);
  assert.match(extension, /const fingerprint = fingerprintFromManifest\(manifest\)/);
  assert.match(extension, /sftpFingerprintMatches\(record, fingerprint\)/);
  assert.match(legacyNotes, /运行确认窗口同样显示“核验代码指纹”/);
});
