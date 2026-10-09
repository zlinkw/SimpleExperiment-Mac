const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../_helpers/registerTsRequire');
const {BoundedSseDecoder,readBoundedResponseText,MAX_CONTROL_RESPONSE_BYTES}=require('../../src/tunnel/BoundedResponse.ts');
const {RealtimeTunnelClient}=require('../../src/tunnel/RealtimeTunnelClient.ts');
const {HttpTunnelClient}=require('../../src/tunnel/TunnelClient.ts');
const {RequestBudget}=require('../../src/tunnel/RequestBudget.ts');
const endpoint={localHost:'127.0.0.1',localPort:1};

test('bounded HTTP decoder cancels oversized streams, releases locks and preserves UTF-8',async()=>{
  let cancelled=0;
  const body=new ReadableStream({start(c){c.enqueue(Buffer.from('12345'));},cancel(){cancelled++;}});
  await assert.rejects(readBoundedResponseText(new Response(body),()=>{},4),/byte limit/);
  assert.equal(cancelled,1);assert.equal(body.locked,false);
  const bytes=Buffer.from('结果');const progress=[];
  const complete=new ReadableStream({start(c){c.enqueue(bytes.subarray(0,1));c.enqueue(bytes.subarray(1));c.close();}});
  assert.equal(await readBoundedResponseText(new Response(complete),n=>progress.push(n),8),'结果');
  assert.deepEqual(progress,[1,6]);assert.equal(complete.locked,false);
});

test('HTTP client rejects advertised oversize before buffering and restores request accounting',async()=>{
  const previous=global.fetch;let cancelled=0;
  const budget=new RequestBudget();
  global.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-length':String(MAX_CONTROL_RESPONSE_BYTES+1)}});
  try {
    await assert.rejects(new HttpTunnelClient(endpoint,budget).getSnapshot(),/byte limit/);
    assert.equal(budget.snapshot().inFlight,0);assert.equal(cancelled,1);
  } finally { global.fetch=previous; }
});

test('SSE decoder handles split Unicode/delimiters and bounds frames, not accumulated history',()=>{
  const decoder=new BoundedSseDecoder(64);const bytes=Buffer.from('data: {"text":"结果"}\r\n\r\n');
  const events=[];for(const byte of bytes)events.push(...decoder.push(Uint8Array.of(byte)));
  assert.deepEqual(events,['{"text":"结果"}']);
  for(let i=0;i<10000;i++)assert.deepEqual(decoder.push(Buffer.from('data: {}\n\n')),['{}']);
  assert.throws(()=>decoder.push(Buffer.from('x'.repeat(65))),/byte limit/);
});

test('SSE failure releases the reader and retains the specific failure for automatic reconnect',async()=>{
  const client=new RealtimeTunnelClient(endpoint,new RequestBudget());
  const abort=new AbortController();client.abort=abort;client.status='sse';
  let requests=0;
  const body=new ReadableStream({pull(c){if(requests++===0)c.enqueue(Buffer.from('data: {}\n\n'));else c.error(new Error('stream failure evidence'));}});
  try {
    await client.readSse(body,abort);
    assert.equal(body.locked,false);
    assert.match(client.diagnostics().lastError,/stream failure evidence/);
    assert.ok(client.reconnectTimer);
  }finally{await client.disconnect('dispose');}
});

test('reconnection aborts old snapshot and never reuses it for the next generation',async()=>{
  const states=[];const client=new RealtimeTunnelClient(endpoint,new RequestBudget(),undefined,s=>states.push(s));
  const requests=[];
  client.http.getSnapshot=options=>new Promise(resolve=>requests.push({options,resolve}));
  const old=client.getSnapshot();await client.disconnect();
  assert.equal(requests[0].options.signal.aborted,true);
  const current=client.getSnapshot();assert.equal(requests.length,2);
  requests[1].resolve({schemaVersion:1,gpu:{new:[]},schedulerStates:[],experimentTraces:[]});
  await current;
  requests[0].resolve({schemaVersion:1,gpu:{old:[]},schedulerStates:[],experimentTraces:[]});await old;
  assert.equal(states.length,1);assert.ok('new' in states[0].gpu);
  assert.equal(client.snapshotInFlight,undefined);assert.equal(client.snapshotAbort,undefined);
  await client.disconnect('dispose');
});
