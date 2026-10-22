const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {resultDigest}=require('../../dist/results/FreshResults');
const tables=require('../../dist/results/ProjectResultTables');

// Real ResultCollectionHost inputs; the queue and old registry never supply bytes or proof.
function currentResultHost(Provider, options={}) {
  const root=options.root || fs.mkdtempSync(path.join(os.tmpdir(),'current-result-host-'));
  const rows=options.rows || [42,43,44].map(seed=>({planFile:'experiments/plans/comparison/demo.yaml',case:'case-one',seed:String(seed),method:'unknown_method',dataset:'arbitrary_set',metrics:{AUC:.92}}));
  const files=new Map(),calls=[],inputs=[],declarations=new Map(),workers=new Map(),states=new Map();
  const planNames=[...new Set(rows.map(row=>row.planFile))];
  for(const [planIndex,planFile] of planNames.entries()) {
    const records=rows.filter(row=>row.planFile===planFile),seeds=[...new Set(records.map(row=>Number(row.seed)))];
    const text=`suite: fixture-${planIndex}\nmode: test\nbase_config: configs/base.yaml\nseeds: [${seeds.join(',')}]\ncases: [{case: case-one}]\ntest_command: python fixture.py\n`;
    const file=path.join(root,planFile);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);
    inputs.push({planFile,revision:resultDigest(text),mode:'test',seeds,jobCount:new Set(records.map(row=>row.case+':'+row.seed)).size});
    const groups=new Map();for(const row of records){const key=row.case+':'+row.seed;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
    const jobs=[...groups.values()].map((group,index)=>{
      const first=group[0],output_dir=`work_dirs/p${planIndex}/job${index}`,result_csv=output_dir+'/metrics.csv';
      const declaration={index,case:first.case,seed:Number(first.seed),output_dir,result_csv,planHash:resultDigest(text)};
      const runId=`command-p${planIndex}-s${first.seed}`;
      const manifest={simpleExperiment:{runId,status:'completed',mode:'test',job:{index,case:first.case,seed:Number(first.seed)},
        outputDir:output_dir,resultCsv:result_csv,weights:[],planFile,planRevision:resultDigest(text)}};
      files.set(output_dir+'/artifact_manifest.json',Buffer.from(JSON.stringify(manifest)));
      files.set(result_csv,Buffer.from(tables.writeCsv(['case','seed','method','dataset','rate_percent','eval_protocol','metric','value'],group.flatMap(row=>Object.entries(row.metrics).map(([metric,value])=>[row.case,row.seed,row.method,row.dataset,row.rate||'',row.endpoint||'',metric,typeof value==='object'?value.value:value])))));
      workers.set(output_dir,'owner');states.set(output_dir,{completed:true,runId});return declaration;
    });declarations.set(planFile,jobs);
  }
  const workerIds=new Set(['owner',...(options.workerIds||[])]);
  const targets=()=>[...workerIds].map(id=>({id,host:'fixture.invalid',user:'fixture',port:2222,remotePath:'/fixture/project'}));
  const host=Object.assign(Object.create(Provider.prototype),{context:{globalStorageUri:{fsPath:root}},setupConfig:{workerTunnels:[]},
    resultCsvDirectory:options.directory||'experiments/results',captureProjectContext:()=>({root,generation:1}),projectContextIsCurrent:()=>true,
    currentResultPlanInputs:async()=>inputs,workerCodeSyncTargets:targets,sftpServerOptions:target=>target,
    resultAdapterRules:()=>options.rules?.()||{},refreshLocalResultCatalogForProject:async()=>{},postState(){},recordActionError(error){calls.push({method:'error',error});},
    simpleSftpCapability:async()=>({methodOptions:{'sync.downloadMappedPaths':{memoryOnly:true,memoryWrapperResults:true}}}),
    client:{getWorkerTasks:async(workerId,request)=>{
      calls.push({method:'tasks',workerId,request});assert.ok(workerIds.has(workerId));
      if(request.discovery)return {queryComplete:true,capabilities:{resultCollection:1},declaredJobs:declarations.get(request.discovery.planFile)};
      assert.deepEqual(request.queries,[]);
      return {queryComplete:true,capabilities:{resultCollection:1},tasks:[],declaredResults:request.declarations.filter(job=>workers.get(job.output_dir)===workerId).map(job=>{
        const state=states.get(job.output_dir);return {index:job.index,outputDir:job.output_dir,...state,
          runtimeDiagnostics:{schemaVersion:1,commandId:state.runId,runId:state.runId,state:'clear',count:0,scanComplete:true},
          files:[job.output_dir+'/artifact_manifest.json',...(job.mode==='train'?[]:[job.result_csv])].filter(file=>files.has(file)).map(remotePath=>({remotePath,bytes:files.get(remotePath).length,sha256:resultDigest(files.get(remotePath))}))};})};
    }},
    simpleSftpApiCall:async(method,params)=>{
      calls.push({method,params});assert.equal(method,'sync.downloadMappedPaths');assert.equal(params.memoryOnly,true);assert.equal(params.wrapperResults,true);
      return {ok:true,memoryOnly:true,entries:params.entries.map(entry=>({...entry,dataBase64:files.get(entry.remotePath).toString('base64')}))};
    },
    loadDistributedQueue:()=>assert.fail('queue is not a result authority'),loadPlanSyncLedger:()=>assert.fail('ledger is not a result authority'),loadProjectTableRegistry:()=>assert.fail('registry is not a result authority'),
  });
  return {root,host,files,calls,inputs,declarations,workers,states,workerIds,
    sync:()=>host.rebuildProjectResultTablesFromUi(),
    exported:()=>JSON.parse(fs.readFileSync(path.join(root,host.resultCsvDirectory,'latest-results.json'),'utf8')),
    catalog:()=>require('../../dist/results/LatestResultExport').latestResultCatalog(root,host.resultCsvDirectory)};
}
module.exports={currentResultHost};
