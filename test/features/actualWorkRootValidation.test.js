const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");
const readme = fs.readFileSync(path.join(__dirname, "../../README.md"), "utf8");
const legacyNotes = fs.readFileSync(path.join(__dirname, "../../docs/technical-notes.md"), "utf8");
const guide = fs.readFileSync(path.join(__dirname, "../../docs/simple-experiment-setup.md"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test("project parent roots reject reserved Agent directories and suggest the real parent", () => {
  const sandbox = {};
  const { resolveApiRemoteRootWithPolicy } = require("../../dist/features/ApiWorkflow.js");
  sandbox.ApiWorkflow_1 = { resolveApiRemoteRootWithPolicy };
  sandbox.errorMessage = (error) => String(error?.message || error);
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("normalizeRemoteWorkRoot")}\n${extractFunction("remoteParentWorkRoot")}\n${extractFunction("actualWorkRootValidationMessage")}\n${extractFunction("actualWorkRootAmbiguityMessage")}\nthis.check = actualWorkRootValidationMessage; this.parent = remoteParentWorkRoot; this.warn = actualWorkRootAmbiguityMessage;`, sandbox);
  assert.equal(sandbox.check("/srv/projects", "demo", "Hub"), undefined);
  assert.equal(sandbox.check("/srv/projects/demo", "demo", "Hub"), undefined);
  assert.match(sandbox.warn("/srv/projects/demo", "demo", "Hub"), /最终代码目录会重复/);
  assert.match(sandbox.warn("/srv/projects/demo", "demo", "Hub"), /建议改为项目父目录：\/srv\/projects/);
  assert.equal(sandbox.parent("/srv/projects/demo"), "/srv/projects");
  assert.equal(sandbox.parent("projects/demo"), "projects");
  assert.equal(sandbox.parent("/demo"), undefined);
  assert.equal(sandbox.warn("/srv/projects", "demo", "Hub"), undefined);
  assert.match(sandbox.check("/srv/simple_agent", "demo", "Hub"), /不能包含 simple_agent/);
  assert.match(sandbox.check("/srv/simple_agent/archive", "demo", "Worker"), /不能包含 simple_agent/);
  assert.equal(sandbox.check("/data/custom-root", "demo", "Hub", {}, {}), undefined);
  assert.match(sandbox.check("/", "demo", "Hub"), /项目的父目录/);
});

test("setup saves and remote side effects share the same work-root gate", () => {
  const hubSave = source.slice(source.indexOf("async saveHubConfigFromUi"), source.indexOf("async saveSchedulerConfigFromUi"));
  const workerSave = source.slice(source.indexOf("async saveWorkerConfigFromUi"), source.indexOf("async addWorkerConfigFromUi"));
  const sftpPrepare = source.slice(source.indexOf("async prepareSftpTargets"), source.indexOf("    sftpServerOptions"));
  const agentWrite = source.slice(source.indexOf("async writeXshellAgentStartupCommands"), source.indexOf("async startAllXshellAgentSessions"));

  assert.match(source, /async function inputActualWorkRoot[\s\S]{0,700}actualWorkRootValidationMessage/);
  assert.match(source, /inputActualWorkRoot[\s\S]{0,1500}"自动改为上一级"[\s\S]{0,180}"仍按当前目录使用"/);
  assert.equal([...source.matchAll(/await inputActualWorkRoot\(/g)].length, 3);
  assert.ok(hubSave.indexOf("assertActualWorkRoot") < hubSave.indexOf("applySetupDraft"));
  assert.ok(hubSave.indexOf("confirmActualWorkRootAmbiguity") < hubSave.indexOf("applySetupDraft"));
  assert.ok(workerSave.indexOf("assertActualWorkRoot") < workerSave.indexOf("applySetupDraft"));
  assert.ok(workerSave.indexOf("confirmActualWorkRootAmbiguity") < workerSave.indexOf("applySetupDraft"));
  assert.match(hubSave, /agentProjectDir = await confirmActualWorkRootAmbiguity/);
  assert.match(workerSave, /targetAgentProjectDir = await confirmActualWorkRootAmbiguity/);
  assert.match(sftpPrepare, /assertTopologyActualWorkRoots\("SFTP 上传或目录配置"\)/);
  assert.match(agentWrite, /assertTopologyActualWorkRoots\("写入 Agent 自启动路径"\)/);
  assert.match(source, /async writeSftpManagerServerProfiles\(targetIds\) \{\s*this\.assertTopologyActualWorkRoots\("写入 SimpleSFTP 服务器配置"\)/);
  assert.match(legacyNotes, /一键改为上一级父目录/);
  assert.match(legacyNotes, /警告窗口可一键改为上一级父目录/);
});
