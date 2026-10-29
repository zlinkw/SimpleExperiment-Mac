const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
require('../_helpers/registerTsRequire');
const P=require('../../src/core/ProjectConnectionProfiles.ts');
const {currentWindowSftpDiscovery}=require('../../src/core/SimpleSftpWindow.ts');
const memo=(initial={})=>{const values=structuredClone(initial),writes=[];return {values,writes,get:key=>values[key],update:async(key,value)=>{writes.push(key);values[key]=structuredClone(value);}};};
test('project connections migrate once and stay isolated across other windows, reloads and folder changes',async()=>{
 const global=memo({setup:{worker:'A'},tunnel:{port:1234}}),local=memo({'simpleExperimentMac.localApiPort':12345}),a={globalState:global,workspaceState:local};
 assert.deepEqual(P.readProjectConnectionValue(a,'C:/project-A','setup'),{worker:'A'});
 await P.saveProjectConnectionValues(a,'C:/project-A',{setup:{worker:'own-A'}});
 global.values.setup={worker:'OTHER-WINDOW'};
 const reloaded={globalState:global,workspaceState:local};
 assert.deepEqual(P.readProjectConnectionValue(reloaded,'C:/project-A','setup'),{worker:'own-A'});
 assert.equal(P.readProjectConnectionValue(reloaded,'C:/project-B','setup'),undefined,'folder switch cannot import the old project global template');
 const b={globalState:global,workspaceState:memo()};assert.equal(P.readProjectConnectionValue(b,'C:/new-project','setup'),undefined);
 await P.saveProjectConnectionValues(b,'C:/new-project',{setup:{worker:'B'}});
 assert.deepEqual(P.readProjectConnectionValue(a,'C:/project-A','setup'),{worker:'own-A'});
 assert.equal(P.readProjectConnectionValue(b,'','setup'),undefined);
 await assert.rejects(P.saveProjectConnectionValues(b,'',{setup:{worker:'bad'}}),/PROJECT_CONNECTION_REQUIRED/);
 assert.equal(global.writes.length,0,'project panel and migration never rewrite global connections');
});
test('same-window SFTP exports ignore a foreign global default and reject wrong PID/project or missing project',async()=>{
 let legacy=0,activated=0;const root='C:/project-A',descriptor={pid:process.pid,workspace:root,baseUrl:'http://127.0.0.1:1234'};
 const registry={getExtension:()=>({isActive:false,activate:async()=>{activated++;return {getLocalApiDiscovery:async()=>descriptor};}})};
 const readLegacy=async()=>{legacy++;return {pid:process.pid+1,workspace:'C:/other'};};
 assert.equal(await currentWindowSftpDiscovery(registry,root,readLegacy),descriptor);assert.equal(activated,1);assert.equal(legacy,0);
 descriptor.workspace='C:/other';await assert.rejects(currentWindowSftpDiscovery(registry,root,readLegacy),/WORKSPACE_MISMATCH/);
 descriptor.workspace=root;descriptor.pid++;await assert.rejects(currentWindowSftpDiscovery(registry,root,readLegacy),/WINDOW_MISMATCH/);
 await assert.rejects(currentWindowSftpDiscovery(registry,'',readLegacy),/PROJECT_REQUIRED/);
});
test('real Experiment APIs refuse cross-window and changed-workspace RPCs before invoking handlers',async()=>{
 const {LocalApiServer}=require('../../dist/api/LocalApiServer');let workspace=path.join(os.tmpdir(),'scope-A'),calls=0;
 const api=new LocalApiServer({name:'SimpleExperiment',version:'fixture',preferredPort:23990,workspace,getWorkspace:()=>workspace,methods:{mark:()=>++calls}});
 await api.start();const d=api.discovery();
 const rpc=async(root,instance=d.instanceId)=>{
  const response=await fetch(d.baseUrl+'/api/v1/rpc',{method:'POST',headers:{Authorization:'Bearer '+d.token,'Content-Type':'application/json','X-Simple-Api-Instance':instance,'X-Simple-Api-Workspace':encodeURIComponent(root)},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'mark',params:{}})});
  return response.json();
 };
 try{
  assert.equal((await rpc(workspace)).result,1);
  assert.match((await rpc(workspace,'other-window')).error.message,/INSTANCE_MISMATCH/);
  const original=workspace;workspace=path.join(os.tmpdir(),'scope-B');
  assert.match((await rpc(original)).error.message,/WORKSPACE_MISMATCH/);assert.equal(calls,1);
  assert.equal(api.capabilities().workspace,workspace);
 }finally{await api.dispose();}
});
test('CLI default cannot mutate a foreign window, and explicit workspace routing ignores the overwritten alias',async()=>{
 const {LocalApiServer}=require('../../dist/api/LocalApiServer'),{callPluginRpc}=require('../../dist/cli/LocalApiClient');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'simple-window-scope-')),dir=path.join(root,'SimpleExperimentMac');fs.mkdirSync(dir);
 const names=['APPDATA','SIMPLE_EXPERIMENT_MAC_API_FILE','SIMPLE_CLI_INSTANCE_ID'],saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 process.env.APPDATA=root;delete process.env.SIMPLE_EXPERIMENT_MAC_API_FILE;delete process.env.SIMPLE_CLI_INSTANCE_ID;
 let callsA=0,callsB=0;const a=new LocalApiServer({name:'SimpleExperiment',version:'fixture',preferredPort:23991,workspace:path.join(root,'A'),discoveryPath:path.join(dir,'api.json'),methods:{mark:()=>++callsA}});
 const b=new LocalApiServer({name:'SimpleExperiment',version:'fixture',preferredPort:23992,workspace:path.join(root,'B'),discoveryPath:path.join(dir,'api.json'),methods:{mark:()=>++callsB}});
 try{
  await a.start();await b.start();
  await assert.rejects(callPluginRpc('experiment','mark',{}),/WORKSPACE_MISMATCH/);assert.equal(callsA+callsB,0);
  assert.equal(await callPluginRpc('experiment','mark',{},undefined,{workspace:path.join(root,'A')}),1);
  assert.equal(callsA,1);assert.equal(callsB,0);
  await a.dispose();const alias=JSON.parse(fs.readFileSync(path.join(dir,'api.json'),'utf8'));assert.equal(alias.instanceId,b.discovery().instanceId);
 }finally{await a.dispose();await b.dispose();for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
});
