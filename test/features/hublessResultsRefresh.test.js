const assert=require('node:assert/strict'),test=require('node:test'),vm=require('node:vm');
require('../_helpers/registerTsRequire');
const {readSource}=require('../_helpers/sourceReader');
const {fixture,planFile}=require('../_helpers/freshResultHost');
const {resultCollectionHost}=require('../../src/extension/ResultCollectionHost.ts');
const method=require('../_helpers/legacyMethod')(readSource('src/extension/legacy.ts'),'apiResultsList(');
const ts=require('typescript');
const code=ts.transpileModule('globalThis.api=({'+method+'}).apiResultsList;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const sandbox={
  resultCollectionHost,stringField:(value,key)=>String(value?.[key]||''),samePlanSelection:(a,b)=>a===b};
vm.runInNewContext(code,sandbox);const api=sandbox.api;

test('results.list actively queries declared Worker artifacts and scopes the requested Plan',async()=>{
  const f=fixture();f.host.planFileInput='plans/another-selected-plan.yaml';
  const result=await api.call(f.host,{planFile});
  assert.equal(result.source,'active_query');assert.equal(result.planFile,planFile);
  assert.equal(result.results.length,1);assert.equal(result.results[0].planFile,planFile);
  assert.ok(f.calls.some(row=>row[0]==='tasks'));assert.ok(f.calls.some(row=>row[0]==='sync.downloadMappedPaths'));
  const other=await api.call(f.host,{planFile:'plans/absent.yaml'});assert.equal(other.results.length,0);
});
test('a disconnected Worker produces an explicit partial result and cannot revive cached metrics',async()=>{
  const f=fixture();const online=f.host.workerCodeSyncTargets()[0],query=f.host.client.getWorkerTasks;
  f.host.workerCodeSyncTargets=()=>[online,{...online,id:'offline',host:'unreachable-fixture'}];
  f.host.client.getWorkerTasks=async(id,options)=>{if(id==='offline')throw Error('fixture offline');return query(id,options);};
  const report=await api.call(f.host,{planFile});assert.equal(report.results.length,1);
  assert.ok(report.summary.skipped.some(error=>String(error).includes('fixture offline')),JSON.stringify(report.summary.skipped));
  f.offline(true);const empty=await api.call(f.host,{planFile});assert.equal(empty.results.length,0);
  assert.ok(empty.summary.skipped.length>0);assert.equal(empty.source,'active_query');
});
