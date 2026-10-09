const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), ts = require('typescript');
const { createRequire } = require('node:module'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'), posix = require('../../dist/mac/PosixPath');
const planDir = 'experiments/Plans 中文 ';
const plans = ['A.yaml', 'a.yaml', ' A%20.yaml ', 'A .yaml', 'é.yaml', 'e\u0301.yaml'].map(name => planDir + '/' + name);
function compiled(relative, overrides = {}, platform = 'darwin') {
  const filename = path.join(root, relative), module = { exports: {} }, localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer,
    process: { platform }, require: id => Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id) }, { filename });
  return module.exports;
}
const layout = compiled('dist/results/ResultLayout.js');
const tables = compiled('dist/results/ProjectResultTables.js', { './ResultLayout': layout });
const freshness = compiled('dist/results/PlanRunFreshness.js');
function summary(planFile, dataset = '') {
  const source = ' work_dirs/中文 A /metrics.csv ';
  return { planFile, planRevision: 'revision', completedRunId: 'run', workerResultTables: [
    { workerId: 'worker', aggregateStatus: 'ready', rawResultCsvPath: source }], results: [
    { workerId: 'worker', runId: 'run', attempt: '1', sourceFiles: [{ path: source }],
      dimensions: { case: 'fixture', seed: 42, method: 'fixture', dataset }, metrics: { accuracy: 0.8 } }] };
}
function run(planFile, index = 0) {
  const id = 'run-' + index, outputDir = ' work_dirs/中文 A /attempts/' + id + '/ out ';
  return { planFile, revision: 'revision', codeFingerprint: 'code', id, planJobCount: 1,
    enqueuedAt: new Date(Date.UTC(2026, 9, 10, 0, index)).toISOString(), jobs: [
      { index: 0, case: 'fixture', seed: 42, attempt: 1, workerId: 'worker', commandId: 'command-' + index,
        outputDir, status: 'completed', artifacts: { [outputDir + '/指标.csv ']: 'a'.repeat(64) } }] };
}
function backend() {
  const filename = path.join(root, 'dist/extension/legacy.js'), source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true), functions = new Map(), methods = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
    if (ts.isMethodDeclaration(node)) methods.set(node.name.getText(ast), node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const notices = [], confirmations = [], store = new Map(), disk = { writes: 0 };
  const sandbox = vm.createContext({ Buffer, path, crypto, process: { platform: 'darwin' },
    normalizePosixRelativePath: posix.normalizePosixRelativePath, PosixPath_1: posix,
    MacPlanFiles_1: require('../../dist/mac/PlanFiles'), ProjectResultTables: tables,
    FileTransferTypes_1: require('../../dist/tunnel/FileTransferTypes'),
    WrapperResultBundle: require('../../dist/results/WrapperResultBundle'),
    workspaceRoot: () => '/Users/科研/项目 A ', planDirSafe: () => planDir,
    DEFAULT_RESULT_CSV_DIR: 'experiments/results', REMOTE_RESULT_INSPECTION_MAX_BYTES: 5 * 1024 * 1024,
    RESULT_ARTIFACT_MAX_BYTES: 128 * 1024 * 1024,
    safeWorkspaceChildPath: (root, relative) => root + '/' + relative,
    remoteResultInspectionCandidates: () => [' work_dirs/中文 A /指标.csv '],
    resultSummaryInspectionCandidates: () => [' work_dirs/中文 A /指标.csv '],
    fs: { stat: async () => undefined, mkdir: async () => { disk.writes++; } },
    UiCommandCancelled: class extends Error {},
    vscode: { workspace: { getConfiguration: () => ({ get: (_key, fallback) => sandbox.setting ?? fallback }) },
      window: { showErrorMessage: async (message, options) => { notices.push({ message, options }); },
        showWarningMessage: async message => { confirmations.push(message); }, showInformationMessage() {} } },
  });
  const names = ['normalizePlanSelectionKey', 'normalizeResultCsvDir', 'resultCsvDirSafe', 'normalizeRemoteResultInspectionPath',
    'remoteResultInspectionLocalRelativePath', 'methodResultArtifactLocalRelativePath', 'safePlanToken', 'stringField', 'canonicalResultPlanFile'];
  const memberNames = ['apiResolveSelectedPlan', 'notifyPlanFailureOnce', 'downloadRemoteResultFromUi', 'openResultArtifactFromUi'];
  vm.runInContext(names.map(name => { assert.ok(functions.has(name), name); return functions.get(name); }).join('\n') +
    '\nclass Subject { ' + memberNames.map(name => { assert.ok(methods.has(name), name); return methods.get(name); }).join('\n') +
    '\n}\nthis.Subject = Subject;', sandbox);
  const subject = new sandbox.Subject();
  Object.assign(subject, { isMacVariant: () => true, projectContextGeneration: 1, client: {},
    localPlanMetadata: { plans: plans.map(planFile => ({ planFile, planId: planFile })) },
    context: { workspaceState: { get: (key, fallback) => store.get(key) ?? fallback, update: async (key, value) => store.set(key, value) } },
    notifiedPlanFailures: new Set(), resolveSelectedPlanFile: value => value,
    refreshLocalPlanMetadataForAction: async () => {}, actionBody: value => value,
    planVersionForFile: () => ({ revision: 'revision' }),
    captureProjectContext: () => ({ root: '/Users/科研/项目 A ' }), projectContextIsCurrent: () => true,
    resultsSummary: { results: [], workerResultTables: [], rawResultCsvPath: ' work_dirs/中文 A /指标.csv ' },
    filterResultsSummaryForPlan: value => value, enabledWorkerConfigs: () => [{ id: 'worker' }],
    effectiveConnectionMode: () => 'manual', projectTopologyAssessment: () => ({ hubAllowed: true }),
    simpleSftpApiCall: async () => { throw Error('unexpected transfer'); }, openPanelAt: async () => {},
  });
  return { sandbox, subject, notices, confirmations, disk };
}

test('compiled Mac table mappings and registries keep full case, spaces, percent and Unicode Plan identities', () => {
  const mappings = Object.fromEntries(plans.map((name, index) => [name, { datasets: ['Data' + index] }]));
  let registry = tables.emptyTableRegistry();
  for (const name of plans) registry = tables.updateRegistry(registry, summary(name), name, 1, mappings);
  for (const [index, name] of plans.entries()) {
    assert.equal(tables.normalizePlanDatasetKey(name), name);
    assert.equal(registry.plans[name].records[0].dataset, 'Data' + index);
    assert.equal(tables.registeredPlanSummary(registry, name).planFile, name);
    assert.throws(() => tables.recordsForSummary(summary(name + ' '), name), /不匹配/);
  }
  const applied = tables.applyPlanDatasetOverrides({ ...registry, plans: Object.fromEntries(plans.map(name =>
    [name, { ...registry.plans[name], records: [{ ...registry.plans[name].records[0], dataset: '' }] }])) }, mappings);
  assert.deepEqual(plans.map(name => applied.plans[name].records[0].dataset), plans.map((_, index) => 'Data' + index));
  assert.equal(Object.keys(tables.buildTables(registry)).length, plans.length * 2);
  assert.throws(() => tables.recordsForSummary(summary('a\\b.yaml'), 'a\\b.yaml'));
});

test('compiled TS and actual generated Agent use the same distinct result Plan directory keys', () => {
  const keys = plans.map(layout.planDirectoryKey);
  assert.equal(new Set(keys.map(value => value.toLowerCase())).size, plans.length);
  const child = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8',
    path.join(__dirname, 'macResultIdentity.fixture.py'), path.join(root, 'dist/runtime/cluster_agent.py'), JSON.stringify(plans)],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.deepEqual(JSON.parse(child.stdout), { keys, remoteOperations: 0 });
  for (const name of ['./a.yaml', 'a//b.yaml', 'a/../b.yaml', 'a\\b.yaml', '/a.yaml', 'C:/a.yaml', 12])
    assert.throws(() => layout.planDirectoryKey(name));
  assert.equal(compiled('dist/results/ResultLayout.js', {}, 'win32').planDirectoryKey('./a.yaml'),
    compiled('dist/results/ResultLayout.js', {}, 'win32').planDirectoryKey('a.yaml'));
});

test('compiled completed-run selection never borrows another Mac Plan and preserves exact output/hash paths', () => {
  const queue = { plans: plans.map(run) };
  for (const [index, name] of plans.entries()) {
    const selected = freshness.selectLatestCompletePlanRun(queue, name, 'revision');
    assert.equal(selected.runId, 'run-' + index); assert.equal(selected.planFile, name);
    assert.equal(selected.jobs[0].outputDir, queue.plans[index].jobs[0].outputDir);
    assert.deepEqual(Object.keys(selected.jobs[0].artifactHashes), Object.keys(queue.plans[index].jobs[0].artifacts));
    assert.equal(freshness.hasExclusiveAttemptOutput(queue, selected, selected.jobs[0]), true);
    const foreign = run(plans[(index + 1) % plans.length], 99);
    foreign.jobs[0].outputDir = selected.jobs[0].outputDir;
    assert.equal(freshness.hasExclusiveAttemptOutput({ plans: [...queue.plans, foreign] }, selected, selected.jobs[0]), false);
  }
  for (const value of ['', [], 12, './a.yaml', 'a\\b.yaml']) assert.equal(freshness.selectLatestCompletePlanRun(queue, value), undefined);
  for (const value of ['a\\b', 'a//b', 'a/../b', '/a', 'a\x7f', 3]) {
    const invalid = run(plans[0]); invalid.jobs[0].outputDir = value;
    assert.equal(freshness.selectLatestCompletePlanRunIdentity({ plans: [invalid] }, plans[0]), undefined);
  }
  const invalid = run(plans[0]); invalid.jobs[0].artifacts = { 'a\\b.csv': 'a'.repeat(64) };
  assert.equal(freshness.selectLatestCompletePlanRun({ plans: [invalid] }, plans[0]), undefined);
});

test('compiled partial previews preserve the original Mac Plan and output without implicit aliases', () => {
  const pending = plans.map((name, index) => {
    const row = run(name, index); row.planJobCount = 2;
    row.jobs.push({ ...row.jobs[0], index: 1, seed: 43, status: 'running', commandId: 'pending-' + index });
    return row;
  });
  for (const [index, name] of plans.entries()) {
    const preview = freshness.selectLatestPlanRunPreview({ plans: pending }, name, 'revision');
    assert.equal(preview.runId, 'run-' + index); assert.equal(preview.jobs[0].outputDir, pending[index].jobs[0].outputDir);
  }
  assert.equal(freshness.selectLatestPlanRunPreview({ plans: pending }, './' + plans[0]), undefined);
});

test('actual compiled API, result canonical selection and settings reject wrong paths without a fallback', () => {
  const { sandbox, subject } = backend();
  for (const name of plans) {
    assert.equal(subject.apiResolveSelectedPlan({ planFile: name }).planFile, name);
    assert.equal(subject.apiResolveSelectedPlan({ planId: name }).planFile, name);
    assert.equal(sandbox.canonicalResultPlanFile(name), name);
  }
  assert.equal(subject.apiResolveSelectedPlan({ planFile: plans[2].trim() }), null);
  assert.equal(sandbox.canonicalResultPlanFile(planDir.toLowerCase() + '/A.yaml'), '');
  assert.equal(sandbox.canonicalResultPlanFile('experiments/plans/A.yaml'), '');
  for (const value of ['../a.yaml', './a.yaml', 12, []]) assert.throws(() => subject.apiResolveSelectedPlan({ planFile: value }));
  assert.throws(() => subject.apiResolveSelectedPlan({ planFile: plans[0], file: plans[1] }));
  assert.equal(sandbox.normalizeResultCsvDir(' experiments/结果 '), ' experiments/结果 ');
  sandbox.setting = 'experiments//results'; assert.throws(() => sandbox.resultCsvDirSafe());
});

test('actual compiled lightweight result inspection keeps exact names and distinct Plan copy directories', () => {
  const { sandbox } = backend(), file = ' work_dirs/中文 A /指标.csv ';
  assert.equal(sandbox.normalizeRemoteResultInspectionPath(file), file);
  for (const value of ['a\\b.csv', './a.csv', 'a//b.csv', '../a.csv', '/a.csv', 'a.pth ', 12])
    assert.equal(sandbox.normalizeRemoteResultInspectionPath(value), '');
  const targets = plans.map(name => sandbox.remoteResultInspectionLocalRelativePath(file, name, '2026-10-10T00:00:00Z'));
  assert.equal(new Set(targets.map(name => name.toLowerCase())).size, plans.length);
});

test('actual compiled UI result actions retain raw paths up to the user confirmation boundary', async () => {
  const { subject, confirmations, disk } = backend(), file = ' work_dirs/中文 A /指标.csv ';
  for (const method of ['downloadRemoteResultFromUi', 'openResultArtifactFromUi']) {
    await assert.rejects(subject[method]({ planFile: plans[2], remotePath: file }), /取消/);
    assert.equal(confirmations.at(-1).includes('远端来源：' + file), true);
    await assert.rejects(subject[method]({ planFile: plans[2], remotePath: file.trim() }), /不属于/);
  }
  assert.equal(confirmations.length, 2); assert.equal(disk.writes, 0);
});

test('actual compiled failure notifications keep distinct Plan identities and suppress only the same receipt', async () => {
  const { subject, notices } = backend();
  const state = { schedulerStates: [plans[2], plans[2].trim(), plans[0], plans[1]].map(planFile => ({
    planFile, operationId: 'same-operation', failed_experiments: [{ experiment_index: 0, error: 'mock failure' }] })) };
  await subject.notifyPlanFailureOnce(state);
  assert.equal(notices.length, 1); assert.equal(subject.notifiedPlanFailures.size, 4);
  for (const row of state.schedulerStates) assert.equal(notices[0].options.detail.includes(row.planFile), true);
  await subject.notifyPlanFailureOnce(state); assert.equal(notices.length, 1);
});
