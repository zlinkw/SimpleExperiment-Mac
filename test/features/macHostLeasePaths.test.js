const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function darwinModule(file, extra = "", disk) {
  const localRequire = createRequire(file), exports = {};
  const context = { module: { exports }, exports, process: { ...process, platform: "darwin", arch: "arm64" }, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => disk && ["fs/promises", "node:fs/promises"].includes(name) ? disk
      : disk && ["../state/StateStore", "./state-store"].includes(name) ? { atomicWriteText: disk.writeFile }
      : ["path", "node:path"].includes(name) ? { ...path.posix, posix: path.posix, win32: path.win32 } : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(file, "utf8") + extra, context, { filename: file });
  return context.module.exports;
}
test("Mac leases preserve POSIX labels and distinct case-sensitive registry ownership", () => {
  const legacy = darwinModule(path.resolve(__dirname, "../../dist/core/HostOperationLease.legacy.js"), "\nexports.sessionKey = sessionKey;");
  const manager = new legacy.LegacyHostOperationLeaseManager({ leasePath: "/tmp/lease", windowId: "test", heartbeatMs: 0 });
  const project = "/Users/test/研究 项目/Model/尾部 ";
  assert.equal(manager.createRecord({ pluginId: "mac", workspaceUri: "file:///test", hostProjectPath: project, actionType: "write" }).hostProjectPath, project);
  assert.notEqual(legacy.sessionKey("/tmp/Model/lease"), legacy.sessionKey("/tmp/model/lease"));
  const resource = darwinModule(path.resolve(__dirname, "../../dist/core/ResourceOperationLease.js"));
  const a = new resource.ResourceOperationLeaseManager({ leasePath: "/tmp/Model/lease", windowId: "test" });
  const b = new resource.ResourceOperationLeaseManager({ leasePath: "/tmp/model/lease", windowId: "test" });
  assert.notEqual(a.state, b.state);
  assert.equal(resource.resourceTargetsConflict([{server:"local",project:"/p",target:"/p/Model"}], [{server:"local",project:"/p",target:"/p/model"}]), false);
});

test("both actual Mac plugins coordinate POSIX leases through the same registry without Windows paths", async () => {
  const files = new Map(), directories = new Set(); let sequence = 0;
  const absent = () => Object.assign(Error("absent"), { code: "ENOENT" });
  const metadata = row => ({ dev: 1, ino: row.ino, size: row.bytes.length, nlink: 1, mtimeMs: row.ino, ctimeMs: row.ino,
    isFile: () => true, isSymbolicLink: () => false });
  const disk = {
    async mkdir(value) { directories.add(value); },
    async writeFile(file, text) { files.set(file, { bytes: Buffer.from(text), ino: ++sequence }); },
    async lstat(file) { if (!files.has(file)) throw absent(); return metadata(files.get(file)); },
    async readFile(file, encoding) { if (!files.has(file)) throw absent(); return encoding ? files.get(file).bytes.toString(encoding) : files.get(file).bytes; },
    async readdir(directory) { return [...files.keys()].filter(file => path.posix.dirname(file) === directory).map(file => path.posix.basename(file)); },
    async open(file) { if (!files.has(file)) throw absent(); const row = files.get(file); return {
      async stat() { return metadata(row); }, async close() {},
      async read(buffer, offset, length, position) { const bytesRead = Math.min(length, row.bytes.length - position); row.bytes.copy(buffer, offset, position, position + bytesRead); return { bytesRead }; },
    }; },
  };
  const home = "/Users/test/研究 项目";
  const expPaths = darwinModule(path.resolve(__dirname, "../../dist/mac/MacPaths.js"));
  const sfPaths = darwinModule(path.resolve(__dirname, "../../../SimpleSFTP-Mac/mac-paths.js"));
  const leaseRoot = expPaths.macComponentDirectory("SimpleLocalMac", "darwin", home);
  assert.equal(leaseRoot, sfPaths.macComponentDirectory("SimpleLocalMac", "darwin", home));
  assert.equal(leaseRoot, home + "/Library/Application Support/SimpleLocalMac");
  const exp = darwinModule(path.resolve(__dirname, "../../dist/core/ResourceOperationLease.js"), "", disk);
  const sf = darwinModule(path.resolve(__dirname, "../../../SimpleSFTP-Mac/resource-operation-lease.js"), "", disk);
  const options = { leasePath: leaseRoot + "/host-operation.json", heartbeatMs: 0, ownerAlive: () => true };
  const a = new exp.ResourceOperationLeaseManager({ ...options, windowId: "experiment" });
  const b = new sf.ResourceOperationLeaseManager({ ...options, windowId: "sftp" });
  const project = "/data/研究 项目/Model", target = project + "/结果/Model/尾部 %20.csv";
  const input = { pluginId: "simple-local.simple-experiment-mac", workspaceUri: "file:///研究", hostProjectPath: home, actionType: "write",
    resources: [{ server: "Worker:22", project, target }] };
  const handles = [];
  try {
    const first = await a.acquire(input); handles.push(first);
    await assert.rejects(b.acquire({ ...input, pluginId: "simple-local.simple-sftp-mac" }), error => error.code === "RESOURCE_CONFLICT");
    const independent = await b.acquire({ ...input, resources: [{ server: "worker:22", project, target: target.replace("/结果/Model/", "/结果/model/") }] }); handles.push(independent);
    await first.assertHeld(); await independent.assertHeld();
    assert.equal((await b.inspect()).records.length, 2);
    await independent.release(); await first.release();
    const transferred = await b.acquire({ ...input, pluginId: "simple-local.simple-sftp-mac" }); handles.push(transferred);
    await assert.rejects(a.acquire(input), error => error.code === "RESOURCE_CONFLICT");
    assert.equal((await a.inspect()).records[0].pluginId, "simple-local.simple-sftp-mac");
    assert.equal((await a.inspect()).records[0].resources[0].target, target);
    await transferred.assertHeld();
    assert.ok([...files.keys()].every(file => file.startsWith(leaseRoot + "/")));
  } finally { for (const handle of handles) await handle.release(); }
  assert.equal((await a.inspect()).records.length, 0);
});
test("Mac business admission keeps the single workspace and native host boundary", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const start = source.indexOf("function currentHostOperationLeaseContext()");
  const end = source.indexOf("const EMPTY_WORKSPACE_FOLDERS_FOR_WEBVIEW", start);
  const folder = { uri: { toString: () => "file:///Users/test/研究%20项目" } };
  const sandbox = { process: {platform:"darwin",arch:"arm64"}, vscode: {workspace:{workspaceFolders:[folder]}},
    workspaceLocationForFolder: () => ({editorUri:folder.uri.toString(),hostPath:"/Users/test/研究 项目"}) };
  vm.createContext(sandbox); vm.runInContext(source.slice(start,end),sandbox);
  assert.equal(sandbox.currentHostOperationLeaseContext().hostProjectPath,"/Users/test/研究 项目");
  sandbox.vscode.workspace.workspaceFolders.push(folder); assert.throws(()=>sandbox.currentHostOperationLeaseContext(),/多个工作区/);
  sandbox.vscode.workspace.workspaceFolders.pop(); sandbox.process.arch="x64"; assert.throws(()=>sandbox.currentHostOperationLeaseContext(),/本地 UI/);
  sandbox.process.platform="linux"; assert.throws(()=>sandbox.currentHostOperationLeaseContext(),/本地 UI/);
});
