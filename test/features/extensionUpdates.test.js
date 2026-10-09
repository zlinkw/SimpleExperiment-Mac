const assert = require("node:assert/strict");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const {
  compareSemanticVersions,
  componentUpdate,
  refreshStoredPluginUpdatePlan,
  planPairedUpdates,
} = require("../../dist/features/ExtensionUpdates");

const fs = require("node:fs");
const path = require("node:path");

const panelSource = readSource("src/ui/PanelHtml.ts");
const extensionSource = readSource("src/extension.ts");

function release(version, names = [`simple-${version}.vsix`, `simple-${version}.vsix.sha256`]) {
  return {
    tagName: `v${version}`,
    htmlUrl: `https://example.com/releases/v${version}`,
    assets: names.map((name) => ({ name, browser_download_url: `https://example.com/${name}`, size: 1 })),
  };
}

test("release versions use semantic comparison and ignore the optional v prefix", () => {
  assert.equal(compareSemanticVersions("0.4.7", "0.4.6"), 1);
  assert.equal(compareSemanticVersions("v0.4.7", "0.4.7"), 0);
  assert.equal(compareSemanticVersions("0.4.10", "0.4.9"), 1);
  assert.equal(
    compareSemanticVersions(
      componentUpdate("id", "repo", "SimpleExperiment", "0.4.11", release("SimpleExperiment 0.4.10"), "simple-experiment").latestVersion,
      "0.4.11",
    ),
    -1,
  );
});

test("SemVer comparison uses the explicitly packaged runtime closure", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, "../../dist/vendor/semver/package.json"), "utf8"));
  assert.equal(bundled.version, manifest.dependencies.semver);
  const { collectLocalRuntimeClosure } = require("../../scripts/runtime-closure");
  const closure = collectLocalRuntimeClosure(path.join(__dirname, "../.."), ["dist/features/ExtensionUpdates.js"]);
  assert.ok(closure.some(item => item.file === "dist/vendor/semver/functions/compare.js"));
  assert.ok(fs.existsSync(path.join(__dirname, "../../dist/vendor/semver/LICENSE")));
  const precedence = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 1; i < precedence.length; i++) assert.equal(compareSemanticVersions(precedence[i - 1], precedence[i]), -1);
  assert.equal(compareSemanticVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.throws(() => compareSemanticVersions("1.0.0-01", "1.0.0"), /无效/);
});

test("paired update plan requires VSIX assets from both releases", () => {
  const experiment = componentUpdate("simple-local.simple-experiment", "zlinkw/SimpleExperiment", "SimpleExperiment", "0.4.6", release("0.4.7", ["simple-experiment-0.4.7.vsix", "simple-experiment-0.4.7.vsix.sha256"]), "simple-experiment");
  const sftp = componentUpdate("simple-local.simple-sftp", "zlinkw/SimpleSFTP", "SimpleSFTP", "0.2.5", release("0.2.6", ["simple-sftp-0.2.6.vsix", "simple-sftp-0.2.6.vsix.sha256"]), "simple-sftp");
  const plan = planPairedUpdates(experiment, sftp);
  assert.equal(plan.status, "update_available");
  assert.equal(plan.experiment.vsix.name, "simple-experiment-0.4.7.vsix");
  assert.equal(plan.sftp.checksum.name, "simple-sftp-0.2.6.vsix.sha256");

  const missingAsset = componentUpdate("id", "repo", "Broken", "1.0.0", { tagName: "v1.1.0", assets: [] }, "broken");
  assert.equal(planPairedUpdates(missingAsset, sftp).status, "error");
});

test("stored update plans are refreshed against installed versions", () => {
  const experiment = componentUpdate("simple-local.simple-experiment", "zlinkw/SimpleExperiment", "SimpleExperiment", "0.4.9", release("0.4.10", ["simple-experiment-0.4.10.vsix", "simple-experiment-0.4.10.vsix.sha256"]), "simple-experiment");
  const sftp = componentUpdate("simple-local.simple-sftp", "zlinkw/SimpleSFTP", "SimpleSFTP", "0.2.6", release("0.2.7", ["simple-sftp-0.2.7.vsix", "simple-sftp-0.2.7.vsix.sha256"]), "simple-sftp");
  const stored = planPairedUpdates(experiment, sftp);
  const refreshed = refreshStoredPluginUpdatePlan(stored, (id) => id.includes("experiment") ? "0.4.10" : "0.2.7");

  assert.equal(refreshed.status, "up_to_date");
  assert.equal(refreshed.experiment.updateAvailable, false);
  assert.equal(refreshed.sftp.updateAvailable, false);
  assert.equal(refreshed.checkedAt, stored.checkedAt);

  const newerExperiment = componentUpdate("simple-local.simple-experiment", "zlinkw/SimpleExperiment", "SimpleExperiment", "0.4.10", release("0.4.11", ["simple-experiment-0.4.11.vsix", "simple-experiment-0.4.11.vsix.sha256"]), "simple-experiment");
  const partial = refreshStoredPluginUpdatePlan(planPairedUpdates(newerExperiment, sftp), (id) => id.includes("experiment") ? "0.4.10" : "0.2.7");

  assert.equal(partial.status, "update_available");
  assert.equal(partial.experiment.updateAvailable, true);
  assert.equal(partial.sftp.updateAvailable, false);
});

test("update card hides installation when the installed versions are current", () => {
  assert.match(panelSource, /storedStatus === "update_available" && !hasStoredUpdate \? "up_to_date" : storedStatus/);
  assert.match(panelSource, /canInstall = status === "update_available" && hasStoredUpdate/);
  assert.match(panelSource, /\(canInstall \? '<button data-command="installPluginUpdates"/);
  assert.match(panelSource, /当前已是最新版本；更新来源为两个仓库的 GitHub Latest Release。/);
});

test("local API update commands return their plans directly", () => {
  assert.match(extensionSource, /if \(command === "checkPluginUpdates"\)\s*return await this\.checkPluginUpdates\(params\.manual === true\);/);
  assert.match(extensionSource, /if \(command === "installPluginUpdates"\)\s*return await this\.installPluginUpdates\(\);/);
});

test("paired plugin update requires installation and reload as one user choice", () => {
  assert.match(extensionSource, /安装并重载窗口以应用配套插件更新/);
  assert.match(extensionSource, /"安装并重载", "取消"/);
  assert.match(extensionSource, /this\.forceReloadRequired = true;[\s\S]{0,160}this\.showPanelReloadRequired\(\);[\s\S]{0,140}workbench\.action\.reloadWindow/);
  assert.match(panelSource, /title="安装 SimpleExperiment 和 SimpleSFTP 更新，并重载窗口以应用"\>安装并重载/);
});
