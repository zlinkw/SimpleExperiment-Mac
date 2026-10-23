const test=require('node:test'),assert=require('node:assert/strict');
const {readSource}=require('../_helpers/sourceReader'),method=require('../_helpers/legacyMethod');
const source=readSource('src/extension.ts'),route=new Function('return ({'+method(source,'postTunnelAction(')+'}).postTunnelAction;')();
function fixture(ids=['a']){
  const calls=[],host={assertActionAuthorityCurrent(){},assertPlanTopologyReady(){},enabledWorkerConfigs:()=>ids.map(id=>({id})),
    resolveWorkerEndpointId:value=>['a','b','disabled'].includes(value)?value:'',
    workerScopedActionBody:(body,id)=>({...body,workerId:id}),postWorkerTunnelAction:async(...args)=>{calls.push(args);return{status:'accepted'};}};
  return {host,calls};
}
test('generic action entry binds an explicit enabled Worker or the sole configured Worker',async()=>{
  const f=fixture();await route.call(f.host,'validate-plan',{planFile:'p.yaml'});
  assert.equal(f.calls[0][0],'a');assert.equal(f.calls[0][1],'validate-plan');assert.equal(f.calls[0][2].workerId,'a');
  const multi=fixture(['a','b']),options={title:'fixture'};await route.call(multi.host,'validate-plan',{workerId:'b'},options);
  assert.equal(multi.calls[0][0],'b');assert.equal(multi.calls[0][3],options);
});
test('explicit unknown, disabled or retired targets never fall back to another Worker',async()=>{
  for(const target of ['missing','disabled','hub']){const f=fixture();await assert.rejects(route.call(f.host,'validate-plan',{workerId:target}),/未配置或未启用/);assert.equal(f.calls.length,0);}
  const f=fixture(['a','b']);await assert.rejects(route.call(f.host,'validate-plan',{}),/请选择/);assert.equal(f.calls.length,0);
  const stale=fixture();stale.host.assertActionAuthorityCurrent=()=>{throw Error('context changed');};
  await assert.rejects(route.call(stale.host,'validate-plan',{workerId:'a'}),/context changed/);assert.equal(stale.calls.length,0);
});
test('Worker action submissions retain capability, resource and initiating-client completion guards',()=>{
  const worker=method(source,'postWorkerTunnelAction(');
  for(const pattern of [/missingWorkerActionCapabilities\(workerId, action\)/,/makeOpId\(action\)/,/schemaVersion: 1/,
    /const client = options\.authorityClient \|\| this\.client/,/const generation = options\.projectContext\?\.generation \?\? this\.projectContextGeneration/,
    /withRemoteActionResource\(workerId, action, request, \(\) => client\.postWorkerAction\(workerId, action, request\)\)/,
    /this\.localOperations\[request\.opId\] =/])assert.match(worker,pattern);
  assert.ok([...worker.matchAll(/client !== this\.client/g)].length>=2);
});
