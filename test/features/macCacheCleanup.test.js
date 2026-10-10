const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const crypto = require("node:crypto"), vm = require("node:vm"), { EventEmitter } = require("node:events"), { createRequire } = require("node:module");
const helperModule = { exports: {} }, helperFile = require.resolve("../../dist/mac/CacheDelete"), helperRequire = createRequire(helperFile);
// Windows lacks O_NOFOLLOW; inject the native constant leaf, retaining the compiled helper.
const noFollow = 0x100;
vm.runInNewContext(fs.readFileSync(helperFile, "utf8"), { module: helperModule, exports: helperModule.exports, Buffer, process,
  require: name => name === "node:fs" ? { ...fs, constants: { ...fs.constants, O_NOFOLLOW: noFollow } } : helperRequire(name) });
const helper = helperModule.exports;

function fixture() {
  const root = "/Users/test/研究 项目/Model", relative = "tmp/目录/旧 ' %20.log", full = root + "/" + relative, parent = path.posix.dirname(full);
  let removed = false, position = 0, cwd = root;
  const content = Buffer.from("保留旧日志内容\n"), events = [];
  const stat = { dev: 1n, ino: 44n, size: BigInt(content.length), mtimeMs: BigInt(Date.now() - 8 * 86400000), nlink: 1n,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  stat.mtimeNs = stat.mtimeMs * 1000000n;
  const directory = { dev: 1, isDirectory: () => true, isSymbolicLink: () => false };
  const disk = {
    lstatSync(file) { if (file === root || file === parent) return directory;
      assert.ok([full, "./" + path.posix.basename(full)].includes(file), file);
      if (removed) throw Object.assign(Error("absent"), { code: "ENOENT" }); return stat; },
    realpathSync(file) { return file === "." ? cwd : file; },
    openSync(file, flags) { assert.ok([full, "./" + path.posix.basename(full)].includes(file)); assert.ok(flags & noFollow); position = 0; return 5; },
    fstatSync() { return stat; }, closeSync() {},
    readSync(_fd, buffer) { const count = Math.min(buffer.length, content.length - position); content.copy(buffer, 0, position, position + count); position += count; return count; },
    unlinkSync(file) { events.push(["unlink", file, cwd]); removed = true; },
  };
  const host = { chdir(value) { events.push(["cd", value]); cwd = value; }, cwd: () => cwd };
  const token = crypto.createHash("sha256").update(`${relative}|${stat.dev}|${stat.ino}|${stat.size}|${stat.mtimeNs}|${stat.nlink}`).digest("hex");
  const approval = { root, relative, fullPath: full, token, sha256: crypto.createHash("sha256").update(content).digest("hex"),
    confirm: true, secondConfirmation: true, confirmedAbsolutePath: full };
  return { root, relative, full, parent, stat, directory, disk, host, events, approval };
}

test("actual Mac cache consumer launches the packaged Node helper in the verified parent, without PowerShell", async () => {
  const f = fixture(), calls = [], file = path.resolve(__dirname, "../../dist/extension/CacheCleanupPanel.js"), localRequire = createRequire(file);
  const module = { exports: {} }, promises = { lstat: async (...args) => f.disk.lstatSync(...args), realpath: async value => f.disk.realpathSync(value) };
  const customRequire = name => {
    if (name === "vscode") return {};
    if (name === "node:path") return { ...path.posix, posix: path.posix };
    if (name === "node:fs/promises") return promises;
    if (name === "../mac/CacheDelete") return { ...helper, fingerprintCacheFile: (full, relative) => helper.fingerprintCacheFile(full, relative, f.disk) };
    if (name === "node:child_process") return { spawn(command, args, options) {
      assert.notEqual(command, "pwsh.exe", "Mac must not launch Windows PowerShell"); calls.push({ command, args, options });
      const child = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => { try { helper.deleteApprovedCacheFile(JSON.parse(args[1]), f.disk, f.host); child.emit("close", 0); }
        catch (error) { child.stderr.emit("data", error.message); child.emit("close", 1); } });
      return child;
    } };
    return localRequire(name);
  };
  customRequire.resolve = localRequire.resolve;
  vm.runInNewContext(fs.readFileSync(file, "utf8") + "\nmodule.exports.deleteLocalCandidate=deleteLocalCandidate;", {
    module, exports: module.exports, require: customRequire, __dirname: path.dirname(file), Buffer, console,
    process: { ...process, platform: "darwin", arch: "arm64", execPath: "/Applications/Visual Studio Code.app/Code Helper", env: { KEEP: "yes" } },
  });
  await module.exports.deleteLocalCandidate(f.root, { path: f.relative, fullPath: f.full, token: f.approval.token });
  assert.equal(calls.length, 1); assert.equal(calls[0].command, "/Applications/Visual Studio Code.app/Code Helper");
  assert.equal(calls[0].args[0], localRequire.resolve("../mac/CacheDelete")); assert.equal(calls[0].options.cwd, f.parent);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, "1"); assert.equal(calls[0].options.env.KEEP, "yes");
  assert.deepEqual(f.events.at(-1), ["unlink", "./旧 ' %20.log", f.parent]);
});

test("Mac deletion requires both confirmations of the exact full path", () => {
  for (const patch of [{ confirm: false }, { secondConfirmation: false }, { confirmedAbsolutePath: "/other" }, { fullPath: "/other" }]) {
    const f = fixture(); assert.throws(() => helper.deleteApprovedCacheFile({ ...f.approval, ...patch }, f.disk, f.host), /CONFIRM_REQUIRED/);
    assert.equal(f.events.length, 0);
  }
});

test("canonical direct-parent failures, links and mount changes perform no deletion", () => {
  for (const fault of ["cd", "cwd", "realpath", "root-link", "parent-link", "mount"]) {
    const f = fixture(), original = f.disk.lstatSync;
    if (fault === "cd") f.host.chdir = () => { throw Error("unavailable"); };
    if (fault === "cwd") f.host.cwd = () => "/outside";
    if (fault === "realpath") f.disk.realpathSync = value => value === f.parent ? "/outside" : value;
    if (["root-link", "parent-link", "mount"].includes(fault)) f.disk.lstatSync = file => file === (fault === "root-link" ? f.root : f.parent)
      ? { ...f.directory, dev: fault === "mount" ? 2 : 1, isSymbolicLink: () => fault !== "mount" } : original(file);
    assert.throws(() => helper.deleteApprovedCacheFile(f.approval, f.disk, f.host), /PARENT_CD_FAILED/);
    assert.equal(f.events.some(e => e[0] === "unlink"), false);
  }
});

test("changed file identity, SHA, age, links and file type are rejected", () => {
  for (const fault of ["identity", "hash", "recent", "symlink", "directory", "hardlink"]) {
    const f = fixture();
    if (fault === "identity") f.stat.ino++;
    if (fault === "hash") f.approval.sha256 = "0".repeat(64);
    if (fault === "recent") f.stat.mtimeMs = BigInt(Date.now());
    if (fault === "symlink") f.stat.isSymbolicLink = () => true;
    if (fault === "directory") f.stat.isFile = () => false;
    if (fault === "hardlink") f.stat.nlink = 2n;
    assert.throws(() => helper.deleteApprovedCacheFile(f.approval, f.disk, f.host), /TARGET_CHANGED/);
    assert.equal(f.events.some(e => e[0] === "unlink"), false);
  }
});

test("traversal and protected scopes never reach a deletion leaf", () => {
  for (const relative of ["tmp/../results/a.log", "tmp", "simple_cluster/tmp", "experiments/results/a.log", "tmp/a\\b", "tmp/a\n.log"]) {
    const f = fixture(); assert.throws(() => helper.deleteApprovedCacheFile({ ...f.approval, relative }, f.disk, f.host), /TARGET_CHANGED/);
    assert.equal(f.events.length, 0);
  }
});

test("a zero-effect child cannot report completion while the target still exists", () => {
  const f = fixture(); f.disk.unlinkSync = value => f.events.push(["attempt", value]);
  assert.throws(() => helper.deleteApprovedCacheFile(f.approval, f.disk, f.host), /TARGET_STILL_PRESENT/);
});
