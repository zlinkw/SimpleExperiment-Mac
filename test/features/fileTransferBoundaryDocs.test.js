const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const doc = fs.readFileSync(path.join(__dirname, "../../docs/file-transfer-acceptance.md"), "utf8");

test("file transfer acceptance matches the SimpleSFTP boundary", () => {
  assert.match(doc, /SimpleExperiment.*不直接执行 SSH、SCP 或 RSYNC/);
  assert.match(doc, /SimpleSFTP.*真实文件传输/);
  assert.match(doc, /Xshell 本地隧道后的 Hub\/Worker Agent/);
  assert.match(doc, /<项目父目录>\/<当前项目名>/);
  assert.doesNotMatch(doc, /Hub Agent HTTP 文件 API/);
});
