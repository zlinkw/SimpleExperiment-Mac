const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
const ROOT = process.platform === "win32" ? "C:\\sync-scope-batch-fixture" : "/fixture/sync-scope-batch"; // r17：项目根按平台为已解析绝对路径（holds 只读派生，不落真实盘）

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
    context: { globalStorageUri: { fsPath: ROOT + "-plugin-state" } },
    localMachineStateGuard: () => ({ prefixes: [], unknown: false }),
    targetRootGuard: () => ({ prefixes: [], unknown: false }),
    simpleSftpCapability: async () => {},
    simpleSftpApiCall: async (method, params) => {
      calls.push({ method, params });
      if (method === "sync.projectInventory") return { files };
      if (method === "sync.serverToServerFpsync") return { ok: true };
      throw new Error(`unexpected ${method}`);
    },
    assertSshTransportIdentities: async () => {},
    deleteSyncScopeRemoteCopy: async (id, server, relativePath, directory) => calls.push({ method: "confirmed-delete", params: { id, server, relativePath, directory } }),
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
  const deletes = calls.filter((call) => call.method === "confirmed-delete");
  assert.deepEqual(deletes.map((call) => call.params.relativePath), ["artifacts/pack"]);
  assert.equal(provider.saved["artifacts/a.txt"].sha256, digest("artifacts/a.txt"));
  assert.equal(provider.saved["artifacts/pack"].fileHashes["artifacts/pack/c.bin"], digest("artifacts/pack/c.bin"));
  assert.equal(provider.saved["artifacts/pack"].fileHashes["artifacts/outside.txt"], undefined);
  assert.equal(scopeInventorySnapshot(files, ["artifacts/a.txt"]), JSON.stringify([["artifacts/a.txt", digest("artifacts/a.txt")]]));
});

// r117 接线迁移（r112 原 AST batch 用例 :86-93 的三条断言一一映射到这里，真实原型链 + dist 装载）：
// ①fpsync 携带非空身份且等于按冻结清单手写的上线格式预期；②同输入第二次（跨实例）逐字同代；
// ③改一个来源 SHA 开新代。方法必须完整走到 updateSyncScopeHolds 正常返回，不允许提前绕开。
function batchIdentityFixture(shaOverride) {
  const names = ["artifacts/a.txt", "artifacts/b.txt", "artifacts/pack/c.bin", "artifacts/pack/d.bin", "artifacts/outside.txt"];
  const files = Object.fromEntries(names.map((name) => [name, record(name)]));
  if (shaOverride) files["artifacts/a.txt"] = { sha256: shaOverride, size: 9 };
  const fpsyncs = [];
  const provider = {
    context: { globalStorageUri: { fsPath: ROOT + "-identity-plugin-state" } },
    localMachineStateGuard: () => ({ prefixes: [], unknown: false }),
    targetRootGuard: () => ({ prefixes: [], unknown: false }),
    simpleSftpCapability: async () => {},
    simpleSftpApiCall: async (method, params) => {
      if (method === "sync.projectInventory") return { files: structuredClone(files) };
      if (method === "sync.serverToServerFpsync") { fpsyncs.push(params); return { ok: true }; }
      throw new Error(`unexpected ${method}`);
    },
    assertSshTransportIdentities: async () => {},
    deleteSyncScopeRemoteCopy: async () => {},
    sftpServerOptions: (row) => ({ id: row.id, host: `${row.id}.example`, networkHost: `net-${row.id}`, remotePath: `/proj/${row.id}`, user: "u", port: 22 }),
    updateSyncScopeHolds: async (_root, mutate) => { provider.saved = {}; mutate(provider.saved); },
  };
  provider.verifiedSftpProjectInventory = async (options) => provider.simpleSftpApiCall("sync.projectInventory", options);
  const work = [
    { path: "artifacts/a.txt", name: "a.txt", directory: false, endpointId: "w1" },
    { path: "artifacts/b.txt", name: "b.txt", directory: false, endpointId: "w1" },
    { path: "artifacts/pack", name: "pack", directory: true, endpointId: "w1" },
  ];
  return { provider, fpsyncs, work };
}
const batchIdentityOracle = (paths, hashes) => {
  const sorted = [...paths].sort();
  const manifest = sorted.map((file) => [file, hashes[file].toLowerCase()]);
  return crypto.createHash("sha256").update(JSON.stringify(["sync-scope-retain", sorted, manifest])).digest("hex");
};

test("batch lane (:11084 批量保留文件版本) sends the frozen-manifest identity, reruns verbatim, and opens a generation on SHA change", async () => {
  const originalExecute = vscodeStub.commands.executeCommand;
  const originalConfig = vscodeStub.workspace.getConfiguration;
  vscodeStub.commands.executeCommand = async () => { throw new Error("worker batch sync must not upload"); };
  vscodeStub.workspace.getConfiguration = () => ({ get: () => [] });
  const { __transferSyncScopeBatchForTest } = require("../../dist/extension/legacy.js");
  try {
    const expectedPaths = ["artifacts/a.txt", "artifacts/b.txt", "artifacts/pack/c.bin", "artifacts/pack/d.bin"];
    const expectedHashes = Object.fromEntries(expectedPaths.map((name) => [name, digest(name)]));
    const first = batchIdentityFixture();
    const completed = await __transferSyncScopeBatchForTest(first.provider, ROOT, [{ id: "w1", role: "worker" }, { id: "w2", role: "worker" }], structuredClone(first.work), ["w2"], () => {});
    assert.deepEqual(completed, ["artifacts/a.txt", "artifacts/b.txt", "artifacts/pack"], "方法必须完整返回（holds 保存步骤不被绕开）");
    assert.equal(first.provider.saved["artifacts/pack"].fileHashes["artifacts/pack/c.bin"], digest("artifacts/pack/c.bin"), "完成证据须走到 :11139 的 holds 落盘");
    assert.equal(first.fpsyncs.length, 1);
    const sent = first.fpsyncs[0];
    assert.ok(sent.retentionKey, "批量 lane 必须携带非空 retentionKey（r112 现场占死的就是缺身份的共享 project-files 槽）");
    assert.match(sent.generation, /^[0-9a-f]{64}$/, "generation 64 位小写 hex，原样过 receiver transferScope64");
    assert.equal(sent.retentionKey, 'sync-scope-retain:["artifacts/a.txt","artifacts/b.txt","artifacts/pack/c.bin","artifacts/pack/d.bin"]',
      "scope 恰为冻结展开清单（目录已展开为子文件），不含 outside.txt");
    assert.equal(sent.generation, batchIdentityOracle(expectedPaths, expectedHashes), "身份逐字等于手写上线格式（盐+排序 scope+排序 path+SHA 清单），不经被测函数自证");
    const again = batchIdentityFixture();
    await __transferSyncScopeBatchForTest(again.provider, ROOT, [{ id: "w1", role: "worker" }, { id: "w2", role: "worker" }], structuredClone(again.work), ["w2"], () => {});
    assert.equal(again.fpsyncs.length, 1);
    assert.deepEqual({ retentionKey: again.fpsyncs[0].retentionKey, generation: again.fpsyncs[0].generation },
      { retentionKey: sent.retentionKey, generation: sent.generation }, "同输入跨实例逐字同代：同批重试复用己代走 receiver resume");
    const changed = batchIdentityFixture("f".repeat(64));
    await __transferSyncScopeBatchForTest(changed.provider, ROOT, [{ id: "w1", role: "worker" }, { id: "w2", role: "worker" }], structuredClone(changed.work), ["w2"], () => {});
    assert.equal(changed.fpsyncs.length, 1);
    assert.equal(changed.fpsyncs[0].retentionKey, sent.retentionKey, "同一逻辑批仍是同一逻辑源");
    assert.notEqual(changed.fpsyncs[0].generation, sent.generation, "来源 SHA 变化必须开新代，不与旧代混淆");
  } finally {
    vscodeStub.commands.executeCommand = originalExecute;
    vscodeStub.workspace.getConfiguration = originalConfig;
  }
});

test("local files share one upload manifest and a destination hash mismatch does not save holds", async () => {
  const calls = [];
  const provider = {
    context: { globalStorageUri: { fsPath: ROOT + "-plugin-state" } },
    localMachineStateGuard: () => ({ prefixes: [], unknown: false }),
    targetRootGuard: () => ({ prefixes: [], unknown: false }),
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
  const uploads = calls.filter((call) => call.command === "simpleSftpMac.uploadWorkspace");
  assert.equal(uploads.length, 1);
  assert.deepEqual(Object.keys(uploads[0].params.manifest).sort(), ["artifacts/a.txt", "artifacts/b.txt", "artifacts/c.txt"]);
  assert.equal(uploads[0].params.manifest["artifacts/excluded.txt"], undefined);
  assert.equal(calls.filter((call) => call.method === "sync.projectInventory").length, 1);
});
