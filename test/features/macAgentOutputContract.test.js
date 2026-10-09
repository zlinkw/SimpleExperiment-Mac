const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const vm=require('node:vm'), ts=require('typescript'), crypto=require('node:crypto'), {spawnSync}=require('node:child_process');
const {createRequire}=require('node:module'), root=path.resolve(__dirname,'../..');
function candidates(rows,plan,revision='r1') {
  const source=fs.readFileSync(path.join(root,'dist/extension/legacy.js'),'utf8'), ast=ts.createSourceFile('actual.js',source,ts.ScriptTarget.Latest,true), funcs=new Map();
  (function visit(node){if(ts.isFunctionDeclaration(node)&&node.name)funcs.set(node.name.text,node.getText(ast));ts.forEachChild(node,visit);})(ast);
  const names=['remoteResultInspectionCandidates','remoteResultOperationPayloads','operationResultPlanFile','normalizePlanSelectionKey',
    'planFileEquivalenceKeys','samePlanSelection','uniqueStrings','stringFromRecord','planVersionTimestamp','normalizeRemoteResultInspectionPath','usableSelectionKey'];
  const context=vm.createContext({process:{platform:'darwin'},Buffer,Date,Map,Set,
    MacResultOperationScope:require('../../dist/mac/ResultOperationScope'),PosixPath_1:require('../../dist/mac/PosixPath'),
    FileTransferTypes_1:require('../../dist/tunnel/FileTransferTypes'),WrapperResultBundle:require('../../dist/results/WrapperResultBundle')});
  vm.runInContext(names.map(name=>{assert.ok(funcs.has(name),name);return funcs.get(name);}).join('\n')+'\nthis.candidates=remoteResultInspectionCandidates;',context);
  return JSON.parse(JSON.stringify(context.candidates([rows],plan,revision)));
}
for(const scenario of ['identity','invalid','physical','jobs','keys','formats','report'])test('isolated actual Agent output contract and compiled Mac candidates: '+scenario,()=>{
  const directory=path.join(root,'release-artifacts','Agent 回执 '+scenario+' '+crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
  const result=spawnSync(process.env.PYTHON||'python',['-B','-X','utf8',path.join(__dirname,'macAgentOutputContract.fixture.py'),scenario,
    path.join(root,'dist/runtime/cluster_agent.py'),directory],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.error?.message);const out=JSON.parse(result.stdout);
  assert.equal(out.scenario,scenario);assert.equal(out.passed,true);assert.equal(out.remoteOperations,0);
  if(scenario==='identity')for(const row of out.rows){assert.deepEqual(candidates([row.receipt],row.plan),['outputs/demo/bad.json']);
    assert.deepEqual(candidates([row.event],row.plan),['outputs/demo/bad.json']);
    const reducer=require('../../dist/tunnel/RealtimeEventReducer');let state=reducer.createRealtimeState();
    for(const [index,event]of [{type:'operation_started',payload:{action:'check-output-contract',...row.started}},row.event].entries())
      state=reducer.applyRealtimeEvent(state,{schemaVersion:1,seq:index+1,source:'hub_agent',generatedAt:'2026-10-10T00:00:00Z',operationId:'operation',...event});
    assert.deepEqual(candidates(state.operations,row.plan),['outputs/demo/bad.json']);}
  if(scenario==='physical'||scenario==='jobs')assert.deepEqual(candidates([out.receipt],out.plan),out.receipt.unparseableFiles);
  if(scenario==='keys'){
    const file=path.join(root,'dist/results/ResultLayout.js'),module={exports:{}};
    vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:createRequire(file),process:{platform:'darwin'},Buffer},{filename:file});
    assert.deepEqual(out.paths,out.plans.map(plan=>'simple_cluster/contracts/contract_check_reports/by_plan/'+module.exports.planDirectoryKey(plan)+'/latest.json'));
  }
  if(scenario==='formats')for(const row of out.rows)assert.deepEqual(candidates([row.receipt],row.plan),[]);
  if(scenario==='invalid'||scenario==='report'){assert.equal(out.events,0);assert.equal(out.writes,0);}
  const agent=fs.readFileSync(path.join(root,'dist/runtime/cluster_agent.py'),'utf8');
  assert.match(agent,/if action == "check-output-contract":\s+return output_contract_receipt\(root, payload, operation_id, op_id\)/);
  assert.match(agent,/started_fields = action_receipt_fields\(action, payload\)/);
});
