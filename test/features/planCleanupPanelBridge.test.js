const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const panelRequire = require('node:module').createRequire(require.resolve('../../dist/extension/PlanCleanupPanel'));

const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const preview = () => ({ token: 'a'.repeat(48), digest: 'digest', action: 'move', scope: { planFile: 'experiments/plans/p.yaml', planHash: 'hash' }, blockers: [],
  rows: [{ node: { id: 'local', root: 'C:/fixture' }, disposition: 'move', absolutePath: 'C:/fixture/experiments/plans/p.yaml', destination: 'clean_dir/experiments/plans/p.yaml', type: 'file', evidence: ['exact'], dependencies: [] }] });

function bridge({ immediateBoot = true, service = {} } = {}) {
  const elements = new Map(), requests = [], responses = [], calls = [], viewers = [], timers = [];
  let now = 1000;
  class Clock extends Date { static now() { return now; } }
  let hostListener, html, booted = false;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: id === 'action' ? 'move' : '', checked: false, disabled: false, textContent: '', innerHTML: '' });
    return elements.get(id);
  };
  const boot = () => {
    if (booted) return;
    booted = true;
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    vm.runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage: message => { requests.push(clone(message)); if (hostListener) void hostListener(clone(message)); } }),
      document: { getElementById: element }, window: { addEventListener: (_type, listener) => viewers.push(listener) }, Date: Clock,
      setInterval: callback => { timers.push(callback); return timers.length; },
    });
  };
  const panel = { webview: {
    get html() { return html; }, set html(value) { html = value; if (immediateBoot) boot(); },
    onDidReceiveMessage(listener) { hostListener = listener; return { dispose() {} }; },
    async postMessage(message) { responses.push(clone(message)); for (const listener of viewers) listener({ data: clone(message) }); return true; },
  }, onDidDispose() {} };
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '../../src/extension/PlanCleanupPanel.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, { exports, require: name => name === 'vscode' ? { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } } : panelRequire(name) });
  const host = { service: {
    async list() { calls.push('list'); return []; },
    async preview() { calls.push('preview'); return preview(); },
    async confirm() { calls.push('confirm'); throw new Error('Not authorized in fixture'); },
    ...service,
  }, async execute() { calls.push('execute'); throw new Error('Not authorized in fixture'); } };
  return { async open() { await exports.openPlanCleanupPanel(host, 'experiments/plans/p.yaml'); if (!immediateBoot) boot(); await flush(); },
    element, requests, responses, calls, hostMessage: message => hostListener(message),
    deliver: message => viewers.forEach(listener => listener({ data: clone(message) })),
    advance: seconds => { now += seconds * 1000; timers.forEach(callback => callback()); } };
}

test('fast Webview startup reaches the host and its automatic preview completes without a second click', async () => {
  const f = bridge(); await f.open();
  assert.deepEqual(f.calls, ['list', 'preview']);
  assert.match(f.element('status').textContent, /只读预览完成/);
  assert.equal(f.element('confirm').disabled, false);
  assert.equal(f.element('execute').disabled, true);
  assert.equal(f.calls.includes('execute'), false);
});

test('history response can immediately request a preview while the preceding host response is still being delivered', async () => {
  const f = bridge({ immediateBoot: false }); await f.open();
  assert.deepEqual(f.calls, ['list', 'preview']);
  assert.match(f.element('status').textContent, /只读预览完成/);
});

test('slow preflight responds immediately; blocked preview reports its reason and permits a fresh click', async () => {
  let release;
  const f = bridge({ immediateBoot: false, service: { preview: () => new Promise(resolve => { release = resolve; }) } });
  await f.open();
  assert.match(f.element('status').textContent, /预览|预检|读取/);
  assert.equal(f.element('preview').disabled, true);
  assert.equal(f.element('confirm').disabled, true);
  release(preview()); await flush();
  assert.equal(f.element('preview').disabled, false);
  assert.equal(f.element('confirm').disabled, false);
  f.element('partial').checked = true; f.element('partial').onchange();
  assert.equal(f.element('confirm').disabled, true);
  assert.equal(f.element('execute').disabled, true);
});

test('no historical operation gives an actionable message and sends no invalid status request', async () => {
  const f = bridge({ immediateBoot: false }); await f.open();
  f.element('load').onclick(); await flush();
  assert.match(f.element('status').textContent, /尚无|选择.*历史/);
  assert.equal(f.requests.filter(message => message.type === 'status').length, 0);
});

test('host preflight failure is visible and releases controls; invalid actions cannot reuse an old approval', async () => {
  const f = bridge({ immediateBoot: false, service: { async preview() { throw Object.assign(new Error('节点当前不可达'), { apiData: { code: 'NODE_UNREACHABLE' } }); } } });
  await f.open();
  assert.match(f.element('status').textContent, /NODE_UNREACHABLE.*节点当前不可达/);
  assert.equal(f.element('preview').disabled, false);
  assert.equal(f.element('confirm').disabled, true);
  assert.equal(f.element('execute').disabled, true);
  const count = f.responses.length;
  await f.hostMessage({ type: 'execute', requestId: 'invalid-execute' });
  assert.equal(f.responses.length, count + 1);
  assert.match(f.responses.at(-1).message, /先.*确认|CONFIRM_REQUIRED/);
  assert.equal(f.calls.includes('execute'), false);
});

test('duplicate host requests return an explicit busy response without starting a second preflight', async () => {
  let release, count = 0;
  const f = bridge({ service: { preview: () => { count++; return new Promise(resolve => { release = resolve; }); } } });
  await f.open();
  await f.hostMessage({ type: 'preview', requestId: 'duplicate' });
  assert.match(f.responses.at(-1).message, /OPERATION_BUSY/);
  assert.equal(count, 1);
  assert.equal(f.element('preview').disabled, true);
  release(preview()); await flush();
  assert.match(f.element('status').textContent, /只读预览完成/);
});

test('permanent-delete approval requires two separate clicks against identical exact paths, and never executes itself', async () => {
  const confirmations = [];
  let current;
  const f = bridge({ service: {
    async preview(params) { const result = preview(); current = { ...result, action: params.action, rows: result.rows.map(row => ({ ...row, disposition: params.action })) }; return current; },
    async confirm(params) {
      confirmations.push(clone(params));
      return { id: 'b'.repeat(48), preview: { ...current, confirmations: params.phase }, state: 'ready', targets: {}, pendingNodes: [] };
    },
  } });
  f.element('action').value = 'delete'; await f.open();
  f.element('confirm').onclick(); await flush();
  assert.equal(confirmations.length, 1); assert.equal(confirmations[0].phase, 1);
  assert.equal(f.element('execute').disabled, true); assert.equal(f.element('confirm').disabled, false);
  f.element('confirm').onclick(); await flush();
  assert.equal(confirmations.length, 2); assert.equal(confirmations[1].phase, 2);
  assert.deepEqual(confirmations[0].exactTargets, confirmations[1].exactTargets);
  assert.deepEqual(confirmations[1].exactTargets, ['local:C:/fixture/experiments/plans/p.yaml']);
  assert.equal(f.element('execute').disabled, false);
  assert.equal(f.requests.some(message => message.type === 'execute'), false);
  f.element('action').value = 'move'; f.element('action').onchange();
  assert.equal(f.element('execute').disabled, true); assert.equal(f.element('confirm').disabled, true);
});

test('an obsolete reply cannot unlock controls or replace the pending newer preview', async () => {
  let release;
  const f = bridge({ service: { preview: () => new Promise(resolve => { release = resolve; }) } });
  await f.open();
  f.deliver({ type: 'preview', requestId: 'obsolete-request', preview: { ...preview(), action: 'delete' } });
  assert.equal(f.element('preview').disabled, true); assert.equal(f.element('confirm').disabled, true);
  release(preview()); await flush();
  assert.equal(f.element('confirm').disabled, false);
  assert.match(f.element('confirm').textContent, /确认上述精确路径/);
});

test('the review page shows live node progress and elapsed time without enabling approval while preflight is pending', async () => {
  let release;
  const f = bridge({ service: { preview: (_params, onProgress) => new Promise(resolve => {
    release = resolve;
    if (onProgress) onProgress({ phase: 'nodes', message: 'nwpu3：校验身份与 SHA256', completed: 2, total: 3 });
  }) } });
  await f.open();
  assert.match(f.element('progress').textContent, /nwpu3.*2\/3/);
  f.advance(3);
  assert.match(f.element('progress').textContent, /3 秒/);
  assert.equal(f.element('confirm').disabled, true);
  f.deliver({ type: 'progress', requestId: 'obsolete-progress', message: '旧操作进度' });
  assert.doesNotMatch(f.element('progress').textContent, /旧操作/);
  release(preview()); await flush();
  assert.equal(f.element('confirm').disabled, false);
  assert.match(f.element('progress').textContent, /3 秒/);
});

test('blocked preview explains disabled approval, removes missing-node text and leaves fresh preview available', async () => {
  const p = preview(); p.blockers = [{ code: 'ACTIVE_OPERATION', detail: 'same-plan-operation' }];
  const f = bridge({ service: { async preview() { return p; } } }); await f.open();
  assert.match(f.element('status').textContent, /预检受阻.*不能确认/s);
  assert.match(f.element('status').textContent, /same-plan-operation/);
  assert.doesNotMatch(f.element('review').innerHTML, /undefined/);
  assert.equal(f.element('confirm').disabled, true); assert.equal(f.element('execute').disabled, true);
  assert.match(f.element('confirm').title, /ACTIVE_OPERATION/);
  assert.equal(f.element('preview').disabled, false);
  f.element('confirm').onclick(); await flush();
  assert.equal(f.requests.some(message => message.type === 'confirm'), false);
});

test('report-only config notices do not block other verified targets; protected-only review explains no target', async () => {
  let protectedOnly = false;
  const f = bridge({ service: { async preview() {
    const p = preview(); p.scope.notices = [{ code: 'CONFIG_REFERENCE_UNVERIFIED', detail: 'q.yaml：{custom_config}' }];
    if (protectedOnly) p.rows[0].disposition = 'protected';
    return p;
  } } }); await f.open();
  assert.equal(f.element('confirm').disabled, false);
  assert.match(f.element('review').innerHTML, /相关配置保留/);
  assert.doesNotMatch(f.element('review').innerHTML, /undefined/);
  protectedOnly = true; f.element('preview').onclick(); await flush();
  assert.equal(f.element('confirm').disabled, true);
  assert.match(f.element('status').textContent, /没有可确认的独占目标/);
  assert.match(f.element('confirm').title, /独占目标/);
  assert.match(f.element('restore').title, /已有清理操作/);
});

test('verified-only approval accepts only offline exceptions and still blocks active tasks', async () => {
  const p = preview(); p.verifiedOnly = true; p.blockers = [{ code: 'OFFLINE_NODE', nodeId: 'w2', detail: 'offline' }];
  const f = bridge({ service: { async preview() { return p; } } }); await f.open();
  assert.equal(f.element('confirm').disabled, false);
  p.blockers.push({ code: 'ACTIVE_JOB', detail: 'run:0' });
  f.element('preview').onclick(); await flush();
  assert.equal(f.element('confirm').disabled, true); assert.match(f.element('status').textContent, /ACTIVE_JOB/);
});
