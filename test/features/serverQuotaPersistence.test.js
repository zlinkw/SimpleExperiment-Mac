const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
require('../_helpers/registerTsRequire');
const X=require('../../src/tunnel/XshellTunnelSetup.ts'),Q=require('../../src/features/GpuQuotaScheduling.ts'),M=require('../../src/features/GpuMemoryScheduling.ts');
const source=fs.readFileSync('src/extension/legacy.ts','utf8'),ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true),cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='RealtimeTunnelPanelProvider');
function fixture({events=true,interruptStorage=false}={}){
 const keys={setupConfig:'setup',tunnelConfig:'tunnel',setupConfigurationSignature:'signature'},state=new Map(),settings=new Map(),writes=[];
 let h,interrupted=false;
 const config={inspect:key=>({defaultValue:key==='tunnel.remoteTmuxSessionPrefix'?'simple':'',globalValue:settings.get(key)}),get:(key,fallback)=>settings.get(key)??fallback,
  update:async(key,value)=>{settings.set(key,value);if(events)await h.handleConfigurationChanged({affectsConfiguration:prefix=>prefix==='simpleExperiment'||prefix==='simpleExperimentMac.tunnel'});}};
 const patch=(input,key,fallback)=>Object.hasOwn(input,key)?input[key]:fallback;
 const names=['applySetupDraft','saveState','loadSetupConfig','sessionDefaultInspections','sessionDefaultConfigurationSignature','handleConfigurationChanged','saveWorkerConfigFromUi','saveWorkerConfigCore'];
 const methods=cls.members.filter(n=>names.includes(n.name?.getText(ast))).map(n=>n.getText(ast)).join('\n');
 const Host=vm.runInNewContext(ts.transpileModule('class Host{'+methods+'};Host',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
  keys,XshellTunnelSetup_1:X,GpuQuotaScheduling:Q,GpuMemoryScheduling:M,ConfigurationSettings_1:require('../../src/tunnel/ConfigurationSettings.ts'),
  TunnelGateway_1:{normalizeTunnelGatewayConfig:value=>value,xshellTunnelConnectionMode:'xshell_realtime',isRealtimeConnectionMode:()=>true},
  persistedXshellSetupConfig:value=>structuredClone(value),persistedTunnelGatewayConfig:value=>structuredClone(value),nonEmptyWorkerTunnelConfig:value=>value,
  vscode:{ConfigurationTarget:{Global:1},workspace:{getConfiguration:()=>config},window:{showInformationMessage(){},showWarningMessage(){}}},
  recordField:(message,key)=>message[key],stringField:(message,key)=>message[key],
  workspaceRoot:()=> 'C:/quota-project',
  readProjectConnectionValue:(_context,_root,key)=>structuredClone(state.get(key)),
  saveProjectConnectionValues:async(_context,_root,values)=>{for(const [key,value] of Object.entries(values)){
   if(interruptStorage&&key==='tunnel'&&!interrupted){interrupted=true;await h.handleConfigurationChanged({affectsConfiguration:prefix=>prefix==='simpleExperiment'||prefix==='simpleExperimentMac.tunnel'});}
   state.set(key,structuredClone(value));writes.push(key);
  }},
  preservedOptionalStringPatch:patch,preservedStringPatch:patch,clearableOptionalStringPatch:patch,sessionScopedOptionalStringPatch:patch,
  numberPatch:patch,forwardIndexPatch:patch,condaEnvPatch:patch,autoOrNumberRangePatch:patch,boolishPatch:patch,optionalNumberRangePatch:patch,
  sessionPathChanged:(a,b)=>a!==b,assertActualWorkRoot(){},normalizeRemoteWorkRoot:String,effectiveWorkerCondaEnv:(worker,global)=>worker.condaEnv??global,
 });
 h=new Host();h.context={globalState:{get:key=>structuredClone(state.get(key)),update:async(key,value)=>{
  if(interruptStorage&&key==='tunnel'&&!interrupted){interrupted=true;await h.handleConfigurationChanged({affectsConfiguration:prefix=>prefix==='simpleExperiment'||prefix==='simpleExperimentMac.tunnel'});}
  state.set(key,structuredClone(value));writes.push(key);}}};
 h.tunnelConfig={localPort:24000,remotePort:25000};h.setupConfig=X.normalizeXshellSetupConfig({condaEnv:'env',workerTunnels:['a','b'].map(id=>({id,workerHost:id,agentProjectDir:'/project',gpuMaxConcurrentCards:1}))});
 state.set('setup',structuredClone(h.setupConfig));state.set('tunnel',structuredClone(h.tunnelConfig));
 Object.assign(h,{lastWorkerProbes:{},isRealtimeMode:()=>true,effectiveConnectionMode:()=> 'xshell_realtime',loadTunnelConfig:()=>state.get('tunnel'),resetClient(){},postState(){},ensureRealtimeConnected:async()=>{},
  withAssignmentsFromConfigFields:value=>value,withXshellDerivedFields:value=>value,withImportedXshellFields:value=>value,ensureXshellSessionLoaded:async()=>{},showServerConfigSavedNextStep:async()=>{}});
 return {h,state,writes,reload:()=>h.loadSetupConfig()};
}
test('server cap, zero/pause and cleared/inherit survive real save, configuration callbacks and fresh reload',async()=>{
 for(const cap of [2,0,undefined]){const f=fixture(),workers=f.h.setupConfig.workerTunnels.map(w=>w.id==='a'?{...w,gpuMaxConcurrentCards:cap,gpuCardOverrides:{'0':{gpuJobsPerCard:6}}}:w);
  await f.h.applySetupDraft({workerTunnels:workers});
  for(const value of [f.h.setupConfig,f.state.get('setup'),f.reload()]){assert.equal(value.workerTunnels[0].gpuMaxConcurrentCards,cap);assert.equal(value.workerTunnels[0].gpuCardOverrides['0'].gpuJobsPerCard,6);assert.equal(value.workerTunnels[1].gpuMaxConcurrentCards,1);}
 }
});
test('storage captures one immutable settings snapshot even when an unrelated config callback interleaves the two writes',async()=>{
 const f=fixture({events:false,interruptStorage:true});f.h.setupConfig.workerTunnels[0].gpuMaxConcurrentCards=3;
 await f.h.saveState();assert.equal(f.state.get('setup').workerTunnels[0].gpuMaxConcurrentCards,3);
});
test('two Worker saves cannot overwrite one another after asynchronous session loading',async()=>{
 const f=fixture();let release,entered=0;const gate=new Promise(resolve=>release=resolve);
 f.h.ensureXshellSessionLoaded=async()=>{if(++entered===1)await gate;};
 const a=f.h.saveWorkerConfigFromUi({endpointId:'a',patch:{gpuMaxConcurrentCards:2}}),b=f.h.saveWorkerConfigFromUi({endpointId:'b',patch:{gpuMaxConcurrentCards:3}});
 try{await new Promise(setImmediate);assert.equal(entered,1,'save intents must serialize before reading the current Worker array');}
 finally{release();await Promise.all([a,b]);}
 assert.deepEqual(f.reload().workerTunnels.map(w=>w.gpuMaxConcurrentCards),[2,3]);
});
test('a failed Worker save does not block the next queued save or replace another server quota',async()=>{
 const f=fixture();let calls=0;f.h.ensureXshellSessionLoaded=async()=>{if(++calls===1)throw Error('session unreadable');};
 const a=f.h.saveWorkerConfigFromUi({endpointId:'a',patch:{gpuMaxConcurrentCards:2}}),b=f.h.saveWorkerConfigFromUi({endpointId:'b',patch:{gpuMaxConcurrentCards:0}});
 await assert.rejects(a,/session unreadable/);await b;
 assert.deepEqual(f.reload().workerTunnels.map(w=>w.gpuMaxConcurrentCards),[1,0]);assert.equal(f.h.workerConfigSavePromise,undefined);
});
