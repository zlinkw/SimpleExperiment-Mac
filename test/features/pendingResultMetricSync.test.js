const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {scenario,Provider,resultDigest}=require('../_helpers/resultCollectionScenario');
const extension=fs.readFileSync(path.join(__dirname,'../../src/extension/legacy.ts'),'utf8');
const panel=fs.readFileSync(path.join(__dirname,'../../src/ui/PanelHtml.legacy.ts'),'utf8');
const {__handleResultUiCommandForTest:ui}=require('../../dist/extension/legacy');
const vscodeStub={workspace:{workspaceFolders:[]}};
function sliceBetween(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function single(){const f=scenario(),p=f.addPlan(undefined,{seeds:[42]});f.put(p,0);return {f,p};}
for(const command of ['rebuildProjectResultTables','syncPendingPlanArtifacts','syncAllResultArtifacts'])for(const recordedHashes of [false,true])test(command+' collects all six current jobs irrespective of old recorded hashes='+recordedHashes,async()=>{
 const f=scenario({workerIds:['w1','w2','unused-offline']}),p=f.addPlan(undefined,{cases:['bus','pad'],seeds:[42,43,44]});
 p.jobs.forEach(j=>f.put(p,j.index,{workerId:j.index<3?'w1':'w2',runId:'run-b-'+j.index,dataset:j.case.toUpperCase()}));f.offline('unused-offline');
 f.host.extensionRuntimeVersionState=()=>({reloadRequired:false});f.host.resolveSelectedPlanFile=()=>p.planFile;
 f.host.planSyncLedger={entries:{old:{runId:'run-a',hashes:recordedHashes?{'old.csv':'a'.repeat(64)}:{}}}};
 const old=path.join(f.root,'simple_cluster/results/project_table_registry.json');fs.mkdirSync(path.dirname(old),{recursive:true});fs.writeFileSync(old,JSON.stringify({plans:{[p.planFile]:{records:[{runId:'run-a',metrics:{AUC:.81}}]}}}));const before=fs.readFileSync(old);
 const r=await ui(f.host,{command,planFile:p.planFile});assert.equal(r.results.length,6);assert.equal(r.completed,6);assert.ok(r.results.every(row=>row.runId.startsWith('run-b-')&&row.metrics.AUC===.92));
 for(const dataset of ['BUS','PAD'])assert.deepEqual(r.results.filter(row=>row.dimensions.dataset===dataset).map(row=>row.dimensions.seed).sort(),['42','43','44']);
 const reads=f.calls.filter(c=>c.kind==='receive');assert.equal(reads.length,2);assert.deepEqual(new Set(reads.map(c=>c.params.server.id)),new Set(['w1','w2']));
 assert.equal(fs.existsSync(path.join(f.root,'work_dirs')),false);assert.equal(fs.existsSync(path.join(f.root,'tmp/result')),false);assert.deepEqual(fs.readFileSync(old),before);
 for(const t of f.snapshot().tables){assert.match(t.markdown,/0\.920/);assert.doesNotMatch(t.markdown,/0\.810/);}
});
for(const fault of ['extra-file','missing-file','duplicate-file','changed-content','invalid-base64','wrong-size','wrong-hash','not-memory','api-failed'])test('memory transfer rejects '+fault+' without accepting cached rows',async()=>{
 const {f}=single();await f.update();f.calls.length=0;
 f.receive((params,value)=>{
  const e=value.entries[0];
  if(fault==='extra-file')value.entries.push({...e,remotePath:'work_dirs/undeclared.csv'});
  if(fault==='missing-file')value.entries.pop();
  if(fault==='duplicate-file')value.entries[1]={...e};
  if(fault==='changed-content')e.dataBase64=Buffer.from('x'.repeat(e.bytes)).toString('base64');
  if(fault==='invalid-base64')e.dataBase64='!'.repeat(e.dataBase64.length);
  if(fault==='wrong-size')e.bytes++;
  if(fault==='wrong-hash')e.sha256='f'.repeat(64);
  if(fault==='not-memory')value.memoryOnly=false;
  if(fault==='api-failed')value.ok=false;
  return value;
 });
 const r=await f.update();assert.equal(r.results.length,0);assert.equal(r.jobs[0].state,'unknown');assert.match(r.jobs[0].error,/RESULT_/);assert.equal(f.snapshot().jobs[0].state,'unknown');
});
for(const missing of ['memoryOnly','memoryWrapperResults'])test('old SFTP missing '+missing+' cannot fall back to disk',async()=>{
 const {f}=single();f.host.simpleSftpCapability=async()=>({methodOptions:{'sync.downloadMappedPaths':{memoryOnly:missing!=='memoryOnly',memoryWrapperResults:missing!=='memoryWrapperResults'}}});
 const r=await f.update();assert.equal(r.results.length,0);assert.match(r.jobs[0].error,/SimpleSFTP/);assert.equal(f.calls.some(c=>c.kind==='receive'),false);
});
test('a proven identical mirror supplies current bytes when its original Worker is offline',async()=>{
 const {f,p}=single();f.put(p,0,{workerId:'w2'});f.offline('w1');const r=await f.update();assert.equal(r.completed,1);assert.equal(r.results[0].workerId,'w2');assert.ok(r.skipped.some(e=>e.includes('w1')));
});
test('different mirror hashes cannot be resolved using old owner or timestamp hints',async()=>{
 const {f,p}=single();f.put(p,0,{workerId:'w2',metric:.1});const r=await f.update();assert.equal(r.results.length,0);assert.equal(r.jobs[0].state,'conflict');assert.equal(f.calls.some(c=>c.kind==='receive'),false);
});
test('legacy raw files and aggregate directories remain untouched and cannot fill missing results',async()=>{
 const {f,p}=single();const raw=path.join(f.root,'tmp/result/stale.csv');fs.mkdirSync(path.dirname(raw),{recursive:true});fs.writeFileSync(raw,'AUC,999');
 const legacy=path.join(f.root,'artifacts/results/final/final.csv');fs.mkdirSync(path.dirname(legacy),{recursive:true});fs.writeFileSync(legacy,'old table');
 f.copies.clear();const r=await f.update();assert.equal(r.results.length,0);assert.equal(r.jobs[0].state,'missing');assert.equal(fs.readFileSync(raw,'utf8'),'AUC,999');assert.equal(fs.readFileSync(legacy,'utf8'),'old table');
});
test('unchanged size and timestamp cannot mask a new current metric hash',async()=>{
 const {f,p}=single();await f.update();const file=p.jobs[0].result_csv,old=f.storage.get('w1').get(file);f.storage.get('w1').set(file,Buffer.from(old.toString().replace('0.92','0.61')));
 const r=await f.update();assert.equal(r.results[0].metrics.AUC,.61);assert.ok(f.calls.filter(c=>c.kind==='receive').length>=2);assert.match(f.read('set/final/final.csv'),/0.61/);
});
test('a missing-only historical download choice cannot suppress a fresh in-memory read',async()=>{
 const {f}=single();await f.update();f.calls.length=0;f.host.resultDownloadChoice='only_missing';const r=await f.update();assert.equal(r.completed,1);assert.equal(f.calls.filter(c=>c.kind==='receive').length,1);
});
for(const [field,value]of [['train_rate','.5'],['rate_percent','50']])test(field+' is normalized as 50 percent in current tables',async()=>{
 const {f,p}=single();const j=p.jobs[0];f.put(p,0,{text:`case,seed,method,dataset,${field},AUC\n${j.case},${j.seed},method,set,${value},0.92\n`});const r=await f.update();assert.equal(r.results[0].dimensions.rate_percent,'50');assert.match(f.read('set/final/final.csv'),/,50,/);
});
test('quoted configured column names preserve dimensions and refresh the visible current summary',async()=>{
 const {f,p}=single();f.rules.csvColumnMapping={case:'case,name',seed:'my seed',metric:'my metric',value:'my value',dataset:'my dataset'};
 f.put(p,0,{text:'"case,name",my seed,my metric,my value,my dataset\nalpha,42,AUC,0.73,exact-set\n'});const r=await f.update();assert.equal(r.results[0].metrics.AUC,.73);assert.equal(r.results[0].dimensions.dataset,'exact-set');assert.strictEqual(f.host.resultsSummary,r);
});
test('empty declaration and wrong protocol explicitly block current discovery',async()=>{
 for(const fault of ['empty','protocol']){const {f}=single();f.discovery((id,options,value)=>fault==='empty'?{...value,declaredJobs:[]}:{...value,capabilities:{resultCollection:0}});const r=await f.update();assert.equal(r.current,false);assert.equal(r.results.length,0);assert.ok(r.skipped.length);assert.equal(f.calls.some(c=>c.kind==='receive'),false);}
});
test('the next query removes missing results and an all-offline query preserves the old export as historical only',async()=>{
 const {f}=single();await f.update();const before=JSON.stringify(f.snapshot());f.offline('w1');f.offline('w2');const offline=await f.update();assert.equal(offline.current,false);assert.equal(offline.results.length,0);assert.equal(JSON.stringify(f.snapshot()),before);
 f.online('w1');f.online('w2');f.copies.clear();const gone=await f.update();assert.equal(gone.current,true);assert.equal(gone.results.length,0);assert.equal(f.snapshot().jobs[0].state,'missing');
});
test('retired Hub SFTP targets are rejected instead of falling back to the only Worker',async()=>{
 const f=scenario();const h=Object.assign(Object.create(Provider.prototype),f.host,{enabledWorkerConfigs:()=>f.workers,setupConfig:{workerTunnels:f.workers}});
 assert.throws(()=>h.mappedDownloadServerForSource('hub'),/Worker|HUB_REMOVED|未配置/);
});

test("distribution rejects symlink destinations and preserves content when replacement fails", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-metrics-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-metrics-outside-"));
  try {
    const stage = path.join(workspace, "simple_cluster", "downloads", "mapped_stage", "source.csv");
    const destination = path.join(workspace, "experiments", "results", "a", "raw", "a_seed.csv");
    fs.mkdirSync(path.dirname(stage), { recursive: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(stage, "new");
    fs.writeFileSync(destination, "original");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    let linked = false;
    try { fs.symlinkSync(path.join(outside, "secret.txt"), destination + ".link"); linked = true; }
    catch { linked = false; }
    const { __distributeMappedDownloadsForTest } = require("../../dist/extension/legacy.js");
    if (linked) {
      await assert.rejects(() => __distributeMappedDownloadsForTest(workspace, [{
        remotePath: "simple_cluster/results/w1/raw.csv",
        localRelative: "experiments/results/a/raw/a_seed.csv.link",
        stageRelative: "simple_cluster/downloads/mapped_stage/source.csv",
      }], [{ remotePath: "simple_cluster/results/w1/raw.csv" }], true), /符号链接/);
      assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
    }
    const originalOpen = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith("source.csv"))
        handle.read = async () => { throw new Error("copy interrupted"); };
      return handle;
    };
    try {
      await assert.rejects(() => __distributeMappedDownloadsForTest(workspace, [{
        remotePath: "simple_cluster/results/w1/raw.csv",
        localRelative: "experiments/results/a/raw/a_seed.csv",
        stageRelative: "simple_cluster/downloads/mapped_stage/source.csv",
      }], [{ remotePath: "simple_cluster/results/w1/raw.csv", localRelativePath: "simple_cluster/downloads/mapped_stage/source.csv" }], true), /暂存残留|分发/);
    } finally {
      fs.promises.open = originalOpen;
    }
    assert.equal(fs.readFileSync(destination, "utf8"), "original");
    const originalRealpath = fs.promises.realpath;
    const swappedRealpath = async (target, ...args) => {
      const resolved = await originalRealpath(target, ...args);
      if (String(target).endsWith(`${path.sep}raw`)) return path.join(outside, "secret-dir");
      return resolved;
    };
    try {
      await assert.rejects(() => __distributeMappedDownloadsForTest(workspace, [{
        remotePath: "simple_cluster/results/w1/raw.csv",
        localRelative: "experiments/results/a/raw/a_seed.csv",
        stageRelative: "simple_cluster/downloads/mapped_stage/source.csv",
      }], [{ remotePath: "simple_cluster/results/w1/raw.csv", localRelativePath: "simple_cluster/downloads/mapped_stage/source.csv" }], true, {
        beforeRename() { fs.promises.realpath = swappedRealpath; },
      }), /父目录在写入后发生变化|超出项目根目录|符号链接/);
    } finally {
      fs.promises.realpath = originalRealpath;
    }
    assert.equal(fs.readFileSync(destination, "utf8"), "original");
    assert.equal(fs.existsSync(path.join(outside, "a_seed.csv")), false);
  } finally {
    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: "", scheme: "file", path: "" } }];
  }
});

// Mac lineage anchor ported onto the .403 scenario harness (original syncFixture body is
// preserved verbatim in the mac-align-085 w085/orphan-mac-tests note; its assertion —
// a fractional train_rate and a percent rate_percent land in the same rate_percent
// column — is unchanged).
test('fractional train_rate and percent rate_percent land in the same rate_percent column', async () => {
  const f=scenario(),p=f.addPlan(undefined,{seeds:[42,43]});
  const header='case,seed,method,dataset,train_rate,rate_percent,eval_protocol,AUC\n';
  f.put(p,0,{text:header+'alpha,42,method,set,0.5,,holdout,0.9\n'});
  f.put(p,1,{text:header+'alpha,43,method,set,,50,holdout,0.9\n'});
  const r=await f.update();assert.equal(r.completed,2,JSON.stringify(r.jobs));
  const lines=f.read('set/final/final.csv').trim().split('\n');
  const col=lines[0].split(',').indexOf('rate_percent');
  assert.ok(col>=0,lines[0]);
  // The canonical final table aggregates seeds into one row; the two job notations
  // (fraction train_rate 0.5 and percent rate_percent 50) collapse into the single
  // shared rate_percent column with identical values, so both jobs count in one row.
  assert.equal(lines.length,2,'both jobs aggregated into the single canonical row');
  const row=lines[1].split(',');
  assert.equal(row[col],'50','fraction train_rate and percent rate_percent land in the same column');
  assert.equal(row[lines[0].split(',').indexOf('jobs')],'2');
});
