const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
require('./registerTsRequire');
const { ResultCollectionHost } = require('../../src/extension/ResultCollectionHost.ts');
const { resultDigest } = require('../../src/results/FreshResults.ts');
const exportsApi = require('../../src/results/LatestResultExport.ts');
const originalLoad = Module._load;
let Provider;
try {
  Module._load = function (name, ...args) {
    if (name === 'vscode') return {workspace:{getConfiguration:()=>({get:(_name,fallback)=>fallback})},
      Uri:{file:fsPath=>({fsPath})},ProgressLocation:{Notification:1},
      window:{withProgress:async(_options,work)=>work({report(){}},{isCancellationRequested:false}),showInformationMessage:async()=>{},showWarningMessage:async()=>{}}};
    return originalLoad.call(this,name,...args);
  };
  Provider = require('../../dist/extension/legacy').RealtimeTunnelPanelProvider;
} finally { Module._load = originalLoad; }

// Private transport fixtures, not a runtime emulator. All discovery, ownership,
// parsing, validation, batching and publication decisions run production code.
function scenario({workerIds=['w1','w2'], directory='artifacts/results'}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'current-result-contract-'));
  const workers=workerIds.map(id=>({id,host:id+'.invalid',user:'fixture',port:2222,remotePath:'/private/'+id}));
  const plans=[], storage=new Map(workerIds.map(id=>[id,new Map()])), copies=new Map(), calls=[], failures=new Map(), rules={};
  let current=true, discoveryOverride, observationOverride, receiveOverride, wait;
  const host={
    resultCsvDirectory:directory, panelDisposed:false,
    captureProjectContext:()=>({root,generation:1}), projectContextIsCurrent:()=>current,
    workerCodeSyncTargets:()=>workers,
    currentResultPlanInputs:async()=>plans.map(({jobs,...plan})=>({...plan})),
    resultAdapterRules:()=>rules,
    parseFreshResultMetric:Provider.prototype.parseFreshResultMetric,
    sftpServerOptions:row=>({...row}),
    simpleSftpCapability:async()=>({methodOptions:{'sync.downloadMappedPaths':{memoryOnly:true,memoryWrapperResults:true}}}),
    client:{getWorkerTasks:async(id,options)=>{
      calls.push({kind:options.discovery?'discovery':'observation',id,options});
      assert.equal(options.queries?.length||0,0,'no terminal-history task query');
      if(wait)await wait;
      if(failures.has(id))throw Error(failures.get(id));
      if(options.discovery){
        const plan=plans.find(p=>p.planFile===options.discovery.planFile);
        const value={queryComplete:true,capabilities:{resultCollection:1},declaredJobs:plan.jobs.map(j=>({...j,planHash:plan.revision}))};
        return discoveryOverride?discoveryOverride(id,options,value):value;
      }
      const declaredResults=options.declarations.map(declaration=>{
        const proof=copies.get(id+'\0'+declaration.output_dir);
        if(!proof)return {index:declaration.index,outputDir:declaration.output_dir,completed:false,resultState:'missing'};
        const names=[declaration.output_dir+'/artifact_manifest.json',...(declaration.mode==='train'?[]:[declaration.result_csv])];
        return {index:declaration.index,outputDir:declaration.output_dir,collectionResultCsv:declaration.result_csv,completed:true,...proof,
          files:names.filter(name=>storage.get(id).has(name)).map(remotePath=>{const bytes=storage.get(id).get(remotePath);return {remotePath,bytes:bytes.length,sha256:resultDigest(bytes)};})};
      });
      const value={queryComplete:true,capabilities:{resultCollection:1},tasks:[],declaredResults};
      return observationOverride?observationOverride(id,options,value):value;
    }},
    simpleSftpApiCall:async(method,params)=>{
      calls.push({kind:'receive',method,params});assert.equal(method,'sync.downloadMappedPaths');
      assert.equal(params.memoryOnly,true);assert.equal(params.metricsOnly,true);assert.equal(params.wrapperResults,true);
      assert.ok(params.entries.reduce((n,e)=>n+e.bytes,0)<=4*1024*1024);
      const value={ok:true,memoryOnly:true,entries:params.entries.map(e=>({...e,dataBase64:storage.get(params.server.id).get(e.remotePath).toString('base64')}))};
      return receiveOverride?receiveOverride(params,value):value;
    },
    refreshLocalResultCatalogForProject:async()=>{},postState(){},recordActionError(){},
    loadProjectTableRegistry:()=>assert.fail('old registry cannot supply current results'),
    loadDistributedQueue:()=>assert.fail('old queue cannot supply result bytes'),
    loadPlanSyncLedger:()=>assert.fail('old transfer ledger cannot supply current results'),
    hostOperationLease:{run:()=>assert.fail('no persistent result lease')},
  };
  const service=new ResultCollectionHost(host);
  function addPlan(planFile='experiments/plans/demo.yaml', {seeds=[42,43],cases=['alpha'],mode='test'}={}) {
    const text=JSON.stringify({planFile,seeds,cases,mode});
    fs.mkdirSync(path.dirname(path.join(root,planFile)),{recursive:true});fs.writeFileSync(path.join(root,planFile),text);
    const key=resultDigest(planFile).slice(0,12);
    const jobs=cases.flatMap(caseName=>seeds.map(seed=>({index:0,case:caseName,seed,output_dir:`work_dirs/${key}/${caseName}_${seed}`,result_csv:`tmp/result/${key}/${caseName}_${seed}.csv`}))).map((j,index)=>({...j,index}));
    const plan={planFile,revision:resultDigest(text),seeds,mode,jobCount:jobs.length,jobs};plans.push(plan);return plan;
  }
  function put(plan,index,{workerId=workerIds[0],runId='command-'+index,metric=.92,dataset='set',method='method',outcome='completed',exitCode=0,text,diagnostics}={}) {
    const job=plan.jobs.find(j=>j.index===index), files=storage.get(workerId);
    text ??= `case,seed,method,dataset,eval_protocol,metric,value\n${job.case},${job.seed},${method},${dataset},clean,AUC,${metric}\n`;
    const manifest={simpleExperiment:{runId,status:outcome,mode:plan.mode,job:{index,case:job.case,seed:job.seed},outputDir:job.output_dir,resultCsv:job.result_csv,weights:[],exitCode}};
    files.set(job.output_dir+'/artifact_manifest.json',Buffer.from(JSON.stringify(manifest)));
    if(plan.mode!=='train')files.set(job.result_csv,Buffer.from(text));
    copies.set(workerId+'\0'+job.output_dir,{runId,executionStatus:outcome,exitCode,runtimeDiagnostics:diagnostics||{schemaVersion:1,commandId:runId,runId,state:'clear',count:0,scanComplete:true}});
    return job;
  }
  const snapshot=()=>JSON.parse(fs.readFileSync(path.join(root,directory,exportsApi.LATEST_RESULT_FILE),'utf8'));
  return {root,workers,plans,storage,copies,calls,rules,host,service,addPlan,put,snapshot,
    update:()=>service.update(),catalog:()=>exportsApi.latestResultCatalog(root,directory),
    offline:(id,message='ECONNREFUSED fixture')=>failures.set(id,message),online:id=>failures.delete(id),
    current:value=>{current=value;},block:promise=>{wait=promise;},
    discovery:fn=>{discoveryOverride=fn;},observation:fn=>{observationOverride=fn;},receive:fn=>{receiveOverride=fn;},
    read:relative=>fs.readFileSync(path.join(root,directory,relative),'utf8'),
  };
}
module.exports={scenario,resultDigest,exportsApi,Provider};
