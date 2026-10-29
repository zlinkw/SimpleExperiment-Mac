// Item 85 UI consumption evidence. The panel functions that ask the host ring
// first when a GPU window changes, apply carried fine frames into the existing
// chart cache, and honestly fall back to the remote history request on an empty
// answer or an older host that never replies are exercised for real: the
// function bodies are extracted from the actual PanelHtml.legacy.ts script text,
// the rendered full script is parsed, and the routing/whitelist wiring is read
// from the same source. Request pairing is checked with a controllable timer:
// each answer may only consume its own still-valid requestId, never another
// window's pending request. Only the vscode transport and the chart scheduler
// are recorded stubs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript'), vm = require('node:vm');
require('../_helpers/registerTsRequire');

const source = fs.readFileSync(require.resolve('../../src/ui/PanelHtml.legacy.ts'), 'utf8');
assert.match(source, /if \(item\.type === "gpuWindowSamples"\) \{\s*applyGpuWindowSamples\(item\);/, 'the panel message router must dispatch gpuWindowSamples to the ring consumer');
assert.ok(source.includes('"manualGpuSnapshot", "loadGpuHistory", "gpuWindowSamples"'), 'gpuWindowSamples must be an allowed outgoing panel command');

function extractFunction(name) {
  const match = source.match(new RegExp('    function ' + name + '\\([\\s\\S]*?\\n    \\}\\n'));
  assert.ok(match, 'panel function ' + name + ' must exist in the real script');
  return match[0];
}
const code = ['"use strict";',
  extractFunction('lowTrafficModeFromState'), extractFunction('displayAutoAllowed'),
  extractFunction('gpuHistorySeriesKey'), extractFunction('gpuWindowFineWindowMs'),
  // The carried-frame consumer merges coarse and fine segments, so its real helpers belong to the
  // harness as well; otherwise the merge path would only be exercised by a stub.
  extractFunction('gpuHistorySegmentGapLimit'), extractFunction('historyExpectedStepFromSortedTimes'),
  extractFunction('mergeGpuHistorySegments'),
  extractFunction('requestGpuHistoryRemote'),
  extractFunction('applyGpuWindowSamples'), extractFunction('requestGpuHistory')].join('\n');
const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const posted = [], drawn = [], notices = [], timers = new Map(), cleared = [];
  let nextTimer = 1;
  const context = {
    posted, drawn, timers, cleared, Map, Number, Array, String, Math, Boolean, Object, Date,
    vscode: { postMessage: message => posted.push(message) },
    gpuWindowRequestSeq: 0, gpuWindowPending: new Map(), gpuWindowPendingByKey: new Map(),
    gpuHistorySeriesCache: new Map(), gpuHistoryRequestLastAt: new Map(),
    gpuHistoryMeta: {}, gpuHistorySeriesRevision: 0,
    GPU_HISTORY_GAP_FACTOR: 1.75,
    asArray: (value) => (Array.isArray(value) ? value : (!value || typeof value !== "object" ? [] : Object.values(value))),
    GPU_HISTORY_REQUEST_COOLDOWN_MS: 0, GPU_HISTORY_SERIES_CACHE_LIMIT: 8,
    scheduleGpuHistoryDraw: () => drawn.push(1),
    // Normal mode authority (no low-traffic frame): the automatic ring entry keeps its original
    // trajectory, and the guard hook is observable rather than missing.
    lastState: { trafficMode: { enabled: false, displayAutoRefresh: true } },
    tmuxDisplayAutoHint: true,
    renderDisplayAutoNotices: () => notices.push(1),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => { cleared.push(id); timers.delete(id); },
  };
  vm.runInNewContext(compiled, context);
  return {
    context, posted, drawn, notices, timers, cleared,
    fireTimeouts() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } },
  };
}

// Real reporting contract (not derived from this fixture):
// - the Worker emits fine GPU frames with an ISO `generatedAt` (src/runtime/GpuCollector.ts:415),
// - the host ring turns that into epoch-MILLISECONDS `collectedAt` (src/features/GpuSampleRing.ts:16,27,76),
// - the panel history pipeline stores epoch-SECONDS `bucketEpoch` (src/ui/PanelHtml.legacy.ts:11891
//   `Math.round(collectedAt / 1000)`), exactly like the coarse remote buckets
//   (src/clusterAgentRuntime.legacy.ts:2162 `epoch // BUCKET_SECONDS * BUCKET_SECONDS`, :2096 gmtime)
//   and like the panel's own window math (:12164 `latest - 24 * 3600`).
// So the fixture supplies the fine frame the way the Worker really reports it (ms) and stores the
// cached coarse bucket in the unit the pipeline actually uses (seconds).
const t0Ms = Date.now();
const t0 = Math.round(t0Ms / 1000);
const fineSample = { seq: 9, epoch: 'e2', collectedAt: t0Ms, source: 'worker_telemetry',
  gpus: [{ index: 0, memoryUsedMb: 3000, memoryTotalMb: 8192, utilizationPercent: 61 }, { index: 1, memoryUsedMb: 100, memoryTotalMb: 8192, utilizationPercent: 0 }] };

test('a GPU window request first asks the host ring for fine frames with a unique requestId instead of re-requesting remote history', () => {
  const h = harness();
  vm.runInNewContext('requestGpuHistory({ serverId: "srv1", gpuId: "0", maxPoints: 96 });', h.context);
  assert.deepEqual(h.posted.map(m => m.command), ['gpuWindowSamples'], 'the window switch sends only the host ring query first');
  const query = h.posted[0];
  assert.equal(query.workerId, 'srv1');
  assert.equal(query.requestId, 1, 'the request carries its exact pairing identity');
  assert.ok(query.end - query.start === 96 * 60000, 'the requested window matches the chart window span');
});

test('answers are consumed only by their own request: out-of-order windows, wrong identity, duplicates and worker mismatch never touch another pending entry', () => {
  const h = harness();
  vm.runInNewContext('requestGpuHistory({ serverId: "srv1", gpuId: "0" }); requestGpuHistory({ serverId: "srv2", gpuId: "0" });', h.context);
  assert.deepEqual(h.posted.map(m => [m.command, m.workerId, m.requestId]), [['gpuWindowSamples', 'srv1', 1], ['gpuWindowSamples', 'srv2', 2]]);
  // The SECOND window answers first, and a mismatched/duplicate answer arrives too.
  vm.runInNewContext('applyGpuWindowSamples({ requestId: 2, workerId: "srv2", samples: SAMPLES });', Object.assign(h.context, { SAMPLES: [fineSample] }));
  vm.runInNewContext('applyGpuWindowSamples({ requestId: 2, workerId: "srv2", samples: SAMPLES });', h.context);
  vm.runInNewContext('applyGpuWindowSamples({ requestId: 99, workerId: "srv1", samples: SAMPLES });', h.context);
  vm.runInNewContext('applyGpuWindowSamples({ requestId: 1, workerId: "srv2", samples: SAMPLES });', h.context);
  assert.deepEqual(h.posted.map(m => m.command), ['gpuWindowSamples', 'gpuWindowSamples'], 'no remote history fired and the first window stayed pending');
  assert.equal(h.context.gpuHistorySeriesCache.get('srv2::0').points.length, 1, 'only the answered window received its fine frames');
  assert.equal(h.context.gpuHistorySeriesCache.has('srv1::0'), false, 'the other window was not polluted by the mismatched answers');
  // The still-valid first request times out and falls back with ITS payload.
  h.fireTimeouts();
  assert.deepEqual(h.posted.slice(2).map(m => [m.command, m.serverId]), [['loadGpuHistory', 'srv1']], 'the pending window falls back exactly once for its own payload');
  // Its answer finally arrives late: the request already fell back, so it must not re-apply or double-fire.
  const before = h.posted.length;
  vm.runInNewContext('applyGpuWindowSamples({ requestId: 1, workerId: "srv1", samples: SAMPLES });', h.context);
  assert.equal(h.posted.length, before, 'a late answer after the fallback changes nothing');
  h.fireTimeouts();
  assert.equal(h.posted.length, before, 'no second fallback fired');
});

test('carried fine frames update the existing chart series (keeping older coarse history intact) without any remote request', () => {
  const h = harness();
  vm.runInNewContext('requestGpuHistory({ serverId: "srv1", gpuId: "0", maxPoints: 96 });', h.context);
  const coarse = { serverId: 'srv1', gpuId: '0', points: [{ bucketEpoch: t0 - 7200, gpuUtilPercent: 10, memoryUsedMb: 1, memoryTotalMb: 8192, imputed: false }] };
  h.context.gpuHistorySeriesCache.set('srv1::0', coarse);
  vm.runInNewContext('applyGpuWindowSamples({ requestId: 1, workerId: "srv1", samples: SAMPLES });', Object.assign(h.context, { SAMPLES: [fineSample] }));
  assert.deepEqual(h.posted.map(m => m.command), ['gpuWindowSamples'], 'no duplicate remote history request happened for the fine window');
  assert.equal(h.timers.size, 0, 'the answered request cancelled its own fallback timer');
  const series = h.context.gpuHistorySeriesCache.get('srv1::0');
  assert.equal(series.points.length, 2, 'the older coarse frame is kept and the fine frame added, nothing synthesized');
  assert.equal(series.points[1].bucketEpoch, t0, 'the fine frame keeps the Worker collected time');
  assert.equal(series.points[1].gpuUtilPercent, 61, 'the fine frame feeds the chart point shape');
  assert.equal(h.drawn.length, 1, 'the chart is redrawn from the merged cache');
  assert.equal(h.context.gpuHistorySeriesRevision, 1);
  assert.ok(h.context.gpuHistorySeriesCache.get('srv1::1').points[0].bucketEpoch === t0, 'both carried GPUs are applied');
});

test('a new request for the same window replaces and cancels the previous timer, and its late answer is ignored', () => {
  const h = harness();
  vm.runInNewContext('requestGpuHistory({ serverId: "srv1", gpuId: "0" });', h.context);
  vm.runInNewContext('requestGpuHistory({ serverId: "srv1", gpuId: "0" });', h.context);
  assert.equal(h.cleared.length, 1, 'the replaced request had its fallback timer cancelled');
  assert.deepEqual(h.posted.map(m => m.requestId), [1, 2]);
  vm.runInNewContext('applyGpuWindowSamples({ requestId: 1, workerId: "srv1", samples: SAMPLES });', Object.assign(h.context, { SAMPLES: [fineSample] }));
  assert.equal(h.context.gpuHistorySeriesCache.size, 0, 'the superseded answer applied nothing');
  h.fireTimeouts();
  assert.deepEqual(h.posted.slice(2).map(m => m.command), ['loadGpuHistory'], 'only the current request falls back, once');
});

test('an empty ring answer and an older host that never answers both fall back to the existing remote history request exactly once', () => {
  const empty = harness();
  vm.runInNewContext('requestGpuHistory({ serverId: "srv1", gpuId: "0", maxPoints: 96 });', empty.context);
  vm.runInNewContext('applyGpuWindowSamples({ requestId: 1, workerId: "srv1", samples: [] });', empty.context);
  assert.deepEqual(empty.posted.map(m => m.command), ['gpuWindowSamples', 'loadGpuHistory'], 'empty ring answer honestly falls back to remote history for the same window');
  assert.equal(empty.timers.size, 0, 'the consumed request left no timer behind');
  empty.fireTimeouts();
  assert.equal(empty.posted.filter(m => m.command === 'loadGpuHistory').length, 1, 'the bounded single fallback stayed single');
  const oldHost = harness();
  vm.runInNewContext('requestGpuHistory({ serverId: "srv1", gpuId: "0", maxPoints: 96 });', oldHost.context);
  assert.deepEqual(oldHost.posted.map(m => m.command), ['gpuWindowSamples']);
  oldHost.fireTimeouts();
  assert.deepEqual(oldHost.posted.map(m => m.command), ['gpuWindowSamples', 'loadGpuHistory'], 'an old host without the ring handler still gets its history after the bounded wait');
  const overview = harness();
  vm.runInNewContext('requestGpuHistory({ maxPoints: 96 });', overview.context);
  assert.deepEqual(overview.posted.map(m => m.command), ['loadGpuHistory'], 'overview requests without a Worker keep the old remote path');
});

test('the full rendered panel script parses after the outer template strip (P0 gate)', () => {
  const Module = require('node:module');
  const path = require('node:path');
  const sourcePath = path.resolve(__dirname, '../../src/ui/PanelHtml.legacy.ts');
  const codeText = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(codeText, sourcePath);
  const html = loaded.exports.renderPanelHtml();
  const expression = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match, count = 0;
  while ((match = expression.exec(html))) { new vm.Script(match[1], { filename: 'panel-script-' + ++count }); }
  assert.ok(count > 0 && /gpuWindowSamples/.test(html), 'the rendered script contains the ring wiring and parses');
});
