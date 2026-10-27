const test = require('node:test');
const assert = require('node:assert/strict');
const { ReleaseClient, RateLimitedError } = require('../../dist/updates/ReleaseClient');
const { registerUpdater, getUpdateStatus, CHECK_COMMAND } = require('../../dist/updates/Bootstrap');
const { SFTP_EXTENSION_ID, EXPERIMENT_EXTENSION_ID, SFTP_UPDATE_REPO, EXPERIMENT_UPDATE_REPO } = require('../../dist/features/ExtensionUpdates');

// Mac 身份：更新来源只能是 Mac 配套 Release 仓库（与产品 assertUpdateUrl 同源常量）。
const URL_EXP = `https://api.github.com/repos/${EXPERIMENT_UPDATE_REPO}/releases/latest`;

// Task ui-plan-gpu-progress-20261024 item 1: a proven GitHub quota window is a
// typed, recoverable deferral — never a check failure, and never a fake "latest".

test('proven 429 becomes a typed RateLimitedError whose backoff survives a reload and re-requests after expiry', async () => {
  let time = 0, calls = 0;
  const persisted = { at: 0 };
  const store = { load: async () => persisted.at, save: async at => { persisted.at = at; } };
  const first = new ReleaseClient(async () => { calls++; return new Response('rate', { status: 429, headers: { 'retry-after': '60' } }); }, () => time, store);
  await assert.rejects(first.request(URL_EXP, 1000), err => err instanceof RateLimitedError && err.retryAt === 60000 && /限流/.test(err.message));
  assert.equal(persisted.at, 60000, 'the proven window must reach the async retry store');
  const ok = async () => { calls++; return Response.json({ ok: true }); };
  const restarted = new ReleaseClient(ok, () => time, store);
  await assert.rejects(restarted.request(URL_EXP, 1000, true), err => err instanceof RateLimitedError && err.retryAt === 60000);
  assert.equal(calls, 1, 'a reload must not re-request inside the persisted window, manual included');
  time = 60001;
  assert.deepEqual(JSON.parse((await restarted.request(URL_EXP, 1000, true)).toString()), { ok: true });
  assert.equal(calls, 2, 'the expired window must let the next check through');
});

function updaterFixture(checkImpl) {
  const state = new Map(), calls = [], commands = new Map(), subscriptions = [], bars = [];
  const context = { subscriptions, globalStorageUri: { fsPath: 'unused' },
    globalState: { get: (k, fallback) => state.has(k) ? state.get(k) : fallback, update: async (k, v) => { state.set(k, structuredClone(v)); } } };
  const vscode = { version: '1.100.0', StatusBarAlignment: { Right: 1 }, Uri: { file: fsPath => ({ fsPath }) },
    extensions: { getExtension: () => ({ packageJSON: { version: '1.0.0' } }) },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async id => { calls.push('exec:' + id); } },
    window: { createStatusBarItem: () => { const bar = { text: '', tooltip: '', show() {}, dispose() {} }; bars.push(bar); return bar; },
      showInformationMessage: async message => { calls.push('notice:' + message); },
      showWarningMessage: async message => { calls.push('warning:' + message); },
      showErrorMessage: async message => { calls.push('error:' + message); } } };
  const local = { gate: { begin: async () => {}, end: async () => {}, wait: async () => {} },
    store: { prepare: async () => 'x', verify: async () => {} } };
  const updater = registerUpdater(context, vscode, checkImpl ? { check: checkImpl } : undefined, local);
  return { updater, context, vscode, state, calls, commands, bars, dispose: () => subscriptions.forEach(s => s.dispose()) };
}

test('manual and automatic checks report a rate limit as a waiting state, never a failure or a relabelled latest', async () => {
  const f = updaterFixture(async () => { throw new RateLimitedError('GitHub HTTP 429；限流至 1970-01-01T00:01:00.000Z。', 60000); });
  try {
    const returned = await f.commands.get(CHECK_COMMAND)();
    const warning = f.calls.find(row => row.startsWith('warning:'));
    assert.ok(warning && warning.includes('限流'), 'the manual check must warn with the local retry time instead of throwing');
    assert.ok(warning.includes(new Date(60000).toLocaleString()), 'the warning carries the local retry time');
    assert.ok(!f.calls.some(row => row.startsWith('error:')), 'a rate limit must not raise the failure modal');
    assert.match(f.bars[0].text, /限流中/);
    assert.match(f.bars[0].tooltip, /自动重试/);
    assert.equal(returned.status, 'unknown', 'the returned plan is the published deferral, not a stuck checking state');
    assert.equal(getUpdateStatus().status, 'unknown', 'the API status is the published deferral');
    assert.match(getUpdateStatus().message, /限流中.*自动重试/);
    assert.equal(f.state.get('simpleExperimentMac.pluginUpdateStatus').status, 'unknown', 'globalState must not stay stuck on checking either');
    assert.match(f.state.get('simpleExperimentMac.pluginUpdateStatus').message, /不能视为最新/);
    await f.updater.check(false);
    assert.notEqual(getUpdateStatus().status, 'error', 'the deferral must not publish a failure status');
    assert.notEqual(getUpdateStatus().status, 'up_to_date', 'stale data must never be relabelled as latest');
  } finally { f.dispose(); }
});

test('an expired window restores the normal check flow', async () => {
  let attempts = 0;
  const components = [SFTP_EXTENSION_ID, EXPERIMENT_EXTENSION_ID].map((id, i) => ({ id, repo: i ? EXPERIMENT_UPDATE_REPO : SFTP_UPDATE_REPO, label: id, currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true,
    vsix: { size: 100, url: `https://github.com/${i ? EXPERIMENT_UPDATE_REPO : SFTP_UPDATE_REPO}/releases/download/v1.1.0/update.vsix`, digest: 'sha256:' + 'a'.repeat(64) } }));
  const f = updaterFixture(async () => {
    attempts++;
    if (attempts === 1) throw new RateLimitedError('GitHub HTTP 429。', 60000);
    return { status: 'update_available', checkedAt: '', message: 'update', sftp: components[0], experiment: components[1] };
  });
  try {
    await f.updater.check(true);
    assert.equal(getUpdateStatus().status, 'unknown');
    await f.updater.check(true);
    assert.equal(getUpdateStatus().status, 'update_available', 'after the window the next check reports real results again');
  } finally { f.dispose(); }
});

test('the persistence save is awaited before the check settles and failures are stated inside the typed error', async () => {
  let saveState = 'pending', calls = 0;
  const gate = { open: null };
  const store = { load: async () => 0, save: () => new Promise(resolve => { gate.open = () => { saveState = 'saved'; resolve(); }; }) };
  const client = new ReleaseClient(async () => { calls++; return new Response('rate', { status: 429, headers: { 'retry-after': '60' } }); }, () => 0, store);
  const pending = client.request(URL_EXP, 1000);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(saveState, 'pending', 'the check must still be settling while the save is open');
  gate.open();
  await assert.rejects(pending, err => err instanceof RateLimitedError);
  assert.equal(saveState, 'saved', 'the error settles only after the persistence completed');
  const broken = new ReleaseClient(async () => new Response('rate', { status: 429, headers: { 'retry-after': '60' } }), () => 0,
    { load: async () => 0, save: async () => { throw new Error('disk full'); } });
  await assert.rejects(broken.request(URL_EXP, 1000), err => err instanceof RateLimitedError && err.message.includes('保存失败'),
    'a failed save keeps the in-memory backoff and states the persistence failure openly');
  const syncThrow = new ReleaseClient(async () => { calls++; return Response.json({ ok: true }); }, () => 0,
    { load: () => { throw new Error('storage broken'); }, save: () => {} });
  await syncThrow.request(URL_EXP, 1000);
  assert.equal(calls, 2, 'a synchronously throwing load must not leak into the caller');
});

test('a persisted far-future retry point beyond the 24h cap is rejected, not obeyed forever', async () => {
  let calls = 0;
  const store = { load: async () => 48 * 3600 * 1000, save: async () => {} };
  const client = new ReleaseClient(async () => { calls++; return Response.json({ ok: true }); }, () => 0, store);
  await client.request(URL_EXP, 1000);
  assert.equal(calls, 1, 'a corrupt far-future value cannot lock checks out indefinitely');
});

test('the default updater persists the proven window in globalState and a new window stays deferred', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('rate', { status: 429, headers: { 'retry-after': '60' } }); };
  try {
    const f = updaterFixture(undefined);
    try {
      await f.updater.check(true);
      assert.equal(calls, 1, 'Mac 静态 preview 索引一次检查只取一份索引文件，两个组件共用');
      const retryAt = Number(f.state.get('simpleExperimentMac.pluginUpdateRetryAt'));
      assert.ok(Number.isFinite(retryAt) && retryAt > Date.now(), 'the proven window must be persisted through globalState');
      const second = registerUpdater(f.context, f.vscode, undefined, {
        gate: { begin: async () => {}, end: async () => {}, wait: async () => {} },
        store: { prepare: async () => 'x', verify: async () => {} } });
      await second.check(true);
      assert.equal(calls, 1, 'a reloaded window keeps waiting inside the persisted window');
      assert.ok(f.calls.filter(row => row.startsWith('warning:')).length === 2);
      assert.ok(!f.calls.some(row => row.startsWith('error:')));
      assert.equal(getUpdateStatus().status !== 'error', true);
    } finally { f.dispose(); }
  } finally { globalThis.fetch = originalFetch; }
});
