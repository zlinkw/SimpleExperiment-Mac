const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const tables = require('../../dist/results/ProjectResultTables');
let savedRules = {};
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
  if (request === 'vscode') return {Uri: {file: value => ({fsPath: value})}, ConfigurationTarget: {WorkspaceFolder: 2}, window: {showInformationMessage() {}, showWarningMessage: async () => '覆盖已有子表'}, workspace: {workspaceFolders: [], getConfiguration: () => ({get: () => savedRules, update: async (_key, value) => { savedRules = value; }})}};
  return originalLoad.call(this, request, parent, main);
};
const {RealtimeTunnelPanelProvider} = require('../../dist/extension/legacy');
Module._load = originalLoad;

test('production writer, catalog, open and split obey dataset keys and configured root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-catalog-'));
  const registry = tables.emptyTableRegistry();
  registry.plans['experiments/plans/demo.yaml'] = {revision: 'r1', expectedSeeds: 1, records: ['BUS', 'PAD', ''].map(dataset => ({planFile: 'experiments/plans/demo.yaml', workerId: 'w1', case: 'same', seed: '1', method: 'corim', dataset, rate: '', endpoint: 'clean', metrics: {accuracy: .8}}))};
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), {
    resultCsvDirectory: 'artifacts/results', captureProjectContext: () => ({root}),
    projectContextIsCurrent: () => true,
    openWorkspaceFileForProjectContext: async relative => {host.opened = relative;},
  });
  await host.writeProjectTableRegistry(root, registry);
  for (const dataset of ['BUS', 'PAD', '_unassigned']) {
    const final = path.join(root, 'artifacts/results', dataset, 'final/final.csv');
    const parsed = tables.readCsv(fs.readFileSync(final, 'utf8'));
    assert.deepEqual([...new Set(parsed.rows.map(row => row[parsed.header.indexOf('dataset')]))], [dataset === '_unassigned' ? '' : dataset]);
    assert.ok(fs.existsSync(final.replace('.csv', '.md')));
    assert.ok(fs.existsSync(path.join(root, 'artifacts/results', dataset, 'methods/corim/corim.csv')));
  }
  assert.equal(fs.existsSync(path.join(root, 'experiments/results')), false);
  const planKey = tables.planDirectoryKey('experiments/plans/demo.yaml');
  const artifact = `artifacts/results/BUS/plans/${planKey}/raw/w1/metrics.csv`;
  fs.mkdirSync(path.dirname(path.join(root, artifact)), {recursive: true});
  fs.writeFileSync(path.join(root, artifact), 'dataset,value\nBUS,.8\n', 'utf8');
  const catalog = tables.resultCatalog(root, host.resultCsvDirectory);
  assert.equal(catalog.datasets.length, 4);
  const all = catalog.datasets.flatMap(row => row.tables);
  assert.equal(new Set(all.map(row => row.tableKey)).size, 6);
  assert.equal(catalog.datasets.find(row => row.datasetKey === '_shared').plans[0].planFile, 'experiments/plans/demo.yaml');
  assert.equal(catalog.unassignedPlans.length, 0);
  assert.equal(catalog.multiDatasetPlans.length, 1);
  await host.openLocalResultTableFromUi({tableKey: 'PAD/final', format: 'csv', file: '../untrusted'});
  assert.equal(host.opened, 'artifacts/results/PAD/final/final.csv');
  await host.openLocalResultTableFromUi({artifactKey: artifact});
  assert.equal(host.opened, artifact);
  await assert.rejects(host.openLocalResultTableFromUi({tableKey: '../escape'}));
  await assert.rejects(host.openLocalResultTableFromUi({artifactKey: '../escape.csv'}));
  await host.splitProjectResultTableFromUi({tableKey: 'PAD/final', splitField: 'dataset', splitValues: ['PAD'], keepColumns: ['dataset', 'accuracy_mean']});
  assert.equal(fs.readFileSync(path.join(root, 'artifacts/results/PAD/final/by_dataset/PAD.csv'), 'utf8').includes('PAD,0.8'), true);
  assert.equal(fs.existsSync(path.join(root, 'artifacts/results/BUS/final/by_dataset')), false);
  const before = fs.readFileSync(path.join(root, 'artifacts/results/BUS/final/final.csv'), 'utf8');
  registry.plans['experiments/plans/demo.yaml'].records.push({...registry.plans['experiments/plans/demo.yaml'].records[1], metrics: {AUC: .6, roc_auc: .7}});
  await assert.rejects(host.writeProjectTableRegistry(root, registry), /冲突/);
  assert.equal(fs.readFileSync(path.join(root, 'artifacts/results/BUS/final/final.csv'), 'utf8'), before);

  const source = require('../_helpers/sourceReader').readSource('src/ui/PanelHtml.ts');
  const start = source.indexOf('    function resultCatalogViewModel(catalog, state)');
  const end = source.indexOf('\n    function renderResultEvidenceWorkbench', start + 20);
  const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const context = {detailsOpenAttr: (_key, defaultOpen) => defaultOpen ? ' open' : '', asArray: value => Array.isArray(value) ? value : [], esc: escape, escAttr: escape, resultSplitTableKey: '', resultSplitFieldName: '', resultSplitSearchQuery: '', resultSplitSelectedColumns: null, resultSplitSelectedValues: null, detailsOpenState: {}, renderSectionIfVisible() {}};
  vm.runInNewContext(source.slice(start, end) + '; this.renderProjectResultTables = renderProjectResultTables', context);
  const render = context.renderProjectResultTables;
  const html = render({resultOutputConfig: {tables: all, catalog}});
  assert.match(html, /data-details-key="result-dataset-BUS"/);
  assert.match(html, /data-details-key="result-dataset-PAD"/);
  assert.match(html, /data-details-key="result-dataset-BUS" open/);
  assert.doesNotMatch(html, /data-details-key="result-dataset-PAD" open/);
  assert.match(html, /resultDatasetGroup/);
  assert.match(html, /方法 1 · 涉及 Plan 1/);
  assert.match(html, /关联 Plan（1）/);
  assert.doesNotMatch(html, /Plan 0/);
  assert.match(html, /跨数据集 Plan 与共享产物（1 个 Plan · 1 个文件）/);
  assert.match(html, /跨数据集 · BUS、PAD/);
  assert.match(html, /data-table-key="PAD\/final"/);
  assert.match(html, /未识别数据集/);
  assert.match(html, /title="artifacts\/results\/PAD\/final\/final.csv"/);
  assert.match(html, /class="resultMethodList"/);
  assert.match(html, /data-format="csv"/);
  assert.match(html, /data-format="md"/);
  assert.doesNotMatch(html, /全项目总表|experiments\/results/);
  assert.match(source, /\.resultTableBrowser details > summary::before/);
  assert.match(source, /\.resultTableBrowser details\[open\] > summary::before/);
  assert.match(source, /::-webkit-details-marker \{ display: none; \}/);
});

test('local refresh repairs stale CSV and Markdown from recorded seeds without any remote reads or raw caches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-local-refresh-'));
  const planFile = 'experiments/plans/demo.yaml';
  const registry = tables.emptyTableRegistry();
  registry.plans[planFile] = { revision: 'r1', expectedSeeds: 1, records: [{ planFile, workerId: 'worker-a', case: 'case-a', seed: '42',
    method: 'method-a', dataset: 'dataset-a', rate: '', endpoint: 'clean', runId: 'run-b', revision: 'r1', metrics: { AUC: .93 } }] };
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), {
    resultCsvDirectory: 'artifacts/results', captureProjectContext: () => ({ root }), projectContextIsCurrent: () => true,
    cancelResultCatalogRefresh() {}, invalidateResultCatalogCache() {}, postState() {},
    client: { getResultsSummary: async () => assert.fail('local refresh must not access remote summaries') },
    simpleSftpApiCall: async () => assert.fail('local refresh must not download files'),
  });
  await host.writeProjectTableRegistry(root, registry);
  const csv = path.join(root, 'artifacts/results/dataset-a/final/final.csv');
  const md = path.join(root, 'artifacts/results/dataset-a/final/final.md');
  const expected = fs.readFileSync(md, 'utf8');
  fs.writeFileSync(csv, 'stale csv', 'utf8'); fs.writeFileSync(md, 'stale markdown', 'utf8');
  await host.refreshLocalResultsFromUi();
  assert.equal(fs.readFileSync(md, 'utf8'), expected);
  assert.match(fs.readFileSync(csv, 'utf8'), /0.93/);
  const registryPath = path.join(root, 'simple_cluster/results/project_table_registry.json');
  const generation = JSON.parse(fs.readFileSync(registryPath, 'utf8')).publicationGeneration;
  await host.refreshLocalResultsFromUi();
  assert.equal(JSON.parse(fs.readFileSync(registryPath, 'utf8')).publicationGeneration, generation, 'an unchanged refresh does not republish');
  assert.equal(fs.existsSync(path.join(root, 'artifacts/results/dataset-a/plans')), false);
});

test('published registry excludes retired method and dataset tables from current catalog without deleting their files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-current-generation-'));
  const planFile = 'experiments/plans/demo.yaml';
  const registry = tables.emptyTableRegistry();
  registry.plans[planFile] = { revision: 'r1', expectedSeeds: 1, records: [{ planFile, workerId: 'worker-a', case: 'case-a', seed: '42',
    method: 'old-method', dataset: 'old-dataset', rate: '', endpoint: 'clean', runId: 'run-a', metrics: { AUC: .81 } }] };
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), { resultCsvDirectory: 'artifacts/results' });
  await host.writeProjectTableRegistry(root, registry);
  const oldFile = path.join(root, 'artifacts/results/old-dataset/methods/old-method/old-method.csv');
  const oldText = fs.readFileSync(oldFile, 'utf8');
  registry.plans[planFile].records = registry.plans[planFile].records.map(row => ({ ...row, method: 'new-method', dataset: 'new-dataset', runId: 'run-b', metrics: { AUC: .93 } }));
  await host.writeProjectTableRegistry(root, registry);
  const current = tables.resultCatalog(root, 'artifacts/results').datasets.flatMap(dataset => dataset.tables);
  assert.deepEqual(current.map(row => row.tableKey).sort(), ['new-dataset/final', 'new-dataset/method/new-method']);
  assert.equal(fs.readFileSync(oldFile, 'utf8'), oldText);
  assert.equal(fs.existsSync(path.join(root, 'artifacts/results/old-dataset/final/final.md')), true);
});

test('result catalog stays within dataset, plan, table and artifact response limits at stress scale', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-catalog-stress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resultRoot = path.join(root, 'experiments/results/benchmark/plans');
  const registryPlans = {};
  for (let plan = 0; plan < 100; plan++) {
    const planFile = `experiments/plans/benchmark/plan-${String(plan).padStart(3, '0')}.yaml`;
    const raw = path.join(resultRoot, tables.planDirectoryKey(planFile), 'raw');
    registryPlans[planFile] = { revision: 'fixture', expectedSeeds: 1, records: [] };
    fs.mkdirSync(raw, { recursive: true });
    for (let artifact = 0; artifact < 20; artifact++) fs.writeFileSync(path.join(raw, `metric-${String(artifact).padStart(2, '0')}.json`), '{"v":1}', 'utf8');
  }
  const registryPath = path.join(root, 'simple_cluster/results/project_table_registry.json');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, plans: registryPlans }), 'utf8');
  const catalog = tables.resultCatalog(root, 'experiments/results');
  const plans = catalog.datasets.flatMap(dataset => dataset.plans || []);
  const artifacts = plans.flatMap(plan => plan.artifacts || []);
  assert.ok(catalog.datasets.length <= catalog.catalogLimits.datasets);
  assert.ok(plans.length <= catalog.catalogLimits.plans);
  assert.ok(artifacts.length <= catalog.catalogLimits.artifacts);
  assert.equal(plans.length, 100);
  assert.equal(artifacts.length, 2000);
});

test('manual Plan mapping persists per workspace, rebuilds existing seeds locally, and keeps raw artifacts unchanged', async () => {
  savedRules = {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-manual-map-'));
  const planFile = 'experiments/plans/comparison/old.yaml';
  const registry = tables.emptyTableRegistry();
  registry.plans[planFile] = {revision: 'r1', expectedSeeds: 1, records: [{planFile, workerId: 'w1', case: 'same', seed: '1', method: 'old', dataset: '', rate: '', endpoint: 'clean', metrics: {accuracy: .8}}]};
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), {
    resultCsvDirectory: 'experiments/results', captureProjectContext: () => ({root}), projectContextIsCurrent: () => true, postState() { this.refreshed = true; },
    loadProjectTableRegistry: async () => JSON.parse(fs.readFileSync(path.join(root, 'simple_cluster/results/project_table_registry.json'), 'utf8')),
  });
  await host.writeProjectTableRegistry(root, registry);
  const artifact = path.join(root, 'experiments/results/_unassigned/plans', tables.planDirectoryKey(planFile), 'raw/w1/metrics.csv');
  fs.mkdirSync(path.dirname(artifact), {recursive: true});
  fs.writeFileSync(artifact, 'metric,value\naccuracy,0.8\n', 'utf8');
  const before = fs.readFileSync(artifact, 'utf8');
  await host.applyPlanDatasetMappingFromUi({mappings: {[planFile]: 'PAD'}});
  assert.equal(savedRules.planDatasetMapping[planFile].datasets[0], 'PAD');
  assert.equal(host.refreshed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'simple_cluster/results/project_table_registry.json'), 'utf8')).plans[planFile].records[0].dataset, 'PAD');
  assert.ok(fs.existsSync(path.join(root, 'experiments/results/PAD/final/final.csv')));
  assert.equal(fs.readFileSync(artifact, 'utf8'), before);
  await assert.rejects(host.applyPlanDatasetMappingFromUi({mappings: {[planFile]: 'BUS'}}), /不能通过人工映射覆盖/);
  assert.equal(savedRules.planDatasetMapping[planFile].datasets[0], 'PAD');
  const catalog = tables.resultCatalog(root, 'experiments/results', savedRules.planDatasetMapping);
  assert.equal(catalog.unassignedPlans.length, 0);
  assert.equal(catalog.datasets.find(row => row.datasetKey === 'PAD').plans[0].planFile, planFile);
});

test('legacy artifact CSV metadata repairs an unmatched Plan key and keeps multi-dataset Plans out of unresolved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-artifact-metadata-'));
  const planFile = 'experiments/plans/comparison/corim.yaml';
  const registry = tables.emptyTableRegistry();
  registry.plans[planFile] = {revision: 'r1', expectedSeeds: 1, records: ['BUS', 'PAD'].map(dataset => ({planFile, workerId: 'w1', case: 'same', seed: '1', method: 'corim', dataset, rate: '', endpoint: 'clean', metrics: {accuracy: .8}}))};
  fs.mkdirSync(path.join(root, 'simple_cluster/results'), {recursive: true});
  fs.writeFileSync(path.join(root, 'simple_cluster/results/project_table_registry.json'), JSON.stringify(registry), 'utf8');
  const oldFile = path.join(root, 'experiments/results/_shared/plans/old-plan-hash/detail/w1/project_seed_mean_std.csv');
  fs.mkdirSync(path.dirname(oldFile), {recursive: true});
  fs.writeFileSync(oldFile, 'plan_file,dataset\n' + planFile + ',BUS\n' + planFile + ',PAD\n', 'utf8');
  const catalog = tables.resultCatalog(root, 'experiments/results');
  assert.equal(catalog.unassignedPlans.length, 0);
  assert.equal(catalog.multiDatasetPlans.length, 1);
  const shared = catalog.datasets.find(row => row.datasetKey === '_shared');
  assert.equal(shared.plans[0].planFile, planFile);
  assert.deepEqual(shared.plans[0].datasets, ['BUS', 'PAD']);
  assert.equal(shared.plans[0].artifacts.length, 1);
});

test('legacy flat tables remain read-only and separate from new datasets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-legacy-'));
  const legacy = path.join(root, 'artifacts/results/final/final.csv');
  fs.mkdirSync(path.dirname(legacy), {recursive: true});
  fs.writeFileSync(legacy, 'dataset,value\nBUS,.5\nPAD,.6\n', 'utf8');
  assert.equal(tables.resultCatalog(root, 'artifacts/results').legacyTables.length, 1);
  const newFile = path.join(root, 'artifacts/results/BUS/final/final.csv');
  fs.mkdirSync(path.dirname(newFile), {recursive: true});
  fs.writeFileSync(newFile, 'dataset,value\nBUS,.5\n', 'utf8');
  assert.equal(tables.resultCatalog(root, 'artifacts/results').legacyTables.length, 0);
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'dataset,value\nBUS,.5\nPAD,.6\n');
});
