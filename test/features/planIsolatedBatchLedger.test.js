const { test, assert, fs, os, path, fork, ledger, runSelectedPlans, Q, ts, tmpFile, replacementState, extractMethodBody, legacySource, transpile, seed, observed, spawnChild, batchFixture, runBatch } = require("./planIsolatedBatchLedger.support.cjs");

test('损坏账本保留原字节并 fail closed：0/47 字节与未知版本在写入尝试后原样保留',async()=>{
  for(const bytes of ['','x'.repeat(47)]){
    const file=tmpFile('ledger.json');
    fs.writeFileSync(file,bytes);
    await assert.rejects(()=>ledger.freezeBatchScope(file,{batchId:'b-1',projectRoot:'/proj'},[{planFile:'plans/a.yaml',submissionOperationId:'op-a'}]),
      /ISOLATED_BATCH_LEDGER_CORRUPT/);
    assert.equal(fs.readFileSync(file,'utf8'),bytes,'损坏字节必须原样保留（不覆盖、不视为空）');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name=>name.includes('.tmp')||name.includes('.lock')||name.includes('.stolen.')||name.includes('.released.')),[],'拒写路径不留任何残留');
  }
  const file=tmpFile('v1.json');
  fs.writeFileSync(file,JSON.stringify({version:1,batches:[{batchId:'old',projectRoot:'/proj',frozenAt:'',plans:[]}]}));
  await assert.rejects(()=>ledger.loadIsolatedBatchLedger(file),/ISOLATED_BATCH_LEDGER_CORRUPT/);
  assert.match(fs.readFileSync(file,'utf8'),/"version":1/,'未知版本文件同样原样保留');
});

test('入口冻结完整初始集合；同批重入非增补；隔离目标=登记 destination 的隔离相对路径（源 absolutePath 不入账）',async()=>{
  const file=tmpFile('ledger.json');
  await ledger.freezeBatchScope(file,{batchId:'b-1',projectRoot:'/proj',canonicalProjectId:'cp-1'},
    [{planFile:'plans/a.yaml',submissionOperationId:'op-a'},{planFile:'plans/plain.yaml',submissionOperationId:'op-p'}]);
  assert.equal(await ledger.attachIsolatedCleanup(file,{batchId:'b-1'},{submissionOperationId:'op-a',planFile:'plans/a.yaml',
    revision:'rev-a',codeFingerprint:'fp',runReplacement:replacementState('tok-a')}),true);
  const mid=await ledger.loadIsolatedBatchLedger(file);
  assert.deepEqual(mid[0].plans.find(plan=>plan.planFile==='plans/a.yaml').cleanup,
    [{cleanupOperationId:'tok-a',targets:[{nodeId:'w1',host:'h1.example',sourceRelativePath:'work/a0',isolationRelativePath:'clean_dir/20261022/work/a0',archiveBatch:'20261022'}]}]);
  await assert.rejects(ledger.freezeBatchScope(file,{batchId:'b-1',projectRoot:'/proj'},[{planFile:'plans/a.yaml',submissionOperationId:'op-a'},{planFile:'plans/late.yaml',submissionOperationId:'op-late'}]),/ISOLATED_BATCH_SCOPE_CONFLICT/);
  const after=await ledger.loadIsolatedBatchLedger(file);
  assert.deepEqual(after[0].plans.map(plan=>plan.planFile).sort(),['plans/a.yaml','plans/plain.yaml'],'迟到/新增 PLAN 不混入已冻结批次');
  assert.equal(await ledger.attachIsolatedCleanup(file,{batchId:'b-other'},{submissionOperationId:'op-a',planFile:'plans/a.yaml',revision:'r',codeFingerprint:'f',runReplacement:replacementState('tok-x')}),false);
  assert.equal((await ledger.loadIsolatedBatchLedger(file)).length,1,'别批引用不产生新记录');
});

test('隔离事实首写冻结：同 token 新目标整体拒收且保留原记录；完全相同幂等；revision/codeFingerprint 冲突拒收',async()=>{
  const file=tmpFile('ledger.json');
  await ledger.freezeBatchScope(file,{batchId:'b-1',projectRoot:'/proj'},[{planFile:'plans/a.yaml',submissionOperationId:'op-a'}]);
  await ledger.attachIsolatedCleanup(file,{batchId:'b-1'},{submissionOperationId:'op-a',planFile:'plans/a.yaml',revision:'rev-a',codeFingerprint:'fp',runReplacement:replacementState('tok-a')});
  const before=(await ledger.loadIsolatedBatchLedger(file))[0].plans[0];
  // 同一 completed token 携带新 relativePath 的迟到回调：整体拒收，原记录一字不动。
  const lateRow={completed:['tok-a'],previews:[{preview:{token:'tok-a',rows:[
    {disposition:'isolate',relativePath:'work/unapproved',destination:'clean_dir/old/work/unapproved',node:{id:'w1',host:'h1.example'}}]}}]};
  assert.equal(await ledger.attachIsolatedCleanup(file,{batchId:'b-1'},{submissionOperationId:'op-a',planFile:'plans/a.yaml',
    revision:'rev-a',codeFingerprint:'fp',runReplacement:lateRow}),false);
  assert.deepEqual((await ledger.loadIsolatedBatchLedger(file))[0].plans[0].cleanup,before.cleanup,'同 operation 目标集不可扩');
  // 完全相同重放：幂等 true，字节不变。
  assert.equal(await ledger.attachIsolatedCleanup(file,{batchId:'b-1'},{submissionOperationId:'op-a',planFile:'plans/a.yaml',revision:'rev-a',codeFingerprint:'fp',runReplacement:replacementState('tok-a')}),true);
  assert.deepEqual((await ledger.loadIsolatedBatchLedger(file))[0].plans[0],before);
  // revision 冲突：拒收（保留原记录与新 operation 数据不写入）。
  const evilRow={completed:['tok-b'],previews:[{preview:{token:'tok-b',rows:[
    {disposition:'isolate',relativePath:'work/other',destination:'clean_dir/old/work/other',node:{id:'w1',host:'h1'}}]}}]};
  assert.equal(await ledger.attachIsolatedCleanup(file,{batchId:'b-1'},{submissionOperationId:'op-a',planFile:'plans/a.yaml',
    revision:'rev-EVIL',codeFingerprint:'fp',runReplacement:evilRow}),false);
  const after=await ledger.loadIsolatedBatchLedger(file);
  assert.deepEqual(after[0].plans[0],before);
});

test('终局：失败/取消=void 不回退；无卡身份入队不可信；未派发前无 commandId 允许空串占位；迟到/别批不改写',async()=>{
  const file=tmpFile('ledger.json');
  await ledger.freezeBatchScope(file,{batchId:'b-1',projectRoot:'/proj'},
    [{planFile:'plans/a.yaml',submissionOperationId:'op-a'},{planFile:'plans/b.yaml',submissionOperationId:'op-b'},{planFile:'plans/c.yaml',submissionOperationId:'op-c'}]);
  await ledger.markPlanTerminal(file,{batchId:'b-1'},{submissionOperationId:'op-a',planFile:'plans/a.yaml',status:'failed'});
  await ledger.markPlanTerminal(file,{batchId:'b-1'},{submissionOperationId:'op-b',planFile:'plans/b.yaml',status:'committed',
    identity:{queuePlanId:'plan-b',jobs:[{jobIndex:0,expectedCommandId:''}]}}); // enqueuePlan 落盘点尚无 commandId：允许空串绑定占位
  await ledger.markPlanTerminal(file,{batchId:'b-1'},{submissionOperationId:'op-c',planFile:'plans/c.yaml',status:'committed'});
  await ledger.markPlanTerminal(file,{batchId:'b-1'},{submissionOperationId:'op-a',planFile:'plans/a.yaml',status:'committed',
    identity:{queuePlanId:'plan-a',jobs:[{jobIndex:0,expectedCommandId:'cmd-late'}]}});
  await ledger.markPlanTerminal(file,{batchId:'b-ghost'},{submissionOperationId:'op-b',planFile:'plans/b.yaml',status:'failed'});
  const [batch]=await ledger.loadIsolatedBatchLedger(file);
  const state=name=>batch.plans.find(plan=>plan.planFile===name).state;
  assert.equal(state('plans/a.yaml'),'void','失败终局不被迟到 committed 复活');
  assert.equal(state('plans/b.yaml'),'awaiting_dispatch');
  assert.equal(state('plans/c.yaml'),'unknown','没有卡/job 结构的「入队」不足信');
});

test('merge（导出 API，无生产调用方）：只增未见批次；不扩初始集合；void/dispatched 终局不回退不复活；同 token 目标不借合并扩张',()=>{
  const planA={planFile:'plans/a.yaml',submissionOperationId:'op-a',revision:'r',codeFingerprint:'f',state:'awaiting_dispatch',
    cleanup:[{cleanupOperationId:'tok-a',targets:[{nodeId:'w1',host:'h',sourceRelativePath:'work/a',isolationRelativePath:'clean/a'}]}],
    jobs:[{jobIndex:0,expectedCommandId:'cmd-a'}]};
  const frozen={batchId:'b-1',projectRoot:'/proj',frozenAt:'',plans:[{...structuredClone(planA),state:'frozen'}]};
  const dispatched={...structuredClone(planA),state:'dispatched',jobs:[{jobIndex:0,expectedCommandId:'cmd-a',proof:{observedAt:'x',workerId:'w',source:'s'}}]};
  const voided={...structuredClone(planA),state:'void'};
  // 未选中 PLAN 绝不追加：
  assert.throws(()=>L2(frozen,{...structuredClone(planA),planFile:'plans/unselected.yaml',submissionOperationId:'foreign'}),/SCOPE_CONFLICT/);
  assert.throws(()=>ledger.mergeIsolatedBatches([frozen],[{...structuredClone(frozen),projectRoot:'/different'}]),/SCOPE_CONFLICT/);
  assert.throws(()=>ledger.mergeIsolatedBatches([frozen],[{...structuredClone(frozen),plans:[]}]),/SCOPE_CONFLICT/);
  // void 迟到 dispatched 记录不复活：
  assert.equal(L2({...frozen,plans:[voided]},dispatched).plans[0].state,'void','A cancelled/failed batch member was revived');
  // dispatched 不被 awaiting 降级；awaiting 可被 void 覆盖：
  assert.equal(L2({...frozen,plans:[dispatched]},structuredClone(planA)).plans[0].state,'dispatched');
  assert.equal(L2({...frozen,plans:[structuredClone(planA)]},voided).plans[0].state,'void');
  // 新批次共存 + 合并绝不改既有批次：
  const merged=ledger.mergeIsolatedBatches([frozen],[{batchId:'b-2',projectRoot:'/proj',frozenAt:'',plans:[]}]);
  assert.deepEqual(merged.map(batch=>batch.batchId),['b-1','b-2']);
  // 同 token 目标集不扩张；新 token 记录可追加：
  const expandTarget={...voided,cleanup:[{cleanupOperationId:'tok-a',targets:[...structuredClone(planA.cleanup[0].targets),
    {nodeId:'w1',host:'h',sourceRelativePath:'work/evil',isolationRelativePath:'clean/evil'}]}]};
  assert.throws(()=>ledger.mergeIsolatedBatches([frozen],[{batchId:'b-1',projectRoot:'/proj',frozenAt:'',plans:[expandTarget]}]),/TARGET_CONFLICT/);
  const changedHost=structuredClone(voided);changedHost.cleanup[0].targets[0].host='different';
  assert.throws(()=>L2(frozen,changedHost),/TARGET_CONFLICT/);
  const conflictingNew=structuredClone(voided);conflictingNew.cleanup[0].cleanupOperationId='new-token';
  conflictingNew.cleanup.push(structuredClone(conflictingNew.cleanup[0]));conflictingNew.cleanup[1].targets[0].isolationRelativePath='clean/other';
  assert.throws(()=>L2(frozen,conflictingNew),/TARGET_CONFLICT/);
  assert.equal(frozen.plans[0].cleanup[0].targets.length,1,'冲突不修改原集合');
  function L2(existing,incoming){return ledger.mergeIsolatedBatches([structuredClone(existing)],[{batchId:'b-1',projectRoot:'/proj',frozenAt:'',plans:[structuredClone(incoming)]}])[0];}
});
