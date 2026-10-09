const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const api = require("../../dist/features/ApiWorkflow");
const posix = require("../../dist/mac/PosixPath");
const manual = require("../../dist/mac/ManualTunnel");
const compiled = fs.readFileSync(path.resolve(__dirname, "../../dist/extension/legacy.js"), "utf8");

function helper(name, globals = {}) {
  const start = compiled.indexOf("function " + name + "("); assert.ok(start >= 0, name);
  const tail = compiled.slice(start), end = tail.slice(1).search(/^function /m) + 1;
  assert.ok(end > 0, name);
  return vm.runInNewContext(tail.slice(0, end) + "; " + name, { ApiWorkflow_1: api, ...globals });
}
function method(name, globals = {}) {
  const start = compiled.search(new RegExp("^    (?:async )?" + name + "\\(", "m")); assert.ok(start >= 0, name);
  const tail = compiled.slice(start), end = tail.slice(1).search(/^    (?:async )?[a-zA-Z][a-zA-Z0-9_]*\(/m) + 1;
  return vm.runInNewContext("({" + tail.slice(0, end) + "})", { ApiWorkflow_1: api, ...globals })[name];
}

test("POSIX paths retain case, Chinese, Unicode spelling and leading/trailing leaf spaces", () => {
  const root = "/data/研究目录/ Model ";
  assert.equal(posix.normalizePosixAbsolutePath(root + "///"), root);
  assert.equal(api.normalizeApiRemotePath(root), root);
  assert.equal(api.remoteProjectWorkDir(root, " 实验 A "), root + "/ 实验 A ");
  assert.notEqual(posix.normalizePosixAbsolutePath("/data/Model"), posix.normalizePosixAbsolutePath("/data/model"));
  assert.notEqual(posix.normalizePosixAbsolutePath("/data/é"), posix.normalizePosixAbsolutePath("/data/e\u0301"));
  for (const value of ["C:\\data", "relative/path", " /data/path", "//host/path", "/data/../other", "/data/./other", "/data\\other", "/data\nother", "/data\0other", 123])
    assert.throws(() => posix.normalizePosixAbsolutePath(value), /POSIX/);
  assert.throws(() => posix.normalizePosixAbsolutePath("/"), /根目录/);
  for (const name of ["../project", ".", "..", "a/b", "a\\b", "a\n"]) assert.throws(() => api.remoteProjectWorkDir(root, name));
});

test("allowed and denied roots use exact POSIX case and child boundaries; malformed rules fail closed", () => {
  const policy = { allowedRoots: ["/data/研究/Model "], deniedRoots: ["/data/研究/Model /Secret"] };
  assert.equal(api.resolveApiRemoteRootWithPolicy("/data/研究/Model /secret", {}, policy), "/data/研究/Model /secret");
  assert.throws(() => api.resolveApiRemoteRootWithPolicy("/data/研究/Model /Secret/child", {}, policy), /禁止/);
  for (const root of ["/data/研究/model ", "/data/研究/Model", "/data/研究/Model X"])
    assert.throws(() => api.resolveApiRemoteRootWithPolicy(root, {}, policy), /allowedRoots/);
  for (const allowedRoots of ["/data", [""], ["/"], ["relative"], ["/data/../other"], ["C:\\data"]])
    assert.throws(() => api.resolveApiRemoteRootWithPolicy("/data/project", {}, { allowedRoots }));
  assert.equal(api.remoteRootMigrationHint("/Data/Simple", ["/data/zlk"]), undefined);
  assert.equal(api.remoteRootMigrationHint("/Data/simple", ["/data/zlk"]), undefined);
  assert.match(api.remoteRootMigrationHint("/Data/simple", ["/Data/zlk"]), /历史命名/);
});

test("real root policy reader and runtime/Agent helpers retain the same exact paths", () => {
  const policy = { allowedRoots: ["/Data/研究 "], deniedRoots: ["/Data/研究 /private"] };
  const readPolicy = helper("remoteRootPolicyConfig", { vscode: { workspace: { getConfiguration: () => ({ get: key => policy[key.split(".")[1]] }) } } });
  assert.equal(readPolicy().allowedRoots[0], "/Data/研究 ");
  const root = "/Data/研究 ", projectName = " 实验 A ", install = "/Data/runtime ";
  const dirs = method("agentRuntimeDirs", { remoteProjectName: () => projectName, normalizeRemoteWorkRoot: api.normalizeApiRemotePath }).call({}, root, install);
  assert.equal(dirs.workRoot, root); assert.equal(dirs.workDir, root + "/" + projectName); assert.equal(dirs.installDir, install);
  assert.throws(() => method("agentRuntimeDirs", { remoteProjectName: () => projectName, normalizeRemoteWorkRoot: api.normalizeApiRemotePath }).call({}, root, "/"), /runtime/);
  assert.equal(helper("normalizeCondaEnvSetting")("/opt/环境 "), "/opt/环境 ");
  assert.equal(helper("remoteProjectName", { path: path.posix, workspaceRoot: () => "/Users/test/ 实验 A " })(), projectName);
  const normalized = helper("normalizeAgentProjectRoot");
  const checked = helper("enforceExpectedAgentProjectRoot", { normalizeAgentProjectRoot: normalized, ENDPOINT_READY_PROBE_STATUSES: new Set(["ok"]) });
  assert.equal(checked({ status: "ok", projectRoot: dirs.workDir }, dirs.workDir, "Worker").status, "ok");
  for (const actual of [dirs.workDir.trimEnd(), dirs.workDir.replace("Data", "data"), "/Data/研究 /../wrong"])
    assert.equal(checked({ status: "ok", projectRoot: actual }, dirs.workDir, "Worker").status, "agent_project_mismatch");
});

test("root-policy UI refuses malformed nonblank lines before any setting mutation", async () => {
  const updates = [], provider = { captureProjectContext: () => ({}), projectContextIsCurrent: () => true, postState() {} };
  provider.saveRemoteRootPolicyFromUi = method("saveRemoteRootPolicyFromUi", {
    recordField: (record, key) => record[key], vscode: { ConfigurationTarget: { WorkspaceFolder: 3 }, workspace: {
      workspaceFolders: [{ uri: "file:///Users/test/project" }], getConfiguration: () => ({ update: async (key, value) => updates.push({ key, value }) }),
    }, window: { showInformationMessage: async () => {} } },
  });
  for (const value of ["/", "//data", "relative", "/data/../other", "/data\\other"])
    await assert.rejects(provider.saveRemoteRootPolicyFromUi({ patch: { allowedRoots: value, deniedRoots: "" } }));
  assert.equal(updates.length, 0);
  await provider.saveRemoteRootPolicyFromUi({ patch: { allowedRoots: "/Data/研究 \n\n", deniedRoots: "/Data/研究 /Private" } });
  assert.equal(updates[0].value[0], "/Data/研究 "); assert.equal(updates[1].value[0], "/Data/研究 /Private");
});

test("actual three-topology preview and uploads match manual guide paths with Chinese and edge spaces", async () => {
  const file = path.resolve(__dirname, "macProjectPrepare.test.js"), localRequire = createRequire(file), module = { exports: {} };
  // Reuse the real-provider fixture without registering or running its other tests.
  vm.runInNewContext(fs.readFileSync(file, "utf8") + "\nmodule.exports = { fixture };", {
    require: name => name === "node:test" ? () => {} : localRequire(name), module, __dirname: path.dirname(file), Buffer, console,
  }, { filename: file });
  for (const mode of ["single_worker", "worker_pool", "hub_worker"]) {
    const f = module.exports.fixture(mode), projectName = " 实验 A "; f.setRoot("/Users/test/" + projectName);
    const endpoints = manual.endpointsFromSetup(f.provider.setupConfig).map(endpoint => ({ ...endpoint,
      projectParentDir: "/Data/研究 " + endpoint.id + " ", agentInstallDir: "/Data/runtime " + endpoint.id + " ", condaEnv: "/opt/环境 " }));
    f.provider.setupConfig = manual.setupFromManualEndpoints(endpoints);
    f.provider.agentRuntimeDirs = method("agentRuntimeDirs", { remoteProjectName: () => projectName, normalizeRemoteWorkRoot: api.normalizeApiRemotePath });
    await assert.rejects(f.provider.apiProjectPrepare({}), error => {
      assert.equal(error.apiCode, 2001); assert.equal(error.apiData.preview.workspace, "/Users/test/" + projectName);
      for (const target of error.apiData.preview.servers) assert.equal(target.workDir, endpoints.find(endpoint => endpoint.id === target.serverId).projectParentDir + "/" + projectName);
      return true;
    });
    const result = await f.provider.apiProjectPrepare({ confirm: true });
    for (const endpoint of endpoints) {
      const workDir = endpoint.projectParentDir + "/" + projectName;
      assert.ok(result.manualStart.guide.includes(workDir)); assert.ok(result.manualStart.guide.includes(endpoint.agentInstallDir));
      assert.ok(f.uploads.some(upload => upload.command.endsWith("uploadWorkspace") && upload.args.remotePath === workDir));
      assert.ok(f.uploads.some(upload => upload.command.endsWith("uploadFiles") && upload.args.remotePath === endpoint.agentInstallDir + "/simple_cluster/runtime"));
    }
  }
  for (const directory of ["/root/", "/tmp///", "//data", "/data/../other"]) {
    const point = { ...manual.endpointsFromSetup(module.exports.fixture().provider.setupConfig)[0], projectParentDir: directory };
    assert.throws(() => manual.setupFromManualEndpoints([point]));
  }
});
