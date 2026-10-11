const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const test = require('node:test');
const repo = path.join(__dirname, '../..');
const vscode = {
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_name, fallback) => fallback }) },
  extensions: { getExtension: () => ({ extensionPath: repo, packageJSON: require('../../package.json') }) },
  Uri: { file: fsPath => ({ fsPath }) }, ProgressLocation: { Notification: 1 },
  window: { withProgress: async (_options, work) => work({ report() {} }, { isCancellationRequested: false }),
    showWarningMessage: async () => {}, showInformationMessage: async () => {}, setStatusBarMessage() {} },
};
const originalLoad = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
const { RealtimeTunnelPanelProvider } = require('../../dist/extension/legacy');
Module._load = originalLoad;
const tables = require('../../dist/results/ProjectResultTables');
const bundle = require('../../dist/results/WrapperResultBundle');
const publication = require('../../dist/results/ProjectResultPublication');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const planFile = 'experiments/plans/comparison/anything.yaml';

function fixture({ sameNamePlans = false, wrapperOnly = false, trainSummary = false, incomplete = false, retry = false, retryWorker = 'owner', formalJob = false,
  retryToken = 'distributed-attempt-1791468346173-xuw2sy' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-wrapper-results-'));
  const files = new Map(), calls = [];
  const makeRun = (id, value, done = 3) => ({ id, planFile, revision: 'same-revision', ...(formalJob && id === 'B' ? {resultPathPolicy:'declared',codeFingerprint:'fixture-code'} : {}), enqueuedAt: id === 'A' ? '2026-10-01T00:00:00Z' : '2026-10-02T00:00:00Z',
    jobs: [42, 43, 44].map((seed, index) => {
      const retried = retry && id === 'B' && seed === 44;
      const formal = formalJob && id === 'B';
      const outputDir = formal ? `work_dirs/formal/seed${seed}` : `work_dirs/arbitrary/${seed}/attempts/${retried ? retryToken : id}`;
      const checkpoint = outputDir + '/best_model.pth';
      const job = { index, case: 'case-one', seed, attempt: retried ? 43 : 1, workerId: retried ? retryWorker : 'owner', commandId: id + '-' + seed,
        outputDir, status: index < done ? 'completed' : 'running', ...(formal ? {attempt:0,resultPathPolicy:'declared',globalJobId:`B:${index}`,
          collectionResultCsv:`tmp/result/formal/seed${seed}/metrics.csv`} : {}) };
      const endpoint = wrapperOnly ? outputDir + '/scoring.csv' : outputDir + (trainSummary ? '/metrics_summary.csv' : '/test_results/formal_result_rows.csv');
      const endpointText = `case,seed,method,dataset,metric,value,checkpoint_path,job_dir,run_id\ncase-one,${seed},unknown_method,arbitrary_set,AUC,${value},${checkpoint},${outputDir},${id}\n`;
      files.set(endpoint, Buffer.from(endpointText));
      if (formal) files.set(job.collectionResultCsv, Buffer.from(endpointText));
      if (!wrapperOnly && !trainSummary) files.set(outputDir + '/test_results/four_state_metrics.csv', Buffer.from('state,metric,value,p0_value,delta_p100_minus_p0,sample_count,checkpoint_path,job_dir,seed,method,dataset,undefined_reason,p0_undefined_reason,extra_column\n'
        + ['both', 'image_missing', 'text_missing', 'both_missing'].map(state => `${state},AUC,${value},0.7,0.2,210,${checkpoint},${outputDir},${seed},unknown_method,arbitrary_set,,,保留原文`).join('\n') + '\n'));
      files.set(outputDir + '/custom.csv', Buffer.from('case,state,label,score,unknown_field\npatient-case,custom-state,lesion,NaN,不能计算\n'));
      files.set(outputDir + '/custom.json', Buffer.from(JSON.stringify({ arbitrary: { list: [1, null, '完整保留'] } })));
      files.set(outputDir + '/config_snapshot.yaml', Buffer.from('model: untouched\n'));
      files.set(outputDir + '/mask.npz', Buffer.from([0, 255, 2, 4, 9]));
      files.set(outputDir + '/artifact_manifest.json', Buffer.from(JSON.stringify({ output_dir: outputDir, checkpoint_path: checkpoint,
        ...(formal ? {result_csv:job.collectionResultCsv} : {}),
        metrics_summary: endpoint, outputs: ['custom.csv', 'custom.json', 'config_snapshot.yaml', 'mask.npz',
          ...(!wrapperOnly && !trainSummary ? ['test_results/four_state_metrics.csv'] : [])] })));
      // Discovery must work with just a standard manifest, without metric hashes recorded in the queue.
      job.artifacts = {};
      if (formal) {
        const hashes = Object.fromEntries([...files].filter(([file])=>file.startsWith(outputDir+'/') || file===job.collectionResultCsv).map(([file,bytes])=>[file,sha(bytes)]));
        files.set(outputDir+'/formal_job_owner.json', Buffer.from(JSON.stringify({schemaVersion:1,state:'completed',workflowId:'B',globalJobId:job.globalJobId,
          commandId:job.commandId,index,case:job.case,seed,outputDir,collectionResultCsv:job.collectionResultCsv,
          planRevision:'same-revision',codeFingerprint:'fixture-code',sha256:hashes})));
        job.artifacts = Object.fromEntries([...files].filter(([file])=>file.startsWith(outputDir+'/') || file===job.collectionResultCsv).map(([file,bytes])=>[file,sha(bytes)]));
      }
      return job;
    }) });
  const runs = [makeRun('A', .81), makeRun('B', .92, incomplete ? 2 : 3)];
  const tuningFile = planFile.replace('/comparison/', '/comparison_tuning/');
  if (sameNamePlans) runs.push({ ...makeRun('C', .66), planFile: tuningFile });
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root, scheme: 'file', path: root } }];
  const host = Object.create(RealtimeTunnelPanelProvider.prototype);
  Object.assign(host, {
    client: {}, context: { globalStorageUri: { fsPath: root } }, resultCsvDirectory: 'experiments/results',
    localPlanMetadata: { plans: [...(sameNamePlans ? [{ planFile: tuningFile, revision: 'same-revision', seeds: [42, 43, 44] }] : []),
      { planFile, revision: 'same-revision', seeds: [42, 43, 44] }],
      detectedProject: { adapterRules: { distributedResults: !wrapperOnly } } },
    captureProjectContext: () => ({ root, generation: 1 }), projectContextIsCurrent: () => true,
    effectiveConnectionMode: () => 'tunnel', actionBody: body => body, refreshLocalPlanMetadataForAction: async () => {},
    loadPlanSyncLedger: async () => ({ schemaVersion: 2, entries: {} }), loadDistributedQueue: async () => ({ plans: runs }),
    resolveSelectedPlanFile: () => planFile, enabledWorkerConfigs: () => [...new Set(runs.flatMap(run => run.jobs.map(job => job.workerId)))].map(id => ({ id })),
    mappedDownloadServerForSource: id => ({ id, host: 'current-config.example', remotePath: '/verified/project' }),
    simpleSftpCapability: async () => ({ methodOptions: { 'sync.downloadMappedPaths': { memoryOnly: true, memoryWrapperResults: true } } }),
    postState() {}, invalidateResultCatalogCache() {},
    simpleSftpApiCall: async (method, params) => {
      calls.push({ method, params });
      if (method === 'sync.projectInventory') return { ok: true, files: Object.fromEntries(params.scopePaths.filter(file => files.has(file))
        .map(file => [file, { size: files.get(file).length, sha256: sha(files.get(file)) }])) };
      assert.equal(method, 'sync.downloadMappedPaths');
      assert.equal(params.memoryOnly, true, 'result rebuild must never download originals to disk');
      assert.equal(params.wrapperResults, true);
      if (!params.memoryOnly) {
        for (const entry of params.entries) {
          const target = path.join(root, entry.localRelativePath); fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, files.get(entry.remotePath));
        }
        return { ok: true, completedFiles: params.entries.length };
      }
      return { ok: true, memoryOnly: true, entries: params.entries.map(entry => ({ remotePath: entry.remotePath,
        bytes: entry.bytes, sha256: entry.sha256, dataBase64: files.get(entry.remotePath).toString('base64') })) };
    },
  });
  const sync = () => host.rebuildProjectResultTablesFromUi({ planFiles: sameNamePlans ? [planFile, tuningFile] : [planFile] });
  const registry = () => JSON.parse(fs.readFileSync(path.join(root, 'simple_cluster/results/project_table_registry.json'), 'utf8'));
  return { root, host, files, calls, runs, sync, registry, tuningFile };
}

test('same-named Plans publish separate summaries without persisting original files', async () => {
  const f = fixture({ sameNamePlans: true });
  const selected = await f.host.rebuildProjectResultTablesFromUi({ planFiles: [planFile] });
  assert.equal(selected.included.length, 1);
  assert.deepEqual(Object.keys(f.registry().plans), [planFile]);
  assert.ok(f.calls.filter(call => call.method === 'sync.downloadMappedPaths')
    .every(call => call.params.entries.every(entry => !entry.remotePath.includes('/attempts/C/'))));
  const report = await f.sync();
  assert.equal(report.included.length, 2); assert.deepEqual(report.skipped, []); assert.deepEqual(report.missing, []);
  const registered = f.registry();
  const normal = registered.plans[planFile], tuning = registered.plans[f.tuningFile];
  assert.equal(normal.wrapperEvidence.runId, 'B'); assert.equal(tuning.wrapperEvidence.runId, 'C');
  assert.ok(normal.records.every(row => row.planFile === planFile && row.runId === 'B' && row.metrics.AUC === .92));
  assert.ok(tuning.records.every(row => row.planFile === f.tuningFile && row.runId === 'C' && row.metrics.AUC === .66));
  const paths = new Set(normal.wrapperEvidence.jobs.flatMap(job => job.sources.map(source => source.localRelativePath)));
  for (const job of tuning.wrapperEvidence.jobs) for (const source of job.sources) {
    assert.equal(paths.has(source.localRelativePath), false);
    assert.equal(fs.existsSync(path.join(f.root, source.localRelativePath)), false);
  }
  const final = tables.readCsv(fs.readFileSync(path.join(f.root, 'experiments/results/arbitrary_set/final/final.csv'), 'utf8'));
  assert.equal(final.rows.length, 2);
  assert.deepEqual(new Set(final.rows.map(row => row[final.header.indexOf('plan_file')])), new Set([planFile, f.tuningFile]));
  f.calls.length = 0;
  await f.sync();
  assert.ok(f.calls.filter(call => call.method === 'sync.downloadMappedPaths').length > 0, 'each sync reads originals into memory');
});

test('formal declared CSV survives Host discovery, four-state validation and local rebuild without borrowing historical attempts', async () => {
  const f=fixture({formalJob:true}); const oldBytes=new Map([...f.files].filter(([file])=>file.includes('/attempts/')));
  const report=await f.sync(); assert.deepEqual(report.skipped,[]); assert.deepEqual(report.missing,[]);
  const current=f.registry().plans[planFile]; assert.equal(current.wrapperEvidence.runId,'B');
  assert.ok(current.records.every(row=>row.runId==='B' && row.metrics.AUC===.92));
  for(const proof of current.wrapperEvidence.jobs) {
    assert.equal(proof.job.resultPathPolicy,'declared'); assert.ok(!proof.job.outputDir.includes('/attempts/'));
    assert.ok(proof.sources.some(source=>source.remotePath===proof.job.collectionResultCsv));
    assert.ok(proof.sources.some(source=>source.remotePath.endsWith('/formal_job_owner.json')));
  }
  for(const [file,bytes] of oldBytes) assert.deepEqual(f.files.get(file),bytes);
  const local=await f.host.summaryFromLocalMetricFiles(f.root,planFile,f.host.resultsSummary,{authoritativeLocal:true});
  assert.equal(local.wrapperEvidence.runId,'B');
});

for (const [name, retryWorker, retryToken] of [
  ['manual retry', 'owner', 'distributed-attempt-1791468346173-xuw2sy'],
  ['cross Worker reassignment', 'new-owner', 'distributed-attempt-1791468346173-xuw2sy'],
  ['automatic retry', 'owner', 'auto-retry-1791468346173-xuw2sy'],
  ['recalled failure retry', 'new-owner', 'attempt-1791624729570-fw3s7l'],
]) test(name + ' publishes the completed attempt under the original Plan run and refreshes locally', async () => {
  const trainSummary = name === 'recalled failure retry';
  const f = fixture({ retry: true, retryWorker, retryToken, trainSummary }); const report = await f.sync();
  assert.deepEqual(report.skipped, []); assert.deepEqual(report.missing, []);
  const evidence = f.registry().plans[planFile].wrapperEvidence;
  assert.equal(evidence.runId, 'B'); assert.equal(evidence.jobs.length, 3);
  const retried = evidence.jobs.find(row => row.job.seed === 44);
  assert.equal(retried.job.attempt, 43); assert.equal(retried.job.commandId, 'B-44');
  assert.equal(retried.job.workerId, retryWorker); assert.equal(retried.job.ownerWorkerId, retryWorker);
  assert.equal(retried.job.outputDir, f.runs[1].jobs[2].outputDir);
  assert.ok(f.calls.some(call => call.method === 'sync.downloadMappedPaths' && call.params.server.id === retryWorker
    && call.params.entries.some(file => file.remotePath.startsWith(retried.job.outputDir + '/'))));
  assert.ok(f.registry().plans[planFile].records.every(row => row.runId === 'B'));
  assert.ok(retried.sources.some(file => file.kind === (trainSummary ? 'metrics_summary.csv' : 'test_results/four_state_metrics.csv')));
  if (trainSummary) assert.ok(f.calls.filter(call => call.method === 'sync.downloadMappedPaths')
    .every(call => call.params.entries.every(file => !file.remotePath.includes('/test_results/'))), 'train-only wrapper needs no test outputs');
  const local = await f.host.summaryFromLocalMetricFiles(f.root, planFile, f.host.resultsSummary, { authoritativeLocal: true });
  assert.equal(local.wrapperEvidence.runId, 'B'); assert.deepEqual(local.wrapperEvidence.jobs, evidence.jobs);
  f.calls.length = 0;
  f.host.cancelResultCatalogRefresh = () => {};
  let refreshed = false; f.host.refreshLocalResultCatalogForProject = async () => { refreshed = true; };
  await f.host.refreshLocalResultsFromUi();
  assert.equal(refreshed, true); assert.equal(f.calls.length, 0, 'local refresh does not download or select an older run');
  await f.sync();
  assert.ok(f.calls.filter(call => call.method === 'sync.downloadMappedPaths').length > 0);
});

test('memoryOnly aggregation verifies four-state and arbitrary outputs but persists only summaries and hash evidence', async () => {
  const f = fixture(); const report = await f.sync(); assert.deepEqual(report.skipped, []);
  const evidence = f.registry().plans[planFile].wrapperEvidence;
  assert.equal(evidence.runId, 'B'); assert.equal(evidence.jobs.length, 3);
  for (const job of evidence.jobs) {
    assert.equal(job.checkpointPath, job.job.outputDir + '/best_model.pth');
    for (const source of job.sources) {
      assert.equal(sha(f.files.get(source.remotePath)), source.sha256);
      assert.equal(fs.existsSync(path.join(f.root, source.localRelativePath)), false);
      assert.equal(fs.existsSync(path.join(f.root, source.localRelativePath + '.provenance.json')), false);
    }
  }
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  assert.equal(evidence.storage, 'summary-only');
  const generated = walk(path.join(f.root, 'experiments/results'));
  assert.ok(!generated.some(file => /four_state.*\.csv$|\.provenance\.json$|custom\.csv/.test(file)));
  const summary = JSON.parse(fs.readFileSync(path.join(f.root, evidence.views[0]), 'utf8'));
  assert.equal(summary.runId, 'B'); assert.equal(summary.storage, 'summary-only');
  assert.equal(summary.kinds.find(row => /four_state/.test(row.kind)).rows, 12);
  assert.ok(summary.kinds.find(row => /four_state/.test(row.kind)).columns.includes('extra_column'));
  assert.doesNotMatch(JSON.stringify(summary), /不能计算/);
  assert.ok(f.calls.filter(call => call.method === 'sync.downloadMappedPaths').every(call => call.params.memoryOnly));
  assert.equal(fs.existsSync(path.join(f.root, 'tmp')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'simple_cluster/downloads')), false);
});

test('generic wrapper requires no four-state schema or project-specific CSV name', async () => {
  const f = fixture({ wrapperOnly: true });
  f.host.localPlanMetadata.detectedProject.adapterRules.distributedResults = true;
  await f.sync();
  assert.equal(f.registry().plans[planFile].records.length, 3);
  assert.ok(f.registry().plans[planFile].wrapperEvidence.jobs.every(job => job.sources.some(source => source.kind === 'mask.npz')));
  const local = await f.host.summaryFromLocalMetricFiles(f.root, planFile, f.host.resultsSummary, { authoritativeLocal: true });
  assert.equal(local.wrapperEvidence.runId, 'B');
  assert.deepEqual(local._wrapperFiles, []);
  assert.ok(local.wrapperEvidence.jobs.every(job => job.sources.every(source => !fs.existsSync(path.join(f.root, source.localRelativePath)))));
});

test('a wrapper with no endpoint CSV publishes structured outputs without inventing statistics', async () => {
  const f = fixture({ wrapperOnly: true });
  for (const run of f.runs) for (const job of run.jobs) {
    f.files.delete(job.outputDir + '/scoring.csv');
    const manifestPath = job.outputDir + '/artifact_manifest.json';
    const manifest = JSON.parse(f.files.get(manifestPath)); delete manifest.metrics_summary;
    f.files.set(manifestPath, Buffer.from(JSON.stringify(manifest)));
  }
  const report = await f.sync(); assert.deepEqual(report.skipped, []); assert.deepEqual(report.missing, []);
  const plan = f.registry().plans[planFile];
  assert.equal(plan.wrapperEvidence.runId, 'B'); assert.deepEqual(plan.records, []);
  assert.equal(plan.wrapperEvidence.jobs.length, 3);
  const summary = JSON.parse(fs.readFileSync(path.join(f.root, plan.wrapperEvidence.views[0]), 'utf8'));
  assert.ok(summary.kinds.some(row => /custom\.csv/.test(row.kind)));
  assert.equal(fs.existsSync(path.join(f.root, 'experiments/results/arbitrary_set/final/final.csv')), false);
});

test('TSV merge preserves commas, quotes and multiline cells; JSONL run mismatches are rejected', () => {
  const job = { runId: 'A', index: 0, attempt: 1, case: 'one', seed: 42, workerId: 'owner', outputDir: 'work_dirs/a/attempts/A', commandId: 'cmd' };
  const remotePath = job.outputDir + '/custom.tsv', text = 'label\tnote\nlesion,benign\t"first\nsecond,third"\n';
  const prepared = bundle.prepareWrapperJob(job, [{ remotePath, text, sha256: sha(text), bytes: Buffer.byteLength(text) }], '', [remotePath], file => 'experiments/results/' + file);
  const pub = bundle.prepareWrapperPublication('A', [{ case: 'one', seed: 42 }], [prepared]);
  const merged = bundle.wrapperMergedFiles('experiments/results', planFile, pub, [prepared]);
  const csv = tables.readCsv(merged[0].contents);
  assert.equal(csv.rows[0][csv.header.indexOf('label')], 'lesion,benign');
  assert.equal(csv.rows[0][csv.header.indexOf('note')], 'first\nsecond,third');
  const bad = '{"run_id":"B","job_dir":"work_dirs/a/attempts/A"}\n';
  assert.throws(() => bundle.prepareWrapperJob(job, [{ remotePath: job.outputDir + '/rows.jsonl', text: bad, sha256: sha(bad) }], '', [], file => file), /身份不匹配/);
});

test('auxiliary diagnostic seed is preserved; canonical and anchored job seeds remain strict', () => {
  const job = { runId: 'A', index: 1, attempt: 1, case: 'one', seed: 43, workerId: 'owner', outputDir: 'work_dirs/a/attempts/A', commandId: 'cmd' };
  const file = (name, text) => ({ remotePath: job.outputDir + '/' + name, text, sha256: sha(text), bytes: Buffer.byteLength(text) });
  const diagnostic = file('undefined_metrics.csv', 'case,run_id,seed,metric,value\n,,42,target_accuracy_change,NaN\n');
  const prepared = bundle.prepareWrapperJob(job, [diagnostic], '', [], name => name);
  assert.equal(prepared.records[0].rows[0].seed, '42');
  const pub = bundle.prepareWrapperPublication('A', [{ case: 'one', seed: 43 }], [prepared]);
  assert.match(bundle.wrapperMergedFiles('experiments/results', planFile, pub, [prepared])[0].contents, /NaN,A,1,one,43,owner/);
  assert.throws(() => bundle.prepareWrapperJob(job, [diagnostic], diagnostic.remotePath, [], name => name), /期望 43，实际 42/);
  const anchored = file('diagnostic.json', JSON.stringify({ seed: 42, job_dir: job.outputDir }));
  assert.throws(() => bundle.prepareWrapperJob(job, [anchored], '', [], name => name), /身份不匹配/);
  assert.equal(bundle.isWrapperResultFile(job.outputDir + '/code_backup/results.csv'), false);
});

test('local reuse checks current SHA256 even when size and mtime match', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-wrapper-reuse-'));
  const text = 'seed,metric,value\n42,AUC,0.8\n', relative = 'results/metric.csv';
  fs.mkdirSync(path.join(root, 'results'));
  const target = path.join(root, relative); fs.writeFileSync(target, text);
  const entry = { remotePath: 'work_dirs/a/metric.csv', localRelativePath: relative, sha256: sha(text), bytes: Buffer.byteLength(text) };
  assert.equal((await bundle.readVerifiedLocalResult(root, entry)).text, text);
  const before = fs.statSync(target); fs.writeFileSync(target, text.replace('0.8', '0.9')); fs.utimesSync(target, before.atime, before.mtime);
  assert.equal(await bundle.readVerifiedLocalResult(root, entry), undefined);
  await assert.rejects(bundle.readVerifiedLocalResult(root, { ...entry, localRelativePath: '../metric.csv' }), /路径不安全/);
});

for (const fault of ['missing-four', 'hash-mismatch', 'wrong-checkpoint', 'missing-custom']) test(fault + ' retains old complete endpoint and wrapper generation', async () => {
  const f = fixture({ retry: true }); const b = f.runs.pop(); await f.sync();
  const previous = fs.readFileSync(path.join(f.root, 'experiments/results/arbitrary_set/final/final.csv'));
  f.runs.push(b);
  const output = b.jobs[2].outputDir;
  if (fault === 'missing-four') f.files.delete(output + '/test_results/four_state_metrics.csv');
  if (fault === 'missing-custom') f.files.delete(output + '/custom.json');
  if (fault === 'wrong-checkpoint') f.files.set(output + '/test_results/four_state_metrics.csv',
    Buffer.from(f.files.get(output + '/test_results/four_state_metrics.csv').toString().replaceAll('best_model.pth', 'other_model.pth')));
  if (fault === 'hash-mismatch') {
    const call = f.host.simpleSftpApiCall;
    f.host.simpleSftpApiCall = async (method, params) => {
      const response = await call(method, params);
      if (method === 'sync.downloadMappedPaths' && params.memoryOnly && response.entries.some(file => file.remotePath.endsWith('four_state_metrics.csv')))
        response.entries.find(file => file.remotePath.endsWith('four_state_metrics.csv')).dataBase64 = Buffer.from('tampered').toString('base64');
      return response;
    };
  }
  const report = await f.sync(); assert.ok(report.skipped.length || report.missing.length);
  assert.equal(f.registry().plans[planFile].wrapperEvidence.runId, 'A');
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'experiments/results/arbitrary_set/final/final.csv')), previous);
});

test('same revision rerun A to incomplete B produces isolated preview without lending old seeds', async () => {
  const f = fixture({ incomplete: true }); const report = await f.sync();
  assert.equal(f.registry().plans[planFile].wrapperEvidence.runId, 'A');
  assert.equal(report.previews[0].runId, 'B'); assert.equal(report.previews[0].completedJobs, 2);
  for (const file of report.previews[0].paths.filter(file => file.endsWith('.csv'))) {
    const csv = tables.readCsv(fs.readFileSync(path.join(f.root, file), 'utf8'));
    assert.ok(csv.rows.every(row => row[csv.header.indexOf('simple_run_id')] === 'B'));
    assert.ok(csv.rows.every(row => row[csv.header.indexOf('simple_seed')] !== '44'));
  }
  f.runs[1].jobs[2].status = 'completed'; await f.sync();
  assert.equal(f.registry().plans[planFile].wrapperEvidence.runId, 'B');
  assert.deepEqual(new Set(f.registry().plans[planFile].records.map(row => row.runId)), new Set(['B']));
});

test('repeated collection is byte-idempotent and never overwrites another attempt', async () => {
  const f = fixture(); f.runs.pop(); await f.sync();
  const previousSources = f.registry().plans[planFile].wrapperEvidence.jobs.flatMap(job => job.sources);
  for (const job of f.runs[0].jobs) job.artifacts = Object.fromEntries([...f.files].filter(([file]) => file.startsWith(job.outputDir + '/'))
    .map(([file, bytes]) => [file, sha(bytes)]));
  await f.sync();
  assert.deepEqual(f.registry().plans[planFile].wrapperEvidence.jobs.flatMap(job => job.sources), previousSources);
  for (const source of previousSources) assert.equal(fs.existsSync(path.join(f.root, source.localRelativePath)), false);
});

test('unchanged results are reread only in memory without retaining raw cache', async () => {
  const f = fixture(); await f.sync();
  f.calls.length = 0;
  const report = await f.sync();
  const transferred = f.calls.filter(call => call.method === 'sync.downloadMappedPaths').flatMap(call => call.params.entries);
  assert.equal(transferred.length, 21);
  assert.equal(report.downloaded, true);
  assert.ok(report.downloads[0].networkFiles > 0);
  assert.equal(report.downloads[0].reusedFiles, 0);
  assert.ok(f.calls.filter(call => call.method === 'sync.downloadMappedPaths').every(call => call.params.memoryOnly === true));
});

test('old SFTP cannot fall back to disk and leaves an existing summary unchanged', async () => {
  const f = fixture(); await f.sync();
  const before = fs.readFileSync(path.join(f.root, 'simple_cluster/results/project_table_registry.json'));
  f.calls.length = 0;
  f.host.simpleSftpCapability = async () => ({ methodOptions: { 'sync.downloadMappedPaths': { memoryOnly: true } } });
  const report = await f.sync();
  assert.ok(report.skipped.some(error => /全格式内存接收/.test(error)));
  assert.equal(f.calls.filter(call => call.method === 'sync.downloadMappedPaths').length, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'simple_cluster/results/project_table_registry.json')), before);
});

test('opening a malformed remote result uses an unsaved memory document and writes no local copy', async () => {
  const f = fixture(); await f.sync();
  const table = f.host.resultsSummary.workerResultTables[0], remotePath = table.rawResultCsvPath;
  const broken = Buffer.from('metric,value\n"broken'); f.files.set(remotePath, broken);
  f.host.filterResultsSummaryForPlan = summary => summary;
  f.host.client.downloadWorkerFile = () => { throw new Error('direct file download forbidden'); };
  const previousOpen = vscode.workspace.openTextDocument, previousShow = vscode.window.showTextDocument;
  const previousWarning = vscode.window.showWarningMessage;
  let opened;
  vscode.workspace.openTextDocument = async options => { assert.equal(typeof options.content, 'string'); opened = options; return options; };
  vscode.window.showTextDocument = async () => {};
  vscode.window.showWarningMessage = async (_message, _options, choice) => choice;
  try { await f.host.openResultArtifactFromUi({ planFile, remotePath, workerId: table.workerId }); }
  finally { vscode.workspace.openTextDocument = previousOpen; vscode.window.showTextDocument = previousShow; vscode.window.showWarningMessage = previousWarning; }
  assert.equal(opened.content, broken.toString());
  assert.equal(fs.existsSync(path.join(f.root, 'simple_cluster/downloads')), false);
  assert.ok(f.registry().plans[planFile].wrapperEvidence.jobs.every(job => job.sources.every(source => !fs.existsSync(path.join(f.root, source.localRelativePath)))));
});

test('endpoint and wrapper tables roll back together on transactional publication failure', async () => {
  const f = fixture(); const b = f.runs.pop(); await f.sync();
  const before = fs.readFileSync(path.join(f.root, 'simple_cluster/results/project_table_registry.json'));
  const previous = fs.readFileSync(path.join(f.root, 'experiments/results/arbitrary_set/final/final.csv'));
  const wrapperPath = f.registry().plans[planFile].wrapperEvidence.views[0];
  const previousWrapper = fs.readFileSync(path.join(f.root, wrapperPath));
  const oldVisible = { runId: 'A', marker: 'published' }; f.host.resultsSummary = oldVisible;
  f.runs.push(b);
  const publish = publication.publishProjectResultFiles;
  publication.publishProjectResultFiles = (root, dir, files, options) => publish(root, dir, files, { ...options,
    rename: async (from, to) => { if (from.endsWith('.new') && to.endsWith(path.join('final', 'final.csv'))) throw new Error('injected atomic failure'); return fs.promises.rename(from, to); } });
  try { await assert.rejects(f.sync(), /injected atomic failure/); }
  finally { publication.publishProjectResultFiles = publish; }
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'simple_cluster/results/project_table_registry.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'experiments/results/arbitrary_set/final/final.csv')), previous);
  assert.deepEqual(fs.readFileSync(path.join(f.root, wrapperPath)), previousWrapper);
  assert.equal(f.host.resultsSummary, oldVisible);
});

test('a first incomplete run has only an explicit preview and no formal endpoint table', async () => {
  const f = fixture({ incomplete: true }); f.runs.shift(); const report = await f.sync();
  assert.equal(report.previews[0].completedJobs, 2);
  assert.equal(fs.existsSync(path.join(f.root, 'experiments/results/arbitrary_set/final/final.csv')), false);
});

test('changed source hash cannot replace previously verified summary even without local originals', async () => {
  const f = fixture(); await f.sync();
  const evidence = f.registry().plans[planFile].wrapperEvidence;
  const source = evidence.jobs[0].sources.find(source => source.remotePath.endsWith('/custom.csv'));
  f.files.set(source.remotePath, Buffer.from(f.files.get(source.remotePath).toString().replace('NaN', '0.9')));
  const report = await f.sync();
  assert.ok(report.skipped.some(error => /历史原始指标已变化/.test(error)));
  assert.equal(f.registry().plans[planFile].wrapperEvidence.jobs[0].sources.find(row => row.remotePath === source.remotePath).sha256, source.sha256);
  assert.equal(fs.existsSync(path.join(f.root, source.localRelativePath)), false);
});

test('a legacy endpoint-only refresh cannot replace a complete wrapper bundle', async () => {
  const f = fixture(); await f.sync();
  const registry = f.registry(), summary = tables.registeredPlanSummary(registry, planFile);
  assert.equal(summary.results[0].jobDir, registry.plans[planFile].records[0].jobDir);
  const wrongRun = { ...summary, completedRunId: 'A', results: summary.results.map(row => ({ ...row, runId: 'A' })) };
  assert.throws(() => tables.mergeAvailableWorkerResults(registry, wrongRun, planFile, 3), /运行身份不一致/);
  assert.throws(() => tables.updateRegistry(registry, wrongRun, planFile, 3), /运行身份不一致/);
  delete summary.wrapperEvidence;
  assert.throws(() => tables.mergeAvailableWorkerResults(registry, summary, planFile, 3), /完整结果证明缺失/);
  assert.throws(() => tables.updateRegistry(registry, summary, planFile, 3), /完整结果证明缺失/);
});

test('wrapper declaration rejects out-of-job paths and retains unknown JSON without coercion', () => {
  assert.throws(() => bundle.declaredWrapperResults('{"outputs":["../../other.csv"]}', 'work_dirs/a/attempts/A'), /不安全/);
  assert.throws(() => bundle.declaredWrapperResults('{"outputs":["/other/a.csv"]}', 'work_dirs/a/attempts/A'), /不属于/);
  assert.deepEqual(bundle.declaredWrapperResults('{"outputs":["extra.parquet","test/custom.tsv"],"checkpoint_path":"best.pth"}', 'work_dirs/a/attempts/A'),
    ['work_dirs/a/attempts/A/extra.parquet', 'work_dirs/a/attempts/A/test/custom.tsv']);
});
