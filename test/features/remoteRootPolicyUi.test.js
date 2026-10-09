const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("remote root policies are exposed in the plugin settings page", () => {
  assert.equal(packageJson.contributes.configuration.properties["simpleExperiment.remote.allowedRoots"].scope, "resource");
  assert.equal(packageJson.contributes.configuration.properties["simpleExperiment.remote.deniedRoots"].scope, "resource");
  assert.match(panel, /<div id="remoteRootPolicySettings" data-anchor="settings-remote-root-policy"><\/div>/);
  assert.match(panel, /function renderRemoteRootPolicySettings\(state\)/);
  assert.doesNotMatch(panel, /settingsLayoutTools"[^>]*>\s*<b>远端根目录安全边界/);
  assert.match(panel, /class="remoteRootPolicy"/);
  assert.match(panel, /class="remoteRootPolicyFields"/);
  assert.match(panel, /data-key="allowedRoots"/);
  assert.match(panel, /data-key="deniedRoots"/);
  assert.match(panel, /<button class="secondary" data-command="saveRemoteRootPolicy"[^>]*>保存<\/button>/);
  assert.match(panel, /textarea\.remoteRootPolicyInput \{ width: 100%; height: 100%; min-height: 0;/);
  assert.match(extension, /remoteRootPolicy: remoteRootPolicyConfig\(\)/);
});

test("saving remote root policies writes the workspace configuration", () => {
  const start = extension.indexOf("async saveRemoteRootPolicyFromUi(message)");
  const end = extension.indexOf("async chooseResultCsvDirFromUi()", start);
  assert.ok(start >= 0 && end > start);
  const method = extension.slice(start, end);
  assert.match(method, /config\.update\("remote\.allowedRoots", allowedRoots, vscode\.ConfigurationTarget\.WorkspaceFolder\)/);
  assert.match(method, /config\.update\("remote\.deniedRoots", deniedRoots, vscode\.ConfigurationTarget\.WorkspaceFolder\)/);
  assert.match(method, /ApiWorkflow_1\.normalizeApiRemotePath\(item\)/);
});
