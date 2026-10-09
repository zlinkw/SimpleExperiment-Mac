const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

test("public GitHub sync and Xshell commands are contributed without legacy remote runners", () => {
  const commands = packageJson.contributes.commands.map((item) => item.command);
  assert.equal(commands.includes("simpleExperiment.syncToGitHub"), true);
  assert.equal(commands.includes("simpleExperiment.deployRuntime"), false);
  assert.equal(commands.includes("simpleExperiment.verifyRuntime"), false);
  assert.equal(commands.filter((command) => command.includes("configure") && command.includes("RealtimeTunnel")).every((command) => command.includes("Xshell")), true);
  assert.equal(commands.includes("simpleExperiment.configureXshellSavedSessions"), true);
  assert.equal(commands.includes("simpleExperiment.prepareAgents"), true);
});
