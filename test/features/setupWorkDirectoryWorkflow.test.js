const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

test("Xshell setup requires project parent directories before code sync", () => {
  assert.match(source, /inputActualWorkRoot\("Hub 项目父目录"/);
  assert.match(source, /inputActualWorkRoot\("Worker 项目父目录"/);
  assert.match(source, /agentProjectDir: hubActualWorkDir/);
  assert.match(source, /agentProjectDir,/);
  assert.match(source, /function inputRequired\(/);
  assert.match(source, /simpleSftpIntegrationReadiness\(\)/);
  assert.match(source, /使用配套离线包重新安装两个插件/);
});

test("quick setup writes current-project profiles to the public SimpleSFTP location", () => {
  assert.match(source, /"SimpleSFTP", "server-profiles"/);
  assert.doesNotMatch(source, /"ZLK", "server-profiles"/);
  assert.match(source, /targets\.push\(this\.hubCodeSyncTarget\(\)\)/);
  assert.match(source, /targets\.push\(this\.workerCodeSyncTarget\(worker\)\)/);
  assert.match(source, /workerActualWorkRootTarget\(worker\)/);
  assert.match(source, /targets\.some\(\(target\) => target\.id === existingActiveServerId\)/);
  assert.match(source, /source: "simple-experiment"/);
  assert.match(source, /updatedBy: "simple-experiment"/);
  assert.match(source, /await atomicWriteText\(file, payload\)/);
  assert.match(source, /const profileResult = await this\.writeSftpManagerServerProfiles\(\)/);
  assert.match(source, /已生成 \$\{profileResult\.targetCount\} 个当前项目 SimpleSFTP 目标/);
});

test("quick setup resolves Xshell and Worker blockers before Agent preparation", () => {
  const start = source.indexOf("async quickSetup(showAgentCompletion = true)");
  const end = source.indexOf("async configureXshellSavedSessions()", start);
  assert.ok(start >= 0 && end > start);
  const flow = source.slice(start, end);
  const setupGate = flow.indexOf("serverSetupMissingItems(this.setupConfig, hubRequired)");
  const workerGate = flow.indexOf("当前只配置了 Hub");
  const workspaceGate = flow.indexOf("if (!workspaceRoot())");
  const profiles = flow.indexOf("const profileResult = await this.writeSftpManagerServerProfiles()");
  const preparation = flow.indexOf("this.prepareAgentsForFirstRun(showAgentCompletion)");
  assert.ok(setupGate >= 0 && setupGate < workerGate);
  assert.ok(setupGate < workspaceGate && workspaceGate < workerGate);
  assert.ok(workerGate < profiles && profiles < preparation);
  assert.match(flow, /插件不会在这里从零初始化服务器配置/);
  assert.match(flow, /插件不会在接入弹窗中初始化服务器/);
  assert.match(flow, /"打开服务器设置"/);
  assert.match(flow, /this\.openPanelAt\("settings", "settings-servers", \{ userInitiated: true \}\)/);
  assert.doesNotMatch(flow, /"打开面板"/);
  assert.match(source, /async addWorkerConfigFromUi\(showMessage = true\)/);
  assert.match(source, /if \(showMessage\)\s*void vscode\.window\.showInformationMessage\(`\$\{worker\.displayName \|\| worker\.id\} 已添加并全局保存。`\)/);
  assert.match(flow, /Hub 配置已保存[\s\S]{0,180}return false;/);
  assert.doesNotMatch(flow, /仅填写 Hub 参数/);
  assert.doesNotMatch(flow, /选择 Xshell 会话文件.*action/);
  assert.match(flow, /下一步选择要运行实验的本地项目/);
  assert.match(flow, /"选择项目并继续", "打开配置说明", "稍后"/);
  assert.match(flow, /open === "选择项目并继续"[\s\S]{0,150}openWorkspaceFolderForContinuation\("一键配置", "quickSetup"/);
  assert.match(source, /async completeQuickSetupAfterWorkspace\(showAgentCompletion = true\)/);
  assert.match(source, /pending\.action === "quickSetup"[\s\S]{0,150}completeQuickSetupAfterWorkspace/);
  assert.match(source, /completeQuickSetupAfterWorkspace[\s\S]{0,220}ensureSimpleSftpReadyForSetup\("一键配置续接"\)/);
  assert.match(source, /一键配置续接已停止：服务器配置缺少/);
  assert.match(source, /尚未生成当前项目 SimpleSFTP 目标或准备 Agent/);
  const blockers = flow.slice(flow.indexOf("const preparationBlockers ="), flow.indexOf("const profileSummary ="));
  assert.match(blockers, /if \(preparationBlockers\.length\)/);
  assert.match(blockers, /return false;/);
  assert.doesNotMatch(blockers, /prepareAgentsForFirstRun/);
});
