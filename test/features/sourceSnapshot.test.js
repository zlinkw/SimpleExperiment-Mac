const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('complete actual source-snapshot AST binds membership and integrity without executing backup or treating generated copies as inputs',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-snapshot-input-')),input=path.join(root,'input.json');
 const map=process.platform==='win32'?file=>file.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,drive)=>'/mnt/'+drive.toLowerCase()):file=>file;
 fs.writeFileSync(input,JSON.stringify({runtime:map(process.env.SIMPLE_SCOPE_RUNTIME||path.resolve('src/runtime/PlanCodeScope.ts')),agent:map(process.env.SIMPLE_SCOPE_AGENT||path.resolve('src/clusterAgentRuntime.legacy.ts')),protocol:map(path.join(__dirname,'sourceSnapshot.protocol.py'))}),'utf8');
 const fixture=path.join(__dirname,'sourceSnapshot.fixture.py'),args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','/usr/bin/python3','-B','-X','utf8',map(fixture),map(input)]:['-B','-X','utf8',fixture,input];
 const r=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4*1024*1024});
 assert.equal(r.status,0,r.stderr||r.stdout||String(r.error));const report=JSON.parse(r.stdout);assert.equal(report.noProjectExecution,true);assert.equal(report.wholeBackupCovered,true);assert.ok(report.cases.length>0);console.log(JSON.stringify(report));
});
