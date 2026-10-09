const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolveWorkspaceLocation } = require("../../dist/core/WorkspacePathMapper.js");

const mapping = {
  hostRoot: "D:\\GitRepo\\",
  containerRoot: "/workspaces/",
};

test("SimpleExperiment declares a Windows UI host and optional mapping settings", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  assert.deepEqual(packageJson.extensionKind, ["ui"]);
  assert.equal(packageJson.contributes.configuration.properties["simpleExperiment.workspaceHostRoot"].default, "");
  assert.equal(packageJson.contributes.configuration.properties["simpleExperiment.workspaceContainerRoot"].default, "");
});

test("workspace path mapping preserves Windows file workspaces", () => {
  const result = resolveWorkspaceLocation({
    scheme: "file",
    path: "/D:/GitRepo/demo",
    fsPath: "D:/GitRepo/demo/",
    external: "file:///D:/GitRepo/demo",
  });
  assert.deepEqual(result, {
    scheme: "file",
    editorUri: "file:///D:/GitRepo/demo",
    hostPath: "D:\\GitRepo\\demo\\",
    relativePath: "",
    remote: false,
  });
});

test("workspace path mapping keeps the remote editor URI and maps nested host paths", () => {
  const result = resolveWorkspaceLocation({
    scheme: "vscode-remote",
    path: "/workspaces/MCP/simple-experiment",
    fsPath: "/workspaces/MCP/simple-experiment",
    external: "vscode-remote://dev-container+abc/workspaces/MCP/simple-experiment",
  }, mapping);
  assert.equal(result.editorUri, "vscode-remote://dev-container+abc/workspaces/MCP/simple-experiment");
  assert.equal(result.hostPath, "D:\\GitRepo\\MCP\\simple-experiment");
  assert.equal(result.relativePath, "MCP/simple-experiment");
  assert.equal(result.remote, true);
});

test("workspace path mapping accepts the configured container root itself", () => {
  const result = resolveWorkspaceLocation({
    scheme: "vscode-remote",
    path: "/workspaces/",
    fsPath: "/workspaces/",
  }, mapping);
  assert.equal(result.hostPath, "D:\\GitRepo");
  assert.equal(result.relativePath, "");
});

test("workspace path mapping requires explicit remote root settings", () => {
  const uri = { scheme: "vscode-remote", path: "/workspaces/demo", fsPath: "/workspaces/demo" };
  assert.throws(() => resolveWorkspaceLocation(uri, {}), /simpleExperiment\.workspaceHostRoot/);
  assert.throws(() => resolveWorkspaceLocation(uri, { hostRoot: "D:\\GitRepo" }), /simpleExperiment\.workspaceContainerRoot/);
  assert.throws(() => resolveWorkspaceLocation({ ...uri, scheme: "untitled" }, mapping), /不支持的工作区 URI scheme/);
});

test("workspace path mapping rejects traversal and path injection", () => {
  const invalidPaths = [
    "/workspaces/../secret",
    "/workspaces/%2e%2e/secret",
    "/workspaces/%252e%252e/secret",
    "/workspaces%2f..%2fsecret",
    "/other/demo",
    "/workspaces/C:/temp",
    "//server/share",
    "/workspaces/demo\\evil",
    "/workspaces/demo\0evil",
    "/workspaces/demo%00evil",
    "/workspaces/demo%255cevil",
  ];
  for (const remotePath of invalidPaths) {
    assert.throws(() => resolveWorkspaceLocation({
      scheme: "vscode-remote",
      path: remotePath,
      fsPath: remotePath,
    }, mapping), undefined, remotePath);
  }
  assert.throws(() => resolveWorkspaceLocation({
    scheme: "vscode-remote",
    path: "/workspaces/demo",
    fsPath: "/workspaces/demo",
  }, { ...mapping, hostRoot: "\\\\server\\share" }), /Windows 盘符绝对路径/);
});
