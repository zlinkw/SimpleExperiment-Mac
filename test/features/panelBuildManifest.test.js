const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { collectLocalRuntimeClosure } = require("../../scripts/runtime-closure");
const { createPanelBuildManifest } = require("../../scripts/panel-build-manifest");

const root = path.resolve("C:/panel-manifest-fixture");
const baseFiles = {
  "dist/extension.js": 'module.exports = require("./extension/legacy");',
  "dist/extension/legacy.js": [
    'require("../features/PanelBuildIdentity");',
    'require("../features/PanelLifecycle");',
    'require("../features/PanelStateDelivery");',
    'require("../features/PanelStateProgress");',
  ].join("\n"),
  "dist/ui/PanelHtml.js": 'module.exports = require("./PanelHtml.legacy");',
  "dist/ui/PanelHtml.legacy.js": "module.exports = 'panel A';",
  "dist/ui/PanelRecoveryHtml.js": "module.exports = 'recovery';",
  "dist/cli.js": "module.exports = {};",
  "dist/features/PanelBuildIdentity.js": "module.exports = {};",
  "dist/features/PanelLifecycle.js": "module.exports = {};",
  "dist/features/PanelStateDelivery.js": "module.exports = {};",
  "dist/features/PanelStateProgress.js": "module.exports = {};",
  "scripts/check-static.js": "module.exports = {};",
};

function createFs(contents) {
  const normalize = (value) => path.relative(root, value).replaceAll("\\", "/");
  return {
    statSync(value) { if (!(normalize(value) in contents)) throw new Error("ENOENT"); return { isFile: () => true }; },
    readFileSync(value) { const key = normalize(value); if (!(key in contents)) throw new Error("ENOENT"); return contents[key]; },
  };
}

function createManifest(contents) {
  const fsApi = createFs(contents);
  const closure = collectLocalRuntimeClosure(root, ["dist/extension.js", "dist/ui/PanelHtml.js", "dist/ui/PanelRecoveryHtml.js", "dist/cli.js"], ["scripts/check-static.js"], fsApi);
  return { closure, manifest: createPanelBuildManifest("0.5.200", closure.map(({ file }) => ({ path: file, content: contents[file] }))) };
}

test("runtime manifest follows actual extension and panel implementation modules", () => {
  const { closure, manifest } = createManifest({ ...baseFiles });
  const included = new Set(manifest.manifest.files.map((row) => row.path));
  for (const file of [
    "dist/extension.js", "dist/extension/legacy.js", "dist/ui/PanelHtml.js", "dist/ui/PanelHtml.legacy.js",
    "dist/ui/PanelRecoveryHtml.js", "dist/features/PanelBuildIdentity.js", "dist/features/PanelLifecycle.js",
    "dist/features/PanelStateDelivery.js", "dist/features/PanelStateProgress.js",
  ]) assert.ok(included.has(file), `${file} must be in the manifest`);
  assert.equal(closure.length, included.size);
  assert.equal(manifest.manifest.buildId.length, 64);
  assert.equal(manifest.manifestHash.length, 64);
});

for (const changed of ["dist/ui/PanelHtml.legacy.js", "dist/extension/legacy.js", "dist/features/PanelLifecycle.js"]) {
  test(`changing only ${changed} changes manifest buildId while facades remain unchanged`, () => {
    const before = createManifest({ ...baseFiles });
    const nextFiles = { ...baseFiles, [changed]: `${baseFiles[changed]}\n// rebuilt` };
    const after = createManifest(nextFiles);
    assert.equal(nextFiles["dist/extension.js"], baseFiles["dist/extension.js"]);
    assert.equal(nextFiles["dist/ui/PanelHtml.js"], baseFiles["dist/ui/PanelHtml.js"]);
    assert.notEqual(after.manifest.manifest.buildId, before.manifest.manifest.buildId);
    assert.notEqual(after.manifest.manifestHash, before.manifest.manifestHash);
  });
}
