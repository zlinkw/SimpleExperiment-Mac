const { test, assert, fs, path, vm, world, read, intact } = require("./planIsolatedReview.support.cjs");

test('原注册隔离目标追加或换节点均拒绝',async()=>{const w=await world();w.original.preview.rows[0].destination='work/p1';fs.writeFileSync(path.join(w.opRoot,w.originalId+'.json'),JSON.stringify(w.original));await assert.rejects(w.preview(),/TARGET_CHANGED/);assert.equal(w.stats.executions,0);assert.equal(read(w,'work/p1'),'SIBLING');});

test('隔离目标替换为符号链接时不追踪删除新产物',async()=>{const w=await world();fs.renameSync(path.join(w.root,w.destination),path.join(w.root,w.destination+'-backup'));
// 平台接线：Windows 非特权创建目录符号链接 EPERM；junction 同为目录重解析点，
// Node 在 Windows 上对 lstat/DirEntry 均报 isSymbolicLink()===true，生产 LINK_OR_REPARSE_POINT 检测与全部断言不变。
fs.symlinkSync(path.join(w.root,'work/p0'),path.join(w.root,w.destination),process.platform==='win32'?'junction':'dir');await assert.rejects(w.preview(),/NO_VERIFIED_TARGETS|SYMLINK/);assert.equal(read(w,'work/p0'),'NEW');assert.equal(w.stats.executions,0);});

test('执行忙留下原错误，不自动重发；重载只查询',async()=>{const w=await world(),p=await w.preview();await w.approve(p);w.setBusyExecute(true);const result=await w.host.execute(p.token);assert.notEqual(result.state,'completed');assert.match(result.error,/OPERATION_BUSY/);assert.equal(w.stats.executions,1);assert.ok((await w.audit()).some(e=>e.kind==='busy'));await assert.rejects(w.makeHost().execute(p.token),e=>e.apiData?.code==='ISOLATED_DELETE_QUERY_REQUIRED');assert.equal(w.stats.executions,1);assert.equal(read(w,w.destination),'OLD');});

test('独立执行不等原提交 tick，不占全项目锁，仍保留执行互斥',async()=>{const w=await world(),p=await w.preview();await w.approve(p);w.underlying.distributedQueueTickPromise=new Promise(()=>{});let release;w.setHold(new Promise(r=>release=r));const pending=w.host.execute(p.token);await w.executionEntered;assert.equal(w.host.blocksTaskScheduling,false);await assert.rejects(w.host.execute(p.token),/BUSY/);release();w.setHold(undefined);assert.equal((await pending).state,'completed');assert.equal(w.stats.leaseCalls,0);});

test('桥接限制原操作、保留双确认，取消后旧授权不可恢复执行',async()=>{const w=await world();await w.host.openIsolatedBatchReviews();new vm.Script(w.panel.webview.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);assert.match((await w.send({type:'preview'})).message,/REVIEW_ONLY/);assert.match((await w.send({type:'status',operationId:'f'.repeat(48)})).message,/IDENTITY_CHANGED/);assert.match((await w.send({type:'resume'})).message,/REVIEW_ONLY/);const p=(await w.send({type:'deleteIsolated'})).preview;assert.ok(p);await w.send({type:'confirm',phase:1});await w.send({type:'confirm',phase:2});await w.send({type:'cancel'});assert.match((await w.send({type:'execute'})).message,/RECONFIRM_REQUIRED/);assert.equal(w.stats.executions,0);assert.ok((await w.audit()).some(e=>e.kind==='cancelled'));});
