const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
require('../_helpers/registerTsRequire');
function load(name, imports = {}) {
  const file = path.resolve(__dirname, "../../src/features/" + name + ".ts");
  const mod = new Module(file, module);
  mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  const original = mod.require.bind(mod);
  mod.require = key => imports[key] || original(key);
  mod._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
  return mod.exports;
}
const Q = load("DistributedPlanQueue");
const R = load("FailedJobRecovery", { "./DistributedPlanQueue": Q });
const root = "D:/project", server = { host: "example-worker", user: "researcher", port: 22, remotePath: "/srv/project" };
function fixture(mode = "train") {
  let queue = { schemaVersion: 1, plans: [{ id: "workflow-123456", projectId: Q.canonicalProjectId(root),
    planFile: "experiments/plans/comparison_tuning/cpsc.yaml", revision: "rev", codeFingerprint: "code",
    executionMode: mode, schedulingMode: "server_prequeue", enqueuedAt: new Date(0).toISOString(), planJobCount: 18,
    jobs: Array.from({ length: 18 }, (_, index) => ({ index, case: "case" + index, seed: 42, attempt: 1,
      status: index ? "completed" : "failed", workerId: "old-worker", commandId: "command-" + index,
      runKey: "command-" + index, gpuId: "1", outputDir: `work_dirs/cpsc/${index}/attempts/workflow-123456`,
      error: index ? undefined : "Agent restarted without pane" })) }] };
  let active = true, actions = [], stops = 0, ids = 0, snapshotError, capability = true, reply,
    snapshotStatus = "failed", waitCount = 0, context = { root };
  const original = structuredClone(queue.plans[0]);
  const proof = () => ({ projectId: original.projectId, workflowId: original.id, planFile: original.planFile,
    planRevision: original.revision, codeFingerprint: original.codeFingerprint, experimentIndex: 0,
    ...original.jobs[0] });
  const client = {
    getWorkerTasks: async () => { if (snapshotError) throw snapshotError;
      return { capabilities: { failedAttemptQuarantine: capability }, tasks: [{ ...proof(), status: snapshotStatus }] }; },
    postWorkerAction: async (worker, action, request) => { actions.push({ worker, action, request });
      return reply || { status: "accepted", operationId: request.opId }; },
  };
  const host = { client, distributedQueueGeneration: 0,
    captureProjectContext: () => context, projectContextIsCurrent: value => active && value === context,
    loadDistributedQueue: async () => structuredClone(queue),
    saveDistributedQueue: async (_, _unused, options) => { queue = options.mutateLatest(structuredClone(queue)); },
    workerCodeSyncTargets: () => [{ id: "old-worker" }], sftpServerOptions: () => server,
    detachStaleDistributedTick() {}, postState() {}, tickDistributedQueue: async () => {}, recordActionError() {},
    stopDistributedJobForClear: async (plan, job) => { assert.equal(plan.id, original.id); assert.equal(job.commandId, "command-0"); stops++; },
    withRemoteActionResource: async (_worker, _action, _request, callback) => callback(),
    waitForOperationTerminalResult: async (_, submitted) => { waitCount++; const row = queue.failedAttemptRecoveries[0];
      return { ...proof(), status: "completed", recoveryId: row.id, quarantined: true, absolutePath: row.absolutePath, destination: row.destination }; },
  };
  const message = { planId: original.id, planFile: original.planFile, jobIndex: 0, attempt: 1, commandId: "command-0" };
  return { host, message, original, actions, proof, id: kind => `${kind}-12345678-${++ids}`,
    get queue() { return queue; }, get stops() { return stops; }, get waitCount() { return waitCount; },
    setActive: value => active = value, offline: () => snapshotError = Error("offline"), online: () => snapshotError = undefined,
    capability: value => capability = value, reply: value => reply = value, snapshotStatus: value => snapshotStatus = value,
  };
}

test("offline historical recall preserves the original card, mode and every sibling without new attempts", async () => {
  for (const mode of ["train", "test", "train_test"]) {
    const f=fixture(mode),before=structuredClone(f.queue);f.offline();let confirmations=0;
    await assert.rejects(R.recallFailedJobFromUi(f.host,f.message,async()=>{confirmations++;return true;},f.id),/HISTORICAL_ATTEMPT_READ_ONLY/);
    assert.deepEqual(f.queue,before);assert.equal(f.queue.plans[0].executionMode,mode);
    assert.equal(f.queue.plans[0].schedulingMode,"server_prequeue");
    assert.deepEqual(f.queue.plans[0].jobs.slice(1),f.original.jobs.slice(1));
    assert.equal(f.queue.plans[0].jobs[0].attempt,1);assert.equal(f.queue.plans[0].jobs[0].commandId,"command-0");
    assert.equal(f.queue.failedAttemptRecoveries,undefined);assert.equal(confirmations,0);
    assert.equal(f.actions.length,0);assert.equal(f.stops,0);
  }
});
test("project changes and historical input cannot reach a confirmation, stop, cleanup or queue write", async () => {
  for (const changed of [false,true]) {
    const f=fixture(),before=structuredClone(f.queue);if(changed)f.setActive(false);
    f.host.saveDistributedQueue=async()=>{throw Error("unexpected queue write");};
    await assert.rejects(R.recallFailedJobFromUi(f.host,f.message,async()=>{throw Error("unexpected confirmation");},f.id),
      changed?/Plan context changed/:/HISTORICAL_ATTEMPT_READ_ONLY/);
    assert.deepEqual(f.queue,before);assert.equal(f.actions.length,0);assert.equal(f.stops,0);
  }
});
test("persisted historical cleanup obligations survive restart as manual review, never automatic recovery", async () => {
  const f=fixture();f.queue.failedAttemptRecoveries=[{id:"legacy-obligation",status:"pending",tries:0,job:f.proof()}];
  const before=structuredClone(f.queue);f.offline();
  for(const now of [1000,2000,32000,100000,200000]){
    const state=await R.processFailedAttemptRecoveries(f.host,root,f.id,now);
    assert.deepEqual(state,{status:"manual_review_required",automaticExecution:false});
  }
  assert.deepEqual(f.queue,before);assert.equal(f.actions.length,0);assert.equal(f.waitCount,0);assert.equal(f.stops,0);
});
test("background historical recovery never stops active originals or moves completed originals", async () => {
  for(const status of ["running","completed"]){
    const f=fixture();f.snapshotStatus(status);const before=structuredClone(f.queue);
    const state=await R.processFailedAttemptRecoveries(f.host,root,f.id,1000);
    assert.equal(state.automaticExecution,false);assert.deepEqual(f.queue,before);
    assert.equal(f.stops,0);assert.equal(f.actions.length,0);
  }
});
test("wrong receipts and changed server authorization never authorize historical cleanup", async () => {
  for(const patch of [{seed:43},{commandId:"another-job"},{status:"failed"}]){
    const f=fixture();f.reply({...f.proof(),status:"completed",quarantined:true,...patch});
    f.host.sftpServerOptions=()=>({...server,user:"other-user"});const before=structuredClone(f.queue);
    await R.processFailedAttemptRecoveries(f.host,root,f.id,1000);
    assert.deepEqual(f.queue,before);assert.equal(f.actions.length,0);assert.equal(f.waitCount,0);
  }
  assert.throws(()=>R.failedAttemptPaths("/srv/project","work_dirs/a/attempts/../escape"));
  assert.throws(()=>R.failedAttemptPaths("/srv/project","../escape"));
});
test("late historical receipts cannot replace a current declared job generation", async () => {
  const f=fixture(),current=JSON.parse(JSON.stringify(f.queue));current.plans[0].resultPathPolicy="declared";
  const job=current.plans[0].jobs[0];Object.assign(job,{attempt:0,outputDir:"work_dirs/cpsc/0",collectionResultCsv:"tmp/result/0.csv",lifecycleProtocol:2,status:"pending"});
  delete job.commandId;delete job.workerId;delete job.runKey;
  const before=structuredClone(job),at=new Date().toISOString();
  const merged=Q.mergeDurableWorkerSnapshots(current,[{workerId:"old-worker",capabilities:{durablePlanQueue:true},
    fetchedAt:at,generatedAt:at,tasks:[{...f.proof(),status:"failed"}]}],Q.canonicalProjectId(root));
  assert.equal(merged.plans.length,1);assert.deepEqual(merged.plans[0].jobs[0],before);
  assert.equal(merged.failedAttemptRecoveries,undefined);
});
test("declared recall delegates the exact original job message to the reviewed single-job host flow", async () => {
  const f=fixture();f.queue.plans[0].resultPathPolicy="declared";const before=structuredClone(f.queue),calls=[];
  const result={status:"blocked",code:"SOURCE_CHANGED_UNSUPPORTED"};
  f.host.retryDistributedJobFromUi=async message=>{calls.push(message);return result;};
  assert.equal(await R.recallFailedJobFromUi(f.host,f.message,async()=>{throw Error("duplicate confirmation");},f.id),result);
  assert.deepEqual(calls,[f.message]);assert.deepEqual(f.queue,before);assert.equal(f.actions.length,0);assert.equal(f.stops,0);
});

// Merged 2026-10-23 (integration-latest): 双方对同一失败作业恢复契约各自重写了回归，两套语义互补，均保留。
const Rc=require('../../src/features/FailedJobRecovery.ts');
function recallContractFixture(declared=false) {
  const queue={schemaVersion:1,plans:[{id:'workflow',projectId:'project',executionMode:'train',planFile:'plans/p.yaml',revision:'rev',codeFingerprint:'code',
    ...(declared?{resultPathPolicy:'declared'}:{}),jobs:[{index:0,status:'failed',commandId:'original',workerId:'worker',attempt:declared?0:1,
      outputDir:declared?'work_dirs/job':'work_dirs/job/attempts/legacy',error:'original failure'}]}]};
  const context={root:'D:/project'},calls=[];let current=true;
  const forbid=()=>assert.fail('legacy recovery must not query, write, stop or move');
  const host={captureProjectContext:()=>context,projectContextIsCurrent:()=>current,loadDistributedQueue:async()=>structuredClone(queue),
    saveDistributedQueue:forbid,client:{getWorkerTasks:forbid,postWorkerAction:forbid},stopDistributedJob:forbid,
    retryDistributedJobFromUi:async message=>{calls.push(message);return {manualReview:true};}};
  return {queue,host,calls,switchProject:()=>current=false};
}
test('historical failed attempts cannot be recalled, stopped, moved or assigned a new version',async()=>{
  for(const mode of ['train','test','train_test']) {const f=recallContractFixture();f.queue.plans[0].executionMode=mode;const before=structuredClone(f.queue);
    await assert.rejects(Rc.recallFailedJobFromUi(f.host,{planId:'workflow',jobIndex:0},()=>assert.fail('legacy cannot be confirmed'),()=>assert.fail('no new identity')),/HISTORICAL_ATTEMPT_READ_ONLY/);
    assert.deepEqual(f.queue,before);assert.equal(f.calls.length,0);}
});
test('declared-job recall delegates the exact selection to the existing manual retry and cleanup flow',async()=>{
  const f=recallContractFixture(true),message={planId:'workflow',jobIndex:0,commandId:'original',outputDir:'work_dirs/job'};const before=structuredClone(f.queue);
  assert.deepEqual(await Rc.recallFailedJobFromUi(f.host,message,()=>assert.fail('confirmation belongs to existing retry flow'),()=>assert.fail('no speculative identity')),{manualReview:true});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0],message);assert.deepEqual(f.queue,before);
});
test('a changed project cannot delegate or mutate a recall',async()=>{
  const f=recallContractFixture(true);f.switchProject();const before=structuredClone(f.queue);
  await assert.rejects(Rc.recallFailedJobFromUi(f.host,{planId:'workflow'},()=>true,()=>assert.fail()),/context changed/);assert.equal(f.calls.length,0);assert.deepEqual(f.queue,before);
});
test('an unknown workflow cannot target an unrelated failed job',async()=>{
  const f=recallContractFixture(true);await assert.rejects(Rc.recallFailedJobFromUi(f.host,{planId:'foreign'},()=>true,()=>assert.fail()),/context changed/);assert.equal(f.calls.length,0);
});
test('reloaded legacy remote obligations require manual review and never execute in the background',async()=>{
  const f=recallContractFixture();f.queue.failedAttemptRecoveries=[{id:'old-recovery',status:'pending',absolutePath:'/srv/project/work_dirs/job/attempts/legacy'}];
  const before=structuredClone(f.queue);for(const delay of [0,30000,600000])assert.deepEqual(await Rc.processFailedAttemptRecoveries(f.host,'D:/project',()=>assert.fail(),delay),{status:'manual_review_required',automaticExecution:false});
  assert.deepEqual(f.queue,before);assert.equal(f.calls.length,0);
});
test('late original receipts and changed server authorization cannot restart an old cleanup obligation',async()=>{
  for(const status of ['failed','running','completed','unknown']) {const f=recallContractFixture();f.queue.plans[0].jobs[0].status=status;
    f.queue.failedAttemptRecoveries=[{status:'pending',serverIdentity:'changed-server',job:{commandId:'original'}}];const before=structuredClone(f.queue);
    assert.equal((await Rc.processFailedAttemptRecoveries(f.host,'D:/project',()=>assert.fail())).automaticExecution,false);assert.deepEqual(f.queue,before);}
});
