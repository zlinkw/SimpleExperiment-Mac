const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
function planReader(platform) {
  const file = path.join(root, 'dist/features/PlanBuilder.legacy.js');
  const exports = {};
  const context = { exports, module: { exports }, require: createRequire(file), process: { platform }, console };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.module.exports;
}
const mac = planReader('darwin'), windows = planReader('win32');
const array = value => Array.from(value);
const literals = [' Results/中文 A /Metrics.csv ', ' Results/中文 A /metrics.csv ',
  'Results/中文 A /Metrics.csv ', 'Results/中文 A /é.csv', 'Results/中文 A /e\u0301.csv',
  'Results/中文 A /%20.csv', 'other/metrics_summary.csv', 'another/metrics_summary.csv'];
function matcher(surface) {
  const source = surface === 'panel'
    ? [...require('../../dist/ui/PanelHtml.legacy').renderPanelHtml('darwin').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
      .map(match => match[1]).find(text => text.includes('function compileResultCandidatePatterns('))
    : fs.readFileSync(path.join(root, 'dist/extension/legacy.js'), 'utf8');
  if (surface === 'panel') new vm.Script(source);
  const ast = ts.createSourceFile('actual.js', source, ts.ScriptTarget.Latest, true), functions = new Map();
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast)); ts.forEachChild(node, visit); }
  visit(ast);
  const names = ['normalizeResultCandidatePath', 'normalizeOutputCandidateKey', 'compileResultCandidatePatterns',
    'compiledResultCandidatesMatchFile', 'resultCandidatePatternMatchesFile'];
  if (surface === 'panel') names.push('normalizeMacResultCandidatePath', 'resultPreviewRegexEscape');
  const shared = require('../../dist/mac/ResultCandidatePath');
  const context = vm.createContext({ process: { platform: 'darwin' }, MAC_PLAN_IDENTITY: true, path,
    ResultCandidatePath_1: shared, PlanBuilder_1: mac, asArray: value => Array.isArray(value) ? value : [],
    escapeRegExp: value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  });
  vm.runInContext(names.map(name => { assert.ok(functions.has(name), name); return functions.get(name); }).join('\n') +
    '\nthis.match = resultCandidatePatternMatchesFile;', context);
  return context.match;
}

test('actual compiled Mac Plan reader preserves quoted paths across direct fields and summary signals', () => {
  const yaml = ['suite: demo', 'runner: {test_command: python test.py}', ...literals.map(value => 'result_csv: ' + JSON.stringify(value))].join('\n');
  for (const reader of [mac.parsePlanOutputEvidence, mac.parsePlanSummary]) {
    const evidence = reader(yaml);
    assert.deepEqual(array(evidence.outputCandidates), literals);
    for (const value of literals) assert.ok(evidence.outputSignals.includes('结果文件: result_csv=' + value));
  }
  assert.equal(new Set(literals.map(mac.normalizeOutputCandidateKey)).size, literals.length);
  assert.equal(mac.normalizeOutputCandidateKey(12), '');
  assert.equal(mac.normalizeOutputCandidateKey('a//b.csv'), '');
});

test('YAML escapes decode once while literal quotes, hashes, commas and spaces remain filename content', () => {
  const pairs = [
    ['"Results/\\u4e2d\\x20A/\\U0001f600.csv "', 'Results/中 A/😀.csv '],
    ["'Results/O''Brien # ,/metrics_summary.csv '", "Results/O'Brien # ,/metrics_summary.csv "],
    ['"Results/\\\"quoted\\\"/Metrics.csv "', 'Results/"quoted"/Metrics.csv '],
    ['"Results/{suite}/指标.csv "', 'Results/{suite}/指标.csv '],
    ['Results/a#b.csv # comment', 'Results/a#b.csv'],
    ["Results/O'Brien.csv # comment", "Results/O'Brien.csv"],
    ['Results/"quoted".csv # comment', 'Results/"quoted".csv'],
    ['"Results/\\_space.csv"', 'Results/\u00a0space.csv'],
  ];
  for (const [token, expected] of pairs) {
    const output = mac.parsePlanOutputEvidence('result_csv: ' + token).outputCandidates;
    assert.deepEqual(array(output), [expected], token);
  }
  const quotedName = "'Results/\"file\".csv '";
  assert.deepEqual(array(mac.parsePlanOutputEvidence('result_csv: ' + quotedName).outputCandidates), ['Results/"file".csv ']);
});

test('Mac block and flow result lists, object paths and outputs retain exact identity', () => {
  for (const list of [
    'expectedResults: [' + literals.map(JSON.stringify).join(', ') + ']',
    'expectedResults:\n' + literals.map(value => '  - path: ' + JSON.stringify(value)).join('\n'),
    'paper: { expectedResults: [' + literals.map(value => '{file: ' + JSON.stringify(value) + '}').join(', ') + '] }',
  ]) assert.deepEqual(array(mac.parsePlanOutputEvidence(list).outputCandidates), literals);
  const outputs = [...literals, ' Models/权重 A .pth ', literals[0]];
  assert.deepEqual(array(mac.parsePlanOutputEvidence('runner: { outputs: [' + outputs.map(JSON.stringify).join(', ') + '] }').declaredOutputs), outputs.slice(0, -1));
  const flow = "paper: {result_csv: 'Results/O''Brien # ,/metrics_summary.csv ', result_json: 'Results/other/metrics.json'}";
  assert.deepEqual(array(mac.parsePlanOutputEvidence(flow).outputCandidates), ["Results/O'Brien # ,/metrics_summary.csv ", 'Results/other/metrics.json']);
  assert.deepEqual(array(mac.parsePlanOutputEvidence("expectedResults: [Results/O'Brien.csv, Results/next.csv]").outputCandidates), ["Results/O'Brien.csv", 'Results/next.csv']);
});

test('invalid YAML scalars and POSIX paths never become repaired or Windows candidates', () => {
  const tokens = ['"a\\q.csv"', '"a\\uD800.csv"', '"a\\U00110000.csv"', '"a.csv', '"a.csv"junk',
    '"a\\n.csv"', '"a\\\\b.csv"', "'a\\b.csv'", '"./a.csv"', '"a//b.csv"', '"a/../b.csv"',
    '"/a.csv"', '"C:/a.csv"', 'null', '42', 'false', '{}', '[]', '"' + '中'.repeat(1366) + '.csv"'];
  for (const token of tokens) assert.deepEqual(array(mac.parsePlanOutputEvidence('result_csv: ' + token).outputCandidates), [], token);
  const onlyMetadata = 'expectedResults: ["jobs.csv", "a/status.json ", "simple_cluster/results/a.csv"]';
  assert.deepEqual(array(mac.parsePlanOutputEvidence(onlyMetadata).outputCandidates), []);
});

test('command result flags, redirects, directories and macros retain their declared spelling', () => {
  const command = 'python test.py --result-csv " Results/A /Metrics.csv " --output-dir " Work/A " > "Results/B/stdout.log "';
  const evidence = mac.parsePlanOutputEvidence('runner:\n  test_command: ' + command, { mode: 'test' });
  assert.ok(evidence.outputCandidates.includes(' Results/A /Metrics.csv '));
  assert.ok(evidence.outputCandidates.includes('Results/B/stdout.log '));
  for (const base of ['metrics_summary.csv', 'metrics_case.csv', 'stdout.log', 'stderr.log'])
    assert.ok(evidence.outputCandidates.includes(' Work/A /' + base));
  const yaml = 'result_csv: "{output_dir}/metrics_summary.csv"\nexpectedResults: ["work_dirs/A/metrics_summary.csv", "work_dirs/B/metrics_summary.csv"]';
  assert.deepEqual(array(mac.parsePlanOutputEvidence(yaml).outputCandidates),
    ['{output_dir}/metrics_summary.csv', 'work_dirs/A/metrics_summary.csv', 'work_dirs/B/metrics_summary.csv']);
});

test('Plan YAML candidates feed the actual Mac panel/backend matcher without directory or spelling aliases', () => {
  for (const match of [matcher('backend'), matcher('panel')]) {
    for (const target of literals) {
      const summary = mac.parsePlanSummary('expectedResults: [' + JSON.stringify(target) + ']');
      assert.equal(summary.outputCandidates.length, 1);
      assert.equal(match(summary.outputCandidates[0], target, summary), true);
      for (const other of literals.filter(value => value !== target)) assert.equal(match(summary.outputCandidates[0], other, summary), false);
    }
    const summary = mac.parsePlanSummary('result_csv: "Results/{seed}/Metrics.csv "');
    assert.equal(match(summary.outputCandidates[0], 'Results/7/Metrics.csv ', summary), true);
    assert.equal(match(summary.outputCandidates[0], 'results/7/Metrics.csv ', summary), false);
  }
});

test('non-Mac compiled Plan reader keeps the original contract folding', () => {
  assert.equal(windows.normalizeOutputCandidateKey('a/metrics_summary.csv'), windows.normalizeOutputCandidateKey('b/METRICS_SUMMARY.CSV'));
  const yaml = 'result_csv: "{output_dir}/metrics_summary.csv"\nexpectedResults: ["work_dirs/A/metrics_summary.csv", "work_dirs/B/metrics_summary.csv"]';
  assert.deepEqual(array(windows.parsePlanOutputEvidence(yaml).outputCandidates), ['*/metrics_summary.csv']);
});
