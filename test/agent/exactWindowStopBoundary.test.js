const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('stop routes fence the original command and close immutable windows without PID or session fallback',()=>{
  for(const group of ['bridge','session']) {
  const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',path.join(__dirname,'exactWindowStopBoundary.fixture.py'),group],
    {encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  assert.match(result.stdout,/exact stop boundaries ok/);
  }
});
