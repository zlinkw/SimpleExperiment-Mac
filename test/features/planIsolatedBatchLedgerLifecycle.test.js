const { test, assert, fs, os, path, fork, ledger, runSelectedPlans, Q, ts, tmpFile, replacementState, extractMethodBody, legacySource, transpile, seed, observed, spawnChild, batchFixture, runBatch } = require("./planIsolatedBatchLedger.support.cjs");

test('跨进程锁：正常创建者释放；活 owner 与过期未知 owner 都保留原锁并快速 fail closed',async()=>{
  const file=tmpFile('ledger.json');
  await ledger.freezeBatchScope(file,{batchId:'b-1',projectRoot:'/proj'},[{planFile:'plans/a.yaml',submissionOperationId:'op-a'}]);
  assert.equal(fs.existsSync(file+'.lock'),false,'正常创建者工作结束后释放自己的锁');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name=>name.includes('.stolen.')||name.includes('.released.')),[],'回收与释放不留残片');
  fs.writeFileSync(file+'.lock',JSON.stringify({token:'alive',host:os.hostname(),pid:process.pid,expiresAt:new Date(Date.now()+3_600_000).toISOString()}));
  const before=fs.readFileSync(file,'utf8');
  const startedAt=Date.now();
  await assert.rejects(()=>ledger.freezeBatchScope(file,{batchId:'b-2',projectRoot:'/proj'},[{planFile:'plans/x.yaml',submissionOperationId:'op-x'}]),
    /ISOLATED_BATCH_LEDGER_LOCKED/);
  assert.ok(Date.now()-startedAt<3000,'活锁必须快速失败（不阻塞提交/派发回合）');
  assert.equal(fs.readFileSync(file,'utf8'),before,'等不到锁绝零写入');
  assert.equal(fs.existsSync(file+'.lock'),true,'抢锁失败者绝不删除他人活锁（TTL 未到也不可）');
  const unknownFile=tmpFile('unknown.json'),raw=JSON.stringify({token:'dead',expiresAt:new Date(0).toISOString()});
  fs.writeFileSync(unknownFile+'.lock',raw);
  await assert.rejects(ledger.freezeBatchScope(unknownFile,{batchId:'b-1',projectRoot:'/proj'},[{planFile:'p',submissionOperationId:'o'}]),/ISOLATED_BATCH_LEDGER_LOCKED/);
  assert.equal(fs.readFileSync(unknownFile+'.lock','utf8'),raw);
  assert.equal(fs.existsSync(unknownFile),false,'无法证明失主时零账本写入');
});

test('真实进程互斥：竞争者不能摘走活锁；原 owner 释放后才进入',async()=>{
  const distFile=path.resolve(__dirname,'../../dist/features/PlanIsolatedBatchLedger.js');
  assert.ok(fs.existsSync(distFile),'双进程夹具消费编译产物；请先 npm run typecheck');
  const file=tmpFile('ledger.json');
  const eventsFile=file+'.events';// 锁内物理事件账本：仅持锁进程在临界区内追加，行序=真实串行序（2026-10-23 等强证明返修）
  const b=spawnChild(distFile,file,'ordinary',eventsFile);let a;
  const cleanup=async()=>{for(const w of [a,b].filter(Boolean)){try{if(w.p.connected)w.p.send('release');}catch{/* 已断开 */}}
    for(const w of [a,b].filter(Boolean))await Promise.race([new Promise(r=>w.p.on('close',r)),new Promise(r=>setTimeout(r,200))]);
    for(const w of [a,b].filter(Boolean))if(w.p.exitCode===null){w.p.kill('SIGKILL');}};
  try{
    const bEntered=await b.wait('entered');
    const originalLock=fs.readFileSync(file+'.lock','utf8');a=spawnChild(distFile,file,'ordinary',eventsFile);
    await new Promise(r=>setTimeout(r,400));
    assert.ok(!a.events.some(m=>m.event==='entered'),'旧回收者用过期观察 rename 掉 B 活锁后不得进入临界区');
    const live=JSON.parse(fs.readFileSync(file+'.lock','utf8'));
    assert.equal(JSON.stringify(live),originalLock,'B 活锁始终在位，不能先摘走再还原');
    try{a.p.send('release');}catch{/* 已结束 */}
    try{b.p.send('release');}catch{/* 已结束 */}
    await b.wait('done');
    await a.wait('done');
    assert.notEqual(a.p.pid,b.p.pid,'回归必须由两个真实进程完成');
    const aEntered=a.events.find(m=>m.event==='entered');
    assert.ok(aEntered,'A 应串行排队——本场景 B 已释放故 A 必须随后进入');
    // 等强串行证明（2026-10-23 返修，替换原 enteredAt>=bDoneAt-50 观测时刻断言）：
    // ENTER/LEAVE 由各持锁进程在生产锁持有期内追加，锁本身保证写入互斥，
    // 因此账本行序就是临界区的真实串行序——不依赖任何父进程观测时刻，零时间容差。
    // 偷锁/插入会直接破坏严格 4 行序；活锁原位、不同 PID、无残片断言全部保留在下方。
    const seq=fs.readFileSync(eventsFile,'utf8').trim().split(/\r?\n/);
    assert.deepEqual(seq,['ENTER '+b.p.pid,'LEAVE '+b.p.pid,'ENTER '+a.p.pid,'LEAVE '+a.p.pid],
      '锁内事件账本必须呈严格 B.enter→B.leave→A.enter→A.leave（真实串行恢复）');
    assert.equal(fs.existsSync(file+'.lock'),false,'两进程收尾后锁已释放');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name=>name.includes('.stolen.')||name.includes('.released.')),[],'CAS 回收与还原不留残片');
  }finally{await cleanup();}
});

test('真实 producer 链：真 enqueuePlan→真 commit 方法→真 mergeDurableWorkerSnapshots 投影→真 promote 方法；取消+resultQueryError 非证明、窗口观察才是、粘性不丢',async()=>{
  const file=tmpFile('chain.json');
  const projectId=Q.canonicalProjectId('/proj');
  const makeCommit=new Function('markPlanTerminal','return async function (submissionOperationId, planFile, cardId, queuedPlan) {'
    +transpile(extractMethodBody(legacySource,'async commitIsolatedEnqueueLocal(submissionOperationId, planFile, cardId, queuedPlan) {'))+'};');
  const makePromote=new Function('DistributedPlanQueue','workspaceRoot','promoteDispatchedPlans','return async function (generation) {'
    +transpile(extractMethodBody(legacySource,'async promoteIsolatedDispatchLocal(generation) {'))+'};');
  const commit=makeCommit(ledger.markPlanTerminal),promote=makePromote(Q,()=>'/proj',ledger.promoteDispatchedPlans);
  const stubThis={currentIsolatedBatchLocal:{batchId:'b-1'},isolatedReplacementLedgerFileLocal:()=>file,distributedQueueGeneration:7,loadDistributedQueue:async()=>undefined};
  // 真 enqueuePlan：pending job 无 commandId → committed 只到 awaiting_dispatch，job 身份空串占位。
  const q=Q.enqueuePlan({schemaVersion:1,plans:[],clearedJobs:[]},{projectId,executionMode:'train',schedulingMode:'local_idle',
    planJobCount:1,fullPlanJobCount:1,planFile:'plans/a.yaml',revision:'rev',codeFingerprint:'fp',
    jobs:[{index:0,case:'a',seed:1,outputDir:'work/a',collectionResultCsv:'work/a/m.csv'}]},'card');
  const card=q.plans.find(row=>row.id==='card');
  await ledger.freezeBatchScope(file,{batchId:'b-1',projectRoot:'/proj',canonicalProjectId:projectId},[{planFile:'plans/a.yaml',submissionOperationId:'submit'}]);
  await ledger.attachIsolatedCleanup(file,{batchId:'b-1'},{submissionOperationId:'submit',planFile:'plans/a.yaml',revision:'rev',codeFingerprint:'fp',runReplacement:replacementState('iso-1')});
  assert.equal(await commit.call(stubThis,'submit','plans/a.yaml','card',card),true);
  let [batch]=(await ledger.loadIsolatedBatchLedger(file));
  assert.equal(batch.plans[0].state,'awaiting_dispatch','真入队落盘绝不冒充已派发');
  // 派发后的队列（commandId 由派发链生成的形状）+ 取消+resultQueryError+无窗口的原生快照：
  const at=new Date().toISOString(),now=Date.now();
  const queue={schemaVersion:1,plans:[{...card,projectId,jobs:card.jobs.map(job=>({...job,commandId:'new-0',workerId:'worker',status:'dispatching'}))}]};
  const cancelTask=observation=>({workerId:'worker',fetchedAt:at,generatedAt:at,capabilities:{taskLifecycle:2},
    tasks:[{commandId:'new-0',projectId,outputDir:'work/a',collectionResultCsv:'work/a/m.csv',observation}]});
  const cancelled=Q.mergeDurableWorkerSnapshots(JSON.parse(JSON.stringify(queue)),
    [cancelTask({lifecycleProtocol:2,commandId:'new-0',projectId,workerId:'worker',observedAt:at,cancelled:true,tmux:null,result:null,resultQueryError:'result observation unavailable'})],projectId,now,30000);
  const cancelledJob=cancelled.plans[0].jobs[0];
  assert.equal(cancelledJob.nativeStartProof,undefined,'取消标记+无窗口不得置原生启动证明');
  assert.ok((cancelledJob.observationErrors||[]).some(text=>/result observation unavailable/.test(text)),'resultQueryError 必须留在完整错误清单里');
  stubThis.loadDistributedQueue=async()=>cancelled;
  assert.equal(await promote.call(stubThis,7),0,'投影后的取消假证据绝不能提升');
  assert.equal((await ledger.loadIsolatedBatchLedger(file))[0].plans[0].state,'awaiting_dispatch');
  // 有物理窗口的原生观察 → 置证明 → 真 promote 方法整链提升。
  const running=Q.mergeDurableWorkerSnapshots(JSON.parse(JSON.stringify(queue)),
    [cancelTask({lifecycleProtocol:2,commandId:'new-0',projectId,workerId:'worker',observedAt:at,tmux:{paneId:'%1',windowId:'@1',dead:false,phase:'running'}})],projectId,now,30000);
  const runningJob=running.plans[0].jobs[0];
  assert.equal(runningJob.nativeStartProof.source,'worker_snapshot_task_l2');
  stubThis.loadDistributedQueue=async()=>running;
  assert.equal(await promote.call(stubThis,7),1);
  [batch]=await ledger.loadIsolatedBatchLedger(file);
  assert.equal(batch.plans[0].state,'dispatched');
  assert.equal(batch.plans[0].jobs[0].expectedCommandId,'new-0','绑定来自真实派发身份');
  assert.equal(ledger.eligibleIsolatedReviews([batch],'/proj').length,1);
  // 粘性：证明置位后再来取消/无窗口投影，启动事实不被抹掉。
  const afterCancel=Q.mergeDurableWorkerSnapshots(JSON.parse(JSON.stringify(running)),
    [cancelTask({lifecycleProtocol:2,commandId:'new-0',projectId,workerId:'worker',observedAt:at,cancelled:true,tmux:null,result:null})],projectId,now+1000,30000);
  assert.deepEqual(afterCancel.plans[0].jobs[0].nativeStartProof,runningJob.nativeStartProof,'已核实的原生启动证明不得被后续取消投影抹掉');
  // 换代失效：commandId 换了则旧证明不迁移。
  const nextGen={schemaVersion:1,plans:[{...card,projectId,jobs:card.jobs.map(job=>({...job,commandId:'new-1',workerId:'worker',status:'dispatching',nativeStartProof:runningJob.nativeStartProof}))}]};
  const regen=Q.mergeDurableWorkerSnapshots(nextGen,[cancelTask({lifecycleProtocol:2,commandId:'new-1',projectId,workerId:'worker',observedAt:at,cancelled:true,tmux:null,result:null})],projectId,now+2000,30000);
  assert.notEqual(regen.plans[0].jobs[0].nativeStartProof,runningJob.nativeStartProof,'旧 command 的证明不得迁移到新代际');
});

test('a 隔离前失败 + b 成功：a→void、b 只到 awaiting_dispatch、批次永不合格；随后 0 字节损坏也原样保留',async()=>{
  const ledgerFile=tmpFile('ledger.json');
  const report=await runBatch(batchFixture({ledgerFile,statuses:{'plans/a.yaml':'throw'}}));
  assert.match(report.message,/存在失败\/取消\/结果未知或派发未核实的项，本批整体不浮出隔离区删除审核/);
  assert.doesNotMatch(report.message,/已核实远端派发/);
  const batches=await ledger.loadIsolatedBatchLedger(ledgerFile);
  assert.equal(batches.length,1);assert.equal(batches[0].plans.length,2,'初始集合完整：隔离前失败的 a 也在账本内');
  const state=name=>batches[0].plans.find(plan=>plan.planFile===name).state;
  assert.equal(state('plans/a.yaml'),'void');assert.equal(state('plans/b.yaml'),'awaiting_dispatch');
  assert.equal(ledger.eligibleIsolatedReviews(batches,'/proj').length,0,'a void ⇒ 批次永不合格');
  fs.writeFileSync(ledgerFile,'');
  await assert.rejects(()=>ledger.markPlanTerminal(ledgerFile,{batchId:batches[0].batchId},{submissionOperationId:'op-x',planFile:'plans/a.yaml',status:'void'}),
    /ISOLATED_BATCH_LEDGER_CORRUPT/);
  assert.equal(fs.statSync(ledgerFile).size,0,'0 字节损坏保留');
});

test('真实入口：初始全选一次冻结（含无隔离 PLAN）、别名去重、unknown 未准入、账本故障提交不受阻',async()=>{
  const ledgerFile=tmpFile('ledger.json');
  const report=await runBatch(batchFixture({ledgerFile,statuses:{'plans/b.yaml':'plain'}}));
  const batches=await ledger.loadIsolatedBatchLedger(ledgerFile);
  assert.equal(batches[0].plans.length,2,'无隔离旧产物的 PLAN 同样在初始集合');
  assert.ok(batches[0].plans.every(plan=>plan.state==='awaiting_dispatch'));
  assert.equal(ledger.eligibleIsolatedReviews(batches,'/proj').length,0);
  assert.match(report.message,/等待已登记状态轮询核实远端派发/);
  assert.match(report.message,/本机入队不等于已启动/);
  const file2=tmpFile('ledger2.json');
  await runBatch(batchFixture({ledgerFile:file2}),['plans/a.yaml','plans/a.yaml']);
  assert.equal((await ledger.loadIsolatedBatchLedger(file2))[0].plans.length,1);
  const file3=tmpFile('ledger3.json');
  const report3=await runBatch(batchFixture({ledgerFile:file3,statuses:{'plans/b.yaml':'unknown'}}));
  assert.equal((await ledger.loadIsolatedBatchLedger(file3))[0].plans.find(plan=>plan.planFile==='plans/b.yaml').state,'unknown');
  assert.match(report3.message,/本批整体不浮出隔离区删除审核/);
  const dir=tmpFile('not-a-dir');fs.writeFileSync(dir,'x');
  const report4=await runBatch(batchFixture({ledgerFile:path.join(dir,'ledger.json')}));
  assert.equal(report4.rows.filter(row=>row.status==='succeeded').length,2,'账本故障不阻断正常提交');
  assert.match(report4.message,/隔离区删除审核账本本次不可用/);
});

test('legacy 文案：删除后最终写入身份漂移不谎称「未删除文件」；停止前阶段保留准确文案',()=>{
  const finalAt=legacySource.indexOf('队列保留外部最新修改与原任务身份');
  assert.ok(finalAt>0);
  const finalMessage=legacySource.slice(finalAt-260,finalAt+40);
  assert.ok(!finalMessage.includes('未删除文件'),'mutateLatest 已发生在删除后：不得再报「未删除文件」');
  assert.match(finalMessage,/未入队——此前所选 job 旧产物的清理已在本流程中实际发生/);
  assert.match(legacySource,/未删除文件，未重新排队。（阶段：/,'停止前 fence 阶段保留「未删除文件」准确文案');
});

test('源码钉：账本安全原语、真实 producer 接线与提升来源约束',()=>{
  const module=fs.readFileSync(path.resolve(__dirname,'../../src/features/PlanIsolatedBatchLedger.ts'),'utf8');
  assert.match(module,/fs\.open\(lockPath, "wx"\)/);
  assert.doesNotMatch(module,/fs\.(rename|link)\(lockPath,/,'竞争者不得先摘锁后复核');
  assert.doesNotMatch(module,/pidAlive|ownerRemovable/,'TTL/PID 不授权自动摘取任何锁');
  assert.match(module,/ownerToken !== fence\.token/,'写盘前失主 fencing');
  assert.match(module,/const PROOF_STATUSES = \["running"\]/);
  assert.match(module,/now - at < 0/,'任何未来观察都拒绝');
  const queue=fs.readFileSync(path.resolve(__dirname,'../../src/features/DistributedPlanQueue.ts'),'utf8');
  assert.match(queue,/nativeStartProof\.commandId === job\.commandId\s*&& job\.nativeStartProof\.workerId === job\.workerId \? job\.nativeStartProof/,'粘性证明按 commandId 和 Worker 换代');
  assert.match(queue,/observation\.queryError, observation\.executionQueryError, observation\.resultQueryError, observation\.runtimeQueryError/,'完整错误清单');
  assert.match(queue,/observation\.tmux\?\.dead === false && \["starting", "running"\]\.includes\(state\.execution\)/,'真实活窗口且原生执行阶段核实才建证');
  assert.match(legacySource,/await this\.commitIsolatedEnqueueLocal\(submissionOperationId, planFile, id,/,'committed 终局走真实 producer 方法');
  assert.match(legacySource,/proof && proof\.commandId === job\.commandId && proof\.workerId === job\.workerId/,'提升只消费同 command 同 Worker 原生证明');
  assert.match(legacySource,/source: valid \? String\(proof\.source\)/);
  assert.match(legacySource,/await this\.promoteIsolatedDispatchLocal\(generation\)/);
  assert.match(legacySource,/typeof this\.promoteIsolatedDispatchLocal === "function"/,'VM 部分提取防护，不影响真实类内恒定接线');
  const batch=fs.readFileSync(path.resolve(__dirname,'../../src/extension/SelectedPlanBatchHost.ts'),'utf8');
  assert.ok(batch.indexOf('const planMessages')<batch.indexOf('await freezeBatchScope('));
  assert.ok(!/admitted\s*=\s*true/.test(batch));
});
