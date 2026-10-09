const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const scope = require('../../dist/mac/ResultSummaryScope'), posix = require('../../dist/mac/PosixPath');
const plans = [' A.yaml ', 'A.yaml', 'a.yaml', 'A%20.yaml', 'é.yaml', 'e\u0301.yaml'].map(name => 'experiments/Plans 中文 /' + name);
const file = ' Results/中文 A /Metrics.csv ', hash = 'a'.repeat(64);
function backend(platform = 'darwin') {
  const source = fs.readFileSync(path.join(root, 'dist/extension/legacy.js'), 'utf8');
  const ast = ts.createSourceFile('actual.js', source, ts.ScriptTarget.Latest, true), functions = new Map();
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast)); ts.forEachChild(node, visit); }
  visit(ast);
  const names = ['normalizePlanSelectionKey', 'planFileEquivalenceKeys', 'samePlanSelection', 'usableSelectionKey',
    'resultRecordPlanFile', 'planVersionTimestamp', 'resultSummaryMatchesPlanVersion', 'filterResultsSummaryForSelectedPlan',
    'filterCompletedResultSummaryForPlan', 'resultSummaryInspectionCandidates', 'resultSummarySyncCandidates',
    'normalizeRemoteResultInspectionPath', 'compactResultsSummaryForPlanForWebview'];
  const context = vm.createContext({ process: { platform }, MacResultSummaryScope: scope, PosixPath_1: posix,
    FileTransferTypes_1: require('../../dist/tunnel/FileTransferTypes'),
    WrapperResultBundle: require('../../dist/results/WrapperResultBundle'),
    normalizePosixRelativePath: posix.normalizePosixRelativePath,
    objectRecord: value => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
    uniqueStrings: values => [...new Set(values.filter(Boolean))],
    RESULT_SUMMARY_RECORD_ARRAY_FIELDS: new Set(['results', 'finalResults', 'final_results', 'pendingReviewRecords', 'pending_review_records']),
    RESULTS_SUMMARY_WEBVIEW_VARIANT_CACHE_LIMIT: 8, resultsSummaryForWebviewCache: new WeakMap(),
    compactResultsSummaryForWebview: value => value,
  });
  vm.runInContext(names.map(name => { assert.ok(functions.has(name), name); return functions.get(name); }).join('\n') +
    '\nthis.api = {' + names.join(',') + '};', context);
  return context.api;
}
const api = backend(), array = value => Array.from(value);
function summary(planFile = plans[0]) {
  return { planFile, planRevision: 'r1', completedRunId: 'run', rawResultCsvPath: file,
    metricSizes: { [file]: 100 }, metricHashes: { [file]: hash },
    workerResultTables: [{ workerId: 'Worker', rawResultCsvPath: file, metricPaths: [file],
      metricSizes: { [file]: 100 }, metricHashes: { [file]: hash } }],
    results: [{ id: 'own', finalEvidenceState: 'archived', provenance: { plan_file: planFile } }] };
}
test('real compiled result scope preserves exact Plan/paths and reuses a fully consistent summary', () => {
  for (const plan of plans) {
    const original = summary(plan);
    assert.equal(scope.scopeMacResultSummary(original, plan), original);
    assert.equal(api.filterCompletedResultSummaryForPlan(original, plan), original);
    assert.equal(api.filterResultsSummaryForSelectedPlan(original, plan, 'r1'), original);
    assert.deepEqual(array(api.resultSummaryInspectionCandidates(original, plan)), [file]);
    const transfers = array(api.resultSummarySyncCandidates(original, plan));
    assert.equal(transfers.length, 1); assert.equal(transfers[0].remotePath, file);
    assert.equal(transfers[0].workerId, 'Worker'); assert.equal(transfers[0].sha256, hash); assert.equal(transfers[0].bytes, 100);
    for (const other of plans.filter(value => value !== plan)) {
      assert.deepEqual(array(api.resultSummaryInspectionCandidates(original, other)), []);
      assert.deepEqual(array(api.resultSummarySyncCandidates(original, other)), []);
      const filtered = api.filterCompletedResultSummaryForPlan(original, other);
      assert.equal(filtered.rawResultCsvPath, undefined); assert.equal(filtered.results.length, 0);
    }
  }
});
test('explicit alias conflicts, bad types and repaired paths never authorize result artifacts', () => {
  const invalid = [null, 4, [], {}, './' + plans[0], plans[0].replaceAll('/', '\\'), 'a//b.yaml', 'a/../b.yaml', '/a.yaml', 'a\0.yaml'];
  for (const value of invalid) {
    const original = { ...summary(), plan_file: value };
    assert.deepEqual(array(api.resultSummaryInspectionCandidates(original, plans[0])), []);
    assert.deepEqual(array(api.resultSummarySyncCandidates(original, plans[0])), []);
    const filtered = api.filterCompletedResultSummaryForPlan(original, plans[0]);
    assert.equal(filtered.rawResultCsvPath, undefined); assert.equal(filtered.workerResultTables.length, 0);
    const badSelection = api.filterResultsSummaryForSelectedPlan(summary(), value);
    assert.equal(badSelection.rawResultCsvPath, undefined); assert.equal(badSelection.results.length, 0);
  }
  const conflict = { ...summary(), plan_file: plans[1] };
  assert.equal(scope.scopeMacResultSummary(conflict, plans[0]).resultCount, 0);
  assert.equal(scope.scopeMacResultSummary({ ...summary(), plan_file: plans[0] }, plans[0]).rawResultCsvPath, file);
});
test('anonymous aggregate paths stay unauthorized while explicitly scoped rows and Worker tables survive', () => {
  const original = summary(); delete original.planFile;
  original.workerResultTables[0].plan_file = plans[0];
  original.results.push({ id: 'anonymous' }, { id: 'foreign', planFile: plans[1] });
  const filtered = api.filterCompletedResultSummaryForPlan(original, plans[0]);
  assert.deepEqual(filtered.results.map(row => row.id), ['own']);
  assert.equal(filtered.rawResultCsvPath, undefined); assert.equal(filtered.workerResultTables.length, 1);
  assert.deepEqual(array(api.resultSummaryInspectionCandidates(original, plans[0])), [file]);
  delete original.workerResultTables[0].plan_file;
  assert.deepEqual(array(api.resultSummaryInspectionCandidates(original, plans[0])), []);
  assert.deepEqual(array(api.resultSummarySyncCandidates(original, plans[0])), []);
});
test('contradictory records, provenance, nested datasets and completed jobs cannot lend paths or hash hints', () => {
  for (const table of [
    { planFile: plans[1] }, { planFile: plans[0], plan_file: plans[1] },
    { provenance: { plan_file: plans[1] } }, { completedJob: { planFile: plans[1] } },
    { datasetResultTables: [{ planFile: plans[1], rawResultCsvPath: file }] },
    { datasetResultTables: {} },
  ]) {
    const original = summary(); Object.assign(original.workerResultTables[0], table);
    original.results.push({ id: 'conflict', planFile: plans[0], provenance: { plan_file: plans[1] } });
    const filtered = api.filterCompletedResultSummaryForPlan(original, plans[0]);
    assert.deepEqual(filtered.results.map(row => row.id), ['own']); assert.equal(filtered.workerResultTables.length, 0);
    assert.equal(filtered.rawResultCsvPath, undefined);
    assert.deepEqual(array(api.resultSummaryInspectionCandidates(original, plans[0])), []);
    assert.deepEqual(array(api.resultSummarySyncCandidates(original, plans[0])), []);
  }
  const own = summary(); own.datasetResultTables = [{ planFile: plans[0], rawResultCsvPath: 'Results/Own.csv' },
    { planFile: plans[1], rawResultCsvPath: 'Results/Foreign.csv' }];
  assert.deepEqual(array(api.resultSummaryInspectionCandidates(own, plans[0])).sort(), [file, 'Results/Own.csv'].sort());
});
test('malformed containers and foreign claim evidence suppress aggregate authorization without mutating input', () => {
  for (const extra of [{ workerResultTables: {} }, { results: {} }, { claimEvidence: { planFile: plans[1], path: file } },
    { claimEvidence: { claims: [{ planFile: plans[1] }], path: file } }]) {
    const original = { ...summary(), ...extra }, before = JSON.stringify(original);
    const filtered = scope.scopeMacResultSummary(original, plans[0]);
    assert.equal(filtered.claimEvidence, undefined); assert.equal(filtered.rawResultCsvPath, undefined);
    assert.equal(JSON.stringify(original), before);
  }
  const original = { finalResults: [{ planFile: plans[0], finalEvidenceState: 'archived' }],
    pendingReviewRecords: [{ plan_file: plans[0] }, { planFile: plans[1] }] };
  const filtered = scope.scopeMacResultSummary(original, plans[0]);
  assert.equal(filtered.resultCount, 2); assert.equal(filtered.finalResultCount, 1); assert.equal(filtered.pendingReviewCount, 1);
  const catalog = { ...summary(), claimEvidence: { path: file, catalog: ['accuracy', 'AUC'], claims: [{ planFile: plans[0] }] } };
  assert.equal(scope.scopeMacResultSummary(catalog, plans[0]), catalog);
});
test('actual Mac webview cache preserves spaces and separate variants, and stale revisions remain hidden', () => {
  const original = summary();
  const first = api.compactResultsSummaryForPlanForWebview(original, plans[0], 'r1');
  assert.equal(api.compactResultsSummaryForPlanForWebview(original, plans[0], 'r1'), first);
  const other = api.compactResultsSummaryForPlanForWebview(original, plans[0].trim(), 'r1');
  assert.notEqual(other, first); assert.equal(other.resultCount, 0);
  assert.equal(api.compactResultsSummaryForPlanForWebview(original, plans[0], 'r2').resultCount, 0);
  assert.equal(api.compactResultsSummaryForPlanForWebview(original, plans[0], 'r1'), first);
  // Both keys collided under joining with |; full tuple encoding is required.
  const mixed = { results: [] };
  const a = api.compactResultsSummaryForPlanForWebview(mixed, 'plans/A|r.yaml', 'v');
  const b = api.compactResultsSummaryForPlanForWebview(mixed, 'plans/A', 'r.yaml|v');
  assert.notEqual(a, b); assert.equal(a.planFile, 'plans/A|r.yaml'); assert.equal(b.planFile, 'plans/A');
});
test('non-Mac compiled summary filtering retains Windows selection aliases', () => {
  const windows = backend('win32');
  const original = summary('experiments/plans/a.yaml');
  assert.equal(windows.filterCompletedResultSummaryForPlan(original, 'a.yaml').results.length, 1);
  assert.ok(windows.resultSummaryInspectionCandidates(original, 'a.yaml').includes(file.trim()));
});
