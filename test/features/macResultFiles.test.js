const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const vm = require('node:vm'), { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..'), sha = value => crypto.createHash('sha256').update(value).digest('hex');
function compiled(file, overrides = {}, platform = 'darwin') {
  const full = path.join(root, file), module = { exports: {} }, requireLocal = createRequire(full);
  vm.runInNewContext(fs.readFileSync(full, 'utf8'), { module, exports: module.exports, Buffer, TextDecoder, process: { platform },
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : requireLocal(name) }, { filename: full });
  return module.exports;
}
function fixture() {
  const folder = '/root/ Results 中文 ', relative = ' Results 中文 /é.csv', file = folder + '/é.csv', bytes = Buffer.from('result');
  const nodes = new Map([['/root', { ino: 1, directory: true }], [folder, { ino: 2, directory: true }],
    [file, { ino: 3, bytes, mtimeMs: 1, ctimeMs: 1 }]]);
  const state = { opens: 0, reads: 0, closes: 0, nodes, folder, file, relative, bytes };
  const key = value => value.normalize('NFD').toLowerCase(), find = value => [...nodes].find(([name]) => key(name) === key(value));
  const stat = node => ({ dev: 1, ino: node.ino, size: node.bytes?.length || 0, mtimeMs: node.mtimeMs || 1, ctimeMs: node.ctimeMs || 1,
    isSymbolicLink: () => node.symlink === true, isDirectory: () => node.directory === true, isFile: () => !node.directory && !node.symlink && !node.special });
  const filesystem = {
    lstat: async value => { const found = find(value); if (!found) throw Object.assign(Error('absent'), { code: 'ENOENT' }); return stat(found[1]); },
    realpath: async value => find(value)?.[0] || value,
    readdir: async value => [...nodes.keys()].filter(name => path.posix.dirname(name) === value && name !== value).map(name => path.posix.basename(name)),
    open: async (value, flags) => {
      state.opens++; state.flags = flags; const before = find(value)[1]; state.beforeOpen?.(); const opened = state.opened || find(value)[1];
      return { stat: async () => stat(opened), read: async (buffer, offset, length, position) => {
        state.reads++; state.onRead?.(opened); const bytesRead = opened.bytes.copy(buffer, offset, position, position + length); return { bytesRead };
      }, close: async () => { state.closes++; }, before };
    },
  };
  const api = compiled('dist/mac/ResultFiles.js', { 'node:fs/promises': filesystem, 'node:path': path.posix });
  const wrapper = compiled('dist/results/WrapperResultBundle.js', { '../mac/ResultFiles': api });
  const entry = { remotePath: 'Remote/ 指标.csv', localRelativePath: relative, bytes: bytes.length, sha256: sha(bytes) };
  return { state, api, wrapper, entry };
}

test('actual compiled Mac byte/hash reads and wrapper reuse keep raw names with bounded descriptors', async () => {
  const { state, api, wrapper, entry } = fixture();
  assert.equal((await api.readMacResultBytes('/root', state.relative, 16)).toString(), 'result');
  assert.equal(await api.hashMacResultFile('/root', state.relative, 16), sha(state.bytes));
  const reused = await wrapper.readVerifiedLocalResult('/root', entry);
  assert.equal(reused.text, 'result'); assert.equal(reused.remotePath, entry.remotePath); assert.equal(reused.reused, true);
  assert.equal(state.opens, 3); assert.equal(state.closes, 3); assert.equal(state.flags & fs.constants.O_WRONLY, 0);
  assert.equal(await wrapper.readVerifiedLocalResult('/root', { ...entry, sha256: 'a'.repeat(64) }), undefined);
  assert.equal(await wrapper.readVerifiedLocalResult('/root', { ...entry, bytes: 5 }), undefined);
});
test('actual compiled snapshot returns descriptor mtime together with checked exact bytes', async () => {
  const { state, api } = fixture();
  state.nodes.get(state.file).mtimeMs = 1234;
  const snapshot = await api.readMacResultSnapshot('/root', state.relative, 16);
  assert.equal(snapshot.bytes.toString(), 'result'); assert.equal(snapshot.mtimeMs, 1234);
  assert.equal(state.opens, 1); assert.equal(state.closes, 1);
  state.onRead = opened => { opened.mtimeMs++; };
  await assert.rejects(() => api.readMacResultSnapshot('/root', state.relative, 16), /读取期间变化/);
  assert.equal(state.closes, 2);
});
test('case, Unicode and repaired aliases cannot be read or returned as a verified wrapper source', async () => {
  const { state, api, wrapper, entry } = fixture();
  for (const relative of [state.relative.toLowerCase(), state.relative.replace('é', 'e\u0301'), state.relative.replace('é', 'É')]) {
    await assert.rejects(() => api.readMacResultBytes('/root', relative, 16), /拼写/);
    await assert.rejects(() => wrapper.readVerifiedLocalResult('/root', { ...entry, localRelativePath: relative }), /拼写/);
  }
  for (const relative of [null, 3, {}, '', '/file.csv', './file.csv', 'a//b.csv', 'a/../b.csv', 'a\\b.csv', 'a\0.csv', 'a:csv', 'a\u007f.csv', '中'.repeat(1400)])
    await assert.rejects(() => api.readMacResultBytes('/root', relative, 16), /相对路径/);
  await assert.rejects(() => wrapper.readVerifiedLocalResult('/root', { ...entry, remotePath: 'Remote\\指标.csv' }), /相对路径/);
  assert.equal(state.opens, 0);
});
test('missing files, symlinks, special files and oversized originals do not reach read callbacks', async () => {
  for (const fault of ['missing', 'symlink', 'special', 'oversize']) {
    const { state, api } = fixture();
    if (fault === 'missing') state.nodes.delete(state.file);
    else if (fault === 'oversize') state.nodes.get(state.file).bytes = Buffer.alloc(17);
    else state.nodes.get(state.file)[fault] = true;
    if (fault === 'missing') assert.equal(await api.readMacResultBytes('/root', state.relative, 16), undefined);
    else await assert.rejects(() => api.readMacResultBytes('/root', state.relative, 16), /符号链接|文件类型|上限/);
    assert.equal(state.opens, 0); assert.equal(state.reads, 0);
  }
});
test('replacement between check and open cannot borrow identical contents or metadata from a new inode', async () => {
  const { state, wrapper, entry } = fixture();
  state.beforeOpen = () => state.nodes.set(state.file, { ...state.nodes.get(state.file), ino: 99 });
  await assert.rejects(() => wrapper.readVerifiedLocalResult('/root', entry), /打开时变化/);
  assert.equal(state.reads, 0); assert.equal(state.closes, 1);
});
test('directory/root/file replacement or content changes during read never authorize the result', async () => {
  for (const fault of ['root', 'parent', 'file', 'content']) {
    const { state, wrapper, entry } = fixture(); let changed = false;
    state.onRead = opened => {
      if (changed) return; changed = true;
      if (fault === 'content') opened.ctimeMs++;
      else { const full = fault === 'root' ? '/root' : fault === 'parent' ? state.folder : state.file;
        state.nodes.set(full, { ...state.nodes.get(full), ino: 99 }); }
    };
    await assert.rejects(() => wrapper.readVerifiedLocalResult('/root', entry), /读取期间变化/);
    assert.equal(state.closes, 1);
  }
});
test('growth is bounded, and failures in callbacks close the checked descriptor', async () => {
  for (const kind of ['bytes', 'hash', 'callback']) {
    const { state, api } = fixture();
    state.onRead = opened => { opened.bytes = Buffer.alloc(17, 'x'); };
    if (kind === 'bytes') await assert.rejects(() => api.readMacResultBytes('/root', state.relative, 16), /超出预算/);
    if (kind === 'hash') await assert.rejects(() => api.hashMacResultFile('/root', state.relative, 16), /核验上限/);
    if (kind === 'callback') await assert.rejects(() => api.withMacResultFile('/root', state.relative, 16, async () => { throw Error('callback failure'); }), /callback failure/);
    assert.equal(state.closes, 1); assert.ok(state.reads <= 1);
  }
});
test('real local compiled read preserves Chinese/space paths and supports empty and binary originals', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-mac-result-read-'));
  const api = require('../../dist/mac/ResultFiles'); fs.mkdirSync(path.join(workspace, '目录 A'));
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 10]), Buffer.from('中文结果')]) {
    fs.writeFileSync(path.join(workspace, '目录 A', '指标.csv'), bytes);
    assert.deepEqual(await api.readMacResultBytes(workspace, '目录 A/指标.csv', 32), bytes);
    assert.equal(await api.hashMacResultFile(workspace, '目录 A/指标.csv', 32), sha(bytes));
  }
});
