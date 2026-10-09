const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scope = require("../../dist/features/SyncScopeStatus.js");

function digest(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function removeTempDirectory(target) {
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  if (!base || base === "." || base === ".." || !base.startsWith("simple-scope-hash-")) throw new Error("PARENT_CD_FAILED");
  const realParent = fs.realpathSync(parent);
  const tempRoot = fs.realpathSync(os.tmpdir());
  const relative = path.relative(tempRoot, realParent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("PARENT_CD_FAILED");
  const probe = spawnSync(process.execPath, ["-e", "const fs=require('node:fs'); process.chdir(process.argv[1]); if (fs.realpathSync(process.cwd())!==process.argv[2]) process.exit(2); fs.rmSync('./'+process.argv[3],{recursive:true,force:true});", realParent, realParent, base], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  if (probe.status !== 0) throw new Error(`PARENT_CD_FAILED ${probe.stderr}`);
}

test("a fresh process reuses persisted hashes and keeps rows from another scope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-scope-hash-"));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "simple-scope-hash-cache-"));
  const script = `
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const scope = require(process.env.SCOPE_MODULE);
    const root = process.env.SCOPE_ROOT;
    const cacheFile = process.env.SCOPE_CACHE;
    const phase = process.env.SCOPE_PHASE;
    const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const names = ["results/metrics.csv", "results/summary.json"];
    (async () => {
      if (phase === "seed") {
        fs.mkdirSync(path.join(root, "results"), { recursive: true });
        fs.mkdirSync(path.join(root, "other"), { recursive: true });
        fs.writeFileSync(path.join(root, "results", "metrics.csv"), "metric,value\\nauc,1\\n");
        fs.writeFileSync(path.join(root, "results", "summary.json"), "{\\"value\\":1}");
        fs.writeFileSync(path.join(root, "other", "kept.csv"), "kept");
        const first = await scope.hashLocalScopeNames(root, names.concat(["other/kept.csv"]), undefined, cacheFile);
        process.stdout.write(JSON.stringify({ stable: first["results/metrics.csv"].sha256, other: first["other/kept.csv"].sha256 }));
        return;
      }
      const reads = [];
      const original = fs.promises.open;
      const metricPath = path.join(root, "results", "metrics.csv");
      fs.promises.open = async (...args) => {
        if (path.resolve(String(args[0])) === path.resolve(metricPath)) reads.push(String(args[0]));
        return original.apply(fs.promises, args);
      };
      const second = await scope.hashLocalScopeNames(root, ["results/metrics.csv"], undefined, cacheFile);
      const openedBeforeChange = reads.length;
      const changed = path.join(root, "results", "summary.json");
      const previous = fs.statSync(changed);
      fs.writeFileSync(changed, "{\\"value\\":2}");
      const nextTime = new Date(previous.mtimeMs + 3000);
      fs.utimesSync(changed, nextTime, nextTime);
      const third = await scope.hashLocalScopeNames(root, names, undefined, cacheFile);
      fs.writeFileSync(path.join(root, "results", "extra.csv"), "new");
      const fourth = await scope.hashLocalScopeNames(root, names.concat(["results/extra.csv"]), undefined, cacheFile);
      const document = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      process.stdout.write(JSON.stringify({
        reused: second["results/metrics.csv"].sha256,
        openedBeforeChange,
        changed: third["results/summary.json"].sha256,
        expectedChanged: digest("{\\"value\\":2}"),
        stable: third["results/metrics.csv"].sha256,
        extra: fourth["results/extra.csv"].sha256,
        expectedExtra: digest("new"),
        retained: document.files["other/kept.csv"] ? document.files["other/kept.csv"].sha256 : "",
      }));
    })().catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });
  `;
  const modulePath = path.join(__dirname, "../../dist/features/SyncScopeStatus.js");
  const run = (phase) => spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
    env: { ...process.env, SCOPE_MODULE: modulePath, SCOPE_ROOT: root, SCOPE_CACHE: scope.localScopeHashCachePath(storage, root), SCOPE_PHASE: phase },
  });
  try {
    const seeded = run("seed");
    assert.equal(seeded.status, 0, seeded.stderr);
    const first = JSON.parse(seeded.stdout);
    const checked = run("check");
    assert.equal(checked.status, 0, checked.stderr);
    const result = JSON.parse(checked.stdout);
    assert.equal(result.reused, first.stable);
    assert.equal(result.openedBeforeChange, 0);
    assert.equal(result.changed, result.expectedChanged);
    assert.notEqual(result.changed, first.stable);
    assert.equal(result.stable, first.stable);
    assert.equal(result.extra, result.expectedExtra);
    assert.equal(result.retained, first.other);
  } finally {
    removeTempDirectory(root);
    removeTempDirectory(storage);
  }
});

test("same size and mtime with a changed ctime is not reused", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-scope-hash-ctime-"));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "simple-scope-hash-ctime-cache-"));
  try {
    const relative = "results/same-size.csv";
    const full = path.join(root, "results", "same-size.csv");
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "aaaa");
    const cacheFile = scope.localScopeHashCachePath(storage, root);
    const first = await scope.hashLocalScopeNames(root, [relative], undefined, cacheFile);
    const document = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    document.files[relative].ctimeMs += 25;
    fs.writeFileSync(cacheFile, JSON.stringify(document));
    fs.writeFileSync(full, "bbbb");
    const stat = fs.statSync(full);
    fs.utimesSync(full, stat.atime, new Date(document.files[relative].mtimeMs));
    delete require.cache[require.resolve("../../dist/features/SyncScopeStatus.js")];
    const reloaded = require("../../dist/features/SyncScopeStatus.js");
    const second = await reloaded.hashLocalScopeNames(root, [relative], undefined, cacheFile);
    assert.equal(second[relative].sha256, digest(Buffer.from("bbbb")));
    assert.notEqual(second[relative].sha256, first[relative].sha256);
  } finally {
    removeTempDirectory(root);
    removeTempDirectory(storage);
  }
});

test("a damaged scope hash cache is ignored and rewritten from a fresh hash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-scope-hash-bad-"));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "simple-scope-hash-bad-cache-"));
  try {
    const relative = "metrics.json";
    fs.writeFileSync(path.join(root, relative), "{\"ok\":true}");
    const cacheFile = scope.localScopeHashCachePath(storage, root);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, "{not-json");
    const hashed = await scope.hashLocalScopeNames(root, [relative], undefined, cacheFile);
    assert.equal(hashed[relative].sha256, digest(Buffer.from("{\"ok\":true}")));
    const document = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.files[relative].sha256, hashed[relative].sha256);
  } finally {
    removeTempDirectory(root);
    removeTempDirectory(storage);
  }
});
