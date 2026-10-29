const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
require('../_helpers/registerTsRequire');
const {RUNTIME_LOG_DIAGNOSTICS_PYTHON}=require('../../src/runtime/RuntimeLogDiagnostics.ts');
const {TMUX_TASK_LIFECYCLE_PYTHON}=require('../../src/runtime/TmuxTaskLifecycle.ts');
const R=require('../../src/features/RuntimeDiagnostics.ts');
test('original log analysis handles complete exceptions, early errors, phases, chunked Unicode and reconnect without historical contamination',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'simpleex-log-parser-')),file=path.join(root,'functions.py');
 fs.writeFileSync(file,RUNTIME_LOG_DIAGNOSTICS_PYTHON,'utf8');
 const lifecycle=path.join(root,'lifecycle.py');fs.writeFileSync(lifecycle,TMUX_TASK_LIFECYCLE_PYTHON,'utf8');
 const result=spawnSync('python',['-X','utf8',path.resolve(__dirname,'runtimeLogDiagnostics.fixture.py'),file,lifecycle],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(result.status,0,result.stderr||result.stdout);assert.equal(JSON.parse(result.stdout).ok,true);
});
test('runtime health needs complete log evidence for this exact execution and never changes numerical metrics',()=>{
 const base={schemaVersion:1,commandId:'c',runId:'c',state:'clear',count:0,scanComplete:true};
 assert.equal(R.completionState(base,'c'),'verified');
 assert.equal(R.completionState({...base,state:'anomalous',count:1},'c'),'review_required');
 for(const row of [undefined,{...base,commandId:'old'},{...base,scanComplete:false},{...base,state:'scanning'}])assert.equal(R.completionState(row,'c'),'unverified');
 assert.match(R.completionLabel({...base,state:'anomalous',count:1},'c'),/完成但有异常/);
});
