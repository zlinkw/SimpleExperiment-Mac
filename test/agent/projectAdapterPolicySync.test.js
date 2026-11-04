const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const method = require('../_helpers/legacyMethod');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(process.env.SIMPLE_POLICY_SENDER || path.join(root, 'src/extension/legacy.ts'), 'utf8');
const agent = process.env.SIMPLE_POLICY_AGENT || path.join(root, 'dist/runtime/cluster_agent.py');
let seq = 0;
const configurations = new Map();
const helperNames = ['pluginProjectAdapterRules', 'recordField', 'normalizeProjectAdapterRulesPatch', 'stringPatchValue', 'splitUiList', 'splitUiMap'];
const ast = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
const helpers = helperNames.map(name => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name); return declaration.getText(ast);
});
const Host = vm.runInNewContext(ts.transpileModule(
  helpers.join('\n') + '\nclass Host {' + ['syncProjectAdapterRulesToAgents(', 'postTensorboardAction(', 'saveProjectAdapterRulesFromUi(', 'saveResultColumnMappingFromUi('].map(name => method(source, name)).join('\n') + '} Host;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText, {
  uniqueStrings: values => [...new Set(values)],
  errorMessage: error => error.message,
  makeOpId: action => action + '-' + ++seq,
  setTimeout,
  vscode: { Uri: { file: fsPath => ({ fsPath }) }, ConfigurationTarget: { WorkspaceFolder: 3 }, window: { showInformationMessage() {} },
    workspace: { getConfiguration: (_section, uri) => ({
      get: (_key, fallback) => configurations.get(uri.fsPath) || fallback,
      update: async (key, value, target) => { assert.equal(key, 'projectAdapterRules'); assert.equal(target, 3); configurations.set(uri.fsPath, value); },
    }) } },
});
const plain = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
function receive(rows) {
  const result = spawnSync('python', ['-B', '-X', 'utf8', path.join(__dirname, 'projectAdapterPolicySync.fixture.py'), agent], {
    input: JSON.stringify(rows), encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function host(workerIds, transport, projectRoot = '/Users/研究/项目 A') {
  const value = new Host(), calls = [];
  value.isRealtimeMode = () => true;
  value.projectTopologyAssessment = () => ({ mode: 'worker_pool' });
  value.enabledWorkerConfigs = () => workerIds.map(id => ({ id }));
  value.captureProjectContext = () => ({ root: projectRoot });
  value.projectContextIsCurrent = () => true;
  value.refreshLocalPlanMetadata = async () => {};
  value.postState = () => {};
  value.queueResultParseAfterProjectChange = () => {};
  // Only the wire transport is replaced. Both production sending methods run.
  value.client = { postWorkerAction: async (workerId, action, payload) => {
    assert.equal(action, 'save-result-policy');
    assert.equal(payload.endpointId, workerId);
    const row = { workerId, root: projectRoot, payload: plain(payload) };
    calls.push(row);
    return transport ? transport(row) : { status: 'completed' };
  } };
  return { value, calls };
}
const policy = {
  taskType: 'classification', primaryMetric: 'AUC', metricRegex: '(AUC): ([0-9.]+)',
  summaryCsv: '结果 目录/summary.csv', caseCsv: '结果 目录/case.csv',
  secondaryMetrics: ['accuracy'], classificationMetrics: ['AUC'], segmentationMetrics: ['Dice'],
  candidateCsv: ['work dirs/结果.csv'], candidateJson: ['work dirs/结果.json'],
  consoleLogs: ['logs/stdout.log'], textLogs: ['logs/训练 日志.txt'],
  csvColumnMapping: { case: 'case_name', seed: 'seed', split: 'split', dataset: '数据集', method: 'method',
    eval_protocol: 'protocol', rate_percent: 'rate', train_rate: 'train_rate', metric: 'metric', value: 'value' },
  metricAliases: { auc: 'AUC' },
  derivedMetric: { metric: 'AUC', leftEndpoint: 'clean', rightEndpoint: 'corrupt', scale: 100, outputName: 'auc_drop' },
};
const desktop = { planGlobs: ['experiments/plans/**/*.yaml', '计划 空间/**/*.yml'],
  configGlobs: ['configs/**/*.yaml'], resultGlobs: ['结果 目录/**/*.csv'] };

test('isolated real Mac receiver accepts valid policy and rejects local or unknown fields', () => {
  const cases = [ [{}, null], [policy, null],
    ...Object.entries({ ...desktop, planDatasetMapping: {} }).map(([key, value]) => [{ [key]: value }, /invalid projectAdapterRules field/]),
    [{ planDatasetMapping: { plan: { datasets: ['中文 数据集'] } } }, /invalid projectAdapterRules field/],
    [{ unknownField: 'must remain visible' }, /invalid projectAdapterRules field/],
    [{ csvColumnMapping: { case: 'invalid\ncolumn' } }, /invalid csvColumnMapping field/],
    [{ derivedMetric: { ...policy.derivedMetric, scale: 7 } }, /invalid derivedMetric configuration/],
  ];
  const got = receive(cases.map(([rules]) => ({ payload: { options: { projectAdapterRules: rules } } })));
  got.results.forEach((result, index) => {
    if (cases[index][1]) { assert.equal(result.status, 'failed'); assert.match(result.message, cases[index][1]); }
    else assert.equal(result.status, 'completed');
  });
  assert.equal(got.writes.length, 2);
});

test('real Mac sender preserves all valid fields and local configuration across path and mapping forms', async () => {
  const matrix = [
    { rules: {}, expected: {} },
    { rules: { planDatasetMapping: {} }, expected: {} },
    { rules: policy, expected: policy },
    { rules: { ...policy, planDatasetMapping: {} }, expected: policy },
    ...Object.entries(desktop).map(([key, value]) => ({ rules: { ...policy, [key]: value }, expected: policy })),
    { rules: { ...policy, ...desktop, planDatasetMapping: {} }, expected: policy },
    ...['C:\\研究 工作区\\项目 A', '/Users/研究 工作区/项目 A', '/srv/团队 空间/项目 A'].map(directory => ({
      rules: { ...policy, ...desktop, candidateCsv: [directory + '/结果.csv'], planDatasetMapping: {
        [directory + '/experiments/plans/计划.yaml']: { datasets: ['中文 数据集'], source: 'manual' },
      } }, expected: { ...policy, candidateCsv: [directory + '/结果.csv'] },
    })),
  ];
  const h = host(['node-a', '节点 二', 'node-a']), expected = [];
  for (const item of matrix) {
    const rules = freeze(plain(item.rules)), before = plain(rules);
    assert.deepEqual(Array.from(await h.value.syncProjectAdapterRulesToAgents(rules)), []);
    assert.deepEqual(plain(rules), before, 'local mapping and policy must remain intact');
    expected.push(item.expected, item.expected);
  }
  const received = receive(h.calls);
  for (const r of received.results) assert.equal(r.status, 'completed', r.message);
  assert.deepEqual(h.calls.map(r => r.workerId), matrix.flatMap(() => ['node-a', '节点 二']));
  h.calls.forEach((r, i) => assert.deepEqual(r.payload.options.projectAdapterRules, expected[i]));
  received.writes.forEach((r, i) => assert.deepEqual(r.value, { ...expected[i], schemaVersion: 1,
    csvColumnMapping: expected[i].csvColumnMapping || {}, derivedMetric: expected[i].derivedMetric || {} }));
});

test('single, duplicate and missing Workers and offline mode keep their real routing behavior', async () => {
  const calls = [];
  for (const ids of [[], ['only'], ['one', 'two', 'one']]) {
    const h = host(ids);
    assert.deepEqual(Array.from(await h.value.syncProjectAdapterRulesToAgents({ ...policy, ...desktop, planDatasetMapping: {} })), []);
    assert.deepEqual(h.calls.map(r => r.workerId), [...new Set(ids)]);
    calls.push(...h.calls);
  }
  for (const result of receive(calls).results) assert.equal(result.status, 'completed', result.message);
  const offline = host(['must-not-send']);
  offline.value.isRealtimeMode = () => false;
  assert.deepEqual(Array.from(await offline.value.syncProjectAdapterRulesToAgents(policy)), ['离线模式']);
  assert.deepEqual(offline.calls, []);
});

test('unknown fields and malformed legal fields still return each Worker actual Agent failure', async () => {
  const invalids = [{ unknownField: true }, { csvColumnMapping: { metric: 'bad\ncolumn' } },
    { derivedMetric: { ...policy.derivedMetric, outputName: 'not valid' } }];
  // Reuse one isolated receiver process; every actual outgoing rules object must
  // exactly equal the receiver input before its real response is returned.
  const received = receive(invalids.map(rules => ({ payload: { options: { projectAdapterRules: rules } } })));
  for (const [caseIndex, invalid] of invalids.entries()) {
    const h = host(['a', 'b'], row => {
      assert.deepEqual(row.payload.options.projectAdapterRules, invalid);
      return received.results[caseIndex];
    });
    const rules = freeze({ ...invalid, ...desktop, planDatasetMapping: {} });
    const errors = Array.from(await h.value.syncProjectAdapterRulesToAgents(rules));
    assert.equal(errors.length, 2);
    for (const [index, id] of ['a', 'b'].entries()) {
      assert.match(errors[index], new RegExp('^' + id + ': invalid '));
      assert.deepEqual(h.calls[index].payload.options.projectAdapterRules, invalid);
    }
  }
});

test('both result-rule settings entry points retain desktop discovery and use the common Agent boundary', async () => {
  const all = [];
  for (const entry of ['saveProjectAdapterRulesFromUi', 'saveResultColumnMappingFromUi']) {
    const root = '/Users/科研/' + entry, original = freeze(plain({ ...policy, ...desktop, planDatasetMapping: { p: { datasets: ['中文'] } } }));
    configurations.set(root, original);
    const h = host(['worker-a', 'worker-b'], undefined, root);
    const patch = entry === 'saveProjectAdapterRulesFromUi' ? { ...policy, metricAliases: 'auc = AUC' } : { metric: 'score' };
    await h.value[entry]({ patch });
    const saved = configurations.get(root);
    for (const key of Object.keys(desktop)) assert.deepEqual(plain(saved[key]), desktop[key]);
    assert.deepEqual(plain(saved.planDatasetMapping), plain(original.planDatasetMapping));
    assert.deepEqual(plain(original), { ...policy, ...desktop, planDatasetMapping: { p: { datasets: ['中文'] } } });
    assert.deepEqual(plain(saved.metricAliases), policy.metricAliases);
    assert.deepEqual(h.calls.map(row => row.workerId), ['worker-a', 'worker-b']);
    for (const row of h.calls) for (const key of [...Object.keys(desktop), 'planDatasetMapping']) assert.equal(key in row.payload.options.projectAdapterRules, false);
    all.push(...h.calls);
  }
  for (const result of receive(all).results) assert.equal(result.status, 'completed', result.message);
});

test('one failed or unreachable Worker does not hide other Worker responses', async () => {
  const h = host(['failed', 'unreachable', 'ready'], row => {
    if (row.workerId === 'failed') return { status: 'failed', message: 'actual Agent refusal' };
    if (row.workerId === 'unreachable') throw new Error('actual connection refused');
    return receive([row]).results[0];
  });
  assert.deepEqual(Array.from(await h.value.syncProjectAdapterRulesToAgents(policy)), [
    'failed: actual Agent refusal', 'unreachable: actual connection refused',
  ]);
  assert.deepEqual(h.calls.map(r => r.workerId), ['failed', 'unreachable', 'ready']);
});

test('overlapping project windows retain independent configured clients, rules and local mappings', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const a = host(['same-id'], async () => { entered(); await gate; return { status: 'completed' }; }, '/Users/甲 项目');
  const b = host(['same-id'], undefined, 'C:/研究/乙 项目');
  const rulesA = freeze({ ...policy, primaryMetric: 'AUC', planDatasetMapping: { a: { datasets: ['甲'] } } });
  const rulesB = freeze({ ...policy, primaryMetric: 'Dice', planDatasetMapping: { b: { datasets: ['乙'] } } });
  const pending = a.value.syncProjectAdapterRulesToAgents(rulesA);
  await started;
  assert.deepEqual(Array.from(await b.value.syncProjectAdapterRulesToAgents(rulesB)), []);
  release();
  assert.deepEqual(Array.from(await pending), []);
  assert.equal(a.calls[0].root, '/Users/甲 项目');
  assert.equal(b.calls[0].root, 'C:/研究/乙 项目');
  assert.equal(a.calls[0].payload.options.projectAdapterRules.primaryMetric, 'AUC');
  assert.equal(b.calls[0].payload.options.projectAdapterRules.primaryMetric, 'Dice');
  assert.deepEqual(plain(rulesA.planDatasetMapping), { a: { datasets: ['甲'] } });
  assert.deepEqual(plain(rulesB.planDatasetMapping), { b: { datasets: ['乙'] } });
});
