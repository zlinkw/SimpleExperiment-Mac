// r112→r117 共享保留/合并链 fpsync 身份接线覆盖（现场依据：nwpu3 d-47be3d71…=sha256(["project-files",0])
// 与 lane1 d-008f3730… 被同一逻辑源自家 committed 代占满，此后每发必 TRANSFER_STAGE_PENDING）。
// r117 按 GPT 裁定（se-0-5-415-direction-20261026/plan.md）迁移后的分工：
// - batch lane（legacy.ts:11084）迁移至 test/features/syncScopeTransferBatch.test.js，经
//   __transferSyncScopeBatchForTest 真实原型链 + dist 装载执行；
// - 跨机对账 lane（:22036）经新增 __reconcileProjectFilesAcrossWorkersForTest 在 dist 上跑真实方法、
//   真实 planProjectMirror 规划，在 simpleSftpApiCall 捕获参数——绕过方法体不算证明接线；
// - 本文件保留 retain（:11364）与目录恢复（:11449）两个方法：AST 从 **src** 提取方法体、vm 隔离执行，
//   这是隔离单测技术，不证明 dist 装载链；目录身份按 r117 Q5 修复改用手写上线格式 oracle（纯函数
//   自比较不作目录内容变化断言的唯一依据）。
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'),
  Module = require('node:module'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
require('../_helpers/registerTsRequire');
const { syncScopeStagingIdentity } = require('../../src/features/JobArtifactSyncIdentity.ts');
const { safeSyncPath } = require('../../src/features/SyncResolution.ts');
const { scopeInventoryPathAllowed } = require('../../src/features/SyncScopeStatus.ts');
const { isUnderMachineStatePrefixes } = require('../../src/features/ProjectRootMap.ts');
const { planSyncScopeTransferGroups, batchSyncScopeInventoryPaths, scopeInventorySnapshot } = require('../../src/features/SyncScopeTransferBatch.ts');
const { normalizeMirrorScopePaths, filterInventoryByScope } = require('../../src/features/ProjectMirror.ts');
const { filterHeldFiles } = require('../../src/features/SyncResolution.ts');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/legacy.ts'), 'utf8');
const ast = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
const methods = {};
(function visit(n) { if (ts.isMethodDeclaration(n) && ['retainSyncScopeVersion', 'reconcileChosenDirectories'].includes(n.name.getText(ast))) methods[n.name.getText(ast)] = n; ts.forEachChild(n, visit); })(ast);
assert.deepEqual(Object.keys(methods).sort(), ['reconcileChosenDirectories', 'retainSyncScopeVersion'], '保留/目录恢复方法必须能从当前源码提取（batch/对账改走 dist 测试缝）');

function host(name, h, extra) {
  h[name] = vm.runInNewContext(ts.transpileModule('class Host{' + methods[name].getText(ast) + '};Host.prototype.' + name,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
  Object.assign({
    vscode: { workspace: { getConfiguration: () => ({ get: (_k, f) => f }) }, Uri: { file: x => x },
      window: { showWarningMessage: (...a) => Promise.resolve(a.at(-1)) }, commands: { executeCommand: async () => ({ ok: true }) } },
    path, safeSyncPath, scopeInventoryPathAllowed, isUnderMachineStatePrefixes, syncScopeStagingIdentity,
    planSyncScopeTransferGroups, batchSyncScopeInventoryPaths, scopeInventorySnapshot,
    normalizeMirrorScopePaths, filterInventoryByScope, filterHeldFiles, SYNC_SCOPE_REVIEWED_STALE_FILE_LIMIT: 200,
    workerFpsyncTaskLabel: () => '', UiCommandCancelled: Error, isLocalCodeOwnedPath: () => false,
    loadSyncHolds: async () => ({}), collectLocalScopeInventory: async () => { throw Error('本用例来源必须是 Worker'); },
    mirrorChosenWorkerVersionToLocal: async () => { throw Error('本用例不镜像本机'); },
    deleteLocalSyncPath: () => { throw Error('本用例不删本机文件'); }, confirmSyncScopePaths: async () => true,
  }, extra));
  return h;
}
const SHA = { a: 'a'.repeat(64), b: 'b'.repeat(64), c: 'c'.repeat(64) };
const identity = p => ({ retentionKey: p.retentionKey, generation: p.generation });
const pinned = (p, scopePaths, manifest, label) => {
  assert.ok(p.retentionKey && /^[0-9a-f]{64}$/.test(p.generation), label + '：fpsync 必须携带非空 retentionKey/generation');
  assert.deepEqual(identity(p), syncScopeStagingIdentity(scopePaths, manifest), label + '：身份必须等于按本批冻结清单计算的纯函数结果');
};
// r117 oracle：测试内手写的上线格式（盐+排序 scope+排序 path+SHA 清单），不经被测函数。
const keepLiteral = pairs => crypto.createHash('sha256').update(JSON.stringify(['sync-scope-retain', ['work_dirs/keep'],
  [...pairs].sort((l, r) => (l[0] === r[0] ? 0 : l[0] < r[0] ? -1 : 1))])).digest('hex');

function retainFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-retain-identity-'));
  const targets = [{ id: 'a', remotePath: '/p' }, { id: 'b', remotePath: '/p' }];
  const inventory = { a: { 'work_dirs/x.bin': { sha256: SHA.a, size: 3 } }, b: {} }, transfers = [];
  const h = host('retainSyncScopeVersion', {
    context: { globalStorageUri: { fsPath: root } }, syncScopeMutationInFlight: false,
    sftpServerOptions: row => row, assertSshTransportIdentities: async () => {}, updateSyncScopeHolds: async () => {},
    targetRootGuard: () => ({ prefixes: [], unknown: false }), localMachineStateGuard: () => ({ prefixes: [], unknown: false }),
    verifiedSftpProjectInventory: async ({ source }) => ({ files: structuredClone(inventory[source.id] || {}) }),
    simpleSftpApiCall: async (method, p) => { assert.equal(method, 'sync.serverToServerFpsync'); transfers.push(p);
      for (const file of p.relativePaths) inventory[p.destination.id][file] = structuredClone(inventory[p.source.id][file]); },
  });
  return { h, inventory, run: () => h.retainSyncScopeVersion(root, targets, 'work_dirs/x.bin', 'a', false, () => {}, true, ['b']), transfers };
}
test('retain lane (:11364 手动保留/合并扇出·文件) sends the frozen-manifest identity and retries reuse it verbatim', async () => {
  const f = retainFixture();
  assert.equal(await f.run(), true); assert.equal(f.transfers.length, 1);
  pinned(f.transfers[0], ['work_dirs/x.bin'], { 'work_dirs/x.bin': SHA.a }, '保留');
  assert.equal(await f.run(), true);
  assert.deepEqual(identity(f.transfers[1]), identity(f.transfers[0]), '同一批第二次调用 retentionKey/generation 逐字相等（不再开新代）');
  const g = retainFixture(); g.inventory.a['work_dirs/x.bin'] = { sha256: SHA.c, size: 3 };
  assert.equal(await g.run(), true);
  assert.notEqual(g.transfers[0].generation, f.transfers[0].generation, '来源 SHA 变化必须开新代');
});

// r117（Q5）：目录保留的清单以子文件为键（legacy.ts:11314 sourceInventory），旧实现查 sourceFiles[目录]
// 恒得 [["dir",""]]——子文件改 SHA/增删都被算成同代。此用例走完整确认与来源复核，捕获真实参数。
function retainDirFixture(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-retain-dir-identity-'));
  const targets = [{ id: 'a', remotePath: '/p' }, { id: 'b', remotePath: '/p' }];
  const inventory = { a: { 'work_dirs/keep/m.pth': { sha256: SHA.a, size: 3 }, 'work_dirs/keep/sub/n.bin': { sha256: SHA.b, size: 2 } }, b: {} };
  if (mutate) mutate(inventory.a);
  const transfers = [];
  const h = host('retainSyncScopeVersion', {
    context: { globalStorageUri: { fsPath: root } }, syncScopeMutationInFlight: false,
    sftpServerOptions: row => row, assertSshTransportIdentities: async () => {}, updateSyncScopeHolds: async () => {},
    targetRootGuard: () => ({ prefixes: [], unknown: false }), localMachineStateGuard: () => ({ prefixes: [], unknown: false }),
    verifiedSftpProjectInventory: async ({ source }) => ({ files: structuredClone(inventory[source.id] || {}) }),
    simpleSftpApiCall: async (method, p) => {
      if (method === 'sync.projectTree') return { entries: [{ path: 'work_dirs/keep', directory: true }] };
      assert.equal(method, 'sync.serverToServerFpsync'); transfers.push(p);
      for (const [file, info] of Object.entries(inventory[p.source.id])) if (file.startsWith(p.relativePath + '/')) inventory[p.destination.id][file] = structuredClone(info);
    },
  });
  return { run: () => h.retainSyncScopeVersion(root, targets, 'work_dirs/keep', 'a', true, () => {}, false, ['b']), transfers };
}
test('retain lane directory mode (:11364 手动保留目录) sends the complete frozen descendant manifest and content changes open new generations', async () => {
  const f = retainDirFixture();
  assert.equal(await f.run(), true); assert.equal(f.transfers.length, 1);
  const sent = f.transfers[0];
  assert.ok(sent.retentionKey && /^[0-9a-f]{64}$/.test(sent.generation), '目录保留：fpsync 必须携带非空 retentionKey/generation');
  assert.equal(sent.retentionKey, 'sync-scope-retain:["work_dirs/keep"]', '目录即逻辑源，key 只含 scope 清单');
  assert.equal(sent.generation, keepLiteral([['work_dirs/keep/m.pth', SHA.a], ['work_dirs/keep/sub/n.bin', SHA.b]]),
    '目录身份必须等于目录内全部冻结子文件的手写上线格式预期（非纯函数自证）');
  const g = retainDirFixture(); assert.equal(await g.run(), true);
  assert.deepEqual(identity(g.transfers[0]), identity(sent), '同目录同内容重试逐字复用同代');
  const changed = retainDirFixture(files => { files['work_dirs/keep/m.pth'] = { sha256: SHA.c, size: 3 }; });
  assert.equal(await changed.run(), true);
  assert.notEqual(changed.transfers[0].generation, sent.generation, '目录内子文件 SHA 变化必须开新代（r117 修复的现场缺陷点）');
  const shrunk = retainDirFixture(files => { delete files['work_dirs/keep/sub/n.bin']; });
  assert.equal(await shrunk.run(), true);
  assert.notEqual(shrunk.transfers[0].generation, sent.generation, '目录内删除子文件必须开新代');
});

function directoryRestoreFixture(mutateHolds, mutateInventories) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-direstore-identity-'));
  const targets = [{ id: 'a', remotePath: '/p' }, { id: 'b', remotePath: '/p' }];
  const holds = { 'work_dirs/keep': { status: 'resolved', directory: true, endpointId: 'a', fileHashes: { 'work_dirs/keep/m.pth': SHA.a } } };
  const inventories = { a: { 'work_dirs/keep/m.pth': { sha256: SHA.a } }, b: { 'work_dirs/keep/m.pth': { sha256: SHA.b } } };
  if (mutateHolds) mutateHolds(holds);
  if (mutateInventories) mutateInventories(inventories);
  const transfers = [];
  const h = host('reconcileChosenDirectories', {
    context: { globalStorageUri: { fsPath: root } }, sftpServerOptions: row => row, assertSshTransportIdentities: async () => {},
    targetRootGuard: () => ({ prefixes: [], unknown: false }), deleteSyncScopeRemoteCopy: async () => {}, updateSyncScopeHolds: async () => {},
    verifiedSftpProjectInventory: async ({ source }) => ({ files: structuredClone(inventories[source.id] || {}) }),
    simpleSftpApiCall: async (method, p) => { assert.equal(method, 'sync.serverToServerFpsync'); transfers.push(p);
      for (const [file, info] of Object.entries(inventories[p.source.id])) if (file.startsWith(p.relativePath + '/')) inventories[p.destination.id][file] = structuredClone(info); },
  });
  return { run: () => h.reconcileChosenDirectories(root, targets, structuredClone(holds), structuredClone(inventories), ['.']), transfers };
}
test('directory-restore lane (:11449 恢复手动保留目录) sends the identity derived from the holds manifest', async () => {
  const f = directoryRestoreFixture(); await f.run(); assert.equal(f.transfers.length, 1);
  pinned(f.transfers[0], ['work_dirs/keep'], { 'work_dirs/keep/m.pth': SHA.a }, '目录恢复');
  assert.equal(f.transfers[0].generation, keepLiteral([['work_dirs/keep/m.pth', SHA.a]]),
    'r117：目录恢复身份 = 冻结子文件清单的手写上线格式（不经被测函数自证）');
  const g = directoryRestoreFixture(); await g.run();
  assert.deepEqual(identity(g.transfers[0]), identity(f.transfers[0]), '同一 holds 记录重复恢复逐字同代');
  const changed = directoryRestoreFixture(
    holds => { holds['work_dirs/keep'].fileHashes = { 'work_dirs/keep/m.pth': SHA.c }; },
    inventories => { inventories.a['work_dirs/keep/m.pth'] = { sha256: SHA.c }; });
  await changed.run(); assert.equal(changed.transfers.length, 1);
  assert.equal(changed.transfers[0].retentionKey, f.transfers[0].retentionKey, '同一目录仍是同一逻辑源');
  assert.notEqual(changed.transfers[0].generation, f.transfers[0].generation, '目录内子文件内容变化必须开新代');
  const grown = directoryRestoreFixture(
    holds => { holds['work_dirs/keep'].fileHashes = { 'work_dirs/keep/m.pth': SHA.a, 'work_dirs/keep/extra.bin': SHA.b }; },
    inventories => { inventories.a['work_dirs/keep/extra.bin'] = { sha256: SHA.b }; });
  await grown.run(); assert.equal(grown.transfers.length, 1);
  assert.notEqual(grown.transfers[0].generation, f.transfers[0].generation, '目录内新增子文件必须开新代');
});

// ==== r117 跨机对账 lane：dist 真实方法 + 真实原型链 + 真实 planProjectMirror ====
// provider 只显式给出：网络/SSH 替身、库存数据、状态文件租约透传；规划、目录恢复、状态落盘全走真实代码。
// 断言不注入假计划：来源 a 有 x+y、目标 b 只有 x → 真实规划只对 y 发一包。
const distVscodeStub = {
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: { showWarningMessage: async (...a) => a.at(-1), showInformationMessage: async () => undefined },
  commands: { executeCommand: async () => ({ ok: true }) },
  Uri: { file: value => ({ fsPath: value }) },
};
const originalLoad = Module._load;
Module._load = function (request, ...args) { return request === 'vscode' ? distVscodeStub : originalLoad.call(this, request, ...args); };
const { __reconcileProjectFilesAcrossWorkersForTest } = require('../../dist/extension/legacy.js');
const { projectMirrorStateStoragePath, emptyPlanSyncLedger } = require('../../dist/features/PlanArtifactSync.js');
const CODE = { x: 'd'.repeat(64), y: 'e'.repeat(64) };
function reconcileFixture(mutateTarget) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'se-reconcile-seam-'));
  const targets = [{ id: 'a', role: 'worker' }, { id: 'b', role: 'worker' }];
  const inventories = { a: { 'code/x.py': { sha256: CODE.x }, 'code/y.py': { sha256: CODE.y } }, b: { 'code/x.py': { sha256: CODE.x } } };
  if (mutateTarget) mutateTarget(inventories);
  const transfers = [];
  const provider = {
    syncScopeMutationInFlight: false,
    context: { globalStorageUri: { fsPath: root } },
    workerCodeSyncTargets: () => targets, enabledWorkerConfigs: () => targets,
    captureProjectContext: () => ({}), syncCodeTargets: async () => {},
    loadPlanSyncLedger: async () => emptyPlanSyncLedger(), // 生产真实形状 {schemaVersion:2, entries:{}}（PlanArtifactSync.ts:16-18）；r118 红2：{} 缺 entries，pendingPlanSyncs 依赖该合同（PlanArtifactSync.ts:144），属夹具形状错而非生产缺陷
    withPluginStateFileLease: async (_root, _file, _kind, _label, run) => run(), // 状态文件租约隔离；真实写盘仍在私有夹具内
    localMachineStateGuard: () => ({ prefixes: [], unknown: false }),
    targetRootGuard: () => ({ prefixes: [], unknown: false }),
    sftpServerOptions: row => ({ id: row.id, host: `${row.id}.example`, networkHost: `net-${row.id}`, remotePath: `/proj/${row.id}`, user: 'u', port: 22 }),
    assertSshTransportIdentities: async () => {},
    verifiedSftpProjectInventory: async ({ source }) => ({ files: structuredClone(inventories[source.id] || {}) }),
    simpleSftpApiCall: async (method, p) => {
      assert.equal(method, 'sync.serverToServerFpsync', '对账缝用例不得触发其它远端 API');
      transfers.push(p);
      for (const file of p.relativePaths) inventories[p.destination.id][file] = structuredClone(inventories[p.source.id][file]);
    },
  };
  distVscodeStub.workspace.workspaceFolders = [{ uri: { scheme: 'file', path: root.replace(/\\/g, '/'), fsPath: root, toString: () => 'file://' + root.replace(/\\/g, '/') } }];
  return { root, transfers, run: () => __reconcileProjectFilesAcrossWorkersForTest(provider, root) };
}
test('cross-worker reconcile lane (:22036 项目文件补齐) drives the real planner through the dist seam and freezes the source identity', async () => {
  try {
    const f = reconcileFixture();
    await f.run();
    assert.equal(f.transfers.length, 1, '真实规划应只对目标缺失的 code/y.py 发一包');
    const sent = f.transfers[0];
    assert.deepEqual(sent.relativePaths, ['code/y.py']);
    assert.ok(sent.retentionKey && /^[0-9a-f]{64}$/.test(sent.generation), '对账 lane 必须携带非空身份');
    assert.equal(sent.retentionKey, 'sync-scope-retain:["code/y.py"]', 'frozen scope 即实际补齐路径清单，目标已有的 x 不进身份');
    assert.equal(sent.generation, crypto.createHash('sha256').update(JSON.stringify(['sync-scope-retain', ['code/y.py'], [['code/y.py', CODE.y]]])).digest('hex'),
      '身份 = 来源侧冻结 SHA 的手写上线格式；目标已有 x 属进度，不参与身份');
    assert.equal(JSON.parse(fs.readFileSync(projectMirrorStateStoragePath(f.root, f.root), 'utf8')).complete, true, '正常完成后必须落完整状态');
    await f.run();
    assert.equal(f.transfers.length, 1, '同步完成后计划自然清空，第二次运行不再发包');
    const again = reconcileFixture(); await again.run();
    assert.deepEqual(identity(again.transfers[0]), identity(sent), '可重复发包的同输入跨实例逐字同代');
    const drifting = reconcileFixture(inventories => { inventories.b['code/x.py'] = { sha256: 'f'.repeat(64) }; });
    await assert.rejects(() => drifting.run(), /项目同步未完成/);
    assert.equal(drifting.transfers.length, 1);
    assert.deepEqual(identity(drifting.transfers[0]), identity(sent), '目标侧内容漂移不改变来源冻结身份（冲突仍由完成校验拒绝）');
    const shifted = reconcileFixture(inventories => { inventories.a['code/y.py'] = { sha256: 'c'.repeat(64) }; });
    await shifted.run();
    assert.equal(shifted.transfers.length, 1);
    assert.equal(shifted.transfers[0].retentionKey, sent.retentionKey, '同一补齐路径仍是同一逻辑源');
    assert.notEqual(shifted.transfers[0].generation, sent.generation, '来源 SHA 改变必须开新代（方向计划 B 段要求，r122 补齐）');
  } finally {
    distVscodeStub.workspace.workspaceFolders = [];
  }
});
