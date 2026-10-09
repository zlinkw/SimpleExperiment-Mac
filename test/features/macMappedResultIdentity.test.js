const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const ts = require('typescript'), vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const paths = ['Results/A.csv', 'Results/a.csv', 'Results/ A.csv ', 'Results/A%20.csv', 'Results/é.csv', 'Results/e\u0301.csv'];
const names = ['mappedResultPath', 'mappedResultPathKey', 'uniqueMappedTransfers', 'assertRealChildFile',
  'streamCopyFile', 'openReusableMappedTemp', 'mappedResultTemporaryRelativePath', 'mappedResultPublicationResources',
  'distributeMappedDownloads', 'collapseMappedDownloadBatches', 'partitionMappedDownloadTransfers'];
function backend(platform = 'darwin', filesystem = fs.promises, extra = {}) {
  const source = fs.readFileSync(path.join(root, 'dist/extension/legacy.js'), 'utf8');
  const ast = ts.createSourceFile('actual.js', source, ts.ScriptTarget.Latest, true), funcs = new Map(), methods = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) funcs.set(node.name.text, node.getText(ast));
    if (ts.isMethodDeclaration(node)) methods.set(node.name.getText(ast), node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const readFile = path.join(root, 'dist/mac/ResultFiles.js'), readModule = { exports: {} }, readRequire = createRequire(readFile);
  vm.runInNewContext(fs.readFileSync(readFile, 'utf8'), { module: readModule, exports: readModule.exports, Buffer,
    require: name => name === 'node:fs/promises' ? filesystem : readRequire(name) });
  const wrapperFile = path.join(root, 'dist/results/WrapperResultBundle.js'), wrapperModule = { exports: {} }, wrapperRequire = createRequire(wrapperFile);
  vm.runInNewContext(fs.readFileSync(wrapperFile, 'utf8'), { module: wrapperModule, exports: wrapperModule.exports, Buffer, TextDecoder, process: { platform },
    require: name => name === '../mac/ResultFiles' ? readModule.exports : wrapperRequire(name) });
  const selected = ['collectMappedResultDownloadBatches', 'confirmMappedResultDownloads', 'downloadMappedResultBatch', 'downloadMetricMemoryBatch'];
  const context = vm.createContext({ Buffer, Map, Set, path, crypto, process: { platform }, fs: filesystem, fsNode: fs,
    PosixPath_1: require('../../dist/mac/PosixPath'), ResultCandidatePath_1: require('../../dist/mac/ResultCandidatePath'),
    MacResultFiles: readModule.exports, WrapperResultBundle: wrapperModule.exports, AbortController, AbortSignal, TextDecoder,
    safeWorkspaceChildPath: (base, relative) => path.join(base, ...relative.split('/')),
    methodResultArtifactLocalRelativePath: (remote, plan) => 'mapped/' + crypto.createHash('sha256').update(JSON.stringify([plan, remote])).digest('hex') + '.csv',
    isResultMetricFile: () => true, DEFAULT_RESULT_CSV_DIR: 'experiments/results',
    RESULT_ARTIFACT_MAX_BYTES: 128 * 1024 * 1024, MAPPED_RESULT_DOWNLOAD_MAX_ENTRIES: 1,
    MAPPED_RESULT_DOWNLOAD_MAX_BATCH_BYTES: 128 * 1024 * 1024,
    sha256File: async filename => crypto.createHash('sha256').update(await filesystem.readFile(filename)).digest('hex'),
    SafeRequestRetry_1: { retryRequestSignal: () => undefined }, errorMessage: error => error.message, UiCommandCancelled: class extends Error {},
    vscode: { ProgressLocation: { Notification: 1 }, window: { showInformationMessage() {}, showWarningMessage() {},
      withProgress: async (_options, action) => action({ report() {} }, { isCancellationRequested: false }) } }, ...extra,
  });
  vm.runInContext(names.map(name => { assert.ok(funcs.has(name), name); return funcs.get(name); }).join('\n') +
    '\nclass Provider {' + selected.map(name => { assert.ok(methods.has(name), name); return methods.get(name); }).join('\n') +
    '}\nthis.api = {' + names.join(',') + ', Provider};', context);
  return context.api;
}
const plain = value => JSON.parse(JSON.stringify(value));
function entry(remote, local = 'mapped/' + crypto.createHash('sha256').update(remote).digest('hex') + '.csv') {
  return { planFile: 'Plans/ Plan 中文 .yaml ', remotePath: remote, localRelative: local, localPath: '/root/' + local };
}
function batch(entries) { return { sourceId: 'Worker', workerId: 'Worker', entries,
  transfers: new Map(entries.map(value => [value.remotePath, { ...value, localRelativePath: value.localRelative }])) }; }

test('actual compiled Mac transfer and Plan batches keep all raw identities and merge only identical evidence', () => {
  const api = backend(), entries = paths.map((remote, i) => ({ ...entry(remote), bytes: i + 1, sha256: String(i).repeat(64) }));
  assert.deepEqual(plain(api.uniqueMappedTransfers(entries)).map(value => value.remotePath), paths);
  const subject = new api.Provider(); subject.enabledWorkerConfigs = () => [{ id: 'Worker' }];
  const collected = subject.collectMappedResultDownloadBatches({ root: '/root' }, [{ planFile: entries[0].planFile,
    summary: {}, candidates: entries.map(value => ({ ...value, workerId: 'Worker' })) }]);
  assert.equal(collected[0].transfers.size, paths.length); assert.equal(collected[0].entries.length, paths.length);
  const merged = api.collapseMappedDownloadBatches([batch(entries), batch(entries)]);
  assert.equal(merged[0].entries.length, paths.length); assert.equal(merged[0].transfers.size, paths.length);
  const duplicate = { ...entries[0], localRelative: 'other/copy.csv' };
  assert.equal(api.uniqueMappedTransfers([entries[0], duplicate]).length, 1);
  for (const change of [{ bytes: 999 }, { sha256: 'f'.repeat(64) }]) {
    assert.throws(() => api.uniqueMappedTransfers([entries[0], { ...duplicate, ...change }]), /不一致/);
    assert.throws(() => api.collapseMappedDownloadBatches([batch([entries[0]]), batch([{ ...duplicate, ...change }])]), /不一致/);
  }
});
test('bad typed paths fail before collection, deduplication, resource locking or physical access', async () => {
  let reads = 0;
  const api = backend('darwin', { realpath: async () => { reads++; return '/root'; } });
  const subject = new api.Provider(); subject.enabledWorkerConfigs = () => [{ id: 'Worker' }];
  const invalid = [null, 3, {}, [], '', '/a.csv', 'a\\b.csv', './a.csv', 'a//b.csv', 'a/../b.csv', 'a\0.csv', 'a:csv', '中'.repeat(1400)];
  for (const value of invalid) {
    assert.throws(() => api.uniqueMappedTransfers([{ ...entry('valid.csv'), remotePath: value }]), /相对路径/);
    assert.throws(() => api.uniqueMappedTransfers([{ ...entry('valid.csv'), localRelative: value }]), /相对路径/);
    assert.throws(() => api.mappedResultPublicationResources('/root', [{ ...entry('valid.csv'), remotePath: value }], [{ remotePath: value }]), /相对路径/);
    assert.throws(() => subject.collectMappedResultDownloadBatches({ root: '/root' }, [{ planFile: 'Plans/A.yaml', candidates: [{ remotePath: value }] }]), /相对路径/);
    assert.throws(() => subject.collectMappedResultDownloadBatches({ root: '/root' }, [{ planFile: value, candidates: [] }]), /相对路径/);
    await assert.rejects(() => api.assertRealChildFile('/root', value, 'optional'), /相对路径/);
  }
  assert.equal(reads, 0); // No physical access occurs for malformed paths.
});
test('tuple keys do not collapse separator-bearing Plan/source pairs; destination collisions still stop', () => {
  const api = backend(), local = 'mapped/shared.csv';
  const a = { ...entry('r.csv'), planFile: 'p|q.yaml' }, b = { ...a, planFile: 'p', remotePath: 'q.yaml|r.csv' };
  // Same tuple suffix/local: the legacy concatenated key collided. Distinct destinations below are deliberate.
  b.localRelative = a.localRelative;
  assert.throws(() => api.collapseMappedDownloadBatches([batch([a, b])]), /同一本地路径/);
  const one = { ...entry('a|b.csv', local), planFile: 'plans/A' }, two = { ...one, planFile: 'plans/A|a', remotePath: 'b.csv' };
  assert.throws(() => api.collapseMappedDownloadBatches([batch([one, two])]), /同一本地路径/);
  const distinctPlans = [one, { ...one, planFile: 'plans/A ' }];
  assert.equal(api.collapseMappedDownloadBatches([batch(distinctPlans)])[0].entries.length, 2);
  const conflict = { ...one, remotePath: 'other.csv' };
  assert.throws(() => api.collapseMappedDownloadBatches([batch([one]), { ...batch([conflict]), sourceId: 'other' }]), /同一本地路径/);
});
test('inventory evidence and one-file chunks bind only exact source; failures do not deliver a case neighbour', async () => {
  const api = backend(), subject = new api.Provider(), calls = [], publications = [], client = {};
  const entries = paths.map(remote => entry(remote));
  subject.client = client; subject.projectContextIsCurrent = () => true;
  subject.mappedDownloadServerForSource = () => ({ host: 'mock', remotePath: '/mock' });
  subject.simpleSftpApiCall = async (method, params) => {
    calls.push([method, plain(params)]);
    if (method === 'sync.projectInventory') return { files: Object.fromEntries(paths.map((remote, i) => [remote, { size: i + 10, sha256: String(i).repeat(64) }]).concat([
      ['Results\\A.csv', { size: 777, sha256: 'f'.repeat(64) }], ['RESULTS/A.CSV', { size: 888, sha256: 'e'.repeat(64) }]])) };
    if (method === 'sync.downloadMappedPaths') { if (params.entries[0].remotePath === paths[1]) throw Error('fixture failure'); return { fileCount: params.entries.length }; }
    throw Error('unexpected API');
  };
  subject.publishMappedResultDownloads = async (_context, _client, selected, transfers) => {
    publications.push([selected.map(value => value.remotePath), transfers.map(value => value.remotePath)]); return selected.length;
  };
  const report = await subject.downloadMappedResultBatch({ root: '/root' }, client, batch(entries), 'mock', { notify: false });
  const downloads = calls.filter(([method]) => method === 'sync.downloadMappedPaths').map(([,params]) => params.entries[0]);
  assert.deepEqual(downloads.map(value => value.remotePath), paths);
  assert.deepEqual(downloads.map(value => value.bytes), paths.map((_,i) => i + 10));
  assert.deepEqual(downloads.map(value => value.sha256), paths.map((_,i) => String(i).repeat(64)));
  assert.deepEqual(plain(report.deliveredEntries).map(value => value.remotePath), paths.filter(value => value !== paths[1]));
  assert.equal(report.failures.length, 1); assert.equal(report.completed, paths.length - 1);
  for (const [selected, transfers] of publications) assert.deepEqual(Array.from(selected), Array.from(transfers));
});
test('real compiled hash reuse only publishes its own raw source and sends the other case to the API', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-mac-mapped-cache-'));
  const api = backend(), subject = new api.Provider(), client = {}, hash = crypto.createHash('sha256').update('cached').digest('hex');
  fs.mkdirSync(path.join(workspace, 'mapped')); fs.writeFileSync(path.join(workspace, 'mapped', 'cached.csv'), 'cached', 'utf8');
  const upper = { ...entry(paths[0], 'mapped/cached.csv'), bytes: 6, sha256: hash, exists: true };
  const lower = { ...entry(paths[1], 'mapped/uncached.csv'), bytes: 6, sha256: hash };
  const publications = [], downloads = [];
  subject.client = client; subject.projectContextIsCurrent = () => true; subject.mappedDownloadServerForSource = () => ({});
  subject.publishMappedResultDownloads = async (_ctx, _client, selected) => { publications.push(Array.from(selected, value => value.remotePath)); return selected.length; };
  subject.simpleSftpApiCall = async (method, params) => { assert.equal(method, 'sync.downloadMappedPaths'); downloads.push(...params.entries); return { fileCount: params.entries.length }; };
  const report = await subject.downloadMappedResultBatch({ root: workspace }, client, batch([upper, lower]), 'mock', { notify: false });
  assert.deepEqual(publications, [[paths[0]], [paths[1]]]); assert.deepEqual(downloads.map(value => value.remotePath), [paths[1]]);
  assert.equal(report.completed, 2);
});
test('real local publication writes each exact source content and distinct staging/lease identities', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-mac-mapped-publish-')), api = backend();
  fs.mkdirSync(path.join(workspace, 'stage')); fs.writeFileSync(path.join(workspace, 'stage', 'one.csv'), 'UPPER', 'utf8');
  fs.writeFileSync(path.join(workspace, 'stage', 'two.csv'), 'lower', 'utf8');
  const entries = [entry(paths[0], 'out/one.csv'), entry(paths[1], 'out/two.csv')];
  const transfers = [{ remotePath: paths[0], localRelativePath: 'stage/one.csv' }, { remotePath: paths[1], localRelativePath: 'stage/two.csv' }];
  assert.equal(await api.distributeMappedDownloads(workspace, entries, transfers, true), 2);
  assert.equal(fs.readFileSync(path.join(workspace, 'out', 'one.csv'), 'utf8'), 'UPPER');
  assert.equal(fs.readFileSync(path.join(workspace, 'out', 'two.csv'), 'utf8'), 'lower');
  assert.notEqual(api.mappedResultTemporaryRelativePath('out/A.csv'), api.mappedResultTemporaryRelativePath('out/a.csv'));
  const resources = plain(api.mappedResultPublicationResources(workspace, entries, [transfers[0]]));
  assert.equal(resources.length, 3); assert.ok(resources.every(value => !value.target.endsWith('two.csv')));
});
test('simulated insensitive Mac disks reject case/Unicode aliases before reuse or missing-only skip', async () => {
  const stored = ['/root', '/root/Results', '/root/Results/é.csv'];
  const alias = value => value.normalize('NFD').toLowerCase();
  const filesystem = {
    realpath: async value => stored.find(item => alias(item) === alias(value)) || value,
    lstat: async value => { const actual = stored.find(item => alias(item) === alias(value)); if (!actual) throw Object.assign(Error('missing'), { code: 'ENOENT' });
      return { isSymbolicLink: () => false, isFile: () => actual.endsWith('.csv'), isDirectory: () => !actual.endsWith('.csv') }; },
    readdir: async value => stored.filter(item => path.posix.dirname(item) === value && item !== value).map(item => path.posix.basename(item)),
  };
  const api = backend('darwin', filesystem, { path: path.posix });
  assert.equal((await api.assertRealChildFile('/root', 'Results/é.csv', 'file')).exists, true);
  for (const relative of ['results/é.csv', 'Results/É.csv', 'Results/e\u0301.csv']) {
    await assert.rejects(() => api.assertRealChildFile('/root', relative, 'optional'), /拼写/);
    const subject = new api.Provider(), client = {}; subject.client = client; subject.projectContextIsCurrent = () => true;
    await assert.rejects(() => subject.confirmMappedResultDownloads({ root: '/root' }, client, [batch([entry('source.csv', relative)])], 'mock', { missingOnly: true }), /拼写/);
  }
  const windows = backend('win32');
  assert.equal(windows.uniqueMappedTransfers([entry(paths[0]), entry(paths[1])]).length, 1);
  assert.equal(windows.mappedResultTemporaryRelativePath('out/A.csv'), windows.mappedResultTemporaryRelativePath('out/a.csv'));
});

test('real compiled staging open rejects swapped inode or hard link without truncating the retained file', async () => {
  for (const fault of ['inode', 'hardlink']) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-mac-mapped-open-'));
    fs.mkdirSync(path.join(workspace, 'out')); const relative = 'out/stage.tmp', full = path.join(workspace, relative);
    fs.writeFileSync(full, 'retained original', 'utf8'); let flags, closed = false;
    const filesystem = { ...fs.promises, open: async (...args) => {
      flags = args[1]; const handle = await fs.promises.open(...args), stat = await handle.stat(), close = handle.close.bind(handle);
      handle.stat = async () => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
        fault === 'inode' ? { ino: stat.ino + 100 } : { nlink: 2 });
      handle.close = async () => { closed = true; await close(); }; return handle;
    } };
    const api = backend('darwin', filesystem);
    await assert.rejects(() => api.openReusableMappedTemp(workspace, relative), /身份/);
    assert.equal(flags & fs.constants.O_TRUNC, 0); assert.equal(flags & fs.constants.O_CREAT, 0);
    assert.equal(fs.readFileSync(full, 'utf8'), 'retained original'); assert.equal(closed, true);
  }
});

test('compiled physical source changes, missing descriptors and wrong hashes retain the old final file', async () => {
  for (const fault of ['ctime', 'missing', 'sha']) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-mac-mapped-copy-'));
    fs.mkdirSync(path.join(workspace, 'stage')); fs.mkdirSync(path.join(workspace, 'out'));
    const source = path.join(workspace, 'stage', 'source.csv'), destination = path.join(workspace, 'out', 'final.csv');
    fs.writeFileSync(source, 'downloaded', 'utf8'); fs.writeFileSync(destination, 'previous final', 'utf8');
    let sourceStats = 0, sourceClosed = false, tempClosed = false;
    const filesystem = { ...fs.promises, lstat: async (...args) => {
      if (args[0] === source && ++sourceStats > 1 && fault === 'missing') throw Object.assign(Error('missing'), { code: 'ENOENT' });
      return fs.promises.lstat(...args);
    }, open: async (...args) => {
      const handle = await fs.promises.open(...args), stat = handle.stat.bind(handle), close = handle.close.bind(handle); let stats = 0;
      if (args[0] === source) handle.stat = async () => { const info = await stat(); if (++stats > 1 && fault === 'ctime') info.ctimeMs++; return info; };
      handle.close = async () => { if (args[0] === source) sourceClosed = true; if (String(args[0]).endsWith('.tmp')) tempClosed = true; await close(); };
      return handle;
    } };
    const api = backend('darwin', filesystem);
    await assert.rejects(() => api.distributeMappedDownloads(workspace, [entry('Remote/A.csv', 'out/final.csv')],
      [{ remotePath: 'Remote/A.csv', localRelativePath: 'stage/source.csv', ...(fault === 'sha' ? { sha256: 'f'.repeat(64) } : {}) }], true), /分发写入失败/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'previous final'); assert.equal(tempClosed, true);
    if (fault !== 'missing') assert.equal(sourceClosed, true);
  }
});

test('actual compiled wrapper disk fallback verifies its physical original and rejects an insensitive alias before API transfer', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-mac-wrapper-disk-')), api = backend(), subject = new api.Provider(), client = {};
  const localRelative = 'Results/指标 A.yaml', remotePath = 'Remote/指标 A.yaml', bytes = Buffer.from('result: 1\n');
  const record = { ...entry(remotePath, localRelative), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  subject.client = client; subject.projectContextIsCurrent = () => true; subject.mappedDownloadServerForSource = () => ({});
  subject.simpleSftpCapability = async () => ({ methodOptions: { 'sync.downloadMappedPaths': { memoryOnly: true } } });
  let downloads = 0;
  subject.simpleSftpApiCall = async (method, params) => {
    assert.equal(method, 'sync.downloadMappedPaths'); assert.equal(params.memoryOnly, false); downloads++;
    fs.mkdirSync(path.join(workspace, 'Results'), { recursive: true }); fs.writeFileSync(path.join(workspace, localRelative), bytes);
    return { fileCount: 1 };
  };
  const report = await subject.downloadMetricMemoryBatch({ root: workspace }, client, batch([record]), 'mock', { isCancellationRequested: false }, { report() {} });
  assert.equal(report.metricFiles[0].text, bytes.toString()); assert.equal(report.metricFiles[0].remotePath, remotePath); assert.equal(downloads, 1);
  const bad = { ...record, localRelative: 'results/指标 A.yaml' };
  await assert.rejects(() => subject.downloadMetricMemoryBatch({ root: workspace }, client, batch([bad]), 'mock', { isCancellationRequested: false }, { report() {} }), /拼写/);
  assert.equal(downloads, 1);
});

test('checked local streaming copy completes partial writes and rejects zero progress without replacing the final file', async () => {
  for (const zero of [false, true]) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-mac-mapped-short-'));
    fs.mkdirSync(path.join(workspace, 'stage')); fs.mkdirSync(path.join(workspace, 'out'));
    const bytes = Buffer.from('完整中文 streaming result'), source = path.join(workspace, 'stage', 'source.csv'), destination = path.join(workspace, 'out', 'final.csv');
    fs.writeFileSync(source, bytes); fs.writeFileSync(destination, 'old final', 'utf8'); let writes = 0;
    const filesystem = { ...fs.promises, open: async (...args) => {
      const handle = await fs.promises.open(...args), write = handle.write.bind(handle);
      if (String(args[0]).endsWith('.tmp')) handle.write = async (buffer, offset, length, position) => {
        writes++; return zero ? { bytesWritten: 0 } : write(buffer, offset, Math.min(length, 2), position);
      };
      return handle;
    } };
    const api = backend('darwin', filesystem), entries = [entry('Remote/source.csv', 'out/final.csv')],
      transfers = [{ remotePath: 'Remote/source.csv', localRelativePath: 'stage/source.csv', sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
    if (zero) { await assert.rejects(() => api.distributeMappedDownloads(workspace, entries, transfers, true), /没有进展/); assert.equal(fs.readFileSync(destination, 'utf8'), 'old final'); }
    else { assert.equal(await api.distributeMappedDownloads(workspace, entries, transfers, true), 1); assert.deepEqual(fs.readFileSync(destination), bytes); assert.ok(writes > 1); }
  }
});
