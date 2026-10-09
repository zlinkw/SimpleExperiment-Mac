const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');

test('log filter accepts arbitrary environment names and does not discard project path evidence',()=>{
  const result=spawnSync(process.env.PYTHON || 'python',['-X','utf8',path.join(__dirname,'noiseLineGeneric.fixture.py')],
    {encoding:'utf8',timeout:10000,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(result.status,0,result.stderr || result.stdout);
  assert.match(result.stdout,/generic log filter passed/);
});
