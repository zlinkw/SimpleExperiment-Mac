const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {buildPptPlotRequest} = require('../../dist/PptPlotBridge');
const {buildPlottingOutputContract, paperTableCsvPath} = require('../../dist/features/PlottingContract');

test('PPT accepts nested and synced dataset tables and rejects mixed dataset plotting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-ppt-'));
  const plan = 'experiments/plans/demo.yaml';
  const contract = buildPlottingOutputContract('2026-09-30', plan, ['BUS', 'PAD']);
  assert.equal(contract.files.paperTable.path, '');
  assert.deepEqual(contract.files.paperTable.paths, ['BUS', 'PAD'].map(dataset => paperTableCsvPath(plan, dataset)));
  const write = (relative, value) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, value, 'utf8');
  };
  const bus = paperTableCsvPath(plan, 'BUS');
  const pad = paperTableCsvPath(plan, 'PAD');
  write(bus, 'method,dataset,metric,mean,std\ndemo,BUS,accuracy,.8,.1\n');
  write(pad, 'method,dataset,metric,mean,std\ndemo,PAD,accuracy,.7,.1\n');
  const input = sources => ({projectRoot: root, planFile: plan, sourcePaths: sources, target: {presentationPath: path.join(root, 'result.pptx')}});
  const request = await buildPptPlotRequest(input([bus]), 'dataset-test');
  assert.deepEqual(request.sourcePaths, [bus]);
  await assert.rejects(buildPptPlotRequest(input([bus, pad])), /多个数据集/);
  const mapped = 'artifacts/results/BUS/plans/demo__12345678/trace/simple_results_table__demo__abcd.csv';
  write(mapped, 'method,dataset,metric,mean,std\ndemo,BUS,accuracy,.8,.1\n');
  assert.deepEqual((await buildPptPlotRequest(input([mapped]))).sourcePaths, [mapped]);
  const stats = 'simple_cluster/results/by_plan/demo/statistics.json';
  write(stats, JSON.stringify({resultCount: 4, aggregationPolicy: {source: 'archived_only'}, rows: [{dimensions: {dataset: 'BUS'}}, {dimensions: {dataset: 'PAD'}}]}));
  await assert.rejects(buildPptPlotRequest(input([stats])), /多个数据集/);
});
