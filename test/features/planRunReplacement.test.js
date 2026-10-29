const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
require('../_helpers/registerTsRequire');
const {replaceRunOutputs}=require('../../src/features/PlanRunReplacement.ts');
function fixture(){
 const events=[],files=new Set(['job0/old-only.bin','job0/model.pth','job1/failed.log']),operations=new Map(),state={};let choice='rerun_all',cancel=0,fail=false,lost=false,autoDelete=false;
 const jobs=[0,1,2].map(index=>({index,output_dir:'work/job'+index,result_csv:'tmp/result/job'+index+'.csv'}));
 const ports={assertCurrent(){},progress(){},save:async()=>events.push('save'),
 preview:async job=>({token:'op'+job.index,digest:'digest'+job.index,action:'isolate',scope:{},blockers:[],verifiedOnly:false,expiresAt:Date.now()+6e5,confirmations:0,...(autoDelete?{autoDeleteCapability:1}:{}),rows:[{node:{id:'worker',kind:'remote',user:'u',host:'host',port:2222},nodeId:'worker',absolutePath:'/safe/'+job.output_dir,type:'directory',disposition:job.index<2?'isolate':'absent'}]}),
 ask:async p=>{events.push('ask'+p.phase);assert.ok(p.groups[0].targets.every(t=>t.path.startsWith('/safe/')));if(cancel===p.phase)return 'cancel';return p.phase===1?choice:'isolate_and_run';},
 beforeDelete:async()=>{events.push('workers');if(fail)throw Error('nwpu3 unavailable');},hold:async selected=>events.push('hold:'+selected.map(job=>job.index).join(',')),
 verify:async preview=>events.push('verify'+preview.token),
 autoDeleteIsolated:async id=>{events.push('delete'+id);return {state:'accepted'};},
 service:{confirm:async p=>events.push('confirm'+p.phase+p.token),preflightConfirmed:async id=>events.push('check'+id),status:async id=>operations.get(id)||{state:'partial'}},
 // r87 块4：autoDelete='full'/'partial' 模拟 0.2.111 execute 返回携带操作快照——
 // full=每目标完整完成回执（rename、移动当时源缺失、登记成功），partial=登记未成功。
 // r98 B1 口径：此桩替换的是 PlanCleanup 服务层（其 rows.isolationReceipt 是 captureIsolationReceipt 冻结后的
 // 内部形状，与插件线路协议由 PlanCleanup.ts 单点映射）；真实 SFTP 应答形状、五条完成路径与硬门负例
 // 在 planRunIsolateRerun.test.js 的 r98 用例按线路级覆盖，本桩不得引入插件未返回的字段。
 execute:async id=>{events.push('isolate'+id);for(const file of [...files])if(file.startsWith('job'+id.slice(2)+'/'))files.delete(file);const result={state:'completed',pendingNodes:[]};if(autoDelete)result.preview={autoDeleteCapability:1,rows:[{disposition:'isolate',isolationReceipt:{renamed:true,sourceMissingAtMove:true,registered:autoDelete==='full'}}]};operations.set(id,result);if(lost)throw Error('response lost');return result;}};
 return {ports,state,jobs,events,files,set:(v)=>{({choice=choice,cancel=cancel,fail=fail,lost=lost,autoDelete=autoDelete}=v);},run:()=>replaceRunOutputs(ports,state,'plans/p.yaml',jobs,[0],'frozen')};
}
test('overwrite confirms artifact destinations and empty parents twice before isolation; missing-only preserves both',async()=>{
 for(const choice of ['rerun_all','rerun_missing']){
  const f=fixture();f.set({choice,autoDelete:'full'});const pages=[],phases=[],deletes=[];
  f.ports.prepareEmptyParents=async preview=>[{token:'parents-'+preview.token,digest:'d',node:{id:'worker',kind:'remote'},sourceIsolationTokens:[preview.token],confirmations:0,
   confirmationPaths:['/safe/clean_dir/'+preview.token,'/safe/clean_dir/'+preview.token+'/work/job'],
   confirmationTargets:[{absolutePath:'/safe/clean_dir/'+preview.token,type:'directory'},{absolutePath:'/safe/clean_dir/'+preview.token+'/work/job',type:'directory'}]}];
  f.ports.confirmEmptyParents=async (rows,phase)=>{phases.push(phase);for(const row of rows)row.confirmations=phase;};
  const ask=f.ports.ask;f.ports.ask=async page=>{pages.push(page);return ask(page);};
  f.ports.autoDeleteIsolated=async(id,parents)=>{assert.ok(parents.every(row=>row.confirmations===2));deletes.push(id);return{state:'accepted'};};
  await f.run();
  if(choice==='rerun_all'){
   assert.deepEqual(phases,[1,2]);assert.deepEqual(deletes,['op0','op1']);
   for(const page of pages)assert.ok(page.groups[0].targets.some(row=>row.path==='/safe/clean_dir/op0'));
  }else{assert.deepEqual(phases,[]);assert.deepEqual(deletes,[]);assert.ok(!pages[1].groups[0].targets.some(row=>row.path.includes('/clean_dir/')));}
  assert.equal(f.state.emptyParents,undefined,'finished run does not retain deletion inventories');
 }
});
test('cancel second parent confirmation never moves or deletes old outputs',async()=>{
 const f=fixture();f.set({cancel:2,autoDelete:'full'});const phases=[];
 f.ports.prepareEmptyParents=async preview=>[{token:preview.token,confirmationPaths:['/safe/clean_dir/'+preview.token],confirmationTargets:[{absolutePath:'/safe/clean_dir/'+preview.token,type:'directory'}],node:{id:'worker'}}];
 f.ports.confirmEmptyParents=async(_rows,phase)=>phases.push(phase);
 await assert.rejects(f.run(),/已取消/);assert.deepEqual(phases,[1]);assert.equal(f.files.size,3);
 assert.ok(!f.events.some(row=>row.startsWith('isolate')||row.startsWith('delete')));
});
test('parent preview binds all backend chunks to the current node and rejects extra deletion paths',async()=>{
 const {previewEmptyParents,confirmEmptyParents,executeEmptyParents}=require('../../src/features/IsolationEmptyParents.ts');
 const {cleanupDigest}=require('../../src/features/PlanCleanup.ts');
 const node={id:'worker',kind:'remote',root:'/safe',user:'u',host:'h',port:22},batch='job-'+'a'.repeat(48),parent='/safe/clean_dir/'+batch,identity={path:'/safe'};
 const preview={action:'isolate',rows:[0,1].map(i=>({disposition:'isolate',backendToken:'chunk'+i,rootIdentity:identity,node,type:i?'file':'directory',destination:'clean_dir/'+batch+'/work/job'+i}))};
 const calls=[];let foreign=false,unowned=false;
 const ports={currentNode:async()=>node,sftp:async(method,params)=>{calls.push({method,params});
  if(method.endsWith('isolationParentsPreview'))return{eligible:true,isolationParentCleanup:true,token:'parent-token',digest:'digest',rootIdentity:identity,
   sourceIsolationTokens:['chunk0','chunk1'],safety:{emptyDirectoriesOnly:1,doubleConfirmation:1,parentCwdRequired:1},
   targets:unowned?[]:[{absolutePath:foreign?'/safe/other':parent,type:'directory'}],confirmationPaths:[...(unowned?[]:[parent]),...preview.rows.map(row=>'/safe/'+row.destination)]};
  if(method.endsWith('execute'))return{state:'completed',receipt:{emptyDirectoriesRemoved:1}};
  return{ok:true};}};
 const parents=await previewEmptyParents(ports,preview,true);
 assert.deepEqual(calls[0].params.isolationTokens,['chunk0','chunk1']);assert.equal(parents[0].confirmationTargets[2].type,'file');
 await assert.rejects(executeEmptyParents(ports,parents),/CONFIRM_REQUIRED/);
 await confirmEmptyParents(ports,parents,1);await confirmEmptyParents(ports,parents,2);
 assert.equal(await executeEmptyParents(ports,parents),1);
 assert.deepEqual(calls.filter(row=>row.method.endsWith('confirm')).map(row=>row.params.exactTargets),[parents[0].confirmationPaths,parents[0].confirmationPaths]);
 unowned=true;const artifactOnly=await previewEmptyParents(ports,preview,true);assert.equal(artifactOnly.length,1);
 assert.deepEqual(artifactOnly[0].confirmationPaths,preview.rows.map(row=>'/safe/'+row.destination),'unowned containers stay protected; artifacts still need exact confirmations');
 unowned=false;foreign=true;await assert.rejects(previewEmptyParents(ports,preview,true),/空目录清理需要/);
 ports.currentNode=async()=>({...node,root:'/changed'});await assert.rejects(confirmEmptyParents(ports,parents,2),/SERVER_IDENTITY_CHANGED/);
 void cleanupDigest;
});
test('legacy empty-directory review shows the same complete paths twice and cancellation prevents execution',async()=>{
 const {reviewEmptyIsolationParents}=require('../../src/extension/PlanCleanupEmptyParents.ts');
 for(const cancel of [0,1,2]){
  const pages=[],phases=[],messages=[];let executed=0;
  const row={node:{id:'worker',kind:'remote',user:'u',host:'h',port:22},confirmationPaths:['/safe/clean_dir/job-known/work','/safe/clean_dir/job-known']};
  const service={list:async()=>[{id:'original',action:'isolate'}],status:async()=>({preview:{action:'isolate'}}),prepareEmptyParentCleanup:async(_preview,future)=>{assert.equal(future,false);return[row];},
   confirmEmptyParentCleanup:async(rows,phase)=>{assert.deepEqual(rows,[row]);phases.push(phase);},executeEmptyParentCleanup:async()=>{executed++;return 2;}};
  await reviewEmptyIsolationParents({askRunConfirmation:async page=>{pages.push(page);return page.phase===cancel?'cancel':'delete_empty_parents';},notifyWarn:text=>messages.push(text),notifyInfo:text=>messages.push(text)},service,()=>{});
  assert.equal(executed,cancel?0:1);assert.deepEqual(phases,cancel===1?[]:cancel===2?[1]:[1,2]);
  for(const page of pages)assert.deepEqual(page.groups[0].targets.map(target=>target.path),row.confirmationPaths);
 }
});
test('two clicks isolate every selected job directory including stale extra files, then continue without a third review',async()=>{
 const f=fixture(),r=await f.run();assert.deepEqual(r.selectedIndices,[0,1,2]);assert.equal(f.files.size,0);
 assert.deepEqual(f.events.filter(e=>e.startsWith('ask')),['ask1','ask2']);assert.ok(f.events.indexOf('workers')<f.events.indexOf('isolateop0'));assert.equal(f.state.done,true);
 assert.ok(f.events.indexOf('isolateop1')<f.events.indexOf('hold:0,1,2'),'hold runs only after every isolation');
});
test('independent job previews overlap with a bound of two and no confirmation or isolation begins before all finish',async()=>{
 const f=fixture(),preview=f.ports.preview,started=[];let release,active=0,max=0;const gate=new Promise(resolve=>release=resolve);
 f.ports.preview=async job=>{started.push(job.index);max=Math.max(max,++active);if(job.index===0)await gate;const result=await preview(job);active--;return result;};
 const pending=f.run();await new Promise(setImmediate);const advanced=started.includes(1);assert.equal(f.events.some(e=>e.startsWith('ask')||e.startsWith('isolate')),false);release();await pending;
 assert.equal(advanced,true);assert.equal(max,2);assert.deepEqual(f.state.previews.map(row=>row.index),[0,1,2]);
});
test('missing-only keeps complete job, isolates incomplete job, and starts absent job',async()=>{
 const f=fixture();f.set({choice:'rerun_missing'});const r=await f.run();assert.deepEqual(r.selectedIndices,[1,2]);assert.ok(f.files.has('job0/model.pth'));assert.ok(!f.files.has('job1/failed.log'));
});

test('missing-only resumption cannot silently retain an older broader isolation selection',async()=>{
 const f=fixture();f.state.choice='rerun_missing';f.state.selectedIndices=[0,1,2];f.state.phase=1;
 await assert.rejects(f.run(),/范围已变化/);assert.ok(!f.events.some(e=>e.startsWith('isolate')));assert.equal(f.files.size,3);
});
test('cancel either prompt and failed all-Worker recheck never isolate; retry retains the same confirmed batch',async()=>{
 for(const phase of [1,2]){const f=fixture();f.set({cancel:phase});await assert.rejects(f.run(),/已取消/);assert.ok(!f.events.some(e=>e.startsWith('isolate')));}
 const f=fixture();f.set({fail:true});await assert.rejects(f.run(),/nwpu3/);assert.ok(!f.events.some(e=>e.startsWith('isolate')));
 f.set({fail:false});await f.run();assert.deepEqual(f.events.filter(e=>e.startsWith('ask')),['ask1','ask2']);
});
test('lost execute responses reconcile by active status, resume never repeats a completed isolation, changed declarations reject',async()=>{
 const f=fixture();f.set({lost:true});await f.run();await f.run();assert.equal(f.events.filter(e=>e==='isolateop0').length,1);
 await assert.rejects(replaceRunOutputs(f.ports,f.state,'plans/p.yaml',f.jobs,[0],'changed'),/已变化/);
});
test('an unfinished delete-first state from the previous flow is re-previewed as isolation without executing old tokens',async()=>{
 const f=fixture();f.state.previews=[{index:0,preview:{token:'old-token',digest:'d',action:'delete',scope:{},rows:[],blockers:[],verifiedOnly:false,expiresAt:Date.now()+6e5,confirmations:0}}];f.state.choice='rerun_all';f.state.phase=1;
 const r=await f.run();assert.equal(f.state.flow,'isolate');assert.ok(f.state.previews.some(row=>row.preview.action==='isolate'));
 assert.ok(!f.events.some(e=>e==='confirm1old-token'));assert.deepEqual(r.selectedIndices,[0,1,2]);
});
// r82（0.5.414）：运行选择与安全准入分离——返回值必须同时携带 selectedIndices 与结构化 blocked；
// blocked 是"隔离未完成/核验未知"的准入排除，不是用户跳过，也不得被当作已授权凭证。413 上红（无 blocked 字段）。
test('r82 red: a clean run still reports its admission split explicitly: selected plus an empty blocked list',async()=>{
 const f=fixture(),r=await f.run();
 assert.ok(Array.isArray(r.blocked),'成功轮次也必须显式返回 blocked=[]，让下游无法把缺字段当"无阻断"或"全放行"');
 assert.deepEqual(r.blocked,[]);assert.deepEqual(r.selectedIndices,[0,1,2]);
});

test('actual injected modal script renders full paths and sends only one correlated answer per click',()=>{
 const html=require('../../src/ui/RunConfirmation.ts').withRunConfirmation('<body><script nonce="allowed"></script></body>');const scripts=[...html.matchAll(/<script nonce="allowed">([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,2);const script=scripts[1][1];new vm.Script(script);
 const handlers={},sent=[],nodes={};function node(){return {textContent:'',hidden:true,children:[],appendChild(child){this.children.push(child);},focus(){},addEventListener(type,fn){handlers[type]=fn;},querySelector(key){return nodes[key]||=node();},querySelectorAll(){return nodes['.buttons'].children;}};}
 const dialog=node();vm.runInNewContext(script,{window:{addEventListener:(name,fn)=>handlers[name]=fn},document:{getElementById:()=>dialog,createElement:()=>node()},vscode:{postMessage:m=>sent.push(m)}});
 const full='/safe/'+('中文 very long path/'.repeat(60))+'model';handlers.message({data:{type:'planRunConfirmation',requestId:'request1',payload:{title:'confirm',planFile:'p.yaml',phase:2,groups:[{value:'isolate_and_run',label:'隔离并重跑',targets:[{path:full,server:'w',connection:'u@h:22',type:'directory'}]}]}}});
 assert.ok(nodes['.paths'].children.some(n=>n.textContent.includes(full)));const button=nodes['.buttons'].children[0];button.onclick();button.onclick();assert.equal(sent.length,1);assert.equal(sent[0].requestId,'request1');
});
// r87 块4（0.5.414）：隔离完成即派发 + 后台自动删接线。回执齐备（rename、移动当时源缺失、登记成功）
// 即准入，后台删除是旁路任务绝不进 await 链；能力缺失保持旧复核链并明确提示需更新插件。
test('r87 block4: complete isolation receipts admit immediately — background delete is fired off the dispatch chain and verify is skipped',async()=>{
 const f=fixture();let release;const blockedDelete=new Promise(resolve=>{release=resolve;});const deleted=[];
 f.set({autoDelete:'full'});f.ports.autoDeleteIsolated=async id=>{deleted.push(id);await blockedDelete;return {state:'accepted'};};
 const r=await f.run();
 assert.deepEqual(r.selectedIndices,[0,1,2]);assert.deepEqual(r.blocked,[]);
 assert.deepEqual(deleted,['op0','op1'],'仅本批已隔离完成的令牌提交后台删除；absent 的 job2 无令牌可删');
 assert.ok(!f.events.some(e=>e.startsWith('verify')),'回执齐备后不再逐条复核原路径（不再读隔离副本后才派发）');
 assert.ok(f.events.includes('hold:0,1,2'),'删除请求仍悬而未决时 hold/派发已经完成——后台删除不在 await 链上');
 release();
});
test('r87 block4: capability reported with an incomplete receipt blocks that job as unverified, dispatches nothing for it and never starts a background delete',async()=>{
 const f=fixture();const deleted=[];f.set({autoDelete:'partial'});f.ports.autoDeleteIsolated=async id=>{deleted.push(id);return {state:'accepted'};};
 const r=await f.run();
 assert.deepEqual(r.selectedIndices,[2],'登记未成功的 job 不准入，独立 job 不被整批拖住');
 assert.deepEqual(r.blocked.map(row=>[row.index,row.stage]),[[0,'verify'],[1,'verify']]);
 assert.ok(r.blocked.every(row=>/回执不完整/.test(row.reason)));
 assert.deepEqual(deleted,[],'回执不全的 token 不提交后台删除');
 assert.ok(!f.events.some(e=>e.startsWith('verify')),'能力已上报时不再走旧逐条复核链');
});
test('r87 block4: rerun_missing with complete receipts still skips verify but never auto-deletes (deletion authorization is rerun_all-only)',async()=>{
 const f=fixture();const deleted=[];f.set({choice:'rerun_missing',autoDelete:'full'});f.ports.autoDeleteIsolated=async id=>{deleted.push(id);return {state:'accepted'};};
 const r=await f.run();
 assert.deepEqual(r.selectedIndices,[1,2]);assert.ok(f.files.has('job0/model.pth'),'补跑不覆盖完成 job，其旧副本更不许被自动删');
 assert.deepEqual(deleted,[],'rerun_missing 不触发后台删除');
 assert.ok(!f.events.some(e=>e.startsWith('verify')));
});
test('r87 block4: an old plugin without the capability keeps the verify chain untouched and tells the user 0.2.111 is required',async()=>{
 const f=fixture();const notes=[];f.ports.progress=text=>notes.push(text);
 const r=await f.run();
 assert.deepEqual(r.selectedIndices,[0,1,2]);assert.deepEqual(r.blocked,[]);
 assert.ok(f.events.includes('verifyop0')&&f.events.includes('verifyop1'),'能力缺失时旧逐条复核链原样保留，不削弱');
 assert.ok(!f.events.some(e=>e.startsWith('delete')),'旧插件绝不调用新删除接口');
 assert.ok(notes.some(text=>/0\.2\.111/.test(text)&&/不会自动删除/.test(text)),'兼容矩阵行1：明确提示自动清理需更新 SimpleSFTP 到 0.2.111');
});
