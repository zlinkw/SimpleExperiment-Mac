const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const legacyNotes = fs.readFileSync(path.join(root, "docs/technical-notes.md"), "utf8");
const guide = fs.readFileSync(path.join(root, "docs/simple-experiment-setup.md"), "utf8");

const advancedCommands = [
  "simpleExperimentMac.writeXshellAgentStartupCommands",
  "simpleExperimentMac.configureXshellRealtimeTunnel",
  "simpleExperimentMac.startHubTunnel",
  "simpleExperimentMac.startWorkerTunnel",
  "simpleExperimentMac.startXshellRealtimeTunnel",
  "simpleExperimentMac.startAllXshellRealtimeTunnels",
  "simpleExperimentMac.showTunnelEndpointRegistry",
  "simpleExperimentMac.testXshellTunnel",
  "simpleExperimentMac.restartRealtimeStream",
  "simpleExperimentMac.pauseRealtimeStream",
  "simpleExperimentMac.resumeRealtimeStream",
  "simpleExperimentMac.pauseAllNetworkActivity",
  "simpleExperimentMac.generateXshellTunnelScript",
  "simpleExperimentMac.openTunnelStatus",
  "simpleExperimentMac.runXshellRealIntegrationCheck",
  "simpleExperimentMac.manualRefresh",
  "simpleExperimentMac.importOfflineBundle",
];

const primaryCommands = [
  "simpleExperimentMac.openPanel",
  "simpleExperimentMac.quickSetup",
  "simpleExperimentMac.bootstrapProject",
  "simpleExperimentMac.prepareAgents",
  "simpleExperimentMac.openSetupGuide",
  "simpleExperimentMac.configureXshellSavedSessions",
  "simpleExperimentMac.configureWorkerTunnels",
  "simpleExperimentMac.configureTunnelPorts",
  "simpleExperimentMac.startAllXshellConnections",
  "simpleExperimentMac.testAllTunnels",
];

test("command palette defaults to the new-project main workflow without removing advanced handlers", () => {
  const commands = new Set(packageJson.contributes.commands.map((item) => item.command));
  const palette = packageJson.contributes.menus.commandPalette;
  const hiddenByDefault = new Map(palette.map((item) => [item.command, item.when]));

  assert.equal(packageJson.contributes.configuration.properties["simpleExperimentMac.showAdvancedCommands"].default, false);
  assert.deepEqual([...hiddenByDefault.keys()].sort(), [...advancedCommands].sort());

  for (const command of advancedCommands) {
    assert.ok(commands.has(command), `${command} must remain contributed`);
    assert.equal(hiddenByDefault.get(command), "config.simpleExperimentMac.showAdvancedCommands");
    assert.match(extension, new RegExp(`(?:registerCommand|hostCommand)\\("${command.replaceAll(".", "\\.")}"`));
  }

  for (const command of primaryCommands) {
    assert.ok(commands.has(command), `${command} must remain contributed`);
    assert.equal(hiddenByDefault.has(command), false, `${command} must remain visible by default`);
  }

  assert.match(readme, /simpleExperimentMac\.tunnel\.manualEndpoints/);
  assert.match(guide, /SimpleExperiment Mac：配置 Termius 手动端点/);
  const command = packageJson.contributes.commands.find(item => item.command === "simpleExperimentMac.generateXshellTunnelScript");
  assert.equal(command.title, "SimpleExperiment：显示 Termius 隧道与 Agent 指引");
  assert.ok(readSource("src/factories/CommandFactory.ts").includes(command.title));
  assert.match(legacyNotes, /旧自动隧道、单端点启动、实时流和诊断恢复命令仍保持注册/);
  assert.match(legacyNotes, /面板内原按钮和直接命令 ID 不变/);
});

test("settings links directly to the advanced command visibility setting", () => {
  assert.match(panel, /data-anchor="settings-advanced-commands"/);
  assert.match(panel, /data-command="openAdvancedCommandsSetting"[^>]*>打开命令设置<\/button>/);
  assert.match(panel, /"openAdvancedCommandsSetting"/);
  assert.match(extension, /case "openAdvancedCommandsSetting":[\s\S]{0,180}workbench\.action\.openSettings", "simpleExperimentMac\.showAdvancedCommands"/);
});
