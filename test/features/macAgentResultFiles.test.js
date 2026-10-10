const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const vm=require('node:vm'),ts=require('typescript'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
function candidates(receipt,plan){
 const source=fs.readFileSync(path.join(root,'dist/extension/legacy.js'),'utf8'),ast=ts.createSourceFile('actual.js',source,ts.ScriptTarget.Latest,true),funcs=new Map();
 (function visit(node){if(ts.isFunctionDeclaration(node)&&node.name)funcs.set(node.name.text,node.getText(ast));ts.forEachChild(node,visit);})(ast);
 const names=['remoteResultInspectionCandidates','remoteResultOperationPayloads','operationResultPlanFile','normalizePlanSelectionKey','planFileEquivalenceKeys',
  'samePlanSelection','uniqueStrings','stringFromRecord','planVersionTimestamp','normalizeRemoteResultInspectionPath','usableSelectionKey'];
 const context=vm.createContext({process:{platform:'darwin'},Buffer,Date,Map,Set,
  MacResultOperationScope:require('../../dist/mac/ResultOperationScope'),PosixPath_1:require('../../dist/mac/PosixPath'),
  FileTransferTypes_1:require('../../dist/tunnel/FileTransferTypes'),WrapperResultBundle:require('../../dist/results/WrapperResultBundle')});
 vm.runInContext(names.map(name=>{assert.ok(funcs.has(name),name);return funcs.get(name)}).join('\n')+'\nthis.candidates=remoteResultInspectionCandidates;',context);
 return JSON.parse(JSON.stringify(context.candidates([[receipt]],plan,'r1')));
}
for(const scenario of ['paths','yaml','jobs','glob','formats','snapshots','limits'])test('actual Agent raw result declarations and descriptor parser: '+scenario,()=>{
 const directory=path.join(root,'release-artifacts','Agent 结果文件 '+scenario+' '+crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
 const result=spawnSync(process.env.PYTHON||'python',['-B','-X','utf8',path.join(__dirname,'macAgentResultFiles.fixture.py'),scenario,
  path.join(root,'dist/runtime/cluster_agent.py'),directory],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(result.status,0,result.stderr||result.error?.message);const out=JSON.parse(result.stdout);
 assert.equal(out.scenario,scenario);assert.equal(out.passed,true);assert.equal(out.remoteOperations,0);
 if(['paths','formats'].includes(scenario))for(const row of out.rows)
  assert.deepEqual(candidates(row.receipt,row.plan),scenario==='paths'?[row.source]:[]);
 if(['yaml','jobs','glob'].includes(scenario))assert.deepEqual(candidates(out.receipt,out.plan),out.sources);
 if(['snapshots','limits'].includes(scenario)){assert.equal(out.events,0);assert.equal(out.writes,0);}
});
