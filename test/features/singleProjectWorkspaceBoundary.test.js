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
    // 契约：断言失败统一以 errorMessage 包装为“无法使用当前工作区”，沙箱提供生产同款提取器。
    errorMessage: (error) => String((error && error.message) || error),
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
  // Mac 契约：本地工作区宿主路径即 POSIX 绝对路径（hostPathApi=Mac 宿主），Windows 盘符映射形态属退役模型。
  const one = [{ uri: { scheme: "file", path: "/Users/zlk/projects/demo", fsPath: "/Users/zlk/projects/demo" } }];
  assert.equal(checker(one)("上传项目代码"), "/Users/zlk/projects/demo");
  const many = [one[0], { uri: { fsPath: "/Users/zlk/projects/other" } }];
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

test("remote workspace operations fail closed on non-Windows hosts and never execute host writes", () => {
  // Mac 契约重述（退役 Windows WSL 盘符映射执行模型）：即便映射配置合法，
  // platform==="darwin" 时远程工作区必须被拒绝执行宿主操作（Windows 折叠语义不再借用）。
  const remote = [{
    uri: {
      scheme: "vscode-remote",
      path: "/workspaces/MCP/demo",
      fsPath: "/workspaces/MCP/demo",
      toString: () => "vscode-remote://dev-container/workspaces/MCP/demo",
    },
  }];
  const sandbox = {
    process: { platform: "darwin" },
    // 契约：断言失败统一以 errorMessage 包装为“无法使用当前工作区”，沙箱提供生产同款提取器。
    errorMessage: (error) => String((error && error.message) || error),
    WorkspacePathMapper_1: require("../../dist/core/WorkspacePathMapper.js"),
    vscode: {
      workspace: {
        workspaceFolders: remote,
        getConfiguration: () => ({ get: (key) => key === "workspaceHostRoot" ? "/Users/zlk/GitRepo" : "/workspaces" }),
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
  assert.throws(() => sandbox.check("上传项目代码"), /远程工作区必须由 Windows UI Extension Host 执行/);
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
        // Mac 契约：宿主根为 POSIX 绝对路径（Mac 宿主即本机文件系统），Windows 盘符形态属退役模型。
        getConfiguration: () => ({ get: (key) => key === "workspaceHostRoot" ? "/Users/zlk/GitRepo" : "/workspaces" }),
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
