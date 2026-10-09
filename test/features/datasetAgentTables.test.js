const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('isolated Agent partitions Plan, project and paper tables and retains same-basename Plans', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-agent-'));
  const script = path.join(temp, 'check.py');
  const root = path.join(temp, 'project');
  const runtime = path.resolve(__dirname, '../../dist/runtime/cluster_agent.py');
  const helpers = path.resolve(__dirname, '../_helpers');
  fs.writeFileSync(script, `import sys, os, csv, json, math
sys.path.insert(0, ${JSON.stringify(helpers)})
from extractRuntimeFunctions import extract_runtime_functions
a = extract_runtime_functions(${JSON.stringify(runtime)}, ['parse_results_action', 'write_plan_seed_aggregate', 'write_project_seed_aggregate', 'write_project_final_summary', 'paper_dataset_output', 'publish_dataset_outputs', 'export_paper_table_action'])
root = ${JSON.stringify(root)}
os.makedirs(root, exist_ok=True)
source = 'experiments/results/raw.csv'
def rows(table):
    with open(a.safe_project_path(root, table), encoding='utf-8') as stream:
        return list(csv.DictReader(stream))
def summary(plan, datasets):
    return {'planFile': plan, 'results': [{'dimensions': {'case': 'same', 'seed': seed, 'method': 'demo', 'dataset': dataset}, 'metrics': {'accuracy': {'value': value}}, 'sourceFiles': [{'path': source}]} for dataset in datasets for seed, value in [('1', .6), ('2', .8)]]}
for plan in ['experiments/plans/a/demo.yaml', 'experiments/plans/b/demo.yaml', 'experiments/plans/missing.yaml']:
    full = a.safe_project_path(root, plan)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8') as stream:
        stream.write('suite: demo\\nseeds: [1, 2]\\npaper:\\n  result_csv: experiments/results/raw.csv\\ncases:\\n  - case: same\\n')
os.makedirs(os.path.join(root, 'experiments/results'), exist_ok=True)
with open(a.safe_project_path(root, source), 'w', encoding='utf-8', newline='') as stream:
    writer = csv.writer(stream)
    writer.writerow(['case', 'seed', 'method', 'dataset', 'accuracy'])
    writer.writerows([['same', seed, 'demo', dataset, value] for dataset in ['BUS', 'PAD'] for seed, value in [('1', .6), ('2', .8)]])
parsed = a.parse_results_action(root, plan='experiments/plans/a/demo.yaml')
assert len(parsed['datasetResultTables']) == len(parsed['projectDatasetTables']) == 2
assert not parsed.get('finalCsvPath') and not parsed.get('projectFinalCsvPath')

policy = {'metricAliases': {}, 'metricPriority': ['accuracy']}
one = summary('experiments/plans/a/demo.yaml', ['BUS', 'PAD'])
a.write_plan_seed_aggregate(root, one, policy)
assert one['aggregateStatus'] == 'ready' and not one.get('finalCsvPath') and not one.get('aggregateCsvPath')
assert {t['dataset'] for t in one['datasetResultTables']} == {'BUS', 'PAD'}
for table in one['datasetResultTables']:
    for field in ['aggregateCsvPath', 'finalCsvPath']:
        values = rows(table[field])
        assert {r['dataset'] for r in values} == {table['dataset']}
    final = rows(table['finalCsvPath'])[0]
    assert abs(float(final['accuracy_mean']) - .7) < 1e-12
    assert abs(float(final['accuracy_sd']) - math.sqrt(.02)) < 1e-12
    assert table['dataset'] in open(a.safe_project_path(root, table['finalMarkdownPath']), encoding='utf-8').read()
two = summary('experiments/plans/b/demo.yaml', ['BUS'])
a.write_plan_seed_aggregate(root, two, policy)
assert one['datasetResultTables'][0]['finalCsvPath'] != two['finalCsvPath']
seed_tables = a.write_project_seed_aggregate(root, two)
final_tables = a.write_project_final_summary(root, two)
assert len(seed_tables) == len(final_tables) == 2
for table in final_tables:
    values = rows(table['finalCsvPath'])
    assert {r['dataset'] for r in values} == {table['dataset']}
    if table['dataset'] == 'BUS':
        assert {r['plan_file'] for r in values} == {one['planFile'], two['planFile']}
assert not os.path.exists(os.path.join(root, 'simple_cluster/results/project_final.csv'))
missing = summary('experiments/plans/missing.yaml', [''])
a.write_plan_seed_aggregate(root, missing, policy)
assert missing['datasetResultTables'][0]['datasetKey'] == '_unassigned'
assert rows(missing['finalCsvPath'])[0]['dataset'] == ''
before = open(a.safe_project_path(root, two['finalCsvPath']), 'rb').read()
bad = summary(two['planFile'], ['A B', 'A?B'])
try:
    a.write_plan_seed_aggregate(root, bad, policy)
    raise AssertionError('collision accepted')
except ValueError:
    pass
assert open(a.safe_project_path(root, two['finalCsvPath']), 'rb').read() == before
stats = {'resultCount': 4, 'rows': [{'dimensions': {'dataset': d, 'method': 'demo'}, 'group': 'demo', 'metrics': {'accuracy': {'mean': .7, 'std': .1, 'n': 2}}} for d in ['BUS', 'PAD']]}
a.compute_statistics_action = lambda *args: stats
a.read_project_metric_policy = lambda *args: policy
a.read_current_results_summary = lambda *args: {}
a.build_claim_evidence_report = lambda *args: {}
a.write_results_summary_v2 = lambda *args: None
paper = a.export_paper_table_action(root, one['planFile'])
assert len(paper['paperDatasetTables']) == 2 and paper['path'] == '' and paper['csvPath'] == ''
for table in paper['paperDatasetTables']:
    assert {r['dataset'] for r in rows(table['paperTableCsvPath'])} == {table['dataset']}
    assert '/tables/' + table['datasetKey'] + '/' in table['paperTableCsvPath']
print(json.dumps({'planTables': len(one['datasetResultTables']), 'projectTables': len(final_tables), 'paperTables': len(paper['paperDatasetTables'])}))
`, 'utf8');
  const result = spawnSync('python', ['-X', 'utf8', '-B', script], {encoding: 'utf8', timeout: 10000, windowsHide: true});
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {planTables: 2, projectTables: 2, paperTables: 2});
});
