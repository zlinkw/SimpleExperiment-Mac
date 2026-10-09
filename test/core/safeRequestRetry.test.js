require('../_helpers/registerTsRequire');
require('../../src/core/ProgressRpcTransport.ts').postProgressRpc = (url, options) => global.fetch(url, { method: 'POST', ...options });
const test = require('node:test'), assert = require('node:assert/strict');
const { SafeRequestRetry, retryRequestSignal, registerRetryStopCheck } = require('../../src/core/SafeRequestRetry.ts');
const { confirmSftpOperationStopped, callSftpWithProgress } = require('../../src/core/SimpleSftpProgressWait.ts');
const turn = () => new Promise(setImmediate);

test('failed history releases request; retry executes fresh work', async () => {
  const retry = new SafeRequestRetry();
  await assert.rejects(retry.run('workspace/plan', async () => { throw Error('failed'); }), /failed/);
  assert.equal(await retry.run('workspace/plan', async () => 42), 42);
  assert.equal(retry.requests.size, 0);
});

test('same request aborts, drains, confirms remote exit, then starts; another target stays live', async () => {
  const retry = new SafeRequestRetry(), order = [];
  let finishOld, finishOther;
  const old = retry.run('project/transfer', async () => {
    const signal = retryRequestSignal();
    registerRetryStopCheck(async () => { order.push('remote-exited'); });
    signal.addEventListener('abort', () => order.push('abort'));
    await new Promise(resolve => { finishOld = resolve; });
    order.push('drained');
  });
  const rejected = assert.rejects(old, /重新执行替代/);
  const other = retry.run('other/transfer', async () => {
    const signal = retryRequestSignal();
    await new Promise(resolve => { finishOther = resolve; });
    assert.equal(signal.aborted, false);
  });
  const next = retry.run('project/transfer', async () => { order.push('new'); return 2; });
  await turn(); assert.deepEqual(order, ['abort']);
  await assert.rejects(retry.run('project/transfer', async () => 3), /正在停止/);
  finishOld(); assert.equal(await next, 2); await rejected;
  assert.deepEqual(order, ['abort', 'drained', 'remote-exited', 'new']);
  finishOther(); await other;
  assert.equal(retry.requests.size, 0);
});

test('unknown remote outcome stays guarded until a subsequent retry verifies exit', async () => {
  const retry = new SafeRequestRetry(); let online = false, ran = 0;
  await assert.rejects(retry.run('k', async () => {
    registerRetryStopCheck(async () => { if (!online) throw Error('unknown'); });
    throw Error('connection lost');
  }), /connection lost/);
  await assert.rejects(retry.run('k', async () => ++ran), /unknown/);
  assert.equal(ran, 0); online = true;
  assert.equal(await retry.run('k', async () => ++ran), 1);
  assert.equal(retry.requests.size, 0);
});

test('a local cancellation request is not proof that noncooperative work exited', async () => {
  const retry = new SafeRequestRetry(10); let finish;
  const old = retry.run('k', () => new Promise(resolve => { finish = resolve; }));
  const rejected = assert.rejects(old, /重新执行替代/);
  let ran = false;
  await assert.rejects(retry.run('k', async () => { ran = true; }), /尚未确认退出/);
  assert.equal(ran, false); finish(); await rejected;
  assert.equal(await retry.run('k', async () => 'fresh'), 'fresh');
});

test('SFTP cancellation waits for disposed transfer and operation controllers, including cancelled rows', async () => {
  const saved = global.fetch; let reads = 0;
  const endpoint = new URL('http://127.0.0.1:1'); const calls = [];
  const discovery = { endpoint, headers: {}, instanceId: 'host:started', features: { transferSettlementReceipts: true } };
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body); calls.push(request.method);
    if (request.method === 'transfers.cancel') assert.equal(request.params.operationInstanceId, discovery.instanceId);
    return Response.json({ result: request.method === 'transfers.cancel'
      ? { ok: true, cancelled: true, operationId: 'old', operationInstanceId: discovery.instanceId, status: 'cancelling', instanceId: discovery.instanceId }
      : { ok: true, instanceId: discovery.instanceId,
          transfers: ++reads === 1 ? [{ operationId: 'old', status: 'cancelled' }] : [],
          operations: reads === 2 ? [{ id: 'old', stage: 'draining' }] : [],
          settledOperations: reads === 3 ? [{ operationId: 'old', operationInstanceId: discovery.instanceId, status: 'settled', settledAt: new Date().toISOString() }] : [] } });
  };
  try {
    await confirmSftpOperationStopped('old', discovery);
    assert.equal(reads, 3); assert.equal(calls[0], 'transfers.cancel');
  } finally { global.fetch = saved; }
});

test('mismatched cancel receipt or incomplete/failed state cannot permit replay', async () => {
  const saved = global.fetch, endpoint = new URL('http://127.0.0.1:1');
  const discovery = { endpoint, headers: {}, instanceId: 'host:started', features: { transferSettlementReceipts: true } };
  try {
    global.fetch = async () => Response.json({ result: { ok: true, cancelled: true, operationId: 'different', operationInstanceId: discovery.instanceId, status: 'cancelling', instanceId: discovery.instanceId } });
    await assert.rejects(confirmSftpOperationStopped('old', discovery), /身份不匹配/);
    global.fetch = async (_u, o) => Response.json({ result: JSON.parse(o.body).method === 'transfers.cancel'
      ? { ok: true, cancelled: true, operationId: 'old', operationInstanceId: discovery.instanceId, status: 'cancelling', instanceId: discovery.instanceId }
      : { ok: true, instanceId: discovery.instanceId, transfers: [], operations: [], settledOperations: [] } });
    await assert.rejects(confirmSftpOperationStopped('old', discovery), /缺少该传输的完成回执/);
    global.fetch = async () => Response.json({ result: { ok: true, cancelled: true, operationId: 'old', operationInstanceId: discovery.instanceId, status: 'cancelling', instanceId: 'host:restarted' } });
    await assert.rejects(confirmSftpOperationStopped('old', discovery), /实例已变化/);
    await assert.rejects(confirmSftpOperationStopped('old', { ...discovery, features: {} }), /未提供持久化退出回执/);
  } finally { global.fetch = saved; }
});

test('full SFTP retry cancels the old operation id and starts the replacement only after exit', async () => {
  const saved = global.fetch, retry = new SafeRequestRetry(), endpoint = new URL('http://127.0.0.1:1');
  const events = []; let firstId, requestKey, queries = 0;
  const discover = async () => ({ endpoint, headers: {}, instanceId: 'host:started', features: { transferSettlementReceipts: true } });
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/events')) return new Response(null, { status: 204 });
    const request = JSON.parse(options.body);
    if (request.method === 'transfers.cancel') { events.push('cancel:' + request.params.operationId); return Response.json({ result: { ok: true, cancelled: true, operationId: request.params.operationId, operationInstanceId: 'host:started', status: 'cancelling', instanceId: 'host:started' } }); }
    if (request.method === 'transfers.list') { queries++; events.push('exited'); return Response.json({ result: { ok: true, instanceId: 'host:started', transfers: [], operations: [], settledOperations: [{ operationId: firstId, operationInstanceId: 'host:started', status: 'settled', settledAt: new Date().toISOString() }] } }); }
    const id = request.params._operationId;
    events.push('start:' + id);
    assert.match(request.params._requestKey, /^[a-f0-9]{64}$/);
    if (requestKey) assert.equal(request.params._requestKey, requestKey);
    requestKey = request.params._requestKey;
    if (!firstId) {
      firstId = id;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('transport aborted')), { once: true }));
    }
    assert.notEqual(id, firstId); assert.ok(queries > 0);
    return Response.json({ result: { ok: true, fileCount: 2 } });
  };
  try {
    const old = retry.run('project/sync/plan', () => callSftpWithProgress('sync.downloadMappedPaths', {}, discover));
    const cancelled = assert.rejects(old, /重新执行替代/); await turn();
    const result = await retry.run('project/sync/plan', () => callSftpWithProgress('sync.downloadMappedPaths', {}, discover));
    await cancelled; assert.equal(result.fileCount, 2);
    assert.ok(events.indexOf('cancel:' + firstId) < events.indexOf('exited'));
    assert.equal(retry.requests.size, 0);
  } finally { global.fetch = saved; }
});

test('failed SFTP response with unknown remote outcome keeps same-target retry guarded', async () => {
  const saved = global.fetch, retry = new SafeRequestRetry(), endpoint = new URL('http://127.0.0.1:1');
  const discovery = { endpoint, headers: {}, instanceId: 'host:started', features: { transferSettlementReceipts: true } };
  let starts = 0, cancellations = 0;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'transfers.cancel') {
      cancellations++;
      return Response.json({ result: { ok: true, cancelled: false, status: 'outcomeUnknown', operationId: request.params.operationId,
        operationInstanceId: discovery.instanceId, instanceId: discovery.instanceId } });
    }
    if (request.method === 'sync.downloadMappedPaths') { starts++; throw Error('connection lost after dispatch'); }
    throw new Error(`unexpected ${request.method}`);
  };
  try {
    await assert.rejects(retry.run('same-target', () => callSftpWithProgress('sync.downloadMappedPaths', {}, async () => discovery)), /旧传输结果未知/);
    await assert.rejects(retry.run('same-target', () => callSftpWithProgress('sync.downloadMappedPaths', {}, async () => discovery)), /旧传输结果未知/);
    assert.equal(starts, 1);
    assert.equal(cancellations, 2, 'failed wait requests its own stop; retry rechecks the unknown exit without another dispatch');
  } finally { global.fetch = saved; }
});

test('persisted same-target blocker is settled before the new operation is submitted', async () => {
  const saved = global.fetch, endpoint = new URL('http://127.0.0.1:1');
  const discovery = { endpoint, headers: {}, instanceId: 'host:new', features: { transferSettlementReceipts: true } };
  let starts = 0, confirmations = 0;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'sync.downloadMappedPaths' && starts++ === 0)
      return Response.json({ error: { message: 'same target is unresolved', data: { blockedOperationId: 'old-op', operationInstanceId: 'host:old' } } });
    if (request.method === 'transfers.cancel') {
      confirmations++;
      return Response.json({ result: { ok: true, cancelled: true, settled: true, status: 'settled', operationId: 'old-op',
        operationInstanceId: 'host:old', instanceId: 'host:new' } });
    }
    return Response.json({ result: { ok: true, fileCount: 1 } });
  };
  try {
    const result = await callSftpWithProgress('sync.downloadMappedPaths', {}, async () => discovery);
    assert.equal(result.fileCount, 1);
    assert.equal(starts, 2);
    assert.equal(confirmations, 1);
  } finally { global.fetch = saved; }
});

test('unknown mapped metric download reconciles its exact target before dispatching one fresh request', async () => {
  const saved = global.fetch;
  const discovery = { endpoint: new URL('http://127.0.0.1:1'), headers: {}, instanceId: 'host:new',
    features: { transferSettlementReceipts: true, transferSettlementReconciliation: true } };
  let starts = 0, proofs = 0;
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/events')) return new Response(null, { status: 204 });
    const request = JSON.parse(options.body);
    if (request.method === 'transfers.cancel') return Response.json({ result: { ok: true, status: 'outcomeUnknown', operationId: 'old-read', operationInstanceId: 'host:old' } });
    if (request.method === 'transfers.reconcile') {
      proofs++;
      assert.equal(request.params.retryMethod, 'sync.downloadMappedPaths');
      assert.equal(request.params.retryParams.localPath, 'C:/projects/example');
      return Response.json({ result: { ok: true, status: 'settled', settled: true, operationId: 'old-read', operationInstanceId: 'host:old', instanceId: 'host:new' } });
    }
    if (starts++ === 0) return Response.json({ error: { data: { blockedOperationId: 'old-read', operationInstanceId: 'host:old', notStarted: true } } });
    return Response.json({ result: { ok: true, memoryOnly: true, fileCount: 1 } });
  };
  try {
    const result = await callSftpWithProgress('sync.downloadMappedPaths', { localPath: 'C:/projects/example', memoryOnly: true, metricsOnly: true }, async () => discovery);
    assert.equal(result.fileCount, 1); assert.equal(starts, 2); assert.equal(proofs, 1);
  } finally { global.fetch = saved; }
});

test('legacy server transfer unknown is reconciled before exactly one fresh dispatch', async () => {
  const saved = global.fetch, order = [], phases = [];
  const discovery = { endpoint: new URL('http://127.0.0.1:1'), headers: {}, instanceId: 'host:new',
    features: { transferSettlementReceipts: true, transferSettlementReconciliation: true } };
  const params = { source: { host: 'source', username: 'tester', remotePath: '/projects/example' },
    destination: { host: 'destination', username: 'tester', remotePath: '/projects/example' } };
  let starts = 0;
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/events')) return new Response(null, { status: 204 });
    const request = JSON.parse(options.body); order.push(request.method);
    if (request.method === 'transfers.cancel') return Response.json({ result: { ok: true, cancelled: false, status: 'outcomeUnknown',
      operationId: 'old', operationInstanceId: 'host:old' } });
    if (request.method === 'transfers.reconcile') {
      assert.equal(request.params.operationId, 'old'); assert.deepEqual(request.params.retryParams.source, params.source);
      assert.equal(request.params.retryParams.password, undefined);
      return Response.json({ result: { ok: true, status: 'settled', settled: true, operationId: 'old',
        operationInstanceId: 'host:old', instanceId: 'host:new' } });
    }
    if (starts++ === 0) return Response.json({ error: { data: { blockedOperationId: 'old', operationInstanceId: 'host:old', notStarted: true } } });
    return Response.json({ result: { ok: true, verifiedFiles: 6 } });
  };
  try {
    const retry = new SafeRequestRetry();
    assert.equal((await retry.run('target', () => callSftpWithProgress('sync.serverToServerFpsync', params, async () => discovery,
      snapshot => { phases.push(snapshot.phase); throw Error('notification unavailable'); }))).verifiedFiles, 6);
    assert.deepEqual(order, ['sync.serverToServerFpsync', 'transfers.cancel', 'transfers.reconcile', 'sync.serverToServerFpsync']);
    assert.deepEqual(phases, ['reconciling']);
    assert.equal(retry.requests.size, 0);
  } finally { global.fetch = saved; }
});

test('blocked not-started attempt cannot poison a later same-host retry with a nonexistent stop check', async () => {
  const saved = global.fetch, retry = new SafeRequestRetry();
  const discovery = { endpoint: new URL('http://127.0.0.1:1'), headers: {}, instanceId: 'host:new',
    features: { transferSettlementReceipts: true, transferSettlementReconciliation: true } };
  let idle = false, starts = 0;
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/events')) return new Response(null, { status: 204 });
    const request = JSON.parse(options.body);
    if (request.method === 'transfers.cancel') {
      assert.equal(request.params.operationId, 'old', 'must never try cancelling the unstarted operation');
      return Response.json({ result: { ok: true, cancelled: false, status: 'outcomeUnknown', operationId: 'old', operationInstanceId: 'host:old' } });
    }
    if (request.method === 'transfers.reconcile') return Response.json({ result: { ok: true, settled: idle, status: idle ? 'settled' : 'outcomeUnknown',
      reason: 'REMOTE_TRANSFER_SLOT_BUSY', operationId: 'old', operationInstanceId: 'host:old', instanceId: 'host:new' } });
    starts++;
    if (starts <= 2) return Response.json({ error: { data: { blockedOperationId: 'old', operationInstanceId: 'host:old', notStarted: true } } });
    return Response.json({ result: { ok: true } });
  };
  try {
    const work = () => callSftpWithProgress('sync.serverToServerFpsync', {}, async () => discovery);
    await assert.rejects(retry.run('target', work), /REMOTE_TRANSFER_SLOT_BUSY/);
    assert.equal(starts, 1); assert.equal(retry.requests.size, 0);
    idle = true; assert.equal((await retry.run('target', work)).ok, true); assert.equal(starts, 3);
  } finally { global.fetch = saved; }
});

test('unavailable or mismatched recovery proof never resends a modifying transfer', async () => {
  const saved = global.fetch;
  const discovery = { endpoint: new URL('http://127.0.0.1:1'), headers: {}, instanceId: 'host:new',
    features: { transferSettlementReceipts: true, transferSettlementReconciliation: true } };
  try {
    for (const proof of [
      { status: 'outcomeUnknown', settled: false, reason: 'REMOTE_TRANSFER_STILL_ACTIVE' },
      { status: 'settled', settled: true, operationInstanceId: 'other:instance' },
      { status: 'settled', settled: true, instanceId: 'another:host' },
    ]) {
      let starts = 0;
      global.fetch = async (url, options) => {
        if (String(url).endsWith('/events')) return new Response(null, { status: 204 });
        const request = JSON.parse(options.body);
        if (request.method === 'transfers.cancel') return Response.json({ result: { ok: true, status: 'outcomeUnknown', operationId: 'old', operationInstanceId: 'host:old' } });
        if (request.method === 'transfers.reconcile') return Response.json({ result: { ok: true, operationId: 'old', operationInstanceId: 'host:old', instanceId: 'host:new', ...proof } });
        starts++; return Response.json({ error: { data: { blockedOperationId: 'old', operationInstanceId: 'host:old', notStarted: true } } });
      };
      await assert.rejects(callSftpWithProgress('sync.serverToServerFpsync', {}, async () => discovery), /未重新传输/);
      assert.equal(starts, 1);
    }
  } finally { global.fetch = saved; }
});

test('replacement during reconciliation drains the old caller and never dispatches its cancelled request', async () => {
  const saved = global.fetch, retry = new SafeRequestRetry(), ids = [];
  const discovery = { endpoint: new URL('http://127.0.0.1:1'), headers: {}, instanceId: 'host:new',
    features: { transferSettlementReceipts: true, transferSettlementReconciliation: true } };
  let entered, complete;
  const ready = new Promise(resolve => { entered = resolve; });
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/events')) return new Response(null, { status: 204 });
    const request = JSON.parse(options.body);
    if (request.method === 'transfers.cancel') return Response.json({ result: { ok: true, status: 'outcomeUnknown',
      operationId: request.params.operationId, operationInstanceId: request.params.operationInstanceId } });
    if (request.method === 'transfers.reconcile') {
      entered(); return new Promise(resolve => { complete = () => resolve(Response.json({ result: { ok: true, status: 'settled', settled: true,
        operationId: 'old', operationInstanceId: 'host:old', instanceId: 'host:new' } })); });
    }
    ids.push(request.params._operationId);
    if (ids.length === 1) return Response.json({ error: { data: { blockedOperationId: 'old', operationInstanceId: 'host:old', notStarted: true } } });
    return Response.json({ result: { ok: true } });
  };
  try {
    const work = () => callSftpWithProgress('sync.serverToServerFpsync', {}, async () => discovery);
    const first = retry.run('target', work), rejected = assert.rejects(first, /重新执行替代/);
    await ready;
    const next = retry.run('target', work); await turn();
    assert.equal(ids.length, 1, 'must drain the proof before starting the replacement');
    complete(); await rejected; assert.equal((await next).ok, true);
    assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]); assert.equal(retry.requests.size, 0);
  } finally { global.fetch = saved; }
});

for (const method of ['sync.projectInventory', 'sync.projectTree', 'sync.projectFileStats']) test(`explicit retry of legacy ${method} uses producer exit proof before dispatch`, async () => {
  const saved = global.fetch, order = [], retry = new SafeRequestRetry();
  const discovery = { endpoint: new URL('http://127.0.0.1:1'), headers: {}, instanceId: 'host:new',
    features: { transferSettlementReceipts: true, transferSettlementReconciliation: true, transferReconciliationMethods: [method] } };
  let starts = 0;
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/events')) return new Response(null, { status: 204 });
    const request = JSON.parse(options.body); order.push(request.method);
    if (request.method === 'transfers.cancel') return Response.json({ result: { ok: true, status: 'outcomeUnknown', operationId: 'old', operationInstanceId: 'host:old' } });
    if (request.method === 'transfers.reconcile') {
      assert.equal(request.params.retryMethod, method); assert.equal(request.params.requestKey.length, 64);
      assert.equal(request.params.retryParams.source.remotePath, '/project');
      return Response.json({ result: { ok: true, settled: true, status: 'settled', operationId: 'old', operationInstanceId: 'host:old', instanceId: 'host:new' } });
    }
    if (starts++ === 0) return Response.json({ error: { data: { notStarted: true, blockedOperationId: 'old', operationInstanceId: 'host:old' } } });
    return Response.json({ result: { ok: true, files: {} } });
  };
  try {
    const params = { source: { host: 'server', username: 'owner', remotePath: '/project' } };
    assert.equal((await retry.run('publish', () => callSftpWithProgress(method, params, async () => discovery))).ok, true);
    assert.deepEqual(order, [method, 'transfers.cancel', 'transfers.reconcile', method]);
    assert.equal(retry.requests.size, 0);
    starts = 0; discovery.features.transferReconciliationMethods = [];
    await assert.rejects(retry.run('publish', () => callSftpWithProgress(method, params, async () => discovery)), /更新 SimpleSFTP/);
    assert.equal(starts, 1, 'unsupported producer must not dispatch a second request');
  } finally { global.fetch = saved; }
});
