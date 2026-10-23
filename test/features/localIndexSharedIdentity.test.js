const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
// Keep real lease I/O inside this test process's temporary home, never the installed extension's state.
process.env.LOCALAPPDATA=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'local-index-shared-home-'));
require('../_helpers/registerTsRequire');
const {projectFileIndex}=require('../../src/features/ProjectFileIndex.ts');
const {hashLocalCodeFiles,localCodeManifestCachePath}=require('../../src/features/LocalCodeManifestCache.ts');

// 真实故障（2026-10-21 15:26–15:27 批次）：legacy 本地观测索引与 LocalCodeManifestCache 的
// local.code-manifest 上报对同一存储文件（endpointId+projectRoot 相同）构造了两套本地 identity，
// 两个实例交替抢占 owners；批量提交时并发的代码哈希把另一路在途本地观测读打成
// FILE_INDEX_CONNECTION_REPLACED（edrl 整体失败、ebmc 本机两个 job 预览被阻断）。
// 本回归用真实入口复现：legacy 方法原文从源码提取（仅机械去掉 TS 可选符，不改逻辑）驱动
// 真实 ProjectFileIndex，并发方为真实的 hashLocalCodeFiles 缓存上报路径。

function extractMethodBody(source,name){
  const at=source.indexOf(name+'(source?) {');
  if(at<0) throw Error('METHOD_NOT_FOUND '+name);
  let i=source.indexOf('{',at),depth=0,end=-1;
  for(let j=i;j<source.length;j++){if(source[j]==='{')depth++;else if(source[j]==='}'){depth-=1;if(!depth){end=j;break;}}}
  if(end<0) throw Error('METHOD_UNBALANCED '+name);
  return source.slice(i+1,end);
}
function buildLegacyObservationIndex(legacySourceText){
  const body=extractMethodBody(legacySourceText,'projectFileObservationIndex');
  const factory=new Function('workspaceRoot','projectFileIndex','localFileIndexIdentity','crypto',
    'return function (source) {'+body+'};');
  // 每个沙箱 root 绑定一次真实方法；baseline 体不引用 localFileIndexIdentity，候选体引用真实导出。
  return root=>factory(()=>root,projectFileIndex,require('../../src/features/ProjectFileIndex.ts').localFileIndexIdentity,crypto);
}
function makeContext(storageRoot){
  return { fileIndexClient:undefined, fileIndexSession:undefined, projectFileIndexes:undefined, client:{tag:'a'},
    context:{ globalStorageUri:{ fsPath:storageRoot } } };
}
const legacySource=fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
const observerForRoot=buildLegacyObservationIndex(legacySource);

function freshRoot(name){
  const root=path.join(fs.realpathSync(os.tmpdir()),name+'-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(16).slice(2));
  fs.mkdirSync(root,{recursive:true});
  return root;
}

test('a real concurrent code-manifest hash never steals an in-flight legacy local observation read',async()=>{
  const root=freshRoot('v15-idx-race');
  fs.writeFileSync(path.join(root,'a.txt'),'shared identity fixture');
  const storage=path.join(root,'storage');
  const ctx=makeContext(storage);
  const observe=observerForRoot(root);
  // 真实 legacy 入口：source 为空 → 本地观测索引；读保持在途。
  const legacyIndex=observe.call(ctx,undefined);
  assert.equal(legacyIndex.identity.endpointId,'local');
  let releaseGate;const gate=new Promise(resolve=>{releaseGate=resolve;});
  const reading=legacyIndex.read({ method:'local.metadata', paths:['a.txt'], metadataOnly:true },async()=>{
    await gate; return { files:{ 'a.txt':{ exists:true,size:1 } } };
  });
  // 真实 manifest 入口：带 code-manifest-cache 缓存路径的哈希构建，末尾上报 local.code-manifest 读。
  await hashLocalCodeFiles(root,['a.txt'],localCodeManifestCachePath(storage,root));
  releaseGate();
  // 基线在此 reject：FILE_INDEX_CONNECTION_REPLACED（owners 被并发实例夺走）。
  await reading;
  // 两条入口必须共享同一实例，否则上面就已抛错。
  assert.equal(observe.call(ctx,undefined),legacyIndex);
});

test('a genuine remote connection replacement still rejects in-flight reads on the old index',async()=>{
  const root=freshRoot('v15-idx-remote');
  const storage=path.join(root,'storage');
  const ctx=makeContext(storage);
  const observe=observerForRoot(root);
  const source={ id:'w1',host:'h1.example',port:22,user:'u',remotePath:'/srv/proj' };
  const indexA=observe.call(ctx,source);
  let releaseGate;const gate=new Promise(resolve=>{releaseGate=resolve;});
  const reading=indexA.read({ method:'sync.projectTree', relativePath:'work_dirs', recursive:true },async()=>{
    await gate; return { entries:[] };
  });
  // 健康检查重建 client：fileIndexSession 轮转 → 远端连接身份真实替换，旧读必须作废。
  ctx.client={ tag:'b' };
  const indexB=observe.call(ctx,source);
  assert.notEqual(indexB,indexA,'远端连接替换必须新建观测实例（语义保持）');
  releaseGate();
  await assert.rejects(reading,/FILE_INDEX_CONNECTION_REPLACED/);
});

test('both local observation entry points join through the shared identity helper',()=>{
  const manifest=fs.readFileSync(path.resolve(__dirname,'../../src/features/LocalCodeManifestCache.ts'),'utf8');
  assert.match(legacySource,/const identity = source \? \{ workspace: root, endpointId, projectRoot, connection, endpointBinding \} : localFileIndexIdentity\(root\);/);
  assert.match(manifest,/projectFileIndex\(localFileIndexIdentity\(root\), path\.dirname\(path\.dirname\(cacheFile\)\)\)/);
  // 旧的裸字面量本地身份必须移除，防止再次漂移。
  assert.ok(!manifest.includes('connection: "local:" + process.pid }'));
});
