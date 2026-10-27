const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");
const { compactGpuHistoryResponse } = require("../../dist/features/GpuHistoryState.js");

// Requirement regression for task ui-plan-gpu-progress-20261024, item 3:
// "GPU history curves (per-GPU and overview) render complete, then turn into
// scattered points."  Same proven harness as gpuHistoryChartBehavior.test.js:
// the shipped inline panel functions run in one vm context over the shipped
// compaction path, so this drives the real chain
// compactGpuHistoryResponse -> rememberGpuHistoryState -> applyGpuWindowSamples
// -> gpuHistoryTimeRange -> drawHistoryLine segmentation/x-placement.
//
// Proven facts this fixture pins (do not "fix" the product by editing here):
//  - GpuHistoryState.legacy.ts compactPoint: remote bucketEpoch is SECONDS
//    (timestamp fallback new Date(bucketEpoch * 1000)); missing gapBefore -> null.
//  - GpuSampleRing.ts: ring frames carry collectedAt = Date.parse(generatedAt)
//    (MILLISECONDS).
//  - applyGpuWindowSamples stores bucketEpoch = collectedAt (ms) verbatim into
//    the same series that remote seconds points live in.
//  - gpuHistoryTimeRange clamps min to max - 24*3600 and drawGpuHistoryCanvas
//    filters points below windowStart, so a mixed units series loses every
//    coarse point and compresses fine points onto a few x pixels.
//  - Independently of units, historyPointStartsGap falls back to the merged
//    series median (historyExpectedStepFromSortedTimes) when gapBefore is null:
//    seconds-scale fine frames collapse the threshold below the coarse step.

function inlineFunction(name) {
  const html = renderPanelHtml();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((candidate) => candidate.includes("function " + name + "(")) || "";
  const start = script.indexOf("function " + name + "(");
  assert.notEqual(start, -1, "missing inline function " + name);
  const bodyStart = script.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < script.length; index += 1) {
    const char = script[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    // Skip comments so apostrophes inside prose (e.g. "window's") cannot
    // open a fake string and desynchronize the brace depth counter.
    if (char === "/" && script[index + 1] === "/") {
      const newline = script.indexOf("\n", index);
      index = newline === -1 ? script.length : newline;
      continue;
    }
    if (char === "/" && script[index + 1] === "*") {
      const end = script.indexOf("*/", index + 2);
      index = end === -1 ? script.length : end + 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return script.slice(start, index + 1);
  }
  throw new Error("unclosed inline function " + name);
}

const FUNCTION_NAMES = [
  "historyExpectedStepFromSortedTimes", "historyPointStartsGap", "gpuHistoryPointIndex",
  "finiteHistoryPercent", "gpuHistoryTimeTransform", "gpuHistoryTimeRange", "drawHistoryLine",
  "gpuHistorySeriesKey", "rememberGpuHistoryState", "applyGpuWindowSamples",
  "mergeGpuHistorySegments", "gpuHistorySegmentGapLimit",
  "gpuHistorySeriesFor", "gpuHistoryOverviewSeries",
];

function chartContext() {
  const context = {
    GPU_HISTORY_GAP_FACTOR: 1.75,
    GPU_HISTORY_SERIES_CACHE_LIMIT: 8,
    gpuHistoryMeta: {},
    gpuHistorySeriesCache: new Map(),
    gpuHistorySeriesRevision: 0,
    gpuHistoryLastStateStatus: "idle",
    expandedGpuHistoryKeys: new Set(),
    gpuHistoryRequestLastAt: new Map(),
    gpuWindowPending: new Map(),
    gpuWindowPendingByKey: new Map(),
    gpuWindowRequestSeq: 0,
    gpuHistoryOverviewCacheRevision: -1,
    gpuHistoryOverviewCacheState: null,
    gpuHistoryOverviewCacheServers: null,
    gpuHistoryOverviewCacheValue: [],
    gpuHistoryPointIndexCache: new WeakMap(),
    setTimeout: () => 0,
    clearTimeout: () => 0,
    scheduleGpuHistoryDraw: () => {},
    requestGpuHistoryRemote: () => {},
    asArray(value) { return Array.isArray(value) ? value : []; },
    gpuServerDisplayName(_state, server) { return server.serverId; },
  };
  vm.runInNewContext(FUNCTION_NAMES.map(inlineFunction).join("\n"), context);
  return context;
}

const T0 = 1_730_000_000; // fixed epoch seconds for determinism
const COARSE_STEP = 300;
const FINE_STEP = 15;
const PLOT = { left: 36, right: 46, top: 12, bottom: 24 };
const WIDTH = 640;
const HEIGHT = 190;

function coarseRawPoints(count, gapBeforeValue) {
  return Array.from({ length: count }, (_, index) => ({
    bucketEpoch: T0 + index * COARSE_STEP,
    gpuUtilPercent: 40 + (index % 7),
    memoryUtilPercent: 50,
    memoryUsedMb: 8000,
    memoryTotalMb: 16384,
    ...(gapBeforeValue === undefined ? {} : { gapBefore: gapBeforeValue }),
    imputed: false,
  }));
}

// Ring frames exactly as gpuWindowSamplesFromUi answers them: collectedAt is
// GpuSampleRing's Date.parse(generatedAt), i.e. epoch MILLISECONDS.
function ringSamples(count, lastMs) {
  return Array.from({ length: count }, (_, index) => ({
    collectedAt: lastMs - (count - 1 - index) * FINE_STEP * 1000,
    gpus: [{ index: "0", utilizationPercent: 60 + (index % 5), memoryUsedMb: 9000, memory_total_mb: 16384 }],
  }));
}

function deliverRemote(context, { bucketSeconds, gapBeforeValue }) {
  const data = compactGpuHistoryResponse({
    bucketSeconds,
    retentionHours: 72,
    updatedAt: new Date(T0 * 1000).toISOString(),
    series: [{ serverId: "nwpu3", gpuId: "0", rawPointCount: 40, points: coarseRawPoints(40, gapBeforeValue) }],
  });
  context.rememberGpuHistoryState({ status: "ready", fetchedAt: new Date(T0 * 1000).toISOString(), query: {}, data });
}

function deliverRingFrames(context, count, lastMs, requestId) {
  const reqId = requestId || 1;
  const key = "nwpu3::0";
  const entry = { id: reqId, workerId: "nwpu3", key, payload: { serverId: "nwpu3", gpuId: "0", maxPoints: 288 }, timer: 0 };
  context.gpuWindowPending.set(reqId, entry);
  context.gpuWindowPendingByKey.set(key, entry);
  context.applyGpuWindowSamples({ requestId: reqId, workerId: "nwpu3", samples: ringSamples(count, lastMs) });
}

// Explicit sample list (epoch MILLISECONDS per collectedAt contract), so a test
// can place a hole at an exact offset inside the ring window.
function deliverRingSamples(context, samples, requestId) {
  const reqId = requestId || 1;
  const key = "nwpu3::0";
  const entry = { id: reqId, workerId: "nwpu3", key, payload: { serverId: "nwpu3", gpuId: "0", maxPoints: 288 }, timer: 0 };
  context.gpuWindowPending.set(reqId, entry);
  context.gpuWindowPendingByKey.set(key, entry);
  context.applyGpuWindowSamples({ requestId: reqId, workerId: "nwpu3", samples });
}

function ringSamplesCovering(firstSec, count, stepSeconds) {
  return Array.from({ length: count }, (_, index) => ({
    collectedAt: (firstSec + index * (stepSeconds || FINE_STEP)) * 1000,
    gpus: [{ index: "0", utilizationPercent: 60 + (index % 5), memoryUsedMb: 9000, memory_total_mb: 16384 }],
  }));
}

// Mirror of drawGpuHistoryCanvas' util-line path: real gpuHistoryTimeRange
// clamp, real window filter, then the real drawHistoryLine with a recorder.
function utilLineMetrics(context, seriesList) {
  const range = context.gpuHistoryTimeRange(seriesList);
  if (!range) return { strokes: 0, drawnRows: 0, totalRows: 0, maxTime: 0 };
  const drawn = [];
  let strokes = 0;
  seriesList.forEach((item) => {
    const index = context.gpuHistoryPointIndex(item.points || []);
    index.rows.filter((point) => Number(point.bucketEpoch) >= range.min).forEach((point) => drawn.push(point));
    const fake = {
      save() {}, restore() {}, globalAlpha: 1, strokeStyle: "", fillStyle: "", lineWidth: 1,
      lineJoin: "", lineCap: "", setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {},
      stroke() { strokes += 1; },
    };
    context.drawHistoryLine(fake, index.rows.filter((point) => Number(point.bucketEpoch) >= range.min),
      { field: "gpuUtilPercent", color: "#000", dash: [], focus: "util" },
      range.min, range.max, PLOT, WIDTH - PLOT.left - PLOT.right, HEIGHT - PLOT.top - PLOT.bottom,
      "", index.expectedStep, 16384, "util");
  });
  return { strokes, drawnRows: drawn.length, totalRows: seriesList.reduce((sum, item) => sum + (item.points || []).length, 0), maxTime: range.max };
}

test("REPRO-1 ring fine frames must keep the series on the seconds time scale (unit contract)", () => {
  const context = chartContext();
  deliverRemote(context, { bucketSeconds: 60, gapBeforeValue: undefined });
  deliverRingFrames(context, 120, (T0 + 40 * COARSE_STEP) * 1000);
  const metrics = utilLineMetrics(context, [context.gpuHistorySeriesFor("nwpu3", "0")]);
  // Seconds-scale epochs in Oct 2024 sit near 1.73e9; a merged series must never
  // jump to the millisecond scale (~1.73e12). Today applyGpuWindowSamples stores
  // ring collectedAt (ms) as bucketEpoch, so maxTime explodes, the 24 h clamp
  // drops every coarse point and the chart collapses into a fine-point cluster.
  assert.ok(metrics.maxTime < 1e11,
    "merged series maxTime must stay epoch-seconds; actual maxTime=" + metrics.maxTime);
  assert.equal(metrics.drawnRows, metrics.totalRows,
    "continuous coarse+fine history must all fall inside the drawn window");
  assert.equal(metrics.strokes, 1, "the util line must stay one connected segment");
});

test("REPRO-2 null-gap coarse merge must not collapse the coarse gap threshold (median contract)", () => {
  // Scope note (host gap-fill): cluster_agent.py always emits authoritative
  // gapBefore booleans, so gapBefore:null coarse points are a DEFENSIVE case
  // (old agent payload). Per the approved plan this now drives the REAL merge
  // seam (applyGpuWindowSamples) instead of hand-concatenating arrays, because
  // gap decisions must be materialized per-segment BEFORE merging; the merged
  // fine-frame median must not re-judge the coarse run. Original hand-merge red
  // is preserved in evidence F03/F06 (/tmp/pi-test-2bn9_zal, /tmp/pi-test-6xnyj_rs).
  const context = chartContext();
  deliverRemote(context, { bucketSeconds: 60, gapBeforeValue: undefined });
  deliverRingFrames(context, 120, (T0 + 40 * COARSE_STEP) * 1000);
  const metrics = utilLineMetrics(context, [context.gpuHistorySeriesFor("nwpu3", "0")]);
  assert.equal(metrics.strokes, 1,
    "coarse(gapBefore:null)+contiguous fine with zero declared gaps must stay connected; actual strokes=" + metrics.strokes);
});

test("REPRO-3 overview peak merge with ring frames must stay complete and connected", () => {
  const context = chartContext();
  deliverRemote(context, { bucketSeconds: 60, gapBeforeValue: undefined });
  deliverRingFrames(context, 120, (T0 + 40 * COARSE_STEP) * 1000);
  const overview = context.gpuHistoryOverviewSeries({}, [{ serverId: "nwpu3" }]);
  assert.equal(overview.length, 1, "one merged server overview series");
  const metrics = utilLineMetrics(context, overview);
  assert.ok(metrics.maxTime < 1e11, "overview maxTime must stay epoch-seconds; actual=" + metrics.maxTime);
  assert.equal(metrics.strokes, 1, "overview util line must stay one connected segment");
});

// ── B③ negative assertions (per host-plan gap: explicit true / imputed / real
// holes must never be connected by any granularity fix) ──────────────────────

// Real agent contract verified against dist/runtime/cluster_agent.py
// (sha256 d399d5eaa87f9bfbfa631d43f72eff81ae5e9754aa34c5d7236601623c4d746b):
// GPU_HISTORY_BUCKET_SECONDS defaults to 60; downsample_gpu_history_points marks
// point["gapBefore"] with an authoritative boolean and normalize_gpu_history only
// emits REAL points. So bucketSeconds=60 metadata + 300 s returned step + explicit
// booleans (REPRO-2's shape) is the true contract; a returned-point boolean `true`
// is the only declaration of a real telemetry hole.
function contractSeries(holeIndex) {
  return Array.from({ length: 40 }, (_, index) => ({
    bucketEpoch: T0 + index * COARSE_STEP,
    gpuUtilPercent: 40 + (index % 7),
    memoryUtilPercent: 50,
    memoryUsedMb: 8000,
    memoryTotalMb: 16384,
    gapBefore: index === holeIndex, // authoritative boolean, exactly one real hole
    imputed: false,
  }));
}

test("CONTRACT-5 real-contract hole marker survives compaction and the coarse+fine merge", () => {
  const context = chartContext();
  const data = compactGpuHistoryResponse({
    bucketSeconds: 60,
    retentionHours: 72,
    updatedAt: new Date(T0 * 1000).toISOString(),
    series: [{ serverId: "nwpu3", gpuId: "0", rawPointCount: 40, points: contractSeries(20) }],
  });
  const compacted = data.series[0].points.find((row) => row.bucketEpoch === T0 + 20 * COARSE_STEP);
  assert.equal(compacted.gapBefore, true, "compaction must keep the authoritative hole marker (no fabricated continuity)");
  context.rememberGpuHistoryState({ status: "ready", fetchedAt: new Date(T0 * 1000).toISOString(), query: {}, data });
  const remote = context.gpuHistorySeriesFor("nwpu3", "0");
  // Fine frames at the CORRECTED seconds scale (what the unit fix will produce),
  // appended contiguously after the coarse run, all continuous.
  const fineSeconds = Array.from({ length: 120 }, (_, index) => ({
    bucketEpoch: T0 + 40 * COARSE_STEP - (119 - index) * FINE_STEP,
    gpuUtilPercent: 60 + (index % 5),
    memoryUtilPercent: 56, memoryUsedMb: 9000, memoryTotalMb: 16384,
    gapBefore: false, imputed: false,
  }));
  const metrics = utilLineMetrics(context, [{ serverId: "nwpu3", gpuId: "0", points: remote.points.concat(fineSeconds) }]);
  assert.ok(metrics.maxTime < 1e11, "series must stay epoch-seconds");
  assert.equal(metrics.strokes, 2,
    "exactly the declared hole splits the line (two segments); actual strokes=" + metrics.strokes);
});

test("SPEC-6 imputed points must break the line even with gapBefore=false", () => {
  const context = chartContext();
  const points = Array.from({ length: 12 }, (_, index) => ({
    bucketEpoch: T0 + index * COARSE_STEP,
    gpuUtilPercent: 45, memoryUtilPercent: 50, memoryUsedMb: 8000, memoryTotalMb: 16384,
    gapBefore: false, imputed: index === 6, // synthesized fill value
  }));
  const data = compactGpuHistoryResponse({
    bucketSeconds: 60, retentionHours: 72,
    updatedAt: new Date(T0 * 1000).toISOString(),
    series: [{ serverId: "nwpu3", gpuId: "0", rawPointCount: 12, points }],
  });
  assert.equal(data.series[0].points.find((row) => row.bucketEpoch === T0 + 6 * COARSE_STEP).imputed, true,
    "compaction preserves the imputed flag");
  const metrics = utilLineMetrics(context, [{ serverId: "nwpu3", gpuId: "0", points: data.series[0].points }]);
  // Host gap decision: imputed (value missing, filled) must keep breaking the
  // curve. VERIFIED ALREADY SATISFIED: drawHistoryLine flushes the segment at an
  // imputed point and never plots it (PanelHtml.legacy.js inline L12079/12082,
  // caption "补齐点未绘制"), so a fill can never be drawn as real telemetry.
  // This test pins that guarantee against any future granularity change.
  assert.ok(metrics.strokes >= 2,
    "imputed point must start a new segment instead of being connected; actual strokes=" + metrics.strokes);
});

test("SPEC-7 a real hole between remote coarse run and fine frames must not be connected", () => {
  // Real merge seam (per approved plan): ring frames arriving 2 h after the
  // remote run ended must split at the boundary, even though applyGpuWindowSamples
  // starts every frame with gapBefore:false.
  const context = chartContext();
  deliverRemote(context, { bucketSeconds: 60, gapBeforeValue: false });
  deliverRingFrames(context, 60, (T0 + 40 * COARSE_STEP + 7200 + 59 * FINE_STEP) * 1000);
  const metrics = utilLineMetrics(context, [context.gpuHistorySeriesFor("nwpu3", "0")]);
  assert.ok(metrics.strokes >= 2,
    "a 2 h hole at the segment merge boundary must split the line; actual strokes=" + metrics.strokes);
});

test("SPEC-8 a hole INSIDE the ring window must split by the ring's own sampling interval", () => {
  const context = chartContext();
  deliverRemote(context, { bucketSeconds: 60, gapBeforeValue: false });
  const ringStart = T0 + 40 * COARSE_STEP;
  const samples = ringSamplesCovering(ringStart, 10, FINE_STEP)
    .concat(ringSamplesCovering(ringStart + 9 * FINE_STEP + 1800, 10, FINE_STEP));
  deliverRingSamples(context, samples, 1);
  const metrics = utilLineMetrics(context, [context.gpuHistorySeriesFor("nwpu3", "0")]);
  assert.ok(metrics.strokes >= 2,
    "a 30 min hole among 15 s ring frames must break the line; actual strokes=" + metrics.strokes);
});

test("SPEC-9 repeated ring refresh keeps the remote-declared hole split (no loss on refresh)", () => {
  const context = chartContext();
  const data = compactGpuHistoryResponse({
    bucketSeconds: 60, retentionHours: 72,
    updatedAt: new Date(T0 * 1000).toISOString(),
    series: [{ serverId: "nwpu3", gpuId: "0", rawPointCount: 40, points: contractSeries(20) }],
  });
  context.rememberGpuHistoryState({ status: "ready", fetchedAt: new Date(T0 * 1000).toISOString(), query: {}, data });
  deliverRingFrames(context, 40, (T0 + 40 * COARSE_STEP) * 1000, 1);
  deliverRingFrames(context, 40, (T0 + 40 * COARSE_STEP + 600) * 1000, 2);
  const series = context.gpuHistorySeriesFor("nwpu3", "0");
  const hole = series.points.find((row) => row.bucketEpoch === T0 + 20 * COARSE_STEP);
  assert.equal(hole.gapBefore, true, "refresh must not erase the authoritative hole marker");
  const metrics = utilLineMetrics(context, [series]);
  assert.ok(metrics.strokes >= 2, "remote-declared hole must still split after refresh; actual strokes=" + metrics.strokes);
});

test("CONTROL seconds-scale fine merge stays connected when reported bucketSeconds >= coarse step", () => {
  const context = chartContext();
  deliverRemote(context, { bucketSeconds: 300, gapBeforeValue: undefined });
  const remote = context.gpuHistorySeriesFor("nwpu3", "0");
  const fineSeconds = Array.from({ length: 120 }, (_, index) => ({
    bucketEpoch: T0 + 40 * COARSE_STEP - (119 - index) * FINE_STEP,
    gpuUtilPercent: 60 + (index % 5),
    memoryUtilPercent: 56,
    memoryUsedMb: 9000,
    memoryTotalMb: 16384,
    gapBefore: false,
    imputed: false,
  }));
  const metrics = utilLineMetrics(context, [{ serverId: "nwpu3", gpuId: "0", points: remote.points.concat(fineSeconds) }]);
  assert.equal(metrics.strokes, 1);
});
