const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const Queue = require('../../dist/features/DistributedPlanQueue');
const Policy = require('../../dist/features/DistributedSchedulingPolicy');
const Freshness = require('../../dist/results/PlanRunFreshness');
const Wrapper = require('../../dist/results/WrapperResultBundle');
const Sync = require('../../dist/features/PlanArtifactSyncStatus');

function plan() { return { projectId: 'project', planFile: 'experiments/plans/formal.yaml', revision: 'revision',
  codeFingerprint: 'code', executionMode: 'train_test', jobs: [42,43,44].map((seed,index) => ({ index, case: 'case', seed,
    outputDir: `work_dirs/formal/case/seed${seed}`, collectionResultCsv: `tmp/result/formal/case/seed${seed}/metrics.csv` })) }; }
const workers = [0,1,2].map(index => ({ workerId: 'worker'+index, online: true, idleGpuIds: ['0'],
  codeFingerprint: 'code', declaredJobPaths: true, idleGpuAdmission: true, weight: 1 }));

test('real Scheduler and Agent message admission, writer conflicts, checkpoint hashes and read-only preflight', () => {
  const adapterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-formal-adapter-'));
  const adapter = path.join(adapterDir, 'writer_fixture.py');
  fs.writeFileSync(adapter, require('../../dist/templates/ProjectAdapterTemplates').outputAdapterTemplate('fixture'), 'utf8');
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B','-X','utf8', path.join(__dirname,'formalJobExecution.fixture.py'), adapter],
    { cwd: path.join(__dirname,'../..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  assert.equal(JSON.parse(proc.stdout.trim()).ok, true);
});

test('arbitrary recorded CLI commands cannot bypass formal PLAN admission in a research project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-formal-cli-'));
  fs.mkdirSync(path.join(root, 'experiments/plans'), { recursive: true });
  assert.throws(() => require('../../dist/features/ExperimentRunner').runRecordedExperiment({ cwd: root, name: 'fixture',
    command: ['must-never-start'] }), /FORMAL_PLAN_REQUIRED/);
  assert.equal(fs.existsSync(path.join(root, 'experiments/runs')), false);
  const registryOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-formal-registry-'));
  fs.mkdirSync(path.join(registryOnly, 'experiments'));
  fs.writeFileSync(path.join(registryOnly, 'experiments/results_fixture.csv'), 'metric,value\n', 'utf8');
  assert.throws(() => require('../../dist/features/ExperimentRunner').runRecordedExperiment({ cwd: registryOnly,
    name: 'fixture', command: ['must-never-start'] }), /FORMAL_PLAN_REQUIRED/);
});

test('formal output review never offers the legacy new-attempt or overwrite rerun choices', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../dist/extension/legacy.js'), 'utf8');
  const start = source.indexOf('    async confirmPlanExistingOutputsFromValidation(');
  const end = source.indexOf('    async confirmPlanRunSubmission(', start);
  const owner = Function('vscode', 'return {'+source.slice(start,end)+'}')({window:{showWarningMessage(){throw Error('legacy dialog opened');}}});
  await assert.rejects(owner.confirmPlanExistingOutputsFromValidation({}, {}, {result_path_policy:'declared', existing:[{output_dir:'work_dirs/formal/case/seed42'}]}), /FORMAL_JOB_CONFLICT.*[\s\S]*work_dirs\/formal\/case\/seed42/);
  await assert.rejects(owner.confirmPlanExistingOutputsFromValidation({}, {overwrite:true}, {result_path_policy:'declared', existing:[]}), /FORMAL_JOB_CONFLICT/);
  await owner.confirmPlanExistingOutputsFromValidation({}, {}, {result_path_policy:'declared', existing:[]});
});

test('formal three-seed queue persists stable paths, requires new Worker protocol and rejects duplicate writers', () => {
  const queue = Queue.enqueuePlan(Queue.emptyDistributedQueue(), plan(), 'workflow-formal');
  assert.equal(queue.plans[0].resultPathPolicy, 'declared');
  assert.equal(new Set(queue.plans[0].jobs.map(job => job.outputDir)).size, 3);
  assert.ok(queue.plans[0].jobs.every(job => job.attempt === 0 && job.globalJobId === `workflow-formal:${job.index}`
    && !job.outputDir.includes('attempts')));
  assert.equal(Queue.enqueuePlan(queue, plan(), 'workflow-formal'), queue);
  assert.throws(() => Queue.enqueuePlan(queue, {...plan(), revision:'other'}, 'workflow-formal'), /IDENTITY_CONFLICT/);
  const shared = plan(); shared.jobs[1].collectionResultCsv = shared.jobs[0].collectionResultCsv;
  assert.throws(() => Queue.enqueuePlan(Queue.emptyDistributedQueue(),shared,'shared'), /FORMAL_JOB_CONFLICT/);
  const saved = Queue.serializeDistributedQueue(queue);
  assert.ok(JSON.parse(saved).plans[0].jobs.every(job => !Object.hasOwn(job,'attempt')));
  assert.deepEqual(Queue.restoreFormalJobQueue(JSON.parse(saved)),queue);
  assert.throws(() => Queue.enqueuePlan(queue, plan(), 'workflow-other'), /FORMAL_JOB_CONFLICT/);
  assert.equal(Queue.allocateAvailable(queue, workers.map(row => ({...row,declaredJobPaths: false}))).dispatches.length, 0);
  const dispatched = Queue.allocateAvailable(JSON.parse(JSON.stringify(queue)), workers);
  assert.equal(dispatched.dispatches.length, 3);
  assert.deepEqual(dispatched.queue.plans[0].jobs.map(job => job.outputDir), queue.plans[0].jobs.map(job => job.outputDir));
  const dispatchedPlan = dispatched.queue.plans[0], job = dispatchedPlan.jobs[0];
  const receipt = { projectId: dispatchedPlan.projectId, workflowId: dispatchedPlan.id, planFile: dispatchedPlan.planFile,
    planRevision: dispatchedPlan.revision, codeFingerprint: dispatchedPlan.codeFingerprint, experimentIndex: job.index,
    case: job.case, seed: job.seed, outputDir: job.outputDir, resultPathPolicy: 'declared', globalJobId: job.globalJobId,
    workerId: job.workerId, gpuId: job.gpuId, commandId: job.commandId, targetCommandId: job.commandId,
    runKey: job.commandId, planJobCount: dispatchedPlan.planJobCount, durableAccepted: true, durableReleased: true,
    neverStarted: true, neverStartedEvidence: 'durable_queued_row', status: 'cancelled', stopReason: 'requeue' };
  assert.equal(Queue.remoteTaskMatchesJob(dispatchedPlan, job, receipt), true);
  assert.equal(Queue.stopIdentityMatchesJob(dispatchedPlan, job, receipt), true);
  assert.equal(Queue.isExactQueuedReleaseProof(dispatchedPlan, job, receipt), true);
  const hosted = { ...queue, plans: queue.plans.map(row => ({...row,schedulingMode:'server_prequeue'})) };
  assert.equal(Policy.allocateServerPrequeue(hosted, workers).dispatches.length, 3);
  assert.equal(Policy.allocateServerPrequeue(hosted, workers.map(row => ({...row,declaredJobPaths: false}))).dispatches.length, 0);
});

test('explicit retry preserves formal path and global identity; historical attempts cannot be resumed or minted', () => {
  let queue = Queue.enqueuePlan(Queue.emptyDistributedQueue(), plan(), 'workflow-formal');
  queue.plans[0].jobs[0].status = 'failed';
  const previous = queue.plans[0].jobs[0];
  const retried = Queue.retryVerifiedJob(queue, 'workflow-formal', 0, 'job-command-retry').plans[0].jobs[0];
  assert.equal(retried.outputDir, previous.outputDir);
  assert.equal(retried.globalJobId, previous.globalJobId);
  assert.equal(retried.attempt, 0);
  assert.equal(Queue.durableCommandId(queue.plans[0], retried, 'worker0', '0'), 'job-command-retry');
  const legacy = {...queue.plans[0],id:'historical',resultPathPolicy:undefined,jobs:[{...previous,attempt:1,outputDir:'work_dirs/old/attempts/historical'}]};
  const bytes = JSON.stringify(legacy);
  assert.throws(() => Queue.retryVerifiedJob({schemaVersion:1,plans:[legacy]}, legacy.id,0,'job-command-retry'), /HISTORICAL_ATTEMPT_READ_ONLY/);
  assert.throws(() => Queue.nextAttemptOutputDir(legacy.jobs[0].outputDir,'anything'), /HISTORICAL_ATTEMPT_READ_ONLY/);
  assert.equal(Queue.allocateAvailable({schemaVersion:1,plans:[legacy]}, workers).dispatches.length,0);
  assert.equal(Policy.allocateServerPrequeue({schemaVersion:1,plans:[{...legacy,schedulingMode:'server_prequeue'}]},workers).dispatches.length,0);
  assert.equal(JSON.stringify(legacy),bytes);
});

test('formal completion collector accepts exact declared CSV and retains SHA256 and cross-job refusal', () => {
  const queue = Queue.enqueuePlan(Queue.emptyDistributedQueue(), plan(), 'workflow-formal');
  const row = queue.plans[0];
  for (const job of row.jobs) Object.assign(job,{status:'completed',workerId:'worker0',commandId:`command-${job.index}`,
    artifacts:{[`${job.outputDir}/artifact_manifest.json`]:'a'.repeat(64)}});
  const selected = Freshness.selectLatestCompletePlanRun(queue,row.planFile,row.revision);
  assert.ok(selected);
  const job = {...selected.jobs[0],runId:row.id};
  const manifest = JSON.stringify({output_dir:job.outputDir,result_csv:job.collectionResultCsv});
  assert.ok(Wrapper.declaredWrapperResults(manifest,job.outputDir,job.collectionResultCsv).includes(job.collectionResultCsv));
  const csv = 'case,seed,metric,value,job_dir\ncase,42,accuracy,0.75,'+job.outputDir+'\n';
  const inputs = [{remotePath:job.collectionResultCsv,text:csv,sha256:Wrapper.resultHash(csv)},
    {remotePath:job.outputDir+'/artifact_manifest.json',text:manifest,sha256:Wrapper.resultHash(manifest)}];
  const owner = JSON.stringify({schemaVersion:1,state:'completed',workflowId:job.runId,globalJobId:job.globalJobId,
    commandId:job.commandId,index:job.index,case:job.case,seed:job.seed,outputDir:job.outputDir,
    planRevision:job.planRevision,codeFingerprint:job.codeFingerprint,collectionResultCsv:job.collectionResultCsv,
    sha256:Object.fromEntries(inputs.map(file=>[file.remotePath,file.sha256]))});
  inputs.push({remotePath:job.outputDir+'/formal_job_owner.json',text:owner,sha256:Wrapper.resultHash(owner)});
  const prepared = Wrapper.prepareWrapperJob(job,inputs,job.collectionResultCsv,inputs.map(file=>file.remotePath),file=>'results/raw/'+file);
  assert.ok(prepared);
  const publication = Wrapper.prepareWrapperPublication(row.id, [{case:job.case,seed:job.seed}], [prepared]);
  assert.equal(Object.hasOwn(Wrapper.wrapperSummaryJobs(publication)[0].job, 'attempt'), false);
  assert.throws(()=>Wrapper.prepareWrapperJob(job,[{...inputs[0],sha256:'0'.repeat(64)},inputs[1]],job.collectionResultCsv,[],file=>file),/SHA256/);
  assert.throws(()=>Wrapper.declaredWrapperResults(JSON.stringify({result_csv:'tmp/result/other.csv'}),job.outputDir,job.collectionResultCsv),/产物路径|作业目录/);
  assert.throws(()=>Wrapper.jobResultPath('/project/../'+job.collectionResultCsv,job.outputDir,job.collectionResultCsv),/路径不安全/);
  assert.throws(()=>Wrapper.prepareWrapperJob({...job,commandId:'another'},inputs,job.collectionResultCsv,[],file=>file),/OWNER_IDENTITY_CHANGED/);
  const changed = csv+'case,42,accuracy,0.5,'+job.outputDir+'\n';
  assert.throws(()=>Wrapper.prepareWrapperJob(job,[{...inputs[0],text:changed,sha256:Wrapper.resultHash(changed)},...inputs.slice(1)],job.collectionResultCsv,[],file=>file),/OWNER_SHA256_CHANGED/);
  const inventories = new Map([['worker0',Object.fromEntries(inputs.map(file=>[file.remotePath,file.sha256]))]]);
  const one = {...row,jobs:[{...row.jobs[0],artifacts:inventories.get('worker0')}]};
  assert.equal(Sync.assessPlanArtifactSync(one,['worker0'],inventories,['artifact_manifest.json']).status,'synced');
  const mirror = {...inventories.get('worker0')}; delete mirror[job.collectionResultCsv]; inventories.set('worker1',mirror);
  assert.equal(Sync.assessPlanArtifactSync(one,['worker0','worker1'],inventories,['artifact_manifest.json']).status,'partial');
});
