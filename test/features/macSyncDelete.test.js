const assert = require("node:assert/strict");
const test = require("node:test");
const os = require("node:os");
const realFs = require("node:fs");
const path = require("node:path");
const { macDeleteChild, deleteLocalSyncPath } = require("../../dist/features/SyncResolution.js");

// 生产 macDeleteChild 只接受规范 POSIX 绝对根（src/features/SyncResolution.ts:215-219 自己校验，
// 不经过 WorkspacePathMapper）。Windows 宿主必须把这条口径留在注入层：交给生产的是规范 POSIX 虚拟根，
// 注入的磁盘层把它映射到唯一的真实临时目录，realpathSync 与 cwd 回报对应的虚拟身份。真实文件变更、
// 重解析点、冻结清单 inode、句柄证明、./叶子名 与删后检查全部照常发生，生产删除边界一行未改。
const VIRTUAL_ROOT = "/Users/test/同步 工作区";

function sandbox(files) {
  const real = realFs.realpathSync(realFs.mkdtempSync(path.join(os.tmpdir(), "079del-")));
  // 每个用例一个唯一虚拟根；宿主临时目录只存在于注入层内部，生产只看得到 POSIX 形状。
  const root = VIRTUAL_ROOT + "/" + path.basename(real);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(real, name);
    realFs.mkdirSync(path.dirname(file), { recursive: true });
    if (content === null) realFs.mkdirSync(file, { recursive: true }); else realFs.writeFileSync(file, content);
  }
  return { root, real };
}

function injected(root, real) {
  const toReal = target => {
    const text = String(target).replace(/\\/g, "/");
    // 生产会在已核验父目录里用 ./叶子名 与 "." 操作；其余一律必须是虚拟根内的绝对路径。
    const base = text === "." || text === "./" ? (host.dir || root)
      : text.startsWith("./") ? (host.dir || root) + "/" + text.slice(2)
      : text === root ? root
      : text.startsWith(root + "/") ? text : null;
    if (base === null) throw new Error(`夹具路径不在虚拟项目根内：${text}`);
    const relative = base === root ? "" : base.slice(root.length + 1);
    return relative ? path.join(real, ...relative.split("/")) : real;
  };
  const host = { dir: null, chdir(dir) { if (!realFs.existsSync(toReal(dir))) throw new Error("ENOENT"); this.dir = dir; }, cwd() { return this.dir; } };
  const toVirtual = native => root + (native === real ? "" : "/" + path.relative(real, native).split(path.sep).join("/"));
  const disk = {
    lstatSync: (file, options) => realFs.lstatSync(toReal(file), options),
    readdirSync: (file, options) => realFs.readdirSync(toReal(file), options),
    // 物理校验必须得到虚拟身份，否则 realpathSync 会把宿主盘符路径泄露给 POSIX 根的判断。
    realpathSync: file => file === "." ? host.dir : toVirtual(realFs.realpathSync(toReal(file))),
    rmSync: (file, options) => realFs.rmSync(toReal(file), options),
  };
  return { disk, host };
}

test("mac child deletes a verified plain file with the single-entry frozen inventory", () => {
  const { root, real } = sandbox({ "old/a.bin": "x" });
  const { disk, host } = injected(root, real);
  const proofs = [];
  macDeleteChild({ root, relative: "old/a.bin", handleProbe: "/probe/mac_cleanup_handles.py" }, disk, host,
    (file, full, expected, inventory) => proofs.push({ file, full, expected, inventory }));
  assert.equal(realFs.existsSync(path.join(real, "old/a.bin")), false);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0].file, "/probe/mac_cleanup_handles.py");
  assert.equal(proofs[0].inventory.length, 1);
  // 冻结证明与句柄证明都必须只看到 POSIX 侧身份，不能泄露宿主盘符路径。
  assert.equal(proofs[0].full, root + "/old/a.bin");
  assert.ok(!/[A-Za-z]:/.test(proofs[0].full) && !proofs[0].full.includes("\\"));
  assert.equal(String(proofs[0].expected.ino), proofs[0].inventory[0].inode);
});

test("mac child freezes the whole directory subtree into the handle inventory", () => {
  const { root, real } = sandbox({ "run/x.bin": "1", "run/sub/y.bin": "2", "keep.bin": "keep" });
  const { disk, host } = injected(root, real);
  const proofs = [];
  macDeleteChild({ root, relative: "run", handleProbe: "/p.py" }, disk, host,
    (_file, _full, _expected, inventory) => proofs.push(inventory));
  assert.equal(realFs.existsSync(path.join(real, "run")), false);
  assert.equal(realFs.existsSync(path.join(real, "keep.bin")), true);
  // run + x.bin + sub + y.bin = 4 frozen vnodes, all device-bound positive inodes.
  assert.equal(proofs[0].length, 4);
  assert.ok(proofs[0].every(row => /^\d+$/.test(row.device) && /^[1-9]\d*$/.test(row.inode)));
});

test("symbolic links or foreign-device entries inside the target block the delete", () => {
  const { root, real } = sandbox({ "run/a.bin": "1" });
  // Windows 上普通文件符号链接需要额外权限（EPERM），这里用同类重解析点 junction；两者在
  // lstatSync 下都报 isSymbolicLink()，生产守卫必须同样拦住，并保留树内真实文件。
  const outside = path.join(real, "outside-dir"); realFs.mkdirSync(outside);
  realFs.symlinkSync(outside, path.join(real, "run/link"), process.platform === "win32" ? "junction" : "dir");
  const { disk, host } = injected(root, real);
  assert.throws(() => macDeleteChild({ root, relative: "run", handleProbe: "/p.py" }, disk, host, () => undefined), /符号链接/);
  assert.equal(realFs.existsSync(path.join(real, "run/a.bin")), true);
});

test("an active native handle blocks deletion unchanged and is propagated verbatim", () => {
  const { root, real } = sandbox({ "old/a.bin": "x" });
  const { disk, host } = injected(root, real);
  const error = Object.assign(new Error("ACTIVE_HANDLE：pid 42"), { code: "ACTIVE_HANDLE" });
  assert.throws(() => macDeleteChild({ root, relative: "old/a.bin", handleProbe: "/p.py" }, disk, host, () => { throw error; }), /ACTIVE_HANDLE/);
  assert.equal(realFs.existsSync(path.join(real, "old/a.bin")), true);
});

test("identity drift during proof cancels the delete before removal", () => {
  const { root, real } = sandbox({ "old/a.bin": "x" });
  const { disk, host } = injected(root, real);
  const file = path.join(real, "old/a.bin");
  assert.throws(() => macDeleteChild({ root, relative: "old/a.bin", handleProbe: "/p.py" }, disk, host, () => {
    const now = new Date(Date.now() + 5000);
    realFs.utimesSync(file, now, now);
  }), /TARGET_CHANGED/);
  assert.equal(realFs.existsSync(file), true);
});

test("a deep file inserted during the handle proof blocks the delete with zero deletion", () => {
  const { root, real } = sandbox({ "run/x.bin": "1", "run/sub/y.bin": "2" });
  const { disk, host } = injected(root, real);
  assert.throws(() => macDeleteChild({ root, relative: "run", handleProbe: "/p.py" }, disk, host, () => {
    realFs.writeFileSync(path.join(real, "run/sub/planted.bin"), "planted");
  }), /TARGET_CHANGED/);
  assert.equal(realFs.existsSync(path.join(real, "run/sub/planted.bin")), true);
  assert.equal(realFs.existsSync(path.join(real, "run/x.bin")), true, "nothing may be deleted once the frozen tree drifted");
});

test("a deep file replaced or rewritten during the proof blocks the delete", () => {
  for (const mode of ["replace", "rewrite"]) {
    const { root, real } = sandbox({ "run/x.bin": "1", "run/sub/y.bin": "original" });
    const { disk, host } = injected(root, real);
    assert.throws(() => macDeleteChild({ root, relative: "run", handleProbe: "/p.py" }, disk, host, () => {
      const deep = path.join(real, "run/sub/y.bin");
      if (mode === "replace") { realFs.rmSync(deep); realFs.writeFileSync(deep, "swapped-by-attacker"); }
      else { realFs.writeFileSync(deep, "rewritten"); const now = new Date(Date.now() + 5000); realFs.utimesSync(deep, now, now); }
    }), /TARGET_CHANGED/);
    assert.equal(realFs.readFileSync(path.join(real, "run/x.bin"), "utf8"), "1");
    assert.equal(realFs.existsSync(path.join(real, "run")), true);
  }
});

test("hardlinks, protected segments and replaced ancestors fail closed without deleting", () => {
  const hard = sandbox({ "run/x.bin": "1", "outside.bin": "shared" });
  realFs.linkSync(path.join(hard.real, "outside.bin"), path.join(hard.real, "run/hard.bin"));
  const linkCase = injected(hard.root, hard.real);
  assert.throws(() => macDeleteChild({ root: hard.root, relative: "run", handleProbe: "/p.py" }, linkCase.disk, linkCase.host, () => undefined), /硬链接/);
  assert.equal(realFs.existsSync(path.join(hard.real, "run/x.bin")), true);

  const repo = sandbox({ "run/x.bin": "1", "run/.git/config": "x" });
  const repoCase = injected(repo.root, repo.real);
  assert.throws(() => macDeleteChild({ root: repo.root, relative: "run", handleProbe: "/p.py" }, repoCase.disk, repoCase.host, () => undefined), /PROTECTED_PATH/);
  assert.equal(realFs.existsSync(path.join(repo.real, "run/x.bin")), true);
  assert.throws(() => macDeleteChild({ root: repo.root, relative: ".git", handleProbe: "/p.py" }, repoCase.disk, repoCase.host, () => undefined), /PROTECTED_PATH/);

  const moved = sandbox({ "run/x.bin": "1" });
  const { disk, host } = injected(moved.root, moved.real);
  assert.throws(() => macDeleteChild({ root: moved.root, relative: "run", handleProbe: "/p.py" }, disk, host, () => {
    realFs.renameSync(path.join(moved.real, "run"), path.join(moved.real, "run-elsewhere"));
  }), /TARGET_CHANGED|ENOENT/);
  assert.equal(realFs.existsSync(path.join(moved.real, "run-elsewhere/x.bin")), true, "the drifted tree survives under its real location");
  assert.equal(realFs.existsSync(path.join(moved.real, "run")), false);
});

test("a stale spawn request never deletes a replaced target", () => {
  const { root, real } = sandbox({ "old/a.bin": "x" });
  const stale = { root, relative: "old/a.bin", handleProbe: "/p.py",
    expected: { type: "file", dev: "9", ino: "9", size: "0", mtimeNs: "0", nlink: "1" } };
  const { disk, host } = injected(root, real);
  assert.throws(() => macDeleteChild(stale, disk, host, () => undefined), /启动删除程序后发生变化/);
  assert.equal(realFs.existsSync(path.join(real, "old/a.bin")), true);
});

test("a wrong physical working directory fails closed as PARENT_CD_FAILED", () => {
  const { root, real } = sandbox({ "old/a.bin": "x" });
  const { disk } = injected(root, real);
  const host = { chdir() { /* silently refuse */ }, cwd: () => "/somewhere/else" };
  assert.throws(() => macDeleteChild({ root, relative: "old/a.bin", handleProbe: "/p.py" }, disk, host, () => undefined), /PARENT_CD_FAILED/);
  assert.equal(realFs.existsSync(path.join(real, "old/a.bin")), true);
});

test("a non canonical host-shaped root is refused before any filesystem call", () => {
  const { root, real } = sandbox({ "old/a.bin": "x" });
  const { disk, host } = injected(root, real);
  // 固定 Windows 形状字面量：真机 macOS 上 realFs.realpathSync 的结果本身是规范 POSIX 绝对路径，
  // 属于合法输入，不能当作非法根，否则该用例在目标平台会反向失败。
  for (const bad of ["C:/fixture/project", root + "/..", root.replace(/^\//, "")]) {
    let touched = false;
    const probe = { ...disk, lstatSync: file => { touched = true; return disk.lstatSync(file, { bigint: true }); } };
    assert.throws(() => macDeleteChild({ root: bad, relative: "old/a.bin", handleProbe: "/p.py" }, probe, host, () => undefined),
      /PARENT_CD_FAILED：根目录必须是规范绝对路径。/);
    assert.equal(touched, false, "非规范根必须在任何磁盘调用之前被拒");
    assert.equal(realFs.existsSync(path.join(real, "old/a.bin")), true);
  }
});

test("a child claiming success while the target survives is reported as TARGET_STILL_PRESENT", () => {
  const { root, real } = sandbox({ "old/a.bin": "x" });
  const base = injected(root, real);
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
