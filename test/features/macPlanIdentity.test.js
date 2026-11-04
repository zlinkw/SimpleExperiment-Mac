const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
require('../_helpers/registerTsRequire');

const root = path.resolve(__dirname, '../..');
function astParts(source) {
  const ast = ts.createSourceFile('actual.ts', source, ts.ScriptTarget.Latest, true);
  const functions = new Map(), methods = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
    if (ts.isMethodDeclaration(node)) methods.set(node.name.getText(ast), node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { functions, methods };
}
function host(platform = 'darwin') {
  const packageRoot=process.env.SIMPLE_IDENTITY_PACKAGE_ROOT;
  const { functions, methods } = astParts(fs.readFileSync(packageRoot?path.join(packageRoot,'dist/extension/legacy.js'):path.join(root, 'src/extension/legacy.ts'), 'utf8'));
  const names = ['usableSelectionKey', 'uniqueStrings', 'normalizePlanSelectionKey', 'planFileEquivalenceKeys',
    'samePlanSelection', 'planIdentityKeys', 'resolvePlanFileFromPlanList', 'operationResultPlanFile',
    'stringField', 'stringArrayField', 'mergeRecentPlans', 'readProjectPlanSelectionState', 'writeProjectPlanSelectionState'];
  let persisted;
  const sandbox = vm.createContext({ process: { platform }, path,
    ApiWorkflow_1:require(packageRoot?path.join(packageRoot,'dist/features/ApiWorkflow'):path.join(root,'src/features/ApiWorkflow.ts')),
    normalizePosixRelativePath:require('../../src/mac/PosixPath.ts').normalizePosixRelativePath,
    PosixPath_1:require('../../src/mac/PosixPath.ts'),
    PROJECT_PLAN_SELECTION_PATH: 'simple_cluster/ui/plan_selection.json',
    fs: { mkdir: async () => {}, readFile: async () => JSON.stringify(persisted) },
    writeAtomicPluginStateJson: async (_file, payload) => { persisted = payload; },
  });
  const code = names.map(name => { assert.ok(functions.has(name), name); return functions.get(name); }).join('\n') +
    '\nclass Subject { ' + ['actionPlanTarget', 'localPlanForActionBody', 'apiPlanValidate', 'apiResolveSelectedPlan', 'stampPlanRevision', 'planVersionForFile', 'planSubmissionPlanFile', 'selectPlanFromUi']
      .map(name => methods.get(name)).join('\n') + '\n}\nthis.Subject = Subject;';
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  return sandbox;
}
function compiledQueue(platform) {
  const file = path.join(process.env.SIMPLE_IDENTITY_PACKAGE_ROOT || root, 'dist/features/DistributedPlanQueue.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
    require: createRequire(file), process: { platform }, Buffer, console }, { filename: file });
  return module.exports;
}
function panel(platform = 'darwin') {
  const html = require(path.join(process.env.SIMPLE_IDENTITY_PACKAGE_ROOT || root,'dist/ui/PanelHtml.legacy.js')).renderPanelHtml(platform);
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(code => code.includes('function samePlanSelection('));
  assert.ok(script);
  new vm.Script(script);
  const parts = astParts(script);
  const flag = script.match(/const MAC_PLAN_IDENTITY = (true|false);/);
  assert.ok(flag, 'platform marker must come from the actual rendered script');
  const sandbox = vm.createContext({ MAC_PLAN_IDENTITY: flag[1] === 'true',
    PLAN_FILE_EQUIVALENCE_CACHE_LIMIT: 2, planFileEquivalenceCache: new Map(),
    EMPTY_PLAN_FILE_EQUIVALENCE_ENTRY: { keys: [], keySet: new Set() } });
  vm.runInContext(['uniqueText', 'normalizePlanSelectionKey', 'planFileEquivalenceEntry', 'planFileEquivalenceKeys',
    'samePlanSelection', 'planFileOf', 'collectPlanFileDefaultOrder', 'resolvePlanFileCurrent', 'matchPlanFileInOrder',
    'executionPlanGroupKey'].map(name => { assert.ok(parts.functions.has(name), name); return parts.functions.get(name); }).join('\n'), sandbox);
  return sandbox;
}
const files = ['experiments/plans/中文/A.yaml', 'experiments/plans/中文/a.yaml',
  ' experiments/plans/中文/A.yaml ', 'experiments/plans/中文/A%20.yaml', 'experiments/plans/中文/A .yaml'];

test('Mac backend, compiled queue and rendered panel preserve distinct POSIX spellings', () => {
  const backend = host(), queue = compiledQueue('darwin'), ui = panel();
  for (const file of files) {
    assert.equal(backend.normalizePlanSelectionKey(file, true), file);
    assert.equal(queue.planFileIdentityKey(file), file);
    assert.equal(ui.executionPlanGroupKey(file), file);
    for (const other of files) {
      assert.equal(backend.samePlanSelection(file, other), file === other);
      assert.equal(queue.sameDistributedPlanFile(file, other), file === other);
      assert.equal(ui.samePlanSelection(file, other), file === other);
    }
  }
  for (const alias of ['plans/中文/A.yaml', '/project/experiments/plans/中文/A.yaml', './' + files[0], files[0].replaceAll('/', '\\')]) {
    assert.equal(backend.samePlanSelection(files[0], alias), false);
    assert.equal(queue.sameDistributedPlanFile(files[0], alias), false);
    assert.equal(ui.samePlanSelection(files[0], alias), false);
  }
  for (const spelling of ['é.yaml', 'e\u0301.yaml', 'plans/name\\part.yaml']) {
    assert.equal(backend.normalizePlanSelectionKey(spelling), spelling);
    assert.equal(queue.planFileIdentityKey(spelling), spelling);
    assert.equal(ui.planFileOf({ file: spelling }), spelling);
  }
});

test('API and UI supported PLAN selectors stamp the same real revision without duplicate paths',()=>{
 const backend=host(),subject=new backend.Subject(),file=files[0];
 const plan={planFile:file,planId:'chosen-id',revision:'actual-file-revision'};
 subject.localPlanMetadata={plans:[plan,{planFile:files[1],planId:'other-id',revision:'other-revision'}]};
 subject.planFileInput=files[1];subject.selectedPlanId='other-id';
 for(const fields of [{planFile:file},{options:{planFile:file}},{selectedPlanId:'chosen-id'},{planId:'chosen-id'},
   {planFile:file,options:{planFile:file},selectedPlanId:'chosen-id'}]){
   const body=structuredClone(fields);
   assert.equal(subject.apiResolveSelectedPlan(fields).revision,plan.revision);
   subject.stampPlanRevision(body);
   assert.equal(body.planRevision,plan.revision,JSON.stringify(fields));
   assert.equal(body.options.planRevision,plan.revision);
   const target=subject.actionPlanTarget(fields);
   assert.equal(subject.localPlanForActionBody({...target,options:{planFile:target.planFile}}).revision,plan.revision);
   assert.equal(fields.planRevision,undefined,'caller input is not mutated by resolving selection');
 }
 for(const fields of [{planFile:file,options:{planFile:files[1]}},{planFile:file,selectedPlanId:'other-id'},
   {planId:'chosen-id',selectedPlanId:'other-id'},{planFile:file,file:files[1]}]){
   assert.throws(()=>subject.apiResolveSelectedPlan(fields),/PLAN_SELECTION_CONFLICT/);
   assert.throws(()=>subject.localPlanForActionBody(fields),/PLAN_SELECTION_CONFLICT/);
   assert.throws(()=>subject.actionPlanTarget(fields),/PLAN_SELECTION_CONFLICT/);
 }
});

test('formal admission identifies exactly which real PLAN identity field is missing',()=>{
 const queue=compiledQueue('darwin'),valid={planFile:files[0],revision:'revision',codeFingerprint:'fingerprint',jobs:[]};
 for(const[key,label]of [['revision','planRevision'],['codeFingerprint','codeFingerprint'],['planFile','planFile']]){
   assert.throws(()=>queue.enqueuePlan(queue.emptyDistributedQueue(),{...valid,[key]:''},'plan-id'),error=>error.message.includes('PLAN_IDENTITY_MISSING')&&error.message.includes(label));
 }
 assert.throws(()=>queue.enqueuePlan(queue.emptyDistributedQueue(),valid,''),/PLAN_IDENTITY_MISSING.*planId/);
});

test('actual public plan.validate passes one selector through real stamping and formal enqueue',async()=>{
 const backend=host(),subject=new backend.Subject(),file=files[0],plan={planFile:file,planId:'id',revision:'file-revision'};
 const workflow=backend.ApiWorkflow_1;
 backend.ApiWorkflow_1={...workflow,structuredMissingInventory:()=>[]};
 backend.workspaceRoot=()=>'/private/研究 工作区';
 backend.WorkflowBinding={bindWorkflowWorkspace:()=>({}),assertWorkflowContext(){},assertWorkflowWorkspace(){}};
 backend.errorMessage=error=>error.message;
 backend.simpleSftpIntegrationReadiness=()=>({ready:true});backend.projectOutputGateDiagnostics=()=>({rows:[]});
 backend.planValidationFromResult=value=>value.validation;
 backend.fs.stat=async()=>{throw Error('no project checker fixture');};
 Object.assign(subject,{localPlanMetadata:{plans:[plan]},setupConfig:{},lastWorkerProbes:{},projectContextGeneration:1,
  isMacVariant:()=>true,ensureRemoteAgentVersionConsistent:async()=>{},refreshLocalPlanMetadataForAction:async()=>{},
  projectTopologyAssessment:()=>({}),agentRuntimeDirs:()=>({workDir:'/remote'}),enabledWorkerConfigs:()=>[],
  assertPlanLocalConfigFiles:async()=>{},ensureWorkerPoolPlanTarget:async()=>{},assertPlanSchedulerAgentReady(){},
  ensureWorkerCodeReadyForPlanCheck:async body=>{body.codeFingerprint='persisted-fingerprint';},apiPublicTopology:value=>value,
  runPlanPreflight:async body=>{const q=compiledQueue('darwin');q.enqueuePlan(q.emptyDistributedQueue(),{planFile:body.planFile,revision:body.planRevision,codeFingerprint:body.codeFingerprint,jobs:[{index:0,case:'fixture',seed:42,outputDir:'work_dirs/fixture'}]},'fixture-run');return {validation:{ok:true}};}});
 for(const fields of [{planFile:file},{options:{planFile:file}},{selectedPlanId:'id'},{planFile:file,options:{planFile:file},selectedPlanId:'id'}]){
  const input={workspace:'/private/研究 工作区',...fields},before=JSON.stringify(input),answer=await subject.apiPlanValidate(input);
  assert.equal(answer.ok,true,JSON.stringify(answer));assert.equal(answer.checks.remoteExecution,'not_started');assert.equal(answer.checks.projectScience,'project_owned_not_executed');assert.equal(JSON.stringify(input),before);
 }
 await assert.rejects(subject.apiPlanValidate({planFile:file,options:{planFile:files[1]}}),/PLAN_SELECTION_CONFLICT/);
});

test('Mac payload selection, receipts and saved selection retain real edge spaces', async () => {
  const backend = host(), subject = new backend.Subject();
  const file = files[2];
  subject.planFileInput = files[0]; subject.selectedPlanId = files[0];
  const plans = files.map((planFile, index) => ({ planFile, revision: 'revision-' + index, name: 'same' }));
  subject.localPlanMetadata = { plans };
  subject.resolveSelectedPlanFile = hint => backend.resolvePlanFileFromPlanList(plans, hint);
  for (const message of [{ planFile: file }, { file }, { selectedPlanFiles: [file, file] }]) {
    const target = subject.actionPlanTarget(message);
    assert.equal(target.planFile, file);
    assert.equal(subject.localPlanForActionBody({ options: { planFile: file } }).revision, 'revision-2');
    assert.equal(subject.planVersionForFile(file).revision, 'revision-2');
  }
  assert.equal(backend.operationResultPlanFile({ options: { planFile: file } }), file);
  assert.equal(subject.planSubmissionPlanFile({}, { options: { planFile: file } }), file);
  Object.assign(subject, { refreshExperimentTracesProjectionForCurrentInterest() {},
    persistProjectPlanSelectionState: async () => {}, ensureSelectedPlanFileWatchers() {}, postState() {},
    queuePlanScopedResultParse: (_reason, selected) => assert.equal(selected, file) });
  subject.selectPlanFromUi({ planFile: file });
  assert.equal(subject.planFileInput, file); assert.equal(subject.selectedPlanId, file);
  assert.equal(backend.stringField({ workerId: ' worker ' }, 'workerId'), 'worker');
  await backend.writeProjectPlanSelectionState('/project', { selectedPlanId: file, planFileInput: file,
    recentPlans: [{ planFile: file }, { planFile: files[0] }] });
  const restored = await backend.readProjectPlanSelectionState('/project');
  assert.equal(restored.planFileInput, file); assert.equal(restored.selectedPlanId, file);
  assert.equal(restored.recentPlans.length, 2);
  assert.equal(backend.resolvePlanFileFromPlanList(plans, files[1]), files[1]);
  assert.throws(() => backend.resolvePlanFileFromPlanList(plans, 'same'), /完整 Plan 路径/);
  assert.equal(backend.resolvePlanFileFromPlanList(plans, 'experiments/plans/Missing.yaml', [files[0]]), 'experiments/plans/Missing.yaml');
});

test('rendered Mac selection order and bounded cache keep case and whitespace separate', () => {
  const ui = panel();
  const state = { plans: files.map(file => ({ file })), planFileInput: files[2] };
  assert.deepEqual(Array.from(ui.collectPlanFileDefaultOrder(state)), files);
  assert.equal(ui.resolvePlanFileCurrent(undefined, state), files[2]);
  assert.equal(ui.matchPlanFileInOrder(files[1], files), files[1]);
  const a = ui.planFileEquivalenceEntry(files[0]), b = ui.planFileEquivalenceEntry(files[1]);
  assert.notEqual(a, b);
  assert.equal(ui.planFileEquivalenceEntry(files[1]), b);
  files.forEach(file => ui.planFileEquivalenceEntry(file));
  assert.ok(ui.planFileEquivalenceCache.size <= 2);
});

function queueFixture(api, compatibility = false) {
  const now = Date.parse('2026-10-10T08:00:00Z');
  let queue = api.emptyDistributedQueue();
  files.forEach((file, index) => {
    queue = api.enqueuePlan(queue, { projectId: 'project', planFile: file, revision: 'r', codeFingerprint: 'fp',
      jobs: [{ index: 0, case: 'case', seed: 42, outputDir: 'work_dirs/attempt-' + index }] },
      'run-' + index, new Date(now + index).toISOString());
    Object.assign(queue.plans[index].jobs[0], { status: 'running', workerId: 'worker', commandId: 'cmd-' + index });
    delete queue.plans[index].automaticRetry;
  });
  if (compatibility) {
    queue = { ...queue, plans: queue.plans.map(plan => ({ ...plan, resultPathPolicy: 'declared',
      jobs: plan.jobs.map(job => {
        const { lifecycleProtocol, ...legacy } = job;
        return { ...legacy, resultPathPolicy: 'declared', globalJobId: plan.id + ':' + job.index,
          attempt: 0, collectionResultCsv: 'outputs/' + plan.id + '/metrics.csv' };
      }) })) };
  }
  return { queue, now };
}
test('compiled Mac retry latest grouping does not discard a different case or space path', () => {
  const api = compiledQueue('darwin'), { queue, now } = queueFixture(api, true);
  const next = api.scheduleAutomaticJobRetries(queue, [], 'project', { now: now + 100, makeAttemptId: () => 'new' });
  assert.equal(next.plans.filter(plan => plan.automaticRetry?.enabledAt).length, files.length);
  assert.equal(queue.plans.some(plan => plan.automaticRetry), false);
  const excluded = api.scheduleAutomaticJobRetries(queue, [], 'project', { now: now + 100,
    excludedPlanFiles: [files[1]], makeAttemptId: () => 'new' });
  assert.equal(excluded.plans[1].automaticRetry, undefined);
  assert.ok(excluded.plans[0].automaticRetry);
});

test('compiled Mac manual retry targets only the exact selected Plan', () => {
  const api = compiledQueue('darwin'), { queue } = queueFixture(api);
  files.forEach((file, index) => {
    const targets = api.distributedStopTargets(queue, file);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].planId, 'run-' + index);
    assert.equal(targets[0].commandId, 'cmd-' + index);
  });
  assert.equal(queue.plans.every(plan => plan.jobs[0].status === 'running'), true);
});

test('Windows legacy aliases remain available', () => {
  const backend = host('win32'), queue = compiledQueue('win32'), ui = panel('win32');
  assert.equal(backend.samePlanSelection('Experiments\\Plans\\A.YAML', 'a'), true);
  assert.equal(queue.sameDistributedPlanFile('C:/project/plans/A.yaml', 'plans/a.yaml'), true);
  assert.equal(ui.samePlanSelection('Experiments\\Plans\\A.YAML', 'a'), true);
});

test('current protocol-2 jobs never enter the retired automatic retry state machine', () => {
  const api = compiledQueue('darwin'), { queue, now } = queueFixture(api);
  assert.ok(queue.plans.every(plan => plan.jobs.every(job => job.lifecycleProtocol === 2)));
  const next = api.scheduleAutomaticJobRetries(queue, [], 'project', { now: now + 100, makeAttemptId: () => { throw Error('must not schedule a retry'); } });
  assert.equal(next, queue);
  assert.ok(next.plans.every(plan => !plan.automaticRetry && plan.jobs.every(job => !job.automaticRetry)));
});
