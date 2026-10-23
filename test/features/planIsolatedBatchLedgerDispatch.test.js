const { test, assert, fs, os, path, fork, ledger, runSelectedPlans, Q, ts, tmpFile, replacementState, extractMethodBody, legacySource, transpile, seed, observed, spawnChild, batchFixture, runBatch } = require("./planIsolatedBatchLedger.support.cjs");

test('启动证明矩阵：只有 running 观察是证明；queued/dispatching/pending/unknown 与终态（completed/failed/cancelled）一律拒绝；未来时间拒绝；错身份拒绝',async()=>{
  const file=await seed({file:tmpFile('ledger.json')});
  const stillAwaiting=async()=>{const [batch]=await ledger.loadIsolatedBatchLedger(file);
    assert.equal(batch.plans[0].state,'awaiting_dispatch');
    assert.deepEqual(ledger.eligibleIsolatedReviews([batch],'/proj'),[]);};
  for(const bad of [{status:'queued'},{status:'dispatching'},{status:'pending'},{status:'unknown'},{status:'completed'},{status:'failed'},{status:'cancelled'},
    {statusQueryError:'任务产物路径与当前任务不符；请刷新核实'},{statusQueryError:'状态查询已过期'},
    {lastObservedAt:new Date(Date.now()-2*3600_000).toISOString()},{lastObservedAt:new Date(Date.now()+86400_000).toISOString()},{lastObservedAt:''},
    {workerId:''},{commandId:'cmd-other'},{projectId:'cp-2'}]){
    assert.equal(await ledger.promoteDispatchedPlans(file,'/proj',[observed(Date.now(),bad)],Date.now()),0,JSON.stringify(bad));
    await stillAwaiting();
  }
  assert.equal(await ledger.promoteDispatchedPlans(file,'/other',[observed(Date.now())],Date.now()),0,'他项目不被误升');
  // 已知期望 commandId 的严格匹配：先拒后升。
  assert.equal(await ledger.promoteDispatchedPlans(file,'/proj',[observed(Date.now())],Date.now()),1);
  const [batch]=await ledger.loadIsolatedBatchLedger(file);
  assert.equal(batch.plans[0].state,'dispatched');
  assert.equal(batch.plans[0].jobs[0].proof.source,'registered_poll');
  assert.equal(ledger.eligibleIsolatedReviews([batch],'/proj').length,1);
});

test('交错启动：逐 job 证明先证先存持久保留，不要求同时新鲜；原生粘性来源可越新鲜窗补登',async()=>{
  const file=await seed({file:tmpFile('ledger.json'),jobs:[{jobIndex:0,expectedCommandId:'new-0'},{jobIndex:1,expectedCommandId:'new-1'}]});
  const now=Date.now();
  await ledger.promoteDispatchedPlans(file,'/proj',[observed(now)],now);
  let [batch]=await ledger.loadIsolatedBatchLedger(file);
  assert.equal(batch.plans[0].state,'dispatched','该 PLAN 首个原生 job 启动即到边界，不等待所有 seed');
  assert.ok(batch.plans[0].jobs[0].proof,'job0 证明必须已持久化');
  // 120s 后：job0 的原观察早已过期、状态也变 completed——不得抹掉已核实事实；job1 新观察到位即整批 dispatched。
  assert.equal(await ledger.promoteDispatchedPlans(file,'/proj',[observed(now,{status:'completed'}),observed(now+120000,{jobIndex:1,commandId:'new-1'})],now+120000),0,'已到边界不重复提升，后续证明仍保存');
  [batch]=await ledger.loadIsolatedBatchLedger(file);
  assert.equal(batch.plans[0].state,'dispatched');
  assert.deepEqual(ledger.eligibleIsolatedReviews([batch],'/proj').length,1);
  // 重载不丢（文件持久）：
  const reloaded=await ledger.loadIsolatedBatchLedger(file);
  assert.equal(reloaded[0].plans[0].state,'dispatched');
  // 原生粘性来源（windowSeen）1 小时前的证明仍可补登；无来源同旧观察拒绝。
  const file2=tmpFile('l2.json');
  await seed({file:file2,attach:false});
  assert.equal(await ledger.promoteDispatchedPlans(file2,'/proj',[observed(Date.now()-3600_000)],Date.now()),0,'无原生来源的旧观察不得越新鲜窗');
  assert.equal(await ledger.promoteDispatchedPlans(file2,'/proj',[observed(Date.now()-3600_000,{source:'worker_snapshot_task_l2',windowSeen:true})],Date.now()),1);
});

test('commandId 首证绑定：落盘点未派发生成时留空，首个原生证明持久绑定，之后严格匹配',async()=>{
  const file=await seed({file:tmpFile('bind.json'),jobs:[{jobIndex:0,expectedCommandId:''}],attach:false});
  assert.equal(await ledger.promoteDispatchedPlans(file,'/proj',[observed(Date.now(),{commandId:'cmd-bound'})],Date.now()),1);
  const [batch]=await ledger.loadIsolatedBatchLedger(file);
  assert.equal(batch.plans[0].jobs[0].expectedCommandId,'cmd-bound','绑定必须持久写入账本');
  assert.equal(batch.plans[0].state,'dispatched');
});

test('PLAN 首个原生启动即到边界；同卡 command 或 Worker 换代撤销旧事实，重载后仍不合格',async()=>{
  for(const patch of [{commandId:'new-generation'},{workerId:'new-worker'}]){
    const file=await seed({file:tmpFile('generation.json'),jobs:[{jobIndex:0,expectedCommandId:'new-0'},{jobIndex:1,expectedCommandId:'later-1'}]});
    const now=Date.now();
    assert.equal(await ledger.promoteDispatchedPlans(file,'/proj',[observed(now)],now),1);
    assert.equal(ledger.eligibleIsolatedReviews(await ledger.loadIsolatedBatchLedger(file),'/proj').length,1,'不要求其它 seed 同时启动');
    await ledger.promoteDispatchedPlans(file,'/proj',[observed(now+1,{...patch,status:'queued'})],now+1);
    const [batch]=await ledger.loadIsolatedBatchLedger(file);
    assert.equal(batch.plans[0].state,'unknown');
    assert.ok(batch.plans[0].jobs.every(job=>job.proof===undefined));
    assert.equal(ledger.eligibleIsolatedReviews([batch],'/proj').length,0);
  }
});

test('unknown 回执不能借卡身份伪装 committed；同一回执中的隔离 operation 目标冲突整体拒绝',async()=>{
  const file=tmpFile('unknown-identity.json');
  await ledger.freezeBatchScope(file,{batchId:'b-1',projectRoot:'/proj'},[{planFile:'plans/a.yaml',submissionOperationId:'op-a'}]);
  const before=fs.readFileSync(file,'utf8'),state=replacementState('same-token');
  const conflicting=structuredClone(state.previews[0]);conflicting.preview.rows[0].destination='clean_dir/unapproved';state.previews.push(conflicting);
  assert.equal(await ledger.attachIsolatedCleanup(file,{batchId:'b-1'},{planFile:'plans/a.yaml',submissionOperationId:'op-a',revision:'r',codeFingerprint:'f',runReplacement:state}),false);
  assert.equal(fs.readFileSync(file,'utf8'),before,'冲突不得部分写入');
  await ledger.markPlanTerminal(file,{batchId:'b-1'},{planFile:'plans/a.yaml',submissionOperationId:'op-a',status:'unknown',identity:{queuePlanId:'card',jobs:[{jobIndex:0,expectedCommandId:'cmd'}]}});
  assert.equal((await ledger.loadIsolatedBatchLedger(file))[0].plans[0].state,'unknown');
});
