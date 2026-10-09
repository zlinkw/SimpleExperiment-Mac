const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadWorkspaceContext() {
  const sandbox = {
    path,
    mapping: { hostRoot: "D:/GitRepo", containerRoot: "/workspaces", remoteScheme: "vscode-remote" },
    locationCalls: 0,
    EMPTY_WORKSPACE_FOLDERS_FOR_WEBVIEW: Object.freeze([]),
    workspaceContextForWebviewCacheFolders: undefined,
    workspaceContextForWebviewCacheMappingKey: "",
    workspaceContextForWebviewCacheValue: undefined,
    vscode: { workspace: { workspaceFolders: [] } },
    workspaceMappingConfig() { return { ...sandbox.mapping }; },
    workspaceLocationForFolder(folder, mapping) {
      sandbox.locationCalls += 1;
      if (folder && folder.fail) throw new Error("mapping failed");
      return folder ? { hostPath: folder.hostPath, editorUri: folder.uri.toString(), remote: Boolean(mapping.containerRoot) } : undefined;
    },
    errorMessage(error) { return String(error.message || error); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("workspaceContextForWebview")}\nthis.check = workspaceContextForWebview;`, sandbox);
  return sandbox;
}

function loadOnboarding() {
  const sandbox = {
    path,
    EMPTY_PROJECT_ONBOARDING_SOURCE: Object.freeze({}),
    projectOnboardingStateForWebviewCache: new WeakMap(),
    serverSetupMissingItems(setup) {
      const missing = [];
      if (!setup.savedSessionPath) missing.push("Hub Xshell 会话");
      if (!setup.agentProjectDir) missing.push("Hub 项目父目录");
      return missing;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("projectOnboardingStateForWebview")}\nthis.check = projectOnboardingStateForWebview;`, sandbox);
  return sandbox;
}

function folder(name = "Demo") {
  return {
    hostPath: `D:/GitRepo/${name}`,
    uri: { path: `/workspaces/${name}`, toString: () => `vscode-remote://${name}` },
  };
}

test("workspace Webview context reuses stable folders and mapping config", () => {
  const sandbox = loadWorkspaceContext();
  const folders = [folder()];
  sandbox.vscode.workspace.workspaceFolders = folders;
  const first = sandbox.check();

  assert.strictEqual(sandbox.check(), first);
  assert.equal(sandbox.locationCalls, 1);
  assert.equal(first.root, "D:/GitRepo/Demo");
  assert.equal(first.singleProject, true);

  sandbox.mapping = { ...sandbox.mapping, hostRoot: "E:/Projects" };
  const mapping = sandbox.check();
  assert.notStrictEqual(mapping, first);
  assert.equal(sandbox.locationCalls, 2);

  sandbox.vscode.workspace.workspaceFolders = [folder("Other"), folder("Second")];
  const multiple = sandbox.check();
  assert.notStrictEqual(multiple, mapping);
  assert.equal(multiple.folderCount, 2);
  assert.equal(multiple.singleProject, false);
});

test("project onboarding state reuses stable sources and invalidates each input", () => {
  const sandbox = loadOnboarding();
  const workspace = { root: "D:/GitRepo/Demo", name: "Demo", singleProject: true };
  const setup = {
    savedSessionPath: "hub.xsh",
    agentProjectDir: "/srv/projects",
    workerTunnels: [{ id: "worker-a", enabled: true }],
  };
  const simpleSftp = { ready: true };
  const first = sandbox.check({ workspace, setup, simpleSftp, promptShown: 0, completed: false });

  assert.strictEqual(sandbox.check({ workspace, setup, simpleSftp, promptShown: 0, completed: false }), first);
  assert.equal(first.required, true);
  assert.equal(first.ready, true);

  const prompt = sandbox.check({ workspace, setup, simpleSftp, promptShown: 1, completed: false });
  assert.notStrictEqual(prompt, first);
  const completed = sandbox.check({ workspace, setup, simpleSftp, promptShown: 1, completed: true });
  assert.notStrictEqual(completed, prompt);
  assert.equal(completed.required, false);

  const sftp = sandbox.check({ workspace, setup, simpleSftp: { ready: false, message: "SimpleSFTP 未就绪" }, promptShown: 1 });
  assert.notStrictEqual(sftp, completed);
  assert.equal(sftp.blocked, true);

  const configuration = sandbox.check({ workspace, setup: { ...setup, workerTunnels: [] }, simpleSftp, promptShown: 1 });
  assert.notStrictEqual(configuration, sftp);
  assert.match(configuration.detail, /至少一个启用的执行 Worker/);

  const duplicate = sandbox.check({
    workspace,
    setup: { ...setup, savedSessionPath: "" },
    simpleSftp: { ready: false, message: "Hub Xshell 会话" },
    promptShown: 1,
  });
  assert.deepEqual(Array.from(duplicate.missing), ["Hub Xshell 会话"]);
  assert.equal((duplicate.detail.match(/Hub Xshell 会话/g) || []).length, 1);

  const noWorkspace = sandbox.check({ workspace: { ...workspace, root: "" }, setup, simpleSftp, promptShown: 1 });
  assert.notStrictEqual(noWorkspace, configuration);
  assert.equal(noWorkspace.required, false);
  assert.equal(noWorkspace.ready, false);
});

test("project onboarding derives the filtered missing item list once", () => {
  const onboarding = extractFunction("projectOnboardingStateForWebview");
  assert.equal((onboarding.match(/new Set\(missing\.filter\(Boolean\)\)/g) || []).length, 1);
  assert.match(onboarding, /const missingItems = \[\.\.\.new Set\(missing\.filter\(Boolean\)\)\];/);
  assert.match(onboarding, /const projectReady = hasProject && missingItems\.length === 0;/);
  assert.match(onboarding, /\$\{missingItems\.join\("、"\)\}/);
});
