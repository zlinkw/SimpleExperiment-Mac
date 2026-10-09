const test=require('node:test'), assert=require('node:assert/strict');
const progressModule=require('../../dist/core/ProgressInactivity');
const Original=progressModule.ProgressInactivity;
require('../../dist/core/ProgressRpcTransport').postProgressRpc = (url, options) => global.fetch(url, { method:'POST', ...options });
let now=0, waits=[];
progressModule.ProgressInactivity=class extends Original {
  constructor(_idle,onIdle){super(120,onIdle,()=>now);waits.push(this);}
};
const {callSftpWithProgress}=require('../../dist/core/SimpleSftpProgressWait');

async function fixture(run, onProgress) {
  const original=global.fetch; let stream, operationId, finish, cancels=0;
  const discover=async()=>({endpoint:new URL('http://127.0.0.1:1'),headers:{}});
  global.fetch=async(url,options)=>{
    if(String(url).includes('/events')) return new Response(new ReadableStream({start(c){stream=c;options.signal.addEventListener('abort',()=>c.close(),{once:true});}}));
    const request=JSON.parse(options.body);
    if(request.method==='transfers.list') return Response.json({result:{transfers:[]}});
    if(request.method==='transfers.cancel') {cancels++;return Response.json({result:{ok:true}});}
    operationId=request.params._operationId;
    return new Promise((resolve,reject)=>{finish=()=>resolve(Response.json({result:{ok:true,fileCount:1}})); options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
  };
  now=0;waits=[];
  const work=callSftpWithProgress('upload.files',{},discover,onProgress);
  await new Promise(setImmediate);
  const emit=(data)=>stream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:'transfer',operationId,...data})+'\n\n'));
  try {await run({work,finish,emit,get cancels(){return cancels;}});}
  finally {for(const wait of waits)wait.dispose();global.fetch=original;}
}
test('file RPC may exceed old duration while genuine event progress continues',async()=>{
  await fixture(async f=>{
    for(let i=1;i<=20;i++){now+=100;f.emit({phase:'transferring',processedBytes:i});await new Promise(setImmediate);assert.equal(waits[0].check(),false);}
    f.finish();assert.deepEqual(await f.work,{ok:true,fileCount:1});
  });
});

test('only current operation genuine progress reaches the caller; telemetry failure is isolated',async()=>{
  const progress=[];
  await fixture(async f=>{
    f.emit({phase:'hashing',processedFiles:4,processedBytes:1048576});await new Promise(setImmediate);
    f.emit({phase:'hashing',processedFiles:4,processedBytes:1048576});await new Promise(setImmediate);
    f.emit({operationId:'unrelated',phase:'transferring',processedBytes:99999999});await new Promise(setImmediate);
    f.emit({phase:'unpacking',processedFiles:1,processedBytes:1024});await new Promise(setImmediate);
    f.finish();assert.deepEqual(await f.work,{ok:true,fileCount:1});
  },snapshot=>{progress.push(snapshot);throw new Error('notification unavailable');});
  assert.equal(progress.length,2);
  assert.equal(progress[0].phase,'hashing');
  assert.equal(progress[0].processedFiles,4);
  assert.equal(progress[0].processedBytes,1048576);
  assert.ok(progress[0].elapsedMs>=0);
  assert.equal(progress[1].phase,'streaming');
});

test('committed file and group counters reach the caller even when the active child reports zero files',async()=>{
  const reports=[];
  await fixture(async f=>{
    f.emit({phase:'transferring',processedBytes:100,processedFiles:2,completedFiles:2,totalFiles:6,completedGroups:1,totalGroups:3});
    await new Promise(setImmediate);
    f.emit({phase:'unpacking',processedBytes:200,processedFiles:0,completedFiles:2,totalFiles:6,completedGroups:1,totalGroups:3});
    await new Promise(setImmediate);
    f.finish();await f.work;
  },row=>reports.push(row));
  assert.equal(reports.at(-1).processedFiles,0);
  assert.equal(reports.at(-1).completedFiles,2);assert.equal(reports.at(-1).totalFiles,6);
  assert.equal(reports.at(-1).completedGroups,1);assert.equal(reports.at(-1).totalGroups,3);
});

test('cache and difference diagnostics are forwarded with real work and bounded fields', async () => {
  const reports = [];
  await fixture(async f => {
    f.emit({phase:'hashing', processedFiles:52, processedBytes:4096, cacheHits:50, cacheRehash:2, cacheStatus:'write-failed'});
    await new Promise(setImmediate);
    f.emit({phase:'transferring', processedBytes:8192, unchangedFiles:4, missingFiles:1, differentFiles:1, cacheHits:-1, cacheStatus:'arbitrary'});
    await new Promise(setImmediate);
    f.finish(); await f.work;
  }, row => reports.push(row));
  assert.equal(reports[0].cacheHits,50); assert.equal(reports[0].cacheRehash,2); assert.equal(reports[0].cacheStatus,'write-failed');
  assert.equal(reports[1].cacheHits,undefined); assert.equal(reports[1].cacheStatus,undefined);
  assert.equal(reports[1].unchangedFiles,4); assert.equal(reports[1].missingFiles,1); assert.equal(reports[1].differentFiles,1);
});

test('poll fallback forwards current progress when the event stream is unavailable',async()=>{
  const original=global.fetch, progress=[];
  let operationId, finish;
  global.fetch=async(url,options)=>{
    if(String(url).includes('/events'))return new Response(null,{status:204});
    const request=JSON.parse(options.body);
    if(request.method==='transfers.list')return Response.json({result:{instanceId:'active',transfers:[
      {operationId:'another',phase:'hashing',processedFiles:999},
      {operationId,phase:'hashing',processedFiles:7,processedBytes:2097152},
    ]}});
    operationId=request.params._operationId;
    return new Promise(resolve=>{finish=()=>resolve(Response.json({result:{ok:true}}));});
  };
  now=0;waits=[];
  try {
    const work=callSftpWithProgress('sync.projectInventory',{},async()=>({endpoint:new URL('http://127.0.0.1:1'),headers:{},instanceId:'active'}),snapshot=>progress.push(snapshot));
    await new Promise(resolve=>setTimeout(resolve,600));
    finish();await work;
    assert.equal(progress.length,1);
    assert.equal(progress[0].processedFiles,7);
    await new Promise(resolve=>setTimeout(resolve,550));
    assert.equal(progress.length,1,'disposed requests must never keep notifying');
  } finally {for(const wait of waits)wait.dispose();global.fetch=original;}
});
test('repeated events expire; cancellation reaches known transfers and discards late result',async()=>{
  await fixture(async f=>{
    f.emit({phase:'transferring',processedBytes:1});await new Promise(setImmediate);
    now=100;f.emit({phase:'transferring',processedBytes:1});await new Promise(setImmediate);
    now=121;assert.equal(waits[0].check(),true);
    await assert.rejects(f.work,/执行结果待确认/);
    await new Promise(setImmediate);assert.equal(f.cancels,1);
    f.finish();
  });
});

test('oversized RPC responses are bounded and their stream is cancelled', async () => {
  const original = global.fetch;
  let cancelled = false;
  global.fetch = async (url) => {
    if (String(url).includes('/events')) return new Response(null, { status: 204 });
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: { 'content-length': String(33 * 1024 * 1024) },
    });
  };
  try {
    await assert.rejects(callSftpWithProgress('upload.files', {}, async () => ({ endpoint: new URL('http://127.0.0.1:1'), headers: {} })), /byte limit/);
    await new Promise(setImmediate);
    assert.equal(cancelled, true);
  } finally { global.fetch = original; }
});

test('oversized SSE frames release their reader and do not interrupt the actual transfer', async () => {
  const original = global.fetch;
  let cancelled = false;
  global.fetch = async (url) => {
    if (String(url).includes('/events')) return new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1).fill(97)); },
      cancel() { cancelled = true; },
    }));
    await new Promise(setImmediate);
    return Response.json({ result: { ok: true } });
  };
  try {
    assert.deepEqual(await callSftpWithProgress('upload.files', {}, async () => ({ endpoint: new URL('http://127.0.0.1:1'), headers: {} })), { ok: true });
    assert.equal(cancelled, true);
  } finally { global.fetch = original; }
});
