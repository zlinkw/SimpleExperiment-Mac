const test=require('node:test'), assert=require('node:assert/strict');
const progressModule=require('../../dist/core/ProgressInactivity');
const Original=progressModule.ProgressInactivity;
require('../../dist/core/ProgressRpcTransport').postProgressRpc = (url, options) => global.fetch(url, { method:'POST', ...options });
let now=0, waits=[];
progressModule.ProgressInactivity=class extends Original {
  constructor(_idle,onIdle,_clock,notifyOnly){super(120,onIdle,()=>now,notifyOnly);waits.push(this);}
};
const {callSftpWithProgress}=require('../../dist/core/SimpleSftpProgressWait');
test('fresh discovery rejects unsupported metadata mode before any remote or progress request',async()=>{
 const original=global.fetch;global.fetch=()=>assert.fail('unsupported metadata must never become an implicit full hash inventory');
 try{await assert.rejects(callSftpWithProgress('sync.projectInventory',{metadataOnly:true},async()=>({endpoint:new URL('http://127.0.0.1:1'),headers:{},methodOptions:{}})),/不支持递归文件信息/);}
 finally{global.fetch=original;}
});

async function fixture(run, onProgress, method = 'upload.files') {
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
  const work=callSftpWithProgress(method,{},discover,onProgress);
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

test('capacity transitions reach the caller without inventing file or byte progress',async()=>{
 const reports=[];
 await fixture(async f=>{
  f.emit({phase:'preparing',capacityState:'queued',capacityQueuedAt:'2026-10-17T01:00:00Z'});await new Promise(setImmediate);
  f.emit({phase:'preparing',capacityState:'running',capacityGrantedAt:'2026-10-17T01:00:02Z',capacityWaitMs:2000});await new Promise(setImmediate);
  f.finish();await f.work;
 },row=>reports.push(row),'sync.projectInventory');
 assert.deepEqual(reports.map(r=>r.capacityState),['queued','running']);
 assert.equal(reports[1].capacityWaitMs,2000);
 for(const r of reports){assert.equal(r.processedFiles,undefined);assert.equal(r.processedBytes,undefined);}
});

test('cleanup previews consume real progress instead of timing out as silent control requests',async()=>{
  await fixture(async f=>{
    for(let i=1;i<=5;i++){now+=100;f.emit({phase:'verifying',processedFiles:i});await new Promise(setImmediate);assert.equal(waits[0].check(),false);}
    f.finish();await f.work;assert.equal(f.cancels,0);
  },undefined,'files.cleanup.preview');
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
test('unchanged transfer observations report a stall without fixed-time cancellation; later real progress resumes',async()=>{
  await fixture(async f=>{
    f.emit({phase:'transferring',processedBytes:1});await new Promise(setImmediate);
    now=100;f.emit({phase:'transferring',processedBytes:1});await new Promise(setImmediate);
    now=121;assert.equal(waits[0].check(),true);
    await new Promise(setImmediate);assert.equal(f.cancels,0);
    now=140;f.emit({phase:'transferring',processedBytes:2});await new Promise(setImmediate);assert.equal(waits[0].check(),false);
    f.finish();await f.work;
  });
});

test('all file methods survive silent enumeration and capacity queuing without manufacturing progress or cancelling',async()=>{
 for(const method of ['sync.projectInventory','sync.projectTree','sync.projectTreeState','sync.projectFileStats','sync.planLogPaths','remote.listDirs',
  'files.cleanup.preview','files.cleanup.check','files.cleanup.execute']){
  const snapshots=[];
  await fixture(async f=>{
   now=121;assert.equal(waits[0].check(),true);await new Promise(setImmediate);assert.equal(f.cancels,0,method);
   assert.deepEqual(snapshots.map(x=>x.phase),['stalled']);assert.equal(snapshots[0].processedFiles,undefined);
   now=150;f.emit({phase:'preparing',processedFiles:2});await new Promise(setImmediate);
   assert.equal(waits[0].lastProgressAt,150);
   now=300;waits[0].check();assert.equal(f.cancels,0);
   f.finish();assert.equal((await f.work).ok,true);
  },row=>snapshots.push(row),method);
 }
});

test('a transient progress poll failure resumes observing the same operation without replay',async()=>{
 const original=global.fetch;let operationId,finish,polls=0,starts=0;const reports=[];
 global.fetch=async(url,options)=>{
  if(String(url).includes('/events'))return new Response(null,{status:204});
  const request=JSON.parse(options.body);
  if(request.method==='transfers.list'){
   if(++polls===1)throw Error('temporary observation failure');
   return Response.json({result:{instanceId:'active',transfers:[{operationId,phase:'preparing',processedFiles:4}]}});
  }
  starts++;operationId=request.params._operationId;return new Promise(resolve=>finish=()=>resolve(Response.json({result:{ok:true}})));
 };
 now=0;waits=[];
 try{
  const work=callSftpWithProgress('sync.projectInventory',{},async()=>({endpoint:new URL('http://127.0.0.1:1'),headers:{},instanceId:'active'}),row=>reports.push(row));
  await new Promise(resolve=>setTimeout(resolve,1700));finish();await work;
  assert.ok(polls>=2);assert.equal(starts,1);assert.equal(reports.at(-1).processedFiles,4);
 }finally{global.fetch=original;for(const wait of waits)wait.dispose();}
});

test('a changed plugin instance ends a metadata read as unknown and rejects late success',async()=>{
 const original=global.fetch;let starts=0,cancels=0,finish;
 global.fetch=async(url,options)=>{
  if(String(url).includes('/events'))return new Response(null,{status:204});
  const req=JSON.parse(options.body);
  if(req.method==='transfers.list')return Response.json({result:{instanceId:'replacement',transfers:[]}});
  if(req.method==='transfers.cancel'){cancels++;return Response.json({result:{}});}
  starts++;return new Promise((resolve,reject)=>{finish=()=>resolve(Response.json({result:{ok:true}}));options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
 };
 now=0;waits=[];
 try{
  await assert.rejects(callSftpWithProgress('sync.projectInventory',{},async()=>({endpoint:new URL('http://127.0.0.1:1'),headers:{},instanceId:'original'})),/实例已变化.*结果未知/);
  finish();assert.equal(starts,1);assert.equal(cancels,0);
 }finally{global.fetch=original;for(const wait of waits)wait.dispose();}
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
for(const [readMethod,readParams] of [['sync.projectTree',{}],['sync.downloadMappedPaths',{memoryOnly:true}]])
test('cancelled '+readMethod+' reads permit a fresh refresh without waiting for a missing transfer receipt',async()=>{
 const original=global.fetch,calls=[],controller=new AbortController();let first=true;
 global.fetch=async(url,options)=>{
  if(String(url).includes('/events'))return new Response(null,{status:204});
  const req=JSON.parse(options.body);calls.push(req.method);
  assert.ok(!['transfers.cancel','transfers.reconcile'].includes(req.method));
  if(first){first=false;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}
  return Response.json({result:{ok:true,entries:[],exists:true}});
 };
 try{
  const discovery=async()=>({endpoint:new URL('http://127.0.0.1:1'),headers:{},instanceId:'fixture'});
  const query=callSftpWithProgress(readMethod,{...readParams,signal:controller.signal},discovery);await new Promise(setImmediate);controller.abort(Error('user cancelled query'));
  await assert.rejects(query,/cancelled query/);const next=await callSftpWithProgress(readMethod,readParams,discovery);assert.deepEqual(next.entries,[]);assert.deepEqual(calls,[readMethod,readMethod]);
 }finally{global.fetch=original;for(const wait of waits)wait.dispose();}
});
