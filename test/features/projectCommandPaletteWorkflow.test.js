const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extension = readSource("src/extension.ts");

function command(command) {
  return packageJson.contributes.commands.find((item) => item.command === command);
}

test("command palette exposes the three primary new-project entry points", () => {
  assert.equal(command("simpleExperiment.quickSetup").title, "SimpleExperiment：检查服务器配置");
  assert.equal(command("simpleExperiment.bootstrapProject").title, "SimpleExperiment：识别工作区");
  assert.equal(command("simpleExperiment.prepareAgents").title, "SimpleExperiment：准备 Agent 并启动");
  assert.ok(packageJson.activationEvents.includes("onCommand:simpleExperiment.bootstrapProject"));
  assert.ok(packageJson.activationEvents.includes("onCommand:simpleExperiment.prepareAgents"));
  assert.match(extension, /hostCommand\("simpleExperiment\.bootstrapProject", "bootstrap-project", "识别工作区", \(\) => provider\?\.bootstrapProjectFromUi\(\)\)/);
  assert.match(extension, /hostCommand\("simpleExperiment\.prepareAgents", "prepare-agents", "准备 Agent 并启动", \(\) => provider\?\.prepareAgentsForFirstRun\(\)\)/);
  const bootstrapStart = extension.indexOf("async bootstrapProjectFromUi()");
  const bootstrapEnd = extension.indexOf("async generateOutputAdapterFromUi()", bootstrapStart);
  const bootstrap = extension.slice(bootstrapStart, bootstrapEnd);
  assert.match(bootstrap, /if \(!root\) \{[\s\S]{0,220}openWorkspaceFolderForContinuation\("识别工作区", "bootstrapProject"\)[\s\S]{0,80}return;/);
  assert.doesNotMatch(bootstrap, /throw new Error\("需要先打开工作区。"\)/);
  assert.match(extension, /async openWorkspaceFolderForContinuation\(operation, action, payload = \{\}\)/);
  assert.match(extension, /canSelectFolders: true[\s\S]{0,100}canSelectMany: false/);
  assert.match(extension, /pendingWorkspaceContinuation/);
  assert.match(extension, /executeCommand\("vscode\.openFolder", folder, false\)/);
  assert.match(extension, /async resumePendingWorkspaceContinuation\(\)/);
  assert.match(extension, /void provider\.runActivationOnboarding\(\)/);
  assert.match(extension, /name: "workspaceContinuation"[\s\S]{0,180}resumePendingWorkspaceContinuation\(\)/);
  assert.match(extension, /name: "projectStateBootstrap"[\s\S]{0,160}projectBootstrapPromise/);
  assert.match(extension, /name: "firstRunPrompt"[\s\S]{0,140}showFirstRunSetupPromptOnce\(\)/);
  assert.match(extension, /pending\.action === "bootstrapProject"[\s\S]{0,100}bootstrapProjectFromUi\(\)/);
  assert.match(extension, /pending\.action === "quickSetup"[\s\S]{0,140}completeQuickSetupAfterWorkspace/);
  assert.match(extension, /pending\.action === "setupGuide"[\s\S]{0,120}openSetupGuide\(\)/);
  assert.match(extension, /error instanceof UiCommandCancelled[\s\S]{0,500}自动续接失败/);
});

test("connection command keeps literal semantics in package metadata", () => {
  assert.equal(command("simpleExperiment.startAllXshellConnections").title, "SimpleExperiment：启动全部 Xshell 连接");
  assert.doesNotMatch(JSON.stringify(packageJson), /一键启动隧道和 Agent/);
});

test("opening a configured project automatically restores endpoint readiness", () => {
  const start = extension.indexOf("resolveWebviewView(webviewView)");
  const end = extension.indexOf("async dispose()", start);
  assert.ok(start >= 0 && end > start);
  const flow = extension.slice(start, end);
  assert.match(flow, /syncConfiguredXshellSessions\("webview resolved"\)/);
  assert.match(flow, /this\.isRealtimeMode\(\) && initialServerSetupComplete\(this\.setupConfig, this\.projectTopologyAssessment\(\)\.hubAllowed\)/);
  assert.match(flow, /await this\.testTunnel\(false\)/);
  assert.match(flow, /this\.postState\(\)/);
  assert.doesNotMatch(flow, /testTunnel\(true\)/);
});
