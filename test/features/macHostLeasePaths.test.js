const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function darwinModule(file, extra = "") {
  const localRequire = createRequire(file), exports = {};
  const context = { module: { exports }, exports, process: { ...process, platform: "darwin", arch: "arm64" }, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => ["path", "node:path"].includes(name) ? { ...path.posix, posix: path.posix, win32: path.win32 } : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(file, "utf8") + extra, context, { filename: file });
  return context.module.exports;
}
test("Mac leases preserve POSIX labels and distinct case-sensitive registry ownership", () => {
  const legacy = darwinModule(path.resolve(__dirname, "../../dist/core/HostOperationLease.legacy.js"), "\nexports.sessionKey = sessionKey;");
  const manager = new legacy.LegacyHostOperationLeaseManager({ leasePath: "/tmp/lease", windowId: "test", heartbeatMs: 0 });
  const project = "/Users/test/研究 项目/Model/尾部 ";
  assert.equal(manager.createRecord({ pluginId: "mac", workspaceUri: "file:///test", hostProjectPath: project, actionType: "write" }).hostProjectPath, project);
  assert.notEqual(legacy.sessionKey("/tmp/Model/lease"), legacy.sessionKey("/tmp/model/lease"));
  const resource = darwinModule(path.resolve(__dirname, "../../dist/core/ResourceOperationLease.js"));
  const a = new resource.ResourceOperationLeaseManager({ leasePath: "/tmp/Model/lease", windowId: "test" });
  const b = new resource.ResourceOperationLeaseManager({ leasePath: "/tmp/model/lease", windowId: "test" });
  assert.notEqual(a.state, b.state);
  assert.equal(resource.resourceTargetsConflict([{server:"local",project:"/p",target:"/p/Model"}], [{server:"local",project:"/p",target:"/p/model"}]), false);
});
test("Mac business admission keeps the single workspace and native host boundary", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const start = source.indexOf("function currentHostOperationLeaseContext()");
  const end = source.indexOf("const EMPTY_WORKSPACE_FOLDERS_FOR_WEBVIEW", start);
  const folder = { uri: { toString: () => "file:///Users/test/研究%20项目" } };
  const sandbox = { process: {platform:"darwin",arch:"arm64"}, vscode: {workspace:{workspaceFolders:[folder]}},
    workspaceLocationForFolder: () => ({editorUri:folder.uri.toString(),hostPath:"/Users/test/研究 项目"}) };
  vm.createContext(sandbox); vm.runInContext(source.slice(start,end),sandbox);
  assert.equal(sandbox.currentHostOperationLeaseContext().hostProjectPath,"/Users/test/研究 项目");
  sandbox.vscode.workspace.workspaceFolders.push(folder); assert.throws(()=>sandbox.currentHostOperationLeaseContext(),/多个工作区/);
  sandbox.vscode.workspace.workspaceFolders.pop(); sandbox.process.arch="x64"; assert.throws(()=>sandbox.currentHostOperationLeaseContext(),/本地 UI/);
  sandbox.process.platform="linux"; assert.throws(()=>sandbox.currentHostOperationLeaseContext(),/本地 UI/);
});
