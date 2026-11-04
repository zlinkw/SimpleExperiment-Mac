const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),runtime=process.env.SIMPLE_DEPENDENCY_RUNTIME_ROOT||path.join(root,'dist/runtime'),sftp=process.env.SIMPLE_SFTP_REPO||path.resolve(root,'../SimpleSFTP-Mac');
const mounted=file=>file.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,drive)=>'/mnt/'+drive.toLowerCase());
// A separate clean interpreter is necessary: normal test hosts already have PyYAML,
// which hid the deployment defect. No full Agent/Scheduler module is executed.
for(const platform of process.platform==='win32'?['windows','linux-worker']:['linux-worker'])test('offline managed PyYAML deployment and source preflight in clean Python: '+platform,()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-dependency-test-')),input=path.join(directory,'input.json');
 const fixture=path.join(__dirname,'agentRuntimeDependencies.fixture.py');
 const map=platform==='linux-worker'&&process.platform==='win32'?mounted:value=>value;
 fs.writeFileSync(input,JSON.stringify({agent:map(path.join(runtime,'cluster_agent.py')),scheduler:map(path.join(runtime,'cluster_scheduler.py')),lifecycle:map(path.join(sftp,'agent-lifecycle.py')),oldAgent:process.env.SIMPLE_DEPENDENCY_OLD_AGENT?map(process.env.SIMPLE_DEPENDENCY_OLD_AGENT):null,scopeFixture:map(path.join(__dirname,'planCodeScope.fixture.py'))}),'utf8');
 const argv=platform==='linux-worker'&&process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','/usr/bin/python3','-I','-S','-B',map(fixture),map(input)]:['-I','-S','-B',fixture,input];
 const run=spawnSync(platform==='linux-worker'&&process.platform==='win32'?'wsl.exe':process.env.PYTHON||'python',argv,{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4*1024*1024});
 assert.equal(run.status,0,run.stderr||run.stdout||String(run.error));const report=JSON.parse(run.stdout.trim());
 for(const key of ['fresh','upgrade','repair','failureBeforeStop','sameInterpreter','safeLoad','sourcePreflight','noTrainingOrProjectMutation'])assert.equal(report[key],true,key);
 assert.equal(report.yamlVersion,'6.0.3');console.log(JSON.stringify({platform,...report}));
});
