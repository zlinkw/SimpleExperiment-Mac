const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { importOfflineBundle } = require("../../dist/tunnel/OfflineImport.js");

test("offline import reads json bundle without network", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-offline-"));
  const file = path.join(dir, "bundle.json");
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, snapshot: { schedulerStates: [] } }), "utf8");
  const result = await importOfflineBundle(file);
  assert.equal(result.ok, true);
  assert.equal(result.bundle.schemaVersion, 1);
  assert.ok(result.bundle.lastImportedAt);
});

test("offline import reads exported directory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-offline-dir-"));
  await fs.writeFile(path.join(dir, "cluster_snapshot.json"), JSON.stringify({ schemaVersion: 2, schedulerStates: [{ id: 1 }] }), "utf8");
  await fs.writeFile(path.join(dir, "diagnostics.json"), JSON.stringify({ ok: true }), "utf8");
  const result = await importOfflineBundle(dir);
  assert.equal(result.ok, true);
  assert.equal(result.bundle.schemaVersion, 2);
  assert.deepEqual(result.bundle.diagnostics, { ok: true });
});