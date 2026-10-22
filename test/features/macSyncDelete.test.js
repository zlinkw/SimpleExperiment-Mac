const assert = require("node:assert/strict");
const test = require("node:test");
const os = require("node:os");
const realFs = require("node:fs");
const path = require("node:path");
const { macDeleteChild, deleteLocalSyncPath } = require("../../dist/features/SyncResolution.js");

function sandbox(files) {
  const root = realFs.realpathSync(realFs.mkdtempSync(path.join(os.tmpdir(), "079del-")));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    realFs.mkdirSync(path.dirname(file), { recursive: true });
    if (content === null) realFs.mkdirSync(file, { recursive: true }); else realFs.writeFileSync(file, content);
  }
  return root;
}

function injected(root) {
  const host = { dir: null, chdir(dir) { if (!realFs.existsSync(dir)) throw new Error("ENOENT"); this.dir = dir; }, cwd() { return this.dir; } };
  const resolve = file => file === "." || file.startsWith("./") ? path.resolve(host.dir || root, file) : path.resolve(root, file);
  const disk = {
    lstatSync: (file, options) => realFs.lstatSync(resolve(file), options),
    readdirSync: (file, options) => realFs.readdirSync(resolve(file), options),
    realpathSync: file => file === "." ? host.dir : realFs.realpathSync(resolve(file)),
    rmSync: (file, options) => realFs.rmSync(resolve(file), options),
  };
  return { disk, host };
}

test("mac child deletes a verified plain file with the single-entry frozen inventory", () => {
  const root = sandbox({ "old/a.bin": "x" });
  const { disk, host } = injected(root);
  const proofs = [];
  macDeleteChild({ root, relative: "old/a.bin", handleProbe: "/probe/mac_cleanup_handles.py" }, disk, host,
    (file, full, expected, inventory) => proofs.push({ file, full, expected, inventory }));
  assert.equal(realFs.existsSync(path.join(root, "old/a.bin")), false);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0].file, "/probe/mac_cleanup_handles.py");
  assert.equal(proofs[0].inventory.length, 1);
  assert.equal(proofs[0].full, path.join(root, "old/a.bin"));
  assert.equal(String(proofs[0].expected.ino), proofs[0].inventory[0].inode);
});

test("mac child freezes the whole directory subtree into the handle inventory", () => {
  const root = sandbox({ "run/x.bin": "1", "run/sub/y.bin": "2", "keep.bin": "keep" });
  const { disk, host } = injected(root);
  const proofs = [];
  macDeleteChild({ root, relative: "run", handleProbe: "/p.py" }, disk, host,
    (_file, _full, _expected, inventory) => proofs.push(inventory));
  assert.equal(realFs.existsSync(path.join(root, "run")), false);
  assert.equal(realFs.existsSync(path.join(root, "keep.bin")), true);
  // run + x.bin + sub + y.bin = 4 frozen vnodes, all device-bound positive inodes.
  assert.equal(proofs[0].length, 4);
  assert.ok(proofs[0].every(row => /^\d+$/.test(row.device) && /^[1-9]\d*$/.test(row.inode)));
});

test("symbolic links or foreign-device entries inside the target block the delete", () => {
  const root = sandbox({ "run/a.bin": "1" });
  realFs.symlinkSync(path.join(root, "run/a.bin"), path.join(root, "run/link"));
  const { disk, host } = injected(root);
  assert.throws(() => macDeleteChild({ root, relative: "run", handleProbe: "/p.py" }, disk, host, () => undefined), /符号链接/);
  assert.equal(realFs.existsSync(path.join(root, "run/a.bin")), true);
});

test("an active native handle blocks deletion unchanged and is propagated verbatim", () => {
  const root = sandbox({ "old/a.bin": "x" });
  const { disk, host } = injected(root);
  const error = Object.assign(new Error("ACTIVE_HANDLE：pid 42"), { code: "ACTIVE_HANDLE" });
  assert.throws(() => macDeleteChild({ root, relative: "old/a.bin", handleProbe: "/p.py" }, disk, host, () => { throw error; }), /ACTIVE_HANDLE/);
  assert.equal(realFs.existsSync(path.join(root, "old/a.bin")), true);
});

test("identity drift during proof cancels the delete before removal", () => {
  const root = sandbox({ "old/a.bin": "x" });
  const { disk, host } = injected(root);
  const file = path.join(root, "old/a.bin");
  assert.throws(() => macDeleteChild({ root, relative: "old/a.bin", handleProbe: "/p.py" }, disk, host, () => {
    const now = new Date(Date.now() + 5000);
    realFs.utimesSync(file, now, now);
  }), /TARGET_CHANGED/);
  assert.equal(realFs.existsSync(file), true);
});

test("a deep file inserted during the handle proof blocks the delete with zero deletion", () => {
  const root = sandbox({ "run/x.bin": "1", "run/sub/y.bin": "2" });
  const { disk, host } = injected(root);
  assert.throws(() => macDeleteChild({ root, relative: "run", handleProbe: "/p.py" }, disk, host, () => {
    realFs.writeFileSync(path.join(root, "run/sub/planted.bin"), "planted");
  }), /TARGET_CHANGED/);
  assert.equal(realFs.existsSync(path.join(root, "run/sub/planted.bin")), true);
  assert.equal(realFs.existsSync(path.join(root, "run/x.bin")), true, "nothing may be deleted once the frozen tree drifted");
});

test("a deep file replaced or rewritten during the proof blocks the delete", () => {
  for (const mode of ["replace", "rewrite"]) {
    const root = sandbox({ "run/x.bin": "1", "run/sub/y.bin": "original" });
    const { disk, host } = injected(root);
    assert.throws(() => macDeleteChild({ root, relative: "run", handleProbe: "/p.py" }, disk, host, () => {
      const deep = path.join(root, "run/sub/y.bin");
      if (mode === "replace") { realFs.rmSync(deep); realFs.writeFileSync(deep, "swapped-by-attacker"); }
      else { realFs.writeFileSync(deep, "rewritten"); const now = new Date(Date.now() + 5000); realFs.utimesSync(deep, now, now); }
    }), /TARGET_CHANGED/);
    assert.equal(realFs.readFileSync(path.join(root, "run/x.bin"), "utf8"), "1");
    assert.equal(realFs.existsSync(path.join(root, "run")), true);
  }
});

test("hardlinks, protected segments and replaced ancestors fail closed without deleting", () => {
  const linked = sandbox({ "run/x.bin": "1", "outside.bin": "shared" });
  realFs.linkSync(path.join(linked, "outside.bin"), path.join(linked, "run/hard.bin"));
  const linkCase = injected(linked);
  assert.throws(() => macDeleteChild({ root: linked, relative: "run", handleProbe: "/p.py" }, linkCase.disk, linkCase.host, () => undefined), /硬链接/);
  assert.equal(realFs.existsSync(path.join(linked, "run/x.bin")), true);

  const repo = sandbox({ "run/x.bin": "1", "run/.git/config": "x" });
  const repoCase = injected(repo);
  assert.throws(() => macDeleteChild({ root: repo, relative: "run", handleProbe: "/p.py" }, repoCase.disk, repoCase.host, () => undefined), /PROTECTED_PATH/);
  assert.equal(realFs.existsSync(path.join(repo, "run/x.bin")), true);
  assert.throws(() => macDeleteChild({ root: repo, relative: ".git", handleProbe: "/p.py" }, repoCase.disk, repoCase.host, () => undefined), /PROTECTED_PATH/);

  const moved = sandbox({ "run/x.bin": "1" });
  const { disk, host } = injected(moved);
  assert.throws(() => macDeleteChild({ root: moved, relative: "run", handleProbe: "/p.py" }, disk, host, () => {
    realFs.renameSync(path.join(moved, "run"), path.join(moved, "run-elsewhere"));
  }), /TARGET_CHANGED|ENOENT/);
  assert.equal(realFs.existsSync(path.join(moved, "run-elsewhere/x.bin")), true, "the drifted tree survives under its real location");
  assert.equal(realFs.existsSync(path.join(moved, "run")), false);
});

test("a stale spawn request never deletes a replaced target", () => {
  const root = sandbox({ "old/a.bin": "x" });
  const stale = { root, relative: "old/a.bin", handleProbe: "/p.py",
    expected: { type: "file", dev: "9", ino: "9", size: "0", mtimeNs: "0", nlink: "1" } };
  const { disk, host } = injected(root);
  assert.throws(() => macDeleteChild(stale, disk, host, () => undefined), /启动删除程序后发生变化/);
  assert.equal(realFs.existsSync(path.join(root, "old/a.bin")), true);
});

test("a wrong physical working directory fails closed as PARENT_CD_FAILED", () => {
  const root = sandbox({ "old/a.bin": "x" });
  const { disk } = injected(root);
  const host = { chdir() { /* silently refuse */ }, cwd: () => "/somewhere/else" };
  assert.throws(() => macDeleteChild({ root, relative: "old/a.bin", handleProbe: "/p.py" }, disk, host, () => undefined), /PARENT_CD_FAILED/);
  assert.equal(realFs.existsSync(path.join(root, "old/a.bin")), true);
});

test("a child claiming success while the target survives is reported as TARGET_STILL_PRESENT", () => {
  const root = sandbox({ "old/a.bin": "x" });
  const base = injected(root);
  const disk = { ...base.disk, rmSync: () => undefined };
  assert.throws(() => macDeleteChild({ root, relative: "old/a.bin", handleProbe: "/p.py" }, disk, base.host, () => undefined), /TARGET_STILL_PRESENT/);
});

test("unconfigured Mac host and unsupported platforms fail closed without deleting", async () => {
  // The Linux test host is neither win32 nor darwin: the shared entry must refuse.
  if (process.platform === "win32" || process.platform === "darwin") return;
  await assert.rejects(deleteLocalSyncPath(os.tmpdir(), "whatever.bin"), /HANDLE_CHECK_UNAVAILABLE/);
});

test("protected repository and archive segments stay blocked on every platform", async () => {
  await assert.rejects(deleteLocalSyncPath("/tmp", ".git/config"), /PROTECTED_PATH/);
  await assert.rejects(deleteLocalSyncPath("/tmp", "clean_dir/x"), /PROTECTED_PATH/);
});
