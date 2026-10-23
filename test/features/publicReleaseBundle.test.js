const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageScript = fs.readFileSync(path.join(root, "scripts/package-public.ps1"), "utf8");
const installScript = fs.readFileSync(path.join(root, "scripts/install-public-release.ps1"), "utf8");
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const vsixIgnore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");

test("public release declares paired SimpleSFTP dependency", () => {
  // Mac 适配：发布身份为 simple-experiment-mac / SimpleExperiment Mac，配套 simple-local.simple-sftp-mac。
  assert.equal(packageJson.name, "simple-experiment-mac");
  assert.equal(packageJson.displayName, "SimpleExperiment Mac");
  assert.equal(packageJson.__metadata, undefined);
  assert.ok(packageJson.extensionDependencies.includes("simple-local.simple-sftp-mac"));
});

test("public UI uses SimpleExperiment and SimpleSFTP names", () => {
  assert.match(extension, /hostCommand\("simpleExperimentMac\.quickSetup", "quick-setup", "检查服务器配置"/);
  assert.match(extension, /# 由 SimpleExperiment 生成/);
  assert.match(panel, /<title>SimpleExperiment<\/title>/);
  assert.match(panel, /通过 SimpleSFTP 按配置范围同步/);
  assert.doesNotMatch(panel, /ZLK SFTP Manager/);
});

test("public release package creates an offline paired installer", () => {
  assert.match(packageScript, /simple-sftp/);
  assert.match(packageScript, /simple-experiment/);
  assert.match(packageScript, /install-public-release\.ps1/);
  // 0.5.400 用户新契约：bundle 不再附带 setup 指南、不再生成 README，改为终端提示在线 URL。
  assert.doesNotMatch(packageScript, /Join-Path \$root "docs\\\\simple-experiment-setup\.md"/);
  assert.doesNotMatch(packageScript, /Join-Path \$bundle "README\.md"/);
  assert.match(packageScript, /https:\/\/github\.com\/zlinkw\/SimpleExperiment-Mac\/blob\/master\/docs\/simple-experiment-setup\.md/);
  assert.match(packageScript, /Write-Host[\s\S]{0,400}\$onlineGuideUrl/);
  assert.match(packageScript, /function Invoke-VscePackage/);
  assert.match(packageScript, /Release bundle already exists and will not be overwritten/);
  assert.doesNotMatch(packageScript, /Remove-Item/);
  assert.doesNotMatch(packageScript, /Copy-Item[^\r\n]*-Force/);
  assert.doesNotMatch(packageScript, /Set-Content/);
  assert.match(installScript, /simple-sftp-\*\.vsix/);
  assert.match(installScript, /simple-experiment-\*\.vsix/);
  assert.match(installScript, /\$sftp/);
  assert.match(installScript, /\$experiment/);
  assert.match(installScript, /--install-extension/);
});

test("public VSIX excludes local assistant state and rendered scratch files", () => {
  assert.match(vsixIgnore, /^\.claude\/\*\*$/m);
  assert.match(vsixIgnore, /^\.local-gpt\/\*\*$/m);
  assert.match(vsixIgnore, /^_\*\.html$/m);
  assert.match(vsixIgnore, /^dist\/runtime\/__pycache__\/\*\*$/m);
  assert.match(vsixIgnore, /^dist\/test\/\*\*$/m);
  assert.match(vsixIgnore, /^dist\/testing\/\*\*$/m);
  assert.match(vsixIgnore, /^zlk_cluster\/\*\*$/m);
  for (const recoveredArtifact of ["-First", "-Path", "-Raw", ".vscodeignore}else{'NO", "package.json)"]) {
    assert.doesNotMatch(vsixIgnore, new RegExp(`^${escapeRegExp(recoveredArtifact)}$`, "m"));
  }
});

test("shipped package excludes docs, dev tests, changelog and backups (2026-10-21 policy)", () => {
  assert.match(vsixIgnore, /^docs\/\*\*$/m);
  assert.match(vsixIgnore, /^tests\/\*\*$/m);
  assert.match(vsixIgnore, /^CHANGELOG\.md$/m);
  assert.match(vsixIgnore, /^\*\*\/\*\.patched$/m);
  // README.md 是 vsce 4.0.0 强制收录项（collectFiles 恒加 '!README.md'），只允许注释说明，不得伪装排除。
  assert.doesNotMatch(vsixIgnore, /^README\.md$/m);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
