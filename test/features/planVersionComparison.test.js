const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const vm = require('node:vm');
const comparison = require('../../dist/results/PlanVersionComparison');
const retention = require('../../dist/features/PlanOutputRetention');
const freshness = require('../../dist/results/PlanRunFreshness');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const vscode = { workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  extensions: { getExtension: () => ({ extensionPath: path.resolve(__dirname, '../..'), packageJSON: require('../../package.json') }) },
  Uri: { file: fsPath => ({ fsPath }) }, ProgressLocation: { Notification: 1 },
  window: { withProgress: () => { throw new Error('review must use its own page, not a notification'); } } };
const originalLoad = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
const { RealtimeTunnelPanelProvider } = require('../../dist/extension/legacy');
Module._load = originalLoad;
const planFile = 'experiments/plans/any.yaml';

test('statistical comparison uses mean±std with four decimals without rounding source data or filling missing values', () => {
  const source = { header: ['method', 'auc_mean', 'auc_sd', 'loss_mean', 'loss_std', 'jobs'],
    rows: [['one', .82020651, .0095486, .1, ' ', 3], ['two', '', '', .53218, .02553, 3]] };
  const before = JSON.stringify(source);
  const view = comparison.statisticsComparisonView(source);
  assert.deepEqual(view.header, ['method', 'auc', 'loss', 'jobs']);
  assert.deepEqual(view.rows, [['one', '0.8202±0.0095', '0.1000±未计算', 3], ['two', '未计算±未计算', '0.5322±0.0255', 3]]);
  assert.equal(JSON.stringify(source), before);
});

test('one table per Plan aligns version statistics across datasets and schemas without preview or old-seed mixing', () => {
  const runs = ['A', 'B', 'preview', 'error', 'other'].map(runId => ({ runId, planFile: runId === 'other' ? 'other.yaml' : planFile }));
  const view = (dataset, header, rows) => ({ title: dataset + ' / results/' + dataset + '/final.csv', header, rows });
  const results = new Map([
    ['A', { status: 'formal', views: [view('BUS', ['method', 'auc', 'jobs'], [['dpl', '0.8100±0.0100', 3]]),
      view('PAD', ['method', 'auc'], [['dpl', '0.8200±0.0200']])] }],
    ['B', { status: 'formal', views: [view('BUS', ['method', 'jobs', 'loss', 'auc'], [['dpl', 3, '0.1200±0.0200', '0.9200±0.0300']])] }],
    ['preview', { status: 'preview', views: [view('BUS', ['method', 'auc'], [['dpl', '0.9900±0.0000']])] }],
  ]);
  const before = JSON.stringify([...results]), tables = comparison.planComparisonTables(runs, results);
  assert.equal(tables.length, 2);
  const table = tables[0];
  assert.deepEqual(table.rows.map(row => row.runId), ['A', 'B', 'preview', 'error']);
  const auc = table.columns.findIndex(column => column.label === 'BUS / dpl / auc');
  assert.equal(table.rows[0].values[auc], '0.8100±0.0100');
  assert.equal(table.rows[1].values[auc], '0.9200±0.0300');
  const pad = table.columns.findIndex(column => column.label === 'PAD / dpl / auc');
  assert.equal(table.rows[1].values[pad], '—');
  assert.ok(table.rows.slice(2).every(row => row.values.every(value => value === '—')));
  assert.equal(tables[1].rows[0].runId, 'other');
  assert.equal(JSON.stringify([...results]), before);
});

function fixture({ incomplete = false, fault = '' } = {}) {
  // A nonexistent workspace makes any disk write a regression; no test cleanup is needed.
  const root = path.join(os.tmpdir(), 'comparison-no-files-' + crypto.randomUUID());
  const files = new Map(), calls = [], queue = { schemaVersion: 1, plans: [] };
  for (const [id, value] of [['A', .81], ['B', .92]]) {
    const plan = { id, planFile, revision: 'same-config', codeFingerprint: 'code-' + id,
      enqueuedAt: id === 'A' ? '2026-10-01T00:00:00Z' : '2026-10-02T00:00:00Z', fullPlanJobCount: 3, planJobCount: 3, jobs: [] };
    for (const [index, seed] of [42, 43, 44].entries()) {
      const outputDir = `work_dirs/any/${seed}/attempts/${id}`, checkpoint = outputDir + '/best_model.pth';
      const raw = outputDir + '/test_results/formal_result_rows.csv';
      const csv = `case,seed,method,dataset,metric,value,checkpoint_path,job_dir,run_id\none,${seed},method,arbitrary,AUC,${value},${checkpoint},${outputDir},${id}\n`;
      files.set(raw, Buffer.from(csv));
      files.set(outputDir + '/custom.tsv', Buffer.from('label\tnote\ncase,one\t"保留\n多行"\n'));
      files.set(outputDir + '/test_results/four_state_metrics.csv', Buffer.from('state,metric,value,p0_value,delta_p100_minus_p0,sample_count,checkpoint_path,job_dir,seed,method,dataset,undefined_reason,p0_undefined_reason\n'
        + ['both', 'image_missing', 'text_missing', 'both_missing'].map(state => `${state},AUC,${value},0.7,${value - .7},210,${checkpoint},${outputDir},${seed},method,arbitrary,,`).join('\n') + '\n'));
      files.set(outputDir + '/custom.jsonl', Buffer.from('{"arbitrary":[1,null,"未知字段"]}\n'));
      files.set(outputDir + '/config.yaml', Buffer.from('case: untouched\n'));
      files.set(outputDir + '/mask.npz', Buffer.from([0, 255, 3, 9]));
      files.set(outputDir + '/artifact_manifest.json', Buffer.from(JSON.stringify({ output_dir: outputDir, checkpoint_path: checkpoint,
        metrics_summary: raw, outputs: ['custom.tsv', 'custom.jsonl', 'config.yaml', 'mask.npz', 'test_results/four_state_metrics.csv'] })));
      plan.jobs.push({ index, case: 'one', seed, attempt: 1, commandId: id + '-' + seed, workerId: 'worker', outputDir,
        status: incomplete && id === 'B' && seed === 44 ? 'running' : 'completed',
        artifacts: { [checkpoint]: 'a'.repeat(64), [raw]: sha(csv) } });
    }
    queue.plans.push(plan);
  }
  if (fault === 'missing') files.delete(queue.plans[0].jobs[0].outputDir + '/custom.tsv');
  if (fault === 'identity') {
    const target = queue.plans[0].jobs[0].outputDir + '/custom.jsonl';
    files.set(target, Buffer.from('{"run_id":"B","seed":42}\n'));
  }
  const host = Object.create(RealtimeTunnelPanelProvider.prototype);
  const forbidden = async () => { throw new Error('review attempted a publication or mutation'); };
  Object.assign(host, { client: {}, resultCsvDirectory: 'experiments/results',
    captureProjectContext: () => ({ root, generation: 1, signal: new AbortController().signal }), projectContextIsCurrent: () => true,
    localPlanMetadata: { plans: [{ planFile, revision: 'same-config', seeds: [42, 43, 44], cases: ['one'] }], detectedProject: { adapterRules: {} } },
    loadPlanOutputRetentionQueue: async () => queue, loadProjectTableRegistry: forbidden,
    writeProjectTableRegistry: forbidden, saveDistributedQueue: forbidden,
    enabledWorkerConfigs: () => [{ id: 'worker' }],
    mappedDownloadServerForSource: id => ({ id }),
    simpleSftpCapability: async () => ({ methodOptions: { 'sync.downloadMappedPaths': { memoryOnly: true, memoryWrapperResults: true } } }),
    simpleSftpApiCall: async (method, params) => {
      calls.push({ method, params });
      assert.equal(params.signal.aborted, false);
      if (method === 'sync.projectInventory') return { ok: true, files: Object.fromEntries(params.scopePaths.filter(file => files.has(file))
        .map(file => [file, { size: files.get(file).length, sha256: sha(files.get(file)) }])) };
      assert.equal(method, 'sync.downloadMappedPaths'); assert.equal(params.memoryOnly, true); assert.equal(params.wrapperResults, true);
      return { memoryOnly: true, ok: true, entries: params.entries.map(entry => ({ remotePath: entry.remotePath, sha256: entry.sha256,
        bytes: entry.bytes, dataBase64: (fault === 'hash' ? Buffer.alloc(entry.bytes) : files.get(entry.remotePath)).toString('base64') })) };
    } });
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root, scheme: 'file', path: root } }];
  const candidates = queue.plans[0].jobs.map(job => ({ outputDir: job.outputDir, planFile, replacementRunId: 'B', workerIds: ['worker'], type: 'directory' }));
  const runs = comparison.comparisonRuns(queue, candidates);
  const load = run => host.loadPlanVersionComparison(root, queue, run, new AbortController().signal);
  return { root, files, queue, calls, candidates, runs, host, load };
}

test('same revision A to B rebuilds all wrapper formats in memory without changing published/local results', async () => {
  const f = fixture(); const before = [...f.files].map(([file, bytes]) => [file, sha(bytes)]);
  for (const id of ['A', 'B']) {
    const result = await f.load(f.runs.find(run => run.runId === id));
    assert.equal(result.status, 'formal'); assert.equal(result.sources.length, 3);
    const all = JSON.stringify(result);
    assert.match(all, /custom.tsv/); assert.match(all, /保留/); assert.match(all, /config.yaml/); assert.match(all, /mask.npz/);
    const four = result.views.find(view => view.title.includes('four_state_metrics.csv'));
    assert.equal(four.rows.length, 12);
    assert.ok(['state', 'metric', 'value', 'p0_value', 'delta_p100_minus_p0', 'sample_count', 'checkpoint_path', 'job_dir', 'undefined_reason'].every(name => four.header.includes(name)));
    assert.ok(result.sources.every(source => source.job.runId === id && source.checkpointPath.includes('/attempts/' + id)));
    const raw = result.views.find(view => view.title.includes('formal_result_rows.csv'));
    assert.ok(raw.rows.every(row => row[raw.header.indexOf('simple_run_id')] === id));
    const final = result.views.find(view => view.title.endsWith('/final.csv'));
    assert.ok(final, 'existing statistics interface builds a version-local final table');
    assert.ok(JSON.stringify(final).includes(id === 'A' ? '0.81' : '0.92'));
  }
  assert.deepEqual([...f.files].map(([file, bytes]) => [file, sha(bytes)]), before);
  assert.equal(fs.existsSync(f.root), false, 'no raw, provenance, table, journal or staging file may be created');
  assert.ok(f.calls.every(call => ['sync.projectInventory', 'sync.downloadMappedPaths'].includes(call.method)));
});

test('incomplete seeds form an explicit separate preview, never an old-seed formal table', async () => {
  const f = fixture({ incomplete: true }); const run = f.runs.find(run => run.runId === 'B');
  assert.equal(run.eligible, false);
  const result = await f.load(run);
  assert.equal(result.status, 'preview'); assert.equal(result.sources.length, 2);
  assert.ok(!result.views.some(view => view.title.endsWith('/final.csv')));
  assert.ok(result.sources.every(source => source.job.seed !== 44 && source.job.runId === 'B'));
  assert.equal(fs.existsSync(f.root), false);
});

for (const fault of ['missing', 'hash', 'identity']) test(`review ${fault} failure preserves the run and creates no files`, async () => {
  const f = fixture({ fault });
  await assert.rejects(f.load(f.runs.find(run => run.runId === 'A')), /缺失|不一致|不符|不匹配|尚未核验|失败/);
  assert.equal(fs.existsSync(f.root), false);
});

test('repeated comparison is idempotent; unavailable memory capability has no disk fallback', async () => {
  const f = fixture(); const run = f.runs.find(run => run.runId === 'A');
  assert.deepEqual(await f.load(run), await f.load(run));
  f.host.simpleSftpCapability = async () => ({ methodOptions: { 'sync.downloadMappedPaths': { memoryOnly: true } } });
  await assert.rejects(f.load(run), /SimpleSFTP|清单|核验|文件/);
  assert.equal(fs.existsSync(f.root), false);
});

test('retention selection excludes retained/latest/active runs and unverified results', async () => {
  const f = fixture(); const a = f.runs.find(run => run.runId === 'A'), b = f.runs.find(run => run.runId === 'B');
  const results = new Map([['A', await f.load(a)], ['B', await f.load(b)]]);
  assert.equal(b.eligible, false);
  assert.throws(() => comparison.selectedComparisonCandidates(f.runs, results, ['B'], f.candidates), /选择/);
  assert.throws(() => comparison.selectedComparisonCandidates(f.runs, new Map(), ['A'], f.candidates), /选择/);
  assert.throws(() => comparison.selectedComparisonCandidates(f.runs, results, ['A', 'A'], f.candidates), /选择/);
  assert.equal(comparison.selectedComparisonCandidates(f.runs, results, ['A'], f.candidates).length, 3);
  assert.equal(freshness.selectLatestCompletePlanRunIdentity(f.queue, planFile).runId, 'B');
});

test('queue identity detects submitted versions/attempts, but permits our own retirement receipts', () => {
  const f = fixture(); const initial = comparison.comparisonQueueIdentity(f.queue);
  const retired = retention.markOutputsRetired(f.queue, f.candidates[0], 'now');
  assert.equal(comparison.comparisonQueueIdentity(retired), initial);
  retired.plans[0].jobs[1].commandId = 'changed';
  assert.notEqual(comparison.comparisonQueueIdentity(retired), initial);
});

function reviewPanel() {
  let handler, disposed, html, isDisposed = false;
  const messages = [];
  const panel = { webview: { set html(value) { html = value; }, postMessage: async message => { messages.push(message); },
    onDidReceiveMessage: callback => { handler = callback; return { dispose() {} }; } },
    onDidDispose: callback => { disposed = callback; return { dispose() {} }; },
    dispose: () => { if (!isDisposed) { isDisposed = true; disposed(); } } };
  const module = { exports: {} };
  const compiledRequire = Module.createRequire(require.resolve('../../dist/features/SyncScopeConfirmation'));
  vm.runInNewContext(fs.readFileSync(require.resolve('../../dist/features/SyncScopeConfirmation'), 'utf8'), {
    require: id => id === 'vscode' ? { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } } : compiledRequire(id),
    module, exports: module.exports, AbortController, Buffer,
  });
  return { api: module.exports, panel, messages, send: message => handler(message), html: () => html };
}

test('review page shows results, defaults to keep, validates selection and releases on close', async () => {
  const f = fixture(), ui = reviewPanel(); let signal;
  const pending = ui.api.reviewPlanVersionResults(f.runs, f.candidates, async (run, abort) => { signal = abort; return f.load(run); });
  for (const script of ui.html().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
  assert.match(ui.html(), /check.checked=true/); assert.doesNotMatch(ui.html(), /setState|writeFile|download=/);
  await ui.send({ type: 'ready' });
  assert.equal(ui.messages.filter(m => m.type === 'result').length, 2);
  await ui.send({ type: 'select', runIds: ['B'] });
  assert.equal(signal.aborted, false); assert.equal(ui.messages.at(-1).type, 'error');
  await ui.send({ type: 'select', runIds: ['A'] });
  assert.equal((await pending).length, 3); assert.equal(signal.aborted, true);
  const messageCount = ui.messages.length;
  await ui.send({ type: 'ready' }); assert.equal(ui.messages.length, messageCount);
});

test('rendered review keeps one Plan table and one stable selectable row per run while results arrive', async () => {
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.children = []; this.dataset = {}; this._text = text; }
    append(...nodes) { for (const node of nodes) { const item = typeof node === 'string' ? new Element('#text', node) : node; item.remove(); item.parent = this; this.children.push(item); } }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined; }
    insertBefore(node, before) { node.remove(); node.parent = this; this.children.splice(this.children.indexOf(before), 0, node); }
    replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this._text = ''; this.append(...nodes); }
    setAttribute(name, value) { this[name] = value; }
    get firstChild() { return this.children[0]; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
  }
  const ui = reviewPanel(), f = fixture(), a = f.runs.find(run => run.runId === 'A'), b = f.runs.find(run => run.runId === 'B');
  const preview = { ...a, runId: 'preview', eligible: false }, error = { ...a, runId: 'error', eligible: false };
  const other = { ...a, runId: 'other', planFile: 'other.yaml' }, runs = [a, b, preview, error, other];
  const pending = ui.api.reviewPlanVersionResults(runs, [], async () => { throw Error('unused'); });
  const ids = new Map(['runs', 'status', 'cancel', 'continue'].map(id => [id, new Element('div')]));
  const sent = []; let receive;
  vm.runInNewContext([...ui.html().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)][0][1], {
    document: { createElement: tag => new Element(tag), getElementById: id => ids.get(id) },
    window: { addEventListener: (_name, handler) => { receive = handler; } }, acquireVsCodeApi: () => ({ postMessage: message => sent.push(message) }),
  });
  const results = new Map(), message = data => receive({ data });
  message({ type: 'runs', runs, tables: comparison.planComparisonTables(runs, results) });
  const sections = ids.get('runs').children;
  assert.equal(sections.length, 2);
  const table = sections[0].children[1].firstChild, rows = table.children[1].children;
  assert.equal(table.className, 'plan-table'); assert.equal(rows.length, 4);
  const check = rows[0].children[0].firstChild.firstChild, detail = rows[0].children.at(-1).firstChild;
  assert.equal(check.checked, true); assert.equal(check.disabled, true);
  const result = await f.load(a); results.set('A', result);
  message({ type: 'result', result, tables: comparison.planComparisonTables(runs, results) });
  check.checked = false; detail.open = true;
  const newer = await f.load(b); results.set('B', newer);
  message({ type: 'result', result: newer, tables: comparison.planComparisonTables(runs, results) });
  assert.equal(rows[0].children[0].firstChild.firstChild, check); assert.equal(check.checked, false);
  assert.equal(rows[0].children.at(-1).firstChild, detail); assert.equal(detail.open, true);
  assert.equal(check.disabled, false); assert.equal(rows[1].children[0].firstChild.firstChild.disabled, true);
  assert.match(rows[0].textContent, /0.8100±0.0000/); assert.match(rows[1].textContent, /0.9200±0.0000/);
  message({ type: 'runError', runId: 'error', message: 'CSV 引号格式无效' });
  message({ type: 'result', result: { runId: 'preview', status: 'preview', views: [], sources: [] }, tables: comparison.planComparisonTables(runs, results) });
  assert.match(rows[2].textContent, /未完成预览/); assert.match(rows[3].textContent, /CSV 引号格式无效/);
  message({ type: 'loaded' }); assert.equal(ids.get('continue').disabled, false);
  ids.get('continue').onclick(); assert.deepEqual(Array.from(sent.at(-1).runIds), ['A']);
  ui.panel.dispose(); assert.equal(await pending, undefined);
});

test('closing during reconstruction aborts reads and ignores the late response', async () => {
  const f = fixture(), ui = reviewPanel(); let signal, release;
  const pending = ui.api.reviewPlanVersionResults(f.runs, f.candidates, async (_run, abort) => {
    signal = abort; return new Promise(resolve => { release = resolve; });
  });
  const loading = ui.send({ type: 'ready' });
  ui.panel.dispose(); assert.equal(await pending, undefined); assert.equal(signal.aborted, true);
  release({ runId: 'A', status: 'formal', views: [], sources: [] }); await loading;
  assert.equal(ui.messages.filter(message => message.type === 'result').length, 0);
});
