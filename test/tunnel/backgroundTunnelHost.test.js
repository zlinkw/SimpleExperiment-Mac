const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require('typescript');
const { readSource } = require('../_helpers/sourceReader');
const legacyMethod = require('../_helpers/legacyMethod');
const source = readSource('src/extension.ts');
const transport = require('../../dist/tunnel/BackgroundSshTunnels');

function methods(names, globals = {}) {
  const code = ts.transpileModule('class Host {' + names.map(name => legacyMethod(source, name+'(')).join('\n') + '} this.Host = Host;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { ...globals }; vm.createContext(context); vm.runInContext(code, context); return context.Host.prototype;
}
const item = (id = 'w1') => ({ id, role: 'worker', config: { hubHost: id+'.example.org', hubUser:'science',hubSshPort:2222,
  localForwardHost:'localhost',localForwardPort:29001,remoteAgentHost:'worker.internal',remoteAgentPort:29201 } });

test('production manager uses TCP listening evidence and the current business gate', () => {
  let options, gates=0;
  const proto=methods(['backgroundTunnels'],{BackgroundSshTunnels_1:{...transport,BackgroundSshTunnelManager:class{constructor(value){options=value;}}},
    XshellTunnelLauncher_1:{isLocalPortAvailable:()=>{}},require:()=>({assertBusinessAllowed:()=>gates++})});
  proto.backgroundTunnels.call({});assert.equal(options.portListening,transport.backgroundPortListening);
  options.assertBusinessAllowed();assert.equal(gates,1);
});

test('per-Worker launch uses the same current-configuration confirmation as batch launch', async () => {
  const calls=[],proto=methods(['startTunnelEndpointFromUi'],{stringField:(row,key)=>row[key]});
  const host={startBackgroundTunnels:async(...args)=>calls.push(args)};
  await proto.startTunnelEndpointFromUi.call(host,{endpointId:'w1'});
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[[true,true,['w1']]]);
  await assert.rejects(proto.startTunnelEndpointFromUi.call(host,{}),/明确的 Worker/);
});

test('confirmation cannot start an endpoint changed or disabled while the modal was open', async () => {
  for(const change of ['endpoint','disabled','project']) {
    let entries=[item()],current=true,spawns=0;
    const context={signal:new AbortController().signal};
    const proto=methods(['startBackgroundTunnels'],{BackgroundSshTunnels_1:transport,UiCommandCancelled:class extends Error{},
      AgentRuntimeScope_1:{selectAgentRuntimeTargets:rows=>rows},tunnelHttpEndpoint:()=>'',
      vscode:{window:{showWarningMessage:async()=>{if(change==='endpoint')entries[0].config.hubHost='changed.example';if(change==='disabled')entries=[];if(change==='project')current=false;return '启动后台隧道';}}}});
    const host={captureProjectContext:()=>context,projectContextIsCurrent:()=>current,syncXshellConfigBeforeNetwork:async()=>{},
      currentTunnelLaunchBlockers:()=>[],tunnelLaunchItems:()=>entries,tunnelConfig:{},backgroundTunnels:()=>{spawns++;assert.fail('stale request reached manager');}};
    await assert.rejects(proto.startBackgroundTunnels.call(host),/已变化/);assert.equal(spawns,0);
  }
});

test('background start and old command aliases use the background manager without Xshell', async () => {
  const calls = [], ui = [], entries = [item()], ids = [];
  const proto = methods(['startAllXshellRealtimeTunnels','startAllXshellConnections','launchTunnelItem','startBackgroundTunnels'], {
    BackgroundSshTunnels_1: transport,
    AgentRuntimeScope_1: { selectAgentRuntimeTargets: (rows, selected) => selected.length ? rows.filter(row => selected.includes(row.id)) : rows },
    vscode: { ProgressLocation:{Notification:1}, window:{ withProgress:async(_config,work)=>work({report(){}}),showInformationMessage:message=>ui.push(message),showWarningMessage:message=>ui.push(message) } },
    tunnelHttpEndpoint:(host,port)=>host+':'+port,
  });
  const host = { ...proto, setupConfig:{autoTestTunnelAfterStart:false},tunnelConfig:{},captureProjectContext:()=>({signal:new AbortController().signal}),projectContextIsCurrent:()=>true,
    syncXshellConfigBeforeNetwork:async()=>calls.push('configured'),currentTunnelLaunchBlockers:()=>[],
    tunnelLaunchItems:()=>entries,enabledWorkerConfigs:()=>[{id:'w1'}],
    backgroundTunnels:()=>({ running:()=>[],launchAll:async endpoints=>{ ids.push(...endpoints.map(row=>row.id));return endpoints.map(row=>({id:row.id,state:'verified',message:'listening'})); } }),
    ensureRealtimeConnected:async()=>calls.push('observe'),launchUniqueXshellSessions:()=>assert.fail('background must never open Xshell') };
  Object.setPrototypeOf(host,proto);
  await proto.startAllXshellRealtimeTunnels.call(host,false);
  await proto.startAllXshellConnections.call(host,false,false);
  await proto.launchTunnelItem.call(host,entries[0]);
  assert.deepEqual(ids,['w1','w1','w1']);assert.equal(ui.length,3);assert.ok(ui.every(message=>message.includes('Agent 就绪状态以检测结果为准')));
});

test('runtime preflight uses saved SSH identities without scanning or rewriting Xshell files', async () => {
  const proto=methods(['syncXshellConfigBeforeNetwork']);const calls=[];
  const host={ refreshLocalSshConfig:async()=>calls.push('ssh'),assertSshTransportIdentities:async targets=>calls.push(targets[0].id),sftpSharedTargets:()=>[{id:'w1'}],
    refreshXshellSessionLibrary:()=>assert.fail('no automatic session read'),syncConfiguredXshellSessions:()=>assert.fail('no automatic import') };
  await proto.syncXshellConfigBeforeNetwork.call(host,'start');assert.deepEqual(calls,['ssh','w1']);
});

test('explicit Xshell opening keeps enabled session deduplication and never starts background work', async () => {
  const entries=[item('w1'),item('w2')], launched=[];entries.forEach(row=>row.config.savedSessionPath='C:/sessions/shared.xsh');
  const proto=methods(['openAllXshellSessions','launchUniqueXshellSessions'],{AgentRuntimeScope_1:{selectAgentRuntimeTargets:rows=>rows},localPathKey:value=>value.toLowerCase(),tunnelHttpEndpoint:()=>'',vscode:{window:{showInformationMessage(){}}},
    XshellTunnelSetup_1:{xshellExecutablePath:()=> 'C:/Xshell.exe'},XshellSessionLauncher_1:{launchXshellSavedSession:async request=>{launched.push(request);return{launched:true};}},waitForXshellBatchLaunchSlot:async()=>{},errorMessage:String});
  const host={setupConfig:{},refreshXshellSessionLibrary:async()=>{},tunnelLaunchItems:()=>entries,
    startBackgroundTunnels:()=>assert.fail('manual must not start background tunnels'),deployLatestAgentRuntime:()=>assert.fail('manual must not deploy')};
  Object.setPrototypeOf(host,proto);
  const results=await proto.openAllXshellSessions.call(host,false);assert.equal(results.length,2);assert.match(results[1],/跳过重复打开/);assert.equal(launched.length,1);assert.equal(launched[0].sessionPath,'C:/sessions/shared.xsh');
});

test('Agent preparation routes runtime deploy and background start without session writes', async () => {
  const calls=[];
  const proto=methods(['prepareAgentsForFirstRun'],{workspaceRoot:()=>'/project',assertSingleProjectWorkspace:()=>{},UiCommandCancelled:class extends Error{},
    agentStartupWriteConfirmationDetail:()=>'',tunnelTestCompletion:()=>({ready:true,issues:[]}),sleep:async()=>{},vscode:{ProgressLocation:{Notification:1},window:{showWarningMessage:async()=> '确认准备并启动',withProgress:async(_options,work)=>work({report(){}})}}});
  const host={ensureSimpleSftpReadyForSetup:async()=>true,syncXshellConfigBeforeNetwork:async()=>{},assertTopologyReady:()=>({}),assertTopologyActualWorkRoots(){},
    currentAgentPreparationBlockers:()=>[],agentStartupTargets:()=>[{id:'w1',filePath:''}],enabledWorkerConfigs:()=>[{id:'w1'}],assertExecutionCondaEnvReady(){},workerActionTargets:()=>[],
    sftpSharedTargets:()=>[{id:'w1'}],agentRuntimeUploadTargets:()=>[{id:'w1'}],confirmRemoteWriteTargets:async()=>calls.push('confirm'),
    writeSftpManagerServerProfiles:async()=>{calls.push('profiles');return{targetCount:1};},writeXshellAgentStartupCommands:()=>assert.fail('no session patch'),
    deployLatestAgentRuntime:async()=>{calls.push('deploy');return{targets:[],manifest:{}};},startAllXshellConnections:async()=>calls.push('background'),
    testTunnel:async()=>calls.push('detect'),verifyDeployedAgentRuntime:async()=>({fatal:[],warnings:[]}),setupConfig:{}};
  assert.equal(await proto.prepareAgentsForFirstRun.call(host,false),true);assert.deepEqual(calls,['confirm','profiles','deploy','background','detect']);
});
