const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
require('../_helpers/registerTsRequire');
const ts=require('typescript'),{ProjectFileIndex,sftpFileIndexQuery,fileOperationIndexPaths}=require('../../src/features/ProjectFileIndex.ts');
const source=require('node:fs').readFileSync(process.env.SIMPLEEX_TEST_HOST_SOURCE||path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
const ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true);let method;
(function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)==='simpleSftpApiCall')method=n.getText(ast);else ts.forEachChild(n,visit);})(ast);
assert.ok(method);
async function fixture(onRead){
 const storage=await fs.mkdtemp(path.join(os.tmpdir(),'cleanup-index-main-'));
 const identity={workspace:storage,endpointId:'synthetic-worker',projectRoot:'/synthetic/project',connection:'one'};
 const index=new ProjectFileIndex(identity,storage),calls=[];
 // 合流接线：真实 simpleSftpApiCall 在 mutation 路由先过 assertTransferRootSafety（feature 根守卫）；
 // 本切片只提取 simpleSftpApiCall 本体，守卫真身由 projectRootMap.test.js 独立提取验证（同 projectFileIndex.test.js 口径）。
 const h={client:{},assertTransferRootSafety(){},simpleSftpCapability:async()=>({}),projectFileObservationIndex:()=>index,
  invalidateSimpleSftpCapabilityAfterFailure(){},invalidateProjectFileIndexes:async()=>{},refreshProjectFileIndexesBeforeOperation:async()=>{}};
 const run=vm.runInNewContext(ts.transpileModule('class Host{'+method+'};Host.prototype.simpleSftpApiCall',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
  {workspaceRoot:()=>storage,assertRetryRequestCurrent(){},errorMessage:e=>e.message,sftpFileIndexQuery,fileOperationIndexPaths,
   ...require('../_helpers/nativeHostScope'),callSftpWithProgress:async(name,params)=>{calls.push({name,params});return onRead({index,h,calls,identity,storage});}});
 return {index,h,calls,identity,storage,read:(name='files.cleanup.inspect',extra={})=>run.call(h,name,{node:{kind:'remote',id:'synthetic-worker',root:'/synthetic/project'},target:{relativePath:'work/raml-job5',type:'directory'},allowMissing:true,presenceOnly:true,...extra})};
}
test('isolation overlap invalidates a read; the next inspect obtains real absence in the new generation',async()=>{
 const f=await fixture(async({index,calls})=>{if(calls.length===1)await index.invalidate('synthetic isolate',['work/raml-job5']);return {ok:true,target:{relativePath:'work/raml-job5',missing:calls.length>1}};});
 assert.equal((await f.read()).target.missing,true);assert.equal(f.calls.length,2);
 assert.ok(f.calls.every(c=>c.name==='files.cleanup.inspect'));
 assert.equal(f.index.snapshot().entries['work/raml-job5'].presence,'absent');
});
test('an invalidated absence is discarded; a rebuilt source is reported present by a second actual read',async()=>{
 const f=await fixture(async({index,calls})=>{if(calls.length===1)await index.invalidate('source recreated',['work/raml-job5']);return {ok:true,target:{missing:calls.length===1,absolutePath:'/synthetic/project/work/raml-job5'}};});
 assert.equal((await f.read()).target.missing,false);assert.equal(f.calls.length,2);
 assert.equal(f.index.snapshot().entries['work/raml-job5'].presence,'present');
});
test('persistent overlapping changes fail closed after exactly three real reads',async()=>{
 const f=await fixture(async({index})=>{await index.invalidate('overlap',['work/raml-job5']);return {ok:true,target:{missing:true}};});
 await assert.rejects(f.read(),/FILE_INDEX_INVALIDATED_DURING_READ/);assert.equal(f.calls.length,3);
 assert.notEqual(f.index.snapshot().entries['work/raml-job5']?.presence,'absent');
});
for(const name of ['files.cleanup.preview','files.cleanup.execute'])test(name+' is never replayed after an index-like failure',async()=>{
 const f=await fixture(async()=>{throw Error('FILE_INDEX_INVALIDATED_DURING_READ');});
 await assert.rejects(f.read(name),/FILE_INDEX_INVALIDATED_DURING_READ/);assert.equal(f.calls.length,1);
});
test('a changed client prevents a second read',async()=>{
 const f=await fixture(async({index,h})=>{await index.invalidate('overlap',['work/raml-job5']);h.client={};return {ok:true,target:{missing:true}};});
 await assert.rejects(f.read(),/FILE_INDEX_INVALIDATED_DURING_READ/);assert.equal(f.calls.length,1);
});
test('a replaced index owner remains an identity failure, never a reusable absence',async()=>{
 const f=await fixture(async({identity,storage})=>{new ProjectFileIndex({...identity,connection:'two'},storage);return {ok:true,target:{missing:true}};});
 await assert.rejects(f.read(),/FILE_INDEX_CONNECTION_REPLACED/);assert.equal(f.calls.length,1);
});
test('cancelled reads do not retry or publish missing facts',async()=>{
 const controller=new AbortController(),f=await fixture(async()=>{controller.abort(Error('user cancelled'));return {ok:true,target:{missing:true}};});
 await assert.rejects(f.read('files.cleanup.inspect',{signal:controller.signal}),/user cancelled/);assert.equal(f.calls.length,1);
 assert.notEqual(f.index.snapshot().entries['work/raml-job5']?.presence,'absent');
});
