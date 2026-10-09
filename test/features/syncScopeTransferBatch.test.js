const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { batchSyncScopeInventoryPaths, compressSyncScopeInventoryPaths, planSyncScopeTransferGroups, scopeInventorySnapshot, SYNC_SCOPE_FPSYNC_PATH_LIMIT } = require("../../dist/features/SyncScopeTransferBatch.js");

const digest = (seed) => String(seed).replace(/[^a-f0-9]/g, "a").padEnd(64, "b").slice(0, 64);
const vscodeStub = {
  commands: { executeCommand: async () => ({ ok: true }) },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: {},
  Uri: { file: (value) => ({ fsPath: value }) },
};
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? vscodeStub : originalLoad.call(this, request, ...args);
};
const ROOT = "C:\\sync-scope-batch-fixture";

function record(name) {
  return { sha256: digest(name), size: name.length };
}

test("directories and loose files share one archive and drop unselected siblings", () => {
  const files = {
    "artifacts/a.txt": record("artifacts/a.txt"),
    "artifacts/b.txt": record("artifacts/b.txt"),
    "artifacts/secret.txt": record("secret"),
    "artifacts/left/a.bin": record("left/a.bin"),
    "artifacts/right/b.bin": record("right/b.bin"),
    "other/nope.bin": record("nope"),
  };
  const items = [
    { path: "artifacts/a.txt", name: "a.txt", directory: false },
    { path: "artifacts/b.txt", name: "b.txt", directory: false },
    { path: "artifacts/left", name: "left", directory: true },
    { path: "artifacts/right", name: "right", directory: true },
  ];
  const plan = planSyncScopeTransferGroups(items, files);
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0].files, ["artifacts/a.txt", "artifacts/b.txt", "artifacts/left/a.bin", "artifacts/right/b.bin"]);
  assert.equal(plan.groups[0].manifest["artifacts/secret.txt"], undefined);
  assert.equal(plan.groups[0].manifest["other/nope.bin"], undefined);
  assert.deepEqual(plan.directoryDeletes, ["artifacts/left", "artifacts/right"]);
});

test("worker file batches stop at the fpsync path cap", () => {
  const count = SYNC_SCOPE_FPSYNC_PATH_LIMIT + 3;
  const files = Object.fromEntries(Array.from({ length: count }, (_, index) => [`artifacts/${index}.bin`, record("f")]));
  const plan = planSyncScopeTransferGroups([{ path: "artifacts", name: "artifacts", directory: true }], files);
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.groups[0].files.length, SYNC_SCOPE_FPSYNC_PATH_LIMIT);
  assert.equal(plan.groups[1].batchCount, 2);
  assert.deepEqual(plan.directoryDeletes, ["artifacts"]);
});

test("scope batches also cap uncompressed bytes and isolate unknown or oversized files", () => {
  const limit = 128 * 1024 * 1024;
  const sizes = [60 * 1024 * 1024, 60 * 1024 * 1024, 30 * 1024 * 1024, limit + 1, undefined, 10];
  const files = Object.fromEntries(sizes.map((size, i) => [`artifacts/${i}.bin`, { sha256: digest(String(i)), ...(size === undefined ? {} : { size }) }]));
  const plan = planSyncScopeTransferGroups([{ path: "artifacts", name: "artifacts", directory: true }], files);
  assert.deepEqual(plan.groups.map(group => group.files), [
    ["artifacts/0.bin", "artifacts/1.bin"], ["artifacts/2.bin"], ["artifacts/3.bin"], ["artifacts/4.bin"], ["artifacts/5.bin"],
  ]);
  assert.equal(plan.groups.every(group => group.files.length === 1 || group.files.reduce((sum, file) => sum + files[file].size, 0) <= limit), true);
  assert.equal(plan.groups.every(group => group.batchCount === 5), true);
});

test("inventory scope stays on the confirmed deep file until the argument budget requires a common parent", () => {
  assert.deepEqual(compressSyncScopeInventoryPaths(["work_dirs/one/file.txt"]), ["work_dirs/one/file.txt"]);
  assert.deepEqual(
    compressSyncScopeInventoryPaths(["work_dirs/one/file.txt", "work_dirs/two/other.txt", "artifacts/keep.bin"]),
    ["artifacts/keep.bin", "work_dirs/one/file.txt", "work_dirs/two/other.txt"],
  );
  const many = Array.from({ length: 12 }, (_, index) => `work_dirs/run-${index}/metrics.json`);
  assert.deepEqual(compressSyncScopeInventoryPaths(many, { maxPaths: 4, maxArgLength: 6000 }), ["work_dirs"]);
  const siblings = ["work_dirs/one/a.txt", "work_dirs/one/b.txt", "work_dirs/one/c.txt", "work_dirs/two/d.txt", "work_dirs/two/e.txt"];
  assert.deepEqual(compressSyncScopeInventoryPaths(siblings, { maxPaths: 2, maxArgLength: 6000 }), ["work_dirs/one", "work_dirs/two"]);
  const bounded = compressSyncScopeInventoryPaths(["work_dirs/one/a.txt", "work_dirs/one/b.txt", "work_dirs/two/c.txt"], { maxPaths: 2, maxArgLength: 6000 });
  assert.deepEqual(bounded, ["work_dirs/one", "work_dirs/two/c.txt"]);
  const batches = batchSyncScopeInventoryPaths(["a/very/long/path.txt", "b/other/path.txt"], { maxPaths: 8, maxArgLength: 30 });
  assert.deepEqual(batches, [["a/very/long/path.txt"], ["b/other/path.txt"]]);
});

test("empty directory and missing hash fail before a payload is trusted", () => {
  assert.throws(() => planSyncScopeTransferGroups([{ path: "artifacts/left", name: "left", directory: true }], {}), /没有可同步文件/);
  assert.throws(() => planSyncScopeTransferGroups([{ path: "artifacts/a.txt", name: "a.txt", directory: false }], { "artifacts/a.txt": {} }), /SHA256/);
});

test("three confirmed files use one source inventory, one destination inventory, and one fpsync payload", async () => {
  const legacy = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const batchBody = legacy.slice(legacy.indexOf("async runSyncScopeTreeBatch("), legacy.indexOf("async retainSyncScopeVersion("));
  assert.equal(batchBody.includes("retainSyncScopeVersion("), false);
  assert.match(batchBody, /transferSyncScopeBatch\(/);

  const calls = [];
  const names = ["artifacts/a.txt", "artifacts/b.txt", "artifacts/pack/c.bin", "artifacts/pack/d.bin", "artifacts/outside.txt"];
  const files = Object.fromEntries(names.map((name) => [name, record(name)]));
  const provider = {
    context: { globalStorageUri: { fsPath: ROOT } },
    simpleSftpCapability: async () => {},
    simpleSftpApiCall: async (method, params) => {
      calls.push({ method, params });
      if (method === "sync.projectInventory") return { files };
      if (method === "sync.serverToServerFpsync" || method === "sync.deletePath") return { ok: true };
      throw new Error(`unexpected ${method}`);
    },
    assertSshTransportIdentities: async () => {},
    sftpServerOptions: (row) => ({ id: row.id, host: `${row.id}.example`, networkHost: `net-${row.id}`, remotePath: `/proj/${row.id}`, user: "u", port: 22 }),
    updateSyncScopeHolds: async (_root, mutate) => { provider.saved = {}; mutate(provider.saved); },
  };
  provider.verifiedSftpProjectInventory = async (options) => provider.simpleSftpApiCall("sync.projectInventory", options);
  const originalExecute = vscodeStub.commands.executeCommand;
  const originalConfig = vscodeStub.workspace.getConfiguration;
  vscodeStub.commands.executeCommand = async () => { throw new Error("worker sync must not upload"); };
  vscodeStub.workspace.getConfiguration = () => ({ get: () => [] });
  const { __transferSyncScopeBatchForTest } = require("../../dist/extension/legacy.js");
  const work = [
    { path: "artifacts/a.txt", name: "a.txt", directory: false, endpointId: "w1" },
    { path: "artifacts/b.txt", name: "b.txt", directory: false, endpointId: "w1" },
    { path: "artifacts/pack", name: "pack", directory: true, endpointId: "w1" },
  ];
  try {
    const completed = await __transferSyncScopeBatchForTest(provider, ROOT, [{ id: "w1", role: "worker" }, { id: "w2", role: "worker" }], work, ["w2"], () => {});
    assert.deepEqual(completed, ["artifacts/a.txt", "artifacts/b.txt", "artifacts/pack"]);
  } finally {
    vscodeStub.commands.executeCommand = originalExecute;
    vscodeStub.workspace.getConfiguration = originalConfig;
  }
  const inventories = calls.filter((call) => call.method === "sync.projectInventory");
  assert.equal(inventories.filter((call) => call.params.source.id === "w1").length, 1);
  assert.equal(inventories.filter((call) => call.params.source.id === "w2").length, 1);
  assert.deepEqual(inventories[0].params.scopePaths, ["artifacts/a.txt", "artifacts/b.txt", "artifacts/pack"]);
  assert.deepEqual(inventories[1].params.scopePaths, inventories[0].params.scopePaths);
  assert.equal(inventories[0].params.relativePath, ".");
  const fpsync = calls.filter((call) => call.method === "sync.serverToServerFpsync");
  assert.equal(fpsync.length, 1);
  assert.deepEqual(fpsync[0].params.relativePaths, ["artifacts/a.txt", "artifacts/b.txt", "artifacts/pack/c.bin", "artifacts/pack/d.bin"]);
  assert.equal(fpsync[0].params.relativePaths.includes("artifacts/outside.txt"), false);
  const deletes = calls.filter((call) => call.method === "sync.deletePath");
  assert.deepEqual(deletes.map((call) => call.params.relativePath), ["artifacts/pack"]);
  assert.equal(provider.saved["artifacts/a.txt"].sha256, digest("artifacts/a.txt"));
  assert.equal(provider.saved["artifacts/pack"].fileHashes["artifacts/pack/c.bin"], digest("artifacts/pack/c.bin"));
  assert.equal(provider.saved["artifacts/pack"].fileHashes["artifacts/outside.txt"], undefined);
  assert.equal(scopeInventorySnapshot(files, ["artifacts/a.txt"]), JSON.stringify([["artifacts/a.txt", digest("artifacts/a.txt")]]));
});

test("local files share one upload manifest and a destination hash mismatch does not save holds", async () => {
  const calls = [];
  const provider = {
    context: { globalStorageUri: { fsPath: ROOT } },
    simpleSftpCapability: async () => {},
    simpleSftpApiCall: async (method) => { calls.push(method); throw new Error(`unexpected ${method}`); },
    assertSshTransportIdentities: async () => {},
    sftpServerOptions: (row) => ({ id: row.id, host: "worker.example", remotePath: "/proj/w2", user: "u", port: 22 }),
    updateSyncScopeHolds: async () => { throw new Error("holds must stay unchanged after a failed verify"); },
    syncScopeBatchLocalInventory: async () => ({
      "artifacts/a.txt": record("artifacts/a.txt"),
      "artifacts/b.txt": record("artifacts/b.txt"),
      "artifacts/c.txt": record("artifacts/c.txt"),
      "artifacts/excluded.txt": record("excluded"),
    }),
  };
  provider.verifiedSftpProjectInventory = async (options) => {
    calls.push({ method: "sync.projectInventory", source: options.source.id, scopePaths: options.scopePaths });
    return { files: { "artifacts/a.txt": record("other"), "artifacts/b.txt": record("artifacts/b.txt"), "artifacts/c.txt": record("artifacts/c.txt") } };
  };
  const originalExecute = vscodeStub.commands.executeCommand;
  const originalConfig = vscodeStub.workspace.getConfiguration;
  vscodeStub.commands.executeCommand = async (command, params) => { calls.push({ command, params }); return { ok: true }; };
  vscodeStub.workspace.getConfiguration = () => ({ get: () => [] });
  const { __transferSyncScopeBatchForTest } = require("../../dist/extension/legacy.js");
  try {
    await assert.rejects(() => __transferSyncScopeBatchForTest(provider, ROOT, [{ id: "w2", role: "worker" }], [
      { path: "artifacts/a.txt", name: "a.txt", directory: false, endpointId: "local" },
      { path: "artifacts/b.txt", name: "b.txt", directory: false, endpointId: "local" },
      { path: "artifacts/c.txt", name: "c.txt", directory: false, endpointId: "local" },
    ], ["w2"], () => {}), /内容校验不一致/);
  } finally {
    vscodeStub.commands.executeCommand = originalExecute;
    vscodeStub.workspace.getConfiguration = originalConfig;
  }
  const uploads = calls.filter((call) => call.command === "simpleSftp.uploadWorkspace");
  assert.equal(uploads.length, 1);
  assert.deepEqual(Object.keys(uploads[0].params.manifest).sort(), ["artifacts/a.txt", "artifacts/b.txt", "artifacts/c.txt"]);
  assert.equal(uploads[0].params.manifest["artifacts/excluded.txt"], undefined);
  assert.equal(calls.filter((call) => call.method === "sync.projectInventory").length, 1);
});
