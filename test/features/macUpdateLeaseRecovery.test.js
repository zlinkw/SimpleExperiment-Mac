const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), { createRequire } = require("node:module");

// Legacy single-slot recovery on the Mac lease path (Windows-authoritative HostOperationLease
// recovery region): an unexpired receipt blocks unless its canonical owner is proven gone (ESRCH
// only); the fixed .expired slot may only be replaced by another receipt whose canonical owner is
// also proven gone; symlink slots are never evicted. Live-update protection of current transfers
// lives in the .resources-v2 wait layer (see macUpdateGate), not in this legacy slot.
function fixture(options = {}) {
  const file = "/Users/test/Library/Application Support/SimpleLocalMac/host-operation-lease.json";
  const now = Date.now(), expired = new Date(now - 60000).toISOString(), future = new Date(now + 60000).toISOString();
  const canonical = (pid, uuid) => `${require("node:os").hostname()}:${pid}:mac-preview-update:${uuid}`;
  const old = { schemaVersion: 1, leaseId: "old", pluginId: "simple-local.simple-experiment-mac",
    windowId: canonical(86871, "8b70cef7-e132-44b3-955f-2a735a27b8a8"), processId: 86871,
    workspaceUri: "untitled://mac-preview-update", hostProjectPath: "/Users/test/old", actionType: "mac-preview-update",
    actionLabel: "Mac 配套更新", createdAt: expired, heartbeatAt: expired, expiresAt: expired, ...options.record };
  const slotRecord = { ...old, leaseId: "older", expiresAt: expired, windowId: options.slotForeign ? "mac-preview-update:6b60c0b3-0000-4000-8000-000000000000" : canonical(9911, "6b60c0b3-1111-4000-8000-000000000000"), processId: options.slotForeign ? 0 : 9911 };
  let ino = 0; const rows = new Map(), moved = [], probes = [];
  const put = (name, text) => rows.set(name, { text, ino: ++ino, symlink: false });
  put(file, JSON.stringify(old));
  if (!options.noSlot) put(file + ".expired", options.slotSymlink ? "" : JSON.stringify(slotRecord)), rows.get(file + ".expired").symlink = Boolean(options.slotSymlink);
  const absent = () => Object.assign(Error("absent"), { code: "ENOENT" });
  const stat = name => {
    if (!rows.has(name)) throw absent(); const row = rows.get(name);
    return { dev: 1, ino: row.ino, size: Buffer.byteLength(row.text), mtimeMs: row.ino, ctimeMs: row.ino,
      isFile: () => true, isSymbolicLink: () => row.symlink };
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
  const alive = new Set(options.alivePids || []);
  const sandbox = { exports, module: { exports }, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    process: { ...process, platform: "darwin", pid: 22222, kill(pid) { probes.push(pid);
      if (alive.has(pid)) return true;
      throw Object.assign(Error("probe"), { code: options.permissionPids?.includes(pid) ? "EPERM" : "ESRCH" }); } },
    require(name) { if (name === "fs/promises") return disk; if (name === "path") return { ...path.posix, posix: path.posix, win32: path.win32 }; return local(name); } };
  vm.runInNewContext(fs.readFileSync(built, "utf8"), sandbox, { filename: built });
  const manager = new exports.LegacyHostOperationLeaseManager({ leasePath: file, windowId: "new-window", heartbeatMs: 0 });
  const acquire = () => manager.acquire({ pluginId: old.pluginId, workspaceUri: old.workspaceUri, hostProjectPath: "/Users/test/new", actionType: "mac-preview-update" });
  return { manager, acquire, file, rows, moved, probes, canonical };
}

test("dead legacy Mac updater receipt is recovered and replaces the verified-gone fixed slot", async () => {
  const f = fixture({ record: { expiresAt: new Date(Date.now() + 60000).toISOString() } }); // unexpired but canonical owner ESRCHs; slot receipt expired and gone
  const handle = await f.acquire();
  assert.equal(handle.record.windowId, "new-window"); await handle.assertHeld(); await handle.release();
  assert.equal(f.moved.length, 1); assert.deepEqual(f.moved[0], [f.file, f.file + ".expired"]);
  assert.ok(f.probes.includes(9911), "the fixed slot owner must be probed before replacement");
  assert.ok(f.probes.includes(86871));
  assert.equal(JSON.parse(f.rows.get(f.file + ".expired").text).leaseId, "old");
});

test("expired single-slot legacy receipts are reclaimed by the legacy manager; live transfers stay protected in the resources layer", async () => {
  const f = fixture({ alivePids: [86871, 9911], noSlot: true });
  const handle = await f.acquire(); await handle.assertHeld(); await handle.release();
  assert.equal(f.moved.length, 1);
});

for (const [name, options] of [
  ["live owner of an unexpired receipt", { alivePids: [86871], record: { expiresAt: new Date(Date.now() + 60000).toISOString() } }],
  ["unknown permission owner of an unexpired receipt", { permissionPids: [86871], record: { expiresAt: new Date(Date.now() + 60000).toISOString() } }],
  ["dead owner whose recovery slot belongs to an unprobed foreign window", { slotForeign: true }],
  ["dead owner whose recovery slot owner is alive", { alivePids: [9911] }],
  ["dead owner whose recovery slot owner reports EPERM", { permissionPids: [9911] }],
]) {
  test(`legacy recovery preserves ${name}`, async () => {
    const f = fixture(options); await assert.rejects(f.acquire(), error => error.code === "RESOURCE_CONFLICT");
    assert.equal(f.moved.length, 0); assert.equal(JSON.parse(f.rows.get(f.file).text).leaseId, "old");
  });
}

test("a symlinked fixed recovery slot is refused instead of being evicted", async () => {
  const f = fixture({ slotSymlink: true });
  await assert.rejects(f.acquire(), /固定恢复槽不是普通文件/);
  assert.equal(f.moved.length, 0); assert.equal(JSON.parse(f.rows.get(f.file).text).leaseId, "old");
});
