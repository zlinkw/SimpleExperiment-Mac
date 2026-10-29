const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
require('../_helpers/registerTsRequire');
function productionFunction(name){const source=fs.readFileSync('src/extension/legacy.ts','utf8'),tree=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true);
 const fn=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.ok(fn,name);
 return vm.runInNewContext(ts.transpileModule(fn.getText(tree)+';'+name,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{HUB_READY_STATUSES:new Set(['ok','agent_ok'])});}
test('tunnel notification and readiness never consult retired Hub observations',()=>{
 const check=productionFunction('tunnelTestCompletion');
 const result=check({workerTunnels:[{id:'w',enabled:true}]},{status:'offline',schedulerDependencies:{ok:false,message:'old'}},{state:'offline'},{w:{status:'ok'}},true);
 assert.equal(result.ready,true);assert.doesNotMatch(result.message,/hub/i);assert.deepEqual([...result.issues],[]);
});
test('a saved Hub topology flag cannot create an endpoint, login launch or Agent launch',()=>{
 const P=require('../../src/extension/ProviderRealtime.ts');
 const deps={setupConfig:{workerTunnels:[{id:'w',enabled:true,workerHost:'worker.example',workerUser:'u',workerSshPort:22,savedSessionPath:'worker.xsh',localForwardHost:'127.0.0.1',localForwardPort:21001,remoteAgentHost:'127.0.0.1',remoteAgentPort:21002}],savedSessionPath:'old-hub.xsh'},topology:{mode:'hub_worker',hubAllowed:true},lastWorkerProbes:{},tunnelConfig:{}};
 assert.deepEqual(P.buildTunnelLaunchItems(deps).map(row=>row.id),['w']);
 assert.deepEqual(P.buildRealtimeEndpoints(deps).map(row=>row.id),['w']);
 assert.ok(P.buildAgentLaunchItems(deps).every(row=>row.role==='worker'));
});
test('bootstrap readiness ignores retired Hub flags but checks every Worker',()=>{
 const check=productionFunction('projectBootstrapEndpointReadiness');
 assert.equal(check({hubRequired:true,hubStatus:'offline',workers:[{label:'w',status:'ok'}]}).ready,true);
 assert.equal(check({hubRequired:false,hubStatus:'ok',workers:[{label:'w',status:'timeout'}]}).ready,false);
 assert.equal(check({workers:[]}).ready,false);
});
test('saved Hub endpoints remain outside the executable registry, while explicit new Hub endpoints reject',()=>{
 const {createEndpointRegistryFactory}=require('../../src/tunnel/factories/EndpointRegistry.ts');
 const endpoint={id:'w',role:'worker',localHost:'127.0.0.1',localPort:24001,remoteHost:'127.0.0.1',remotePort:24002};
 const old={...endpoint,id:'hub',role:'hub'};
 const factory=createEndpointRegistryFactory({workspaceState:{get:()=>[old,endpoint]}});
 assert.deepEqual(factory.fromWorkspace().list().map(row=>row.id),['w']);
 assert.throws(()=>factory.create([old]),/HUB_REMOVED/);
});
function panelFunction(name,globals){
 const html=require('../../dist/ui/PanelHtml').renderPanelHtml();
 const script=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(row=>row[1]).find(row=>row.includes('function '+name+'('));
 const tree=ts.createSourceFile('panel.js',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let found;
 function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node;ts.forEachChild(node,visit);}visit(tree);assert.ok(found,name);
 return vm.runInNewContext(found.getText(tree)+';'+name,globals);
}

test('rendered topology and help describe one or multiple Workers and mark old configuration retired',()=>{
 const label=panelFunction('topologyModeLabel',{}),help=panelFunction('configHelp',{});
 assert.match(label('worker_pool'),/单台或多台/);assert.doesNotMatch(help('topology','mode'),/Hub/i);
 assert.match(label('hub_worker'),/已退役/);assert.match(help('hub','hubHost'),/已退役/);
});

test('artifact actions cannot bypass missing Worker capabilities through a retired fallback',()=>{
 const run=panelFunction('rowActionDisableReason',{usableTaskKey:Boolean,directWorkerActionMap:{inspectArtifact:'inspect'},
  TASK_CONTROL_COMMANDS:new Set(),ARTIFACT_SCOPE_COMMANDS:new Set(['inspectArtifact']),
  missingWorkerActionCapabilities:()=>['inspect'],disableReason:()=>assert.fail('missing Worker capability must block')});
 assert.match(run({},'inspectArtifact',{runKey:'command',workerId:'w'}),/Worker Agent.*inspect/);
});
test('rendered Agent cards and sync readiness do not display or depend on a saved Hub',()=>{
 let rendered='';
 const render=panelFunction('renderAgentSessions',{DIAGNOSTIC_AGENT_WORKER_CARD_LIMIT:20,agentSessionCard:(role,name)=>role+':'+name,
  setHtmlIfChanged:(_,html)=>rendered=html,diagnosticBudgetNotice:()=>''});
 render({agentSessions:{hub:{configured:true,startupCommand:'obsolete'},workers:[{id:'w'}]}});
 assert.match(rendered,/Worker:w/);assert.doesNotMatch(rendered,/Hub|obsolete/);
 const check=panelFunction('overviewSyncReadiness',{enabledWorkerTunnelsForState:state=>state.setup.workerTunnels,
  syncStatusOk:value=>String(value||'').startsWith('已同步'),syncStatusFailure:value=>String(value||'').includes('失败'),hasText:value=>Boolean(value)});
 assert.equal(check({setup:{workerTunnels:[{id:'w'}]},codeSync:{hub:'失败',workers:'已同步 1 台',fingerprint:'code'}}).ready,true);
 assert.equal(check({setup:{workerTunnels:[{id:'w'}]},codeSync:{hub:'已同步',workers:'失败',fingerprint:'code'}}).ready,false);
});
test('new event parsing accepts Worker telemetry, and settings no longer offer a Hub mode',()=>{
 const {validateAgentEvent}=require('../../src/agent/AgentEvent.ts');
 assert.equal(validateAgentEvent({schemaVersion:1,seq:1,type:'agent_heartbeat',generatedAt:'now',source:'worker_telemetry',workerId:'w',payload:{}}).ok,true);
 const props=require('../../package.json').contributes.configuration.properties;
 assert.equal(props['simpleExperimentMac.tunnel.workerRealtimeMode'],undefined);
 assert.ok(props['simpleExperimentMac.tunnel.workerTunnels'].items.properties.workerHost);
 assert.equal(props['simpleExperimentMac.tunnel.workerTunnels'].items.properties.hubHost,undefined);
});
