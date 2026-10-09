const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");
const { normalizeXshellSetupConfig } = require("../../dist/tunnel/XshellTunnelSetup.js");

const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const readme = fs.readFileSync(path.join(__dirname, "../../README.md"), "utf8");
const guide = fs.readFileSync(path.join(__dirname, "../../docs/simple-experiment-setup.md"), "utf8");

test("first-run Agent preparation confirms once and preserves operation order", () => {
  const start = extension.indexOf("async prepareAgentsForFirstRun(showMessage = true)");
  const end = extension.indexOf("async configureXshellRealtimeTunnel()", start);
  assert.ok(start >= 0 && end > start);
  const flow = extension.slice(start, end);
  const sftp = flow.indexOf('ensureSimpleSftpReadyForSetup("准备 Agent")');
  const workspace = flow.search(/if\s*\(!workspaceRoot\(\)\)/);
  const sync = flow.indexOf('syncXshellConfigBeforeNetwork("prepare agents for first run", { postState: false })');
  const preflight = flow.indexOf("currentAgentPreparationBlockers()");
  const confirm = flow.indexOf("确认准备并启动");
  const write = flow.indexOf("writeXshellAgentStartupCommands(false, false)");
  const blocked = flow.indexOf("Agent 自启动命令未就绪");
  const profiles = flow.indexOf("writeSftpManagerServerProfiles(");
  const pathConfirm = flow.indexOf("confirmRemoteWriteTargets");
  const deploy = flow.indexOf("deployLatestAgentRuntime(false, true, [], true)");
  const launch = flow.indexOf("startAllXshellConnections(false, false)");
  const detect = flow.indexOf("this.testTunnel(false)");
  assert.ok(sftp >= 0 && sftp < workspace && workspace < sync);
  assert.ok(sync >= 0 && sync < preflight);
  assert.ok(preflight < confirm);
  assert.ok(preflight < pathConfirm && pathConfirm < confirm);
  assert.ok(confirm < profiles && profiles < write);
  assert.ok(write < blocked);
  assert.ok(blocked < deploy);
  assert.ok(deploy < launch);
  assert.ok(launch < detect);
  assert.match(flow, /withProgress\(\{ location: vscode\.ProgressLocation\.Notification, title: "准备 Agent"/);
  assert.doesNotMatch(flow, /await sleep\(3000\)|await sleep\(2000\)/);
  assert.match(extension, /const AGENT_STARTUP_BLOCKED_SKIP_REASONS = new Set\(\["non_simple_remote_command", "different_simple_agent_session"\]\)/);
  assert.match(flow, /AGENT_STARTUP_BLOCKED_SKIP_REASONS\??\.has\(item\.skippedReason\)/);
  assert.doesNotMatch(flow, /\["non_simple_remote_command", "different_simple_agent_session"\]\.includes/);
  assert.match(flow, /tunnelTestCompletion\(this\.setupConfig, this\.lastProbe, this\.lastHealth, this\.lastWorkerProbes, topology\.hubAllowed\)/);
  assert.match(flow, /当前拓扑端点健康检测未通过/);
  assert.match(flow, /if \(showMessage\) \{[\s\S]{0,420}"识别工作区", "打开面板"/);
  assert.doesNotMatch(flow, /const next = await vscode\.window\.showInformationMessage\(`Agent 首次准备完成/);
  assert.match(flow, /void vscode\.window\.showInformationMessage\(`Agent 首次准备完成[\s\S]{0,250}\.then\(/);
  assert.match(flow, /next === "识别工作区"\)[\s\S]{0,120}simpleExperiment\.bootstrapProject/);
  assert.match(flow, /if\s*\(!workspaceRoot\(\)\)\s*\{[\s\S]{0,180}openWorkspaceFolderForContinuation\("准备 Agent",\s*"prepareAgents"\)[\s\S]{0,120}UiCommandCancelled/);
  assert.match(extension, /pending\.action === "prepareAgents"[\s\S]{0,100}prepareAgentsForFirstRun\(true\)/);
  assert.match(flow, /当前项目 SimpleSFTP 目标不完整/);
  assert.match(flow, /尚未修改 \.xsh 或上传 runtime/);
  assert.match(flow, /return true;/);
  assert.match(extension, /async ensureSimpleSftpReadyForSetup\(operation\)/);
  assert.match(extension, /ensureSimpleSftpReadyForSetup\("一键配置"\)/);
  assert.match(extension, /ensureSimpleSftpReadyForSetup\("准备 Agent"\)/);
  assert.match(extension, /operation\}暂不能开始/);
});

test("Xshell forwarding preserves configured local and remote hosts", () => {
  const setup = normalizeXshellSetupConfig({
    localForwardHost: "192.168.1.8",
    remoteAgentHost: "agent.internal.example",
    workerRealtimeMode: "hub_plus_workers",
    workerTunnels: [{
      id: "worker-a",
      localForwardHost: "10.20.0.8",
      remoteAgentHost: "worker-agent.internal.example",
      enabled: true,
    }],
  });
  assert.equal(setup.localForwardHost, "192.168.1.8");
  assert.equal(setup.remoteAgentHost, "agent.internal.example");
  assert.equal(setup.workerTunnels[0].localForwardHost, "10.20.0.8");
  assert.equal(setup.workerTunnels[0].remoteAgentHost, "worker-agent.internal.example");
  assert.doesNotMatch(extension, /XSHELL_LOOPBACK_HOSTS|xshellForwardHostIsLoopback/);
});

test("quick setup and main UI expose preparation while connection keeps literal meaning", () => {
  const quickSetupStart = extension.indexOf("async quickSetup(showAgentCompletion = true)");
  const quickSetupEnd = extension.indexOf("async configureXshellSavedSessions()", quickSetupStart);
  const quickSetup = extension.slice(quickSetupStart, quickSetupEnd);
  const readinessStart = extension.indexOf("async ensureSimpleSftpReadyForSetup(operation)");
  const readinessEnd = extension.indexOf("async quickSetup(showAgentCompletion = true)", readinessStart);
  const readiness = extension.slice(readinessStart, readinessEnd);
  assert.ok(quickSetup.indexOf('ensureSimpleSftpReadyForSetup("一键配置")') >= 0);
  assert.ok(quickSetup.indexOf('ensureSimpleSftpReadyForSetup("一键配置")') < quickSetup.indexOf("const hubRequired"));
  assert.doesNotMatch(quickSetup, /showQuickPick/);
  assert.match(extension, /async ensureSimpleSftpReadyForSetup\(operation\)/);
  assert.match(extension, /\$\{operation\}暂不能开始/);
  assert.match(readiness, /next === "打开配置说明"[\s\S]{0,220}this\.openSetupGuide\(\)/);
  assert.match(readiness, /next === "打开扩展管理"[\s\S]{0,260}workbench\.extensions\.search/);
  assert.match(extension, /vscode\.commands\.getCommands\(true\)/);
  assert.match(extension, /SimpleSFTP 已安装但当前窗口尚未注册编排命令/);
  assert.match(extension, /workbench\.action\.reloadWindow/);
  assert.match(quickSetup, /return false;/);
  assert.match(extension, /"准备 Agent 并启动", "仅启动会话", "只检测"/);
  assert.match(extension, /next === "准备 Agent 并启动"\)\s*agentsReady = await this\.prepareAgentsForFirstRun\(showAgentCompletion\)/);
  assert.match(extension, /async quickSetup\(showAgentCompletion = true\)/);
  assert.match(extension, /async writeXshellAgentStartupCommands\(showMessage = true, requireConfirm = true\)/);
  assert.match(extension, /async startAllXshellConnections\(requireConfirm = true, scheduleAutoTest = true\)/);
  assert.equal((extension.match(/this\.schedulePostLaunchAutoTest\(\)/g) || []).length, 3);
  assert.doesNotMatch(extension, /setTimeout\(\(\) => void this\.testTunnel\(true\), 2500\)/);
  assert.match(extension, /private postLaunchAutoTestTimer\?: ReturnType<typeof setTimeout>/);
  assert.match(extension, /private postLaunchAutoTestGeneration = 0/);
  const schedule = extension.match(/private schedulePostLaunchAutoTest\(\)[\s\S]*?private cancelPostLaunchAutoTest/)?.[0] || "";
  assert.match(schedule, /const timerGeneration = this\.postLaunchAutoTestGeneration/);
  assert.match(schedule, /generation !== this\.projectContextGeneration \|\| client !== this\.client/);
  assert.match(schedule, /this\.testTunnel\(true\)\.catch/);
  assert.match(extension, /private resetClient\(\)[\s\S]{0,300}this\.cancelPostLaunchAutoTest\(\)/);
  assert.match(extension, /case "prepareAgents":\s*await this\.prepareAgentsForFirstRun\(message\.uiMode !== true\)/);
  assert.match(panel, /data-command="prepareAgents"[^>]*>准备 Agent 并启动<\/button>/);
  assert.match(panel, /prepareAgents: "部署 Agent、写入受管自启动命令、启动会话并检测全部"/);
  assert.match(panel, /command === "prepareAgents".*serverSetupReadiness\(state\)\.ready/);
  assert.doesNotMatch(panel, /一键启动隧道和 Agent|启动 Agent\+隧道/);
  assert.match(readme, /首次配置推荐点击“准备 Agent 并启动”/);
  assert.match(readme, /未打开工作区时执行“准备 Agent 并启动”会直接打开 VS Code 文件夹选择器/);
  assert.match(guide, /Xshell 会话 -> SimpleExperiment 服务器目录 -> SimpleSFTP 目标 -> 准备 Agent/);
  assert.match(guide, /首次配置使用“准备 Agent 并启动”/);
  assert.match(guide, /插件不会把 Agent 部署到通用占位项目目录/);
});
