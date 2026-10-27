const { test, assert, fs, os, path, fork, ledger, runSelectedPlans, Q, ts, tmpFile, replacementState, extractMethodBody, legacySource, transpile, seed, observed, spawnChild, batchFixture, runBatch } = require("./planIsolatedBatchLedger.support.cjs");

// 用户裁定 B（2026-10-26）退役两条锁协议用例（所测行为已随锁移除，完整退役清单见 planIsolatedLedgerLock.test.js 头注）：
//   原:3  '跨进程锁：正常创建者释放；活 owner 与过期未知 owner 都保留原锁并快速 fail closed'（锁获取/释放/遗留锁保留）
//   原:23 '真实进程互斥：竞争者不能摘走活锁；原 owner 释放后才进入'（跨进程锁互斥与锁内事件序）
// 跨进程"第二写入者"场景现在由写前指纹比对 fail closed，覆盖在 planIsolatedLedgerLock.test.js（CAS 套件）。

test('helper 反例（r28-U1）：子进程真实 IPC error 即时拒绝 done 等待并附完整诊断，不伪装 3000ms IPC 超时',async()=>{
  const distFile=path.resolve(__dirname,'../../dist/features/PlanIsolatedBatchLedger.js');
  assert.ok(fs.existsSync(distFile),'双进程夹具消费编译产物；请先 npm run typecheck');
  const c=spawnChild(distFile,tmpFile('ledger-boom.json'),'boom','');
  await assert.rejects(c.wait('done'),err=>{
    assert.match(err.message,/fixture-boom/,'真实错误消息必须原样上报');
    assert.doesNotMatch(err.message,/IPC timeout/,'即时拒绝不得伪装成超时（job-107 首因伪装层）');
    assert.match(err.message,/events=/,'诊断必须含实际 IPC 事件清单');
    assert.match(err.message,/stdout=|stderr=/,'诊断必须含已 drain 的子进程 stdio');
    return true;});
  await assert.rejects(c.wait('entered'),/fixture-boom/,'后续 wait 同样即时拒绝，不再吊满预算');
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
  // 裁定 B（2026-10-26）：锁原语钉整体替换为 CAS 原语钉（去锁＋写前指纹比对，复用既有身份/哈希实现）。
  assert.match(module,/identityFromStat\(await fs\.stat\(file\)\)/,'读取时记身份元组：复用 LocalCodeManifestCache 身份函数，未新造判据');
  assert.match(module,/sameIdentity\(expected, identity\)/,'快路径：身份六项全未变即落盘，不重算哈希');
  assert.match(module,/sha256File\(file\)/,'慢路径内容比对复用既有 sha256File，未新写文件哈希');
  assert.match(module,/LEDGER_STALE = "ISOLATED_BATCH_LEDGER_STALE"/,'写前不符 fail closed 的新错误码');
  assert.doesNotMatch(module,/acquireLedgerLock|releaseScript|classifyAbandonedZeroByteLock|nextIsolatedLedgerReport|LEDGER_LOCK_LOST/,'锁文件全链、零字节分类与限流已随裁定 B 移除');
  assert.doesNotMatch(module,/pidAlive|ownerRemovable/,'不存在任何自动摘锁取锁代码路径');
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

// ─── 用户授权 2026-10-26（裁定 B 后续）：两处原静默失败点补可见性 ───────────────────────────
// attach 隔离事实与 committed 终局的账本写失败原为空 catch/return false 静默消失，现经既有
// action_errors 通道（command isolatedLedgerWrite）如实记录一条；fail-closed 准入语义一字未动。
// 测试落点选本套件：仓内唯一已装配 commitIsolatedEnqueueLocal 真实方法体提取（makeCommit 同款）
// 与源码钉约定的套件；planOperationNoticeLifecycle 管的是 operation notice 瞬时通知道，而本次
// 选择的通道是 action_errors 持久诊断，不是 notice，故不放那边、也不新开文件。
const errorMessageStub=error=>String(error?.message||error);
const observeWriteFailure=(()=>{const make=new Function('errorMessage','return function (kind, batchId, operationId, error) {'
  +transpile(extractMethodBody(legacySource,'observeIsolatedLedgerWriteFailure(kind, batchId, operationId, error) {'))+'};');
  return make(errorMessageStub);})();

test('可见性（用户授权）：committed 终局写失败 ⇒ action_errors 记一条可见诊断，入队结果与 fail-closed 语义不变',async()=>{
  const makeCommit=new Function('markPlanTerminal','return async function (submissionOperationId, planFile, cardId, queuedPlan) {'
    +transpile(extractMethodBody(legacySource,'async commitIsolatedEnqueueLocal(submissionOperationId, planFile, cardId, queuedPlan) {'))+'};');
  const records=[];
  const stubThis={currentIsolatedBatchLocal:{batchId:'b-vis'},isolatedReplacementLedgerFileLocal:()=>'ledger-vis.json',
    observeIsolatedLedgerWriteFailure:observeWriteFailure,recordActionError:row=>records.push(row)};
  const stale=new Error('ISOLATED_BATCH_LEDGER_STALE：写盘前比对发现账本已被其他写入者改动；本轮零写入（临时文件保留为证据、不删），原文件保持原样，审核入口本回合关闭。路径: ledger-vis.json。可能有第二个窗口在写，请只保留一个窗口后重试。');
  const commit=makeCommit(async()=>{throw stale;});
  assert.equal(await commit.call(stubThis,'submit-vis','plans/a.yaml','card',{jobs:[{index:0,commandId:'cmd-0'}]}),false,
    'fail-closed 原样：终局写失败仍 return false，不阻断已提交入队');
  assert.equal(records.length,1,'恰一条可见记录，无双通道重复');
  assert.equal(records[0].command,'isolatedLedgerWrite');
  assert.match(records[0].message,/committed 终局/);assert.match(records[0].message,/批次 b-vis/);assert.match(records[0].message,/操作 submit-vis/);
  assert.match(records[0].message,/ISOLATED_BATCH_LEDGER_STALE/);assert.match(records[0].message,/第二个窗口/);
  assert.match(records[0].message,/隔离副本已保留，本次不进入清理审核，需人工确认后可重试/);
});

test('可见性（用户授权）：attach 隔离事实失败接线 isolatedLedgerWrite；原空 catch 移除，SelectedPlanBatchHost 提示链不重复记账',()=>{
  const records=[];
  observeWriteFailure.call({recordActionError:row=>records.push(row)},'隔离事实','b-vis-2','op-iso-2',
    new Error('ISOLATED_BATCH_LEDGER_STALE：写盘前比对发现账本已被其他写入者改动'));
  assert.equal(records.length,1);
  assert.equal(records[0].command,'isolatedLedgerWrite');
  assert.match(records[0].message,/隔离事实.*批次 b-vis-2.*操作 op-iso-2/);
  assert.match(records[0].message,/隔离副本已保留，本次不进入清理审核，需人工确认后可重试/);
  const at=legacySource.indexOf('try { await attachIsolatedCleanup(isolatedLedgerFile');
  assert.ok(at>0,'attach 调用点仍在');
  const region=legacySource.slice(at,at+1200);
  assert.match(region,/catch \(error\) \{[\s\S]*this\.observeIsolatedLedgerWriteFailure\("隔离事实", isolatedBatchInfo\.batchId, operationId, error\)/,
    'attach 失败必须经可见通道记录（含批次与操作身份）');
  assert.ok(!/catch \{ \/\* 账本写入失败/.test(region),'原静默空 catch {} 已移除');
  const batchHost=fs.readFileSync(path.resolve(__dirname,'../../src/extension/SelectedPlanBatchHost.ts'),'utf8');
  assert.ok(!batchHost.includes('isolatedLedgerWrite'),
    '去重：freeze 失败仍只走 :147 既有 ledgerError 提示链；单个写操作失败只产生一条可见记录，两个通道不叠加');
});
