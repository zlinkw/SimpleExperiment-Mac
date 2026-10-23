const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const tables = require('../../dist/results/ProjectResultTables');
let savedRules = {};
const {currentResultHost}=require("../_helpers/currentResultHost");
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
  if (request === 'vscode') return {Uri: {file: value => ({fsPath: value})}, ConfigurationTarget: {WorkspaceFolder: 2}, window: {showInformationMessage() {}, showWarningMessage: async () => '覆盖已有子表'}, workspace: {workspaceFolders: [], getConfiguration: () => ({get: () => savedRules, update: async (_key, value) => { savedRules = value; }})}};
  return originalLoad.call(this, request, parent, main);
};
const {RealtimeTunnelPanelProvider} = require('../../dist/extension/legacy');
Module._load = originalLoad;

const {scenario,exportsApi}=require('../_helpers/resultCollectionScenario');

test('active writer, catalog, opening and splitting bind dataset keys and the configured root',async()=>{
  const f=scenario({directory:'artifacts/results'}),p=f.addPlan(undefined,{seeds:[1],cases:['bus','pad','unassigned']});
  p.jobs.forEach((j,index)=>f.put(p,index,{dataset:['BUS','PAD',''][index]}));
  const report=await f.update();assert.equal(report.completed,3);
  const catalog=await f.catalog();assert.deepEqual(catalog.datasets.map(d=>d.datasetKey).sort(),['BUS','PAD','_unassigned']);
  const all=catalog.datasets.flatMap(d=>d.tables);assert.equal(new Set(all.map(t=>t.tableKey)).size,6);
  assert.equal(fs.existsSync(path.join(f.root,'experiments/results')),false);
  const h=Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype),f.host,{
    openWorkspaceFileForProjectContext:async file=>{h.opened=file;},invalidateResultCatalogCache(){}
  });
  await h.openLocalResultTableFromUi({tableKey:'PAD/final',format:'csv',file:'../untrusted'});
  assert.equal(h.opened,'artifacts/results/PAD/final/final.csv');
  await h.openLocalResultTableFromUi({tableKey:'PAD/final',format:'md'});assert.match(h.opened,/PAD\/final\/final.md$/);
  await assert.rejects(h.openLocalResultTableFromUi({tableKey:'../escape'}));
  await assert.rejects(h.openLocalResultTableFromUi({artifactKey:'../escape.csv'}));
  await h.splitProjectResultTableFromUi({tableKey:'PAD/final',splitField:'dataset',splitValues:['PAD'],keepColumns:['dataset','roc_auc_mean']});
  assert.match(fs.readFileSync(path.join(f.root,'artifacts/results/PAD/final/by_dataset/PAD.csv'),'utf8'),/PAD,0.92/);
  assert.equal(fs.existsSync(path.join(f.root,'artifacts/results/BUS/final/by_dataset')),false);
});

test('local refresh regenerates the current export without remote reads, raw caches or old registry rows',async()=>{
  const f=scenario(),p=f.addPlan(undefined,{seeds:[42]});f.put(p,0);await f.update();
  const before=JSON.stringify(f.snapshot()),csv=f.snapshot().tables.find(t=>t.kind==='final');
  fs.writeFileSync(path.join(f.root,'artifacts/results',csv.relativePath),'stale');
  fs.writeFileSync(path.join(f.root,'artifacts/results',csv.markdownPath),'stale');
  f.calls.length=0;
  const h=Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype),f.host);
  await h.refreshLocalResultsFromUi();await h.refreshLocalResultsFromUi();
  assert.equal(JSON.stringify(f.snapshot()),before);assert.match(f.read(csv.relativePath),/0.92/);
  assert.equal(f.read(csv.markdownPath),csv.markdown);assert.deepEqual(f.calls,[]);
  assert.equal(fs.existsSync(path.join(f.root,'simple_cluster/results/project_table_registry.json')),false);
});

test('the current export hides old method and dataset tables without deleting their files',async()=>{
  const f=scenario(),p=f.addPlan(undefined,{seeds:[42]});f.put(p,0,{dataset:'old',method:'old-method'});await f.update();
  const old=f.read('old/final/final.csv');f.put(p,0,{dataset:'new',method:'new-method',runId:'new-command',metric:.61});await f.update();
  assert.equal(f.read('old/final/final.csv'),old);
  const catalog=await f.catalog();assert.deepEqual(catalog.datasets.map(d=>d.datasetKey),['new']);
  assert.deepEqual(catalog.datasets[0].tables.map(t=>t.tableKey).sort(),['new/final','new/method/new-method']);
});

test('manual dataset mapping is workspace scoped and applies only to unassigned fresh metrics',async()=>{
  savedRules={};const f=scenario(),p=f.addPlan(undefined,{seeds:[42]});f.put(p,0,{dataset:''});await f.update();
  const h=Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype),f.host);
  h.loadProjectTableRegistry=RealtimeTunnelPanelProvider.prototype.loadProjectTableRegistry;
  const original=f.storage.get('w1').get(p.jobs[0].result_csv);await h.applyPlanDatasetMappingFromUi({mappings:{[p.planFile]:'PAD'}});
  assert.equal(savedRules.planDatasetMapping[p.planFile].datasets[0],'PAD');
  f.rules.planDatasetMapping=savedRules.planDatasetMapping;await f.update();
  assert.equal((await f.catalog()).unassignedPlans.length,0);assert.match(f.read('PAD/final/final.csv'),/PAD/);
  assert.deepEqual(f.storage.get('w1').get(p.jobs[0].result_csv),original);
  await assert.rejects(h.applyPlanDatasetMappingFromUi({mappings:{[p.planFile]:'BUS'}}),/不能通过人工映射覆盖/);
});

test('result catalog stays within dataset, plan, table and artifact response limits at stress scale', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-catalog-stress-'));
  // Preserve the private stress fixture as audit evidence.
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
  fs.mkdirSync(path.join(root,'simple_cluster/results'),{recursive:true});
  const legacyPath=path.join(root,'simple_cluster/results/project_table_registry.json');fs.writeFileSync(legacyPath,JSON.stringify(registry));
  const active=currentResultHost(RealtimeTunnelPanelProvider,{root,rows:registry.plans[planFile].records,rules:()=>savedRules});
  const legacyLoad=host.loadProjectTableRegistry,post=host.postState;Object.assign(host,active.host);host.loadProjectTableRegistry=legacyLoad;host.postState=post;
  await host.writeProjectTableRegistry(root,registry);
  const artifact = path.join(root, 'experiments/results/_unassigned/plans', tables.planDirectoryKey(planFile), 'raw/w1/metrics.csv');
  fs.mkdirSync(path.dirname(artifact), {recursive: true});
  fs.writeFileSync(artifact, 'metric,value\naccuracy,0.8\n', 'utf8');
  const before = fs.readFileSync(artifact, 'utf8');
  await host.applyPlanDatasetMappingFromUi({mappings: {[planFile]: 'PAD'}});
  assert.equal(savedRules.planDatasetMapping[planFile].datasets[0], 'PAD');
  assert.equal(host.refreshed, true);
  assert.equal(JSON.parse(fs.readFileSync(legacyPath,'utf8')).plans[planFile].records[0].dataset,'');
  assert.equal((await active.catalog()).datasets.find(row=>row.datasetKey==='PAD').plans[0].planFile,planFile);
  assert.ok(fs.existsSync(path.join(root, 'experiments/results/PAD/final/final.csv')));
  assert.equal(fs.readFileSync(artifact, 'utf8'), before);
  await assert.rejects(host.applyPlanDatasetMappingFromUi({mappings: {[planFile]: 'BUS'}}), /不能通过人工映射覆盖/);
  assert.equal(savedRules.planDatasetMapping[planFile].datasets[0], 'PAD');
  const catalog=await active.catalog();
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
