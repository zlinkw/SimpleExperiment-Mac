const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");
require('../_helpers/registerTsRequire');
const {composeLogicalPlans}=require('../../src/features/LogicalPlanProgress.ts');

const panel = readSource("src/ui/PanelHtml.ts").replace('${logicalPlansSource}', '('+composeLogicalPlans.toString()+')');

test('completed job and PLAN expose independent artifact refresh and delta retry while siblings run',()=>{
  const sandbox=clickSandbox();
  sandbox.render({distributedPlans:[{id:'wf',planFile:'plans/corim.yaml',jobs:[
    {index:0,case:'done',seed:43,status:'completed',completionState:'verified',lifecycleProtocol:2,workerId:'jqg_zlk',commandId:'done-command',artifactError:'FILE_INDEX_INVALIDATED_DURING_READ',latestArtifactSync:{state:'partial'}},
    {index:1,case:'live',seed:44,status:'running',lifecycleProtocol:2,workerId:'jqg_zlk',commandId:'running-command'},
  ]}]});
  assert.match(sandbox.html,/data-command="refreshJobArtifacts" data-plan-id="wf" data-job-index="0" data-command-id="done-command"/);
  assert.match(sandbox.html,/data-command="retryJobArtifactSync" data-plan-id="wf" data-job-index="0" data-command-id="done-command"/);
  assert.match(sandbox.html,/刷新 Plan 产物状态/);assert.match(sandbox.html,/重试 Plan 产物同步/);assert.match(sandbox.html,/无需重跑训练/);
  assert.doesNotMatch(sandbox.html,/data-command="retryJobArtifactSync"[^>]*running-command/);
});

test('supplemental mixed-source job fills the original six-job PLAN and preserves exact control identities',()=>{
  const make=(id,indices,time,version,count)=>({id,projectId:'project',revision:'same-plan',codeFingerprint:version,fullPlanJobCount:6,
    planJobCount:count,enqueuedAt:time,planFile:'plans/corim.yaml',jobs:indices.map(index=>({index,case:'case'+index,seed:42,
      outputDir:'work/job'+index,collectionResultCsv:'work/job'+index+'/metrics.csv',status:'completed',completionState:'verified',
      workerId:'worker',commandId:id+'cmd'+index,lifecycleProtocol:2,executionState:'exited',resultState:'complete'}))});
  const old=make('original',[0,1,2,3,4],'2026-10-16T00:00:00Z','old-source',6),newer=make('supplement',[5],'2026-10-17T00:00:00Z','new-source',1);
  const sandbox=clickSandbox();
  for(let i=0;i<3;i++){
    sandbox.render({distributedPlans:[structuredClone(newer),structuredClone(old)]});
    assert.match(sandbox.html,/成功 6\/6/);assert.match(sandbox.html,/补跑已合并/);assert.match(sandbox.html,/混合源码版本/);
    assert.match(sandbox.html,/originalcmd0/);assert.match(sandbox.html,/supplementcmd5/);
    assert.match(sandbox.html,/data-manual-dispatch="batch" data-plan-id="original"/);
    assert.match(sandbox.html,/data-manual-dispatch="batch" data-plan-id="supplement"/);
  }
  newer.jobs[0].status='unknown';newer.jobs[0].completionState='unverified';newer.jobs[0].executionState='missing';
  sandbox.render({distributedPlans:[old,newer]});assert.match(sandbox.html,/成功 5\/6/);assert.doesNotMatch(sandbox.html,/已完成 Plan 历史/);
});

test('five confirmed jobs plus one missing seed remain outside completed PLAN history through refreshes',()=>{
  const sandbox=clickSandbox(),jobs=Array.from({length:6},(_,index)=>({index,case:'corim_pad_p100',seed:42+index,
    status:index===5?'unknown':'completed',completionState:index===5?'unverified':'verified',lifecycleProtocol:2,
    executionState:index===5?'missing':'exited',resultState:index===5?'incomplete':'complete',
    commandId:'command'+index,workerId:'h20',outputDir:'work/job'+index}));
  const state={distributedPlans:[{id:'wf',planFile:'plans/corim.yaml',jobs}]};
  for(let i=0;i<3;i++){
    sandbox.render(structuredClone(state));
    assert.match(sandbox.html,/成功 5\/6/);
    assert.doesNotMatch(sandbox.html,/已完成 Plan 历史/);
    assert.match(sandbox.html,/executionPlanRow blocked/);
    assert.match(sandbox.html,/待核实/);
  }
  const done=structuredClone(state);Object.assign(done.distributedPlans[0].jobs[5],{status:'completed',completionState:'verified',resultState:'complete'});
  sandbox.render(done);assert.match(sandbox.html,/已完成 Plan 历史 1/);
  sandbox.render(state);assert.doesNotMatch(sandbox.html,/已完成 Plan 历史/);
});

test('complete PLAN cards exclude anomalies and unverified logs from clean success and retain concise evidence',()=>{
  for(const completionState of ['verified','review_required',undefined]){
    const sandbox=clickSandbox(),diagnostics={schemaVersion:1,commandId:'c',runId:'c',state:completionState==='review_required'?'anomalous':'clear',
      scanComplete:true,count:completionState==='review_required'?1:0,types:{AttributeError:1},phases:{train:1},
      exceptions:[{summary:'Traceback (most recent call last):\n  File private.py\nAttributeError: callback split',logPath:'simple_cluster/tmux_logs/c.log',lineStart:3,lineEnd:7}]};
    const state={distributedPlans:[{id:'wf',planFile:'plans/runtime.yaml',jobs:[{index:0,case:'a',seed:42,status:'completed',lifecycleProtocol:2,
      executionState:'exited',resultState:'complete',exitCode:0,workerId:'w',commandId:'c',completionState,runtimeDiagnostics:completionState?diagnostics:undefined}]}]};
    sandbox.render(state);
    if(completionState==='verified')assert.match(sandbox.html,/成功 1\/1/);
    else{assert.match(sandbox.html,/成功 0\/1/);assert.doesNotMatch(sandbox.html,/executionPlanRow completed/);assert.match(sandbox.html,/status-warning/);}
    if(completionState==='review_required'){
      assert.match(sandbox.html,/data-runtime-anomaly-rerun="true"/);assert.match(sandbox.html,/覆盖产物并重跑此 job/);
      assert.match(sandbox.html,/完成但有异常，待复核/);assert.match(sandbox.html,/退出码 0/);assert.match(sandbox.html,/异常 1 次 · AttributeError · 阶段 train/);
      assert.match(sandbox.html,/AttributeError: callback split/);assert.match(sandbox.html,/行 3–7/);assert.doesNotMatch(sandbox.html,/Traceback|private.py/);
      const prior=sandbox.executionRenderKeysForState(state).planList;
      const changed=structuredClone(state);changed.distributedPlans[0].jobs[0].runtimeDiagnostics.count=2;
      assert.notEqual(sandbox.executionRenderKeysForState(changed).planList,prior);
    }
    else assert.doesNotMatch(sandbox.html,/data-runtime-anomaly-rerun="true"/);
    if(!completionState)assert.match(sandbox.html,/运行日志待核实/);
  }
});

test('runtime log errors render a failed job and Plan while retaining artifact evidence and manual review actions', () => {
  const sandbox=clickSandbox();
  sandbox.render({distributedPlans:[{id:'wf',projectId:'p',planFile:'plans/errors.yaml',jobs:[{
    index:0,case:'a',seed:42,status:'failed',lifecycleProtocol:2,completionState:'review_required',
    executionState:'exited',resultState:'complete',exitCode:0,workerId:'w',commandId:'c',outputDir:'work/job',
    runtimeDiagnostics:{schemaVersion:1,commandId:'c',runId:'c',state:'anomalous',count:1,scanComplete:true,
      types:{LoggedError:1},phases:{test:1},exceptions:[{summary:'Error. nthreads cannot be larger than NUMEXPR_MAX_THREADS (64)',logPath:'raw.log',lineStart:7,lineEnd:7}]}
  }]}]});
  assert.match(sandbox.html,/executionPlanRow failed/);assert.match(sandbox.html,/成功 0\/1/);assert.match(sandbox.html,/失败 1/);
  assert.match(sandbox.html,/退出码 0/);assert.match(sandbox.html,/产物：完整/);assert.match(sandbox.html,/nthreads cannot be larger/);
  assert.match(sandbox.html,/data-command="analyzeRuntimeLog"/);
  assert.match(sandbox.html,/data-runtime-anomaly-rerun="true"/);
});

test('native cards display readable execution and result states independently', () => {
  for(const [executionState,resultState,status,executionLabel,resultLabel] of [
    ['failed','complete','failed','失败','完整'],['exited','incomplete','unknown','已结束','不完整'],
    ['running','unverified','running','运行中','待核实'],['missing','complete','completed','窗口不存在','完整']]) {
    const sandbox=clickSandbox();
    sandbox.render({distributedPlans:[{id:'wf',planFile:'plans/states.yaml',jobs:[{index:0,case:'a',seed:42,status,
      lifecycleProtocol:2,executionState,resultState,workerId:'w',commandId:'c',outputDir:'work/job'}]}]});
    assert.match(sandbox.html,new RegExp('执行：'+executionLabel));assert.match(sandbox.html,new RegExp('产物：'+resultLabel));
    assert.doesNotMatch(sandbox.html,/执行：(?:failed|exited|running|missing)|产物：(?:complete|incomplete|unverified)/);
  }
});
test('production panel projection preserves independent states and redraws result-only changes', () => {
  const source=readSource('src/extension/legacy.ts');
  // 0.5.416 配套：投影块开头新增能力门判定（if+const stageBlockReleaseCapable），
  // 切片起点必须取真实语句边界（if 行），否则 map 内引用的裸 const 在 VM 里未定义。
  const start=source.indexOf('if (visibleDistributedPlanProgress.some(plan =>');
  const end=source.indexOf('const summaryInputs =',start);
  assert.ok(start>0&&end>start);
  const rows=[{id:'wf',planFile:'plans/states.yaml',jobs:[{index:0,case:'a',seed:42,status:'failed',lifecycleProtocol:2,
    executionState:'failed',resultState:'complete',statusQueryError:undefined,workerId:'w',commandId:'c',outputDir:'work/job'}]}];
  const plans=vm.runInNewContext(source.slice(start,end)+'distributedPlans;',{visibleDistributedPlanProgress:rows,
    DistributedPlanQueue:{jobIsUnavailable:()=>false}});
  assert.equal(plans[0].jobs[0].lifecycleProtocol,2);assert.equal(plans[0].jobs[0].executionState,'failed');
  assert.equal(plans[0].jobs[0].resultState,'complete');
  const sandbox=clickSandbox(),state={distributedPlans:plans};sandbox.render(state);
  assert.match(sandbox.html,/执行：失败/);assert.match(sandbox.html,/产物：完整/);
  const changed=structuredClone(state);changed.distributedPlans[0].jobs[0].resultState='incomplete';
  assert.notEqual(sandbox.executionRenderKeysForState(state).planList,sandbox.executionRenderKeysForState(changed).planList);
});
test('real panel projection and rendered PLAN/job labels share the current synchronization confirmation',()=>{
 const feature=require('../../dist/features/PlanArtifactSyncStatus.js'),{latestJobSyncKey}=require('../../dist/features/LatestJobArtifacts.js');
 const {completionIdentity}=require('../../dist/features/VerifiedCompletion.js');
 const root='d:/project',targets=['a','b','c','d'].map(id=>({id,host:id,port:22,user:'u',remotePath:'/project'}));
 const plan={id:'wf',projectId:root,planFile:'plans/sync.yaml',revision:'r',planJobCount:1,fullPlanJobCount:1,executionMode:'test',resultPathPolicy:'declared',jobs:[]};
 const job={index:0,case:'a',seed:42,status:'completed',completionState:'verified',lifecycleProtocol:2,executionState:'exited',resultState:'complete',exitCode:0,
  workerId:'a',commandId:'command',globalJobId:'wf:0',outputDir:'work/job',collectionResultCsv:'work/job/metrics.csv'};
 plan.jobs=[job];job.verifiedCompletion={schemaVersion:1,exitCode:0,verifiedAt:'2026-10-15T00:00:00Z',identity:completionIdentity(plan,job)};
 job.latestArtifactSync={state:'synced',scopes:[job.outputDir],workerIds:targets.map(t=>t.id),checkedAt:'2026-10-15T01:00:00Z',key:latestJobSyncKey(plan,job,[job.outputDir],targets)};
 // 0.5.416 配套：同上一用例，切片起点取投影块真实语句边界（if 行），保证块内裸 const 有定义。
 const source=readSource('src/extension/legacy.ts'),start=source.indexOf('if (visibleDistributedPlanProgress.some(plan =>'),end=source.indexOf('const summaryInputs =',start);
 for(const changed of [false,true]){
  const configured=structuredClone(targets);if(changed)configured[0].host='replacement-server';
  const projected=vm.runInNewContext(source.slice(start,end)+'distributedPlans;',{
   visibleDistributedPlanProgress:[plan],DistributedPlanQueue:{jobIsUnavailable:()=>false},PlanArtifactSyncStatus:feature,
   workerCodeSyncTargets:()=>configured,workspaceRoot:()=>root,normalizeMirrorScopePaths:x=>x,
   vscode:{workspace:{getConfiguration:()=>({get:()=>['.']})},Uri:{file:x=>x}}});
  const sync=feature.confirmedPlanArtifactSync(plan,configured,['.']),sandbox=clickSandbox();
  sandbox.render({distributedPlans:projected,planArtifactSyncStatuses:sync?{wf:sync}:{}});
  if(!changed){assert.match(sandbox.html,/已全局同步最新产物/);assert.match(sandbox.html,/4\/4 Worker/);assert.match(sandbox.html,/已同步到全部启用服务器/);assert.doesNotMatch(sandbox.html,/正在核验全局同步|全局同步待核验/);}
  else{assert.doesNotMatch(sandbox.html,/已同步到全部启用服务器|已全局同步最新产物/);assert.match(sandbox.html,/未完成，可刷新重试/);}
 }
});

test('failed jobs show a short error and a window-log button instead of embedding the terminal', () => {
  const sandbox = clickSandbox();
  const error = 'FULL_COMMAND_AND_CONFIG_DO_NOT_RENDER '.repeat(200) + '\nTraceback (most recent call last):\n  File "private.py", line 8\nModuleNotFoundError: No module named torch\nPane is dead (status 1)';
  sandbox.render({ distributedPlans: [{ id:'wf',planFile:'plans/failure.yaml',jobs:[{index:0,case:'a',seed:42,status:'failed',
    workerId:'w',commandId:'c',outputDir:'work/job',error}] }] });
  assert.match(sandbox.html, /ModuleNotFoundError/);
  assert.match(sandbox.html, /查看窗口日志/);
  assert.match(sandbox.html, /data-job-tmux-log="1"[^>]*data-command-id="c"/);
  assert.doesNotMatch(sandbox.html, /FULL_COMMAND_AND_CONFIG_DO_NOT_RENDER|Traceback|private.py/);
});

test('a starting task window stays in the queue and does not add a running job', () => {
  const sandbox = clickSandbox();
  sandbox.render({ distributedPlans: [{ id:'wf',planFile:'plans/starting.yaml',jobs:[{index:0,case:'a',seed:42,status:'queued',
    lifecycleProtocol:2,executionState:'starting',workerId:'w',commandId:'c',outputDir:'work/job'}] }] });
  assert.match(sandbox.html, /正在启动命令/);
  assert.doesNotMatch(sandbox.html, />运行中<| · 运行 1/);
});

test('missing native windows and startup failures offer exact one-job rerun, but query failures do not',()=>{
 for(const [status,executionState,query,expected] of [['unknown','missing',undefined,true],['failed','failed',undefined,true],['unknown','unknown','offline',false]]){
  const sandbox=clickSandbox();sandbox.render({distributedPlans:[{id:'wf',planFile:'plans/p.yaml',jobs:[{index:2,case:'a',seed:42,
   status,executionState,statusQueryError:query,lifecycleProtocol:2,workerId:'w',commandId:'exact',outputDir:'work/a'}]}]});
  assert.equal(/data-distributed-retry="wf"[^>]*data-command-id="exact"[^>]*>重跑此 job/.test(sandbox.html),expected);
 }
});

test('rendered rerun buttons carry the original command through the shared payload into the real Host guard',async()=>{
  require('../_helpers/registerTsRequire');
  const ts=require('typescript'),fs=require('node:fs');
  const html=require('../../src/ui/PanelHtml.ts').renderPanelHtml();
  const script=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
  const ast=ts.createSourceFile('panel.js',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let payloadSource;
  function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='payloadFromButton')payloadSource=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);
  assert.ok(payloadSource);
  const payloadContext=vm.createContext({RESTORABLE_PLAN_FILE_PAYLOAD_COMMANDS:new Set(),ARTIFACT_SCOPE_COMMANDS:new Set()});
  vm.runInContext(payloadSource,payloadContext);
  const hostText=fs.readFileSync('src/extension/legacy.ts','utf8'),hostAst=ts.createSourceFile('host.ts',hostText,ts.ScriptTarget.Latest,true);
  let hostSource;
  function findHost(n){if(ts.isMethodDeclaration(n)&&n.name.getText(hostAst)==='retryDistributedJobFromUi')hostSource=n.getText(hostAst);ts.forEachChild(n,findHost);}findHost(hostAst);
  const retry=vm.runInNewContext(ts.transpileModule('class Host{'+hostSource+'};Host.prototype.retryDistributedJobFromUi',
    {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{workspaceRoot:()=>'/fixture'});
  for(const kind of ['missing','failed','anomaly','legacy']){
    const job={index:2,case:'a',seed:42,workerId:'w',commandId:'original-'+kind,outputDir:'work/a',
      lifecycleProtocol:kind==='legacy'?1:2,status:kind==='missing'?'unknown':kind==='anomaly'?'completed':'failed',
      executionState:kind==='missing'?'missing':'exited',completionState:kind==='anomaly'?'review_required':undefined,
      error:kind==='legacy'?'Validation-only tuning cannot access test patients':undefined};
    const plan={id:'wf',planFile:'plans/p.yaml',resultPathPolicy:'declared',jobs:[job]},sandbox=clickSandbox();
    sandbox.render({distributedPlans:[plan]});
    const button=sandbox.html.match(/<button\b[^>]*data-command="retryDistributedJob"[^>]*>/)?.[0];assert.ok(button,kind);
    const dataset={};for(const m of button.matchAll(/data-([a-z-]+)="([^"]*)"/g))dataset[m[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=m[2];
    const payload=payloadContext.payloadFromButton({dataset});
    assert.equal(payload.commandId,job.commandId,kind+' must not lose the rendered command identity');
    assert.equal(payload.planId,'wf');assert.equal(payload.jobIndex,2);
    assert.equal(payload.runtimeAnomalyRerun===true,kind==='anomaly');
    if(kind==='legacy')continue;
    let calls=0;
    const h={captureProjectContext:()=>({}),projectContextIsCurrent:()=>true,workerActionTargets:()=>[{id:'w',host:'fixture'}],
      client:{},loadDistributedQueue:async()=>({plans:[plan]}),retryPulledJob:async(p,j,_r,current,anomalyOnly)=>{
        calls++;assert.equal(p,plan);assert.equal(j,job);assert.ok(current());assert.equal(anomalyOnly,kind==='anomaly');}};
    await retry.call(h,payload);assert.equal(calls,1);
    job.commandId='superseding-command';
    await assert.rejects(retry.call(h,payload),/commandId.*变化/);assert.equal(calls,1,'a truly replaced command must remain protected');
  }
});

test('a six-job declaration with five available inputs cannot render five-of-five success or hide the missing input',()=>{
  const sandbox=clickSandbox();
  const jobs=Array.from({length:5},(_,index)=>({index,case:'a',seed:42+index,status:'completed',completionState:'verified'}));
  sandbox.render({distributedPlans:[{id:'six',planFile:'plans/six.yaml',planJobCount:6,jobs}]});
  assert.match(sandbox.html,/当前 job · 成功 5\/6/);
  assert.match(sandbox.html,/缺少 1 个 job 的任务输入/);
  assert.match(sandbox.html,/data-execution-plan-check="plans\/six.yaml"/);
  assert.doesNotMatch(sandbox.html,/当前 job · 成功 5\/5/);
});

function extract(startName, endName) {
  const start = panel.indexOf(`function ${startName}(`);
  const end = panel.indexOf(`function ${endName}(`, start + 1);
  assert.ok(start >= 0 && end > start);
  return panel.slice(start, end).replaceAll("\\\\", "\\");
}

function executionPlanSource() {
  // Mac 适配：面板源码顶层声明平台常量 MAC_PLAN_IDENTITY（生产值 true），取片段执行时需一并给出。
  const macIdentityDeclaration = "var MAC_PLAN_IDENTITY = true;" + String.fromCharCode(10);
  const helpers = panel.indexOf("function renderPlanTaskCards(");
  const end = panel.indexOf("function renderOperationSectionIfChanged(", helpers);
  assert.ok(helpers > 0 && end > helpers);
  const asArray = panel.slice(panel.indexOf("function asArray(")).split("\n")[0];
  return macIdentityDeclaration + asArray + "\nconst manualJobSelections = new Map();\n" + panel.slice(helpers, end).replaceAll("\\\\", "\\");
}

test('Plan cards expose checkboxes directly and distributed-only state enables all-Plan cleanup',()=>{
 const sandbox=clickSandbox({selectedExecutionPlanFiles:new Set(),executionPlanFiles:[]});
 const state={distributedPlans:[{id:'a',planFile:'plans/a.yaml',jobs:[{index:0,status:'pending',case:'a',seed:1}]},{id:'b',planFile:'plans/b.yaml',jobs:[{index:0,status:'unknown',case:'b',seed:1}]}]};
 sandbox.render(state);assert.match(sandbox.html,/type="checkbox"[^>]*data-execution-plan-check="plans\/a.yaml"/);assert.match(sandbox.html,/data-execution-plan-check="plans\/b.yaml"/);assert.doesNotMatch(sandbox.html,/executionPlanSelect|>选中 Plan</);
 sandbox.operationViewModelForState=()=>({rows:[],visibleRows:[],statusCounts:{}});sandbox.renderFileTransferProgress=()=>'';sandbox.setHtmlIfChanged=(id,html)=>{sandbox[id]=html;};
 sandbox.renderOperationSection(state);const all=sandbox.executionControls.match(/<button[^>]*data-command="stopAndClearPlans"[^>]*data-execution-plan-batch="all"[^>]*>/)[0];assert.doesNotMatch(all,/disabled/);
 const stop=sandbox.executionControls.match(/<button[^>]*data-command="stopAllPlans"[^>]*>/)[0];assert.doesNotMatch(stop,/disabled/);
 const start=panel.indexOf('const planBox = event.target.closest'),end=panel.indexOf('if (event.target?.id === "resultSplitTable")',start);
 vm.runInContext('this.changePlan = function(event){'+panel.slice(start,end)+'};',sandbox);
 sandbox.lastState=state;sandbox.renderOperationSectionIfChanged=()=>sandbox.renderOperationSection(state);
 sandbox.changePlan({target:{closest(){return this;},hasAttribute:()=>true,checked:true,dataset:{}}});assert.equal(sandbox.selectedExecutionPlanFiles.size,2);assert.match(sandbox.executionControls,/中止并清理勾选 Plan \(2\)/);
 sandbox.changePlan({target:{closest(){return this;},hasAttribute:()=>false,checked:false,dataset:{executionPlanCheck:'plans/a.yaml'}}});assert.deepEqual([...sandbox.selectedExecutionPlanFiles],['plans/b.yaml']);assert.equal(sandbox.selectedExecutionPlanFile,'plans/b.yaml');
});

test("failed formal job recall is scoped to the exact command and redraws cleanup progress", () => {
  const sandbox = clickSandbox();
  const state = { distributedPlans: [{ id: "failed-run", planFile: "plans/cpsc.yaml", failedAttemptRecoveries: [],
    jobs: ["failed", "running", "completed"].map((status, index) => ({ index, case: "case" + index, seed: 42,
      status, workerId: "worker-a", commandId: "command-" + index, attempt: 0, resultPathPolicy:"declared", globalJobId:"failed-run:"+index, outputDir: "work_dirs/a/job-"+index })) }] };
  sandbox.render(state);
  assert.equal((sandbox.html.match(/data-command="recallFailedJob"/g) || []).length, 1);
  assert.match(sandbox.html, /data-command="recallFailedJob"[^>]*data-plan-id="failed-run"[^>]*data-job-index="0"[^>]*data-command-id="command-0"/);
  const oldKey = sandbox.executionRenderKeysForState(state).planList;
  const updated = structuredClone(state);
  updated.distributedPlans[0].failedAttemptRecoveries = [{ jobIndex: 0, attempt: 1, status: "pending" }];
  updated.distributedPlans[0].jobs[0].attempt = 2;
  updated.distributedPlans[0].jobs[0].status = "pending";
  assert.notEqual(sandbox.executionRenderKeysForState(updated).planList, oldKey);
  sandbox.render(updated); assert.match(sandbox.html, /历史遗留清理记录需人工审核，不会自动移动或删除/);
  const final = structuredClone(updated);
  final.distributedPlans[0].failedAttemptRecoveries[0].status = "completed";
  sandbox.render(final); assert.match(sandbox.html, /历史回执：失败目录已移入原 Worker 的 clean_dir/);
  const absent = structuredClone(final);
  absent.distributedPlans[0].failedAttemptRecoveries[0].alreadyAbsent = true;
  sandbox.render(absent); assert.match(sandbox.html, /历史失败目录已核验不存在/);
});

test("formal preflight rejection explains that training never started and disables nonexistent TMUX logs", () => {
  const sandbox = clickSandbox();
  const state = { distributedPlans: [{ id: "formal-run", planFile: "plans/formal.yaml", jobs: [{ index: 0,
    case: "formal", seed: 42, status: "failed", workerId: "worker-a", commandId: "rejected-command", attempt: 0,
    outputDir: "work_dirs/formal", error: "FORMAL_JOB_CONFLICT: work_dirs/formal",
    admissionRejection: { code: "FORMAL_JOB_CONFLICT", message: "conflict", rejectedAt: "2026-10-12T00:00:00Z" } }] }] };
  sandbox.render(state);
  assert.match(sandbox.html, /启动前预检已拒绝此 job，训练未开始，不会自动重派/);
  assert.match(sandbox.html, /worker-a · 未启动/);
  assert.match(sandbox.html, /data-job-tmux-log="1"[^>]* disabled/);
  assert.doesNotMatch(sandbox.html, /这是已提交 job 的失败|data-command="recallFailedJob"/);
  const updated = structuredClone(state);
  updated.distributedPlans[0].jobs[0].admissionRejection.code = "FORMAL_JOB_DECLARATION_CHANGED";
  assert.notEqual(sandbox.executionRenderKeysForState(updated).planList, sandbox.executionRenderKeysForState(state).planList);
});

// r82（0.5.414）：隔离暂停 job 的如实呈现三面（blockText / statusLabel / 组级提示）。
// r86 裁定：不留"启动器冲突"面板分支——jobNext 唯一消费点被 errorText∧(预检∨代码校验) 门死，该文案在真实渲染面永不可达；
// 现场启动器失败走既有错误行契约（错误摘要+查看窗口日志+"重新排队此 job"按钮），以 doesNotMatch 钉死死文案不复现。
// r87 机械修：三面各拆独立 test（断言文本逐字照搬、不增不减），首个断言失败不再短路其余两面。
const isolationPausedState = () => ({ distributedPlans: [{ id: "isolation-pause", planFile: "plans/iso.yaml", jobs: [{ index: 0, case: "iso", seed: 43, status: "pending", outputDir: "work_dirs/iso",
  blockReason: "旧产物隔离未完成：隔离预览确认已过期（PREVIEW_EXPIRED），训练未启动；请重新生成预览并重新核对精确路径后再确认，未复用旧令牌。",
  outputIsolationBlocked: { reason: "隔离预览确认已过期", stage: "preview", code: "PREVIEW_EXPIRED", declarationKey: "work_dirs/iso", observedAt: "2026-10-26T05:00:00Z" } }] }] });

test('transfer-isolation recovery renders a usable action for unstarted jobs and preserves completed siblings',()=>{
 const sandbox=clickSandbox(),state=isolationPausedState(),p=state.distributedPlans[0];
 p.jobs[0].outputIsolationBlocked.recovery={state:'review_required'};
 p.jobs.push({index:1,case:'pad',seed:43,status:'completed',completionState:'verified',commandId:'done',workerId:'w'});
 sandbox.render(state);assert.match(sandbox.html,/成功 1\/2/);assert.match(sandbox.html,/旧产物待审核/);
 assert.match(sandbox.html,/data-command="recheckOutputIsolation"[^>]*data-job-index="0"[^>]*>审核旧产物/);
 assert.doesNotMatch(sandbox.html,/data-command="recheckOutputIsolation"[^>]*data-job-index="1"/);
 assert.doesNotMatch(sandbox.html,/排队 1/);assert.doesNotMatch(sandbox.html,/本机等待空卡/);
 const changed=structuredClone(state);changed.distributedPlans[0].jobs[0].outputIsolationBlocked.recovery.state='waiting_transfer';
 assert.notEqual(sandbox.executionRenderKeysForState(state).planList,sandbox.executionRenderKeysForState(changed).planList);
 const source=readSource('src/extension/legacy.ts'),start=source.indexOf('if (visibleDistributedPlanProgress.some(plan =>'),end=source.indexOf('const summaryInputs =',start);
 const projected=vm.runInNewContext(source.slice(start,end)+'distributedPlans;',{visibleDistributedPlanProgress:state.distributedPlans,DistributedPlanQueue:{jobIsUnavailable:()=>false}});
 assert.equal(projected[0].jobs[0].outputIsolationBlocked.recovery.state,'review_required');
 sandbox.render({distributedPlans:projected});assert.match(sandbox.html,/data-command="recheckOutputIsolation"/);
});
test("r82: an isolation-blocked job renders its never-started explanation through blockText", () => {
  const sandbox = clickSandbox();
  sandbox.render(isolationPausedState());
  assert.match(sandbox.html, /旧产物隔离未完成：隔离预览确认已过期（PREVIEW_EXPIRED），训练未启动/);
  assert.doesNotMatch(sandbox.html, /启动器因旧产物冲突退出/);
});
test("r82: an isolation-blocked job renders the isolation-paused status label", () => {
  const sandbox = clickSandbox();
  sandbox.render(isolationPausedState());
  assert.match(sandbox.html, /隔离暂停，未启动/);
});
test("r82: an isolation-blocked job renders the group-level never-dispatched hint", () => {
  const sandbox = clickSandbox();
  sandbox.render(isolationPausedState());
  assert.match(sandbox.html, /1 个 job 旧产物隔离未完成：训练未启动、不会自动派发，也不计入沿用完成/);
});

test("completed Plan history keeps explicit expansion across status refreshes, count changes and recreation", () => {
  const sandbox = clickSandbox({ detailsOpenState: {}, persistTransientPanelState: () => {} });
  vm.runInContext(extract("detailsOpenAttr", "scheduleStatusInfoPopoverClose"), sandbox);
  const toggleStart = panel.indexOf('const keyed = event.target.closest && event.target.closest("details[data-details-key]")');
  const toggleEnd = panel.indexOf('const historyDetails =', toggleStart);
  vm.runInContext('this.toggleHistory = function(event) {' + panel.slice(toggleStart, toggleEnd) + '};', sandbox);
  const plan = { id: "completed-run", planFile: "plans/done.yaml", enqueuedAt: "2026-10-09T08:00:00Z",
    jobs: [{ index: 0, case: "done", seed: 42, status: "completed", completionState: "verified", workerId: "worker-a", commandId: "done-command" }] };
  const render = (extra = []) => sandbox.render({ distributedPlans: [plan, ...extra] });
  const history = /<details class="executionPlanHistory" data-details-key="execution-plan-history"([^>]*)>/;
  render();
  assert.ok(history.test(sandbox.html), "history participates in persisted detail state");
  assert.doesNotMatch(sandbox.html.match(history)[1], /open/);
  const element = { open: true, dataset: { detailsKey: "execution-plan-history" }, closest() { return this; } };
  sandbox.toggleHistory({ target: element });
  plan.jobs[0].finishedAt = "2026-10-09T09:00:00Z";
  render(); assert.match(sandbox.html.match(history)[1], /open/);
  render([{ ...plan, id: "second-run", planFile: "plans/second.yaml" }]);
  assert.match(sandbox.html.match(history)[1], /open/);
  sandbox.render({ distributedPlans: [] });
  render(); assert.match(sandbox.html.match(history)[1], /open/);
  element.open = false; sandbox.toggleHistory({ target: element });
  render(); assert.doesNotMatch(sandbox.html.match(history)[1], /open/);
  const restored = clickSandbox({ detailsOpenState: { "execution-plan-history": true } });
  vm.runInContext(extract("detailsOpenAttr", "scheduleStatusInfoPopoverClose"), restored);
  restored.render({ distributedPlans: [plan] });
  assert.match(restored.html.match(history)[1], /open/, "webview restoration retains the explicit expansion");
});

test("automatic retry shows waiting, queue, exhaustion and success without losing the original failure", () => {
  const sandbox = clickSandbox();
  const job = { index: 1, case: "bus", seed: 44, status: "failed", workerId: "nwpu5", commandId: "failed-job",
    error: "CUDA failed", automaticRetry: { failureCount: 1, failedAttempt: 1, retryAt: "2026-10-08T08:01:00Z" } };
  const state = { distributedPlans: [{ id: "current", planFile: "plans/current.yaml", enqueuedAt: "2026-10-08T08:00:00Z", jobs: [job] }] };
  sandbox.render(state);
  assert.match(sandbox.html, /等待自动重试/);
  assert.match(sandbox.html, /连续失败 1\/5/);
  assert.match(sandbox.html, /CUDA failed/);
  assert.doesNotMatch(sandbox.html, /确认需要停止后/);
  job.status = "pending"; delete job.automaticRetry.retryAt; delete job.error;
  sandbox.render(state); assert.match(sandbox.html, /自动重试排队/);
  job.status = "failed"; job.automaticRetry.failureCount = 5; job.automaticRetry.exhausted = true;
  sandbox.render(state); assert.match(sandbox.html, /连续失败 5\/5，自动重试已停止/);
  job.status = "completed";
  sandbox.render(state); assert.doesNotMatch(sandbox.html, /连续失败/);
});

test("queued code-proof rejection describes a blocked start rather than a failed training job", () => {
  const sandbox=clickSandbox();
  const job={index:2,case:"bus",seed:44,status:"queued",workerId:"nwpu2",gpuId:"0",commandId:"pending-command",
    error:"code-sync proof identity mismatch or stale runtime generation"};
  sandbox.render({distributedPlans:[{id:"run",planFile:"plans/current.yaml",jobs:[job]}]});
  assert.match(sandbox.html,/启动前代码校验阻塞/);
  assert.match(sandbox.html,/部署并重启该 Worker 的 Agent/);
  assert.doesNotMatch(sandbox.html,/这是已提交 job 的失败/);
});

test("retry scheduling and exhaustion redraw the Plan even when the failed status and error stay the same", () => {
  const sandbox = clickSandbox();
  const state = { distributedPlans: [{ id: "run", planFile: "plans/current.yaml", jobs: [{ index: 0, status: "failed", error: "CUDA" }] }] };
  const before = sandbox.executionRenderKeysForState(state).planList;
  const waiting = JSON.parse(JSON.stringify(state));
  waiting.distributedPlans[0].jobs[0].automaticRetry = { failureCount: 1, retryAt: "2026-10-08T08:01:00Z" };
  const scheduled = sandbox.executionRenderKeysForState(waiting).planList;
  assert.notEqual(scheduled, before);
  const exhausted = JSON.parse(JSON.stringify(waiting));
  exhausted.distributedPlans[0].jobs[0].automaticRetry = { failureCount: 5, exhausted: true };
  assert.notEqual(sandbox.executionRenderKeysForState(exhausted).planList, scheduled);
});

test("Plan overview keeps completed and failed Plans visible without routine validation rows", () => {
  let html = "";
  const sandbox = {
    Map,
    Set,
    operationRowsForState: () => [
      { planFile: "plans/done.yaml", status: "completed", completionState: "verified", updatedAt: "2026-09-20T10:00:00Z" },
      { planFile: "plans/old-fail.yaml", status: "failed", finishedAt: "2026-09-20T11:00:00Z" },
      { planFile: "plans/new-fail.yaml", status: "failed", finishedAt: "2026-09-25T12:10:00Z" },
      { planFile: "plans/live.yaml", status: "running", updatedAt: "2026-09-20T09:00:00Z" },
      { planFile: "plans/live.yaml", type: "validate-plan", status: "completed", completionState: "verified", updatedAt: "2026-09-20T08:00:00Z" },
    ],
    taskSectionViewModelForState: () => ({ allRows: [
      { planFile: "plans/done.yaml", status: "completed", completionState: "verified" },
      { planFile: "plans/live.yaml", status: "running" },
    ] }),
    taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}),
    normalizePlanSelectionKey: String,
    samePlanSelection: (left, right) => left === right,
    selectedExecutionPlanFile: "plans/live.yaml",
    collapsedExecutionPlanKeys: new Set(),
    persistWebviewState: () => undefined,
    taskStatusToken: String,
    TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]),
    TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: (value) => value === "running",
    operationIsFailureLike: (value) => value === "failed",
    operationHasDeadEvidence: () => false,
    taskFailureLikeStatus: (value) => value === "failed",
    planBaseName: (value) => value.split("/").pop(),
    esc: String,
    escAttr: String,
    loadingPrefix: () => "",
    detailsOpenAttr: () => "",
    statusClass: String,
    renderOperationItem: (row) => "<div>" + (row.type || "operation") + "</div>",
    renderTaskCards: () => "<div>tasks</div>",
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(executionPlanSource() + "\nthis.render = renderExecutionPlanList;", sandbox);
  sandbox.render({ sessionStartedAt: "2026-09-25T12:00:00Z" });
  assert.match(html, /old-fail.yaml/);
  assert.match(html, /new-fail.yaml/);
  assert.doesNotMatch(html, /历史 Plan|validate-plan/);
  assert.match(html, /详情与日志/);
  assert.match(html, /data-command="clearOperations" data-plan-file="plans\/live.yaml"/);
  assert.match(html, /data-execution-plan-check="plans\/live.yaml"[^>]*checked/);
});

test("persisted distributed jobs keep their Plan live after restart despite old failed operations", () => {
  let html = "";
  const sandbox = {
    Map, Set,
    operationRowsForState: () => [{ planFile: "plans/corim.yaml", status: "failed", finishedAt: "2026-09-24T11:00:00Z" }],
    taskSectionViewModelForState: () => ({ allRows: [] }),
    taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}),
    normalizePlanSelectionKey: String,
    samePlanSelection: (left, right) => left === right,
    selectedExecutionPlanFile: "plans/corim.yaml",
    collapsedExecutionPlanKeys: new Set(),
    persistWebviewState: () => undefined,
    taskStatusToken: String,
    TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]),
    TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: (value) => value === "running",
    operationIsFailureLike: (value) => value === "failed",
    operationHasDeadEvidence: () => false,
    taskFailureLikeStatus: (value) => value === "failed",
    planBaseName: (value) => value.split("/").pop(),
    esc: String, escAttr: String, loadingPrefix: () => "",
    detailsOpenAttr: () => "",
    statusClass: String,
    renderOperationItem: () => "<div>operation</div>",
    renderTaskCards: () => "<div>tasks</div>",
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(executionPlanSource() + "\nthis.render = renderExecutionPlanList;", sandbox);
  sandbox.render({ sessionStartedAt: "2026-09-25T12:00:00Z", distributedPlans: [{
    id: "distributed-1", planFile: "plans/corim.yaml", enqueuedAt: "2026-09-24T10:00:00Z",
    jobs: [
      { index: 0, case: "bus", seed: 42, status: "completed", completionState: "verified", workerId: "worker-a", gpuId: "0", commandId: "old-job" },
      { index: 1, case: "pad", seed: 42, status: "running", workerId: "worker-b", gpuId: "1", commandId: "live-job" },
    ],
  }] });
  assert.match(html, /executionPlanRow running/);
  assert.match(html, /成功 1\/2 · 50% · 运行 1/);
  assert.match(html, /pad seed 42/);
  assert.match(html, /worker-b · GPU 1/);
  assert.doesNotMatch(html, /历史 Plan/);
});

test("latest distributed attempt determines completed or failed Plan display", () => {
  let html = "";
  const sandbox = {
    Map, Set,
    operationRowsForState: () => [{ planFile: "plans/concatenation.yaml", type: "run-plan", status: "interrupted", startedAt: "2026-09-20T10:00:00Z" }],
    taskSectionViewModelForState: () => ({ allRows: [] }), taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}), normalizePlanSelectionKey: String,
    samePlanSelection: (left, right) => left === right,
    selectedExecutionPlanFile: "", collapsedExecutionPlanKeys: new Set(), persistWebviewState: () => undefined,
    taskStatusToken: String, TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]), TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: (value) => value === "running",
    operationIsFailureLike: (value) => value === "failed" || value === "interrupted",
    operationHasDeadEvidence: (row) => row.status === "interrupted",
    taskFailureLikeStatus: (value) => value === "failed", planBaseName: (value) => value.split("/").pop(),
    esc: String, escAttr: String, loadingPrefix: () => "", detailsOpenAttr: () => "", statusClass: String,
    renderOperationItem: () => "<div>old interruption</div>", renderTaskCards: () => "<div>tasks</div>",
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(executionPlanSource() + "\nthis.render = renderExecutionPlanList;", sandbox);
  const failed = { id: "older", planFile: "plans/concatenation.yaml", enqueuedAt: "2026-09-24T10:00:00Z",
    jobs: [{ index: 0, case: "bus", seed: 42, status: "failed", workerId: "nwpu5", commandId: "failed-job" }] };
  const completed = { id: "newer", planFile: "plans/concatenation.yaml", enqueuedAt: "2026-09-25T10:00:00Z",
    jobs: [{ index: 0, case: "bus", seed: 42, status: "completed", completionState: "verified", workerId: "nwpu2", commandId: "completed-job" }] };
  sandbox.render({ sessionStartedAt: "2026-09-25T12:00:00Z", distributedPlans: [failed, completed] });
  assert.match(html, /executionPlanRow completed/);
  assert.match(html, /成功 1\/1 · 100%/);
  assert.doesNotMatch(html, /failed-job|old interruption|>异常</);
  assert.match(html, /nwpu2/);
  assert.doesNotMatch(html, /nwpu5/);
  sandbox.render({ sessionStartedAt: "2026-09-25T12:00:00Z", distributedPlans: [completed, {
    ...failed, id: "newest", enqueuedAt: "2026-09-25T13:00:00Z",
    jobs: [{ ...failed.jobs[0], finishedAt: "2026-09-25T13:10:00Z", error: "missing dataset schema" }],
  }] });
  assert.match(html, /executionPlanRow failed/);
  assert.match(html, /成功 0\/1 · 0% · 失败 1/);
  assert.match(html, /missing dataset schema/);
  assert.doesNotMatch(html, /old interruption|>异常</);
});

test("clearing history hides terminal distributed Plans but keeps active jobs", () => {
  let html = "";
  const sandbox = {
    Map, Set,
    operationRowsForState: () => [],
    taskSectionViewModelForState: () => ({ allRows: [] }), taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}), normalizePlanSelectionKey: String,
    samePlanSelection: (left, right) => left === right,
    selectedExecutionPlanFile: "", collapsedExecutionPlanKeys: new Set(), persistWebviewState: () => undefined,
    taskStatusToken: String, TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued"]), TASK_TERMINAL_STATUSES: new Set(["completed"]),
    operationIsActive: (value) => value === "running", operationIsFailureLike: () => false,
    operationHasDeadEvidence: () => false, taskFailureLikeStatus: () => false,
    planBaseName: (value) => value.split("/").pop(), esc: String, escAttr: String, loadingPrefix: () => "",
    detailsOpenAttr: () => "", statusClass: String,
    renderOperationItem: () => "", renderTaskCards: () => "", setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract("executionHistoryRowVisible", "operationRowsForInput")
    + executionPlanSource()
    + "\nthis.render = renderExecutionPlanList;", sandbox);
  const old = { id: "old", planFile: "plans/old.yaml", enqueuedAt: "2026-09-20T10:00:00Z",
    jobs: [{ status: "failed", case: "a", seed: 1 }] };
  const active = { id: "active", planFile: "plans/active.yaml", enqueuedAt: "2026-09-20T10:00:00Z",
    jobs: [{ status: "running", case: "b", seed: 1 }] };
  const recent = { id: "recent", planFile: "plans/recent.yaml", enqueuedAt: "2026-09-25T12:00:00Z",
    jobs: [{ status: "completed", completionState: "verified", case: "c", seed: 1 }] };
  sandbox.render({ executionHistoryCutoffs: { all: "2026-09-25T10:00:00Z" }, distributedPlans: [old, active, recent] });
  assert.doesNotMatch(html, /old.yaml/);
  assert.match(html, /active.yaml|recent.yaml/);
});

test("diagnostics default to current server health and actionable issues", () => {
  let html = "";
  const sandbox = {
    Set,
    asArray: (value) => Array.isArray(value) ? value : [],
    workerName: String,
    compactText: String,
    esc: String,
    escAttr: String,
    loadingPrefix: () => "",
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract("renderDiagnosticOverview", "renderDiagnosticDetailsJson") + "\nthis.render = renderDiagnosticOverview;", sandbox);
  sandbox.render({ setup: { workerTunnels: [{ id: "nwpu3", enabled: true }] }, workerProbes: { nwpu3: { status: "ok" } }, actionErrors: [] });
  assert.match(html, /nwpu3/);
  assert.match(html, /当前无待处理的连接或端口问题/);
  sandbox.render({ setup: { workerTunnels: [{ id: "nwpu3", enabled: true }] }, workerProbes: { nwpu3: { status: "timeout", message: "连接超时" } }, actionErrors: [] });
  assert.match(html, /连接超时/);
  assert.doesNotMatch(html, /当前无待处理的连接或端口问题/);
});

test("history clearing hides old terminal rows only in the selected Plan", () => {
  const sandbox = { normalizePlanSelectionKey: (value) => String(value || "").replaceAll("\\", "/") };
  vm.createContext(sandbox);
  vm.runInContext(extract("executionHistoryRowVisible", "operationRowsForInput") + "\nthis.visible = executionHistoryRowVisible;", sandbox);
  const state = { executionHistoryCutoffs: { "plans/a.yaml": "2026-09-21T10:00:00Z" } };
  const old = { updatedAt: "2026-09-20T10:00:00Z" };
  const newer = { updatedAt: "2026-09-21T10:01:00Z" };
  assert.equal(sandbox.visible(state, old, "plans/a.yaml", false), false);
  assert.equal(sandbox.visible(state, old, "plans/b.yaml", false), true);
  assert.equal(sandbox.visible(state, old, "plans/a.yaml", true), true);
  assert.equal(sandbox.visible(state, { ...old, status: "running", reconcileEvidenceActive: false }, "plans/a.yaml", false), false);
  assert.equal(sandbox.visible(state, newer, "plans/a.yaml", false), true);
});

function clickSandbox(extra) {
  const persisted = [];
  const sandbox = {
      // Mac 适配：Mac 面板源码在顶层声明平台常量 MAC_PLAN_IDENTITY（生产值 true，见 src/ui/PanelHtml.legacy.ts），
      // 本测试直接取面板片段在 vm 里执行，需要在沙箱里补同一常量，等价于真机面板加载时的顶层声明。
      MAC_PLAN_IDENTITY: true,
    Map, Set,
    operationRowsForState: () => [],
    taskSectionViewModelForState: () => ({ allRows: [], taskView: { selectedRows: [] } }),
    taskPlanFile: (row) => row.planFile,
    taskSelectionSetsForState: () => ({}),
    normalizePlanSelectionKey: (value) => String(value || ""),
    samePlanSelection: (left, right) => left === right,
    stableSectionSignature: (value) => JSON.stringify(value),
    asArray: (value) => Array.isArray(value) ? value : [],
    compactTaskRowsForRenderStructureSignature: (rows) => rows,
    distributedPlanRecoveryView: (plan) => plan.recovery || {},
    compactCapabilitiesForSignature: (value) => value,
    compactOperationRowsForSignature: (rows) => rows,
    normalizeFileTransferRows: (rows) => rows,
    taskActionKey: (row) => String(row.uiKey || ""),
    taskArchiveActionKey: (row) => String(row.uiKey || ""),
    operationStatusFilter: "all",
    selectedOperationHistoryIds: new Set(),
    expandedTaskLogs: new Set(),
    executionRenderKeysCacheState: null,
    executionRenderKeysCacheValue: undefined,
    executionRenderKeysCacheLocalSignature: "",
    lastExecutionPlanListKey: "",
    selectedExecutionPlanFile: "",
    collapsedExecutionPlanKeys: new Set(),
    persistWebviewState: (patch) => persisted.push(patch),
    taskStatusToken: String,
    TASK_LIVE_STATUS_TOKENS: new Set(["running"]),
    TASK_QUEUED_STATUSES: new Set(["queued", "pending"]),
    TASK_TERMINAL_STATUSES: new Set(["completed", "failed"]),
    operationIsActive: (value) => value === "running",
    operationIsFailureLike: (value) => value === "failed",
    operationHasDeadEvidence: () => false,
    taskFailureLikeStatus: (value) => value === "failed",
    planBaseName: (value) => String(value || "").split("/").pop(),
    esc: String, escAttr: String, loadingPrefix: () => "", detailsOpenAttr: () => "", statusClass: String,
    renderOperationItem: () => "<div>operation</div>",
    renderTaskCards: () => "<div>tasks</div>",
    setHtmlIfChanged: (_id, value) => { sandbox.html = value; },
    html: "",
    persisted,
  };
  Object.assign(sandbox, extra || {});
  vm.createContext(sandbox);
  const clickStart = panel.indexOf('const executionPlanFold = event.target.closest("button[data-execution-plan-fold]")');
  const clickEnd = panel.indexOf('const tracePlanScopeTarget = event.target.closest', clickStart);
  assert.ok(clickStart > 0 && clickEnd > clickStart);
  vm.runInContext("var lastState = {};\n" + executionPlanSource()
    + "\nthis.render = function (state) { state = Object.assign({ setup: { workerTunnels: [{id:'a',enabled:true},{id:'b',enabled:true}] } }, state); lastState = state; return renderExecutionPlanList(state); };\nthis.foldClick = function (event) {\n"
    + panel.slice(clickStart, clickEnd).replaceAll("\\\\", "\\")
    + "\n};", sandbox);
  return sandbox;
}

test("queue-only deferred Plan, current success counts, and manual fold survive redraw", () => {
  const sandbox = clickSandbox();
  const state = {
    sessionStartedAt: "2026-09-25T12:00:00Z",
    deferredPlans: [{ id: "wait-1", planFile: "plans/queued.yaml", status: "pending", reason: "等待当前代码版本" }],
    distributedPlans: [
      { id: "old-run", planFile: "plans/live.yaml", enqueuedAt: "2026-09-24T10:00:00Z", jobs: [
        { index: 0, case: "old", seed: 1, status: "completed", completionState: "verified", commandId: "history-ok" },
        { index: 1, case: "old", seed: 2, status: "failed", commandId: "history-fail" },
      ] },
      { id: "current-run", planFile: "plans/live.yaml", enqueuedAt: "2026-09-25T11:00:00Z", jobs: [
        { index: 0, case: "bus", seed: 7, status: "completed", completionState: "verified", commandId: "current-ok" },
        { index: 1, case: "pad", seed: 7, status: "failed", commandId: "current-fail", artifactError: "missing metric" },
        { index: 2, case: "edge", seed: 7, status: "running", commandId: "current-run" },
      ] },
    ],
  };
  sandbox.render(state);
  assert.match(sandbox.html, /queued.yaml/);
  assert.match(sandbox.html, /executionPlanRow queued/);
  assert.match(sandbox.html, />排队</);
  assert.match(sandbox.html, /排队 · 待调度/);
  assert.match(sandbox.html, /成功 1\/3 · 33% · 运行 1 · 失败 1/);
  assert.match(sandbox.html, /pad seed 7/);
  assert.match(sandbox.html, /missing metric/);
  assert.doesNotMatch(sandbox.html, /history-ok|history-fail/);
  assert.doesNotMatch(sandbox.html, /<details[^>]*open/);
  const fold = { dataset: { executionPlanFold: "plans/live.yaml" } };
  sandbox.foldClick({
    preventDefault() {}, stopPropagation() {},
    target: { closest: (selector) => selector.indexOf("data-execution-plan-fold") >= 0 ? fold : null },
  });
  assert.equal(JSON.stringify(sandbox.persisted.at(-1).collapsedExecutionPlanKeys), JSON.stringify(["plans/live.yaml"]));
  assert.match(sandbox.html, /已折叠 Plan 1/);
  assert.match(sandbox.html, /恢复监控/);
  assert.match(sandbox.html, /成功 1\/3/);
  assert.doesNotMatch(sandbox.html, /data-execution-plan-key="plans\/live.yaml"/);
  assert.match(sandbox.html, /queued.yaml/);
  sandbox.render(state);
  assert.match(sandbox.html, /已折叠 Plan 1/);
  assert.match(sandbox.html, /成功 1\/3/);
  const restored = clickSandbox({ collapsedExecutionPlanKeys: new Set(["plans/live.yaml"]) });
  restored.render(state);
  assert.match(restored.html, /已折叠 Plan 1/);
  assert.match(restored.html, /恢复监控/);
  assert.match(restored.html, /queued.yaml/);
  const cardHead = sandbox.html.slice(sandbox.html.indexOf("executionPlanCard"), sandbox.html.indexOf("详情与日志"));
  assert.match(cardHead, /折叠此 Plan/);
  assert.match(cardHead, /stopAndClearPlan/);
  assert.doesNotMatch(cardHead, /clearOperations|选中 Plan/);
  assert.match(sandbox.html, /data-command="stopAndClearPlan"/);
  assert.match(sandbox.html, /data-command="clearOperations"/);
});

test("server unknown never renders running, hosted readiness requires all confirmed jobs, cancellation remains cancellation", () => {
  const sandbox = clickSandbox();
  const plan = { id: "server-plan", planFile: "plans/authority.yaml", schedulingMode: "server_prequeue",
    enqueuedAt: "2026-09-29T12:00:00Z", planJobCount: 2, remoteAcceptedJobCount: 2,
    jobs: [{ index: 0, case: "bus", seed: 42, status: "completed", completionState: "verified", workerId: "nwpu3" },
      { index: 1, case: "pad", seed: 42, status: "unknown", workerId: "nwpu5" }] };
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, />待核实</); assert.match(sandbox.html, /尚未完整确认托管/);
  assert.doesNotMatch(sandbox.html, />运行中<|已托管，可关机/);
  plan.jobs[1].status = "queued";
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, /服务器排队/); assert.match(sandbox.html, /已托管，可关机/);
  plan.jobs.forEach((job) => { job.status = "cancelled"; });
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, />已中止</); assert.doesNotMatch(sandbox.html, />已完成</);
});

test("newer active preflight replaces an older completed run until the new run exists", () => {
  const preflight = [{ planFile: "plans/live.yaml", type: "validate-plan", status: "running", startedAt: "2026-09-25T12:00:00Z" }];
  const sandbox = clickSandbox({
    operationRowsForState: () => preflight,
    operationIsActive: (value) => value === "running" || value === "started",
  });
  const oldRun = { id: "old-run", planFile: "plans/live.yaml", enqueuedAt: "2026-09-25T10:00:00Z", jobs: [
    { index: 0, case: "bus", seed: 1, status: "completed", completionState: "verified" },
    { index: 1, case: "pad", seed: 1, status: "completed", completionState: "verified" },
  ] };
  sandbox.render({ distributedPlans: [oldRun] });
  assert.match(sandbox.html, /校验中 · 待生成 job/);
  assert.match(sandbox.html, />校验中</);
  assert.doesNotMatch(sandbox.html, /成功 2\/2|bus seed 1/);
  preflight[0] = { ...preflight[0], status: "completed", completionState: "verified" };
  sandbox.render({
    distributedPlans: [oldRun, { id: "new-run", planFile: "plans/live.yaml", enqueuedAt: "2026-09-25T12:05:00Z", jobs: [
      { index: 0, case: "edge", seed: 3, status: "pending" },
    ] }],
  });
  assert.match(sandbox.html, /成功 0\/1 · 0% · 排队 1/);
  assert.match(sandbox.html, /edge seed 3/);
  assert.doesNotMatch(sandbox.html, /bus seed 1|校验中/);
});

test("background attempt recovery and result operations never hide restored Plan jobs", () => {
  const plan = { id: "distributed-plan-1791608959184-9rrh9s",
    planFile: "experiments/plans/comparison_tuning/qmf.yaml", enqueuedAt: "2026-10-10T05:09:19.203Z",
    jobs: Array.from({ length: 18 }, (_, index) => ({ index, case: "qmf_pad_ufes_20_c00", seed: 42 + index,
      status: index < 15 ? "completed" : "running", completionState: index < 15 ? "verified" : undefined, workerId: "nwpu2", commandId: "job-" + index })) };
  const operation = { planFile: plan.planFile, status: "running", startedAt: "2026-10-10T09:35:16Z",
    payload: { workflowId: plan.id } };
  const sandbox = clickSandbox({ operationRowsForState: () => [operation] });
  for (const type of ["archive-worker-artifacts", "parse-results", "download-results", "recover-training-completion",
    "stop-worker-task", "refresh-state"]) {
    operation.type = type;
    // Repeated progress/restart snapshots must keep the real job list visible immediately.
    for (let refresh = 0; refresh < 3; refresh++) {
      operation.updatedAt = "2026-10-10T09:36:0" + refresh + "Z";
      sandbox.render({ distributedPlans: [plan] });
      assert.match(sandbox.html, /成功 15\/18 · 83% · 运行 3/, type);
      assert.match(sandbox.html, /qmf_pad_ufes_20_c00 seed 42/, type);
      assert.doesNotMatch(sandbox.html, /待生成 job|当前还没有新 job/, type);
    }
  }
});

test("restored execution identity and progress timestamps cannot masquerade as a new submission", () => {
  const plan = { id: "current-run", planFile: "plans/live.yaml", enqueuedAt: "2026-10-10T05:09:19Z",
    jobs: [{ index: 0, case: "live", seed: 42, status: "unknown" }] };
  const operation = { planFile: plan.planFile, type: "run-plan", status: "running",
    startedAt: "2026-10-10T09:35:16Z", payload: { workflowId: plan.id } };
  const sandbox = clickSandbox({ operationRowsForState: () => [operation] });
  const beforeIdentity = structuredClone(operation);
  delete operation.payload;
  const unboundKey = sandbox.executionRenderKeysForState({ distributedPlans: [plan] }).planList;
  operation.payload = beforeIdentity.payload;
  const boundKey = sandbox.executionRenderKeysForState({ distributedPlans: [plan] }).planList;
  assert.notEqual(boundKey, unboundKey, "late workflow evidence must redraw immediately without a job status change");
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, /live seed 42/);
  assert.match(sandbox.html, /待核实/);
  assert.doesNotMatch(sandbox.html, /待生成 job/);
  delete operation.payload;
  delete operation.startedAt;
  operation.updatedAt = "2026-10-10T09:35:16Z";
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, /live seed 42/, "missing submission time cannot displace known durable jobs");
  assert.doesNotMatch(sandbox.html, /待生成 job/);
  operation.createdAt = "2026-10-10T05:09:13Z";
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, /live seed 42/);
  assert.doesNotMatch(sandbox.html, /待生成 job/);
  operation.createdAt = "2026-10-10T10:00:00Z";
  sandbox.render({ distributedPlans: [plan] });
  assert.match(sandbox.html, /提交中 · 待生成 job/, "a genuinely newer submission still has its own stage");
  assert.doesNotMatch(sandbox.html, /live seed 42/);
});

test("production operation projection and normalization retain submission identity before Plan rendering", () => {
  const ts = require("typescript");
  const projected = { exports: {} };
  vm.runInNewContext(ts.transpileModule(readSource("src/ui/OperationPayload.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, projected);
  const sandbox = clickSandbox({ resolveWorkerId: String, operationStatusFromType: () => "running",
    normalizeUnparseableDetails: () => [], outputContractMissingLabel: String, operationSearchText: () => "" });
  vm.runInContext(extract("operationPayload", "normalizeFileTransferRows") + extract("pick", "formatDuration")
    + extract("normalizeOperationRows", "normalizeUnparseableDetails")
    + "\noperationRowsForState = (state) => normalizeOperationRows(state.operations);", sandbox);
  const plan = { id: "current-run", planFile: "plans/live.yaml", enqueuedAt: "2026-10-10T05:09:19Z",
    jobs: [{ index: 0, case: "live", seed: 42, status: "running" }] };
  const row = { operationId: "operation", planFile: plan.planFile, type: "run-plan", status: "running",
    events: Array.from({ length: 100 }, (_, seq) => ({ seq, message: "large".repeat(5000) })),
    payload: { log: "tail".repeat(5000), workflowId: plan.id },
    startedAt: "2026-10-10T09:35:16Z", updatedAt: "2026-10-10T09:36:00Z" };
  const render = () => sandbox.render({ distributedPlans: [plan],
    operations: projected.exports.compactOperationsForWebview({ operation: { ...row } }) });
  render();
  assert.match(sandbox.html, /live seed 42/, "restored workflow survives large optional diagnostics");
  assert.doesNotMatch(sandbox.html, /待生成 job/);
  delete row.payload;
  row.type = "validate-plan";
  render();
  assert.match(sandbox.html, /校验中 · 待生成 job/, "a real new preflight retains its immutable start time");
  row.startedAt = "2026-10-10T05:09:13Z";
  render();
  assert.match(sandbox.html, /live seed 42/);
  assert.doesNotMatch(sandbox.html, /待生成 job/);
  row.startedAt = "2026-10-10T10:00:00Z";
  row.type = "run-plan";
  row.localSubmissionProgress = true;
  row.status = "queued";
  sandbox.operationIsActive = (status) => status === "running" || status === "queued";
  render();
  assert.match(sandbox.html, /等待继续提交 · 待生成 job/, "local submission metadata survives normalization");
});

test("deferred status stays distinct and is not hidden by an older distributed run", () => {
  const sandbox = clickSandbox();
  sandbox.render({
    distributedPlans: [{ id: "old", planFile: "plans/held.yaml", enqueuedAt: "2026-09-25T09:00:00Z", jobs: [{ status: "completed", completionState: "verified", case: "old", seed: 1 }] }],
    deferredPlans: [
      { id: "hold", planFile: "plans/held.yaml", status: "blocked", reason: "代码指纹不匹配" },
      { id: "work", planFile: "plans/work.yaml", status: "processing", error: "正在准备输出目录" },
      { id: "wait", planFile: "plans/wait.yaml", status: "pending", reason: "等待当前代码版本" },
      { id: "gone", planFile: "plans/gone.yaml", status: "superseded", reason: "已被新提交替代" },
    ],
  });
  assert.match(sandbox.html, /held\.yaml[\s\S]*阻塞 · 待调度/);
  const held = sandbox.html.slice(sandbox.html.indexOf('data-execution-plan-key="plans/held.yaml"'));
  const heldDetail = held.slice(held.indexOf("详情与日志"));
  assert.match(heldDetail, /代码指纹不匹配/);
  assert.doesNotMatch(held.slice(0, held.indexOf("详情与日志")), /代码指纹不匹配/);
  assert.doesNotMatch(sandbox.html, /old seed 1/);
  assert.match(sandbox.html, /work\.yaml[\s\S]*处理中 · 待生成 job/);
  assert.match(sandbox.html, /正在准备输出目录/);
  assert.match(sandbox.html, /wait\.yaml[\s\S]*排队 · 待调度/);
  assert.match(sandbox.html, /等待当前代码版本/);
  assert.doesNotMatch(sandbox.html, /gone\.yaml|已被新提交替代/);
  const heldHead = sandbox.html.slice(sandbox.html.indexOf("held.yaml"), sandbox.html.indexOf("详情与日志", sandbox.html.indexOf("held.yaml")));
  assert.doesNotMatch(heldHead, /代码指纹不匹配/);
});

test("plan cards follow submission order rather than running or failure priority", () => {
  const sandbox = clickSandbox();
  sandbox.render({
    distributedPlans: [
      { id: "done", planFile: "plans/done.yaml", enqueuedAt: "2026-09-25T12:00:00Z", jobs: [{ status: "completed", completionState: "verified", case: "a", seed: 1 }] },
      { id: "bad", planFile: "plans/bad.yaml", enqueuedAt: "2026-09-25T12:01:00Z", jobs: [{ status: "failed", case: "b", seed: 1 }] },
      { id: "hold", planFile: "plans/hold.yaml", enqueuedAt: "2026-09-25T12:02:00Z", jobs: [{ status: "pending", case: "c", seed: 1, blockReason: "代码指纹不匹配：旧代码" }] },
      { id: "wait", planFile: "plans/wait.yaml", enqueuedAt: "2026-09-25T12:03:00Z", jobs: [{ status: "pending", case: "d", seed: 1 }] },
      { id: "run", planFile: "plans/run.yaml", enqueuedAt: "2026-09-25T12:04:00Z", jobs: [{ status: "running", case: "e", seed: 1 }] },
    ],
  });
  const order = ["bad.yaml", "hold.yaml", "wait.yaml", "run.yaml"].map((name) => sandbox.html.indexOf(name));
  assert.deepEqual(order, order.slice().sort((left, right) => left - right));
  assert.ok(order.every((index) => index >= 0));
  assert.match(sandbox.html, /已完成 Plan 历史 1/);
  assert.ok(sandbox.html.indexOf("done.yaml") > order.at(-1), "completed history keeps its existing separate fold");
});

test("concurrent Plan cards stay fixed through twenty alternating progress snapshots", () => {
  const sandbox = clickSandbox();
  const first = { id: "first", planFile: "plans/a.yaml", enqueuedAt: "2026-10-07T10:00:00Z",
    jobs: [{ index: 0, case: "bus", seed: 42, status: "running" }] };
  const second = { id: "second", planFile: "plans/b.yaml", enqueuedAt: "2026-10-07T10:01:00Z",
    jobs: [{ index: 0, case: "pad", seed: 42, status: "running" }] };
  for (let index = 0; index < 20; index += 1) {
    const plans = [first, second].map((plan, slot) => ({ ...plan, jobs: plan.jobs.map((job) => ({ ...job,
      status: (index + slot) % 3 === 0 ? "queued" : "running",
      updatedAt: new Date(Date.parse("2026-10-07T10:02:00Z") + (index * 2 + ((index + slot) % 2)) * 500).toISOString(),
      epoch: index, loss: 1 / (index + 1), percent: index * 2,
    })) }));
    sandbox.selectedExecutionPlanFile = index % 2 ? first.planFile : second.planFile;
    sandbox.render({ distributedPlans: index % 2 ? plans.reverse() : plans });
    assert.ok(sandbox.html.indexOf('data-execution-plan-key="plans/a.yaml"')
      < sandbox.html.indexOf('data-execution-plan-key="plans/b.yaml"'), `snapshot ${index}`);
  }
});

test("card order uses the latest submission generation and deterministic path ties", () => {
  const sandbox = clickSandbox();
  const row = (id, planFile, enqueuedAt) => ({ id, planFile, enqueuedAt,
    jobs: [{ index: 0, case: "bus", seed: 42, status: "running" }] });
  const plans = [row("old-a", "plans/a.yaml", "2026-10-07T09:00:00Z"),
    row("b", "plans/b.yaml", "2026-10-07T10:00:00Z"), row("new-a", "plans/a.yaml", "2026-10-07T11:00:00Z")];
  sandbox.render({ distributedPlans: plans });
  assert.ok(sandbox.html.indexOf("b.yaml") < sandbox.html.indexOf("a.yaml"));
  for (const rows of [[row("z", "plans/z.yaml", ""), row("a", "plans/a.yaml", "")],
    [row("a", "plans/a.yaml", ""), row("z", "plans/z.yaml", "")]]) {
    sandbox.render({ distributedPlans: rows });
    assert.ok(sandbox.html.indexOf("a.yaml") < sandbox.html.indexOf("z.yaml"));
  }
});

test("manual fold survives an empty snapshot and webview restore", () => {
  const sandbox = clickSandbox({ collapsedExecutionPlanKeys: new Set(["plans/live.yaml"]) });
  sandbox.render({ distributedPlans: [], deferredPlans: [] });
  assert.doesNotMatch(sandbox.html, /已折叠 Plan/);
  assert.equal(sandbox.collapsedExecutionPlanKeys.has("plans/live.yaml"), true);
  assert.equal(sandbox.persisted.some((patch) => patch.collapsedExecutionPlanKeys), false);
  sandbox.render({
    distributedPlans: [{ id: "back", planFile: "plans/live.yaml", enqueuedAt: "2026-09-25T12:00:00Z", jobs: [{ status: "completed", completionState: "verified", case: "bus", seed: 1 }] }],
  });
  assert.match(sandbox.html, /已折叠 Plan 1/);
  assert.match(sandbox.html, /恢复监控/);
  assert.doesNotMatch(sandbox.html, /data-execution-plan-key="plans\/live.yaml"/);
  const restored = clickSandbox({ collapsedExecutionPlanKeys: new Set(sandbox.collapsedExecutionPlanKeys) });
  restored.render({
    distributedPlans: [{ id: "back", planFile: "plans/live.yaml", enqueuedAt: "2026-09-25T12:00:00Z", jobs: [{ status: "completed", completionState: "verified", case: "bus", seed: 1 }] }],
  });
  assert.match(restored.html, /已折叠 Plan 1/);
  assert.match(restored.html, /成功 1\/1/);
  assert.match(restored.html, /data-execution-plan-check="plans\/live.yaml"/);
});

test("exact operation cleanup hides only terminal records", () => {
  const rows = [
    { operationId: "old-run", status: "failed", planFile: "plans/corim.yaml" },
    { operationId: "live-run", status: "running", planFile: "plans/corim.yaml" },
  ];
  const sandbox = {
    Set, Array,
    executionHistoryRowsCacheState: null, executionHistoryRowsCacheValue: [],
    operationRowsForInput: () => rows,
    operationIsActive: (value) => value === "running",
    operationOutcomePendingHistory: (row) => String(row?.status || row?.state || "").trim().toLowerCase() === "outcome_pending" && row?.reconcileEvidenceActive !== true,
    executionHistoryRowVisible: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(extract("operationRowsForState", "executionHistoryRowVisible") + "\nthis.visibleRows = operationRowsForState;", sandbox);
  const visible = sandbox.visibleRows({ executionHistoryHiddenOperationIds: ["old-run", "live-run"] });
  assert.deepEqual(Array.from(visible, (row) => row.operationId), ["live-run"]);
});

test("completed history displays run-scoped global artifact verification without expanding details", () => {
  const sandbox = clickSandbox();
  const completed = { id: "latest-run", planFile: "plans/ebmc.yaml", enqueuedAt: "2026-10-07T12:00:00Z",
    jobs: [{ index: 0, case: "bus", seed: 42, status: "completed", completionState: "verified" }] };
  for (const [status, label] of [["checking", "正在核验全局同步"], ["synced", "已全局同步最新产物"],
    ["partial", "尚未全局同步"], ["unknown", "全局同步待核验"]]) {
    sandbox.render({ distributedPlans: [completed], planArtifactSyncStatuses: {
      "latest-run": { runId: "latest-run", status, targetCount: 3, syncedCount: status === "synced" ? 3 : 1, detail: "包含权重" },
    } });
    assert.match(sandbox.html, /已完成 Plan 历史 1/);
    assert.ok(sandbox.html.includes(label));
    assert.ok(sandbox.html.indexOf(label) < sandbox.html.indexOf("详情与日志"));
  }
  sandbox.render({ distributedPlans: [completed], planArtifactSyncStatuses: {
    "latest-run": { runId: "old-run", status: "synced", targetCount: 3, syncedCount: 3 },
  } });
  assert.doesNotMatch(sandbox.html, /已全局同步最新产物/);
  assert.match(sandbox.html, /全局同步待核验/);
});

test("queried absent historical windows reserve no active slot and never count as a completed PLAN", () => {
  const sandbox=clickSandbox();
  sandbox.render({distributedPlans:[{id:'old',planFile:'plans/old.yaml',enqueuedAt:'2026-09-01T00:00:00Z',jobs:[{
    index:0,case:'old',seed:42,lifecycleProtocol:2,status:'unknown',executionState:'missing',resultState:'unverified',workerId:'w',commandId:'old'
  }]}]});
  assert.match(sandbox.html,/未发现执行窗口 1/);
  assert.match(sandbox.html,/待核实 1/);
  assert.doesNotMatch(sandbox.html,/已完成 Plan 历史|· 派发 1|· 排队 1|· 运行 1/);
});

// 0.5.416 配套（se-stage-block-visibility-release）：暂存槽卡点在 Job 错误区的显示矩阵。
// 「卡在哪台/哪个范围/通道/身份＋两槽」始终按结构化字段显示；「释放旧文件占用」按钮仅当
// 结构化 releaseCandidate 与扩展端实时能力门（stageBlockReleaseCapable）同时成立才出现。
test('Worker-local automatic selection is visible before dispatch and invalidates the real render key',()=>{
 const sandbox=clickSandbox(),state={distributedPlans:[{id:'wf',planFile:'plans/p.yaml',jobs:[
  {index:0,case:'c',seed:42,status:'pending',lifecycleProtocol:2,automaticWorkerId:'selected-worker'}]}]};
 const key=sandbox.executionRenderKeysForState(state).planList;sandbox.render(state);
 assert.match(sandbox.html,/selected-worker · 等待本服务器空卡 · 自动选卡/);
 assert.doesNotMatch(sandbox.html,/data-job-tmux-log="1"[^>]*data-worker-id="selected-worker"/,'waiting intent is not a running Worker identity');
 const next=structuredClone(state);next.distributedPlans[0].jobs[0].automaticWorkerId='other-worker';
 assert.notEqual(sandbox.executionRenderKeysForState(next).planList,key);
});
const stageBlockFixture = (overrides = {}) => ({ schemaVersion: 1, code: "TRANSFER_STAGE_PENDING",
  destination: { id: "nwpu3", profile: "work", host: "nwpu3.invalid" }, scope: '["job-artifacts","plans/p.yaml",0,"c0",42]',
  lane: 1, identity: "a".repeat(64), incomingGeneration: "b".repeat(64),
  slots: [{ slot: "slot-0", path: ".staged-slots/aaa/slot-0", generation: "c".repeat(64), status: "committed",
      createdAt: 1, terminalAt: 2, updatedAt: 3, timeSource: "journal-terminalAt", ageMs: 172800000, locked: false, protectedReason: null },
    { slot: "slot-1", path: ".staged-slots/aaa/slot-1", generation: "d".repeat(64), status: "running", createdAt: 4, terminalAt: 0,
      updatedAt: 5, timeSource: null, ageMs: null, locked: true, protectedReason: "lock-held" }],
  releaseCandidate: true, ...overrides });
const stageBlockJob = (extra = {}) => ({ index: 0, case: "done", seed: 42, status: "completed", completionState: "verified",
  lifecycleProtocol: 2, workerId: "nwpu3", commandId: "cmd-a",
  artifactError: "最新产物同步未完成：TRANSFER_STAGE_PENDING: 两代暂存槽均被同一来源的已提交代占用 · 暂存槽卡点：主机 nwpu3.invalid",
  ...extra });

test('single enabled Worker hides obsolete cross-Worker artifact controls and errors while retaining real execution failures',()=>{
 const sandbox=clickSandbox();
 const state={setup:{workerTunnels:[{id:'current',enabled:true},{id:'history',enabled:false}]},
  distributedPlans:[{id:'wf',planFile:'plans/p.yaml',jobs:[stageBlockJob({error:'actual command failed',
   artifactStageBlock:stageBlockFixture(),stageBlockReleaseCapable:true})]}],
  planArtifactSyncStatuses:{wf:{runId:'wf',status:'partial',targetCount:2}}};
 const multi=structuredClone(state);multi.setup.workerTunnels[1].enabled=true;
 const previous=sandbox.executionRenderKeysForState(multi).planList;
 sandbox.render(multi);assert.match(sandbox.html,/TRANSFER_STAGE_PENDING/);
 assert.notEqual(sandbox.executionRenderKeysForState(state).planList,previous,'changing only enabled Workers invalidates the rendered Plan key');
 sandbox.render(state);
 assert.match(sandbox.html,/actual command failed/);
 assert.doesNotMatch(sandbox.html,/TRANSFER_STAGE_PENDING|暂存槽卡点|全局同步|重试产物同步|刷新产物状态|重试 Plan 产物同步|刷新 Plan 产物状态|releaseJobStageBlockSlots/);
});

test("stage block shows host/profile/scope/lane/identity and both slots in the job error area while keeping the readable error line", () => {
  const sandbox = clickSandbox();
  sandbox.render({ distributedPlans: [{ id: "wf", planFile: "plans/p.yaml", jobs: [stageBlockJob({
    artifactStageBlock: stageBlockFixture(), stageBlockReleaseCapable: true })] }] });
  assert.match(sandbox.html, /最新产物同步未完成：TRANSFER_STAGE_PENDING/, "文本兼容：原错误行原样保留");
  assert.match(sandbox.html, /暂存槽卡点：主机 nwpu3\.invalid（profile work）/);
  assert.match(sandbox.html, /通道 1/);
  assert.match(sandbox.html, /身份 aaaaaaaaaaaa…/);
  assert.match(sandbox.html, /待进入代 bbbbbbbbbbbb…/);
  assert.match(sandbox.html, /槽 slot-0[^<]*状态 committed[^<]*已存在 2 天/, "槽 0：committed＋两天年龄");
  assert.match(sandbox.html, /槽 slot-1[^<]*正在被占用[^<]*受保护：lock-held/, "槽 1：占用与保护原因可见");
  assert.match(sandbox.html, /data-command="releaseJobStageBlockSlots" data-plan-id="wf" data-job-index="0" data-command-id="cmd-a"/, "能力齐备＋候选=释放按钮");
});

test("no release button without live capability, without a release candidate, or without structured block; the old SFTP plain-text line still shows", () => {
  const oldSftp = clickSandbox();
  oldSftp.render({ distributedPlans: [{ id: "wf", planFile: "plans/p.yaml", jobs: [stageBlockJob({ stageBlockReleaseCapable: true })] }] });
  assert.doesNotMatch(oldSftp.html, /data-command="releaseJobStageBlockSlots"/, "无结构化卡点（旧 SFTP）：只有原文本行，不猜卡点");
  assert.match(oldSftp.html, /TRANSFER_STAGE_PENDING/);
  const capabilityMissing = clickSandbox();
  capabilityMissing.render({ distributedPlans: [{ id: "wf", planFile: "plans/p.yaml", jobs: [stageBlockJob({
    artifactStageBlock: stageBlockFixture(), stageBlockReleaseCapable: false })] }] });
  assert.doesNotMatch(capabilityMissing.html, /data-command="releaseJobStageBlockSlots"/, "新 SE＋旧 SFTP（能力不齐备）不出现按钮、不猜路径");
  assert.match(capabilityMissing.html, /暂存槽卡点：主机 nwpu3\.invalid/, "但卡点仍要显示");
  assert.match(capabilityMissing.html, /不会猜测路径/);
  const protectedOnly = clickSandbox();
  protectedOnly.render({ distributedPlans: [{ id: "wf", planFile: "plans/p.yaml", jobs: [stageBlockJob({
    artifactStageBlock: stageBlockFixture({ releaseCandidate: false }), stageBlockReleaseCapable: true })] }] });
  assert.doesNotMatch(protectedOnly.html, /data-command="releaseJobStageBlockSlots"/, "locked/非终态/时间未知=无候选，不提供释放入口");
  assert.match(protectedOnly.html, /无可释放候选/);
});
