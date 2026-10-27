const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('../_helpers/registerTsRequire');
const {replacementLifecycleJob} = require('../../src/features/PlanOutputReplacement.ts');
const source = fs.readFileSync(path.join(__dirname, '../../src/extension/legacy.ts'), 'utf8');
test('normal Windows run delegates to the same exact-target confirmation service as explicit retry and manual placement', async () => {
  const ts=require('typescript'), ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);let member;
  function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)==='confirmDeclaredPlanOutputs')member=n;ts.forEachChild(n,visit);}visit(ast);
  const calls=[],root='fixture';class PlanRunHost {constructor(h,r){assert.equal(r,root);} async replace(...args){calls.push(args);return 'continued';}}
  const method=vm.runInNewContext(ts.transpileModule('class Host {'+member.getText(ast)+'};Host.prototype.confirmDeclaredPlanOutputs',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{PlanRunHost,workspaceRoot:()=>root});
  const plan={},body={},validation={jobs:[]};assert.equal(await method.call({},plan,body,validation),'continued');assert.deepEqual(calls,[[plan,body,validation]]);
});

test('rerun selection uses pulled lifecycle evidence rather than cached Worker status or a copied complete result', () => {
  const text = fs.readFileSync(path.join(__dirname, '../../src/extension/PlanRunHost.ts'), 'utf8');
  const start = text.indexOf('    const completed = new Set<number>();'), end = text.indexOf('    const key = runReplacementKey', start);
  const ts=require('typescript'), lifecycle=require('../../src/features/TaskLifecycle.ts');
  const select=vm.runInNewContext(ts.transpileModule('(function(body,jobs){'+text.slice(start,end)+';return [...completed];})',
    {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,lifecycle);
  const job={index:0,case:'a',seed:42,output_dir:'work/a',result_csv:'tmp/a.csv'};
  const observation={lifecycleProtocol:2,commandId:'c',projectId:'p',workerId:'w',tmux:{dead:true,exitCode:null},
    result:{runId:'c',status:'completed',present:true,verified:true}};
  const task={commandId:'c',projectId:'p',outputDir:job.output_dir,collectionResultCsv:job.result_csv,case:'a',seed:42,status:'failed',observation};
  const snapshot={workerId:'w',tasks:[task],declaredResults:[]};
  const run=()=>Array.from(select({workerSubmissionSnapshots:[snapshot]},[job]));
  assert.deepEqual(run(),[0]);
  snapshot.declaredResults=[{...job,outputDir:job.output_dir,collectionResultCsv:job.result_csv,runId:'c',completed:true}];
  observation.tmux.exitCode=7;assert.deepEqual(run(),[]);
  observation.tmux.dead=false;observation.tmux.exitCode=null;assert.deepEqual(run(),[]);
  observation.tmux.dead=true;observation.queryError='offline';assert.deepEqual(run(),[]);
  delete observation.queryError;delete observation.tmux;assert.deepEqual(run(),[0]);
  snapshot.declaredResults=[];observation.result.runId='old';task.status='completed';assert.deepEqual(run(),[]);
});
test('replacement fence persists before deletion and prevents re-mirroring after partial failure', async () => {
  const text = fs.readFileSync(path.join(__dirname, '../../src/extension/PlanCleanupHost.ts'), 'utf8');
  const method = text.slice(text.indexOf('  async execute(id: string)'), text.indexOf('  open(file: string'));
  const ts = require('typescript');
  const compiled = ts.transpileModule('class Host {' + method + '}; Host;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const Host = vm.runInNewContext(compiled, { replacementLifecycleJob, cleanupError: code => { throw Error(code); } });
  const queue = { plans: [{ id: 'run', jobs: [{ index: 0, commandId: 'c', status: 'completed' }, { index: 1, commandId: 'other', status: 'completed' }] }] };
  let saved;
  const instance = new Host(); instance.root = 'fixture'; instance.drainReconnects = async () => {};
  instance.ensureOperationRecordsMigrated = async () => {}; // r17：切片只验证围栏/队列语义；迁移由 projectStatePaths 契约单独覆盖
  instance.host = { loadDistributedQueue: async () => structuredClone(queue), saveDistributedQueue: async (_, data) => { saved = structuredClone(data); },
    withHostOperationLease: async (_, __, work) => work() };
  instance.service = { registeredIsolationSource: async () => undefined, status: async () => ({ preview: { scope: { job: { purpose: 'replace_outputs', workflowId: 'run', index: 0, commandId: 'c' }, nodes: [{ id: 'w' }] } } }),
    history: async () => [], preflightConfirmed: async () => {}, execute: async () => { assert.ok(saved.plans[0].jobs[0].outputRetiredAt); throw Error('NETWORK_DISCONNECT'); } };
  await assert.rejects(instance.execute('op'), /NETWORK_DISCONNECT/);
  assert.equal(saved.plans[0].jobs[0].cleanup.operationId, 'op'); assert.equal(saved.plans[0].jobs[0].cleanup.state, 'partial');
  assert.deepEqual(saved.plans[0].jobs[1], queue.plans[0].jobs[1]); assert.equal(instance.executing, false);
});

function runReplacementHostFixture(change = () => {}) {
  const {PlanRunHost}=require('../../src/extension/PlanRunHost.ts');
  const root='/fixture/project',events=[],files=new Set(['work/a','work/b']),operations=new Map(),confirmations=new Map();
  const nodes=[{id:'w',host:'worker',user:'u',port:22,project_dir:'/safe/project',local_agent_url:'http://localhost:12345',conda_env:'/env'},
    {id:'v',host:'other',user:'v',port:2222,project_dir:'/other/project',local_agent_url:'http://localhost:12346',conda_env:'/env'}];
  const jobs=[0,1].map(index=>({index,case:'c',seed:42+index,output_dir:'work/'+(index?'b':'a'),result_csv:'tmp/'+index+'.csv'}));
  const body={planFile:'plans/p.yaml',planRevision:'revision'},host={client:{},projectContextGeneration:1,root,mode:'xshell_tunnel_realtime',
    captureProjectContext(){return {root:this.root,generation:this.projectContextGeneration};},
    projectContextIsCurrent(c){return c.root===this.root&&c.generation===this.projectContextGeneration;},
    effectiveConnectionMode(){return this.mode;},workerActionTargets:()=>nodes,lastCodeSyncState:{fingerprint:'code'},
    refreshLocalPlanMetadataForAction:async()=>{},stampPlanRevision(){},localDistributedCodeFingerprint:async()=> 'code',
    assertPlanSubmissionWorkers:async()=>{events.push('workers');change('workers',host,nodes,body);},
    saveDistributedQueue:async()=>events.push('hold'),
    askRunConfirmation:async p=>{events.push('ask'+p.phase);change('ask'+p.phase,host,nodes,body);return p.phase===1?'rerun_all':'isolate_and_run';}};
  const cleanup={service:{
    preview:async request=>{const job=request.job.manifest.declarations[0];return {token:String(job.index),digest:'frozen'+job.index,action:'isolate',scope:{},blockers:[],verifiedOnly:false,expiresAt:Date.now()+6e5,confirmations:0,
      rows:[{node:{id:'w',kind:'remote',user:'u',host:'worker',port:22},absolutePath:'/safe/project/'+job.output_dir,type:'directory',disposition:'isolate'}]};},
    confirm:async p=>{confirmations.set(p.token,p.phase);events.push('confirm'+p.phase+p.token);},
    preflightConfirmed:async id=>{assert.equal(confirmations.get(id),1);events.push('check'+id);},
    assertIsolatedSourcesAbsent:async preview=>{events.push('verify'+preview.token);},
    status:async id=>operations.get(id)||{state:'ready'}},
    execute:async id=>{assert.equal(confirmations.get(id),1);events.push('delete'+id);files.delete(jobs[Number(id)].output_dir);
      const result={state:'completed',pendingNodes:[]};operations.set(id,result);change('delete'+id,host,nodes,body);return result;}};
  host.planCleanupHost=()=>cleanup;
  return {host,nodes,body,events,files,run:()=>new PlanRunHost(host,root).replace({},body,{jobs})};
}

test('missing-only queries every enabled Worker instead of treating the partial ready subset as missing outputs',async()=>{
 const f=runReplacementHostFixture(),reads=[],prompts=[];
 f.body.workerSubmissionSnapshots=[{workerId:'w',queryComplete:true,tasks:[],declaredResults:[]}];
 f.host.readWorkerTaskSnapshot=async(id,options)=>{reads.push(id);assert.equal(options.fresh,true);assert.equal(options.inventoryOnly,true);
  return {workerId:id,queryComplete:true,tasks:[],declaredResults:options.declarations.map(job=>({index:job.index,
   completed:id==='v'&&job.index===0,outputDir:job.output_dir,collectionResultCsv:job.result_csv,runId:'original'}))};};
 f.host.askRunConfirmation=async p=>{prompts.push(p);return p.phase===1?'rerun_missing':'isolate_and_run';};
 await f.run();assert.deepEqual(reads.sort(),['v','w']);assert.deepEqual(f.body.assignedExperimentIndices,[1]);
 assert.ok(f.files.has('work/a'));assert.ok(!f.files.has('work/b'));
 assert.ok(prompts.at(-1).groups[0].targets.every(row=>row.path.endsWith('/work/b')));
 const offline=runReplacementHostFixture();offline.host.readWorkerTaskSnapshot=async()=>({queryComplete:false,error:'offline'});
 await assert.rejects(offline.run(),/产物.*未核实/);assert.equal(offline.files.size,2);assert.ok(!offline.events.some(x=>x.startsWith('delete')));
});

test('the real overwrite flow tolerates a same-target client rebuild during confirmation and between deletes',async()=>{
  const f=runReplacementHostFixture((stage,host)=>{if(['ask2','workers','delete0'].includes(stage))host.client={};});
  await f.run();assert.equal(f.files.size,0);assert.equal(f.body.runReplacement.done,true);
  assert.deepEqual(f.events.filter(x=>x.startsWith('ask')),['ask1','ask2']);
  assert.deepEqual(f.events.filter(x=>x.startsWith('delete')),['delete0','delete1']);
});

test('the real overwrite flow blocks changed physical targets, endpoints, environments or workspace before deleting',async()=>{
  for(const change of [h=>h.root='/other',h=>h.projectContextGeneration++,h=>h.mode='offline_import',
    (_h,n)=>n[0].host='changed',(_h,n)=>n[0].user='changed',(_h,n)=>n[0].port=2223,
    (_h,n)=>n[0].project_dir='/different',(_h,n)=>n[0].local_agent_url='http://localhost:54321',(_h,n)=>n[0].conda_env='/changed',
    (_h,n)=>n.pop()]) {
    const f=runReplacementHostFixture((stage,h,n)=>{if(stage==='ask2')change(h,n);});
    await assert.rejects(f.run(),/工作区|连接|服务器/);assert.equal(f.files.size,2);assert.ok(!f.events.some(x=>x.startsWith('delete')));
  }
});

test('a real target change during recheck prevents the first delete and partial resume keeps completed items',async()=>{
  const changed=runReplacementHostFixture((stage,_h,n)=>{if(stage==='workers')n[0].host='different';});
  await assert.rejects(changed.run(),/工作区|连接|服务器/);assert.equal(changed.files.size,2);
  const f=runReplacementHostFixture((stage,h)=>{if(stage==='delete0')h.projectContextGeneration++;});
  await assert.rejects(f.run(),/工作区|连接|服务器/);assert.deepEqual(f.body.runReplacement.completed,['0']);
  await f.run();assert.equal(f.files.size,0);assert.deepEqual(f.events.filter(x=>x.startsWith('delete')),['delete0','delete1']);
});
