const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const source=fs.readFileSync('src/extension/legacy.ts','utf8'),ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true);
function method(name,context){let node;function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)===name)node=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(node);return vm.runInNewContext(ts.transpileModule('class H{'+node.getText(ast)+'};H.prototype.'+name,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);}
test('read-only tunnel probes preserve current clients and in-flight task observations even with one offline Worker',async()=>{
 const original={};let resets=0,connects=0;
 const host={projectContextGeneration:1,client:original,isRealtimeMode:()=>true,effectiveConnectionMode:()=> 'xshell',syncXshellConfigBeforeNetwork:async()=>{},assertTopologyReady:()=>({}),expectedWorkerAgentProjectRoot:()=>'/project',resetClient(){resets++;this.client={};},ensureRealtimeConnected:async()=>connects++,stampWorkerProbeGeneration:(_,p)=>p,postState(){},setupConfig:{},tunnelConfig:{}};
 // Resolve the production probe dependency, rather than replace the method under test.
 const sandbox={TunnelOnlyPolicy_1:{assertTunnelOnlyMode(){}},TunnelHealth_1:{classifyTunnelHealth:()=>({})},XshellTunnelSetup_1:{xshellExecutablePath:()=>''},XshellTunnelPortProbe_1:{probeWorkerTelemetryTunnel:async c=>({status:c.id==='b'?'agent_unreachable':'ok'})},enforceExpectedAgentProjectRoot:p=>p,noHubWorkerHealth:()=>({state:'worker_unavailable'}),AGENT_READY_HEALTH_STATES:new Set(['agent_ok']),errorMessage:e=>e.message};
 host.tunnelLaunchItems=()=>[{id:'a',role:'worker',config:{id:'a'}},{id:'b',role:'worker',config:{id:'b'}}];
 await method('testTunnel',sandbox).call(host,false);
 assert.equal(resets,0);assert.equal(host.client,original);assert.equal(connects,1);assert.equal(host.lastWorkerProbes.b.status,'agent_unreachable');
});

test('coalescing cannot substitute result metadata for a control or declaration query',async()=>{
 require('../_helpers/registerTsRequire');
 const {RealtimeTunnelClient}=require('../../src/tunnel/RealtimeTunnelClient.ts'),{RequestBudget}=require('../../src/tunnel/RequestBudget.ts');
 const c=new RealtimeTunnelClient({id:'w',role:'worker',localHost:'localhost',localPort:1},new RequestBudget());const reads=[];
 c.http.getWorkerTasks=async options=>{reads.push(options);return options;};
 try {
  const q={queries:[{commandId:'c'}],selectedOnly:true};
  const values=await Promise.all([c.getWorkerTasks({...q,observationOnly:true}),c.getWorkerTasks(q),c.getWorkerTasks({declarations:[],declarationOnly:true}),c.getWorkerTasks({declarations:[]}),c.getWorkerTasks({...q,observationOnly:true,diagnosticsOnly:true})]);
  assert.equal(reads.length,5);assert.equal(values[0].observationOnly,true);assert.equal(values[1].observationOnly,undefined);assert.equal(values[2].declarationOnly,true);assert.equal(values[3].declarationOnly,undefined);assert.equal(values[4].diagnosticsOnly,true);
 }finally{await c.disconnect();}
});

test('explicit successful tunnel test recovers authentication fencing without resetting healthy peers',async()=>{
 const calls=[],converges=[],client={connect:async(_,options)=>calls.push(options.manual),diagnostics:()=>({endpoints:[{streamStatus:'sse'}]})};
 const host={projectContextGeneration:1,client,isRealtimeMode:()=>true,budget:{isPaused:()=>false},projectBootstrapPromise:Promise.resolve(),restoreRemotePlanOperations:async()=>{},reconcileStalePlanRunOperations:async()=>{},applyTrafficScheduling(){converges.push(1);},postState(){}};
 const fn=method('ensureRealtimeConnected',{errorMessage:e=>e.message});
 await fn.call(host,'tunnel probe ok');await fn.call(host,'tunnel test ok');assert.deepEqual(calls,[false,true]);assert.equal(host.client,client);
 assert.equal(converges.length,2,'every connection round must re-converge the traffic strategy on the fresh evidence');
});
