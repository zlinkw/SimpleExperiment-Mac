const test = require('node:test');
const assert = require('node:assert/strict');
require('../_helpers/registerTsRequire');
const { deleteConfirmedScopeCopy } = require('../../src/features/SyncScopeDelete.ts');
const node = { id: 'worker', kind: 'remote', host: 'fixture', user: 'user', port: 22, root: '/project' };
const CONSUMER = 'D:/local/consumer-project';
const FAST = { confirmedPathDeletion: 1, entryIdentityBind: 1, batchedFastDelete: 1, directoryTreeIsolateDelete: 1, isolationRenameNoReplace: 1, fastDeleteBatchLimit: 5000 };

test('fresh presence reads recover from index invalidation before and after one large deletion without replaying its executor',async()=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const {ProjectFileIndex,sftpFileIndexQuery}=require('../../src/features/ProjectFileIndex.ts');
 const storage=await fs.mkdtemp(path.join(os.tmpdir(),'cleanup-index-race-'));
 const index=new ProjectFileIndex({workspace:storage,endpointId:'worker',projectRoot:'/project',connection:'fixture'},storage);
 let inspections=0,starts=0,checks=0,waits=0;const stages=[];
 await deleteConfirmedScopeCopy(async(method,params)=>{
  if(method.endsWith('.inspect'))return index.read(sftpFileIndexQuery(method,params),async()=>{
   const n=++inspections;if(n===1||n===3)await index.invalidate('live job observation changed',['work_dirs/job']);
   return {ok:true,executorsChecked:true,executors:[],target:{relativePath:params.target.relativePath,type:'directory',missing:starts===1}};
  });
  if(method.endsWith('.preview'))return {token:'same',digest:'approved',safety:FAST,targets:[{absolutePath:'/project/work_dirs/job',type:'directory'}]};
  if(method.endsWith('.execute')){starts++;return {ok:true,state:'requested'};}
  if(method.endsWith('.check'))return {ok:true,state:++checks===3?'completed':'executing',progress:{removedEntries:checks*100000,removedBytes:checks*2**42}};
  return {ok:true};
 },node,'work_dirs/job',true,CONSUMER,stage=>stages.push(stage),{wait:async()=>{waits++;}});
 assert.equal(inspections,4);assert.equal(starts,1);assert.equal(checks,3);assert.equal(waits,4);
 assert.equal(index.snapshot().entries['work_dirs/job'].presence,'absent');assert.ok(stages.some(stage=>/重新.*核实|重新.*读取/.test(stage)));
});

test('index retries are bounded and inspect-only; connection failures and recreated targets never restart a completed deletion',async()=>{
 for(const [kind,after,expectedInspections] of [['invalidated',false,3],['invalidated',true,4],['offline',true,2],['FILE_INDEX_CONNECTION_REPLACED',false,1],['recreated',true,3]]){
  let starts=0,inspections=0;
  await assert.rejects(deleteConfirmedScopeCopy(async method=>{
   if(method.endsWith('.inspect')){
    inspections++;
    if(!after||starts){if(kind!=='recreated'||inspections===2)throw Error(kind==='invalidated'||kind==='recreated'?'FILE_INDEX_INVALIDATED_DURING_READ':kind);}
    return {ok:true,executorsChecked:true,executors:[],target:{missing:false}};
   }
   if(method.endsWith('.preview'))return {token:'same',digest:'approved',safety:FAST,targets:[{absolutePath:'/project/work_dirs/job',type:'directory'}]};
   if(method.endsWith('.execute')){starts++;return {ok:true};}
   return {ok:true,state:'completed'};
  },node,'work_dirs/job',true,CONSUMER,()=>{},{wait:async()=>{}}),/INVALIDATED|offline|CONNECTION_REPLACED|删除后.*核实/);
  assert.equal(starts,after?1:0);assert.equal(inspections,expectedInspections);
 }
 let inspections=0,starts=0;
 await assert.rejects(deleteConfirmedScopeCopy(async method=>{
  if(method.endsWith('.inspect')){inspections++;return {ok:true,executorsChecked:true,executors:[],target:{missing:false}};}
  if(method.endsWith('.preview'))throw Error('FILE_INDEX_INVALIDATED_DURING_READ');starts++;
 },node,'work_dirs/job',true,CONSUMER,()=>{},{wait:async()=>{}}),/INVALIDATED/);
 assert.equal(inspections,1);assert.equal(starts,0);
});

test('local whole-subdirectory deletion permits a repository but direct git/archive/root targets remain protected',()=>{
 const {localDeleteScript}=require('../../src/features/SyncResolution.ts');
 assert.match(localDeleteScript('D:/project','comparison_methods/_repos/cpsc'),/Remove-Item -LiteralPath '.\/cpsc'/);
 for(const rel of ['.git','.git/config','comparison_methods/_repos/cpsc/.git','clean_dir','clean_dir/file'])assert.throws(()=>localDeleteScript('D:/project',rel),/PROTECTED_PATH.*阻拦路径/);
 for(const rel of ['.','../',''])assert.throws(()=>localDeleteScript('D:/project',rel),/不安全/);
});

test('cleanup failure displays the exact blocking descendant and reason through the tree deletion chain',async()=>{
 const { cleanupApiErrorMessage }=require('../../src/core/SimpleSftpProgressWait.ts');
 const payload={message:'/project/repos/cpsc/clean_dir',data:{code:'PROTECTED_DESCENDANT',blockingPath:'/project/repos/cpsc/clean_dir',reason:'归档区受保护，不能随父目录删除'}};
 let mutations=0;
 await assert.rejects(deleteConfirmedScopeCopy(async method=>{
  if(method.endsWith('.inspect'))return {ok:true,executorsChecked:true,executors:[],target:{missing:false}};
  if(method.endsWith('.preview'))throw Object.assign(Error(cleanupApiErrorMessage('files.cleanup.preview',payload)),{apiData:payload.data});
  mutations++;
 },node,'repos/cpsc',true,CONSUMER),error=>{assert.match(error.message,/PROTECTED_DESCENDANT/);assert.match(error.message,/归档区受保护/);assert.match(error.message,/阻拦路径：\/project\/repos\/cpsc\/clean_dir/);assert.equal(error.apiData.blockingPath,payload.data.blockingPath);return true;});
 assert.equal(mutations,0);
 assert.match(cleanupApiErrorMessage('files.cleanup.preview',{message:'/old/parent',data:{code:'PROTECTED_DESCENDANT'}}),/PROTECTED_DESCENDANT.*受保护.*\/old\/parent/);
});

test('actual cleanup RPC parser publishes guard evidence and retains structured failure data',async()=>{
 const transport=require('../../src/core/ProgressRpcTransport.ts'),originalPost=transport.postProgressRpc,originalFetch=global.fetch;
 const data={code:'PROTECTED_DESCENDANT',blockingPath:'/project/repos/cpsc/clean_dir',reason:'归档区受保护'};
 transport.postProgressRpc=async()=>Response.json({error:{code:2010,message:'/project/repos/cpsc/clean_dir',data}});
 global.fetch=async()=>new Response(null,{status:204});
 try{await assert.rejects(require('../../src/core/SimpleSftpProgressWait.ts').callSftpWithProgress('files.cleanup.preview',{},async()=>({endpoint:new URL('http://127.0.0.1:1'),headers:{}})),error=>{assert.match(error.message,/PROTECTED_DESCENDANT.*归档区受保护.*阻拦路径/);assert.deepEqual(error.apiData,data);return true;});}
 finally{transport.postProgressRpc=originalPost;global.fetch=originalFetch;}
});

test('confirmed tree deletion uses managed cleanup and actively verifies lost execution responses', async () => {
  const calls = []; let checks = 0;
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'files.cleanup.inspect') return { ok: true, executorsChecked: true, executors: [], target:{missing:checks===2} };
    if (method === 'files.cleanup.preview') return { token: 'token', digest: 'digest', safety: FAST, targets: [{ absolutePath: '/project/work_dirs/job', type: 'directory' }] };
    if (method === 'files.cleanup.execute') throw Error('response lost');
    if (method === 'files.cleanup.check') return { ok: true, state: ++checks === 1 ? 'executing' : 'completed' };
    return { ok: true };
  };
  await deleteConfirmedScopeCopy(rpc, node, 'work_dirs/job', true, CONSUMER, () => {}, { wait: async () => {} });
  assert.deepEqual(calls.filter(([m]) => m === 'files.cleanup.confirm').map(([,p]) => p.phase), [1,2]);
  assert.equal(calls.filter(([m]) => m === 'files.cleanup.execute').length, 1);
  assert.equal(checks, 2);
  assert.equal(calls.filter(([m])=>m==='files.cleanup.inspect').length,2,'completion refreshes the exact target into the index');
  assert.equal(calls.at(-1)[0],'files.cleanup.inspect');
  assert.ok(!calls.some(([m]) => /transfers|sync.deletePath/.test(m)));
});

test('a response is never proof of deletion; unchanged or unknown filesystem fails', async () => {
  for (const state of ['pending', 'changed', 'partial', 'unknown']) {
    await assert.rejects(deleteConfirmedScopeCopy(async (m) => {
      if (m.endsWith('.inspect')) return { ok: true, executorsChecked: true, executors: [] };
      if (m.endsWith('.preview')) return { token: 't', digest: 'd', safety: FAST, targets: [{ absolutePath: '/project/work_dirs/job', type: 'directory' }] };
      if (m.endsWith('.check')) return { ok: true, state, queryError: 'fixture query' };
      return { ok: true, state: 'completed' };
    }, node, 'work_dirs/job', true, CONSUMER), /删除未核实|查询失败/);
  }
});

test('a live cleanup window prevents a second executor; missing files require no delete', async () => {
  let starts = 0,inspections=0;
  await assert.rejects(deleteConfirmedScopeCopy(async m => {
    if (m.endsWith('.inspect')) return { ok: true, executorsChecked: true, executors: [{windowId:'@7'}] };
    starts++;
  }, node, 'work_dirs/job', true, CONSUMER), /仍在处理/);
  assert.equal(starts, 0);
  await deleteConfirmedScopeCopy(async m => {
    if (m.endsWith('.inspect')) return { ok: true, executorsChecked: true, executors: [], target:{missing:++inspections>1} };
    if (m.endsWith('.preview')) return { safety: FAST, targets: [{ missing: true }] };
    throw Error('unexpected mutation');
  }, node, 'work_dirs/job', true, CONSUMER);
});

test('real deletion progress extends an inactivity budget and busy admission retries only the same approved target',async()=>{
  let now=0,checks=0,starts=0;const requests=[];
  const rpc=async(method,params)=>{
    requests.push([method,params]);
    if(method.endsWith('.inspect'))return {ok:true,executorsChecked:true,executors:[],target:{missing:checks===7}};
    if(method.endsWith('.preview'))return {token:'same',digest:'approved',safety:FAST,targets:[{absolutePath:'/project/work_dirs/job',type:'directory'}]};
    if(method.endsWith('.execute'))return {ok:true,state:++starts===1?'waiting':'requested'};
    if(method.endsWith('.check'))return {ok:true,state:++checks===1?'pending':checks<7?'executing':'completed',progress:{removedEntries:checks-1,removedBytes:(checks-1)*100,totalEntries:7,totalBytes:700}};
    return {ok:true};
  };
  await deleteConfirmedScopeCopy(rpc,node,'work_dirs/job',true,CONSUMER,()=>{},{timeoutMs:15,now:()=>now,wait:async()=>{now+=10;}});
  assert.ok(now>15);assert.equal(starts,2);assert.equal(checks,7);
  assert.ok(requests.filter(([m])=>m.endsWith('.execute')).every(([,p])=>p.token==='same'&&p.digest==='approved'));
});

test('a live slow executor does not time out or resend an uncertain deletion',async()=>{
  let now=0,starts=0,checks=0;
  await deleteConfirmedScopeCopy(async m=>{
    if(m.endsWith('.inspect'))return {ok:true,executorsChecked:true,executors:[],target:{missing:checks===7}};
    if(m.endsWith('.preview'))return {token:'same',digest:'approved',safety:FAST,targets:[{absolutePath:'/project/work_dirs/job',type:'directory'}]};
    if(m.endsWith('.execute')){starts++;throw Error('lost response');}
    if(m.endsWith('.check'))return {ok:true,state:++checks===7?'completed':'executing',progress:{removedEntries:0,removedBytes:0},observedAt:now};
    return {ok:true};
  },node,'work_dirs/job',true,CONSUMER,()=>{},{timeoutMs:15,now:()=>now,wait:async()=>{now+=10;}});
  assert.equal(starts,1);assert.ok(now>15);assert.equal(checks,7);
});

test('a completed executor is not retried when the post-operation index query fails or observes a recreated target',async()=>{
 for(const fail of [false,true]){
  let starts=0,inspects=0;
  const rpc=async m=>{
   if(m.endsWith('.inspect')){if(++inspects>1&&fail)throw Error('offline');return {ok:true,executorsChecked:true,executors:[],target:{missing:false}};}
   if(m.endsWith('.preview'))return {token:'same',digest:'approved',safety:FAST,targets:[{absolutePath:'/project/work_dirs/job',type:'directory'}]};
   if(m.endsWith('.execute'))starts++;
   if(m.endsWith('.check'))return {ok:true,state:'completed'};
   return {ok:true};
  };
  await assert.rejects(deleteConfirmedScopeCopy(rpc,node,'work_dirs/job',true,CONSUMER),/offline|删除后.*核实/);
  assert.equal(inspects,2);assert.equal(starts,1);
 }
});

test('an endpoint without the fast-chain flags fails closed with one unified upgrade error and zero mutation calls', async () => {
  const calls = [];
  const rpc = async (method) => {
    calls.push(method);
    if (method.endsWith('.inspect')) return { ok: true, executorsChecked: true, executors: [], target: { missing: false } };
    if (method.endsWith('.preview')) return { token: 't', digest: 'd', safety: { confirmedPathDeletion: 1 }, targets: [{ absolutePath: '/project/work_dirs/job', type: 'directory' }] };
    throw new Error('unexpected mutation: ' + method);
  };
  await assert.rejects(deleteConfirmedScopeCopy(rpc, node, 'work_dirs/job', true, CONSUMER, () => {}, { wait: async () => {} }),
    error => { assert.match(error.message, /批量快速删除链/); assert.equal(error.apiData?.code, 'SFTP_FAST_DELETE_UPGRADE_REQUIRED'); return true; });
  assert.ok(!calls.some(m => /confirm|execute|check/.test(m)));
});

test('an engine refusing the fast action as UNKNOWN_ACTION maps to the same unified upgrade error', async () => {
  const calls = [];
  const rpc = async (method) => {
    calls.push(method);
    if (method.endsWith('.inspect')) return { ok: true, executorsChecked: true, executors: [], target: { missing: false } };
    if (method.endsWith('.preview')) throw Object.assign(new Error('UNKNOWN_ACTION'), { apiData: { code: 'UNKNOWN_ACTION' } });
    throw new Error('unexpected mutation: ' + method);
  };
  await assert.rejects(deleteConfirmedScopeCopy(rpc, node, 'work_dirs/job', true, CONSUMER, () => {}, { wait: async () => {} }),
    error => { assert.equal(error.apiData?.code, 'SFTP_FAST_DELETE_UPGRADE_REQUIRED'); return true; });
  assert.ok(!calls.some(m => /confirm|execute|check/.test(m)));
});

test('every cleanup request of one deletion carries the same frozen local project root and an unusable root sends nothing', async () => {
  const seen = []; let checks = 0;
  const rpc = async (method, params) => {
    seen.push([method, params.consumerRoot]);
    if (method.endsWith('.inspect')) return { ok: true, executorsChecked: true, executors: [], target: { missing: checks === 1 } };
    if (method.endsWith('.preview')) return { token: 'token', digest: 'digest', safety: FAST, targets: [{ absolutePath: '/project/work_dirs/job', type: 'directory' }] };
    if (method.endsWith('.execute')) return { ok: true, state: 'requested' };
    if (method.endsWith('.check')) { checks = 1; return { ok: true, state: 'completed' }; }
    return { ok: true };
  };
  await deleteConfirmedScopeCopy(rpc, node, 'work_dirs/job', true, CONSUMER, () => {}, { wait: async () => {} });
  assert.ok(seen.length >= 5, 'the deletion chain really ran: ' + seen.map(row => row[0]).join(','));
  assert.ok(seen.every(([, consumer]) => consumer === CONSUMER), 'SimpleSFTP refuses a cleanup batch without its local consuming project: ' + JSON.stringify(seen));
  for (const bad of [undefined, '', '.', 'relative/project', 'D:/bad\rproject']) {
    const requests = [];
    await assert.rejects(deleteConfirmedScopeCopy(async () => { requests.push(1); return { ok: true }; }, node, 'work_dirs/job', true, bad), /消费项目的绝对路径/);
    assert.equal(requests.length, 0, 'no cleanup request leaves this machine without a consumer root');
  }
});
