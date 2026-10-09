require('../_helpers/registerTsRequire');
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { postProgressRpc } = require('../../src/core/ProgressRpcTransport.ts');
const { readBoundedResponseText } = require('../../src/tunnel/BoundedResponse.ts');
const progress = require('../../src/core/ProgressInactivity.ts');
let now = 0, watchdog;
const Original = progress.ProgressInactivity;
progress.ProgressInactivity = class extends Original {
  constructor(idle, onIdle) { super(idle, onIdle, () => now); watchdog = this; }
};
const { callSftpWithProgress } = require('../../src/core/SimpleSftpProgressWait.ts');
const turn = () => new Promise(setImmediate);

async function localServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(new URL(`http://127.0.0.1:${server.address().port}`)); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('long progress RPC bypasses native fetch header cutoff and retains one dispatch with stable stream phase', async () => {
  const saved = global.fetch, reports = [];
  let events, calls = 0;
  now = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('/events')) return new Response(new ReadableStream({ start(c) {
      events = c; options.signal.addEventListener('abort', () => c.close(), { once: true });
    } }));
    throw Object.assign(Error('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
  };
  try {
    await localServer(async (request, response) => {
      let body = ''; for await (const bytes of request) body += bytes;
      const rpc = JSON.parse(body); calls++;
      for (let i = 1; i <= 24; i++) {
        now += 15_000;
        const phase = ['packing', 'transferring', 'unpacking'][i % 3];
        events.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ operationId: rpc.params._operationId,
          phase, id: 'transfer', processedBytes: i * 100, transferredBytes: i * 80,
          comparedFiles: 432, changedFiles: 24, totalBytes: 4096, status: 'running' }) + '\n\n'));
        await turn(); assert.equal(watchdog.check(), false);
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ result: { ok: true, transferredFiles: 24 } }));
    }, async endpoint => {
      const result = await callSftpWithProgress('sync.serverToServerFpsync', {}, async () => ({ endpoint, headers: {} }), r => reports.push(r));
      assert.deepEqual(result, { ok: true, transferredFiles: 24 });
    });
    assert.equal(now, 360_000, 'simulated business time exceeds the previous 300-second deadline');
    assert.equal(calls, 1); assert.equal(reports.length, 24);
    assert.deepEqual([...new Set(reports.map(r => r.phase))], ['streaming']);
    assert.equal(reports.at(-1).comparedFiles, 432); assert.equal(reports.at(-1).changedFiles, 24);
  } finally { global.fetch = saved; watchdog?.dispose(); }
});

test('RPC transport failure awaits cancellation of its own writer and never replays', async () => {
  const saved = global.fetch; let calls = 0, cancellations = 0, writer = false, operationId, stateReads = 0;
  now = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('/events')) return new Response(null, { status: 204 });
    const rpc = JSON.parse(options.body);
    if (rpc.method === 'transfers.list') {
      stateReads++;
      if (stateReads === 2) writer = false;
      const row = { operationId, operationInstanceId: 'host:one', status: writer ? 'cancelling' : 'settled', settledAt: writer ? '' : 'now' };
      return Response.json({ result: { instanceId: 'host:one', operations: writer ? [row] : [],
        transfers: writer ? [{ operationId }] : [], settledOperations: writer ? [] : [row] } });
    }
    assert.equal(rpc.method, 'transfers.cancel'); assert.equal(rpc.params.operationId, operationId);
    cancellations++; await turn();
    return Response.json({ result: { ok: true, operationId, operationInstanceId: 'host:one', status: 'cancelling', settled: false } });
  };
  try {
    await localServer(async (request, response) => {
      let body = ''; for await (const bytes of request) body += bytes;
      operationId = JSON.parse(body).params._operationId; calls++; writer = true;
      response.destroy();
    }, async endpoint => {
      await assert.rejects(callSftpWithProgress('sync.serverToServerFpsync', {}, async () => ({ endpoint, headers: {},
        instanceId: 'host:one', features: { transferSettlementReceipts: true } })), /旧传输结果未知/);
      assert.equal(writer, false);
    });
    assert.equal(calls, 1); assert.equal(cancellations, 1); assert.equal(stateReads, 2);
  } finally { global.fetch = saved; watchdog?.dispose(); }
});

test('loopback RPC abort closes its socket before late completion', async () => {
  await localServer(async (_request, response) => {
    response.once('close', () => {});
  }, async endpoint => {
    const controller = new AbortController();
    const pending = postProgressRpc(endpoint, { headers: {}, body: '{}', signal: controller.signal });
    await turn(); controller.abort(Error('cancelled'));
    await assert.rejects(pending, /abort/i);
  });
  await assert.rejects(postProgressRpc(new URL('https://remote.invalid'), { headers: {}, body: '{}', signal: new AbortController().signal }), /loopback/);
});

test('native RPC stream still enforces bounded response size and releases the socket', async () => {
  await localServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': 33 * 1024 * 1024 }); response.flushHeaders();
  }, async endpoint => {
    const response = await postProgressRpc(endpoint, { headers: {}, body: '{}', signal: new AbortController().signal });
    await assert.rejects(readBoundedResponseText(response, () => {}), /byte limit/);
  });
});
