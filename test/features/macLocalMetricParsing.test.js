const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const ts = require('typescript'), { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..'), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const plan = 'Plans/ 计划 A.yaml ', remote = 'runs/ 中文 / 指标.csv ';
const csv = Buffer.from('case,seed,method,dataset,metric,value\nalpha,42,M,数据,AUC,0.7\n');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(platform = 'darwin') {
  const workspace = '/工作区 项目', nodes = new Map([[workspace, { directory:true, ino:1 }]]);
  const state = { opens:0, closes:0, reads:0, accesses:0, unboundReads:0, nodes }; let nextIno=2;
  const folded = name => name.normalize('NFD').toLowerCase();
  const find = name => [...nodes].find(([key]) => folded(key) === folded(name));
  const stat = node => ({ dev:1, ino:node.ino, size:node.bytes?.length||0, mtimeMs:node.mtimeMs||10000, ctimeMs:node.ctimeMs||10000,
    isDirectory:()=>node.directory===true, isFile:()=>!node.directory&&!node.symlink&&!node.special, isSymbolicLink:()=>node.symlink===true });
  const filesystem = {
    lstat:async name => { state.accesses++; const row=find(name); if(!row) throw Object.assign(Error('missing'),{code:'ENOENT'}); return stat(row[1]); },
    realpath:async name => find(name)?.[0]||name,
    readdir:async directory => [...nodes.keys()].filter(name=>path.posix.dirname(name)===directory&&name!==directory).map(name=>path.posix.basename(name)),
    readFile:async () => { state.unboundReads++; throw Error('unbound path read must not run'); },
    open:async name => {
      state.opens++; state.beforeOpen?.(name); const node=find(name)[1];
      return { stat:async()=>stat(node), read:async(buffer,offset,length,position)=>{
        state.reads++; state.onRead?.(name,node); return {bytesRead:node.bytes.copy(buffer,offset,position,position+length)};
      }, close:async()=>{state.closes++;} };
    },
  };
  const cache = new Map();
  function compiled(relative) {
    const file=path.join(root,relative); if(cache.has(file)) return cache.get(file).exports;
    const module={exports:{}}; cache.set(file,module); const local=createRequire(file);
    vm.runInNewContext(fs.readFileSync(file,'utf8'), {module,exports:module.exports,Buffer,TextDecoder,process:{platform},
      require:name=> name==='node:fs/promises'?filesystem : name==='node:path'||name==='path'?path.posix :
        name.startsWith('.')&&path.resolve(path.dirname(file),name).startsWith(path.join(root,'dist')+path.sep)
          ?compiled(path.relative(root,path.resolve(path.dirname(file),name)+(path.extname(name)?'':'.js'))) :local(name)}, {filename:file});
    return module.exports;
  }
  const source=fs.readFileSync(path.join(root,'dist/extension/legacy.js'),'utf8'), ast=ts.createSourceFile('actual.js',source,ts.ScriptTarget.Latest,true);
  const funcs=new Map(), methods=new Map();
  (function visit(node){
    if(ts.isFunctionDeclaration(node)&&node.name)funcs.set(node.name.text,node.getText(ast));
    if(ts.isMethodDeclaration(node))methods.set(node.name.getText(ast),node.getText(ast));ts.forEachChild(node,visit);
  })(ast);
  const names=['mappedResultPath','normalizeRemoteResultInspectionPath','methodResultArtifactLocalRelativePath','normalizeResultCsvDir','safePlanToken','uniqueStrings','isResultMetricFile','parseDownloadedMetricCsv'];
  const context=vm.createContext({Buffer,TextDecoder,crypto,Map,Set,process:{platform},fs:filesystem,path:path.posix,
    PosixPath_1:compiled('dist/mac/PosixPath.js'), FileTransferTypes_1:require('../../dist/tunnel/FileTransferTypes'),
    ProjectResultTables:compiled('dist/results/ProjectResultTables.js'), WrapperResultBundle:compiled('dist/results/WrapperResultBundle.js'),
    MacResultSummaryScope:compiled('dist/mac/ResultSummaryScope.js'), MacResultFiles:compiled('dist/mac/ResultFiles.js'),
    MacMetricInput:compiled('dist/mac/MetricInput.js'), DEFAULT_RESULT_CSV_DIR:'experiments/results',
    pluginProjectAdapterRules:()=>({csvColumnMapping:{}}), safeWorkspaceChildPath:(base,relative)=>path.posix.join(base,relative)});
  vm.runInContext(names.map(name=>{assert.ok(funcs.has(name),name);return funcs.get(name);}).join('\n')+
    '\nclass Provider {'+methods.get('summaryFromLocalMetricFiles')+'}\nthis.api={Provider,methodResultArtifactLocalRelativePath};',context);
  const api=context.api, provider=new api.Provider();
  const summary=(file=remote,planFile=plan,bytes=csv)=>({planFile,planRevision:'rev',completedRunId:'R',runId:'R',results:[],
    workerResultTables:[{workerId:'Worker',rawResultCsvPath:file,metricHashes:{[file]:sha(bytes)},metricSizes:{[file]:bytes.length}}]});
  function add(relative,bytes) {
    let full=workspace;for(const [index,part]of relative.split('/').entries()) {
      full+='/'+part;if(!nodes.has(full))nodes.set(full,{ino:nextIno++,directory:index<relative.split('/').length-1});
    }
    nodes.set(full,{ino:nodes.get(full).ino,bytes,mtimeMs:10000,ctimeMs:10000});return full;
  }
  const local=(file,selectedPlan,s)=>api.methodResultArtifactLocalRelativePath(file,selectedPlan,s);
  const parse=(s,selectedPlan=plan,options={authoritativeLocal:true,completedRunId:'R'})=>provider.summaryFromLocalMetricFiles(workspace,selectedPlan,s,options);
  return {state,workspace,provider,summary,add,local,parse,compiled};
}

test('actual compiled Mac CSV parser reads exact Plan/source bytes and checked descriptor timestamp',async()=>{
  const f=fixture(), plans=[plan,plan.toLowerCase(),plan.replace('A.yaml','A%20.yaml'),plan.replace('A.yaml','é.yaml'),plan.replace('A.yaml','e\u0301.yaml')];
  const mapped=[];
  for(const selected of plans){const s=f.summary(remote,selected),relative=f.local(remote,selected,s);mapped.push(relative);f.add(relative,csv);
    const result=await f.parse(s,selected);assert.equal(result.planFile,selected);assert.equal(result.results[0].sourceFiles[0].path,remote);
    assert.equal(result.results[0].metrics.AUC.value,0.7);assert.equal(result.results[0].runId,'R');assert.equal(result.results[0].planRevision,'rev');}
  assert.equal(new Set(mapped).size,plans.length);assert.equal(f.state.opens,plans.length);assert.equal(f.state.closes,plans.length);assert.equal(f.state.unboundReads,0);
  const s=f.summary();s.lastParsedAt=new Date(20000).toISOString();s.results=[{workerId:'Worker'}];
  assert.equal(await f.parse(s,plan,{}),undefined,'descriptor mtime prevents stale local data replacing the online generation');
});
test('foreign, anonymous or conflicting Plan evidence cannot read or stamp local bytes',async()=>{
  const f=fixture();
  for(const s of [f.summary(remote,'Other/A.yaml'),{...f.summary(),plan_file:'Other/A.yaml'},{...f.summary(),planFile:undefined},
    {...f.summary(),workerResultTables:[{...f.summary().workerResultTables[0],completedJob:{planFile:'Other/A.yaml'}}]}])
    assert.equal(await f.parse(s),undefined);
  assert.equal(f.state.accesses,0);assert.equal(f.state.opens,0);
  for(const bad of [null,3,{},'', '/A.yaml','a\\b.yaml','a/../b.yaml'])await assert.rejects(()=>f.parse(f.summary(),bad),/相对路径/);
  for(const bad of [null,3,{},'a\\b.csv','a/../b.csv'])await assert.rejects(()=>f.parse(f.summary(bad)),/相对路径/);
  for(const bad of [null,'',3,{},['a\\b.csv']])await assert.rejects(()=>f.parse({...f.summary(),workerResultTables:[{...f.summary().workerResultTables[0],metricPaths:bad}]}),/清单|相对路径/);
  assert.equal(f.state.accesses,0);
});
test('real compiled local parser rejects aliases, special files, growth, replacement and invalid UTF8 before producing results',async()=>{
  for(const fault of ['alias','symlink','special','oversize','utf8','changed','parent']){
    const f=fixture(),s=f.summary(),relative=f.local(remote,plan,s),full=f.add(relative,csv),node=f.state.nodes.get(full);
    if(fault==='alias'){f.state.nodes.delete(full);f.state.nodes.set(full.toUpperCase(),node);}
    if(fault==='symlink'||fault==='special')node[fault]=true;
    if(fault==='oversize')node.bytes=Buffer.alloc(4*1024*1024+1);
    if(fault==='utf8'){node.bytes=Buffer.from([255]);s.workerResultTables[0].metricHashes[remote]=sha(node.bytes);s.workerResultTables[0].metricSizes[remote]=1;}
    if(fault==='changed')f.state.onRead=(_name,opened)=>{opened.ctimeMs++;};
    if(fault==='parent')f.state.onRead=()=>{f.state.nodes.get(path.posix.dirname(full)).ino++;};
    await assert.rejects(()=>f.parse(s),/拼写|符号链接|文件类型|上限|utf-8|变化/);assert.equal(f.state.unboundReads,0);assert.equal(f.state.closes,f.state.opens);
  }
});
test('primary local inventory hash or size mismatches cannot be relabelled as verified inputs',async()=>{
  for(const change of [{metricHashes:{[remote]:'0'.repeat(64)}},{metricSizes:{[remote]:csv.length+1}},{metricSizes:{[remote]:'1'}},{metricHashes:{[remote]:null}}]){
    const f=fixture(),s=f.summary();f.add(f.local(remote,plan,s),csv);Object.assign(s.workerResultTables[0],change);
    await assert.rejects(()=>f.parse(s),/清单大小|hash 无效/);assert.equal(f.state.unboundReads,0);assert.equal(f.state.closes,f.state.opens);
  }
});
test('memory parsing verifies actual source bytes and discards untrusted cached rows',async()=>{
  const f=fixture(),s=f.summary(),input={remotePath:remote,text:csv.toString(),bytes:csv.length,sha256:sha(csv),rows:[{metrics:{AUC:{value:99}}}]};
  const parse=value=>f.parse(s,plan,{authoritativeLocal:true,completedRunId:'R',memoryMetricFiles:new Map([['Worker\0'+remote,value]])});
  assert.equal((await parse(input)).results[0].metrics.AUC.value,0.7);
  s.workerResultTables[0].metricHashes[remote]=sha(csv).toUpperCase();
  assert.equal((await parse({...input,sha256:sha(csv).toUpperCase()})).results[0].metrics.AUC.value,0.7);
  for(const bad of [null,0,{...input,remotePath:remote.replace('指标.csv','指标.CSV')},{...input,sha256:'0'.repeat(64)},{...input,bytes:csv.length+1},
    {...input,text:'\ud800'},{...input,encoding:'base64'}])await assert.rejects(()=>parse(bad),/输入|来源|编码|清单/);
  assert.equal(f.state.accesses,0);assert.equal(f.state.unboundReads,0);
});
test('actual compiled wrapper local/memory branches keep binary bytes, original names and the same job generation',async()=>{
  for(const mode of ['local','memory']){
    const f=fixture(),s=f.summary(),json=remote.replace('指标.csv','报告.json'),binary=remote.replace('指标.csv','mask.npz');
    const values=new Map([[remote,csv],[json,Buffer.from('{"run_id":"R","case":"alpha","seed":42}')],[binary,Buffer.from([0,255,2])]]);
    const table=s.workerResultTables[0];Object.assign(table,{metricPaths:[...values.keys()],requiredMetricPaths:[...values.keys()],
      metricHashes:Object.fromEntries([...values].map(([file,bytes])=>[file,sha(bytes)])),metricSizes:Object.fromEntries([...values].map(([file,bytes])=>[file,bytes.length])),
      completedJob:{index:0,case:'alpha',seed:42,attempt:1,runId:'R',commandId:'command',outputDir:'runs/ 中文 '}});
    s.expectedMetricJobs=[{case:'alpha',seed:42}];
    const memory=new Map();for(const[file,bytes]of values){f.add(f.local(file,plan,s),bytes);memory.set('Worker\0'+file,
      {remotePath:file,bytes:bytes.length,sha256:sha(bytes),text:file===binary?bytes.toString('base64'):bytes.toString(),...(file===binary?{encoding:'base64'}:{})});}
    const result=await f.parse(s,plan,{authoritativeLocal:true,completedRunId:'R',...(mode==='memory'?{memoryMetricFiles:memory}:{})});
    assert.equal(result.wrapperEvidence.runId,'R');assert.deepEqual(plain(result.wrapperEvidence.jobs[0].sources).map(row=>row.remotePath).sort(),[...values.keys()].sort());
    const output=result._wrapperFiles.find(file=>file.immutable&&Buffer.isBuffer(file.contents));assert.deepEqual(output.contents,values.get(binary));
    assert.equal(f.state.opens,mode==='memory'?0:3,'the primary endpoint must be reused from its checked snapshot');
    assert.equal(f.state.opens,f.state.closes);assert.equal(f.state.unboundReads,0);
    table.metricHashes[json]='0'.repeat(64);await assert.rejects(()=>f.parse(s,plan,{authoritativeLocal:true,completedRunId:'R',...(mode==='memory'?{memoryMetricFiles:memory}:{})}),/SHA256/);
  }
});
test('empty ordinary binary wrapper input remains present without inventing metric rows',async()=>{
  const f=fixture(),file=remote.replace('指标.csv','empty.npz'),s=f.summary(file,plan,Buffer.alloc(0)),table=s.workerResultTables[0];
  Object.assign(table,{wrapperOnly:true,completedJob:{index:0,case:'alpha',seed:42,attempt:1,runId:'R',commandId:'command',outputDir:'runs/ 中文 '}});
  s.expectedMetricJobs=[{case:'alpha',seed:42}];f.add(f.local(file,plan,s),Buffer.alloc(0));
  const result=await f.parse(s);assert.equal(result.results.length,0);assert.equal(result.wrapperEvidence.jobs[0].sources[0].bytes,0);
  assert.equal(result.wrapperEvidence.jobs[0].sources[0].remotePath,file);assert.equal(f.state.opens,1);assert.equal(f.state.closes,1);
});
test('Mac format recognition keeps spelling and excludes checkpoint/source suffixes with edge spaces',()=>{
  const mac=fixture().compiled('dist/results/WrapperResultBundle.js'),other=fixture('win32').compiled('dist/results/WrapperResultBundle.js');
  assert.equal(mac.isWrapperResultFile(remote),true);assert.equal(mac.isWrapperTextFile(remote),true);assert.equal(other.isWrapperResultFile(remote),false);
  for(const file of ['runs/A.pth ','runs/A.py ','runs/checkpoints/A.csv '])assert.equal(mac.isWrapperResultFile(file),false);
});
