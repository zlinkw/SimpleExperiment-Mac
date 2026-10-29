const test=require('node:test'),assert=require('node:assert/strict');
const {parseArgv}=require('../../dist/cli/parse');
test('manual dispatch CLI preserves exact workflow, selected jobs, Worker and busy GPU authorization',()=>{
 const p=parseArgv(['task','dispatch','--workflow','original','--jobs','0,2','--worker','gpu-server','--gpu','0','--confirm','--stop-running']);
 assert.deepEqual(p.positionals,['task','dispatch']);assert.equal(p.flags.gpu,'0');assert.equal(p.flags.jobs,'0,2');assert.equal(p.flags.worker,'gpu-server');assert.equal(p.flags.workflow,'original');assert.equal(p.flags.confirm,true);assert.equal(p.flags['stop-running'],true);
});
test('CLI auto GPU requests Worker-restricted allocation without a fake GPU identifier',async()=>{
 const api=require('../../dist/cli/api'),format=require('../../dist/cli/format'),{runSimpleCli}=require('../../dist/cli/index');
 const old=[api.optionalApi,api.callApi,format.writeJson],calls=[];
 api.optionalApi=async()=>undefined;api.callApi=async(method,params)=>{calls.push({method,params});return {status:'submitted'}};format.writeJson=()=>{};
 try{await runSimpleCli(['task','dispatch','--workflow','p','--jobs','0,2','--worker','w','--gpu','auto','--confirm']);
  assert.equal(calls[0].params.gpuSelection,'automatic');assert.equal(calls[0].params.gpuId,undefined);assert.equal(calls[0].params.workerId,'w');
 }finally{[api.optionalApi,api.callApi,format.writeJson]=old;}
});
test('CLI cannot infer job zero from absent or malformed selection',async()=>{
 const api=require('../../dist/cli/api'),format=require('../../dist/cli/format'),{runSimpleCli}=require('../../dist/cli/index');
 const old=[api.optionalApi,api.callApi,format.writeJson];let calls=0;
 api.optionalApi=async()=>undefined;api.callApi=async()=>{calls++;return {status:'submitted'}};format.writeJson=()=>{};
 try{
  for(const extra of [[],['--jobs',''],['--jobs','1,'],['--jobs','false']])await assert.rejects(runSimpleCli(['task','dispatch','--workflow','w','--worker','a','--gpu','0','--confirm',...extra]),/jobs|索引/);
  assert.equal(calls,0);
  await runSimpleCli(['task','dispatch','--workflow','w','--worker','a','--gpu','0','--confirm','--jobs','0,2']);assert.equal(calls,1);
 }finally{[api.optionalApi,api.callApi,format.writeJson]=old;}
});
test('remaining queue CLI passes an explicit frozen scope without a Worker picker',async()=>{
 const api=require('../../dist/cli/api'),format=require('../../dist/cli/format'),{runSimpleCli}=require('../../dist/cli/index');
 const old=[api.optionalApi,api.callApi,format.writeJson],calls=[];
 api.optionalApi=async()=>undefined;api.callApi=async(method,params)=>{calls.push({method,params});return {status:'submitted'}};format.writeJson=()=>{};
 try{await assert.rejects(runSimpleCli(['task','dispatch','--remaining','--confirm']),/workflow|all/);assert.equal(calls.length,0);
  await runSimpleCli(['task','dispatch','--remaining','--all','--confirm']);
  await runSimpleCli(['task','dispatch','--remaining','--workflow','p','--confirm']);
  assert.equal(calls.length,2);assert.equal(calls[0].method,'tasks.dispatch');assert.equal(calls[0].params.distribution,'quota_remaining');assert.equal(calls[0].params.all,true);assert.equal(calls[1].params.workflowId,'p');
 }finally{[api.optionalApi,api.callApi,format.writeJson]=old;}
});
