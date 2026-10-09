const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function checker(folders) {
  const sandbox = {
    process: { platform: "win32" },
    WorkspacePathMapper_1: require("../../dist/core/WorkspacePathMapper.js"),
    vscode: { workspace: { workspaceFolders: folders } },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("workspaceMappingConfig"),
    extractFunction("workspaceLocationForFolder"),
    extractFunction("assertSingleProjectWorkspace"),
    "this.check = assertSingleProjectWorkspace;",
  ].join("\n"), sandbox);
  return sandbox.check;
}

test("remote project operations require exactly one workspace folder", () => {
  assert.throws(() => checker([])("上传项目代码"), /需要先打开一个本地实验项目/);
  const one = [{ uri: { scheme: "file", path: "/D:/projects/demo", fsPath: "D:/projects/demo" } }];
  assert.equal(checker(one)("上传项目代码"), "D:\\projects\\demo");
  const many = [one[0], { uri: { fsPath: "D:/projects/other" } }];
  assert.throws(() => checker(many)("上传项目代码"), /检测到 2 个工作区文件夹/);
  assert.throws(() => checker(many)("上传项目代码"), /独立 VS Code 窗口中只打开目标实验项目/);
});

test("webview state exposes the local project identity and workspace count", () => {
  assert.match(source, /const workspace = workspaceContextForWebview\(\)/);
  assert.match(source, /workspace,\s*topology,\s*setup: compactXshellSetupForWebview/);
  assert.match(source, /function workspaceContextForWebview\(\)/);
  assert.match(source, /editorUri: location\?\.editorUri/);
  assert.match(source, /containerPath: location\?\.remote/);
  assert.match(source, /mappingError/);
  assert.match(source, /folderCount: folders\.length/);
  assert.match(source, /singleProject: folders\.length === 1/);
});

test("remote workspace operations resolve Windows host paths and preserve editor URI", () => {
  const remote = [{
    uri: {
      scheme: "vscode-remote",
      path: "/workspaces/MCP/demo",
      fsPath: "/workspaces/MCP/demo",
      toString: () => "vscode-remote://dev-container/workspaces/MCP/demo",
    },
  }];
  const sandbox = {
    process: { platform: "win32" },
    WorkspacePathMapper_1: require("../../dist/core/WorkspacePathMapper.js"),
    vscode: {
      workspace: {
        workspaceFolders: remote,
        getConfiguration: () => ({ get: (key) => key === "workspaceHostRoot" ? "D:\\GitRepo" : "/workspaces" }),
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("workspaceMappingConfig"),
    extractFunction("workspaceLocationForFolder"),
    extractFunction("assertSingleProjectWorkspace"),
    "this.check = assertSingleProjectWorkspace;",
  ].join("\n"), sandbox);
  assert.equal(sandbox.check("上传项目代码"), "D:\\GitRepo\\MCP\\demo");
});

test("workspace file opening keeps the remote URI instead of converting to file URI", () => {
  const remoteUri = {
    scheme: "vscode-remote",
    path: "/workspaces/MCP/demo",
    fsPath: "/workspaces/MCP/demo",
    toString: () => "vscode-remote://dev-container/workspaces/MCP/demo",
  };
  const sandbox = {
    WorkspacePathMapper_1: require("../../dist/core/WorkspacePathMapper.js"),
    vscode: {
      workspace: {
        workspaceFolders: [{ uri: remoteUri }],
        getConfiguration: () => ({ get: (key) => key === "workspaceHostRoot" ? "D:\\GitRepo" : "/workspaces" }),
      },
      Uri: {
        joinPath: (uri, ...segments) => ({ scheme: uri.scheme, path: [uri.path, ...segments].join("/") }),
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("workspaceMappingConfig"),
    extractFunction("workspaceLocationForFolder"),
    extractFunction("workspaceEditorUriForFile"),
    "this.open = workspaceEditorUriForFile;",
  ].join("\n"), sandbox);
  assert.deepEqual(sandbox.open("results/metrics.csv"), {
    scheme: "vscode-remote",
    path: "/workspaces/MCP/demo/results/metrics.csv",
  });
});
