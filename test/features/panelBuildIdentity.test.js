const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { createPanelBuildManifest } = require("../../scripts/panel-build-manifest");

const sourcePath = path.join(__dirname, "../../src/features/PanelBuildIdentity.ts");
const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(code, { exports: loaded.exports, module: loaded, require });
const { readPanelBuildIdentity, classifyPanelBuildIdentity, stablePanelExtensionProbe, REQUIRED_PANEL_BUILD_FILES } = loaded.exports;

function fakeBuild() {
  const contents = new Map([
    ["virtual/package.json", JSON.stringify({ version: "0.5.200" })],
    ...REQUIRED_PANEL_BUILD_FILES.map((file) => [`virtual/${file}`, `${file} implementation A`]),
  ]);
  const stats = new Map();
  let reads = 0;
  let clock = 10;
  const normalize = (file) => String(file).replaceAll("\\", "/");
  const fsApi = {
    statSync(file) { const stat = stats.get(normalize(file)); if (!stat) throw new Error("ENOENT"); return stat; },
    readFileSync(file) { const key = normalize(file); if (!contents.has(key)) throw new Error("ENOENT"); reads += 1; return contents.get(key); },
  };
  const updateStat = (file) => stats.set(`virtual/${file}`, { size: Buffer.byteLength(String(contents.get(`virtual/${file}`))), mtimeMs: ++clock });
  const rebuildManifest = () => {
    const entries = REQUIRED_PANEL_BUILD_FILES.map((file) => ({ path: file, content: contents.get(`virtual/${file}`) }));
    const result = createPanelBuildManifest("0.5.200", entries);
    contents.set("virtual/dist/panel-build-manifest.json", result.text);
    updateStat("dist/panel-build-manifest.json");
  };
  contents.set("virtual/dist/panel-build-manifest.json", "");
  updateStat("package.json");
  rebuildManifest();
  return { fsApi, contents, stats, readCount: () => reads, rebuildManifest };
}

test("build identity reads a frozen build-time manifest", () => {
  const fixture = fakeBuild();
  const running = readPanelBuildIdentity("virtual", undefined, "0.5.200", fixture.fsApi);
  assert.equal(running.exists, true);
  assert.equal(running.buildId.length, 64);
  assert.equal(running.manifestHash.length, 64);
  const reads = fixture.readCount();
  const unchanged = readPanelBuildIdentity("virtual", running, "0.5.200", fixture.fsApi);
  assert.notEqual(unchanged, running);
  assert.equal(fixture.readCount(), reads + 1, "disk manifest is reread even when filesystem stat metadata is unchanged");

  fixture.contents.set("virtual/dist/PanelHtml.legacy.js", "not in manifest");
  const disk = readPanelBuildIdentity("virtual", running, "0.5.200", fixture.fsApi);
  assert.equal(disk.buildId, running.buildId, "the runtime closure is selected when the build-time manifest is generated");
});

for (const implementation of ["dist/ui/PanelHtml.legacy.js", "dist/extension/legacy.js", "dist/features/PanelLifecycle.js"]) {
  test(`same-version ${implementation} replacement changes the build identity`, () => {
    const fixture = fakeBuild();
    const running = readPanelBuildIdentity("virtual", undefined, "0.5.200", fixture.fsApi);
    const unchangedFacades = ["dist/extension.js", "dist/ui/PanelHtml.js"].map((file) => fixture.contents.get(`virtual/${file}`));
    fixture.contents.set(`virtual/${implementation}`, `${implementation} implementation B`);
    fixture.rebuildManifest();
    const disk = readPanelBuildIdentity("virtual", running, "0.5.200", fixture.fsApi);
    const state = classifyPanelBuildIdentity({ running, disk, installedVersion: "0.5.200", registryAvailable: true });
    assert.equal(state.registryState, "content_mismatch");
    assert.equal(state.reloadRequired, true);
    assert.equal(state.runningVersion, state.installedVersion);
    assert.equal(disk.files[implementation], require("node:crypto").createHash("sha256").update(`${implementation} implementation B`).digest("hex"));
    assert.deepEqual(["dist/extension.js", "dist/ui/PanelHtml.js"].map((file) => fixture.contents.get(`virtual/${file}`)), unchangedFacades);
  });
}

test("registry unavailability is unknown until stable probes confirm both registry and disk missing", async () => {
  const fixture = fakeBuild();
  const disk = readPanelBuildIdentity("virtual", undefined, "0.5.200", fixture.fsApi);
  const missingDisk = readPanelBuildIdentity("missing", undefined, "0.5.200", fixture.fsApi);
  let calls = 0;
  let delays = 0;
  const transient = await stablePanelExtensionProbe({
    getExtension: () => (++calls === 1 ? undefined : { version: "0.5.200" }),
    delay: async (milliseconds) => { assert.equal(milliseconds, 350); delays += 1; },
    readDiskIdentity: () => disk,
  });
  assert.equal(transient.extension.version, "0.5.200");
  assert.equal(transient.missingConfirmed, false);
  assert.equal(delays, 1);
  assert.equal(classifyPanelBuildIdentity({ running: disk, disk, registryAvailable: false, missingConfirmed: false }).registryState, "unknown");

  const confirmedMissing = await stablePanelExtensionProbe({ getExtension: () => undefined, delay: async () => {}, readDiskIdentity: () => missingDisk });
  assert.equal(confirmedMissing.missingConfirmed, true);
  const state = classifyPanelBuildIdentity({ running: disk, disk: missingDisk, registryAvailable: false, missingConfirmed: confirmedMissing.missingConfirmed });
  assert.equal(state.registryState, "extension_missing");
  assert.equal(state.reloadRequired, true);
});

test("build identity distinguishes version mismatch from matching buildId", () => {
  const fixture = fakeBuild();
  const running = readPanelBuildIdentity("virtual", undefined, "0.5.200", fixture.fsApi);
  assert.equal(classifyPanelBuildIdentity({ running, disk: running, installedVersion: "0.5.199", registryAvailable: true }).registryState, "version_mismatch");
  assert.equal(classifyPanelBuildIdentity({ running, disk: running, installedVersion: "0.5.200", registryAvailable: true }).registryState, "match");
});
