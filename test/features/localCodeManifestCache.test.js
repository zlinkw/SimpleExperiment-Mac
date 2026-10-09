const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cache = require("../../dist/features/LocalCodeManifestCache.js");

function digest(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

test("unchanged files reuse metadata cache and changed files are rehashed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-local-manifest-"));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "simple-local-manifest-cache-"));
  try {
    const stable = path.join(root, "stable.bin");
    const changed = path.join(root, "changed.bin");
    fs.writeFileSync(stable, Buffer.alloc(64 * 1024, 7));
    fs.writeFileSync(changed, "before");
    const cacheFile = cache.localCodeManifestCachePath(storage, root);
    const first = await cache.hashLocalCodeFiles(root, ["stable.bin", "changed.bin"], cacheFile);
    assert.deepEqual(first.stats, { listed: 2, reused: 0, hashed: 2, pruned: 0 });
    assert.equal(first.manifest["stable.bin"].sha256, digest(fs.readFileSync(stable)));
    assert.equal(first.manifest["changed.bin"].sha256, digest(Buffer.from("before")));

    const second = await cache.hashLocalCodeFiles(root, ["stable.bin", "changed.bin"], cacheFile);
    assert.equal(second.stats.reused, 2);
    assert.equal(second.stats.hashed, 0);
    assert.deepEqual(second.manifest, first.manifest);

    const previous = fs.statSync(changed);
    const nextTime = new Date(previous.mtimeMs + 2000);
    fs.writeFileSync(changed, "after-edit");
    fs.utimesSync(changed, nextTime, nextTime);
    const third = await cache.hashLocalCodeFiles(root, ["stable.bin", "changed.bin"], cacheFile);
    assert.equal(third.stats.reused, 1);
    assert.equal(third.stats.hashed, 1);
    assert.equal(third.manifest["stable.bin"].sha256, first.manifest["stable.bin"].sha256);
    assert.equal(third.manifest["changed.bin"].sha256, digest(Buffer.from("after-edit")));
    assert.notEqual(third.manifest["changed.bin"].sha256, first.manifest["changed.bin"].sha256);

    const removed = await cache.hashLocalCodeFiles(root, ["stable.bin"], cacheFile);
    assert.equal(removed.stats.reused, 1);
    assert.equal(removed.stats.hashed, 0);
    assert.equal(removed.stats.pruned, 1);
    assert.equal(removed.manifest["changed.bin"], undefined);

    const restored = await cache.hashLocalCodeFiles(root, ["stable.bin", "changed.bin"], cacheFile);
    assert.equal(restored.stats.reused, 1);
    assert.equal(restored.stats.hashed, 1);
    assert.equal(restored.manifest["changed.bin"].sha256, digest(Buffer.from("after-edit")));
  } finally {
    // Retain isolated fixture evidence; cleanup requires separately confirmed exact paths.

  }
});

test("same-size content changes are not reused from the previous hash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-local-manifest-size-"));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "simple-local-manifest-size-cache-"));
  try {
    const file = path.join(root, "same-size.txt");
    fs.writeFileSync(file, "aaaa");
    const cacheFile = cache.localCodeManifestCachePath(storage, root);
    const first = await cache.hashLocalCodeFiles(root, ["same-size.txt"], cacheFile);
    const previous = fs.statSync(file);
    const nextTime = new Date(previous.mtimeMs + 2000);
    fs.writeFileSync(file, "bbbb");
    fs.utimesSync(file, nextTime, nextTime);
    const second = await cache.hashLocalCodeFiles(root, ["same-size.txt"], cacheFile);
    assert.equal(second.stats.hashed, 1);
    assert.equal(second.stats.reused, 0);
    assert.equal(second.manifest["same-size.txt"].size, 4);
    assert.equal(second.manifest["same-size.txt"].sha256, digest(Buffer.from("bbbb")));
    assert.notEqual(second.manifest["same-size.txt"].sha256, first.manifest["same-size.txt"].sha256);
  } finally {
    // Retain isolated fixture evidence; cleanup requires separately confirmed exact paths.

  }
});

test("hash progress reports before the full set finishes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-local-manifest-progress-"));
  try {
    const files = [];
    for (let index = 0; index < 30; index += 1) {
      const name = `file-${index}.txt`;
      fs.writeFileSync(path.join(root, name), `content-${index}`);
      files.push(name);
    }
    const seen = [];
    await cache.hashLocalCodeFiles(root, files, undefined, (stats) => seen.push(stats.hashed + stats.reused));
    assert.ok(seen.length >= 2);
    assert.ok(seen[0] < files.length);
    assert.equal(seen.at(-1), files.length);
  } finally {
    // Retain isolated fixture evidence; cleanup requires separately confirmed exact paths.
  }
});

test("cancelling a hash aborts the stream and never publishes a manifest cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hash-cancel-evidence-"));
  const file = path.join(root, "large.bin"); fs.writeFileSync(file, Buffer.alloc(1024 * 1024));
  const abort = new AbortController(); let bytes = 0;
  await assert.rejects(cache.sha256File(file, abort.signal, count => { bytes = count; abort.abort(); }), /abort/i);
  assert.ok(bytes > 0 && bytes < 1024 * 1024);
  const cacheFile = path.join(root, "hash-cache.json");
  await assert.rejects(cache.hashLocalCodeFiles(root, ["large.bin"], cacheFile, undefined, abort.signal), /abort/i);
  assert.equal(fs.existsSync(cacheFile), false);
});
