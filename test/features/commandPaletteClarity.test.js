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
  "simpleExperiment.writeXshellAgentStartupCommands",
  "simpleExperiment.configureXshellRealtimeTunnel",
  "simpleExperiment.startHubTunnel",
  "simpleExperiment.startWorkerTunnel",
  "simpleExperiment.startXshellRealtimeTunnel",
  "simpleExperiment.startAllXshellRealtimeTunnels",
  "simpleExperiment.showTunnelEndpointRegistry",
  "simpleExperiment.testXshellTunnel",
  "simpleExperiment.restartRealtimeStream",
  "simpleExperiment.pauseRealtimeStream",
  "simpleExperiment.resumeRealtimeStream",
  "simpleExperiment.pauseAllNetworkActivity",
  "simpleExperiment.generateXshellTunnelScript",
  "simpleExperiment.openTunnelStatus",
  "simpleExperiment.runXshellRealIntegrationCheck",
  "simpleExperiment.manualRefresh",
  "simpleExperiment.importOfflineBundle",
];

const primaryCommands = [
  "simpleExperiment.openPanel",
  "simpleExperiment.quickSetup",
  "simpleExperiment.bootstrapProject",
  "simpleExperiment.prepareAgents",
  "simpleExperiment.openSetupGuide",
  "simpleExperiment.configureXshellSavedSessions",
  "simpleExperiment.configureWorkerTunnels",
  "simpleExperiment.configureTunnelPorts",
  "simpleExperiment.startAllXshellConnections",
  "simpleExperiment.testAllTunnels",
];

test("command palette defaults to the new-project main workflow without removing advanced handlers", () => {
  const commands = new Set(packageJson.contributes.commands.map((item) => item.command));
  const palette = packageJson.contributes.menus.commandPalette;
  const hiddenByDefault = new Map(palette.map((item) => [item.command, item.when]));

  assert.equal(packageJson.contributes.configuration.properties["simpleExperiment.showAdvancedCommands"].default, false);
  assert.deepEqual([...hiddenByDefault.keys()].sort(), [...advancedCommands].sort());

  for (const command of advancedCommands) {
    assert.ok(commands.has(command), `${command} must remain contributed`);
    assert.equal(hiddenByDefault.get(command), "config.simpleExperiment.showAdvancedCommands");
    assert.match(extension, new RegExp(`(?:registerCommand|hostCommand)\\("${command.replaceAll(".", "\\.")}"`));
  }

  for (const command of primaryCommands) {
    assert.ok(commands.has(command), `${command} must remain contributed`);
    assert.equal(hiddenByDefault.has(command), false, `${command} must remain visible by default`);
  }

  assert.match(readme, /simpleExperiment\.showAdvancedCommands/);
  assert.match(legacyNotes, /旧自动隧道、单端点启动、实时流和诊断恢复命令仍保持注册/);
  assert.match(legacyNotes, /面板内原按钮和直接命令 ID 不变/);
});

test("settings links directly to the advanced command visibility setting", () => {
  assert.match(panel, /data-anchor="settings-advanced-commands"/);
  assert.match(panel, /data-command="openAdvancedCommandsSetting"[^>]*>打开命令设置<\/button>/);
  assert.match(panel, /"openAdvancedCommandsSetting"/);
  assert.match(extension, /case "openAdvancedCommandsSetting":[\s\S]{0,180}workbench\.action\.openSettings", "simpleExperiment\.showAdvancedCommands"/);
});
