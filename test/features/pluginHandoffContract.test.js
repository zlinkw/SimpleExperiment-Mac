const assert = require("node:assert/strict");
const test = require("node:test");

const { exitCodeForStatus, validatePluginHandoff } = require("../../scripts/plugin-handoff");

const contract = [
  'process.platform === "win32"',
  "D:\\GitRepo",
  "/workspaces/<relative-path>",
  "vscode-remote",
  "127.0.0.1",
  "Xshell",
].join("\n");

function createConfig(containerUser = "codex") {
  return {
    schemaVersion: 1,
    containerName: "codex-linux-dev",
    hostWorkspaceRoot: "D:\\GitRepo",
    containerWorkspaceRoot: "/workspaces",
    workspaceUriScheme: "vscode-remote",
    containerUser,
    extensionHosts: {
      "openai.chatgpt": "workspace",
      "simple-local.simple-experiment": "ui",
      "simple-local.simple-sftp": "ui",
    },
    pathSettings: {
      clusterHostRoot: "simpleExperiment.workspaceHostRoot",
      clusterContainerRoot: "simpleExperiment.workspaceContainerRoot",
      sftpHostRoot: "simpleSftp.workspaceHostRoot",
      sftpContainerRoot: "simpleSftp.workspaceContainerRoot",
    },
  };
}

test("valid non-root handoff passes while unknown fields remain compatible", () => {
  const result = validatePluginHandoff({ ...createConfig(), futureField: true }, contract);

  assert.equal(result.status, "passed");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("root handoff is never reported as compatibility passed", () => {
  const result = validatePluginHandoff(createConfig("root"), contract);

  assert.equal(result.status, "needs_experiment");
  assert.match(result.warnings.join("\n"), /non-root/);
  assert.notEqual(exitCodeForStatus(result.status), 0);
});

test("invalid path contract fails before compatibility work", () => {
  const config = createConfig();
  config.containerWorkspaceRoot = "/wrong-root";

  const result = validatePluginHandoff(config, contract.replace("127.0.0.1", "localhost"));

  assert.equal(result.status, "failed");
  assert.notEqual(exitCodeForStatus(result.status), 0);
  assert.match(result.errors.join("\n"), /containerWorkspaceRoot/);
  assert.match(result.errors.join("\n"), /127\.0\.0\.1/);
});
