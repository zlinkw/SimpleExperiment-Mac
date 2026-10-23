const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const {spawnSync} = require('node:child_process');
test('upload overwrite policy rejects content/presence races and preserves original files', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8', path.join(__dirname,'uploadOverwritePolicy.fixture.py'), path.resolve(__dirname,'../../dist/runtime/cluster_agent.py')],
    {encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr || result.stdout || String(result.error));
  const report=JSON.parse(result.stdout.trim()); assert.equal(report.ok,true);
  console.log('kept upload policy fixture at '+report.root);
});
