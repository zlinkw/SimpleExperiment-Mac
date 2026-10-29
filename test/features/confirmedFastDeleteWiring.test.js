const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require('../_helpers/registerTsRequire');
const { PlanCleanup } = require('../../src/features/PlanCleanup.ts');
const { previewConfirmedScopeDeletion, completeConfirmedScopeDeletion } = require('../../src/features/SyncScopeDelete.ts');
const { chunkFastDeleteTargets } = require('../../src/features/FastDeleteContract.ts');

const clone = value => JSON.parse(JSON.stringify(value));
const FAST = { confirmedPathDeletion: 1, entryIdentityBind: 1, batchedFastDelete: 1, directoryTreeIsolateDelete: 1, isolationRenameNoReplace: 1, fastDeleteBatchLimit: 5000, registeredIsolationDeletion: 1 };
const err = (code, message) => Object.assign(new Error(message || code), { apiData: { code } });
const isoName = relativePath => '__iso_' + relativePath.replace(/[^\w]/g, '_');
const node = { id: 'w1', kind: 'remote', root: '/project', host: 'h', user: 'u', port: 22 };
const CONSUMER = 'D:/local/consumer-project';
const SENTENCE = '我确认所列路径正确、文件未被占用，并同意永久删除';

/** Engine double mirroring the SimpleSFTP cb2de41c fast contract: batched preview/confirm/execute/status only. */
function makeEngine({ present = new Set(), dirs = new Set(), residue = new Set(), legacy = false, unknownAction = false, updateRequired = false, wrongType = false, failExecuteOnce = false, onExecute = null } = {}) {
  const calls = [], rows = new Map(); let counter = 0;
  const rpc = async (method, params) => {
    calls.push({ method, params: clone(params) });
    if (method === 'files.cleanup.preview') {
      if (unknownAction) throw err('UNKNOWN_ACTION');
      if (updateRequired) throw err('UPDATE_REQUIRED');
      if (params.authorizationMode !== 'confirmed_paths' || params.action !== 'delete') throw err('INVALID_ACTION');
      if (!Array.isArray(params.targets) || !params.targets.length || params.targets.length > 5000) throw err('INVALID_REQUEST');
      const root = String(params.node.root).replace(/\/$/, '');
      const targets = params.targets.map((target, index) => {
        const absolutePath = root + '/' + target.relativePath;
        if (!present.has(target.relativePath)) return { ...target, absolutePath, missing: true };
        const row = { ...target, absolutePath, device: 42, inode: 100 + index, fingerprint: 'fp-' + target.relativePath };
        if (wrongType && target.type === 'directory') return { ...row, type: 'file' };
        if (dirs.has(target.relativePath)) return { ...row, isolationName: isoName(target.relativePath), isolationAbsolutePath: root + '/' + isoName(target.relativePath) };
        return row;
      });
      if (legacy) return { token: 'legacy-' + (++counter), digest: 'd' + counter, safety: { confirmedPathDeletion: 1 }, rootIdentity: { path: params.node.root }, targets };
      const row = { token: 'tok' + (++counter), digest: 'd' + counter, safety: clone(FAST), rootIdentity: { path: params.node.root }, targets, confirmations: 0, node: params.node };
      rows.set(row.token, row);
      return clone(row);
    }
    const row = rows.get(params.token); if (!row) throw err('UNKNOWN_TOKEN');
    if (method === 'files.cleanup.status') {
      const observations = row.targets.map(target => present.has(target.relativePath)
        ? { state: 'pending' } : residue.has(target.relativePath) ? { state: 'unknown', isolationStatus: 'present' } : { state: 'completed', status: 'gone' });
      return clone({ token: row.token, digest: row.digest, rootIdentity: row.rootIdentity, targets: row.targets, confirmations: row.confirmations,
        observations, states: observations.map(row2 => row2.state), batchExecuting: false });
    }
    if (method === 'files.cleanup.confirm') {
      if (params.confirm !== true || params.digest !== row.digest || params.phase !== row.confirmations + 1
        || JSON.stringify(params.exactTargets) !== JSON.stringify(row.targets.filter(target => !target.missing).map(target => target.absolutePath))) throw err('CONFIRM_REQUIRED');
      row.confirmations = params.phase; return { ok: true };
    }
    if (method === 'files.cleanup.execute') {
      if (row.confirmations < 2 || params.digest !== row.digest || !Number.isInteger(params.index) || !row.targets[params.index] || row.targets[params.index].missing) throw err('NOT_AN_EXECUTABLE_TARGET');
      if (onExecute) await onExecute();
      row.targets.forEach(target => { if (!target.missing) present.delete(target.relativePath); });
      if (failExecuteOnce) throw new Error('response lost');
      return { ok: true };
    }
    if (['files.cleanup.check', 'files.cleanup.verify', 'files.cleanup.inspect', 'files.cleanup.settle'].includes(method))
      throw new Error('legacy per-file RPC must not touch the fast chain: ' + method);
    throw new Error('unexpected method ' + method);
  };
  const countOf = method => calls.filter(call => call.method.endsWith(method)).length;
  return { rpc, calls, present, countOf };
}

async function batchFixture(options) {
  const engine = makeEngine(options);
  const entries = options.entries || [];
  const batches = await previewConfirmedScopeDeletion(engine.rpc, node, entries, CONSUMER);
  return { engine, batches };
}

test('the batch preview sends one bounded public request instead of one call per file', async () => {
  for (const total of [1200, 6000]) {
    const present = new Set(Array.from({ length: total }, (_, index) => 'work_dirs/f' + index));
    const engine = makeEngine({ present });
    const entries = Array.from({ length: total }, (_, index) => ({ relativePath: 'work_dirs/f' + index, directory: false }));
    const batches = await previewConfirmedScopeDeletion(engine.rpc, node, entries, CONSUMER);
    assert.equal(engine.countOf('.preview'), 1 + (total > 5000 ? 1 : 0));
    assert.deepEqual(batches.map(batch => batch.rows.length), total > 5000 ? [5000, 1000] : [total]);
    assert.equal(batches.flatMap(batch => batch.rows).filter(row => row.absolutePath && row.type === 'file').length, total);
  }
  assert.deepEqual(chunkFastDeleteTargets([]), []);
});

test('preview rows carry the full original to isolation mapping and fail closed on older engines', async () => {
  const entries = [{ relativePath: 'work_dirs/job', directory: true }, { relativePath: 'work_dirs/metrics.csv', directory: false }, { relativePath: 'work_dirs/gone.csv', directory: false }];
  const { engine, batches } = await batchFixture({ present: new Set(['work_dirs/job', 'work_dirs/metrics.csv']), dirs: new Set(['work_dirs/job']), entries });
  assert.equal(batches.length, 1);
  const [file, dir, gone] = [batches[0].rows[1], batches[0].rows[0], batches[0].rows[2]];
  assert.equal(dir.absolutePath, '/project/work_dirs/job');
  assert.equal(dir.isolationAbsolutePath, '/project/' + isoName('work_dirs/job'));
  assert.equal(dir.device, 42); assert.equal(typeof dir.inode, 'number');
  assert.equal(file.isolationAbsolutePath, undefined);
  assert.equal(gone.missing, true);
  const legacy = makeEngine({ legacy: true, present: new Set(['work_dirs/job']) });
  await assert.rejects(previewConfirmedScopeDeletion(legacy.rpc, node, [{ relativePath: 'work_dirs/job', directory: true }], CONSUMER),
    error => { assert.match(error.message, /批量快速删除链/); assert.equal(error.apiData.code, 'SFTP_FAST_DELETE_UPGRADE_REQUIRED'); return true; });
  assert.equal(legacy.countOf('.confirm'), 0); assert.equal(legacy.countOf('.execute'), 0);
  const changed = makeEngine({ present: new Set(['work_dirs/job']), wrongType: true });
  await assert.rejects(previewConfirmedScopeDeletion(changed.rpc, node, [{ relativePath: 'work_dirs/job', directory: true }], CONSUMER), /路径或类型已变化/);
  assert.equal(changed.countOf('.confirm'), 0);
});

test('a frozen batch confirms twice with exact targets, executes once and resolves through the batched query', async () => {
  const entries = [{ relativePath: 'work_dirs/job', directory: true }, { relativePath: 'work_dirs/metrics.csv', directory: false }, { relativePath: 'work_dirs/gone.csv', directory: false }];
  const { engine, batches } = await batchFixture({ present: new Set(['work_dirs/job', 'work_dirs/metrics.csv']), dirs: new Set(['work_dirs/job']), entries });
  const outcomes = await completeConfirmedScopeDeletion(engine.rpc, batches[0], () => {}, { wait: async () => {} });
  assert.deepEqual(outcomes.map(row => [row.relativePath, row.state]), [['work_dirs/job', 'completed'], ['work_dirs/metrics.csv', 'completed'], ['work_dirs/gone.csv', 'completed']]);
  assert.equal(engine.countOf('.confirm'), 2);
  assert.deepEqual(engine.calls.filter(call => call.method.endsWith('.confirm')).map(call => call.params.phase), [1, 2]);
  assert.deepEqual(engine.calls.filter(call => call.method.endsWith('.confirm'))[0].params.exactTargets, ['/project/work_dirs/job', '/project/work_dirs/metrics.csv']);
  assert.equal(engine.countOf('.execute'), 1);
  assert.ok(engine.countOf('.status') <= 4, 'status polling stays bounded');
  assert.equal(engine.countOf('.check'), 0);
});

test('a lost execute response resolves via the batched query without replaying execute', async () => {
  const entries = [{ relativePath: 'work_dirs/a.csv', directory: false }, { relativePath: 'work_dirs/b.csv', directory: false }];
  const { engine, batches } = await batchFixture({ present: new Set(['work_dirs/a.csv', 'work_dirs/b.csv']), entries, failExecuteOnce: true });
  const outcomes = await completeConfirmedScopeDeletion(engine.rpc, batches[0], () => {}, { wait: async () => {} });
  assert.deepEqual(outcomes.map(row => row.state), ['completed', 'completed']);
  assert.equal(engine.countOf('.execute'), 1);
});

test('isolation residue is reported honestly per path and is never replayed', async () => {
  const entries = [{ relativePath: 'work_dirs/job', directory: true }, { relativePath: 'work_dirs/metrics.csv', directory: false }];
  const { engine, batches } = await batchFixture({ present: new Set(['work_dirs/job', 'work_dirs/metrics.csv']), dirs: new Set(['work_dirs/job']), residue: new Set(['work_dirs/job']), entries });
  const outcomes = await completeConfirmedScopeDeletion(engine.rpc, batches[0], () => {}, { wait: async () => {} });
  const dir = outcomes.find(row => row.relativePath === 'work_dirs/job'), file = outcomes.find(row => row.relativePath === 'work_dirs/metrics.csv');
  assert.equal(file.state, 'completed');
  assert.equal(dir.state, 'failed');
  assert.match(dir.error, /隔离名残留/); assert.match(dir.error, /不会自动重发/);
  assert.equal(engine.countOf('.execute'), 1);
});

test('a tampered target list is rejected at confirm before any execute request', async () => {
  const entries = [{ relativePath: 'work_dirs/a.csv', directory: false }];
  const { engine, batches } = await batchFixture({ present: new Set(['work_dirs/a.csv']), entries });
  batches[0].rows[0].absolutePath = '/project/work_dirs/other.csv';
  await assert.rejects(completeConfirmedScopeDeletion(engine.rpc, batches[0], () => {}, { wait: async () => {} }), error => error.apiData?.code === 'CONFIRM_REQUIRED');
  assert.equal(engine.countOf('.execute'), 0);
});

async function serviceFixture(options = {}) {
  const present = new Set(['work_dirs/job', 'work_dirs/metrics.csv', 'work_dirs/loss.csv']);
  const engine = makeEngine({ present, dirs: new Set(['work_dirs/job']), ...options });
  const candidate = (relativePath, type) => ({ nodeId: 'w1', relativePath, type, category: '专用产物', owners: ['owner'], evidence: ['exact registered target'], dependencies: [] });
  const scope = { projectId: 'project', planKey: 'owner', planFile: 'experiments/plans/p.yaml', planHash: 'hash', runIds: ['run'], revision: 'rev',
    nodes: [node], observationMode: 'managed_tmux', authorizationMode: 'confirmed_paths', blockers: [],
    candidates: [candidate('work_dirs/job', 'directory'), candidate('work_dirs/metrics.csv', 'file'), candidate('work_dirs/loss.csv', 'file')] };
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-delete-'));
  const service = new PlanCleanup({ storageRoot, sftp: engine.rpc, collect: async () => clone(scope), restoreGate: async () => {}, updateIndexes: async () => {}, currentNode: async () => node });
  const preview = () => service.preview({ planFile: scope.planFile, action: 'delete', authorizationMode: 'confirmed_paths' });
  const confirmBoth = async model => {
    const exactTargets = model.rows.map(row => row.node.id + ':' + row.absolutePath);
    for (const phase of [1, 2]) await service.confirm({ token: model.token, digest: model.digest, phase, confirm: true, exactTargets });
    return model;
  };
  return { engine, service, scope, preview, confirmBoth };
}

test('the reviewed page freezes isolation mappings onto its confirmed rows', async () => {
  const f = await serviceFixture();
  const preview = await f.preview();
  assert.deepEqual(preview.rows.map(row => row.disposition), ['delete', 'delete', 'delete']);
  const dir = preview.rows.find(row => row.type === 'directory');
  assert.equal(dir.isolationAbsolutePath, '/project/' + isoName('work_dirs/job'));
  assert.equal(dir.device, 42);
  assert.ok(preview.rows.every(row => row.backendToken));
});

for (const mode of ['legacy', 'unknownAction']) test(`a ${mode} endpoint fails the confirmed review with one unified upgrade error and zero mutation calls`, async () => {  const f = await serviceFixture(mode === 'legacy' ? { legacy: true } : { unknownAction: true });
  await assert.rejects(f.preview(), error => {
    assert.equal(error.apiData.code, 'SFTP_FAST_DELETE_UPGRADE_REQUIRED');
    assert.match(error.message, /不支持确认路径的批量快速删除/);
    return true;
  });
  assert.deepEqual(f.engine.calls.map(call => call.method.replace('files.cleanup.', '')).filter(name => name !== 'preview'), []);
});

test('the unified upgrade mapping is delete-scoped at the public preview: isolate keeps its own error fail-closed', async () => {
  // delete on an endpoint refusing UPDATE_REQUIRED: one unified upgrade error, zero mutations.
  const d = await serviceFixture({ updateRequired: true });
  await assert.rejects(d.preview(), error => {
    assert.equal(error.apiData.code, 'SFTP_FAST_DELETE_UPGRADE_REQUIRED');
    assert.match(error.message, /不支持确认路径的批量快速删除/);
    return true;
  });
  assert.deepEqual(d.engine.calls.map(call => call.method.replace('files.cleanup.', '')).filter(name => name !== 'preview'), []);
  // isolate on the same refusing endpoint: no fast-delete wording, its own error stays visible, nothing runs.
  const f = await serviceFixture({ updateRequired: true });
  const preview = await f.service.preview({ planFile: f.scope.planFile, action: 'isolate', authorizationMode: 'confirmed_paths' });
  assert.ok(preview.rows.length);
  assert.deepEqual([...new Set(preview.rows.map(row => row.disposition))], ['unverified']);
  assert.deepEqual([...new Set(preview.rows.map(row => row.error))], ['UPDATE_REQUIRED']);
  assert.ok(preview.blockers.some(row => row.code === 'UPDATE_REQUIRED'), 'the isolate refusal stays visible with its own code');
  assert.ok(!preview.blockers.some(row => row.code === 'SFTP_FAST_DELETE_UPGRADE_REQUIRED' || String(row.detail).includes('快速删除')), 'no fast-delete wording leaks onto isolate rows');
  assert.deepEqual(f.engine.calls.map(call => call.method.replace('files.cleanup.', '')).filter(name => name !== 'preview'), []);
});

test('confirmed execution runs one execute per frozen batch and completes through the batched query', async () => {
  const f = await serviceFixture();
  const model = await f.confirmBoth(await f.preview());
  const operation = await f.service.execute(model.token);
  assert.equal(operation.state, 'completed');
  assert.equal(f.engine.countOf('.execute'), 1);
  assert.equal(f.engine.countOf('.check'), 0); assert.equal(f.engine.countOf('.verify'), 0);
  assert.deepEqual([...f.engine.present], []);
});

test('isolation residue leaves an honest partial result that no later observation re-executes', async () => {
  const f = await serviceFixture({ residue: new Set(['work_dirs/job']) });
  const model = await f.confirmBoth(await f.preview());
  const operation = await f.service.execute(model.token);
  assert.equal(operation.state, 'partial');
  assert.match(operation.error, /不会自动重发/);
  const dirRow = operation.preview.rows.find(row => row.type === 'directory');
  assert.equal(operation.targets[dirRow.id].state, 'pending');
  assert.match(operation.targets[dirRow.id].error, /present/);
  const refreshed = await f.service.status(model.token);
  assert.equal(refreshed.state, 'partial');
  assert.equal(f.engine.countOf('.execute'), 1);
});

test('a cancellation stops before the next frozen batch without replaying anything', async () => {
  const nodes = [node, { ...node, id: 'w2', root: '/project2' }];
  const present = new Set(['work_dirs/a.csv']);
  let fired = false, service, operationId;
  const engine = makeEngine({ present, onExecute: async () => { if (!fired) { fired = true; await service.cancel(operationId); } } });
  const candidate = (nodeId, relativePath) => ({ nodeId, relativePath, type: 'file', category: '专用产物', owners: ['owner'], evidence: ['exact registered target'], dependencies: [] });
  const scope = { projectId: 'project', planKey: 'owner', planFile: 'experiments/plans/p.yaml', planHash: 'hash', runIds: ['run'], revision: 'rev',
    nodes, observationMode: 'managed_tmux', authorizationMode: 'confirmed_paths', blockers: [],
    candidates: [candidate('w1', 'work_dirs/a.csv'), candidate('w2', 'work_dirs/a.csv')] };
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-delete-cancel-'));
  service = new PlanCleanup({ storageRoot, sftp: engine.rpc, collect: async () => clone(scope), restoreGate: async () => {}, updateIndexes: async () => {}, currentNode: async id => nodes.find(row => row.id === id) });
  const model = await service.preview({ planFile: scope.planFile, action: 'delete', authorizationMode: 'confirmed_paths' });
  assert.equal(model.rows.length, 2);
  const tokens = new Set(model.rows.map(row => row.backendToken));
  assert.equal(tokens.size, 2, 'two nodes freeze two backend batches');
  const exactTargets = model.rows.map(row => row.node.id + ':' + row.absolutePath);
  for (const phase of [1, 2]) await service.confirm({ token: model.token, digest: model.digest, phase, confirm: true, exactTargets });
  operationId = model.token;
  const operation = await service.execute(operationId);
  assert.equal(operation.state, 'paused');
  assert.equal(engine.countOf('.execute'), 1, 'only the first frozen batch ever received an execute');
});

test('the Host wrapper accepts the fast answer without retired gates and maps refusals to one upgrade error', async () => {
  const modulePath = require.resolve('../../dist/extension/PlanCleanupHost'), from = require('node:module').createRequire(modulePath), exports = {};
  vm.runInNewContext(await fs.readFile(modulePath, 'utf8'), { exports, require: name => ['vscode', './PlanCleanupPanel'].includes(name) ? {} : from(name) });
  const answered = [];
  const host = new exports.PlanCleanupHost({ context: { globalStorageUri: { fsPath: await fs.mkdtemp(path.join(os.tmpdir(), 'fast-host-')) } },
    simpleSftpApiCall: async (method, params) => {
      answered.push([method, params]);
      if (host.fixture.reply) return host.fixture.reply;
      if (host.fixture.throw) throw host.fixture.throw;
      return host.fixture.value;
    } }, 'C:/fixture');
  host.fixture = {};
  host.fixture.reply = { value: undefined };
  // Fast answer without any retired generic-chain gates must pass.
  host.fixture = { value: { token: 't', digest: 'd', safety: clone(FAST), targets: [{ absolutePath: '/project/a', type: 'file' }] } };
  assert.equal((await host.service.ports.sftp('files.cleanup.preview', { action: 'delete', authorizationMode: 'confirmed_paths', targets: [{ relativePath: 'a', type: 'file' }] })).safety.batchedFastDelete, 1);
  // Legacy answer without fast flags maps to the unified upgrade error.
  host.fixture = { value: { token: 't', digest: 'd', safety: { confirmedPathDeletion: 1 }, targets: [] } };
  await assert.rejects(host.service.ports.sftp('files.cleanup.preview', { action: 'delete', authorizationMode: 'confirmed_paths', targets: [{ relativePath: 'a', type: 'file' }] }),
    error => error.apiData.code === 'SFTP_FAST_DELETE_UPGRADE_REQUIRED');
  // Refusals with the upgrade codes map to the same unified error.
  host.fixture = { throw: err('UNKNOWN_ACTION') };
  await assert.rejects(host.service.ports.sftp('files.cleanup.preview', { action: 'delete', authorizationMode: 'confirmed_paths', targets: [{ relativePath: 'a', type: 'file' }] }),
    error => error.apiData.code === 'SFTP_FAST_DELETE_UPGRADE_REQUIRED');
  // Retired generic-chain gates remain for non-confirmed previews.
  host.fixture = { value: { safety: {} } };
  await assert.rejects(host.service.ports.sftp('files.cleanup.preview', { observationMode: 'managed_tmux' }),
    error => error.apiData.code === 'SFTP_MANAGED_OBSERVATION_REQUIRED');
  // The fast-delete gate is delete-scoped: a confirmed ISOLATE answer without fast flags keeps the isolate chain.
  host.fixture = { value: { safety: { managedObservation: 1, gitRepositoryAncestors: true, readOnlyReceiptCheck: true, isolateFast: 1 } } };
  assert.equal((await host.service.ports.sftp('files.cleanup.preview', { action: 'isolate', authorizationMode: 'confirmed_paths', targets: [{ relativePath: 'a', type: 'directory' }] })).safety.isolateFast, 1);
  // And its refusal codes stay isolate semantics instead of the unified fast-delete upgrade error.
  host.fixture = { throw: err('UNKNOWN_ACTION') };
  await assert.rejects(host.service.ports.sftp('files.cleanup.preview', { action: 'isolate', authorizationMode: 'confirmed_paths', targets: [] }),
    error => error.apiData.code === 'UNKNOWN_ACTION');
});

test('the tree confirmation page shows the isolation mapping and both stages demand the exact sentence', async () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '../../src/features/SyncScopeConfirmation.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const posted = []; let html = '', hostListener;
  const panel = { webview: { get html() { return html; }, set html(value) { html = value; }, postMessage: message => { posted.push(message); return Promise.resolve(true); },
    onDidReceiveMessage(listener) { hostListener = listener; return { dispose() {} }; } }, onDidDispose() {}, dispose() {} };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => name === 'vscode' ? { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } }
    : name.includes('PlanVersionComparison') ? require('../../src/results/PlanVersionComparison.ts') : require(name) });
  const note = `删除所选位置实际存在的 1 条路径。目录先以不覆盖改名方式唯一隔离，再整批删除；确认页逐条展示原路径与实际隔离路径的完整映射。同名新产物不会被删除；删除后暂停自动补回。${SENTENCE}。`;
  const promise = exports.confirmSyncScopePaths('批量永久删除', note,
    [{ label: 'work_dirs/job · 删除位置 w1', path: '/project/work_dirs/job', isolation: '/project/__iso_work_dirs_job' }], SENTENCE);
  assert.ok(html.includes('/project/work_dirs/job'));
  assert.ok(html.includes('隔离后实际删除：/project/__iso_work_dirs_job'));
  assert.ok(html.includes(note));
  assert.ok(html.includes(`data-final="${SENTENCE}"`));
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const elements = new Map([['stage', { textContent: '' }], ['cancel', {}], ['confirm', { textContent: '确认路径并继续', dataset: { final: SENTENCE } }]]);
  const viewers = [];
  vm.runInNewContext(script, { document: { getElementById: id => elements.get(id) }, window: { addEventListener: (_type, listener) => viewers.push(listener) },
    acquireVsCodeApi: () => ({ postMessage: message => hostListener(message) }) });
  elements.get('confirm').onclick();
  assert.deepEqual(posted.map(message => message.type), ['secondStage']);
  for (const listener of viewers) listener({ data: posted[0] });
  assert.equal(elements.get('confirm').textContent, SENTENCE, 'the second stage demands the exact sentence');
  elements.get('confirm').onclick();
  assert.equal(await promise, true);
  const cancelled = exports.confirmSyncScopePaths('批量永久删除', note, [{ label: 'x', path: '/project/x' }], SENTENCE);
  hostListener({ type: 'cancel' });
  assert.equal(await cancelled, false, 'cancel never confirms');
});

test('the plan review page renders isolation mappings and demands the exact sentence in both phases', async () => {
  const { bridge, deletePreview } = panelBridge();
  const f = bridge();
  await f.open();
  const review = f.element('review').innerHTML;
  assert.ok(review.includes('/project/work_dirs/job'));
  assert.ok(review.includes('隔离后实际删除：<span class="path">/project/__iso_work_dirs_job</span>'));
  assert.ok(review.includes('device=42 · inode=107'));
  assert.equal(f.element('confirm').textContent, '第一次确认：' + SENTENCE);
  f.deliver({ data: { type: 'preview', preview: deletePreview(1) } });
  assert.equal(f.element('confirm').textContent, '第二次确认：' + SENTENCE);
});

function panelBridge() {
  const fsSync = require('node:fs');
  const panelRequire = require('node:module').createRequire(require.resolve('../../dist/extension/PlanCleanupPanel'));
  const flush = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)); };
  const deletePreview = (confirmations = 0) => ({ token: 'b'.repeat(48), digest: 'digest', action: 'delete', confirmations, expiresAt: Date.now() + 6e5,
    scope: { planFile: 'experiments/plans/p.yaml', planHash: 'hash', authorizationMode: 'confirmed_paths' }, blockers: [],
    rows: [{ id: 'r1', node: { id: 'w1', root: '/project', host: 'h', user: 'u', port: 22 }, disposition: 'delete', category: '专用产物',
      absolutePath: '/project/work_dirs/job', destination: 'clean_dir/work_dirs/job', type: 'directory', device: 42, inode: 107,
      isolationName: isoName('work_dirs/job'), isolationAbsolutePath: '/project/' + isoName('work_dirs/job'), evidence: ['exact registered target'], dependencies: [], fingerprint: 'fp' },
      { id: 'r2', node: { id: 'w1', root: '/project', host: 'h', user: 'u', port: 22 }, disposition: 'delete', category: '专用产物',
        absolutePath: '/project/work_dirs/metrics.csv', destination: 'clean_dir/work_dirs/metrics.csv', type: 'file', device: 42, inode: 108, evidence: ['exact registered target'], dependencies: [] }] });
  function bridge() {
    const elements = new Map(), requests = [], viewers = [];
    let hostListener, html, booted = false;
    const element = id => { if (!elements.has(id)) elements.set(id, { value: id === 'action' ? 'move' : '', checked: false, disabled: false, textContent: '', innerHTML: '' }); return elements.get(id); };
    const boot = () => {
      if (booted) return; booted = true;
      const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
      vm.runInNewContext(script, { acquireVsCodeApi: () => ({ postMessage: message => { requests.push(clone(message)); if (hostListener) void hostListener(clone(message)); } }),
        document: { getElementById: element }, window: { addEventListener: (_type, listener) => viewers.push(listener) }, Date, setInterval: () => 0 });
    };
    const panel = { webview: { get html() { return html; }, set html(value) { html = value; boot(); },
      onDidReceiveMessage(listener) { hostListener = listener; return { dispose() {} }; },
      async postMessage(message) { for (const listener of viewers) listener({ data: clone(message) }); return true; } }, onDidDispose() {} };
    const exports = {};
    const compiled = ts.transpileModule(fsSync.readFileSync(path.join(__dirname, '../../src/extension/PlanCleanupPanel.ts'), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(compiled, { exports, require: name => name === 'vscode' ? { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } } : panelRequire(name) });
    const host = { service: { async list() { return []; }, async preview() { return deletePreview(); } } };
    return { async open() { await exports.openPlanCleanupPanel(host, 'C:/fixture', ''); await flush(); }, element, requests, deliver: message => viewers.forEach(listener => listener({ data: clone(message.data) })) };
  }
  return { bridge, deletePreview };
}

test('the batched chain binds preview, confirm, execute and status to one frozen local project root', async () => {
  const entries = [{ relativePath: 'work_dirs/job', directory: true }];
  const engine = makeEngine({ present: new Set(['work_dirs/job']), dirs: new Set(['work_dirs/job']), entries });
  const batches = await previewConfirmedScopeDeletion(engine.rpc, node, entries, CONSUMER);
  assert.equal(batches[0].consumerRoot, CONSUMER);
  const outcomes = await completeConfirmedScopeDeletion(engine.rpc, batches[0], () => {}, { wait: async () => {} });
  assert.deepEqual(outcomes.map(row => row.state), ['completed']);
  assert.ok(engine.calls.length >= 4, 'preview+confirm+execute+status all really went out');
  assert.ok(engine.calls.every(call => call.params.consumerRoot === CONSUMER),
    'every files.cleanup.* request carries the same consuming project root: ' + JSON.stringify(engine.calls.map(call => [call.method, call.params.consumerRoot])));
  for (const bad of ['', 'relative/project']) {
    await assert.rejects(previewConfirmedScopeDeletion(async () => { throw new Error('must not send a request'); }, node, entries, bad), /消费项目的绝对路径/);
  }
});
