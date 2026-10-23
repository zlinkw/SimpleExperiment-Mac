const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
require('../_helpers/registerTsRequire');
const selector=require('../../src/results/plan-run-intent-selector.ts');
const freshness=require('../../src/results/PlanRunFreshness.ts');
const {summarizePlanStatuses}=require('../../src/features/PanelPlanStatusSummary.ts');
const {PlanRunHost}=require('../../src/extension/PlanRunHost.ts');

const statusRow=(status,over={})=>({status,...over});
const scope=crypto.createHash('sha256').update('scope-fixture').digest('hex');
const base=selector.rerunWorkflowBaseId(scope);

test('empty queue opens the legacy-compatible base rerun instance',()=>{
 const decision=selector.selectRerunWorkflowInstance({plans:[]},scope);
 assert.equal(decision.workflowId,base);assert.equal(decision.activeRunId,'');assert.equal(decision.familyRunCount,0);
 // ordinal 0 与旧确定性 id 公式逐字节一致：同哈希盐序列化、同前缀，旧完成批次仍被识别为同范围族。
 const salt=JSON.stringify(['wf-1',[[0,'cmd-0']],false,'rev-1','fp-1']);
 const legacyId='distributed-plan-rerun-'+crypto.createHash('sha256').update(salt).digest('hex');
 assert.equal(selector.rerunWorkflowBaseId(crypto.createHash('sha256').update(salt).digest('hex')),legacyId);
 assert.equal(selector.selectRerunWorkflowInstance({plans:[{id:legacyId,jobs:[statusRow('completed')]}]},
  crypto.createHash('sha256').update(salt).digest('hex')).workflowId,legacyId+'-r1');
});

test('terminal family opens a fresh instance for each new human rerun',()=>{
 let queue={plans:[{id:base,jobs:[statusRow('completed'),statusRow('failed')]}]};
 const first=selector.selectRerunWorkflowInstance(queue,scope);
 assert.equal(first.workflowId,base+'-r1');assert.equal(first.activeRunId,'');assert.equal(first.familyRunCount,1);
 queue={plans:[...queue.plans,{id:first.workflowId,jobs:[statusRow('completed'),statusRow('cancelled')]}]};
 const second=selector.selectRerunWorkflowInstance(queue,scope);
 assert.equal(second.workflowId,base+'-r2');assert.equal(second.activeRunId,'');assert.equal(second.familyRunCount,2);
 // 旧批次历史保持完整：族内全部实例仍在队列中，不清空、不复用已终结 id。
 assert.equal(queue.plans.length,2);
});

test('unterminated family run keeps one stable blocking id across repeated resolutions',()=>{
 const queue={plans:[{id:base,jobs:[statusRow('completed')]},{id:base+'-r1',jobs:[statusRow('running'),statusRow('queued')]}]};
 for(let attempt=0;attempt<3;attempt+=1){
  const decision=selector.selectRerunWorkflowInstance(queue,scope);
  assert.equal(decision.activeRunId,base+'-r1','同意图的网络重试/崩溃恢复必须观察到同一未终结批次');
  assert.equal(decision.workflowId,base+'-r2','未终结时预解析的下一实例保持恒等，不双派');
 }
 for(const status of ['unknown','pending','']){
  const active={plans:[{id:base+'-r1',jobs:[statusRow(status)]}]};
  assert.equal(selector.selectRerunWorkflowInstance(active,scope).activeRunId,base+'-r1',status||'missing');
 }
 assert.equal(selector.selectRerunWorkflowInstance({plans:[{id:base+'-r1',jobs:[{}]}]},scope).activeRunId,base+'-r1','缺状态保守视为未终结');
 assert.equal(selector.selectRerunWorkflowInstance({plans:[{id:base,jobs:[]}]},scope).activeRunId,base,'空 job 列表无法证明终结，维持挡块');
});

test('real cleanup records join by job terminality while foreign ids never join',()=>{
  // 真实队列 cleanup 为对象记录（PlanCleanupHost）：清理卡照常计入族，是否挡新批只看族内 job 终态。
  const cleaning=selector.selectRerunWorkflowInstance({plans:[
   {id:base,cleanup:{operationId:'op-1',state:'pending',completedTargets:[],pendingNodes:['node']},jobs:[statusRow('completed')]},
  ]},scope);
  assert.equal(cleaning.familyRunCount,1,'对象形态清理卡计入族');
  assert.equal(cleaning.workflowId,base+'-r1','清理进行中不挡已终结批次的再次重跑');
  assert.equal(cleaning.activeRunId,'');
  const busy=selector.selectRerunWorkflowInstance({plans:[
   {id:base,cleanup:{operationId:'op-2',state:'pending',completedTargets:[],pendingNodes:['node']},jobs:[statusRow('queued')]},
  ]},scope);
  assert.equal(busy.activeRunId,base,'族内 job 未终结仍维持挡块');
  const foreign=selector.selectRerunWorkflowInstance({plans:[
   {id:'distributed-plan-'+scope,cleanup:{operationId:'op-3',state:'deleted',completedTargets:['x'],pendingNodes:[]},jobs:[statusRow('queued')]},
   {id:base+'-notes',jobs:[statusRow('completed')]},
   {id:base+'-r1x',jobs:[statusRow('running')]},
   {id:base+'-r01',jobs:[statusRow('completed')]},
  ]},scope);
  assert.equal(foreign.workflowId,base);assert.equal(foreign.activeRunId,'');assert.equal(foreign.familyRunCount,0);
});

function cohortFixtures(){
 const job=(planId,index,status)=>({index,case:'case'+index,seed:42,attempt:1,commandId:planId+'-cmd-'+index,globalJobId:planId+':'+index,
  workerId:'worker',outputDir:'work/job'+index,collectionResultCsv:'work/job'+index+'/metrics.csv',status});
 const old={id:'run-old',projectId:'project',planFile:'plans/a.yaml',revision:'revision',codeFingerprint:'fp-old',
  fullPlanJobCount:4,planJobCount:4,enqueuedAt:'2026-10-16T00:00:00Z',resultPathPolicy:'declared',
  jobs:[0,1,2,3].map(index=>job('run-old',index,'completed'))};
 const partial={id:'run-new',projectId:'project',planFile:'plans/a.yaml',revision:'revision',codeFingerprint:'fp-new',
  fullPlanJobCount:4,planJobCount:2,enqueuedAt:'2026-10-17T00:00:00Z',resultPathPolicy:'declared',
  jobs:[0,1].map(index=>job('run-new',index,'running'))};
 return{old,partial};
}
const summarize=(rows,distributed)=>summarizePlanStatuses({plans:rows,distributedPlans:distributed})[0];

test('partial rerun summary splits this-run progress from carried-forward completions',()=>{
 const {old,partial}=cohortFixtures();
 const s=summarize([{file:'plans/a.yaml',revision:'revision',jobCount:4}],[old,partial]);
 // 合并计数语义保持不变（回归钉），拆分只作附加数据通道。
 assert.equal(s.completedCount,2);assert.equal(s.totalCount,4);assert.equal(s.status,'running');
 assert.equal(s.currentRunId,'run-new');assert.equal(s.currentRunTotalCount,2);assert.equal(s.currentRunCompletedCount,0);
 assert.equal(s.carriedForwardCompletedCount,2);assert.deepEqual(s.carriedForwardSourceRunIds,['run-old']);
 // 补跑完成后：本次 2/2、沿用 2，旧完成既不算本次也不算重复。
 for(const job of partial.jobs)job.status='completed';
 const done=summarize([{file:'plans/a.yaml',revision:'revision',jobCount:4}],[old,partial]);
 assert.equal(done.completedCount,4);assert.equal(done.status,'completed');
 assert.equal(done.currentRunCompletedCount,2);assert.equal(done.carriedForwardCompletedCount,2);
 // 单一完整提交：全部计入本次，无沿用来源。
 const single=summarize([{file:'plans/a.yaml',revision:'revision',jobCount:4}],[old]);
 assert.equal(single.currentRunId,'run-old');assert.equal(single.currentRunTotalCount,4);assert.equal(single.currentRunCompletedCount,4);
 assert.equal(single.carriedForwardCompletedCount,0);assert.equal(single.carriedForwardSourceRunIds,undefined);
});

test('partial rerun never replaces the formal history endpoint and never becomes preview authority',()=>{
 const {old,partial}=cohortFixtures();
 const queue={plans:[old,partial]};
 const identity=freshness.selectLatestCompletePlanRunIdentity(queue,'plans/a.yaml','revision');
 assert.equal(identity.runId,'run-old','正式历史仍绑定旧完整卡');
 assert.equal(freshness.selectLatestPlanRunPreview(queue,'plans/a.yaml','revision'),undefined,'不完整的新卡只能 preview 排除，不得冒充正式端点');
});

test('hold retirement normalizes empty CSV and fails explicitly on real mismatches',()=>{
 const queue={plans:[{id:'p1',jobs:[
  {outputDir:'work_dirs/a',collectionResultCsv:undefined,status:'completed'},
  {outputDir:'work_dirs/b',collectionResultCsv:'results/b.csv',status:'completed'},
  {outputDir:'work_dirs\\c',collectionResultCsv:'r.csv',status:'completed'},
 ]}]};
 const before=JSON.stringify(queue);
 const matched=PlanRunHost.normalizeHoldTargets([{output_dir:'work_dirs/a',result_csv:''},
  {output_dir:'work_dirs/b',result_csv:'results/b.csv'},{output_dir:'work_dirs/c',result_csv:'r.csv'}],queue);
 assert.deepEqual(matched.missing,[]);
 for(const job of matched.queue.plans[0].jobs){assert.ok(job.outputRetiredAt);assert.equal(job.artifacts,undefined);assert.deepEqual(job.mirroredWorkerIds,[]);}
 assert.equal(JSON.stringify(queue),before,'归一化不改动调用方队列');
 const reverse=PlanRunHost.normalizeHoldTargets([{output_dir:'work_dirs/a'}],queue);
 assert.deepEqual(reverse.missing,[]);assert.ok(reverse.queue.plans[0].jobs[0].outputRetiredAt,'声明 undefined 与勾选 "" 等价');
 const bad=PlanRunHost.normalizeHoldTargets([{output_dir:'work_dirs/a',result_csv:'other.csv'},{output_dir:'work_dirs/ghost',result_csv:''}],queue);
 assert.equal(bad.missing.length,2,'真实不匹配必须显式列项');
 for(const job of bad.queue.plans[0].jobs)assert.equal(job.outputRetiredAt,undefined,'不匹配时不得静默漏标');
});

test('hold wiring routes through the normalizer and aborts the queue write on missing targets',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../../src/extension/PlanRunHost.ts'),'utf8');
 assert.match(source,/const next = PlanRunHost\.normalizeHoldTargets\(selected, queue, body\.planFile, canonicalProjectId\(this\.root\)\);/);
 assert.match(source,/if \(next\.missing\.length\) throw Error\("HOLD_TARGET_NOT_FOUND/);
 assert.ok(!/selected\.some\(row => row\.output_dir === job\.outputDir/.test(source),'旧的精确相等 hold 匹配必须移除');
});

// 真实故障（2026-10-21 15:26–15:35 批次）：上一批产物卡已被用户“终止并清除”（声明进入
// clearedJobs，磁盘产物仍在）。本轮覆盖重跑：预览→双确认→隔离全部完成后，hold 队列围栏发现
// 当前队列没有这些声明，整单以 HOLD_TARGET_NOT_FOUND 失败——用户产物已移走、任务却没提交。
// 免围栏只认 removeConfirmedDistributedPlan 写下的正式清除证明：同项目（canonical 规范身份）、
// 同 PLAN、resultPathPolicy "declared"、合法 clearedAt、无活跃回执、output+csv 精确一致。
// 任何其他缺失（含未知/不完整/他项目/非正式记录）仍显式失败且不写队列。
const {canonicalProjectId}=require('../../src/features/DistributedPlanQueue.ts');
const HOLD_PROJECT=canonicalProjectId('D:/GitRepo/MultiModal/simple_cluster');
test('hold skips retirement only for formal cleared records of the same project and plan',()=>{
 const cleared=out=>({projectId:HOLD_PROJECT,workflowId:'run-old',planFile:'plans/a.yaml',planRevision:'rev',codeFingerprint:'fp',
  experimentIndex:0,case:'case0',seed:42,resultPathPolicy:'declared',outputDir:out,collectionResultCsv:out+'/metrics.csv',
  status:'completed',clearedAt:'2026-10-20T18:41:26.440Z'});
 const queue={plans:[],clearedJobs:[cleared('work_dirs/a'),cleared('work_dirs/b')]};
 queue.clearedJobs[1].collectionResultCsv='';
 const beforeCleared=JSON.stringify(queue);
 const hit=PlanRunHost.normalizeHoldTargets([{output_dir:'work_dirs/a',result_csv:'work_dirs/a/metrics.csv'},
  {output_dir:'work_dirs/b',result_csv:''}],queue,'plans/a.yaml',HOLD_PROJECT);
 assert.deepEqual(hit.missing,[],'同项目同 PLAN 的正式清除记录不再要求围栏；隔离后必须允许提交');
 assert.deepEqual(hit.queue.plans,[],'跳过围栏不得伪造队列声明');
 assert.equal(JSON.stringify(queue),beforeCleared,'归一化不改动调用方队列');
 const want=[{output_dir:'work_dirs/a',result_csv:'work_dirs/a/metrics.csv'}];
 const probe=(clearedJobs,over={})=>PlanRunHost.normalizeHoldTargets(want,
  {plans:[],clearedJobs},over.planFile||'plans/a.yaml',over.projectId||HOLD_PROJECT).missing;
 assert.equal(probe([{...cleared('work_dirs/a'),planFile:'plans/other.yaml'}],{planFile:'plans/a.yaml'}).length,1,'cleared 记录必须绑定同一 PLAN 文件');
 assert.equal(probe([cleared('work_dirs/a')],{planFile:'other/a.yaml'}).length,1,'本次 PLAN 与记录 PLAN 不同同样不豁免');
 assert.equal(probe([{...cleared('work_dirs/a'),activeReceiptObservedAt:'2026-10-21T00:00:00Z'}]).length,1,'已有活跃回执的清除记录不能免除围栏');
 assert.equal(probe([{...cleared('work_dirs/a'),projectId:canonicalProjectId('D:/other/project')}]).length,1,'其他项目的同路径记录不得豁免');
 assert.equal(probe([{...cleared('work_dirs/a'),projectId:''}]).length,1,'缺 projectId 的不完整记录必须 fail closed');
 assert.equal(probe([{...cleared('work_dirs/a'),resultPathPolicy:undefined}]).length,1,'非 declared 的 attempt/历史清除记录不是正式声明清除证明');
 assert.equal(probe([{...cleared('work_dirs/a'),clearedAt:undefined}]).length,1,'缺 clearedAt 的记录不能证明用户确认清除');
 assert.equal(probe([{...cleared('work_dirs/a'),clearedAt:'not-a-date'}]).length,1,'非法 clearedAt 不能证明用户确认清除');
 const mismatch=PlanRunHost.normalizeHoldTargets([{output_dir:'work_dirs/a',result_csv:'other.csv'}],queue,'plans/a.yaml',HOLD_PROJECT);
 assert.equal(mismatch.missing.length,1,'同产物不同 CSV 仍是真实不匹配');
 assert.equal(PlanRunHost.normalizeHoldTargets(want,queue,undefined,HOLD_PROJECT).missing.length,1,'不传 PLAN 文件时保持严格失败语义');
 assert.equal(PlanRunHost.normalizeHoldTargets(want,queue,'plans/a.yaml',undefined).missing.length,1,'不传项目身份时保持严格失败语义');
 assert.equal(PlanRunHost.normalizeHoldTargets(want,{plans:[],clearedJobs:[]},'plans/a.yaml',HOLD_PROJECT).missing.length,1,'真实缺失仍显式失败');
});

test('legacy rerun intent and resume wiring are pinned in the submission path',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
 assert.match(source,/import { selectRerunWorkflowInstance } from "\.\.\/results\/plan-run-intent-selector";/);
 assert.match(source,/const rerunDecision = selectRerunWorkflowInstance\(await this\.loadDistributedQueue\(root\), rerunScopeKey\);/);
 assert.match(source,/if \(rerunDecision\.activeRunId\)/);
 assert.match(source,/已恢复原提交，未启动新批次；继续主动查询原任务。"\); return;/);
 assert.ok(!source.includes('该范围已创建重跑批次'),'永久重复挡块文案必须移除');
 assert.ok(!source.includes('原提交已在队列中'),'resume 不再把队列命中表述为旧文案');
});

// —— 独立验证反例固化（S1/S2）：跨组卡与无 projectId 旧卡不得污染本次拆分 ——
function s1s2Fixtures(){
 const job=(planId,index,status,over={})=>({index,case:'c'+index,seed:42,attempt:1,commandId:planId+'-cmd-'+index,
  workerId:'w',outputDir:'work/job'+index,collectionResultCsv:'work/job'+index+'/m.csv',status,...over});
 const fullCard=(id,at,over={})=>({id,projectId:'P',planFile:'plans/a.yaml',revision:'rv',codeFingerprint:'fp',
  fullPlanJobCount:4,planJobCount:4,enqueuedAt:at,resultPathPolicy:'declared',
  jobs:[0,1,2,3].map(i=>job(id,i,'completed',{updatedAt:at,finishedAt:at})),...over});
 const partialCard=(id,at,over={})=>({id,projectId:'P',planFile:'plans/a.yaml',revision:'rv',codeFingerprint:'fp2',
  fullPlanJobCount:4,planJobCount:2,enqueuedAt:at,resultPathPolicy:'declared',
  jobs:[0,1].map(i=>job(id,i,'queued',{attempt:undefined})),...over});
 return{fullCard,partialCard};
}
const s1s2Plan=[{file:'plans/a.yaml',revision:'rv',jobCount:4}];

test('S1 same-millisecond cross-group cards deterministically select the newer card',()=>{
 const {fullCard,partialCard}=s1s2Fixtures();
 const s=summarize(s1s2Plan,[fullCard('run-old','2026-10-17T00:00:00.000Z',{projectId:'P1'}),
  partialCard('run-new','2026-10-17T00:00:00.000Z',{projectId:'P2'})]);
 // 平局取数组后者（最新提交卡），拆分不依赖数组旧先者（append-only 队列新卡在末尾）。
 // 沿用只计未被本次覆盖项：旧卡 0/1 行被本次重跑覆盖剔除，沿用仅剩 index2/3 共 2。
 assert.equal(s.currentRunId,'run-new');
 assert.equal(s.currentRunTotalCount,2);assert.equal(s.currentRunCompletedCount,0);
 assert.equal(s.carriedForwardCompletedCount,2);assert.deepEqual(s.carriedForwardSourceRunIds,['run-old']);
});

test('S2 legacy card without projectId never impersonates the fresh run completion',()=>{
 const {fullCard,partialCard}=s1s2Fixtures();
 const legacy={...fullCard('run-legacy','2026-10-10T00:00:00.000Z'),projectId:undefined};
 const s=summarize(s1s2Plan,[legacy,partialCard('run-fresh','2026-10-18T00:00:00.000Z')]);
 // 旧完整卡与新 partial 卡分属不同 compose 组且行无 sourcePlanId 标注：
 // 本次字段必须由当前卡作业所有权推导（2 个 queued 可见），沿用只计未被覆盖的 index2/3。
 assert.equal(s.currentRunId,'run-fresh');
 assert.equal(s.currentRunTotalCount,2);assert.equal(s.currentRunCompletedCount,0);
 assert.equal(s.carriedForwardCompletedCount,2);assert.deepEqual(s.carriedForwardSourceRunIds,['run-legacy']);
});

test('carried count excludes only tasks covered by this rerun (index-2-only rerun carries 3)',()=>{
 const {fullCard}=s1s2Fixtures();
 const legacy={...fullCard('run-legacy','2026-10-10T00:00:00.000Z'),projectId:undefined};
 const single={id:'run-fresh',projectId:'P',planFile:'plans/a.yaml',revision:'rv',codeFingerprint:'fp2',
  fullPlanJobCount:4,planJobCount:1,enqueuedAt:'2026-10-18T00:00:00.000Z',resultPathPolicy:'declared',
  jobs:[{index:2,case:'c2',seed:42,commandId:'run-fresh-cmd-2',workerId:'w',
   outputDir:'work/job2',collectionResultCsv:'work/job2/m.csv',status:'queued'}]};
 const s=summarize(s1s2Plan,[legacy,single]);
 // 4 job 计划仅重跑 index2：本次 0/1，沿用必须为未覆盖的 0/1/3 共 3，不得把被覆盖的 index2 再计一次。
 assert.equal(s.currentRunId,'run-fresh');
 assert.equal(s.currentRunTotalCount,1);assert.equal(s.currentRunCompletedCount,0);
 assert.equal(s.carriedForwardCompletedCount,3);assert.deepEqual(s.carriedForwardSourceRunIds,['run-legacy']);
 assert.ok(s.currentRunTotalCount+s.carriedForwardCompletedCount<=s.totalCount,'本次+沿用不得超过计划总数');
});

test('late stale attempt from a legacy card never contaminates the current split',()=>{
 const {fullCard,partialCard}=s1s2Fixtures();
 const late=fullCard('run-legacy','2026-10-10T00:00:00.000Z',{projectId:undefined});
 late.jobs=late.jobs.map(job=>({...job,attempt:2,updatedAt:'2026-10-19T00:00:00.000Z',finishedAt:'2026-10-19T00:00:00.000Z'}));
 const s=summarize(s1s2Plan,[late,partialCard('run-fresh','2026-10-18T00:00:00.000Z')]);
 // 迟到的旧 attempt=2 完成不污染本次字段；沿用同样只计未被覆盖的 index2/3。
 assert.equal(s.currentRunId,'run-fresh');
 assert.equal(s.currentRunTotalCount,2);assert.equal(s.currentRunCompletedCount,0);
 assert.equal(s.carriedForwardCompletedCount,2);
});
