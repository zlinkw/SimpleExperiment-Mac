const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const test = require('node:test');

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/extension/legacy.ts'), 'utf8');
function method(name, next) {
  const start = source.indexOf('\n    ' + (name.startsWith('tmux') || name.startsWith('isTmux') ? '' : 'async ') + name + '(');
  const end = source.indexOf('\n    async ' + next + '(', start + 1);
  assert.ok(start >= 0 && end > start, name);
  return ts.transpileModule('class Host {' + source.slice(start, end) + '}', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function hostContext(windows, response) {
  const calls = [];
  const context = { calls, windows, errorMessage: e => String(e.message || e), console };
  const moduleFile = path.join(root, 'src/features/TmuxWindowIdentity.ts');
  if (fs.existsSync(moduleFile)) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(moduleFile, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
    context.TmuxWindowIdentity = exports;
  }
  vm.createContext(context);
  vm.runInContext(method('performKillTmuxWindow', 'openTensorBoardUrlFromUi') + '; this.perform = Host.prototype.performKillTmuxWindow;', context);
  context.tmuxKillSessionFromTarget = target => target.split(':')[0];
  context.tmuxListStillHasTarget = (list, target) => list.sessions.some(s => s.windows.some(w => w.target === target));
  context.isTmuxKillTransportFailure = e => /timeout|ECONNRESET/.test(e.message);
  context.readTmuxListAfterKill = async () => ({ ok: true, workerId: 'nwpu2', sessions: [{ name: 'zlk-gpu-0', windows: context.windows }] });
  context.requestKillTmuxWindow = async (_worker, body) => { calls.push(body); return response(context, body); };
  return context;
}
const old = { index: '1', target: 'zlk-gpu-0:1', windowId: '@41', name: 'run-old', panes: [{ id: '%184' }] };
const sibling = { index: '2', target: 'zlk-gpu-0:2', windowId: '@42', name: 'run-running', panes: [{ id: '%185' }] };

test('renumbering after a confirmed close verifies the original window, not its reused index', async () => {
  const c = hostContext([old, sibling], async context => {
    context.windows = [{ ...sibling, index: '1', target: 'zlk-gpu-0:1' }];
    return { ok: true, verified: true, windowId: '@41' };
  });
  await c.perform.call(c, 'nwpu2', old.target);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].windowId, '@41');
  assert.equal(c.windows[0].windowId, '@42');
});

test('lost close reply is reconciled from a fresh list without repeating a mutating request', async () => {
  const c = hostContext([old, sibling], async context => {
    context.windows = [{ ...sibling, index: '1', target: 'zlk-gpu-0:1' }];
    throw new Error('ECONNRESET');
  });
  await c.perform.call(c, 'nwpu2', old.target);
  assert.equal(c.calls.length, 1);
  assert.equal(c.windows[0].windowId, '@42');
});

test('stale identity cannot close a new occupant or report an unchanged window as closed', async () => {
  const c = hostContext([sibling], async () => ({ ok: true, verified: true }));
  await assert.rejects(() => c.perform.call(c, 'nwpu2', old.target, old), /已变化|不存在|身份/);
  assert.equal(c.calls.length, 0);
  c.windows = [old];
  await assert.rejects(() => c.perform.call(c, 'nwpu2', old.target), /仍在/);
});

test('an unverified receipt never reports a still-existing original window as closed', async () => {
  const c = hostContext([old], async () => ({ ok: true, scheduled: true }));
  await assert.rejects(() => c.perform.call(c, 'nwpu2', old.target), /未确认|未验证/);
});

test('HTTP close transport never replays an uncertain mutation through a second transport', async () => {
  const context = {
    calls: 0, fallbacks: 0, errorMessage: e => e.message,
    isTmuxKillTransportFailure: e => /ECONNRESET/.test(e.message),
    client: { clients: new Map([['nwpu2', { requestJson: async () => { context.calls++; throw new Error('ECONNRESET'); } }]]) },
    tmuxEndpoint() { this.fallbacks++; throw new Error('second mutation forbidden'); },
  };
  vm.createContext(context);
  vm.runInContext(method('requestKillTmuxWindow', 'performKillTmuxWindow') + '; this.request = Host.prototype.requestKillTmuxWindow;', context);
  await assert.rejects(() => context.request.call(context, 'nwpu2', { target: old.target }), /ECONNRESET/);
  assert.equal(context.calls, 1);
  assert.equal(context.fallbacks, 0);
});

test('incomplete verification and legacy Agent identity cannot masquerade as a closed window', async () => {
  const c = hostContext([old], async () => { throw new Error('timeout'); });
  let reads = 0;
  c.readTmuxListAfterKill = async () => ++reads === 1
    ? { ok: true, sessions: [{ name: 'zlk-gpu-0', windows: [old] }] }
    : { ok: false, sessions: [], error: 'list-windows failed' };
  await assert.rejects(() => c.perform.call(c, 'nwpu2', old.target), /list-windows failed/);
  assert.equal(c.calls.length, 1);
  const legacy = hostContext([{ ...old, windowId: undefined }], async () => ({ ok: true }));
  await assert.rejects(() => legacy.perform.call(legacy, 'nwpu2', old.target), /更新 Worker Agent/);
  assert.equal(legacy.calls.length, 0);
});

test('each close verification bypasses an older coalesced tmux list request', async () => {
  const paths = [];
  const context = { crypto: require('node:crypto'), publishTmuxList: (_worker, result) => result,
    client: { clients: new Map([['nwpu2', { requestJson: async apiPath => { paths.push(apiPath); return { ok: true, sessions: [] }; } }]]) },
  };
  vm.createContext(context);
  vm.runInContext(method('readTmuxListAfterKill', 'fetchOneTmuxListFromUi') + '; this.read = Host.prototype.readTmuxListAfterKill;', context);
  await context.read.call(context, 'nwpu2');
  await context.read.call(context, 'nwpu2');
  assert.equal(paths.every(p => p.startsWith('/api/tmux/list?closeCheck=')), true);
  assert.notEqual(paths[0], paths[1]);
});
