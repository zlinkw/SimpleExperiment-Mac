const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('actual scope separates imported modules and main entries, and verifies explicitly pinned shared assets',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'plan-assets-input-')),input=path.join(directory,'input.json');
 const mounted=file=>file.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,drive)=>'/mnt/'+drive.toLowerCase());
 const map=process.platform==='win32'?mounted:value=>value;
 fs.writeFileSync(input,JSON.stringify({source:map(process.env.SIMPLE_SCOPE_RUNTIME||path.resolve('src/runtime/PlanCodeScope.ts'))}),'utf8');
 const fixture=path.join(__dirname,'planExternalAssets.fixture.py'),args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','/usr/bin/python3','-B','-X','utf8',map(fixture),map(input)]:['-B','-X','utf8',fixture,input];
 const result=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:4*1024*1024});
 assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));const report=JSON.parse(result.stdout);assert.equal(report.unrelatedMainExcluded,true);assert.equal(report.noTraining,true);
 require('../_helpers/registerTsRequire');
 const packageRoot=process.env.SIMPLE_ASSET_PACKAGE_ROOT;
 const H=require(packageRoot?path.join(packageRoot,'dist/extension/PlanCodeScopeHost'):path.resolve('src/extension/PlanCodeScopeHost.ts'));
 const B=require(packageRoot?path.join(packageRoot,'dist/project/BranchHeadBinding'):path.resolve('src/project/BranchHeadBinding.ts'));
 const response=report.response,source=response.executionSource;
 assert.equal(H.planExecutionSourceDigest(source.manifest,source.assets),source.digest,'Python/desktop digest must bind identical asset facts');
 const local=fs.mkdtempSync(path.join(os.tmpdir(),'plan-assets-local-'));
 for(const[file,text]of Object.entries(report.localFiles)){const target=path.join(local,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text,'utf8');}
 await H.verifyLocalPlanSource(local,source);assert.equal(fs.existsSync(path.join(local,'artifacts')),false,'local source check must not fetch/copy/read remote weights');
 const plan={projectId:response.projectId,planFile:response.planFile,revision:response.planRevision,codeFingerprint:response.codeFingerprint};
 const host={workerActionTargets:()=>[{id:'worker-a'},{id:'worker-b'}],lastWorkerProbes:{'worker-a':{status:'ok',capabilities:{endpoints:{planCodeScope:1}}},'worker-b':{status:'ok',capabilities:{endpoints:{planCodeScope:1}}}},client:{getWorkerPlanCodeScope:async()=>response}};
 assert.deepEqual(await H.resolvePlanExecutionSource(host,plan),source);
 assert.deepEqual(await H.verifyWorkerPlanSource(host,'worker-b',plan),source);
 host.client.getWorkerPlanCodeScope=async()=>{throw Error('PLAN_ASSET_DIGEST_MISMATCH: actual-worker');};
 await assert.rejects(H.verifyWorkerPlanSource(host,'worker-b',plan),/actual-worker/);
 const bad=structuredClone(source);Object.values(bad.assets)[0].target+='.changed';
 assert.notEqual(H.planExecutionSourceDigest(bad.manifest,bad.assets),source.digest);
 await assert.rejects(H.verifyLocalPlanSource(local,bad),/BASELINE_INVALID/);
 const binding=await B.bindPlanSourceToCommit({runner:async()=>{throw Error('bad digest must not read Git');},cwd:local,headCommit:'a'.repeat(40),executionSource:bad,planFile:plan.planFile,revision:plan.revision});
 assert.equal(binding.ok,false);
 const files=Object.entries(report.localFiles).sort(([a],[b])=>a.localeCompare(b)).map(([file,text],index)=>({file,bytes:Buffer.from(text,'utf8'),oid:(index+1).toString(16).padStart(40,'0')}));
 const gitReads=[];
 const bound=await B.bindPlanSourceToCommit({cwd:local,headCommit:'a'.repeat(40),executionSource:source,planFile:plan.planFile,revision:plan.revision,runner:async(args,_cwd,input)=>{
   gitReads.push({args,input});
   const stdout=args[0]==='rev-parse'?Buffer.from('a'.repeat(40)+'\n'):args[0]==='ls-tree'?Buffer.from(files.map(file=>`100644 blob ${file.oid}\t${file.file}\0`).join('')):Buffer.concat(input.trim().split('\n').map(oid=>{const file=files.find(file=>file.oid===oid);return Buffer.concat([Buffer.from(`${oid} blob ${file.bytes.length}\n`),file.bytes,Buffer.from('\n')]);}));
   return {code:0,stdout,stderr:''};
 }});
 assert.equal(bound.ok,true);assert.equal(bound.coveredFiles,files.length);assert.ok(!JSON.stringify(gitReads).includes('model_cache'),'Git binding must cover code blobs, never pretend remote weights are in HEAD');
 console.log(JSON.stringify({unrelatedMainExcluded:report.unrelatedMainExcluded,assetCases:report.assetCases,desktopDigestMatches:true,localSourceOnly:true,multipleWorkersPreserveFailure:true,noTraining:report.noTraining}));
});
