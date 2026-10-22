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

test("runtime closure follows lazy factories, computed feature hints, worker entrypoints and require.resolve", () => {
  const contents = {
    'dist/entry.js': 'tryRequire("./factory"); new worker_threads.Worker(path.join(__dirname, "worker.js")); require.resolve("./delete");',
    'dist/factory.js': 'const featureImplHints = {a: "feature", b: "nested/index"}; function load(hint) { return tryRequire(`../${hint}`); }',
    'dist/worker.js': 'require("./worker-dependency");', 'dist/worker-dependency.js': 'module.exports = {};',
    'dist/delete.js': 'module.exports = {};', 'feature.js': 'module.exports = {};', 'nested/index.js': 'module.exports = {};',
    'dist/build-only.js': 'module.exports = "not runtime";',
  };
  const closure = collectLocalRuntimeClosure(root, ['./dist/entry.js', 'dist/entry.js'], [], createFs(contents));
  assert.deepEqual(closure.map(row => row.file), Object.keys(contents).filter(file => file !== 'dist/build-only.js').sort((a,b) => a.localeCompare(b)));
  assert.ok(closure.find(row => row.file === 'dist/worker-dependency.js').chain.includes('dist/worker.js'));
  assert.throws(() => collectLocalRuntimeClosure(root, ['dist/factory.js'], [], createFs({'dist/factory.js': 'tryRequire(`../${hint}`)'})), /hints cannot be resolved/);
});
