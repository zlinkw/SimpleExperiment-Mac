const fs = require("node:fs");

const REQUIRED_EXTENSION_HOSTS = Object.freeze({
  "openai.chatgpt": "workspace",
  "simple-local.simple-experiment": "ui",
  "simple-local.simple-sftp": "ui",
});

const REQUIRED_PATH_SETTINGS = Object.freeze({
  clusterHostRoot: "simpleExperiment.workspaceHostRoot",
  clusterContainerRoot: "simpleExperiment.workspaceContainerRoot",
  sftpHostRoot: "simpleSftp.workspaceHostRoot",
  sftpContainerRoot: "simpleSftp.workspaceContainerRoot",
});

const REQUIRED_CONTRACT_MARKERS = Object.freeze([
  'process.platform === "win32"',
  "D:\\GitRepo",
  "/workspaces/",
  "vscode-remote",
  "127.0.0.1",
  "Xshell",
]);

function validatePluginHandoff(config, contractText = "") {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { schemaVersion: 1, status: "failed", errors: ["handoff must be an object"], warnings };
  }

  if (config.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  assertEqual(config, "containerName", "codex-linux-dev", errors);
  assertEqual(config, "hostWorkspaceRoot", "D:\\GitRepo", errors);
  assertEqual(config, "containerWorkspaceRoot", "/workspaces", errors);
  assertEqual(config, "workspaceUriScheme", "vscode-remote", errors);
  assertRecord(config, "extensionHosts", REQUIRED_EXTENSION_HOSTS, errors);
  assertRecord(config, "pathSettings", REQUIRED_PATH_SETTINGS, errors);

  if (typeof config.containerUser !== "string" || config.containerUser.trim() === "") {
    warnings.push("containerUser is not declared; non-root runtime needs experiment");
  } else if (config.containerUser.trim().toLowerCase() === "root") {
    warnings.push("containerUser=root violates the non-root runtime requirement");
  }

  for (const marker of REQUIRED_CONTRACT_MARKERS) {
    if (!contractText.includes(marker)) {
      errors.push(`PLUGIN-HANDOFF.md missing marker: ${marker}`);
    }
  }

  return {
    schemaVersion: 1,
    status: errors.length > 0 ? "failed" : warnings.length > 0 ? "needs_experiment" : "passed",
    errors,
    warnings,
  };
}

function assertEqual(config, field, expected, errors) {
  if (config[field] !== expected) {
    errors.push(`${field} must equal ${expected}`);
  }
}

function assertRecord(config, field, expected, errors) {
  const actual = config[field];
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    errors.push(`${field} must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      errors.push(`${field}.${key} must equal ${value}`);
    }
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function exitCodeForStatus(status) {
  if (status === "passed") {
    return 0;
  }
  return status === "needs_experiment" ? 3 : 1;
}

if (require.main === module) {
  const handoffPath = readArg("--handoff");
  const contractPath = readArg("--contract");
  if (!handoffPath || !contractPath) {
    console.error("Usage: node scripts/plugin-handoff.js --handoff <json> --contract <md>");
    process.exitCode = 2;
  } else {
    try {
      const config = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
      const contractText = fs.readFileSync(contractPath, "utf8");
      const result = validatePluginHandoff(config, contractText);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = exitCodeForStatus(result.status);
    } catch (error) {
      console.error(`Failed to read plugin handoff: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { exitCodeForStatus, validatePluginHandoff };
