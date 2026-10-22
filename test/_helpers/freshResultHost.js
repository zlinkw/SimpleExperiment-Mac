const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const { ResultCollectionHost } = require('../../src/extension/ResultCollectionHost.ts');
const { resultDigest } = require('../../src/results/FreshResults.ts');
const planFile = 'experiments/plans/demo.yaml', planText = 'suite: demo\nmode: test\nseeds: [42,43]\n';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-fresh-results-'));
  fs.mkdirSync(path.join(root, 'experiments/plans'), { recursive: true }); fs.writeFileSync(path.join(root, planFile), planText, 'utf8');
  const declaration = { index: 0, case: 'alpha', seed: 42, output_dir: 'work_dirs/alpha42', result_csv: 'work_dirs/alpha42/metrics.csv', planHash: resultDigest(planText) };
  const manifest = JSON.stringify({ simpleExperiment: { runId: 'command', status: 'completed', mode: 'test', job: { index: 0, case: 'alpha', seed: 42 }, outputDir: declaration.output_dir, resultCsv: declaration.result_csv, weights: [] } });
  const raw = { [declaration.output_dir + '/artifact_manifest.json']: manifest, [declaration.result_csv]: '0.5' };
  const calls = [], worker = { id: 'a', host: 'configured-host', port: 222, user: 'exp', remotePath: '/configured/project' };
  let offline = false, gone = false, failTransfer = false, protocol = 1, release;
  const host = { panelDisposed: false, resultCsvDirectory: 'experiments/results',
    hostOperationLease: { run: () => assert.fail('result publication must not use persistent operation/lease records') },
    captureProjectContext: () => ({ root }), projectContextIsCurrent: () => true, workerCodeSyncTargets: () => [worker],
    currentResultPlanInputs: async () => [{ planFile, revision: resultDigest(planText), mode: 'test', seeds: [42,43], jobCount: 2 }],
    resultAdapterRules: () => ({}), parseFreshResultMetric: text => [{ dimensions: { case: 'alpha', seed: '42', dataset: 'set', method: 'demo' }, metrics: { auc: Number(text) } }],
    client: { getWorkerTasks: async (id, options) => {
      calls.push(['tasks', id, options]); assert.equal(id, 'a'); assert.equal(options.queries?.length || 0, 0);
      if (offline) throw Error('offline'); if (release) await release;
      if (options.discovery) return { queryComplete: true, capabilities: { resultCollection: protocol }, declaredJobs: [declaration] };
      return { queryComplete: true, capabilities: { resultCollection: protocol }, tasks: [], declaredResults: gone
        ? [{ index: 0, outputDir: declaration.output_dir, completed: false, resultState: 'missing' }]
        : [{ index: 0, outputDir: declaration.output_dir, completed: true, runId: 'command',
          runtimeDiagnostics:{schemaVersion:1,commandId:'command',runId:'command',state:'clear',count:0,scanComplete:true},
          files: Object.entries(raw).map(([remotePath, text]) => ({ remotePath, bytes: Buffer.byteLength(text), sha256: resultDigest(text) })) }] };
    } },
    simpleSftpCapability: async () => ({ methodOptions: { 'sync.downloadMappedPaths': { memoryOnly: true, memoryWrapperResults: true } } }),
    sftpServerOptions: row => row,
    simpleSftpApiCall: async (method, params) => {
      calls.push([method, params]); assert.equal(method, 'sync.downloadMappedPaths');
      assert.equal(params.memoryOnly, true); assert.equal(params.metricsOnly, true); assert.equal(params.server.remotePath, '/configured/project');
      if (failTransfer) throw Error('transfer interrupted');
      return { ok: true, memoryOnly: true, entries: params.entries.map(entry => ({ remotePath: entry.remotePath, bytes: entry.bytes, sha256: entry.sha256, dataBase64: Buffer.from(raw[entry.remotePath]).toString('base64') })) };
    }, refreshLocalResultCatalogForProject: async () => {}, postState() {}, recordActionError() {},
    loadDistributedQueue: () => assert.fail('queue must not supply results'), loadPlanSyncLedger: () => assert.fail('ledger must not supply results'),
    loadProjectTableRegistry: () => assert.fail('registry must not supply results'),
  };
  const service = new ResultCollectionHost(host);
  return { root, host, service, calls, raw, offline: value => { offline = value; }, gone: value => { gone = value; }, protocol: value => { protocol = value; }, failTransfer: value => { failTransfer = value; }, block: promise => { release = promise; } };
}

module.exports={fixture,planFile,planText};
