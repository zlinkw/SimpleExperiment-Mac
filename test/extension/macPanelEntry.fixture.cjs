// Package-level VS Code API isolation. The Provider constructor is real.
// Only the OS probe, VS Code host API and external/background services are substituted.
// This runs on the executing host and is not native macOS acceptance.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module');
const [root,scenario]=process.argv.slice(2),pkg=require(path.join(root,'package.json'));
const commands=new Map(),views=new Map(),logs=[],errors=[],writes=[];
const disposable=()=>({dispose(){}}),event=()=>disposable();
class EventEmitter{constructor(){this.event=event;}fire(){}dispose(){}}
const retained={servers:[{id:'retained-server',host:'example.invalid',remotePath:'/srv/研究 项目'}],plans:['experiments/plans/原计划.yaml'],history:['retained-history']};
const saved={
 'simpleExperimentMac.xshellRealtimeTunnelConfig':{workerTunnels:[{id:'retained-server',enabled:false,workerHost:'example.invalid',workerUser:'fixture',agentProjectDir:'/srv/研究 项目'}]},
 'simpleExperimentMac.executionHistoryHiddenOperationIds':['retained-operation'],
 'fixture.retained':retained,
};
const settings=scenario.startsWith('upgrade')?{projectAdapterRules:{planDatasetMapping:{'experiments/plans/原计划.yaml':{datasets:['原始 数据集']}}}}:{};
function state(){const data=new Map(scenario.startsWith('upgrade')?Object.entries(JSON.parse(JSON.stringify(saved))):[]);return {data,get:(key,otherwise)=>data.has(key)?data.get(key):otherwise,update:async(key,value)=>{writes.push(key);data.set(key,value);},keys:()=>[...data.keys()],setKeysForSync(){}};}
const config={get:(key,otherwise)=>key in settings?settings[key]:otherwise,inspect:()=>undefined,update:async()=>{throw Error('unexpected configuration write');}};
const context={extensionPath:root,extensionUri:{fsPath:root},extension:{id:pkg.publisher+'.'+pkg.name,extensionPath:root,packageJSON:pkg},globalState:state(),workspaceState:state(),subscriptions:[],globalStorageUri:{fsPath:path.join(process.cwd(),'private-storage')},logUri:{fsPath:path.join(process.cwd(),'private-logs')},secrets:{get:async()=>undefined,store:async()=>{throw Error('unexpected secret write');}}};
if(scenario==='constructor-failure')context.workspaceState.get=()=>{throw Error('fixture stored-state read failed');};
// VS Code exposes a frozen context. A mutable object misses Proxy get invariants.
Object.freeze(context.globalState);Object.freeze(context.workspaceState);Object.freeze(context);
const output={appendLine:line=>logs.push(String(line)),dispose(){}};
let currentView;
function makeView(){return {viewType:'simpleExperimentMac.panel',visible:true,webview:{options:{},html:'',onDidReceiveMessage:event,postMessage:async()=>true},onDidChangeVisibility:event,onDidDispose:event};}
const vscode={version:'1.100.0',EventEmitter,Uri:{file:fsPath=>({scheme:'file',fsPath,path:fsPath,toString(){return 'file://'+fsPath;}})},
 workspace:{workspaceFolders:undefined,getConfiguration:()=>config,onDidChangeConfiguration:event,onDidChangeWorkspaceFolders:event,createFileSystemWatcher:()=>({onDidCreate:event,onDidChange:event,onDidDelete:event,dispose(){}})},
 extensions:{getExtension:id=>id===context.extension.id?context.extension:undefined,onDidChange:event},
 window:{showErrorMessage:async message=>{errors.push(String(message));},showWarningMessage:async()=>{},showInformationMessage:async()=>{},createOutputChannel:()=>output,
  createStatusBarItem:()=>({show(){},dispose(){}}),registerWebviewViewProvider(id,provider){if(views.has(id))throw Error('duplicate view registration: '+id);views.set(id,provider);return {dispose(){views.delete(id);}};}},
 commands:{async executeCommand(id){if(id==='simpleExperimentMac.panel.focus'){const resolver=views.get('simpleExperimentMac.panel');if(!resolver)throw Error('view not registered');currentView||=makeView();await resolver.resolveWebviewView(currentView);return;}const fn=commands.get(id);if(!fn)throw Error("command '"+id+"' not found");return fn();},
  registerCommand(id,fn){if(scenario==='registration-api-failure'&&id==='simpleExperimentMac.quickSetup')throw Error('fixture registration API failure');if(commands.has(id))throw Error('duplicate command: '+id);commands.set(id,fn);return {dispose(){commands.delete(id);}};}},
 ProgressLocation:{Notification:1},StatusBarAlignment:{Right:2},env:{appName:'Code',appHost:'desktop',sessionId:'fixture'},UIKind:{Desktop:1},ExtensionMode:{Production:1}};
const original=Module._load;
let Provider,realConstructorReached=false,bootstrap,beforeBusiness=[];
Module._load=function(id,...args){return id==='vscode'?vscode:original.call(this,id,...args);};
const baseRequire=Module.createRequire(path.join(root,'dist/mac/Bootstrap.js'));
function isolatedRequire(id){
 if(id==='node:child_process')return {spawnSync:()=>({status:0,stdout:'26.0\n'})};
 if(id==='./CliLauncher')return {registerMacCli:(...args)=>({...baseRequire(id).registerMacCli(...args),refresh(){}})};
 if(id==='../platform/MacReleaseClient')return {...baseRequire(id),MacReleaseClient:class{async check(){throw Error('fixture update source offline');}}};
 if(id==='../extension'){
  beforeBusiness=[...commands.keys()];
  if(scenario==='import-failure')throw Error('fixture business import failed');
  const legacy=baseRequire('../extension/legacy');Provider=legacy.RealtimeTunnelPanelProvider;
  // These post-construction services are outside opening the local panel; no network is used.
  Provider.prototype.startLocalApiServer=async()=>{throw Error('fixture background API offline');};
  Provider.prototype.runActivationOnboarding=async()=>{};
  Provider.prototype.reconcileStalePlanRunOperations=async()=>{};
  Provider.prototype.ensureRemoteAgentVersionConsistent=async()=>{};
  Provider.prototype.refreshXshellSessionLibrary=async()=>[];
  const load=Provider.prototype.loadTunnelConfig;
  Provider.prototype.loadTunnelConfig=function(...args){realConstructorReached=true;return load.apply(this,args);};
  if(scenario==='unrelated-command-failure')Provider.prototype.stopMacSystemTunnels=undefined;
  return baseRequire(id);
 }
 return baseRequire(id);
}
async function tick(){await new Promise(resolve=>setImmediate(resolve));}
(async()=>{
 const module={exports:{}},code=fs.readFileSync(path.join(root,'dist/mac/Bootstrap.js'),'utf8');
 // The declared macOS entry's OS branch is injected only in this VM; the real host is reported below.
 const run=vm.runInThisContext('(function(require,module,exports,process,setImmediate,clearImmediate){'+code+'\n})',{filename:path.join(root,'dist/mac/Bootstrap.js')});
 run(isolatedRequire,module,module.exports,{...process,platform:'darwin',arch:'arm64'},setImmediate,clearImmediate);bootstrap=module.exports;
 await bootstrap.activate(context);
 const registeredBeforeBusiness=commands.has('simpleExperimentMac.openPanel');
 if(scenario==='pending-startup'){
  await vscode.commands.executeCommand('simpleExperimentMac.openPanel');
  console.log(JSON.stringify({host:process.platform,scenario,registeredBeforeBusiness,realConstructorReached,html:currentView?.webview.html,logs,errors,retained:context.globalState.data.get('fixture.retained'),writes}));
  return;
 }
 for(let i=0;i<4;i++)await tick();
 // Exercise both command-palette navigation and the actual registered sidebar resolver.
 let commandError;
 try{await vscode.commands.executeCommand('simpleExperimentMac.openPanel');}catch(error){commandError=error.message;}
 const commandHtml=currentView?.webview.html||'';
 const sidebar=makeView();
 const resolver=views.get('simpleExperimentMac.panel');if(resolver)await resolver.resolveWebviewView(sidebar);
 for(let i=0;i<2;i++)await tick();
 console.log(JSON.stringify({host:process.platform,scenario,registeredBeforeBusiness,realConstructorReached,commandError,commandHtml,sidebarHtml:sidebar.webview.html,logs,errors,retained:context.globalState.data.get('fixture.retained'),savedGlobal:Object.fromEntries(Object.keys(saved).map(key=>[key,context.globalState.data.get(key)])),savedWorkspace:Object.fromEntries(Object.keys(saved).map(key=>[key,context.workspaceState.data.get(key)])),settings,writes,beforeBusiness,registered:[...commands.keys()],declared:pkg.contributes.commands.map(row=>row.command)}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
 try{await bootstrap?.deactivate();}finally{for(const item of context.subscriptions.reverse())item.dispose?.();Module._load=original;}
});
