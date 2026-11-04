const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),{spawnSync}=require('node:child_process');
require('../_helpers/registerTsRequire');
const packageRoot=process.env.SIMPLE_SCOPE_PACKAGE_ROOT;
const load=file=>require(packageRoot?path.join(packageRoot,'dist',file):path.resolve('src',file+'.ts'));
const {waitForPlanCodeScopeOperation:wait}=load('features/PlanCodeScopeOperation');
const query={projectId:'p',planFile:'plans/中文 空格.yaml',planRevision:'real-revision',codeFingerprint:'real-fingerprint'};
const state=(patch={})=>({operationId:'op',type:'plan-code-scope',readOnly:true,remoteExecution:'not_started',...query,sourceDigest:'',status:'running',progressSequence:1,progress:{phase:'dependencyAnalysisMs'},timings:{dependencyAnalysisMs:12},...patch});
const result={ok:true,compatible:true,readOnly:true,...query,executionSource:{manifest:{},digest:'actual-digest'}};
function ports(observe){let time=0,submitted=0,terminal=0;return{operationId:'op',query,submit:async()=>{submitted++;return state();},observe,terminal:()=>terminal++,now:()=>time,pause:async()=>{time+=5000;},get submitted(){return submitted;},get ended(){return terminal;},get elapsed(){return time;}};}
test('real processing evidence permits a long operation; status reads are not progress',async()=>{
 let reads=0;const p=ports(async()=>state({progressSequence:++reads,status:reads===8?'completed':'running',result}));
 const answer=await wait(p);assert.equal(p.submitted,1);assert.equal(p.ended,1);assert.ok(p.elapsed>20000);assert.equal(answer.sourceOperation.timings.dependencyAnalysisMs,12);assert.equal(answer.sourceOperation.remoteExecution,'not_started');
 const idle=ports(async()=>state());await assert.rejects(wait(idle),error=>/PLAN_SOURCE_VERIFICATION_PENDING.*未提交训练/.test(error.message)&&error.operationId==='op'&&error.progress.phase==='dependencyAnalysisMs');assert.equal(idle.elapsed,20000);assert.equal(idle.ended,0);assert.equal(idle.submitted,1);
});
test('lost acknowledgements and failed status queries never cause another submission',async()=>{
 const p=ports(async()=>state({status:'completed',result}));p.submit=async()=>{throw Error('ack lost');};assert.equal((await wait(p)).ok,true);
 const lost=ports(async()=>{throw Error('offline');});await assert.rejects(wait(lost),/PLAN_SOURCE_VERIFICATION_PENDING.*未提交训练/);assert.equal(lost.submitted,1);assert.equal(lost.ended,0);
});
test('failures, identity mismatches, missing progress and changed source bindings remain visible',async()=>{
 for(const patch of [{planRevision:'wrong'},{operationId:'other'},{sourceDigest:'changed'},{progressSequence:undefined}])await assert.rejects(wait(ports(async()=>state(patch))),/PLAN_SOURCE_OPERATION_(IDENTITY_MISMATCH|PROGRESS_INVALID)/);
 const p=ports(async()=>state({status:'failed',error:'PLAN_ASSET_DIGEST_MISMATCH: weight.bin'}));await assert.rejects(wait(p),/PLAN_ASSET_DIGEST_MISMATCH.*未提交训练/);assert.equal(p.ended,1);
 const bad=ports(async()=>{throw Error('must not observe');});bad.submit=async()=>{throw Object.assign(Error('HTTP 400 invalid input'),{httpStatus:400});};await assert.rejects(wait(bad),/HTTP 400/);assert.equal(bad.ended,1);
});
test('old matching synchronous responses remain checked, not treated as async progress',async()=>{
 const p=ports(async()=>{throw Error('must not query');});p.submit=async()=>result;assert.equal((await wait(p)).sourceOperation.legacySynchronous,true);
});
test('actual HTTP sender resumes the same read-only operation after an unavailable status response',async t=>{
 const {HttpTunnelClient}=load('tunnel/TunnelClient');const http=require('node:http');let submits=0,reads=0,operationId,received,offline=true;
 const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'){submits++;let raw='';for await(const data of req)raw+=data;received=JSON.parse(raw);operationId=received.operationId;res.destroy();return;}
  reads++;assert.equal(req.url,'/api/operations/'+operationId);
  if(offline){res.writeHead(503);res.end('status unavailable');return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(state({operationId,status:'completed',result})));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const {RequestBudget,defaultRequestBudgetConfig}=load('tunnel/RequestBudget');
 const client=new HttpTunnelClient({localHost:'127.0.0.1',localPort:server.address().port},new RequestBudget(defaultRequestBudgetConfig));
 const request=structuredClone(query),pending=client.getPlanCodeScope(request);request.planRevision='mutated after call';
 await assert.rejects(pending,/PLAN_SOURCE_VERIFICATION_PENDING.*未提交训练/);assert.equal(submits,1);assert.equal(received.planRevision,query.planRevision);assert.ok(reads>=1);
 offline=false;assert.equal((await client.getPlanCodeScope(query)).ok,true);assert.equal(submits,1,'recovery only queries the original operation');
 await client.getPlanCodeScope(query);assert.equal(submits,2,'a completed result cannot cache a future verification');
});
test('isolated actual Agent operation and HTTP branches retain identity, progress, timings and failures',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'plan-operation-')),config=path.join(directory,'input.json');
 const map=process.platform==='win32'?file=>file.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,drive)=>'/mnt/'+drive.toLowerCase()):file=>file;
 fs.writeFileSync(config,JSON.stringify({agent:map(process.env.SIMPLE_SCOPE_AGENT||path.resolve('dist/runtime/cluster_agent.py'))}),'utf8');
 const fixture=path.join(__dirname,'planCodeScopeOperation.fixture.py'),args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','/usr/bin/python3','-B','-X','utf8',map(fixture),map(config)]:['-B','-X','utf8',fixture,config];
 const r=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:4*1024*1024});
 assert.equal(r.status,0,r.stderr||r.stdout||String(r.error));const report=JSON.parse(r.stdout);assert.ok(report.cases>=10);assert.equal(report.noTraining,true);console.log(JSON.stringify(report));
});
