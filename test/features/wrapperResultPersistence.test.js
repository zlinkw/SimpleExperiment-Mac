const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const test = require('node:test');
const repo = path.join(__dirname, '../..');
const vscode = {
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_name, fallback) => fallback }) },
  extensions: { getExtension: () => ({ extensionPath: repo, packageJSON: require('../../package.json') }) },
  Uri: { file: fsPath => ({ fsPath }) }, ProgressLocation: { Notification: 1 },
  window: { withProgress: async (_options, work) => work({ report() {} }, { isCancellationRequested: false }),
    showWarningMessage: async () => {}, showInformationMessage: async () => {}, setStatusBarMessage() {} },
};
const originalLoad = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
const { RealtimeTunnelPanelProvider } = require('../../dist/extension/legacy');
Module._load = originalLoad;
const tables = require('../../dist/results/ProjectResultTables');
const bundle = require('../../dist/results/WrapperResultBundle');
const publication = require('../../dist/results/ProjectResultPublication');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const planFile = 'experiments/plans/comparison/anything.yaml';

const {currentResultHost}=require("../_helpers/currentResultHost");
const {latestResultCatalog}=require("../../dist/results/LatestResultExport");
function fixture(options={}) {return currentResultHost(RealtimeTunnelPanelProvider,options);}
test('TSV merge preserves commas, quotes and multiline cells; JSONL run mismatches are rejected', () => {
  const job = { runId: 'A', index: 0, attempt: 1, case: 'one', seed: 42, workerId: 'owner', outputDir: 'work_dirs/a/attempts/A', commandId: 'cmd' };
  const remotePath = job.outputDir + '/custom.tsv', text = 'label\tnote\nlesion,benign\t"first\nsecond,third"\n';
  const prepared = bundle.prepareWrapperJob(job, [{ remotePath, text, sha256: sha(text), bytes: Buffer.byteLength(text) }], '', [remotePath], file => 'experiments/results/' + file);
  const pub = bundle.prepareWrapperPublication('A', [{ case: 'one', seed: 42 }], [prepared]);
  const merged = bundle.wrapperMergedFiles('experiments/results', planFile, pub, [prepared]);
  const csv = tables.readCsv(merged[0].contents);
  assert.equal(csv.rows[0][csv.header.indexOf('label')], 'lesion,benign');
  assert.equal(csv.rows[0][csv.header.indexOf('note')], 'first\nsecond,third');
  const bad = '{"run_id":"B","job_dir":"work_dirs/a/attempts/A"}\n';
  assert.throws(() => bundle.prepareWrapperJob(job, [{ remotePath: job.outputDir + '/rows.jsonl', text: bad, sha256: sha(bad) }], '', [], file => file), /身份不匹配/);
});


test('auxiliary diagnostic seed is preserved; canonical and anchored job seeds remain strict', () => {
  const job = { runId: 'A', index: 1, attempt: 1, case: 'one', seed: 43, workerId: 'owner', outputDir: 'work_dirs/a/attempts/A', commandId: 'cmd' };
  const file = (name, text) => ({ remotePath: job.outputDir + '/' + name, text, sha256: sha(text), bytes: Buffer.byteLength(text) });
  const diagnostic = file('undefined_metrics.csv', 'case,run_id,seed,metric,value\n,,42,target_accuracy_change,NaN\n');
  const prepared = bundle.prepareWrapperJob(job, [diagnostic], '', [], name => name);
  assert.equal(prepared.records[0].rows[0].seed, '42');
  const pub = bundle.prepareWrapperPublication('A', [{ case: 'one', seed: 43 }], [prepared]);
  assert.match(bundle.wrapperMergedFiles('experiments/results', planFile, pub, [prepared])[0].contents, /NaN,A,1,one,43,owner/);
  assert.throws(() => bundle.prepareWrapperJob(job, [diagnostic], diagnostic.remotePath, [], name => name), /期望 43，实际 42/);
  const anchored = file('diagnostic.json', JSON.stringify({ seed: 42, job_dir: job.outputDir }));
  assert.throws(() => bundle.prepareWrapperJob(job, [anchored], '', [], name => name), /身份不匹配/);
  assert.equal(bundle.isWrapperResultFile(job.outputDir + '/code_backup/results.csv'), false);
});


test('local reuse checks current SHA256 even when size and mtime match', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-wrapper-reuse-'));
  const text = 'seed,metric,value\n42,AUC,0.8\n', relative = 'results/metric.csv';
  fs.mkdirSync(path.join(root, 'results'));
  const target = path.join(root, relative); fs.writeFileSync(target, text);
  const entry = { remotePath: 'work_dirs/a/metric.csv', localRelativePath: relative, sha256: sha(text), bytes: Buffer.byteLength(text) };
  assert.equal((await bundle.readVerifiedLocalResult(root, entry)).text, text);
  const before = fs.statSync(target); fs.writeFileSync(target, text.replace('0.8', '0.9')); fs.utimesSync(target, before.atime, before.mtime);
  assert.equal(await bundle.readVerifiedLocalResult(root, entry), undefined);
  await assert.rejects(bundle.readVerifiedLocalResult(root, { ...entry, localRelativePath: '../metric.csv' }), /路径不安全/);
});


test('wrapper declaration rejects out-of-job paths and retains unknown JSON without coercion', () => {
  assert.throws(() => bundle.declaredWrapperResults('{"outputs":["../../other.csv"]}', 'work_dirs/a/attempts/A'), /不安全/);
  assert.throws(() => bundle.declaredWrapperResults('{"outputs":["/other/a.csv"]}', 'work_dirs/a/attempts/A'), /不属于/);
  assert.deepEqual(bundle.declaredWrapperResults('{"outputs":["extra.parquet","test/custom.tsv"],"checkpoint_path":"best.pth"}', 'work_dirs/a/attempts/A'),
    ['work_dirs/a/attempts/A/extra.parquet', 'work_dirs/a/attempts/A/test/custom.tsv']);
});


function rows(file=planFile,value=.92) {return [42,43,44].map(seed=>({planFile:file,case:'case-one',seed:String(seed),method:'unknown_method',dataset:'arbitrary_set',metrics:{AUC:value}}));}
function noRawFiles(f) {
  for(const remote of f.files.keys()) {assert.equal(fs.existsSync(path.join(f.root,remote)),false,remote);assert.equal(fs.existsSync(path.join(f.root,remote+'.provenance.json')),false);}
  assert.equal(fs.existsSync(path.join(f.root,'simple_cluster/results/project_table_registry.json')),false);
  assert.equal(fs.existsSync(path.join(f.root,'simple_cluster/downloads')),false);
}
function replaceRun(f,job,runId,workerId='owner') {
  f.states.set(job.output_dir,{completed:true,runId});f.workers.set(job.output_dir,workerId);f.workerIds.add(workerId);
  const file=job.output_dir+'/artifact_manifest.json',value=JSON.parse(f.files.get(file));value.simpleExperiment.runId=runId;f.files.set(file,Buffer.from(JSON.stringify(value)));
}

test('same-named Plans publish separate current summaries without raw files or a disk registry',async()=>{
  const other=planFile.replace('/comparison/','/comparison_tuning/');
  const f=fixture({rows:[...rows(),...rows(other,.66)]});
  // The retained entry point queries all current declarations; caller-supplied old plan lists cannot become authority.
  const report=await f.host.rebuildProjectResultTablesFromUi({planFiles:[planFile]});
  assert.equal(report.current,true);assert.deepEqual(new Set(report.included),new Set([planFile,other]));
  assert.equal(report.completed,6);assert.deepEqual(report.skipped,[]);assert.deepEqual(report.missing,[]);
  for(const [file,value] of [[planFile,.92],[other,.66]]) {
    const records=report.results.filter(row=>row.planFile===file);assert.equal(records.length,3);
    assert.ok(records.every(row=>Object.values(row.metrics).some(metric=>metric===value)));
    assert.equal(report.planCoverage[file].completed,3);
  }
  const csv=tables.readCsv(fs.readFileSync(path.join(f.root,'experiments/results/arbitrary_set/final/final.csv'),'utf8'));
  assert.equal(csv.rows.length,2);assert.deepEqual(new Set(csv.rows.map(row=>row[csv.header.indexOf('plan_file')])),new Set([planFile,other]));noRawFiles(f);
});

test('declared CSV and final manifest bind the current job without reading old attempt output',async()=>{
  const f=fixture({rows:rows()});f.files.set('work_dirs/old/attempts/A/metrics.csv',Buffer.from('metric,value\nAUC,1\n'));
  const historical=Buffer.from(f.files.get('work_dirs/old/attempts/A/metrics.csv'));
  const report=await f.sync();assert.equal(report.completed,3);assert.equal(report.current,true);
  const saved=f.exported();assert.equal(saved.source,'active_query');assert.equal(saved.jobs.length,3);
  for(const job of saved.jobs) {
    assert.equal(job.state,'complete');assert.ok(!job.outputDir.includes('/attempts/'));assert.equal(job.sources.length,2);
    for(const source of job.sources){assert.equal(source.sha256,sha(f.files.get(source.remotePath)));assert.equal(source.bytes,f.files.get(source.remotePath).length);}
  }
  assert.ok(f.calls.filter(row=>row.method==='sync.downloadMappedPaths').every(row=>row.params.entries.every(entry=>!entry.remotePath.includes('/attempts/'))));
  assert.deepEqual(f.files.get('work_dirs/old/attempts/A/metrics.csv'),historical);noRawFiles(f);
});

for(const [kind,worker] of [['manual retry','owner'],['cross Worker reassignment','new-owner'],['automatic retry receipt','owner'],['recalled failure retry','new-owner']])
test(kind+' uses the new command and current Worker bytes without reviving an attempt state machine',async()=>{
  const f=fixture({rows:rows()});await f.sync();const job=f.declarations.get(planFile)[2],oldCommand=f.states.get(job.output_dir).runId;
  const oldBytes=new Map([...f.files].map(([file,bytes])=>[file,Buffer.from(bytes)]));
  replaceRun(f,job,'new-command-44',worker);f.calls.length=0;const report=await f.sync();
  assert.equal(report.completed,3);assert.deepEqual(report.missing,[]);assert.deepEqual(report.skipped,[]);
  const current=f.exported().jobs.find(row=>row.seed===44);assert.equal(current.commandId,'new-command-44');assert.equal(current.workerId,worker);assert.equal(current.outputDir,job.output_dir);
  assert.equal(Object.hasOwn(current,'attempt'),false);assert.ok(report.results.every(row=>row.runId!==oldCommand));
  assert.ok(f.calls.some(row=>row.method==='sync.downloadMappedPaths'&&row.params.server.id===worker&&row.params.entries.some(entry=>entry.remotePath===job.result_csv)));
  for(const [file,bytes] of oldBytes) if(file!==job.output_dir+'/artifact_manifest.json')assert.deepEqual(f.files.get(file),bytes);
  f.calls.length=0;await f.host.refreshLocalResultsFromUi();assert.equal(f.calls.length,0);assert.equal(f.exported().jobs.find(row=>row.seed===44).commandId,'new-command-44');noRawFiles(f);
});

function historicalFormatFixture() {
  const job={runId:'B',index:0,case:'case-one',seed:42,attempt:1,workerId:'owner',commandId:'B-42',outputDir:'work_dirs/compat/attempts/B'};
  const endpoint=job.outputDir+'/metrics.csv',checkpoint=job.outputDir+'/best_model.pth';
  const files=new Map([
    [endpoint,`case,seed,method,dataset,metric,value,checkpoint_path,job_dir,run_id\ncase-one,42,unknown_method,arbitrary_set,AUC,0.9,${checkpoint},${job.outputDir},B\n`],
    [job.outputDir+'/four.csv','state,metric,value,p0_value,delta_p100_minus_p0,sample_count,checkpoint_path,job_dir,seed,method,dataset,undefined_reason,p0_undefined_reason,extra_column\n'+['both','image_missing','text_missing','both_missing'].map(state=>`${state},AUC,0.9,0.7,0.2,210,${checkpoint},${job.outputDir},42,unknown_method,arbitrary_set,,,保留原文`).join('\n')+'\n'],
    [job.outputDir+'/custom.json',JSON.stringify({arbitrary:{list:[1,null,'完整保留']}})],
    [job.outputDir+'/mask.npz',Buffer.from([0,255,2,4,9])],
  ]);
  const required=[...files.keys()];const inputs=()=>[...files].map(([remotePath,data])=>({remotePath,text:Buffer.isBuffer(data)?data.toString('base64'):data,encoding:Buffer.isBuffer(data)?'base64':undefined,sha256:sha(data),bytes:Buffer.byteLength(data)}));
  return {job,endpoint,checkpoint,files,required,inputs,prepare:()=>bundle.prepareWrapperJob(job,inputs(),endpoint,required,file=>'results/'+file)};
}

test('stateless historical format reader preserves four-state and arbitrary output evidence without a Host publication',()=>{
  const f=historicalFormatFixture(),prepared=f.prepare(),published=bundle.prepareWrapperPublication('B',[{case:'case-one',seed:42}],[prepared]);
  assert.equal(prepared.evidence.checkpointPath,f.checkpoint);assert.equal(prepared.evidence.sources.length,4);
  const four=prepared.records.find(row=>row.source.kind==='four.csv');assert.equal(four.rows.length,4);assert.ok(four.rows.every(row=>row.extra_column==='保留原文'));
  assert.deepEqual(prepared.records.find(row=>row.source.kind==='custom.json').value,{arbitrary:{list:[1,null,'完整保留']}});
  assert.equal(prepared.records.find(row=>row.source.kind==='mask.npz').value.sha256,sha(f.files.get(f.job.outputDir+'/mask.npz')));
  assert.equal(published.runId,'B');assert.ok(prepared.files.length>prepared.evidence.sources.length);
});

for(const fault of ['missing-four','hash-mismatch','wrong-checkpoint','missing-custom'])
test(fault+' cannot certify a historical wrapper bundle or mutate its prior proof',()=>{
  const f=historicalFormatFixture(),prior=f.prepare(),before=JSON.stringify(prior.evidence);
  if(fault==='missing-four')f.files.delete(f.job.outputDir+'/four.csv');
  if(fault==='missing-custom')f.files.delete(f.job.outputDir+'/custom.json');
  if(fault==='wrong-checkpoint')f.files.set(f.job.outputDir+'/four.csv',f.files.get(f.job.outputDir+'/four.csv').replaceAll('best_model.pth','other.pth'));
  if(fault==='hash-mismatch') {const input=f.inputs();input[1].text+='tampered';assert.throws(()=>bundle.prepareWrapperJob(f.job,input,f.endpoint,f.required,file=>file),/SHA256/);}
  else assert.throws(()=>f.prepare(),fault==='wrong-checkpoint'?/checkpoint|检查点/:/必需结果缺失/);
  assert.equal(JSON.stringify(prior.evidence),before);
});

test('generic CSV names require no project-specific four-state schema; raw binary files are not aggregation inputs',async()=>{
  const f=fixture({rows:rows()});for(const job of f.declarations.get(planFile))f.files.set(job.output_dir+'/mask.npz',Buffer.from([0,255]));
  const report=await f.sync();assert.equal(report.completed,3);assert.equal(report.results.length,3);
  assert.ok(f.calls.filter(row=>row.method==='sync.downloadMappedPaths').every(row=>row.params.entries.every(entry=>/artifact_manifest\.json$|metrics\.csv$/.test(entry.remotePath))));noRawFiles(f);
});

test('train-only completion keeps structured proof without inventing endpoint statistics',async()=>{
  const f=fixture({rows:rows()});f.inputs[0].mode='train';
  for(const job of f.declarations.get(planFile)){const name=job.output_dir+'/artifact_manifest.json',value=JSON.parse(f.files.get(name));Object.assign(value.simpleExperiment,{mode:'train',weights:[job.output_dir+'/best_model.pth']});f.files.set(name,Buffer.from(JSON.stringify(value)));f.files.delete(job.result_csv);}
  const report=await f.sync();assert.equal(report.completed,3);assert.deepEqual(report.results,[]);assert.equal(report.downloaded,false);
  assert.equal(f.exported().jobs.length,3);assert.ok(f.exported().jobs.every(job=>job.sources.length===1));assert.deepEqual(f.exported().tables,[]);noRawFiles(f);
});

test('an incomplete current rerun cannot borrow an old seed or retain its old aggregation authority',async()=>{
  const f=fixture({rows:rows()});await f.sync();const old=f.exported(),jobs=f.declarations.get(planFile);
  jobs.forEach((job,index)=>replaceRun(f,job,'rerun-'+index));f.states.get(jobs[2].output_dir).completed=false;
  const report=await f.sync();assert.equal(report.completed,2);assert.equal(report.planCoverage[planFile].completed,2);
  assert.equal(report.results.length,2);assert.ok(report.results.every(row=>row.dimensions.seed!=='44'&&row.runId.startsWith('rerun-')));
  assert.equal(f.exported().jobs.filter(job=>job.state==='complete').length,2);assert.equal(old.jobs.length,3);
  f.states.get(jobs[2].output_dir).completed=true;assert.equal((await f.sync()).completed,3);assert.ok(f.exported().jobs.every(job=>job.commandId.startsWith('rerun-')));
});

test('repeated collection preserves exact sources and table bytes while rereading current bytes in memory',async()=>{
  const f=fixture({rows:rows()});await f.sync();const previous=f.exported(),file=path.join(f.root,'experiments/results/arbitrary_set/final/final.csv'),bytes=fs.readFileSync(file);
  f.calls.length=0;const report=await f.sync();assert.deepEqual(f.exported().jobs,previous.jobs);assert.deepEqual(fs.readFileSync(file),bytes);
  assert.equal(report.memoryFiles,6);assert.ok(report.memoryRequests>0);assert.equal(report.downloaded,true);
  assert.equal(f.calls.filter(row=>row.method==='sync.downloadMappedPaths').flatMap(row=>row.params.entries).length,6);noRawFiles(f);
});

test('old SFTP cannot fall back to disk or silently retain old rows as current results',async()=>{
  const f=fixture({rows:rows()});await f.sync();const old=f.exported();f.calls.length=0;
  f.host.simpleSftpCapability=async()=>({methodOptions:{'sync.downloadMappedPaths':{memoryOnly:true}}});
  const report=await f.sync();assert.equal(report.completed,0);assert.ok(report.jobs.every(job=>/内存指标读取能力/.test(job.error)));
  assert.equal(f.calls.filter(row=>row.method==='sync.downloadMappedPaths').length,0);assert.deepEqual(f.exported().tables,[]);assert.equal(old.tables.length,2);noRawFiles(f);
});

test('an authorized historical metric view opens malformed text in memory and rejects foreign Plan authority',async()=>{
  const f=fixture({rows:rows()});await f.sync();const job=f.declarations.get(planFile)[0],broken=Buffer.from('metric,value\n"broken');f.files.set(job.result_csv,broken);
  const previous=[vscode.workspace.openTextDocument,vscode.window.showTextDocument,vscode.window.showWarningMessage];let opened;
  vscode.workspace.openTextDocument=async options=>{assert.equal(typeof options.content,'string');opened=options;return options;};vscode.window.showTextDocument=async()=>{};
  vscode.window.showWarningMessage=async(_message,_options,choice)=>choice;f.host.resolveSelectedPlanFile=()=>planFile;
  f.host.actionBody=value=>value;f.host.selectedRunKeys=[];f.host.resultsSummary={planFile,rawResultCsvPath:job.result_csv,resultOwnerWorkerId:'owner',workerResultTables:[{planFile,workerId:'owner',rawResultCsvPath:job.result_csv}]};
  const transfer=f.host.simpleSftpApiCall;
  f.host.simpleSftpApiCall=async(method,params)=>method==='sync.projectInventory'?{files:Object.fromEntries(params.scopePaths.map(remote=>[remote,{size:f.files.get(remote).length,sha256:sha(f.files.get(remote))}]))}:transfer(method,params);f.host.effectiveConnectionMode=()=> 'tunnel';f.host.enabledWorkerConfigs=()=>[{id:'owner'}];
  f.host.mappedDownloadServerForSource=()=>f.host.workerCodeSyncTargets()[0];f.host.client.downloadWorkerFile=()=>assert.fail('direct file download forbidden');
  try{
    const current=f.host.resultsSummary;f.host.resultsSummary={...current,planFile:'experiments/plans/foreign.yaml'};
    await assert.rejects(f.host.openResultArtifactFromUi({planFile,remotePath:job.result_csv,workerId:'owner'}),/不属于/);assert.equal(opened,undefined);
    f.host.resultsSummary=current;await f.host.openResultArtifactFromUi({planFile,remotePath:job.result_csv,workerId:'owner'});}finally{[vscode.workspace.openTextDocument,vscode.window.showTextDocument,vscode.window.showWarningMessage]=previous;}
  assert.equal(opened.content,broken.toString());noRawFiles(f);
});

test('a failed table write leaves the authoritative JSON repairable without a legacy publication ledger',async()=>{
  const f=fixture({rows:rows()});await f.sync();const job=f.declarations.get(planFile)[0];f.files.set(job.result_csv,Buffer.from(f.files.get(job.result_csv).toString().replace('0.92','0.93')));
  const io=require('node:fs/promises'),rename=io.rename;let failed=false;
  io.rename=async(from,to)=>{if(!failed&&to.endsWith('/final/final.csv')){failed=true;throw Error('isolated table commit failure');}return rename(from,to);};
  try{await assert.rejects(f.sync(),/isolated table commit failure/);}finally{io.rename=rename;}
  assert.equal(failed,true);assert.equal(f.exported().source,'active_query');assert.equal(f.exported().jobs.length,3);
  const expected=f.exported().tables.find(table=>table.relativePath==='arbitrary_set/final/final.csv');await f.host.refreshLocalResultsFromUi();
  assert.equal(fs.readFileSync(path.join(f.root,'experiments/results',expected.relativePath),'utf8'),tables.writeCsv(expected.header,expected.rows));noRawFiles(f);
});

test('a first partial run publishes only its actual seeds and never fabricates formal completeness',async()=>{
  const f=fixture({rows:rows()}),job=f.declarations.get(planFile)[2];f.states.get(job.output_dir).completed=false;
  const report=await f.sync();assert.equal(report.completed,2);assert.equal(report.planCoverage[planFile].expected,3);assert.equal(report.planCoverage[planFile].completed,2);
  assert.equal(report.results.length,2);assert.ok(report.results.every(row=>row.dimensions.seed!=='44'));assert.equal(f.exported().jobs.filter(job=>job.state!=='complete').length,1);noRawFiles(f);
});

test('bytes changed after the fresh hash observation cannot enter the current result export',async()=>{
  const f=fixture({rows:rows()});await f.sync();const read=f.host.simpleSftpApiCall;
  f.host.simpleSftpApiCall=async(method,params)=>{const value=await read(method,params);for(const entry of value.entries)if(entry.remotePath.endsWith('metrics.csv'))entry.dataBase64=Buffer.from('tampered').toString('base64');return value;};
  const report=await f.sync();assert.equal(report.completed,0);assert.ok(report.jobs.every(job=>/RESULT_CONTENT_CHANGED/.test(job.error)));
  assert.deepEqual(f.exported().tables,[]);assert.equal((await f.catalog()).datasets.length,0);noRawFiles(f);
});

test('old endpoint summaries and registry rows cannot replace current native result bytes',async()=>{
  const f=fixture({rows:rows()});await f.sync();const before=f.exported();
  f.host.getResultsSummary=()=>assert.fail('cached summary must not be read');
  const forged=tables.emptyTableRegistry();forged.plans[planFile]={records:[{...rows()[0],metrics:{AUC:1}}]};
  const report=await f.host.writeProjectTableRegistry(f.root,forged);assert.equal(report.completed,3);
  assert.deepEqual(f.exported().jobs,before.jobs);assert.ok(report.results.every(row=>Object.values(row.metrics).includes(.92)));noRawFiles(f);
});
