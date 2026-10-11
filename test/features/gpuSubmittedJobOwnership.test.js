const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const original = require.extensions['.ts'];
require.extensions['.ts'] = (loaded, filename) => loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const ownership = require('../../src/features/GpuJobOwnership.ts');
const policy = require('../../src/features/DistributedSchedulingPolicy.ts');
require.extensions['.ts'] = original;
const now = Date.parse('2026-10-10T11:30:00Z');
const projectId = 'd:/gitrepo/multimodal';
function fixture() {
  const plan = { id: 'workflow-A', projectId, planFile: 'experiments/plans/tuning/same.yaml',
    revision: 'revision', codeFingerprint: 'fingerprint', planJobCount: 3, jobs: [] };
  for (let index = 0; index < 3; index++) plan.jobs.push({ index, case: 'case', seed: 42 + index,
    attempt: 1, workerId: 'w', gpuId: String(index), commandId: `issued-${index}`, runKey: `issued-${index}`,
    outputDir: `runs/${index}/attempts/workflow-A`, status: 'running', lastDispatchAttemptAt: new Date(now - 5000).toISOString() });
  const tasks = plan.jobs.map(job => ({ ...job, projectId, workflowId: plan.id, planFile: plan.planFile,
    planRevision: plan.revision, codeFingerprint: plan.codeFingerprint, experimentIndex: job.index,
    planJobCount: 3, configPath: `${job.outputDir}/job_config.yaml` }));
  const snapshot = { workerId: 'w', generatedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(),
    capabilities: { durablePlanQueue: true, schemaVersion: 1 }, tasks };
  const rows = tasks.map((task, index) => ({ index, utilizationPercent: 90, memoryUsedMb: 10000, processCount: 1,
    processes: [{ pid: 123 + index, user: 'shared', pluginManaged: true,
      command: `python train.py --config ${task.configPath} --output-dir ${task.outputDir} --case ${task.case} --seed ${task.seed}` }] }));
  rows.push({ index: 3, utilizationPercent: 90, memoryUsedMb: 10000, processCount: 1,
    processes: [{ pid: 999, user: 'shared', pluginManaged: true, submittedByThisClient: true,
      command: 'python train.py --plan-file experiments/plans/tuning/same.yaml --config runs/foreign/job_config.yaml --output-dir runs/foreign --case case --seed 42' }] });
  return { queue: { schemaVersion: 1, plans: [plan] }, snapshot, gpu: { w: rows } };
}
function project(f) {
  const index = ownership.submittedGpuJobs(f.queue, [f.snapshot], projectId, { w: '/server/zlk/MultiModal' }, now);
  return ownership.projectGpuOwnership(f.gpu, index);
}

test('four plugin jobs on a shared login contain only three locally issued jobs; foreign load stays visible', () => {
  const f = fixture();
  const next = project(f);
  assert.deepEqual(next.w.map(row => row.processes[0].submittedByThisClient), [true, true, true, false]);
  assert.deepEqual(next.w.map(row => row.processCount), [1, 1, 1, 1]);
  assert.equal(policy.prequeueGpuWeight(next.w, 5, 200, { currentUser: 'shared' }, 'shared', 3), 3);
  assert.equal(f.gpu.w[0].processes[0].submittedByThisClient, undefined, 'raw telemetry is immutable');
});

test('Plan similarity, shared usernames and remote-only recovered jobs cannot establish ownership', () => {
  const f = fixture();
  delete f.queue.plans[0].jobs[0].lastDispatchAttemptAt;
  f.snapshot.tasks[1].commandId = 'another-client-command';
  f.gpu.w[2].processes[0].command = f.gpu.w[2].processes[0].command.replace('runs/2/', 'runs/22/');
  assert.deepEqual(project(f).w.map(row => row.processes[0].submittedByThisClient), [false, false, false, false]);
});

test('restart and exact retry/reassignment identities survive; previous attempt does not own the new slot', () => {
  const f = JSON.parse(JSON.stringify(fixture()));
  const job = f.queue.plans[0].jobs[0];
  const task = f.snapshot.tasks[0];
  Object.assign(job, { attempt: 2, workerId: 'w2', commandId: 'retry-command', runKey: 'retry-command', outputDir: 'runs/0/attempts/distributed-attempt-new' });
  Object.assign(task, job, { configPath: `${job.outputDir}/job_config.yaml` });
  f.snapshot.tasks = [task]; f.snapshot.workerId = 'w2';
  const stale = f.gpu.w[0];
  f.gpu.w2 = [{ ...stale, processes: [{ ...stale.processes[0], command: `python train.py --config ${task.configPath} --output-dir ${task.outputDir} --case case --seed 42` }] }];
  const next = project(f);
  assert.equal(next.w2[0].processes[0].submittedByThisClient, true);
  assert.equal(next.w[0].processes[0].submittedByThisClient, false);
  assert.equal(next.w2[0].processes[0].submittedJobCommandId, 'retry-command');
});

test('fresh complete Worker receipts required for each job, with no GPU-only or stale-PID fallback', () => {
  for (const field of ['workflowId', 'projectId', 'outputDir', 'workerId', 'attempt', 'seed', 'codeFingerprint']) {
    const f = fixture(); f.snapshot.tasks[0][field] = 'wrong';
    assert.equal(project(f).w[0].processes[0].submittedByThisClient, false, field);
  }
  for (const alter of [f => { f.snapshot.error = 'offline'; }, f => { f.snapshot.generatedAt = new Date(now - 180001).toISOString(); },
    f => { f.snapshot.tasks.push({ ...f.snapshot.tasks[0] }); }, f => { f.snapshot.tasks[0].status = 'completed'; }]) {
    const f = fixture(); alter(f); assert.equal(project(f).w[0].processes[0].submittedByThisClient, false);
  }
});

test('new process identity handles arbitrary wrapper commands and rejects foreign command IDs or cwd', () => {
  const f = fixture(); const p = f.gpu.w[0].processes[0];
  Object.assign(p, { command: 'custom-executable opaque-arguments', jobCommandId: 'issued-0', jobProjectId: projectId, cwd: '/server/zlk/MultiModal' });
  assert.equal(project(f).w[0].processes[0].submittedByThisClient, true);
  p.jobCommandId = 'foreign'; assert.equal(project(f).w[0].processes[0].submittedByThisClient, false);
  p.jobCommandId = 'issued-0'; p.cwd = '/server/other/MultiModal';
  assert.equal(project(f).w[0].processes[0].submittedByThisClient, false);
});

test('legacy jobs match exact argv values, accepting quoted paths but rejecting prefix and duplicated options', () => {
  const f = fixture(); const p = f.gpu.w[0].processes[0];
  p.command = p.command.replace('--output-dir runs/0/attempts/workflow-A', '--output-dir="runs/0/attempts/workflow-A"');
  assert.equal(project(f).w[0].processes[0].submittedByThisClient, true);
  p.command += ' --output-dir foreign'; assert.equal(project(f).w[0].processes[0].submittedByThisClient, false);
  p.command = fixture().gpu.w[0].processes[0].command + ' --seed 43';
  assert.equal(project(f).w[0].processes[0].submittedByThisClient, false);
});

test('Host projection, payload compaction and Webview normalization preserve job ownership before command truncation', () => {
  const { readSource } = require('../_helpers/sourceReader');
  const extension = readSource('src/extension.ts');
  const ast = ts.createSourceFile('extension.ts', extension, ts.ScriptTarget.Latest, true);
  const names = ['compactMergedGpuForWebview','compactGpuForWebview','compactGpuRowForWebview', 'compactGpuProcessesForWebview',
    'gpuProcessEntries','compactGpuProcessForWebview','firstStringFieldForWebview','firstNumberFieldForWebview'];
  const code = names.map(name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast)).join('\n');
  const context = vm.createContext({ GpuJobOwnership: ownership, mergedGpuForWebviewCache: null, EMPTY_GPU_FOR_WEBVIEW_SOURCE: {},
    WEBVIEW_GPU_PROCESS_LIMIT: 10, WEBVIEW_GPU_PROCESS_COMMAND_LIMIT: 20, objectRecord: x => x && typeof x === 'object' ? x : undefined,
    compactSensitiveText: (x, n) => String(x).slice(0,n), dropUndefined: x => x, mergeFallbackRecords: (...x) => Object.assign({}, ...x) });
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const f = fixture();
  const index = ownership.submittedGpuJobs(f.queue, [f.snapshot], projectId, {}, now);
  const value = context.compactMergedGpuForWebview(null, null, f.gpu, null, index);
  assert.equal(value.w[0].processes[0].command.length, 20);
  assert.equal(value.w[0].processes[0].submittedByThisClient, true);
  assert.equal(context.compactMergedGpuForWebview(null, null, f.gpu, null, index), value);
  assert.equal(context.compactMergedGpuForWebview(null, null, f.gpu, null, new Map()).w[0].processes[0].submittedByThisClient, false);
  const panel = readSource('src/ui/PanelHtml.ts');
  const match = panel.match(/function normalizeGpuProcesses\(value\) \{([\s\S]*?)\n    \}/);
  assert.ok(match);
  const ui = vm.createContext({ asArray: x => Array.isArray(x) ? x : [], pick: (x, keys, fallback) => keys.map(k => x[k]).find(v => v !== undefined) ?? fallback });
  vm.runInContext(match[0], ui);
  assert.equal(ui.normalizeGpuProcesses(value.w[0].processes)[0].submittedByThisClient, true);
  assert.equal(ui.normalizeGpuProcesses(value.w[3].processes)[0].submittedByThisClient, false);
});
