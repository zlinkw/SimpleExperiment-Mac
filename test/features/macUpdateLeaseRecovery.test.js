const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), { createRequire } = require("node:module");

function fixture(options = {}) {
  const file = "/Users/test/Library/Application Support/SimpleLocalMac/host-operation-lease.json";
  const now = Date.now(), expired = new Date(now - 60000).toISOString();
  const old = { schemaVersion: 1, leaseId: "old", pluginId: "simple-local.simple-experiment-mac",
    windowId: "mac-preview-update:8b70cef7-e132-44b3-955f-2a735a27b8a8", processId: 86871,
    workspaceUri: "untitled://mac-preview-update", hostProjectPath: "/Users/test/old", actionType: "mac-preview-update",
    actionLabel: "Mac 配套更新", createdAt: expired, heartbeatAt: expired, expiresAt: expired, ...options.record };
  let ino = 0; const rows = new Map(), moved = [], probes = [];
  const put = (name, text) => rows.set(name, { text, ino: ++ino });
  put(file, JSON.stringify(old)); put(file + ".expired", JSON.stringify({ ...old, leaseId: "older" }));
  const absent = () => Object.assign(Error("absent"), { code: "ENOENT" });
  const stat = name => {
    if (!rows.has(name)) throw absent(); const row = rows.get(name);
    return { dev: 1, ino: row.ino, size: Buffer.byteLength(row.text), mtimeMs: row.ino, ctimeMs: row.ino,
      isFile: () => true, isSymbolicLink: () => false };
  };
  const disk = {
    async mkdir() {}, async readFile(name) { if (!rows.has(name)) throw absent(); return rows.get(name).text; },
    async lstat(name) { if (path.posix.dirname(file) === name) return { isDirectory: () => true, isSymbolicLink: () => false }; return stat(name); },
    async stat(name) { return stat(name); },
    async rename(a, b) { if (!rows.has(a)) throw absent(); moved.push([a, b]); rows.set(b, rows.get(a)); rows.delete(a); },
    async open(name, mode) {
      if (mode === "wx") { if (rows.has(name)) throw Object.assign(Error("exists"), { code: "EEXIST" }); put(name, ""); }
      if (!rows.has(name)) throw absent();
      return { async writeFile(text) { rows.get(name).text = text; }, async sync() {}, async close() {},
        async readFile() { return rows.get(name).text; },
        async write(bytes, offset, length, position) { const oldBytes = Buffer.from(rows.get(name).text); bytes.copy(oldBytes, position, offset, offset + length); rows.get(name).text = oldBytes.toString("utf8"); } };
    },
  };
  const built = path.resolve(__dirname, "../../dist/core/HostOperationLease.legacy.js"), exports = {}, local = createRequire(built);
  const sandbox = { exports, module: { exports }, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    process: { ...process, platform: "darwin", pid: 22222, kill(pid) { probes.push(pid); if (options.alive) return true; throw Object.assign(Error("probe"), { code: options.permission ? "EPERM" : "ESRCH" }); } },
    require(name) { if (name === "fs/promises") return disk; if (name === "path") return { ...path.posix, posix: path.posix, win32: path.win32 }; return local(name); } };
  vm.runInNewContext(fs.readFileSync(built, "utf8"), sandbox, { filename: built });
  const manager = new exports.LegacyHostOperationLeaseManager({ leasePath: file, windowId: "new-window", heartbeatMs: 0 });
  const acquire = () => manager.acquire({ pluginId: old.pluginId, workspaceUri: old.workspaceUri, hostProjectPath: "/Users/test/new", actionType: "mac-preview-update" });
  return { manager, acquire, file, rows, moved, probes };
}

test("dead expired legacy Mac updater recovers even when the fixed recovery slot is occupied", async () => {
  const f = fixture(), handle = await f.acquire();
  assert.equal(handle.record.windowId, "new-window"); await handle.assertHeld(); await handle.release();
  assert.equal(f.moved.length, 1); assert.deepEqual(f.moved[0], [f.file, f.file + ".expired"]);
  assert.ok(f.probes.length >= 1); assert.equal(JSON.parse(f.rows.get(f.file + ".expired").text).leaseId, "old");
});
for (const [name, options] of [["live owner", { alive: true }], ["unknown permission", { permission: true }],
  ["foreign plugin", { record: { pluginId: "foreign" } }], ["invalid UUID", { record: { windowId: "mac-preview-update:invalid" } }],
  ["different action", { record: { actionType: "upload" } }],
  ["unexpired receipt", { record: { expiresAt: new Date(Date.now() + 60000).toISOString() } }]]) {
  test(`legacy updater recovery preserves ${name}`, async () => {
    const f = fixture(options); await assert.rejects(f.acquire(), error => error.code === "RESOURCE_CONFLICT");
    assert.equal(f.moved.length, 0); assert.equal(JSON.parse(f.rows.get(f.file).text).leaseId, "old");
  });
}
