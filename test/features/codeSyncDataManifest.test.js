const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const SyncResolution_1 = require("../../dist/features/SyncResolution.js");
const LocalCodeManifestCache_1 = require("../../dist/features/LocalCodeManifestCache.js");

const source = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
const start = source.indexOf("async function buildLocalCodeManifest(root");
const end = source.indexOf("function sftpUploadSucceeded(result, fingerprint)", start);
assert.ok(start > 0 && end > start);
test("default local scope excludes server-owned data and includes arbitrary code-directory file types", async () => {
  const root = path.resolve("virtual-code-root");
  const files = [
    "data/auxiliary_views.py",
    "data/multimodal_dataset.py",
    "data/datasets/fixed_protocol_manifest.py",
    "data/datasets/__init__.py",
    "data/protocol_config.yaml",
    "data/patient_info.json",
    "data/sample.npy",
    "data/images/scan.png",
    "data/datasets/image.jpg",
    "data/weights/model.pt",
    "data/patients/subject.py",
    "configs/custom.params",
  ];
  const dirs = new Set([root]);
  for (const file of files) {
    let dir = path.dirname(path.join(root, file));
    while (dir.startsWith(root) && !dirs.has(dir)) { dirs.add(dir); dir = path.dirname(dir); }
  }
  const virtualFs = {
    async readdir(dir) {
      const children = new Set();
      for (const entry of [...dirs, ...files.map((f) => path.join(root, f))]) {
        if (path.dirname(entry) === dir) children.add(entry);
      }
      return [...children].map((entry) => ({ name: path.basename(entry), isDirectory: () => dirs.has(entry), isFile: () => !dirs.has(entry) }));
    },
    async stat(file) { return { size: Buffer.byteLength(path.relative(root, file)) }; },
  };
  const sandbox = { fs: virtualFs, fsNode: { createReadStream: (file) => Readable.from([Buffer.from(path.relative(root, file))]) }, path, crypto, console, LocalCodeManifestCache_1: {
    hashLocalCodeFiles: async (_root, listed) => ({
      manifest: Object.fromEntries(listed.map((file) => [file.replace(/\\/g, "/"), { size: Buffer.byteLength(file), sha256: crypto.createHash("sha256").update(file).digest("hex") }])),
      stats: { listed: listed.length, reused: 0, hashed: listed.length, pruned: 0 },
    }),
  } };
  vm.runInNewContext(source.slice(start, end) + "; globalThis.buildLocalCodeManifest = buildLocalCodeManifest;", sandbox);
  const manifest = await sandbox.buildLocalCodeManifest(root);
  for (const file of files.slice(0, -1)) assert.equal(manifest[file], undefined, file);
  assert.ok(manifest["configs/custom.params"]);
});

test("single-path code ownership requires no full-tree listing or hashing", () => {
  const sandbox = { path, SyncResolution_1 };
  vm.runInNewContext(source.slice(start, end) + "; globalThis.isLocalCodeOwnedPath = isLocalCodeOwnedPath;", sandbox);
  const owned = sandbox.isLocalCodeOwnedPath;
  assert.equal(owned("configs/default.yaml", false), true);
  assert.equal(owned("data/raw/image.png", false), false);
  assert.equal(owned("models/cache/weight.pt", false), false);
  assert.equal(owned("data/raw/image.png", false, ["data/raw"]), true);
  assert.equal(owned("data/raw/image.png", false, [], ["configs"]), false);
  assert.equal(owned("models/core.py", false, [], ["configs"]), true);
  assert.equal(owned("models", true, [], ["models/core.py"]), true);
});

test("upload path does not inspect Git conflicts and verifies transferred source hashes", () => {
  const syncStart = source.indexOf("async syncCodeTargets(");
  const syncEnd = source.indexOf("async inspectCodeSyncTarget(", syncStart);
  const sync = source.slice(syncStart, syncEnd);
  const uploadAt = sync.indexOf('executeCommand("simpleSftp.uploadWorkspace"');
  const verifyAt = sync.indexOf("await this.inspectCodeSyncTarget(target, requiredSources)");
  assert.ok(uploadAt > 0 && verifyAt > uploadAt);
  assert.doesNotMatch(sync.slice(0, uploadAt), /inspectCodeSyncTarget|codeSyncConflicts|远端代码冲突/);
  assert.match(source, /!row\.exists \|\| String\(row\.sha256 \|\| ""\)\.toLowerCase\(\) !== String\(manifest\[row\.path\]\?\.sha256 \|\| ""\)\.toLowerCase\(\)/);
});

test("legacy remote Git conflict gate is absent", () => {
  assert.doesNotMatch(source, /function codeSyncConflicts\(|覆盖列出的远端文件|远端代码冲突|缺少 Git 基线/);
});

test("manual local scope accepts every file type and size while excluding machine state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-code-includes-"));
  try {
    for (const [name, content] of Object.entries({
      "data/auxiliary_views.py": "ok",
      "datasets/custom_loader.py": "loader",
      "datasets/protocol_config.yaml": "mode: pilot",
      "configs/default.yaml": "mode: train",
      "datasets/raw/patient.npy": "secret",
      "datasets/patients/subject.py": "secret",
      "datasets/model.pt": Buffer.alloc(128 * 1024),
      "work_dirs/secret.py": "secret",
      "simple_cluster/results/plan-1/metrics.json": "{}",
      "simple_cluster/tmp/cluster_scheduler/logs/plan-1.log": "done",
      "simple_cluster/tmp/cluster_scheduler/queue_state.json": "private",
    })) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    const sandbox = { fs: fs.promises, fsNode: fs, path, crypto, console, LocalCodeManifestCache_1 };
    vm.runInNewContext(source.slice(start, end) + "; globalThis.buildLocalCodeManifest = buildLocalCodeManifest;", sandbox);
    const manifest = await sandbox.buildLocalCodeManifest(root, ["datasets", "configs"]);
    for (const file of ["datasets/custom_loader.py", "datasets/protocol_config.yaml", "datasets/patients/subject.py", "configs/default.yaml", "datasets/raw/patient.npy", "datasets/model.pt"]) assert.ok(manifest[file], file);
    for (const file of ["data/auxiliary_views.py", "work_dirs/secret.py"]) assert.equal(manifest[file], undefined, file);
    const customManifest = await sandbox.buildLocalCodeManifest(root, ["datasets/model.pt"]);
    assert.ok(customManifest["datasets/model.pt"]);
    const resultManifest = await sandbox.buildLocalCodeManifest(root, ["simple_cluster/results"]);
    assert.ok(resultManifest["simple_cluster/results/plan-1/metrics.json"]);
    const logManifest = await sandbox.buildLocalCodeManifest(root, ["simple_cluster/tmp/cluster_scheduler/logs"]);
    assert.ok(logManifest["simple_cluster/tmp/cluster_scheduler/logs/plan-1.log"]);
    const exactScope = await sandbox.buildLocalCodeManifest(root, ["datasets"], ["configs/default.yaml"]);
    assert.deepEqual(Object.keys(exactScope), ["configs/default.yaml"]);
    await assert.rejects(() => sandbox.buildLocalCodeManifest(root, ["simple_cluster/tmp/cluster_scheduler/queue_state.json"]), /机器状态/);
    await assert.rejects(() => sandbox.buildLocalCodeManifest(root, ["../outside.py"]), /相对路径/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one scope button opens both independently saved synchronization modes", () => {
  const panel = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
  const actionStart = panel.indexOf('<div class="toolbar" data-anchor="sync-check-actions">');
  const actionRow = panel.slice(actionStart, panel.indexOf('<div class="toolbar" data-anchor="sync-actions">', actionStart));
  assert.match(panel, /data-command="configureCodeSyncIncludes"/);
  assert.ok(actionRow.indexOf('data-command="overwriteGithub"') < actionRow.indexOf('data-command="configureCodeSyncIncludes"'));
  assert.doesNotMatch(actionRow, /data-command="configureServerSyncScope"/);
  assert.match(actionRow, /项目同步范围与状态/);
  assert.match(actionRow, /两套范围独立保存/);
  assert.doesNotMatch(panel, /configureSftpIgnores|设置跳过文件/);
  assert.match(source, /case "configureCodeSyncIncludes"/);
  assert.match(source, /async configureServerSyncScope\(\) \{\s*await this\.configureCodeSyncIncludes\(\);/);
  assert.match(source, /expandSelectedLocalScope\(root, paths, excluded\)/);
  assert.match(source, /config\.update\("codeSync\.scopePaths", normalized, vscode\.ConfigurationTarget\.WorkspaceFolder\)/);
  assert.match(source, /config\.update\("serverSync\.paths", normalized, vscode\.ConfigurationTarget\.WorkspaceFolder\)/);
  assert.match(source, /buildLocalCodeManifest\(root, includePaths, scopePaths(?:,|\))/);
});

test("scope control opens two tabs and saves each scope independently", async () => {
  const methodStart = source.indexOf("async configureCodeSyncIncludes() {");
  const methodEnd = source.indexOf("async configureServerSyncScope()", methodStart);
  assert.ok(methodStart > 0 && methodEnd > methodStart);
  const text = source.slice(methodStart, methodEnd);
  assert.match(text, /SyncScopeTree_1\.openSyncScopeTree/);
  assert.match(text, /listSyncScopeUnion/);
  assert.match(text, /refreshSyncScopeStatus/);
  const sourceText = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
  assert.match(sourceText, /collectLocalScopeInventory\(root, relative, true, /);
  assert.match(sourceText, /recursive: true, timeoutMs/);
  assert.match(sourceText, /statuses\[relative\] = errors.length/);
  assert.match(sourceText, /return statuses;/);
  assert.match(text, /id: "local"/);
  assert.match(text, /id: "workers"/);
  assert.match(text, /config\.update\("codeSync\.scopePaths"/);
  assert.match(text, /config\.update\("serverSync\.paths"/);
  assert.doesNotMatch(text, /showQuickPick|showOpenDialog|allowedExtensions|maxFileSizeMB/);
});
