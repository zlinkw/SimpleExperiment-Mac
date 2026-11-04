const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=process.env.SIMPLE_STARTUP_PACKAGE_ROOT||path.resolve(__dirname,'../..');
function run(scenario){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'mac-panel-entry-'));
 const r=spawnSync(process.execPath,[path.join(__dirname,'macPanelEntry.fixture.cjs'),root,scenario],{cwd,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:16*1024*1024,
  env:{...process.env,SIMPLE_EXPERIMENT_MAC_API_FILE:path.join(cwd,'no-live-api.json'),SIMPLE_SFTP_MAC_API_FILE:path.join(cwd,'no-live-sftp.json')}});
 assert.equal(r.status,0,r.stderr||r.stdout);
 const lines=r.stdout.trim().split('\n');return JSON.parse(lines.at(-1));
}
test('panel command and sidebar exist before any business imports or initialization',()=>{
 const r=run('pending-startup');assert.equal(r.registeredBeforeBusiness,true);assert.equal(r.realConstructorReached,false);assert.match(r.html,/正在启动/);assert.match(r.html,/Loaded extension: simple-local.simple-experiment-mac/);
});
for(const scenario of ['fresh-offline','upgrade-offline'])test('frozen VS Code context reaches real Provider and opens command/sidebar: '+scenario,()=>{
 const r=run(scenario);assert.equal(r.commandError,undefined);assert.equal(r.realConstructorReached,true);
 assert.match(r.commandHtml,/panelBootstrapStatus/);assert.match(r.sidebarHtml,/panelBootstrapStatus/);
 assert.ok(r.logs.some(line=>line.includes('Loaded code: '+root)));
 for(const id of r.declared)assert.ok(r.registered.includes(id),'declared command must have a real registration: '+id);
 for(const id of ['simpleExperimentMac.openPanel','simpleExperimentMac.showCliEntry','simpleExperimentMac.checkPluginUpdates'])assert.ok(r.beforeBusiness.includes(id),'independent entry must exist before business loading: '+id);
 if(scenario.startsWith('upgrade')){
  assert.deepEqual(r.retained,{servers:[{id:'retained-server',host:'example.invalid',remotePath:'/srv/研究 项目'}],plans:['experiments/plans/原计划.yaml'],history:['retained-history']});
  for(const state of [r.savedGlobal,r.savedWorkspace]){
   assert.deepEqual(state['simpleExperimentMac.executionHistoryHiddenOperationIds'],['retained-operation']);
   assert.equal(state['simpleExperimentMac.xshellRealtimeTunnelConfig'].workerTunnels[0].agentProjectDir,'/srv/研究 项目');
  }
  assert.deepEqual(r.settings.projectAdapterRules.planDatasetMapping,{'experiments/plans/原计划.yaml':{datasets:['原始 数据集']}});
 }
});
for(const [scenario,message] of [['constructor-failure','fixture stored-state read failed'],['import-failure','fixture business import failed']])test('failure still opens diagnostics with original stack: '+scenario,()=>{
 const r=run(scenario);assert.equal(r.commandError,undefined);assert.match(r.commandHtml,/启动失败/);assert.ok(r.commandHtml.includes(message));assert.ok(r.sidebarHtml.includes(message));assert.ok(r.logs.some(line=>line.includes(message)&&line.includes('at ')));
});
test('one unrelated missing handler cannot erase panel navigation or its failure message',()=>{
 const r=run('unrelated-command-failure');assert.equal(r.commandError,undefined);assert.match(r.commandHtml,/panelBootstrapStatus/);assert.ok(r.errors.some(line=>line.includes('stopMacSystemTunnels')));assert.ok(r.registered.includes('simpleExperimentMac.openPanel'));
});
test('command API rollback preserves the independent panel entry and actual failure message',()=>{
 const r=run('registration-api-failure');assert.equal(r.commandError,undefined);assert.match(r.commandHtml,/panelBootstrapStatus/);assert.ok(r.errors.some(line=>line.includes('fixture registration API failure')));assert.ok(r.registered.includes('simpleExperimentMac.openPanel'));assert.ok(!r.registered.includes('simpleExperimentMac.quickSetup'));
});
