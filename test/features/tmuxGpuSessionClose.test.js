const test = require('node:test');
const assert = require('node:assert/strict');
const { closeGpuTmuxSession, gpuTmuxSessionBatch } = require('../../dist/extension/GpuTmuxClose');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  let prefix = 'my-user';
  const session = prefix + '-gpu-0', workerId = 'w3', calls = [], descriptions = [];
  let windows = [
    { index: '0', name: 'bash', windowId: '@10', panes: [{ id: '%10', command: 'bash' }] },
    { index: '1', name: 'run-123', windowId: '@11', panes: [{ id: '%11', command: 'python' }], task: { commandId: 'job-a', status: 'running' } },
  ];
  const identities = windows.map(win => ({ target: session + ':' + win.index, session, windowId: win.windowId,
    windowName: win.name, paneIds: win.panes.map(pane => pane.id), taskCommandId: win.task?.commandId || '', taskStatus: win.task?.status || '',
    paneCommands: win.panes.map(({ id, command }) => ({ id, command })) }));
  const list = () => ({ ok: true, workerId, sessions: [...(windows.length ? [{ name: session, windows: clone(windows) }] : []),
    { name: 'another-gpu-0', windows: [{ index: '0', windowId: '@99', name: 'bash', panes: [{ id: '%99', command: 'bash' }] }] }] });
  const ports = { prefix: () => prefix, read: async () => list(), confirm: async text => { descriptions.push(text); },
    close: async identity => { calls.push(clone(identity)); windows = windows.filter(win => win.windowId !== identity.windowId); },
    progress: async work => work(() => {}) };
  return { ports, list, calls, descriptions, request: { workerId, gpuSession: session, identities },
    changePrefix: value => { prefix = value; }, windows: () => windows };
}

test('GPU card closes only the confirmed namespace and stable windows, including the final idle shell', async () => {
  const f = fixture(), result = await closeGpuTmuxSession(f.ports, f.request);
  assert.match(result, /已核实关闭.*my-user-gpu-0.*2 个窗口/);
  assert.equal(f.descriptions.length, 1);
  assert.match(f.descriptions[0], /my-user-gpu-0:0.*@10/);
  assert.match(f.descriptions[0], /my-user-gpu-0:1.*@11/);
  assert.deepEqual(f.calls.map(row => row.windowId), ['@10', '@11']);
  assert.equal(f.list().sessions[0].name, 'another-gpu-0');
});

test('foreign namespace, incomplete identities, wrong Worker and newly added GPU windows fail before confirmation', async () => {
  for (const mutate of [
    f => { f.request.gpuSession = 'another-gpu-0'; },
    f => { f.request.identities[0].windowId = ''; },
    f => { f.request.workerId = 'other-worker'; },
    f => { f.windows().push({ index: '2', windowId: '@12', name: 'new', panes: [] }); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(closeGpuTmuxSession(f.ports, f.request), /前缀|窗口|Worker/);
    assert.equal(f.calls.length, 0); assert.equal(f.descriptions.length, 0);
  }
});

test('cancel and prefix changes during confirmation authorize no kill', async () => {
  const f = fixture(); f.ports.confirm = async () => { throw new Error('已取消'); };
  await assert.rejects(closeGpuTmuxSession(f.ports, f.request), /已取消/); assert.equal(f.calls.length, 0);
  const changed = fixture(); changed.ports.confirm = async () => changed.changePrefix('other-user');
  await assert.rejects(closeGpuTmuxSession(changed.ports, changed.request), /前缀已变化/); assert.equal(changed.calls.length, 0);
});

test('replaced windows, new tasks and new pane processes invalidate a confirmed batch before the first kill', async () => {
  for (const mutate of [
    f => { f.windows()[0].windowId = '@replacement'; },
    f => { f.windows()[0].task = { commandId: 'new-job', status: 'running' }; },
    f => { f.windows()[0].panes[0].command = 'python'; },
  ]) {
    const f = fixture(); f.ports.confirm = async () => mutate(f);
    await assert.rejects(closeGpuTmuxSession(f.ports, f.request), /窗口.*变化|稳定身份/);
    assert.equal(f.calls.length, 0);
  }
});

test('mid-batch failures and new windows stop at the boundary without claiming completion', async () => {
  const f = fixture(), close = f.ports.close;
  f.ports.close = async identity => { await close(identity); f.windows().push({ index: '2', windowId: '@12', name: 'new', panes: [] }); };
  await assert.rejects(closeGpuTmuxSession(f.ports, f.request), /已关闭 1\/2.*集合已变化/);
  assert.deepEqual(f.calls.map(row => row.windowId), ['@10']);
  const failed = fixture(); failed.ports.close = async () => { throw new Error('断线'); };
  await assert.rejects(closeGpuTmuxSession(failed.ports, failed.request), /已关闭 0\/2.*断线/);
  assert.equal(failed.calls.length, 0);
});

test('GPU batch follows stable IDs after sibling indices are renumbered', async () => {
  const f = fixture(), close = f.ports.close;
  f.ports.close = async identity => {
    await close(identity);
    f.windows().forEach((win, index) => { win.index = String(index); });
  };
  assert.match(await closeGpuTmuxSession(f.ports, f.request), /2 个窗口/);
  assert.deepEqual(f.calls.map(row => row.windowId), ['@10', '@11']);
  assert.deepEqual(f.calls.map(row => row.target), ['my-user-gpu-0:0', 'my-user-gpu-0:0']);
});

test('every read failure, ambiguous session and protected Agent window rejects the batch', () => {
  const f = fixture(), list = f.list();
  assert.throws(() => gpuTmuxSessionBatch({ ...list, ok: false }, 'w3', f.request.gpuSession, 'my-user', f.request.identities), /无法核实/);
  assert.throws(() => gpuTmuxSessionBatch({ ...list, sessions: [...list.sessions, list.sessions[0]] }, 'w3', f.request.gpuSession, 'my-user', f.request.identities), /不唯一/);
  list.sessions[0].windows[0].name = 'agent';
  assert.throws(() => gpuTmuxSessionBatch(list, 'w3', f.request.gpuSession, 'my-user', f.request.identities), /受保护/);
});

test('panel host routes GPU card requests through exact confirmation, progress and the existing window executor', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../../src/extension/legacy.ts'), 'utf8');
  const start = source.indexOf('    async killTmuxWindowFromUi('), end = source.indexOf('    tmuxKillSessionFromTarget(', start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule('class Host { ' + source.slice(start, end) + ' } this.Host = Host;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const f = fixture(), progress = [], refreshed = [], descriptions = [];
  const context = vm.createContext({ closeGpuTmuxSession, AgentTmuxPolicy_1: require('../../dist/tunnel/AgentTmuxPolicy'),
    UiCommandCancelled: Error, vscode: { workspace: { getConfiguration: () => ({ get: () => 'my-user' }) },
      ProgressLocation: { Notification: 1 }, window: {
        showWarningMessage: async (text, options, answer) => { descriptions.push(text); assert.equal(options.modal, true); return answer; },
        withProgress: async (_options, work) => work({ report: update => progress.push(update.message) }),
      } } });
  vm.runInContext(code, context);
  const host = new context.Host();
  host.tmuxWorkerId = () => f.request.workerId;
  host.readTmuxListAfterKill = f.ports.read;
  host.performKillTmuxWindow = async (worker, target, identity) => { assert.equal(worker, f.request.workerId);
    assert.equal(target, identity.target); await f.ports.close(identity); };
  host.fetchOneTmuxListFromUi = async worker => refreshed.push(worker);
  assert.match(await host.killTmuxWindowFromUi(f.request), /2 个窗口/);
  assert.equal(descriptions.length, 1); assert.match(descriptions[0], /my-user-gpu-0:0.*@10/);
  assert.equal(progress.length, 2); assert.equal(host.tmuxClearTaskTabsInFlight, false);
  assert.deepEqual(refreshed, ['w3']);
});
