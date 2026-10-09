const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const readme = fs.readFileSync(path.join(__dirname, "../../README.md"), "utf8");
const legacyNotes = fs.readFileSync(path.join(__dirname, "../../docs/technical-notes.md"), "utf8");
const guide = fs.readFileSync(path.join(__dirname, "../../docs/simple-experiment-setup.md"), "utf8");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test("remote project name is empty until a real workspace is open", () => {
  const sandbox = {
    workspaceRoot: () => undefined,
    path: { basename: () => { throw new Error("basename must not run without workspace"); } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("remoteProjectName")}\nthis.read = remoteProjectName;`, sandbox);
  assert.equal(sandbox.read(), "");
  assert.doesNotMatch(extractFunction("remoteProjectName"), /process\.cwd/);
  assert.match(extension, /\.\.\.\(projectName \? \{ workDir: `\$\{root\}\/\$\{projectName\}` \} : \{\}\)/);
});
