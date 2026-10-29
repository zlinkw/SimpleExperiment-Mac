const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const legacyMethod=require('../_helpers/legacyMethod'),{readSource}=require('../_helpers/sourceReader');
const {changedManifestFiles,inventoryFilesByPath}=require('../../dist/features/CodeSyncDelta');
const source=readSource('src/extension.ts'),manifest={'train.py':{sha256:'aa',size:1}},fp=m=>JSON.stringify(m);
function fixture(options={}){
 const calls=[],code=ts.transpileModule('class Host{'+legacyMethod(source,'checkRunCodeWithoutUploadLocal(')+'};this.Host=Host;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const context={changedManifestFiles,inventoryFilesByPath,PlanCodeScopeHost:{codeInventoryBatches:m=>[Object.keys(m)],runSourceManifest:m=>m},
  buildLocalCodeManifest:async()=>({manifest:options.localChange?{'train.py':{sha256:'changed'}}:manifest}),filterHeldFiles:b=>b.manifest,fingerprintFromManifest:fp};
 vm.runInNewContext(code,context);
 const targets=['a','b'].map(id=>({id,role:'worker'})),host={lastWorkerProbes:{a:{status:'ok'},b:{status:'ok'}},
 resolveCodeUploadTargetIdentityLocal:t=>({key:t.id}),pendingCodeUploadUnknownWriteLocal:()=>options.unknown,
 verifyCodeUploadTargetQuiescentLocal:async t=>{calls.push('writer:'+t.id);return{quiescent:!options.writer};},
 verifiedSftpProjectInventory:async q=>{calls.push('inventory:'+q.source.id);if(options.queryFailure)throw Error('query failed');return{files:options.changed&&q.source.id==='b'?{}:manifest};},
 sftpServerOptions:t=>({id:t.id}),codeSyncWarmProofKey:t=>t.id,codeSyncAgentProofs:new Map([['a',{old:true}],['b',{old:true}]]),
 safeWorkerCodeSyncTargets:async targets=>targets,
 ensureWorkerCodeSyncProof:async t=>{calls.push('proof:'+t.id);return options.missingProof?undefined:{proofId:t.id,manifestDigest:fp(manifest),runtimeGeneration:'current'};},
 localMachineStateGuard:()=>({}),localCodeManifestCacheFile:()=>'',
 simpleSftpApiCall:()=>assert.fail('read check must never upload'),takeoverCodeUploadTargetLocal:()=>assert.fail('read check must never cancel or take ownership')};
 return{host,targets,calls,run:()=>context.Host.prototype.checkRunCodeWithoutUploadLocal.call(host,targets,'/project',manifest,fp(manifest),[],[],{},()=>{},()=>{})};
}
test('matching current Worker content checks every target and registers current proofs without upload or takeover',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.inventoryCalls,2);assert.deepEqual(Object.keys(r.workerVersions),['a','b']);
 assert.equal(r.workerVersions.a.codeSyncProofRuntimeGeneration,'current');assert.equal(f.host.codeSyncAgentProofs.size,0);
 assert.ok(f.calls.indexOf('inventory:b')<f.calls.indexOf('proof:a'));
});
test('changed/missing code uses the existing protected upload flow; no partial readiness is published',async()=>{
 const f=fixture({changed:true});assert.equal(await f.run(),undefined);assert.ok(!f.calls.some(c=>c.startsWith('proof:')));
});
test('unresolved or active writes cannot pass the no-upload check',async()=>{
 for(const options of [{unknown:true},{writer:true}]){const f=fixture(options);assert.equal(await f.run(),undefined);assert.ok(!f.calls.some(c=>c.startsWith('proof:')));}
});
test('a cold probe without a current runtime proof cannot enter the no-upload readiness path',async()=>{
 assert.equal(await fixture({missingProof:true}).run(),undefined);
});
test('remote query failure and local edits cannot become a no-change pass',async()=>{
 await assert.rejects(fixture({queryFailure:true}).run(),/query failed/);await assert.rejects(fixture({localChange:true}).run(),/代码在检查期间已变化/);
});
test('the complete production sync entry skips path confirmation, write leases and upload for unchanged current code',async()=>{
 const {createRealSyncHost}=require('../_helpers/realCodeUploadHost');
 const host=createRealSyncHost({remote:{files:{'src/train.py':{size:4,sha256:require('node:crypto').createHash('sha256').update('same').digest('hex')}}}});
 host.ensureWorkerCodeSyncProof=async(_target,_root,fingerprint)=>({proofId:'fresh',manifestDigest:fingerprint,runtimeGeneration:'current'});
 host.acquireCodeUploadTargetLeaseLocal=()=>assert.fail('no write lease on the current-content fast path');
 host.takeoverCodeUploadTargetLocal=()=>assert.fail('no transfer takeover on the current-content fast path');
 const ready=[];
 await host.syncCodeTargets(host.targets,'run',{hashCompare:true,onTargetReady:id=>ready.push(id)});
 assert.equal(host.confirmations.length,0);assert.equal(host.profiles.length,0);assert.equal(host.uploads.length,0);
 assert.deepEqual(ready,host.targets.map(t=>t.id));assert.equal(host.lastCodeSyncStats.uploads,0);
 assert.match(host.lastCodeSyncState.workers,/代码一致/);
});
