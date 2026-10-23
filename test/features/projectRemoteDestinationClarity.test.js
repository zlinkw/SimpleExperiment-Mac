const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");
const readme = fs.readFileSync(path.join(__dirname, "../../README.md"), "utf8");
const legacyNotes = fs.readFileSync(path.join(__dirname, "../../docs/technical-notes.md"), "utf8");
const guide = fs.readFileSync(path.join(__dirname, "../../docs/simple-experiment-setup.md"), "utf8");
const packageScript = fs.readFileSync(path.join(__dirname, "../../scripts/package-public.ps1"), "utf8");

function extractFunction(name) { return require('../_helpers/panelFunction')(name); }

test("settings show computed code and Agent runtime destinations for every server", () => {
  assert.match(panel, /function renderServerDestinationPreview\(agentState, scope\)/);
  assert.match(panel, /当前项目代码/);
  assert.match(panel, /Agent runtime/);
  assert.match(panel, /installDir \+ "\/simple_cluster\/runtime"/);
  assert.doesNotMatch(panel, /renderServerDestinationPreview\(hubAgent, "hub"\)/);
  assert.match(panel, /renderServerDestinationPreview\(workerAgent, scope\)/);
  assert.match(panel, /\.serverDestinationPreview code/);
  // Mac 适配：服务器区说明为 “Termius、端口、项目父目录”（Windows 为 “Xshell、…”）。
  assert.match(panel, /Termius、端口、项目父目录/);
  assert.match(panel, /configInput\(scope, "agentProjectDir", "项目父目录", worker\.agentProjectDir/);
  assert.match(panel, /登录后进入当前项目代码目录/);
  assert.doesNotMatch(panel, /\["工作目录", compactPath\(setup\.agentProjectDir/);
  assert.match(packageScript, /Invoke-VscePackage \$root \$experimentVsix/);
  assert.doesNotMatch(packageScript, /Set-Content[^\n]*settings\.json|hubAgentProjectDir|workerTunnels/);
});

test("editing a project parent root updates unsaved destination preview without changing saved state", () => {
  assert.match(panel, /function normalizeRemoteDestinationRoot\(value\)/);
  assert.match(panel, /function updateServerDestinationPreview\(input\)/);
  assert.match(panel, /function remoteDestinationRootIssue\(root, projectName\)/);
  assert.match(panel, /function remoteDestinationRootWarning\(root, projectName\)/);
  assert.match(panel, /function remoteDestinationParentRoot\(value\)/);
  assert.match(panel, /input\.dataset\.key !== "agentProjectDir"/);
  assert.match(panel, /root \+ "\/" \+ projectName/);
  assert.match(panel, /root \+ "\/simple_agent\/simple_cluster\/runtime"/);
  assert.match(panel, /未保存预览；点击保存服务器后生效/);
  assert.match(panel, /上传和 Agent 启动仍使用已保存配置/);
  assert.match(panel, /路径末级与项目名相同；[\s\S]{0,120}否则项目名会重复/);
  assert.match(panel, /不要填写 simple_agent；请填写它的父目录/);
  assert.match(panel, /classList\.toggle\("error", Boolean\(issue\)\)/);
  assert.ok([...panel.matchAll(/updateServerDestinationPreview\(input\)/g)].length >= 4);

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("normalizeRemoteDestinationRoot"),
    extractFunction("remoteDestinationParentRoot"),
    extractFunction("remoteDestinationRootWarning"),
    "this.parent = remoteDestinationParentRoot; this.warn = remoteDestinationRootWarning;",
  ].join("\n"), sandbox);
  assert.equal(sandbox.parent("/srv/projects/demo"), "/srv/projects");
  assert.match(sandbox.warn("/srv/projects/demo", "demo"), /建议改为 \/srv\/projects/);
  assert.equal(sandbox.warn("/srv/projects", "demo"), "");
});

test("project quick access summarizes upload destinations and refreshes after project changes", () => {
  assert.match(panel, /function renderServerDestinationPreview\(agentState, scope\)/);
  assert.match(panel, /section === "settings"[\s\S]{0,320}data\.agentSessions/);
  assert.match(legacyNotes, /设置 -> 服务器.*当前项目代码.*Agent runtime/);
});
