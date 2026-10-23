const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {scenario,resultDigest,Provider}=require('../_helpers/resultCollectionScenario');
const {__handleResultUiCommandForTest:ui}=require('../../dist/extension/legacy');
function complete(){const f=scenario();for(const [n,count] of [['a',3],['b',1],['nested/c',2]]){const p=f.addPlan(`experiments/plans/${n}.yaml`,{seeds:Array.from({length:count},(_,i)=>i+1)});p.jobs.forEach(j=>f.put(p,j.index,{workerId:j.index%2?'w2':'w1',runId:n+'-'+j.index}));}return f;}

test('every current PLAN and both Workers are actively queried before bounded memory downloads',async()=>{
 const f=complete(),r=await f.update();assert.equal(r.completed,6);assert.equal(r.included.length,3);assert.deepEqual(r.missing,[]);assert.deepEqual(r.skipped,[]);
 assert.deepEqual(f.calls.filter(c=>c.kind==='discovery').map(c=>c.options.discovery.planFile),f.plans.map(p=>p.planFile));
 assert.deepEqual(f.calls.filter(c=>c.kind==='observation').map(c=>c.id),['w1','w2']);
 const reads=f.calls.filter(c=>c.kind==='receive');assert.equal(reads.length,2);assert.deepEqual(new Set(reads.map(c=>c.params.server.id)),new Set(['w1','w2']));
 assert.ok(f.calls.findIndex(c=>c.kind==='observation')<f.calls.findIndex(c=>c.kind==='receive'));
 assert.equal(fs.existsSync(path.join(f.root,'work_dirs')),false);assert.equal(fs.existsSync(path.join(f.root,'tmp/result')),false);
});
for(const command of ['rebuildProjectResultTables','syncPendingPlanArtifacts','syncAllResultArtifacts'])test(command+' uses the current collection path and retains partial failure details',async()=>{
 const f=complete();f.offline('w2');f.host.extensionRuntimeVersionState=()=>({needsReload:false});f.host.resolveSelectedPlanFile=()=>f.plans[0].planFile;
 const r=await ui(f.host,{command,planFile:f.plans[0].planFile});assert.equal(r.notificationShown,true);assert.equal(r.current,true);
 assert.equal(r.completed,4);assert.equal(r.results.length,4);assert.ok(r.skipped.some(e=>e.includes('w2')));
 assert.equal(r.included.length,3);assert.ok(r.jobs.some(j=>j.state==='unknown'));
});
test('shared remote summaries and old ledger records never replace current CSV bytes',async()=>{
 const f=complete();f.host.client.getResultsSummary=()=>assert.fail('no shared summary');
 f.host.planSyncLedger={entries:{old:{runId:'old'}}};f.host.resultsSummary={results:[{metrics:{AUC:100}}]};
 const r=await f.update();assert.equal(r.results.length,6);assert.ok(r.results.every(row=>row.metrics.AUC===.92));
});
test('a bad declaration blocks only its PLAN while other complete PLANs remain included',async()=>{
 const f=complete();f.discovery((id,options,value)=>options.discovery.planFile.endsWith('/b.yaml')?{...value,declaredJobs:value.declaredJobs.map(j=>({...j,planHash:'stale'}))}:value);
 const r=await f.update();assert.equal(r.included.length,2);assert.equal(r.completed,5);assert.ok(r.jobs.some(j=>j.index===-1&&j.planFile.endsWith('/b.yaml')));
 assert.ok(r.skipped.some(e=>/PLAN/.test(e)));assert.equal(r.current,true);
});
test('a current declaration can collect an older verified execution without forging its source revision',async()=>{
 const f=complete(),p=f.plans[0],j=p.jobs[0];const file=j.output_dir+'/artifact_manifest.json';const m=JSON.parse(f.storage.get('w1').get(file));m.simpleExperiment.planRevision='old-execution-revision';f.storage.get('w1').set(file,Buffer.from(JSON.stringify(m)));
 const r=await f.update();const row=r.results.find(row=>row.runId==='a-0');assert.equal(row.revision,'old-execution-revision');assert.equal(r.completed,6);
});
test('registry-only and cached metadata PLANs cannot enter the current project scope',async()=>{
 const f=complete();f.host.localPlanMetadata={plans:[{planFile:'experiments/plans/ghost.yaml'}]};
 const old=path.join(f.root,'simple_cluster/results/project_table_registry.json');fs.mkdirSync(path.dirname(old),{recursive:true});fs.writeFileSync(old,'{"plans":{"ghost":{"records":[{"metrics":{"AUC":999}}]}}}');
 const bytes=fs.readFileSync(old);const r=await f.update();assert.equal(r.discovered,3);assert.equal(r.results.length,6);assert.deepEqual(fs.readFileSync(old),bytes);
 assert.ok(f.calls.filter(c=>c.kind==='discovery').every(c=>!c.options.discovery.planFile.includes('ghost')));
});
test('offline Worker rows become unknown rather than borrowing that Worker’s previous records',async()=>{
 const f=complete();await f.update();f.offline('w2');const r=await f.update();assert.equal(r.completed,4);assert.ok(r.results.every(row=>row.workerId==='w1'));assert.ok(r.jobs.some(j=>j.state==='unknown'));
});
test('nested same-named PLANs retain separate declarations, jobs and coverage',async()=>{
 const f=scenario();for(const [dir,value]of [['comparison',.6],['comparison_tuning',.9]]){const p=f.addPlan(`experiments/plans/${dir}/demo.yaml`,{seeds:[42]});f.put(p,0,{metric:value,runId:dir});}
 const r=await f.update();assert.equal(r.included.length,2);assert.equal(Object.keys(r.planCoverage).length,2);assert.deepEqual(r.results.map(row=>row.planFile),f.plans.map(p=>p.planFile));assert.deepEqual(r.results.map(row=>row.metrics.AUC),[.6,.9]);
});
test('different replicas of one declared job conflict without choosing by age or cached owner',async()=>{
 const f=scenario(),p=f.addPlan(undefined,{seeds:[42]});f.put(p,0,{workerId:'w1',runId:'one'});f.put(p,0,{workerId:'w2',runId:'two'});
 const r=await f.update();assert.equal(r.results.length,0);assert.equal(r.jobs[0].state,'conflict');assert.equal(f.calls.filter(c=>c.kind==='receive').length,0);
});
test('an unavailable original Worker permits an exact verified mirror and preserves execution provenance',async()=>{
 const f=scenario(),p=f.addPlan(undefined,{seeds:[42]}),j=f.put(p,0,{workerId:'w2',runId:'original-command'});f.offline('w1');
 f.host.distributedQueueCache={plans:[{projectId:f.root,id:'workflow',planFile:p.planFile,revision:'original-revision',codeFingerprint:'original-code',resultPathPolicy:'declared',jobs:[{index:j.index,case:j.case,seed:j.seed,outputDir:j.output_dir,collectionResultCsv:j.result_csv,commandId:'original-command',workerId:'w1',status:'completed',lifecycleProtocol:2}]}]};
 const r=await f.update();assert.equal(r.completed,1);assert.equal(r.results[0].workerId,'w2');assert.equal(r.results[0].executionWorkerId,'w1');assert.equal(r.results[0].revision,'original-revision');
});
test('a newer bound command prevents an old verified mirror from satisfying current ownership',async()=>{
 const f=scenario(),p=f.addPlan(undefined,{seeds:[42]}),j=f.put(p,0,{runId:'old-command'});
 f.host.distributedQueueCache={plans:[{projectId:f.root,id:'workflow',planFile:p.planFile,resultPathPolicy:'declared',jobs:[{index:j.index,case:j.case,seed:j.seed,outputDir:j.output_dir,collectionResultCsv:j.result_csv,commandId:'new-command',workerId:'w1',status:'queued',lifecycleProtocol:2}]}]};
 const r=await f.update();assert.equal(r.results.length,0);assert.equal(r.jobs[0].state,'conflict');assert.equal(f.calls.filter(c=>c.kind==='receive').length,0);
});
test('cancellation during discovery drains current reads and publishes nothing',async()=>{
 const f=complete();let release;f.block(new Promise(resolve=>release=resolve));const controller=new AbortController();const work=f.service.update(controller.signal);controller.abort();release();await assert.rejects(work,/取消|变化/);assert.equal(fs.existsSync(path.join(f.root,'artifacts/results/latest-results.json')),false);assert.equal(f.calls.some(c=>c.kind==='receive'),false);
});
test('connection replacement during download cannot publish downloaded data',async()=>{
 const f=complete();await f.update();const before=JSON.stringify(f.snapshot());f.receive((params,value)=>{f.workers[0].remotePath='/different/project';return value;});
 await assert.rejects(f.update(),/取消|变化/);assert.equal(JSON.stringify(f.snapshot()),before);
});
test('source PLAN changes during collection reject publication even when remote hashes match',async()=>{
 const f=complete();f.receive((params,value)=>{fs.writeFileSync(path.join(f.root,f.plans[0].planFile),'changed');return value;});await assert.rejects(f.update(),/PLAN 已变化/);assert.equal(fs.existsSync(path.join(f.root,'artifacts/results/latest-results.json')),false);
});
test('failed observations remain explicit and cannot make a good Worker appear fully complete',async()=>{
 const f=complete();f.observation((id,options,value)=>id==='w2'?{...value,queryComplete:false,error:'request budget exhausted'}:value);
 const r=await f.update();assert.equal(r.current,true);assert.equal(r.completed,4);assert.ok(r.skipped.some(e=>e.includes('request budget exhausted')));assert.ok(r.missing.length>=2);
});
