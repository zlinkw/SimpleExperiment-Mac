const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const shared = require('../../dist/mac/ResultCandidatePath');
const posix = require('../../dist/mac/PosixPath');
const names = ['normalizeResultCandidatePath', 'normalizeOutputCandidateKey', 'dedupOutputCandidates',
  'compileResultCandidatePatterns', 'compiledResultCandidatesMatchFile', 'resultCandidatePatternMatchesFile',
  'planOutputCandidates', 'planOutputEvidenceCandidates', 'adapterRuleResultCandidates',
  'isParseableResultCandidate', 'planScopedResultParsePreviews'];
function subject(surface, platform = 'darwin') {
  let source;
  if (surface === 'panel') {
    const html = require('../../dist/ui/PanelHtml.legacy').renderPanelHtml(platform);
    source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])
      .find(text => text.includes('function normalizeResultCandidatePath('));
    assert.ok(source); new vm.Script(source);
    assert.ok(source.includes('const MAC_PLAN_IDENTITY = ' + String(platform === 'darwin')));
  } else source = fs.readFileSync(path.join(root, 'dist/extension/legacy.js'), 'utf8');
  const ast = ts.createSourceFile('actual.js', source, ts.ScriptTarget.Latest, true), functions = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const extra = surface === 'panel' ? ['normalizeMacResultCandidatePath', 'resultPreviewRegexEscape'] : [];
  const sandbox = vm.createContext({ path, process: { platform }, MAC_PLAN_IDENTITY: platform === 'darwin',
    ResultCandidatePath_1: shared, normalizeMacResultCandidatePath: shared.normalizeMacResultCandidatePath,
    PlanBuilder_1: { normalizeOutputCandidateKey: () => 'contract:old-fold' },
    OUTPUT_CANDIDATE_CONTRACT_BASENAMES: new Set(['metrics_summary.csv', 'metrics_case.csv', 'stdout.log', 'stderr.log']),
    RESULT_METADATA_FILENAMES: new Set(['jobs.csv', 'status.json', 'artifact_manifest.json']),
    RESULT_METADATA_SUFFIXES: ['_snapshot.json', '_manifest.json', '_status.json', '_state.json', '_progress.json'],
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]), EMPTY_OUTPUT_DERIVATION_SOURCE: Object.freeze({}),
    planOutputCandidatesCache: new WeakMap(), planOutputEvidenceCandidatesCache: new WeakMap(),
    adapterRuleResultCandidatesCache: new WeakMap(), planScopedResultCandidateCache: new WeakMap(),
    planScopedResultPreviewCache: new WeakMap(),
    asArray: value => Array.isArray(value) ? value : [],
    arrayFromRecord: (row, key) => Array.isArray(row?.[key]) ? row[key] : [],
    escapeRegExp: value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  });
  for (const name of [...extra, ...names]) assert.ok(functions.has(name), name);
  vm.runInContext([...extra, ...names].map(name => functions.get(name)).join('\n') +
    '\nthis.api = {' + names.join(',') + '};', sandbox);
  return sandbox.api;
}
const subjects = [subject('backend'), subject('panel')];
const files = ['Results/中文 A /Metrics.csv ', 'results/中文 A /Metrics.csv ',
  'Results/中文 A /metrics.csv ', 'Results/中文 A / Metrics%20.csv ', 'Results/中文 A /é.csv', 'Results/中文 A /e\u0301.csv'];

test('compiled backend and real rendered Mac panel retain typed POSIX candidates with the same UTF8 bounds', () => {
  for (const api of subjects) {
    for (const file of [...files, 'a'.repeat(4096)]) {
      assert.equal(api.normalizeResultCandidatePath(file), file);
      assert.equal(posix.normalizePosixRelativePath(file), file);
    }
    for (const file of ['', 4, [], {}, '/a.csv', 'a\\b.csv', './a.csv', 'a//b.csv', 'a/../b.csv',
      'a:b.csv', 'a\n.csv', 'a\x7f.csv', '中'.repeat(1366), '😀'.repeat(1025)])
      assert.equal(api.normalizeResultCandidatePath(file), '');
  }
});

test('Mac candidate keys and declared lists never fold case, edge spaces, percent or Unicode spellings', () => {
  for (const api of subjects) {
    const input = [...files, files[0], '../wrong.csv', 7];
    assert.deepEqual(Array.from(api.dedupOutputCandidates(input)), files);
    assert.equal(new Set(files.map(api.normalizeOutputCandidateKey)).size, files.length);
    assert.notEqual(api.normalizeOutputCandidateKey('a/metrics_summary.csv'), api.normalizeOutputCandidateKey('b/metrics_summary.csv'));
    const plan = { outputCandidates: input }, rules = { candidateCsv: input };
    assert.deepEqual(Array.from(api.planOutputEvidenceCandidates(plan)), files);
    assert.deepEqual(Array.from(api.adapterRuleResultCandidates(rules)), files);
    assert.equal(api.planOutputCandidates(plan), api.planOutputCandidates(plan), 'same object reuses its cached list');
    assert.equal(api.isParseableResultCandidate('jobs.csv '), false);
  }
});

test('Mac exact paths and declared basename patterns are case sensitive and reject another directory contract alias', () => {
  for (const api of subjects) {
    for (const file of files) {
      const compiled = api.compileResultCandidatePatterns([file], {});
      assert.equal(api.compiledResultCandidatesMatchFile(compiled, file), true);
      for (const other of files.filter(value => value !== file)) assert.equal(api.compiledResultCandidatesMatchFile(compiled, other), false);
      assert.equal(api.compiledResultCandidatesMatchFile(compiled, file.trim()), file === file.trim());
    }
    assert.equal(api.resultCandidatePatternMatchesFile('work_dirs/A/metrics_summary.csv', 'work_dirs/B/metrics_summary.csv', {}), false);
    assert.equal(api.resultCandidatePatternMatchesFile('Metrics.csv ', 'other/Metrics.csv ', {}), true);
    assert.equal(api.resultCandidatePatternMatchesFile('Metrics.csv ', 'other/metrics.csv ', {}), false);
  }
});

test('Mac wildcard and placeholder matching retains full Plan/suite spelling without matching another case', () => {
  for (const api of subjects) {
    const plan = { suite: ' Suite 中文 ', planFile: 'experiments/Plans 中文 / A%20.yaml ' };
    for (const [candidate, target] of [
      ['Results/{suite}/{seed}/Metrics.csv ', 'Results/ Suite 中文 /42/Metrics.csv '],
      ['{output_dir}/Metrics.csv ', 'work_dirs/A/attempts/run/out/Metrics.csv '],
      ['Results/{plan_file}/Metrics.csv ', 'Results/experiments/Plans 中文 / A%20.yaml /Metrics.csv '],
      ['Results/**/指标?.json', 'Results/中文/A/指标1.json'],
    ]) {
      assert.equal(api.resultCandidatePatternMatchesFile(candidate, target, plan), true);
      assert.equal(api.resultCandidatePatternMatchesFile(candidate, target.replace('Results', 'results').replace('Metrics', 'metrics'), plan), false);
    }
    assert.equal(api.resultCandidatePatternMatchesFile('a//*.csv', 'a/1.csv', plan), false);
  }
});

test('real panel and compiled backend preview scopes filter the same exact files and preserve bounded cache behavior', () => {
  const previews = [...files, 'Other/Metrics.csv '].map(file => ({ file, parseable: true, rows: 1 }));
  const plan = { planFile: 'experiments/plans/A.yaml', outputCandidates: [files[0]] };
  const rules = { candidateCsv: [files[4]] };
  for (const api of subjects) {
    const first = api.planScopedResultParsePreviews(previews, plan, rules);
    assert.deepEqual(Array.from(first.items, row => row.file), [files[0], files[4]]);
    assert.equal(first.hiddenCount, previews.length - 2); assert.equal(first.candidateCount, 2);
    assert.equal(api.planScopedResultParsePreviews(previews, plan, rules), first);
    const changed = { ...plan, outputCandidates: [files[1]] };
    assert.deepEqual(Array.from(api.planScopedResultParsePreviews(previews, changed, rules).items, row => row.file), [files[1], files[4]]);
  }
});

test('non-Mac rendered candidates retain the original Windows contract folding and case-insensitive matcher', () => {
  const api = subject('panel', 'win32');
  assert.equal(api.normalizeOutputCandidateKey('a/metrics_summary.csv'), api.normalizeOutputCandidateKey('b/METRICS_SUMMARY.csv'));
  assert.equal(api.resultCandidatePatternMatchesFile('Results/*.csv', 'results/A.CSV', {}), true);
  assert.equal(api.normalizeResultCandidatePath(' ./a\\b.csv '), 'a/b.csv');
});
