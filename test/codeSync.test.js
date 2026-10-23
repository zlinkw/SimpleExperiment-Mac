const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

test("public GitHub sync and Xshell commands are contributed without legacy remote runners", () => {
  const commands = packageJson.contributes.commands.map((item) => item.command);
  // Mac 适配：贡献命令使用 simpleExperimentMac.* 身份前缀，契约断言与 Windows .403 完全同形。
  assert.equal(commands.includes("simpleExperimentMac.syncToGitHub"), true);
  assert.equal(commands.includes("simpleExperimentMac.deployRuntime"), false);
  assert.equal(commands.includes("simpleExperimentMac.verifyRuntime"), false);
  assert.equal(commands.filter((command) => command.includes("configure") && command.includes("RealtimeTunnel")).every((command) => command.includes("Xshell")), true);
  assert.equal(commands.includes("simpleExperimentMac.configureXshellSavedSessions"), true);
  assert.equal(commands.includes("simpleExperimentMac.prepareAgents"), true);
});
