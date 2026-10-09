const test = require('node:test');
const assert = require('node:assert/strict');
const { RealtimeTunnelClient, defaultRealtimeRefreshPolicy } = require('../../dist/tunnel/RealtimeTunnelClient');
const { RequestBudget } = require('../../dist/tunnel/RequestBudget');
function client() {
  return new RealtimeTunnelClient({localHost:'127.0.0.1',localPort:1}, new RequestBudget(),
    {...defaultRealtimeRefreshPolicy,preferWebSocket:false,fallbackToSse:false});
}

test('authentication failure requires manual recovery; recovery reads current state', async () => {
  const c = client(); let calls = 0;
  c.http.getSnapshot = async () => { calls++; throw Error('HTTP 401 unauthorized'); };
  await c.connect();
  assert.equal(c.diagnostics().requiresManualReconnect,true);
  await c.connect();
  await assert.rejects(c.getWorkerTasks(),/修复配置后重新检测隧道/);
  await assert.rejects(c.getGpu(),/修复配置后重新检测隧道/);
  assert.equal(calls,1);
  c.http.getSnapshot = async () => { calls++; return {gpu:{recovered:[]}}; };
  await c.reconnect();
  assert.equal(c.diagnostics().requiresManualReconnect,false);
  assert.ok(c.currentState().lastKnownGood.gpu.recovered);
  c.setHidden(true);
  assert.equal(c.diagnostics().streamStatus,'polling');
  assert.equal(c.pollTimer,undefined);
  c.setHidden(false);
  assert.ok(c.pollTimer);
  await c.disconnect();
});

test('transient connection loss recovers automatically with backoff and retains peer telemetry', async () => {
  const c = client(), peer = client(); let calls = 0;
  c.policy.reconnectInitialDelaySeconds = 1;
  c.policy.reconnectMaxDelaySeconds = 1;
  c.http.getSnapshot = async () => { if (++calls === 1) throw Error('connection reset'); return { gpu: { recovered: [] } }; };
  peer.http.getSnapshot = async () => ({ gpu: { peer: [{ index: 0 }] } });
  try {
    await peer.connect(); await c.connect();
    assert.equal(c.diagnostics().requiresManualReconnect, false);
    assert.equal(c.diagnostics().streamStatus, 'disconnected');
    const deadline = Date.now() + 3500;
    while (c.diagnostics().streamStatus !== 'polling' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(c.diagnostics().streamStatus, 'polling');
    assert.equal(calls, 2);
    assert.deepEqual(peer.currentState().lastKnownGood.gpu.peer, [{ index: 0 }]);
  } finally { await c.disconnect('dispose'); await peer.disconnect('dispose'); }
});

test('optional request failures and late failures cannot poison a healthy stream', async () => {
  const c = client(); c.status = 'sse';
  c.http.requestJson = async () => { throw Error('HTTP 404 optional route'); };
  await assert.rejects(c.requestJson('/api/tmux/list', 'manual_refresh', undefined, {}), /404/);
  assert.equal(c.diagnostics().streamStatus, 'sse');
  let fail;
  c.http.requestJson = () => new Promise((_, reject) => { fail = reject; });
  const old = c.requestJson('/api/tmux/list', 'manual_refresh', undefined, {});
  await c.disconnect(); c.status = 'sse';
  fail(Error('HTTP 401 old request'));
  await assert.rejects(old, /401/);
  assert.equal(c.diagnostics().streamStatus, 'sse');
  assert.equal(c.diagnostics().requiresManualReconnect, false);
  await c.disconnect('dispose');
});

test('pausing during the connect yield prevents a late connection from restarting', async () => {
  const c = client(); let reads = 0;
  c.http.getSnapshot = async () => { reads++; return { gpu: {} }; };
  const connecting = c.connect();
  c.budget.pauseAll(); await c.disconnect('paused'); await connecting;
  assert.equal(reads, 0);
  assert.equal(c.diagnostics().streamStatus, 'paused');
  assert.equal(c.reconnectTimer, undefined);
  await c.disconnect('dispose');
});

test('a failed old polling request cannot disconnect the replacement stream', async () => {
  const c = client(); let fail;
  c.status = 'polling';
  c.snapshotFallbackDelayMs = () => 1;
  c.http.getSnapshot = () => new Promise((_, reject) => { fail = reject; });
  try {
    c.scheduleSnapshotFallbackPoll();
    const deadline = Date.now() + 1000;
    while (!fail && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(typeof fail, 'function');
    await c.disconnect(); c.status = 'sse';
    fail(Error('HTTP 401 obsolete polling request'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.diagnostics().streamStatus, 'sse');
    assert.equal(c.diagnostics().requiresManualReconnect, false);
  } finally { await c.disconnect('dispose'); }
});

test('an aborted old SSE reader cannot replay its trailing buffer', async () => {
  const c = client(); const abort = new AbortController(); let stream;
  const accepted = [];
  c.status = 'sse'; c.abort = abort;
  c.acceptEvent = event => accepted.push(event);
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  const reading = c.readSse(body, abort);
  stream.enqueue(new TextEncoder().encode('data: {"seq": 99}'));
  await new Promise(resolve => setImmediate(resolve));
  await c.disconnect(); c.status = 'sse'; c.abort = new AbortController();
  stream.close(); await reading;
  assert.deepEqual(accepted, []);
  assert.equal(c.diagnostics().streamStatus, 'sse');
  await c.disconnect('dispose');
});

test('manual and fallback snapshot reads coalesce; old response cannot update disconnected state', async () => {
  const c = client(); let release, calls=0;
  c.http.getSnapshot = () => { calls++; return new Promise(r=>{release=r;}); };
  const first=c.getSnapshot(), second=c.refreshSnapshot();
  assert.equal(calls,1);
  await c.disconnect();
  release({gpu:{late:[]}});
  await Promise.all([first,second]);
  assert.equal(c.currentState().lastKnownGood,undefined);
});

test('an unaffected worker continues after another loses connection', async () => {
  const a=client(), b=client();
  a.http.getSnapshot=async()=>{throw Error('offline');};
  b.http.getSnapshot=async()=>({gpu:{healthy:[]}});
  await a.connect(); await b.connect();
  assert.equal(a.diagnostics().streamStatus,'disconnected');
  assert.equal(b.diagnostics().streamStatus,'polling');
  await Promise.all([a.disconnect(),b.disconnect()]);
});

test('manual recovery leaves already connected Workers attached',async()=>{
  const {MultiEndpointRealtimeClient}=require('../../dist/tunnel/MultiEndpointRealtimeClient');
  const host=Object.create(MultiEndpointRealtimeClient.prototype);let healthy=0,failed=0;
  host.clients=new Map([['healthy',{diagnostics:()=>({streamStatus:'sse'}),reconnect:async()=>healthy++}],
    ['failed',{diagnostics:()=>({streamStatus:'disconnected',requiresManualReconnect:true}),reconnect:async()=>failed++}]]);
  host.updateMergedState=()=>undefined;await host.reconnect();assert.equal(healthy,0);assert.equal(failed,1);
});
