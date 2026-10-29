const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { LocalApiServer } = require('../../dist/api/LocalApiServer');
test('independent writers never mutate another writer published inode', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-writer-isolation-'));
  const target = path.join(root, 'state.json');
  const source = fs.readFileSync(require.resolve('../../dist/state/StateStore'), 'utf8');
  let reach, release;
  const reached = new Promise(resolve => { reach = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  function writer(pause) {
    const m = { exports: {} };
    const api = { ...fsp, async open(...args) {
      const h = await fsp.open(...args);
      if (!pause || !String(args[0]).endsWith('.writing')) return h;
      return new Proxy(h, { get(o, k) {
        if (k === 'write') return async (...a) => { reach(); await blocked; return h.write(...a); };
        return typeof o[k] === 'function' ? o[k].bind(o) : o[k];
      } });
    } };
    vm.runInNewContext(source, { module: m, exports: m.exports, process, Buffer, setTimeout,
      require: name => name === 'fs/promises' ? api : require(name) });
    return m.exports;
  }
  const first = writer(true).atomicWriteText(target, '{"a":1}');
  await reached;
  try {
    await writer(false).atomicWriteText(target, '{"second":"longer-value"}');
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { second: 'longer-value' });
  } finally { release(); }
  await first;
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { a: 1 });
});
test('closing an older API instance preserves the current default discovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-writer-isolation-'));
  const discoveryPath = path.join(root, 'api.json');
  const a = new LocalApiServer({ name: 'SimpleExperiment', version: '1.0.0', discoveryPath, workspace: 'a' });
  const b = new LocalApiServer({ name: 'SimpleExperiment', version: '1.0.0', discoveryPath, workspace: 'b' });
  a.startedAt = '2026-10-28T00:00:01Z'; b.startedAt = '2026-10-28T00:00:02Z';
  await a.writeDiscovery(); await b.writeDiscovery();
  const before = fs.readFileSync(discoveryPath, 'utf8');
  await a.dispose();
  assert.equal(fs.readFileSync(discoveryPath, 'utf8'), before);
  assert.equal(JSON.parse(fs.readFileSync(a.instanceRecordPath(), 'utf8')).status, 'stopped');
  await b.dispose();
  assert.equal(JSON.parse(fs.readFileSync(discoveryPath, 'utf8')).status, 'stopped');
});
