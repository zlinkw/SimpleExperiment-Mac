const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),Module=require('node:module');
require('../_helpers/registerTsRequire');
const {expandSyncScopeBatchSelection}=require('../../src/features/SyncScopeBatch.ts');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
function webview(roots=[]){
 let html,host,dispose;const hostMessages=[];const original=Module._load;Module._load=function(name,...args){return name==='vscode'?{ViewColumn:{Active:1},window:{createWebviewPanel:()=>({onDidDispose(fn){dispose=fn;},webview:{set html(value){html=value;},postMessage:async m=>{hostMessages.push(m);},onDidReceiveMessage(fn){host=fn;}}})}}:original.call(this,name,...args);};
 try{delete require.cache[require.resolve('../../src/features/SyncScopeTree.ts')];require('../../src/features/SyncScopeTree.ts').openSyncScopeTree('fixture',roots);}finally{Module._load=original;}
 const element=()=>({children:[],style:{},scrollTop:0,appendChild(c){this.children.push(c);},replaceChildren(...c){this.children=c;}}),nodes=new Map(),sent=[];let receive;
 const timers=[];
 const ctx=vm.createContext({setTimeout(fn){timers.push(fn);return timers.length;},acquireVsCodeApi:()=>({postMessage:m=>sent.push(m)}),document:{createElement:element,getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);}},window:{addEventListener:(_,fn)=>receive=fn}});
 vm.runInContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1],ctx);
 return {ctx,nodes,sent,send:data=>receive({data}),host,hostMessages,dispose,flushTimers:()=>{for(const fn of timers.splice(0))fn();}};
}
function method(name,globals){const ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);let member;function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)===name)member=n;ts.forEachChild(n,visit);}visit(ast);return vm.runInNewContext(ts.transpileModule('class Host{'+member.getText(ast)+'};Host.prototype.'+name,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,globals);}

test('index status remains above the tree, persists per location and ignores stale generations',()=>{
 const f=webview();f.send({type:'init',roots:[{id:'workers',label:'Workers',selected:[],summary:true,indexLocations:[{id:'w1',label:'Worker 1'},{id:'w2',label:'Worker 2'}]}]});
 const query=f.sent.find(m=>m.type==='summary');
 const progress=(id,endpointId,state,detail)=>f.send({type:'readProgress',rootId:'workers',path:'.',id,stage:detail,progress:{endpointId,state,detail}});
 progress(query.id,'w1','complete','已读取 10 个文件 · 索引完成');progress(query.id,'w2','reading','已读取 300 项');
 const text=()=>f.nodes.get('indexProgress').children.map(n=>n.textContent).join(' ');
 assert.match(text(),/1\/2.*尚未全部完成/);assert.match(text(),/Worker 1.*索引完成/);assert.match(text(),/Worker 2.*300/);
 progress('old','w2','complete','stale');assert.doesNotMatch(text(),/stale/);
 progress(query.id,'w2','failed','连接失败');assert.match(text(),/连接失败/);assert.match(text(),/1\/2/);
 f.send({type:'status',rootId:'workers',path:'.',id:query.id,statuses:{},refreshedAt:'now'});assert.match(text(),/连接失败/);
 f.nodes.get('refresh').onclick();assert.match(text(),/0\/2/);assert.doesNotMatch(text(),/连接失败/);
 const fresh=f.sent.filter(m=>m.type==='summary').at(-1);progress(fresh.id,'w1','complete','索引完成');progress(fresh.id,'w2','complete','索引完成');assert.match(text(),/2\/2 · 全部完成/);
});

test('post-delete starts the normal index round immediately and keeps real progress through partial publications',()=>{
 const f=webview();f.send({type:'init',roots:[{id:'local',label:'Local',selected:[],summary:true,indexLocations:[{id:'local',label:'本机'},{id:'w1',label:'Worker 1'}]}]});
 const before=f.sent.find(m=>m.type==='summary');
 f.send({type:'status',rootId:'local',id:before.id,path:'.',statuses:{},refreshedAt:'before'});
 vm.runInContext("state().busyAction={id:'delete',sequence:0};state().expanded.add('results')",f.ctx);
 f.send({type:'batchDone',rootId:'local',id:'delete',affected:['results/gone'],completed:['results/gone'],errors:[]});
 const summaries=f.sent.filter(m=>m.type==='summary');assert.equal(summaries.length,2,'index progress must start before directory listing responds');
 const query=summaries.at(-1);assert.notEqual(query.roundId,before.roundId);
 assert.equal(f.nodes.get('status').className,'busy');assert.match(f.nodes.get('status').textContent,/正在索引文件/);
 assert.match(f.nodes.get('indexProgress').children.map(n=>n.textContent).join(' '),/0\/2.*本机.*等待索引.*Worker 1.*等待索引/);
 f.send({type:'readProgress',rootId:'local',path:'.',id:query.id,stage:'local：正在索引 results · 已读取 81 个目录项',progress:{endpointId:'local',state:'reading',detail:'已读取 81 个目录项'}});
 f.send({type:'status',rootId:'local',path:'.',id:query.id,complete:false,statuses:{'.':{state:'unknown',basis:'metadata',detail:'partial'}}});
 assert.match(f.nodes.get('status').textContent,/81 个目录项/);assert.doesNotMatch(f.nodes.get('status').textContent,/已更新部分|重新读取文件列表/);
 f.send({type:'readProgress',rootId:'local',path:'.',id:query.id,stage:'done',progress:{endpointId:'local',state:'complete',detail:'索引完成'}});
 f.send({type:'readProgress',rootId:'local',path:'.',id:query.id,stage:'w1 failed',progress:{endpointId:'w1',state:'failed',detail:'连接失败'}});
 f.send({type:'status',rootId:'local',path:'.',id:query.id,statuses:{'.':{state:'unknown',basis:'metadata',detail:'unavailable'}},refreshedAt:'after'});
 assert.match(f.nodes.get('indexProgress').children.map(n=>n.textContent).join(' '),/1\/2.*索引完成.*连接失败/);
 f.send({type:'readProgress',rootId:'local',path:'.',id:before.id,stage:'stale'});assert.doesNotMatch(f.nodes.get('status').textContent,/stale/);
 f.flushTimers();assert.equal(f.sent.filter(m=>m.type==='summary').length,2);
});

test('partial delete errors remain visible alongside index progress and each mode starts just one round',()=>{
 const f=webview();f.send({type:'init',roots:['local','workers'].map(id=>({id,label:id,selected:[],summary:true}))});
 f.send({type:'batchDone',rootId:'local',affected:['results/gone'],completed:[],errors:['w2 删除失败']});
 for(const id of ['local','workers'])assert.equal(f.sent.filter(m=>m.type==='summary'&&m.rootId===id).length,id==='local'?2:1);
 const query=f.sent.findLast(m=>m.type==='summary'&&m.rootId==='local');
 f.send({type:'readProgress',rootId:'local',path:'.',id:query.id,stage:'w1：已读取 123 项'});
 assert.match(f.nodes.get('status').textContent,/w2 删除失败.*w1：已读取 123 项/);
 const list=f.sent.findLast(m=>m.type==='list'&&m.rootId==='local');
 f.send({...list,type:'children',entries:[]});
 assert.equal(f.sent.filter(m=>m.type==='summary'&&m.rootId==='local').length,2);
});

test('completed index survives elapsed wall time; an explicit later browse revalidates the observation',()=>{
 const f=webview(),timers=[];let now=1000;
 f.ctx.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
 f.ctx.Date={now:()=>now};
 f.send({type:'init',roots:[{id:'local',label:'Local',selected:[],summary:true,indexLocations:[{id:'local',label:'本机'}]}]});
 const query=f.sent.find(m=>m.type==='summary');
 f.send({type:'children',rootId:'local',path:'.',entries:[{name:'data',path:'data',directory:true,locations:['local']}]});
 f.send({type:'readProgress',rootId:'local',path:'.',id:query.id,stage:'done',progress:{endpointId:'local',state:'complete',detail:'索引完成'}});
 f.send({type:'status',rootId:'local',path:'.',id:query.id,complete:true,refreshedAt:'observed once',statuses:{'.':{state:'unknown',basis:'metadata',detail:'observed'}}});
 now+=300000;for(const timer of timers)timer.fn();
 assert.equal(vm.runInContext("state().indexProgress.get('local').state",f.ctx),'complete');
 assert.equal(vm.runInContext('Boolean(state().indexExpired)',f.ctx),false);
 assert.doesNotMatch(f.nodes.get('indexProgress').children.map(n=>n.textContent).join(' '),/已过期/);
 f.nodes.get('tree').children[1].children[0].onclick();
 assert.equal(f.sent.filter(m=>m.type==='summary').length,2,'later browsing requests a new live round without a timer clearing completion');
});

test('expanding folders reuses in-flight index generation; direct delete binds just that file or folder',()=>{
 const f=webview();f.send({type:'init',roots:[{id:'local',label:'Local',selected:['a.txt','dir'],summary:true}]});
 const folders=[{path:'dir',name:'dir',directory:true,locations:['w1'],selectable:false},{path:'a.txt',name:'a.txt',directory:false,locations:['w1']}];
 f.send({type:'children',rootId:'local',path:'.',entries:folders});
 const row=name=>f.nodes.get('tree').children.find(n=>n.children.some(x=>x.textContent===name));
 row('📁 dir').children[0].onclick();
 assert.equal(f.sent.filter(m=>m.type==='summary').length,1);assert.equal(f.sent.filter(m=>m.type==='cancelRefresh').length,0);assert.equal(f.sent.at(-1).path,'dir');
 row('📁 dir').children.find(n=>n.textContent==='一键删除').onclick();assert.equal(f.sent.at(-1).type,'batchDelete');assert.deepEqual([...f.sent.at(-1).paths],['dir']);assert.deepEqual([...f.sent.at(-1).excluded],[]);
 f.send({type:'actionCancelled',rootId:'local'});row('📄 a.txt').children.find(n=>n.textContent==='一键删除').onclick();assert.deepEqual([...f.sent.at(-1).paths],['a.txt']);assert.equal(f.sent.at(-1).entries[0].directory,false);
 f.send({type:'actionCancelled',rootId:'local'});const box=f.nodes.get('tree').children[0].children[1];box.checked=true;box.onchange();f.nodes.get('batchDelete').onclick();assert.deepEqual([...f.sent.at(-1).paths],['a.txt','dir']);
});

test('default operation selection includes held, out-of-scope and server-only paths for both actions without changing saved scope',()=>{
 const f=webview();f.send({type:'init',roots:[{id:'local',label:'Local',selected:['code'],excludable:true}]});
 f.send({type:'children',rootId:'local',path:'.',entries:[{path:'code',name:'code',directory:true,locations:['local']},{path:'remote',name:'remote',directory:true,locations:['w1'],selectable:false,held:true},{path:'remote.txt',name:'remote.txt',directory:false,locations:['w1'],selectable:false},{path:'outside',name:'outside',directory:true,locations:['local','w1'],held:true}]});
 const row=name=>f.nodes.get('tree').children.find(n=>n.children.some(x=>x.textContent===name));
 for(const name of ['📁 remote','📄 remote.txt','📁 outside']){const box=row(name).children[1];assert.equal(box.disabled,false);box.checked=true;box.onchange();}
 assert.equal(f.nodes.get('save').disabled,true,'operation selections cannot be saved as automatic scope');
 f.nodes.get('batchSync').onclick();assert.deepEqual([...f.sent.at(-1).paths],['outside','remote','remote.txt']);
 f.send({type:'actionCancelled',rootId:'local'});
 f.nodes.get('deleteSelection').onclick();
 assert.equal(row('📁 remote').children[1].checked,true,'legacy delete entry preserves operation selection');
 f.nodes.get('editScope').onclick();assert.equal(row('📁 remote').children[1].disabled,true);assert.equal(row('📁 code').children[1].checked,true);
 const prior=f.sent.filter(m=>m.type==='batchDelete').length;f.nodes.get('batchDelete').onclick();assert.equal(f.sent.filter(m=>m.type==='batchDelete').length,prior,'scope edits cannot silently become management targets');
 f.nodes.get('save').onclick();assert.deepEqual([...f.sent.at(-1).paths],['code']);
 f.nodes.get('operationSelection').onclick();assert.equal(row('📁 remote').children[1].checked,true);
 f.nodes.get('batchDelete').onclick();assert.deepEqual([...f.sent.at(-1).paths],['outside','remote','remote.txt']);assert.deepEqual([...vm.runInContext('[...state().selected]',f.ctx)],['code']);
 assert.equal(f.sent.at(-1).entries.find(e=>e.path==='remote').directory,true);
 f.send({type:'actionCancelled',rootId:'local'});f.nodes.get('filterIssues').onclick();f.nodes.get('showSame').onclick();
 assert.equal(row('📁 remote').children[1].disabled,false,'showing all after filtering restores management mode');
 assert.equal(row('📁 remote').children[1].checked,true);
});

test('Worker root scope does not disable descendant operation checkboxes; exclusions apply to management only',()=>{
 const f=webview();f.send({type:'init',roots:[{id:'workers',label:'Workers',selected:['.']} ]});
 f.send({type:'children',rootId:'workers',path:'.',entries:[{name:'held',path:'held',directory:true,held:true,locations:['w1']} ]});
 f.send({type:'children',rootId:'workers',path:'held',entries:[{name:'keep',path:'held/keep',directory:false,locations:['w1']},{name:'drop',path:'held/drop',directory:false,locations:['w1']}]});
 vm.runInContext("state().expanded.add('held');renderTree()",f.ctx);
 const row=name=>f.nodes.get('tree').children.find(n=>n.children.some(x=>x.textContent===name));
 for(const name of ['📁 held','📄 keep','📄 drop'])assert.equal(row(name).children[1].disabled,false);
 row('📁 held').children[1].checked=true;row('📁 held').children[1].onchange();
 row('📄 keep').children[1].checked=false;row('📄 keep').children[1].onchange();
 assert.equal(f.nodes.get('tree').children[0].children[1].indeterminate,true);
 assert.equal(row('📁 held').children[1].indeterminate,true);
 f.nodes.get('batchDelete').onclick();assert.deepEqual([...f.sent.at(-1).paths],['held']);assert.deepEqual([...f.sent.at(-1).excluded],['held/keep']);
 assert.deepEqual([...vm.runInContext('[...state().selected]',f.ctx)],['.']);
});

test('expired view facts become unknown and expanding starts a new round instead of reusing stale absence',()=>{
 const f=webview();f.send({type:'init',roots:[{id:'local',label:'Local',selected:[],summary:true,indexLocations:[{id:'local',label:'本机'}]}]});
 f.send({type:'children',rootId:'local',path:'.',entries:[{name:'data',path:'data',directory:true,locations:['local'],observations:{local:{status:'present',directory:true}}}]});
 vm.runInContext("state().statuses.data={state:'different',basis:'metadata',detail:'确认缺失',metadata:{local:{status:'absent'}}};state().indexProgress.get('local').state='complete';expireIndexView(state())",f.ctx);
 assert.equal(vm.runInContext("state().statuses.data.metadata.local.status",f.ctx),'unknown');assert.match(f.nodes.get('indexProgress').children.map(n=>n.textContent).join(' '),/等待增量核实/);
 f.nodes.get('tree').children[1].children[0].onclick();assert.equal(f.sent.filter(m=>m.type==='summary').length,2);assert.equal(vm.runInContext('state().indexExpired',f.ctx),false);
});

test('completed view automatically coalesces invalidation bursts, rejects old absence and converges without a manual refresh',()=>{
 const f=webview();f.send({type:'init',roots:[{id:'local',label:'Local',selected:[],summary:true,indexLocations:[{id:'local',label:'本机'}]}]});
 const first=f.sent.find(m=>m.type==='summary');
 f.send({type:'readProgress',rootId:'local',path:'.',id:first.id,stage:'done',progress:{endpointId:'local',state:'complete',detail:'索引完成'}});
 f.send({type:'status',rootId:'local',path:'.',id:first.id,statuses:{file:{state:'different',basis:'metadata',detail:'缺失',metadata:{local:{status:'absent'}}}}});
 for(let i=0;i<5;i++)f.send({type:'indexInvalidated',reason:'sync holds changed'});
 assert.equal(vm.runInContext('state().statuses.file.metadata.local.status',f.ctx),'unknown');
 f.flushTimers();
 assert.equal(f.sent.filter(m=>m.type==='summary').length,2,'one new live round for all endpoint notifications');
 const next=f.sent.filter(m=>m.type==='summary').at(-1);assert.notEqual(next.roundId,first.roundId);
 f.send({type:'status',rootId:'local',path:'.',id:first.id,statuses:{bad:{state:'different',detail:'old absence'}}});
 assert.equal(vm.runInContext('Boolean(state().statuses.bad)',f.ctx),false);
 f.send({type:'readProgress',rootId:'local',path:'.',id:next.id,stage:'done',progress:{endpointId:'local',state:'complete',detail:'索引完成'}});
 f.send({type:'status',rootId:'local',path:'.',id:next.id,statuses:{file:{state:'same',basis:'metadata',detail:'已读取',metadata:{local:{status:'present'}}}},refreshedAt:'fresh'});
 assert.equal(vm.runInContext('state().statuses.file.metadata.local.status',f.ctx),'present');
 assert.match(f.nodes.get('indexProgress').children.map(n=>n.textContent).join(' '),/1\/1 · 全部完成/);
 assert.doesNotMatch(f.nodes.get('status').textContent,/过期|请刷新/);
});

test('invalidation waits for an active operation; cancellation resumes one live check',()=>{
 const f=webview();f.send({type:'init',roots:[{id:'local',label:'Local',selected:[],summary:true}]});
 vm.runInContext("state().busyAction={id:'action',sequence:0}",f.ctx);
 f.send({type:'indexInvalidated',reason:'operation started'});f.flushTimers();
 assert.equal(f.sent.filter(m=>m.type==='summary').length,1);
 f.send({type:'actionCancelled',rootId:'local',id:'action'});f.flushTimers();
 assert.equal(f.sent.filter(m=>m.type==='summary').length,2);
});

test('unchanged sync holds do not invalidate file indexes; actual changes notify precise paths after persistence',async()=>{
 let holds={data:{endpointId:'w1'}},saved=0;const events=[];
 const update=method('updateSyncScopeHolds',{SyncResolution:{syncHoldsStoragePath:()=>'/storage/holds'},loadSyncHolds:async()=>structuredClone(holds),saveSyncHolds:async(_storage,_root,value)=>{saved++;holds=value;}});
 const host={context:{globalStorageUri:{fsPath:'/storage'}},withPluginStateFileLease:async(_root,_file,_kind,_title,work)=>work(),invalidateProjectFileIndexes:async(reason,paths)=>events.push({reason,paths:[...paths],saved})};
 await update.call(host,'/project',()=>{});assert.equal(events.length,0);assert.equal(saved,0);
 await update.call(host,'/project',value=>{value.data.endpointId='w2';value.new={endpointId:'local'};});
 assert.equal(events.length,1);assert.equal(events[0].saved,1);assert.deepEqual(events[0].paths.sort(),['data','new']);
});

test('actual watcher, host bridge and incremental filesystem reader converge after path disappearance; failed reads remain unknown',async()=>{
 const {ProjectFileIndex}=require('../../src/features/ProjectFileIndex.ts');
 const {SyncScopeLocalIndexReader}=require('../../src/features/SyncScopeLocalIndex.ts');
 const {queryScopeMetadata}=require('../../src/features/SyncScopeMetadata.ts');
 const temp=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'scope-auto-refresh-')),root=path.join(temp,'project');fs.mkdirSync(root);
 fs.writeFileSync(path.join(root,'file.txt'),'fixture','utf8');
 const index=new ProjectFileIndex({workspace:root,endpointId:'local',projectRoot:root,connection:'fixture'},path.join(temp,'storage'));
 const reader=new SyncScopeLocalIndexReader(root,5000,index);let offline=false;
 const f=webview([{id:'local',label:'Local',selected:[],indexLocations:[{id:'local',label:'本机'},{id:'w1',label:'Worker'}],
  watch:invalidate=>index.subscribe(invalidate),
  list:async(relative,signal,round)=>{const entries=await reader.list(relative,round,signal);return entries.map(entry=>({...entry,locations:['local'],observations:{local:{status:'present',directory:entry.directory}}}));},
  summary:(_relative,signal,report,publish,round)=>queryScopeMetadata([{id:'local',read:async progress=>{if(offline)throw Error('fixture disconnected');return reader.read(round,signal,progress);}},{id:'w1',read:async()=>({files:{'file.txt':{size:7,modifiedAtMs:1000}}})}],signal,report,publish)
 }]);
 let cursor=0;
 const drain=async()=>{for(let n=0;n<30;n++){while(cursor<f.sent.length)await f.host(f.sent[cursor++]);while(f.hostMessages.length)f.send(f.hostMessages.shift());f.flushTimers();if(cursor===f.sent.length&&!f.hostMessages.length)return;}assert.fail('bridge did not converge');};
 try{
  await drain();assert.equal(vm.runInContext("state().indexProgress.get('local').state",f.ctx),'complete');
  assert.equal(vm.runInContext("state().statuses['file.txt'].metadata.local.status",f.ctx),'present');
  fs.mkdirSync(path.join(root,'clean_dir'));fs.renameSync(path.join(root,'file.txt'),path.join(root,'clean_dir','file.txt'));
  await index.invalidate('fixture path changed',['file.txt']);await drain();
  assert.equal(vm.runInContext("state().statuses['file.txt'].metadata.local.status",f.ctx),'absent');
  assert.equal(vm.runInContext("state().indexProgress.get('local').state",f.ctx),'complete');
  offline=true;await index.invalidate('fixture connection changed',['file.txt']);await drain();
  assert.equal(vm.runInContext("state().statuses['file.txt'].metadata.local.status",f.ctx),'unknown');
  assert.equal(vm.runInContext("state().indexProgress.get('local').state",f.ctx),'failed');
  offline=false;await index.invalidate('fixture reconnected',['file.txt']);await drain();
  assert.equal(vm.runInContext("state().indexProgress.get('local').state",f.ctx),'complete');
  assert.doesNotMatch(f.nodes.get('status').textContent,/过期|请刷新/);
 }finally{f.dispose();await index.flush();}
});

test('mutation invalidation retires in-flight messages rather than restoring obsolete absence',()=>{
 const f=webview();f.send({type:'init',roots:[{id:'local',label:'Local',selected:[],summary:true}]});const query=f.sent.find(m=>m.type==='summary');
 f.send({type:'indexInvalidated',reason:'upload completed'});
 f.send({type:'status',rootId:'local',path:'.',id:query.id,statuses:{'old.bin':{state:'different',detail:'stale absence'}}});
 assert.equal(vm.runInContext("state().statuses['old.bin']",f.ctx),undefined);assert.equal(vm.runInContext('state().indexExpired',f.ctx),true);
 assert.match(f.nodes.get('status').textContent,/upload completed/);
});

test('default scope view hides consistent files, groups equal copies, and keeps failed queries distinct from confirmed absence',()=>{
 const {buildScopeMetadataStatuses}=require('../../src/features/SyncScopeMetadata.ts');
 const {nodes,sent,send,ctx}=webview();send({type:'init',roots:[{id:'local',label:'Local',selected:['.'],summary:true}]});
 const statuses=buildScopeMetadataStatuses(['local','nwpu2','nwpu3','empty','failed'],{local:{files:{'same':{size:2,modifiedAtMs:1000},'different':{size:3,modifiedAtMs:2000}}},nwpu2:{files:{same:{size:2,modifiedAtMs:1000},different:{size:4,modifiedAtMs:3000}}},nwpu3:{files:{same:{size:2,modifiedAtMs:1000},different:{size:4,modifiedAtMs:3000}}},empty:{files:{same:{size:2,modifiedAtMs:1000}}},failed:{files:{same:{size:2,modifiedAtMs:1000}},unverifiedFiles:{different:'HTTP 503'}}},new Map());
 const query=sent.find(m=>m.type==='summary');send({type:'status',id:query.id,rootId:'local',path:'.',statuses});
 const labels=()=>nodes.get('tree').children.flatMap(n=>n.children).map(n=>n.textContent||'');
 assert.ok(!labels().includes('📄 same'),'same observed metadata is hidden by default');assert.ok(labels().includes('📄 different'));
 const row=nodes.get('tree').children.find(n=>n.children.some(x=>x.textContent==='📄 different'));
 const badge=row.children.find(n=>n.className==='badge different');assert.match(badge.textContent,/nwpu2、nwpu3/);assert.match(badge.textContent,/empty.*确认缺失/);assert.match(badge.textContent,/failed.*查询失败/);
 row.children.find(n=>n.textContent==='版本与操作').onclick();
 const cards=nodes.get('tree').children.find(n=>n.className==='row-detail').children;assert.equal(cards.length,4,'one card for the shared version, plus local, absent and unknown');
 const shared=cards.find(n=>n.textContent.startsWith('nwpu2、nwpu3'));assert.ok(shared);assert.match(shared.textContent,/4 B/);
 const source=shared.children.find(n=>n.title?.startsWith('nwpu3：')).children.find(n=>n.textContent==='以此版同步到其他位置');source.onclick();assert.equal(sent.at(-1).endpointId,'nwpu3');
 vm.runInContext('state().busyAction=null',ctx);nodes.get('showSame').onclick();assert.ok(labels().includes('📄 same'));assert.equal(vm.runInContext("state().selected.has('.')",ctx),true,'visibility must not change transfer scope');
 nodes.get('filterIssues').onclick();assert.equal(vm.runInContext('state().issueTree.files.length',ctx),1);assert.equal(vm.runInContext("state().statuses.different.metadata.failed.status",ctx),'unknown');
 nodes.get('showSame').onclick();assert.ok(labels().includes('📄 same'));assert.equal(vm.runInContext('state().issueFilterOn',ctx),false,'show consistent items exits the narrower issue filter');
 nodes.get('filterIssues').onclick();nodes.get('clearIssueFilter').onclick();assert.ok(labels().includes('📄 same'),'show all clears both visibility filters');
});

test('collapsed folders automatically request recursive summaries and show counts alongside observed copies',()=>{
 const {nodes,sent,send,ctx}=webview();
 send({type:'init',roots:[{id:'local',label:'Local',selected:[],summary:true}]});
 send({type:'children',rootId:'local',path:'.',entries:[{name:'configs',path:'configs',directory:true,locations:['local','w1'],observations:{local:{status:'present',directory:true},w1:{status:'present',directory:true}}}]});
 const query=sent.find(m=>m.type==='summary');assert.ok(query,'automatic recursive summary without expanding configs');
 send({type:'status',id:query.id,rootId:'local',path:'.',complete:false,statuses:{configs:{state:'different',basis:'metadata',detail:'递归文件信息：缺失 2 · 差异 1',copies:{local:{present:3,missing:0,needsSync:0,conflict:0,unverified:0,modifiedAtMs:1000},w1:{present:1,missing:2,needsSync:1,conflict:0,unverified:0,modifiedAtMs:1000}}}}});
 const folder=nodes.get('tree').children[1],badge=folder.children.find(n=>n.className==='badge different');
 assert.match(badge?.textContent,/缺失 2/);assert.match(badge?.textContent,/差异 1/);
 assert.equal(vm.runInContext('state().pending.size',ctx),1,'partial reply must keep slow Worker pending');
 assert.ok(!sent.some(m=>m.type==='list'&&m.path==='configs'),'collapsed subtree need not be expanded');
 const old=query.id;nodes.get('refresh').onclick();send({type:'status',id:old,rootId:'local',path:'.',statuses:{configs:{state:'same',detail:'old'}}});
 assert.notEqual(vm.runInContext("state().statuses.configs?.detail",ctx),'old','late summary cannot overwrite refresh');
});

test('unknown-only files remain visible and selectable when consistent folders are hidden; reconnect replaces unknown with current facts',()=>{
 const {buildScopeMetadataStatuses}=require('../../src/features/SyncScopeMetadata.ts'),f=webview();f.send({type:'init',roots:[{id:'workers',label:'Workers',selected:['.'],summary:true}]});
 const make=failed=>buildScopeMetadataStatuses(['w1','w2'],{w1:{files:{'clean/same':{size:1,modifiedAtMs:1000},'uncertain/a':{size:2,modifiedAtMs:1000}}},w2:{files:{'clean/same':{size:1,modifiedAtMs:1000},...(!failed?{'uncertain/a':{size:2,modifiedAtMs:1000}}:{})},unverifiedFiles:failed?{uncertain:'PermissionError'}:{}}},new Map());
 const query=f.sent.find(m=>m.type==='summary');f.send({type:'status',id:query.id,rootId:'workers',path:'.',statuses:make(true)});
 assert.ok(!f.nodes.get('tree').children.some(n=>n.children.some(x=>x.textContent==='📁 clean')));
 assert.ok(f.nodes.get('tree').children.some(n=>n.children.some(x=>x.textContent==='📁 uncertain')));
 f.nodes.get('filterIssues').onclick();assert.equal(vm.runInContext('state().issueTree.files.length',f.ctx),1);
 const file=f.nodes.get('tree').children.find(n=>n.children.some(x=>x.textContent==='📄 a'));assert.ok(file);assert.match(file.children.find(n=>n.className==='badge unknown').textContent,/w2.*查询失败/);
 f.nodes.get('selectFiltered').onclick();assert.equal(vm.runInContext("state().batchSelected.has('uncertain/a')",f.ctx),true);
 f.nodes.get('refresh').onclick();const fresh=f.sent.filter(m=>m.type==='summary').at(-1);f.send({type:'status',id:fresh.id,rootId:'workers',path:'.',statuses:make(false)});
 assert.equal(vm.runInContext('state().issueTree.files.length',f.ctx),0);f.send({type:'status',id:query.id,rootId:'workers',path:'.',statuses:make(true)});assert.equal(vm.runInContext('state().issueTree.files.length',f.ctx),0);
});

test('hash comparison counts are not hidden by direct metadata; metadata differences remain filterable and actionable',()=>{
 const {nodes,sent,send,ctx}=webview();send({type:'init',roots:[{id:'local',label:'Local',selected:[]}]});
 send({type:'children',rootId:'local',path:'.',entries:[{name:'data',path:'data',directory:true,locations:['local','w1'],observations:{local:{status:'present',directory:true},w1:{status:'present',directory:true}}}]});
 send({type:'status',rootId:'local',path:'.',statuses:{data:{state:'different',detail:'同步范围内 3 个文件 · 1 一致 · 2 待更新或冲突',copies:{local:{present:3,missing:0,needsSync:0,conflict:0,unverified:0},w1:{present:1,missing:2,needsSync:1,conflict:0,unverified:0}}}}});
 assert.match(nodes.get('tree').children[1].children.find(n=>n.className==='badge different')?.textContent,/缺失 2/);
 send({type:'status',rootId:'local',path:'.',statuses:{'data/deep/file':{basis:'metadata',state:'different',detail:'缺失：w1 · 内容未比较',issueSignature:'metadata-missing',metadata:{local:{status:'present',directory:false,size:3,modifiedAtMs:1000},w1:{status:'absent'}}}}});
 nodes.get('filterIssues').onclick();assert.equal(vm.runInContext('state().issueTree.files.length',ctx),1);
 const row=nodes.get('tree').children.find(n=>n.children.some(x=>x.textContent==='📄 file'));assert.ok(row);row.children.find(n=>n.textContent==='版本与操作').onclick();
 const action=nodes.get('tree').children.flatMap(n=>n.children).flatMap(n=>n.children||[]).find(n=>n.textContent==='以此版同步到其他位置');assert.equal(action.disabled,false);action.onclick();assert.equal(sent.at(-1).endpointId,'local');assert.equal(sent.at(-1).path,'data/deep/file');
});

test('real metadata host checks companion capability and includes every enabled Worker, independently of transfer scope',async()=>{
 const {queryScopeMetadata}=require('../../src/features/SyncScopeMetadata.ts');const calls=[],updates=[];
 const refresh=method('refreshSyncScopeMetadata',{queryScopeMetadata,collectLocalScopeMetadata:async()=>({files:{'unselected/deep/file':{size:3,modifiedAtMs:1000}}})});
 const host={enabledWorkerConfigs:()=>[{id:'w1'},{id:'w2'}],simpleSftpCapability:async method=>{assert.equal(method,'sync.projectInventory');return {methodOptions:{'sync.projectInventory':{metadataOnly:1}}};},sftpServerOptions:row=>row,simpleSftpApiCall:async(method,params)=>{calls.push(params);return {comparisonBasis:'metadata',files:{}};}};
 const rows=await refresh.call(host,'fixture',[{id:'w1'}],true,'.',undefined,()=>{},row=>updates.push(row));
 assert.equal(calls.length,1);assert.equal(calls[0].metadataOnly,true);assert.equal(calls[0].scopePaths,undefined);assert.equal(rows.unselected.copies.w1.missing,1);assert.equal(rows.unselected.copies.w2.missing,0);assert.equal(rows.unselected.copies.w2.unverified,1);assert.ok(updates.length>=2);
 host.simpleSftpCapability=async()=>({methodOptions:{}});calls.length=0;await refresh.call(host,'fixture',[{id:'w1'}],false,'.');assert.equal(calls.length,0,'old companion must never silently hash the whole project');
});

test('only the sync-scope view reuses its freshly requested Agent generation for listings and counts',async()=>{
 const {queryScopeMetadata}=require('../../src/features/SyncScopeMetadata.ts'),{scopeIndexUnsupported}=require('../../src/features/SyncScopeAgentIndex.ts');
 const indexRead=async()=>({ok:true,exists:true,observedAt:'actual-index-scan',entries:[{name:'file',path:'dir/file',directory:false,size:2,modifiedAtMs:1000}]}),
 list=method('listSyncScopeUnion',{loadSyncHolds:async()=>({}),isSyncHeld:()=>false,errorMessage:e=>e.message,scopeIndexUnsupported});
 const host={context:{globalStorageUri:{fsPath:'fixture'}},sftpServerOptions:t=>t,enabledWorkerConfigs:()=>[{id:'w1'}],simpleSftpApiCall:()=>assert.fail('new Agent directory index needs no SSH directory process')};
 const entries=await list.call(host,'fixture',[{id:'w1'}],'dir',false,false,undefined,indexRead);assert.equal(entries[0].observations.w1.observedAt,'actual-index-scan');
 const summary=method('refreshSyncScopeMetadata',{queryScopeMetadata,scopeIndexUnsupported});
 const rows=await summary.call(host,'fixture',[{id:'w1'}],false,'.',undefined,()=>{},()=>{},async()=>({files:{'dir/file':{size:2,modifiedAtMs:1000}}}));assert.equal(rows.dir.copies.w1.present,1);
 host.simpleSftpApiCall=async()=>({ok:true,exists:true,entries:[]});
 assert.equal((await list.call(host,'fixture',[{id:'w1'}],'.',false,false,undefined,async()=>{throw Error('Worker Agent HTTP 404: old runtime');})).length,0);
 await assert.rejects(list.call(host,'fixture',[{id:'w1'}],'.',false,false,undefined,async()=>{throw Error('SCOPE_INDEX_QUERY_FAILED');}),/SCOPE_INDEX_QUERY_FAILED/);
});

test('real single/batch deletion call chain never enters the legacy transfer-receipt API',async()=>{
 const remote=method('deleteSyncScopeRemoteCopy',{isUnderMachineStatePrefixes:require('../../dist/features/ProjectRootMap').isUnderMachineStatePrefixes,deleteConfirmedScopeCopy:async(rpc,node,relative,directory)=>{
   assert.equal(node.host,'worker.example');assert.equal(node.root,'/project');assert.equal(relative,'work_dirs/job');assert.equal(directory,true);
 }}),calls=[];
 const host={localMachineStateGuard:()=>({prefixes:[],unknown:false}),targetRootGuard:()=>({prefixes:[],unknown:false}),simpleSftpCapability:async()=>({methodOptions:{'files.cleanup.preview':{confirmedPathMetadata:1,confirmedPathNestedRepositories:1}}}),sftpServerOptions:row=>({host:'worker.example',remotePath:'/project',user:'user',port:22}),
   deleteSyncScopeRemoteCopy:async(...args)=>{calls.push(args);await remote.call(host,...args);},
   simpleSftpApiCall:async(name)=>{assert.equal(name,'sync.projectTree');return {ok:true,entries:[{path:'work_dirs/job',directory:true}]};}};
 const remove=method('removeSyncScopeCopies',{safeSyncPath:()=>{},scopeInventoryPathAllowed:()=>true,path,errorMessage:e=>e.message});
 await remove.call(host,'fixture',[{id:'w1'}],'work_dirs/job',['w1'],true);
 assert.equal(calls.length,1);
 assert.doesNotMatch(source,/simpleSftpApiCall\("sync\.deletePath"/);
});
test('deletion rechecks visible selections; absent paths are removed without a target or a tombstone',async()=>{
 const absent=[],old={name:'concatenation',path:'work_dirs/concatenation',directory:true,locations:['w1','w2']};
 const result=await expandSyncScopeBatchSelection([old.path],[],async()=>[],()=>{},[old],{fresh:true,onMissing:p=>absent.push(p)});
 assert.deepEqual(result,[]);assert.deepEqual(absent,[old.path]);
 await assert.rejects(expandSyncScopeBatchSelection([old.path],[],async()=>{throw Error('w2 connection refused');},()=>{},[old],{fresh:true,onMissing:p=>absent.push(p)}),/connection refused/);
});
test('actual union distinguishes empty connected Workers from failed queries',async()=>{
 const list=method('listSyncScopeUnion',{loadSyncHolds:async()=>({}),isSyncHeld:()=>false,errorMessage:e=>e.message});
 const host={context:{globalStorageUri:{fsPath:'fixture'}},sftpServerOptions:t=>t,simpleSftpApiCall:async()=>({ok:true,entries:[]})};
 assert.equal((await list.call(host,'fixture',[{id:'jqg_zlk'}],'work_dirs',false)).length,0);
 host.simpleSftpApiCall=async()=>{throw Error('SSH query timeout');};await assert.rejects(list.call(host,'fixture',[{id:'jqg_zlk'}],'work_dirs',false),/jqg_zlk.*SSH query timeout/);
 let probes=0;host.simpleSftpApiCall=async name=>{if(name==='sync.projectTree')throw Error('SSH query timeout');probes++;return {ok:true,exists:true,empty:true};};
 assert.equal((await list.call(host,'fixture',[{id:'jqg_zlk'}],'work_dirs',false)).length,0);assert.equal(probes,1);
 host.simpleSftpApiCall=async name=>{if(name==='sync.projectTree')throw Error('SSH query timeout');return {ok:true,exists:true,empty:false};};
 await assert.rejects(list.call(host,'fixture',[{id:'jqg_zlk'}],'work_dirs',false),/目录非空/);
});
test('actual Webview removes absent paths from cached children, status filter and selections',()=>{
 let html;const original=Module._load;Module._load=function(name,...args){return name==='vscode'?{ViewColumn:{Active:1},window:{createWebviewPanel:()=>({webview:{set html(value){html=value;},onDidReceiveMessage(){}}})}}:original.call(this,name,...args);};
 try{delete require.cache[require.resolve('../../src/features/SyncScopeTree.ts')];require('../../src/features/SyncScopeTree.ts').openSyncScopeTree('fixture',[]);}finally{Module._load=original;}
 const element=()=>({children:[],style:{},scrollTop:0,appendChild(c){this.children.push(c);},replaceChildren(...c){this.children=c;}}),nodes=new Map(),sent=[];let receive;
 const ctx=vm.createContext({acquireVsCodeApi:()=>({postMessage:m=>sent.push(m)}),document:{createElement:element,getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);}},window:{addEventListener:(_,fn)=>receive=fn}});
 vm.runInContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1],ctx);
 const send=data=>receive({data}),gone='work_dirs/concatenation';
 send({type:'init',roots:[{id:'workers',label:'Workers',selected:[gone]}]});send({type:'children',rootId:'workers',path:'.',entries:[{name:'work_dirs',path:'work_dirs',directory:true}]});
 send({type:'children',rootId:'workers',path:'work_dirs',entries:[{name:'concatenation',path:gone,directory:true}]});
 send({type:'status',rootId:'workers',path:'.',statuses:{[gone]:{state:'different',detail:'old'},[gone+'/old.bin']:{state:'different',detail:'old',issueSignature:'old'}},refreshedAt:'old'});
 vm.runInContext("state().batchSelected.add('work_dirs/concatenation/old.bin');state().operationSelected.add('work_dirs/concatenation');state().expanded.add('work_dirs/concatenation')",ctx);
 send({type:'children',rootId:'workers',path:'work_dirs',entries:[]});
 const result=JSON.parse(vm.runInContext('JSON.stringify({selected:[...state().selected],operation:[...state().operationSelected],batch:[...state().batchSelected],statuses:state().statuses,expanded:[...state().expanded]})',ctx));
 assert.deepEqual(result.selected,[]);assert.deepEqual(result.operation,[]);assert.deepEqual(result.batch,[]);assert.ok(!Object.keys(result.statuses).some(p=>p.startsWith(gone)));assert.ok(!result.expanded.includes(gone));
});

test('partial deletion refreshes attempted parents and retires pre-delete requests including errors',()=>{
 const {ctx,nodes,sent,send}=webview(),gone='work_dirs/job';
 send({type:'init',roots:[{id:'workers',label:'Workers',selected:[gone]}]});
 send({type:'children',rootId:'workers',path:'.',entries:[{name:'work_dirs',path:'work_dirs',directory:true}]});
 send({type:'children',rootId:'workers',path:'work_dirs',entries:[{name:'job',path:gone,directory:true,locations:['w1','w2']}]});
 vm.runInContext("state().pending.add('.');state().refreshRequests.set('.','old');state().listRequests.set('work_dirs','old-list')",ctx);
 send({type:'batchDone',rootId:'workers',completed:[],affected:[gone],errors:['w2 query failed']});
 assert.ok(sent.some(m=>m.type==='list'&&m.path==='work_dirs'),'failed/partially deleted targets must also be re-read');
 const list=sent.findLast(m=>m.type==='list'&&m.path==='work_dirs');
 send({type:'children',id:list.id,rootId:'workers',path:'work_dirs',entries:[]});
 assert.ok(!sent.some(m=>m.type==='refresh'),'file actions reload actual listings without starting a second recursive content comparison');
 send({type:'status',id:'old',rootId:'workers',path:'.',statuses:{[gone]:{state:'different',detail:'stale'}}});
 send({type:'error',id:'old-list',rootId:'workers',path:'work_dirs',requestType:'list',message:'old failure'});
 assert.equal(vm.runInContext("Boolean(state().statuses['work_dirs/job'])",ctx),false);
 assert.match(nodes.get('status').textContent,/w2 query failed/);
});

test('root batch refresh reloads expanded descendants instead of leaving them reading forever',()=>{
 const {ctx,sent,send}=webview();
 send({type:'init',roots:[{id:'workers',label:'Workers',selected:['.']}]});
 send({type:'children',rootId:'workers',path:'.',entries:[{name:'work_dirs',path:'work_dirs',directory:true}]});
 vm.runInContext("state().expanded.add('work_dirs');state().children.set('work_dirs',[])",ctx);
 sent.length=0;
 send({type:'batchDone',rootId:'workers',affected:['.'],completed:[],errors:[]});
 assert.ok(sent.some(m=>m.type==='list'&&m.path==='work_dirs'));
});

test('refresh bounds and coalesces directory requests, skips collapsed and merely selected parents',()=>{
 const {ctx,sent,send}=webview();
 send({type:'init',roots:[{id:'workers',label:'Workers',selected:['not/open/file']}]});
 vm.runInContext("state().children.set('collapsed',[]);state().expanded.add('a');state().expanded.add('b');refreshVisible();refreshVisible()",ctx);
 const lists=()=>sent.filter(m=>m.type==='list');
 assert.equal(lists().length,2);
 assert.deepEqual(lists().map(m=>m.path),['.','a']);
 const first=lists()[0];
 send({...first,type:'children',entries:[]});
 assert.equal(lists().length,3);assert.equal(lists()[2].path,'.');
 assert.notEqual(lists()[2].roundId,first.roundId,'old directory response cannot stand in for the requested index generation');
 assert.ok(!lists().some(m=>m.path==='collapsed'||m.path==='not/open'));
 vm.runInContext("load('b');load('b')",ctx);assert.equal(lists().length,3);
 send({...lists()[2],type:'children',entries:[]});assert.equal(lists()[3].path,'b');
});

test('partial directory evidence preserves selections; strict action enumeration still rejects failed Workers',async()=>{
 const list=method('listSyncScopeUnion',{loadSyncHolds:async()=>({}),isSyncHeld:()=>false,errorMessage:e=>e.message});
 const host={context:{globalStorageUri:{fsPath:'fixture'}},sftpServerOptions:t=>t,simpleSftpApiCall:async(_name,p)=>{
  if(p.source.id==='w2')throw Error('API_CAPACITY_EXCEEDED');
  return {ok:true,entries:[{name:'ok',path:'ok',directory:false}]};
 }};
 const rows=await list.call(host,'fixture',[{id:'w1'},{id:'w2'}],'.',false);
 assert.equal(rows[0].path,'ok');assert.match(rows.queryErrors[0],/w2.*API_CAPACITY_EXCEEDED/);
 await assert.rejects(list.call(host,'fixture',[{id:'w1'},{id:'w2'}],'.',false,true),/w2/);
 const {ctx,send}=webview();send({type:'init',roots:[{id:'workers',label:'Workers',selected:['old']}]});
 send({type:'children',rootId:'workers',path:'.',entries:[{path:'old',name:'old',directory:false,locations:['w2']}]});
 send({type:'children',rootId:'workers',path:'.',entries:rows,queryErrors:rows.queryErrors});
 assert.equal(vm.runInContext("state().selected.has('old')",ctx),true);
 assert.equal(vm.runInContext("state().statuses['.'].state",ctx),'unknown');
 assert.equal(vm.runInContext("state().children.get('.').find(e=>e.path==='old').locations.length",ctx),0);
});

test('local hashing and complete Worker inventory start together; partial failure stays unknown',async()=>{
 let release,started=0;
 const local=new Promise(resolve=>release=resolve);
 const refresh=method('refreshSyncScopeStatus',{collectLocalScopeInventory:()=>local,loadSyncHolds:async()=>({}),
  buildScopeStatuses:(data,_mode,_selected,_unused,_ledger,offline)=>{
   assert.equal(data.local['file'].sha256,'local');assert.equal(data.workers.w1.file.sha256,'remote');assert.ok(offline.has('w2'));
   return {'.':{state:'unknown',detail:'w2 未核实'}};
  }});
 const host={localScopeHashCacheFile:()=>'',localMachineStateGuard:()=>({prefixes:[],unknown:false}),enabledWorkerConfigs:()=>[{id:'w1'},{id:'w2'}],sftpServerOptions:t=>t,
  simpleSftpApiCall:async(name,p)=>{started++;assert.equal(name,'sync.projectInventory');assert.equal(p.recursive,true);assert.deepEqual([...p.scopePaths],['.']);if(p.source.id==='w2')return {ok:false,error:'network failed',files:{}};return {files:{file:{sha256:'remote'}}};},
  loadPlanSyncLedger:async()=>({}),context:{globalStorageUri:{fsPath:'fixture'}}};
 const pending=refresh.call(host,'fixture',[{id:'w1'},{id:'w2'}],'local-server',['.']);
 assert.equal(started,2,'remote reads must not wait for slow local hashing');release({file:{sha256:'local'}});
 assert.equal((await pending)['.'].state,'unknown');
});

test('closing the page cancels only its read requests; saving retires stale refresh responses',async()=>{
 let captured;
 const f=webview([{id:'workers',selected:[],list:async(_path,signal)=>{
  captured=signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('fixture read cancelled')),{once:true}));
 }}]);
 const read=f.host({type:'list',id:'read',rootId:'workers',path:'.'});
 assert.equal(captured.aborted,false);f.dispose();await read;assert.equal(captured.aborted,true);
 f.send({type:'init',roots:[{id:'workers',selected:[]}]});
 vm.runInContext("state().refreshRequests.set('.','old');state().pending.add('.')",f.ctx);
 f.send({type:'saved',rootId:'workers'});
 f.send({type:'status',rootId:'workers',id:'old',path:'.',statuses:{bad:{state:'same'}}});
 assert.equal(vm.runInContext("Boolean(state().statuses.bad)",f.ctx),false);
 assert.equal(vm.runInContext("state().pending.size",f.ctx),0);
});

test('read progress is correlated and cannot replace a completed or superseded refresh; recovered listings clear old connection errors',()=>{
 const {ctx,nodes,send}=webview();send({type:'init',roots:[{id:'workers',selected:[]}]});
 vm.runInContext("state().refreshRequests.set('.','now');state().pending.add('.')",ctx);
 send({type:'readProgress',rootId:'workers',path:'.',id:'now',stage:'H20 正在核验 14 个文件'});
 assert.match(nodes.get('status').textContent,/14/);
 send({type:'readProgress',rootId:'workers',path:'.',id:'old',stage:'stale'});assert.doesNotMatch(nodes.get('status').textContent,/stale/);
 send({type:'status',rootId:'workers',path:'.',id:'now',statuses:{},refreshedAt:'done'});
 send({type:'readProgress',rootId:'workers',path:'.',id:'now',stage:'late'});assert.doesNotMatch(nodes.get('status').textContent,/late/);
 send({type:'error',rootId:'workers',path:'.',requestType:'list',message:'HTTP 503'});
 send({type:'children',rootId:'workers',path:'.',entries:[]});
 assert.doesNotMatch(nodes.get('status').textContent,/503/);assert.equal(vm.runInContext("state().statuses['.'].state",ctx),'unknown');
});

test('directory listing preserves actual per-location file facts without content inventory',async()=>{
 const list=method('listSyncScopeUnion',{loadSyncHolds:async()=>({}),isSyncHeld:()=>false,errorMessage:e=>e.message,
  listLocalSyncScope:async()=>Object.assign([{name:'local.py',path:'local.py',directory:false,size:13,modifiedAtMs:1700000000000}],{observation:{status:'present',directory:true}})});
 const host={context:{globalStorageUri:{fsPath:'fixture'}},sftpServerOptions:t=>t,simpleSftpApiCall:async(name,p)=>{
  assert.equal(name,'sync.projectTree');if(p.source.id==='slow')throw Error('read unavailable');
  return {ok:true,exists:true,entries:p.source.id==='w1'?[{path:'a.py',name:'a.py',directory:false,size:12,modifiedAtMs:1700000000000}]:[]};
 }};
 const rows=await list.call(host,'fixture',[{id:'w1'},{id:'w2'},{id:'slow'}],'.',false);
 assert.equal(rows[0].observations.w1.size,12);assert.equal(rows[0].observations.w1.modifiedAtMs,1700000000000);
 assert.equal(rows[0].observations.w2.status,'not-listed');assert.equal(rows[0].observations.slow.status,'unknown');
 assert.equal(rows.observations.w1.status,'present');
 host.simpleSftpApiCall=async()=>{throw Error('disconnected');};
 const local=await list.call(host,'fixture',[{id:'w1'},{id:'w2'}],'.',true);
 assert.equal(local[0].observations.local.size,13);assert.equal(local[0].observations.w1.status,'unknown');assert.equal(local[0].observations.w2.status,'unknown');
});

test('actual listed files show facts and permit choosing a source immediately, with no separate verification action',()=>{
 const {ctx,nodes,sent,send}=webview();send({type:'init',roots:[{id:'local',label:'Local',selected:['.']}]});
 const observations={local:{status:'present',directory:false,size:12,modifiedAtMs:1700000000000},w1:{status:'present',directory:false,size:10,modifiedAtMs:1700000001000},w2:{status:'unknown',error:'read unavailable'}};
 send({type:'children',rootId:'local',path:'.',entries:[{path:'a.py',name:'a.py',directory:false,locations:['local','w1'],observations}],observations:{local:{status:'present',directory:true},w1:{status:'present',directory:true}}});
 let file=nodes.get('tree').children[1];assert.match(file.children.find(n=>String(n.className).startsWith('badge')).textContent,/12 B/);
 file.children.find(n=>n.textContent==='版本与操作').onclick();
 const copies=nodes.get('tree').children[2].children;
 assert.match(copies[0].textContent,/本机.*存在.*12 B/);assert.doesNotMatch(copies[0].textContent,/尚未校验|待核验/);
 const retain=copies[0].children.find(n=>n.textContent==='以此版同步到其他位置');assert.equal(retain.disabled,false);
 assert.equal(copies.find(n=>n.textContent.startsWith('w2')).children.length,0);
 retain.onclick();assert.equal(sent.at(-1).type,'retain');assert.equal(sent.at(-1).endpointId,'local');
 assert.ok(!sent.some(m=>m.type==='refresh'));
 send({type:'error',rootId:'local',path:'.',requestType:'list',message:'new read failed'});
 assert.match(nodes.get('tree').children[1].children.find(n=>String(n.className).startsWith('badge')).textContent,/查询失败/);
 assert.doesNotMatch(nodes.get('tree').children[1].children.find(n=>String(n.className).startsWith('badge')).textContent,/12 B/);
});

test('real local directory reader returns stat facts without reading file contents',async()=>{
 const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'scope-list-facts-'));
 fs.writeFileSync(path.join(root,'a.py'),'print(42)\n','utf8');fs.mkdirSync(path.join(root,'empty'));
 const ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='listLocalSyncScope');
 const read=vm.runInNewContext(ts.transpileModule(fn.getText(ast)+';listLocalSyncScope',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
  {fs:{lstat:fs.promises.lstat,readdir:fs.promises.readdir},path,errorMessage:e=>e.message,blockedExplicitCodePath:()=>false,scopeInventoryPathAllowed:()=>true,
   mapLimited:async(rows,limit,work)=>{assert.equal(limit,8);return Promise.all(rows.map(work));}});
 const entries=await read(root,'.'),actual=fs.statSync(path.join(root,'a.py'));
 assert.equal(entries.find(e=>e.name==='a.py').size,actual.size);assert.equal(entries.find(e=>e.name==='a.py').modifiedAtMs,actual.mtimeMs);
 assert.equal(entries.observation.status,'present');assert.equal(entries.find(e=>e.name==='empty').directory,true);
});
