const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");
const readme = fs.readFileSync(path.join(__dirname, "../../README.md"), "utf8");
const legacyNotes = fs.readFileSync(path.join(__dirname, "../../docs/technical-notes.md"), "utf8");
const guide = fs.readFileSync(path.join(__dirname, "../../docs/simple-experiment-setup.md"), "utf8");

test("manual server saves show computed destinations before offering one next step", () => {
  const helper = source.slice(source.indexOf("serverConfigSavedMessage(label, actualWorkRoot)"), source.indexOf("async saveHubConfigFromUi"));
  assert.match(helper, /当前项目代码：\$\{dirs\.workDir\}/);
  assert.match(helper, /Agent runtime：\$\{dirs\.installDir\}\/simple_cluster\/runtime/);
  assert.match(helper, /打开目标本地项目后再计算代码上传位置/);
  assert.match(helper, /if \(!workspaceRoot\(\)\)[\s\S]{0,320}"选择项目并继续"/);
  assert.match(helper, /next === "选择项目并继续"[\s\S]{0,140}openWorkspaceFolderForContinuation\(`\$\{label\} 配置`, "quickSetup"/);
  assert.match(helper, /打开配置说明/);
  assert.match(helper, /if \(!enabledWorkers\.length\)[\s\S]{0,260}"添加 Worker"/);
  assert.match(helper, /initialServerSetupComplete\(this\.setupConfig, this\.projectTopologyAssessment\(\)\.hubAllowed\)/);
  assert.match(helper, /assertTopologyActualWorkRoots\("完成服务器设置"\)/);
  assert.match(helper, /showInformationMessage\(message, "准备 Agent 并启动"\)/);
  assert.doesNotMatch(helper, /showInformationMessage\(message, "准备 Agent 并启动",/);
  assert.match(helper, /next === "准备 Agent 并启动"\)\s*await this\.prepareAgentsForFirstRun\(\)/);
});

test("Hub and Worker save handlers continue only after state persistence", () => {
  const hub = source.slice(source.indexOf("async saveHubConfigFromUi"), source.indexOf("async saveSchedulerConfigFromUi"));
  const worker = source.slice(source.indexOf("async saveWorkerConfigFromUi"), source.indexOf("async addWorkerConfigFromUi"));
  assert.ok(hub.indexOf("applySetupDraft") < hub.indexOf("showServerConfigSavedNextStep"));
  assert.ok(worker.indexOf("applySetupDraft") < worker.indexOf("showServerConfigSavedNextStep"));
  assert.match(worker, /savedWorker\?\.displayName \|\| endpointId/);
  assert.doesNotMatch(hub, /refreshXshellSessionLibrary\(/);
  assert.doesNotMatch(worker, /refreshXshellSessionLibrary\(/);
  assert.match(worker, /ensureXshellSessionLoaded\(selectedWorker\?\.savedSessionPath\)/);
  assert.doesNotMatch(worker, /Promise\.all\(manual\.workerTunnels\.map/);
  assert.match(hub, /void this\.showServerConfigSavedNextStep\(/);
  assert.match(worker, /void this\.showServerConfigSavedNextStep\(/);
  assert.match(source, /addWorkerConfigFromUi\(false\)[\s\S]{0,260}showServerConfigSavedNextStep/);
  assert.match(legacyNotes, /手动保存 Hub 或 Worker 后会显示最终代码与 runtime 位置/);
  assert.match(legacyNotes, /配置完整后可直接继续“准备 Agent 并启动”/);
});
