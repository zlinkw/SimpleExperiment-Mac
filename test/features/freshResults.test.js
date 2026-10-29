const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
Module._extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, file);
const { collectFreshResults, freshResultTables, resultDigest } = require('../../src/results/FreshResults.ts');
const Tables = require('../../src/results/ProjectResultTables.ts');
const job = { planFile: 'experiments/plans/demo.yaml', index: 0, case: 'alpha', seed: 42, output_dir: 'work_dirs/demo/alpha42', result_csv: 'work_dirs/demo/alpha42/metrics.csv', mode: 'test' };
const plan = { planFile: job.planFile, revision: 'current', mode: 'test', seeds: [42, 43], jobs: [job] };
function fixture(workerId = 'a', runId = 'cmd', metric = '0.4', outcome = 'completed', exitCode) {
  const texts = {
    [job.output_dir + '/artifact_manifest.json']: JSON.stringify({ simpleExperiment: { status: outcome, runId, mode: 'test', outputDir: job.output_dir, exitCode,
      resultCsv: job.result_csv, weights: [], job: { index: 0, case: 'alpha', seed: 42 } } }),
    [job.result_csv]: metric,
  };
  const files = Object.entries(texts).map(([remotePath, text]) => ({ remotePath, bytes: Buffer.byteLength(text), sha256: resultDigest(text) }));
  return { snapshot: { workerId, queryComplete: true, tasks: [], declaredResults: [{ index: 0, outputDir: job.output_dir, completed: true, runId, files,
    runtimeDiagnostics:{schemaVersion:1,commandId:runId,runId,state:'clear',count:0,scanComplete:true},executionStatus:outcome,exitCode }] },
    receive: async () => Object.entries(texts).map(([remotePath, text]) => ({ remotePath, text })) };
}
const parse = text => [{ dimensions: { case: 'alpha', seed: '42', method: 'demo', dataset: 'set' }, metrics: { auc: { value: Number(text) } } }];

test('a transport failure in a shared result read does not fan out into per-job requests',async()=>{
  const f=fixture(),second={...job,index:1,seed:43,output_dir:job.output_dir+'-43',result_csv:job.output_dir+'-43/metrics.csv'};
  const original=f.snapshot.declaredResults[0];
  f.snapshot.declaredResults.push({...original,index:1,outputDir:second.output_dir,runId:'cmd43',
    files:original.files.map(file=>({...file,remotePath:file.remotePath.replace(job.output_dir,second.output_dir)}))});
  let calls=0;const result=await collectFreshResults([{...plan,jobs:[job,second]}],[f.snapshot],async()=>{calls++;throw TypeError('fetch failed');},parse);
  assert.equal(calls,1);assert.equal(result.jobs.length,2);assert.ok(result.jobs.every(row=>row.state==='unknown'));
});
test('live manifests collect without any queue, ledger, registry, inventory cache or local raw files; replicas count once', async () => {
  const a = fixture(), b = fixture('b'); let reads = 0;
  const result = await collectFreshResults([plan], [a.snapshot, b.snapshot], async () => { reads++; return a.receive(); }, parse);
  assert.equal(reads, 1); assert.equal(result.records.length, 1); assert.equal(result.jobs[0].state, 'complete');
  assert.equal(result.records[0].runId, 'cmd');
});
test('complete artifacts from a nonzero or unknown failed execution retain metrics for review without turning failures into clean success',async()=>{
  for(const exitCode of [7,undefined]){
    const a=fixture('a','cmd','0','failed',exitCode),result=await collectFreshResults([plan],[a.snapshot],a.receive,parse);
    assert.equal(result.jobs[0].state,'complete');assert.equal(result.records[0].metrics.auc,0);
    assert.equal(result.jobs[0].executionState,exitCode===7?'failed':'missing');
    assert.equal(Object.values(freshResultTables(result,[plan])).flatMap(t=>t.rows).length,0);
    assert.ok(Object.values(freshResultTables(result,[plan],undefined,true)).some(t=>t.rows.length));
  }
});
test('partial tables compute observed means, leave single-seed SD blank, and match original formula on complete input', async () => {
  const a = fixture(); const result = await collectFreshResults([plan], [a.snapshot], a.receive, parse);
  const table = Object.values(freshResultTables(result, [plan])).find(table => table.kind === 'final');
  assert.equal(table.rows[0][table.header.indexOf('jobs')], '1/2');
  assert.equal(table.rows[0][table.header.indexOf('roc_auc_mean')], .4);
  assert.equal(table.rows[0][table.header.indexOf('roc_auc_sd')], '');
  result.records.push({ ...result.records[0], seed: '43', metrics: { roc_auc: .6 } });
  result.jobs.push({...result.jobs[0],seed:43,index:1});
  const registry = Tables.emptyTableRegistry(); registry.plans[plan.planFile] = { revision: 'current', expectedSeeds: 2, records: result.records };
  assert.deepEqual(freshResultTables(result, [plan]), Tables.buildTables(registry));
});
test('artifact aggregation does not require console logs, including closed windows and copied manifests',async()=>{
  for(const state of ['anomalous','unverified',undefined]){
    const a=fixture('a','cmd','0');
    a.snapshot.declaredResults[0].runtimeDiagnostics={schemaVersion:1,commandId:'cmd',runId:'cmd',state,count:state==='anomalous'?1:0,scanComplete:state==='anomalous',types:{AttributeError:1},phases:{train:1}};
    const result=await collectFreshResults([plan],[a.snapshot],a.receive,parse);
    assert.equal(result.jobs[0].state,'complete');assert.equal(result.records[0].metrics.auc,0);
    assert.equal(result.jobs[0].completionState,state==='anomalous'?'review_required':'unverified');
    assert.equal(result.jobs[0].aggregationState,'eligible');
    assert.ok(Object.values(freshResultTables(result,[plan])).some(t=>t.rows.length));
    const review=Object.values(freshResultTables(result,[plan],undefined,true));
    assert.equal(review.length,0);
  }
});
test('mixed versions aggregate fresh artifact bytes and preserve each original command and source version',async()=>{
  const a=fixture(),binding={planFile:plan.planFile,index:0,case:'alpha',seed:42,outputDir:job.output_dir,collectionResultCsv:job.result_csv,
    commandId:'cmd',workerId:'original',workflowId:'original-workflow',revision:'original-revision',codeFingerprint:'a'.repeat(64)};
  const result=await collectFreshResults([plan],[a.snapshot],a.receive,parse,{},()=>true,[binding]);
  assert.equal(result.records[0].workerId,'a');assert.equal(result.records[0].executionWorkerId,'original');
  assert.equal(result.records[0].revision,'original-revision');assert.equal(result.records[0].workflowId,'original-workflow');
  result.records.push({...result.records[0],seed:'43',runId:'new-command',codeFingerprint:'b'.repeat(64),workflowId:'new-workflow'});
  result.jobs.push({...result.jobs[0],seed:43,commandId:'new-command'});
  const table=Object.values(freshResultTables(result,[plan])).find(row=>row.kind==='final');
  assert.equal(table.rows[0][table.header.indexOf('mixed_versions')],'true');
  assert.match(table.rows[0][table.header.indexOf('job_versions')],/alpha\/42:a{64}@original:cmd/);
  assert.match(table.rows[0][table.header.indexOf('job_versions')],/alpha\/43:b{64}@original:new-command/);
  binding.commandId='newest-pending';
  const superseded=await collectFreshResults([plan],[a.snapshot],()=>assert.fail('old artifacts cannot replace newest command'),parse,{},()=>true,[binding]);
  assert.equal(superseded.jobs[0].state,'conflict');assert.equal(superseded.records.length,0);
});
test('deleted results vanish on the next query; offline is unknown and cannot reuse previous rows', async () => {
  const gone = { workerId: 'a', queryComplete: true, declaredResults: [{ index: 0, outputDir: job.output_dir, completed: false, resultState: 'missing' }] };
  const result = await collectFreshResults([plan], [gone], () => assert.fail('no download'), parse);
  assert.equal(result.jobs[0].state, 'missing'); assert.equal(result.querySucceeded, true); assert.deepEqual(result.records, []);
  const offline = await collectFreshResults([plan], [{ workerId: 'a', queryComplete: false, error: 'offline' }], () => assert.fail(), parse);
  assert.equal(offline.jobs[0].state, 'unknown'); assert.equal(offline.querySucceeded, false); assert.deepEqual(offline.records, []);
});
test('conflicting writer or content cannot be selected by timestamps; changed bytes reject the read', async () => {
  const a = fixture(), b = fixture('b', 'other');
  const conflict = await collectFreshResults([plan], [a.snapshot, b.snapshot], () => assert.fail('conflict must not download'), parse);
  assert.equal(conflict.jobs[0].state, 'conflict');
  const changed = await collectFreshResults([plan], [a.snapshot], async () => (await a.receive()).map(file => ({ ...file, text: file.text + 'x' })), parse);
  assert.equal(changed.records.length, 0); assert.match(changed.jobs[0].error, /RESULT_CONTENT_CHANGED/);
});
test('a live writer blocks stale completed replicas; nonzero exit remains distinct from complete artifacts', async () => {
  const a = fixture();
  a.snapshot.tasks = [{ commandId: 'new', outputDir: job.output_dir, observation: { tmux: { dead: false, exitCode: null } } }];
  const busy = await collectFreshResults([plan], [a.snapshot], () => assert.fail(), parse);
  assert.equal(busy.jobs[0].executionState, 'running'); assert.equal(busy.records.length, 0);
  for (const code of [null, 0, 3]) {
    a.snapshot.tasks = [{ commandId: 'cmd', outputDir: job.output_dir, observation: { tmux: { dead: true, exitCode: code } } }];
    const done = await collectFreshResults([plan], [a.snapshot], a.receive, parse);
    assert.equal(done.jobs[0].state, 'complete');
    assert.equal(done.jobs[0].executionState, code ? 'failed' : 'exited');
  }
});
