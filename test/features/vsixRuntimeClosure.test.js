const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "../..");

test("VSIX includes every local CommonJS dependency of extension and CLI entrypoints", () => {
  const command = process.platform === "win32" ? "node.exe" : process.execPath;
  const result = spawnSync(command, [path.join(root, "scripts", "verify-vsix-runtime.js")], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /VSIX runtime closure verified/);
  assert.doesNotMatch(result.stderr, /DEP0190|DeprecationWarning/);
});

test("tooling uses pinned local VSCE and npm-cli without shell argument concatenation", () => {
  const fs = require("node:fs");
  const helper = fs.readFileSync(path.join(root, "scripts", "npm-command.js"), "utf8");
  const verifier = fs.readFileSync(path.join(root, "scripts", "verify-vsix-runtime.js"), "utf8");
  const acceptance = fs.readFileSync(path.join(root, "scripts", "acceptance.js"), "utf8");
  assert.match(helper, /command: process\.execPath/);
  assert.match(verifier, /require\.resolve\("@vscode\/vsce\/vsce"\)/);
  assert.match(verifier, /spawnSync\(process\.execPath/);
  assert.match(verifier, /timeout: 8000/);
  assert.doesNotMatch(verifier, /npmCommand|"exec"/);
  assert.match(acceptance, /function runNpm/);
  assert.doesNotMatch(verifier, /shell\s*:/);
  assert.doesNotMatch(acceptance, /shell\s*:/);
});
