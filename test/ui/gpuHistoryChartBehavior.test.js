const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

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
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return script.slice(start, index + 1);
  }
  throw new Error("unclosed inline function " + name);
}

function chartContext(functionNames) {
  const context = {
    gpuHistoryServerStyles: {},
    gpuHistoryMeta: { bucketSeconds: 300 },
    gpuHistorySeriesCache: new Map(),
    gpuHistorySeriesRevision: 0,
    gpuHistoryOverviewCacheRevision: -1,
    gpuHistoryOverviewCacheState: null,
    gpuHistoryOverviewCacheServers: null,
    gpuHistoryOverviewCacheValue: [],
    gpuHistoryPointIndexCache: new WeakMap(),
    gpuHistoryOklabCache: new Map(),
    gpuHistoryServerStyleColorUsageCache: null,
    GPU_HISTORY_GAP_FACTOR: 1.75,
    GPU_HISTORY_SERVER_STYLE_LIMIT: 128,
    GPU_HISTORY_OKLAB_CACHE_LIMIT: 256,
    GPU_HISTORY_COLORS: ["#2885EF", "#CD8300", "#03A14A", "#E64343", "#A95DDA", "#00A3B4", "#C952A8", "#849B11", "#DE6907", "#009F89", "#CE4A72", "#008DBE"],
    GPU_HISTORY_LINE_STYLES: ["solid", "dash", "dot", "dashdot"],
    GPU_HISTORY_MARKERS: ["circle", "square", "triangle", "diamond"],
    GPU_HISTORY_MIN_COLOR_DISTANCE: 0.09,
    saveGpuHistoryServerStyles() {},
    asArray(value) { return Array.isArray(value) ? value : []; },
    gpuServerDisplayName(_state, server) { return server.serverId; },
  };
  const source = functionNames.map(inlineFunction).join("\n");
  vm.runInNewContext(source, context);
  return context;
}

test("GPU history server styles remain stable and distinguish 1, 2, 8, and 16 servers", () => {
  const context = chartContext([
    "gpuHistoryServerStyleColorUsage", "adjustGpuHistoryServerStyleColorUsage", "gpuHistoryServerStyle", "chooseGpuHistoryColor", "gpuHistoryColorDistance", "gpuHistoryOklab",
    "gpuStableIndex", "lineDashForStyle",
    "finiteHistoryPercent",
  ]);
  for (const count of [1, 2, 8, 16]) {
    const styles = Array.from({ length: count }, (_, index) => context.gpuHistoryServerStyle("server-" + index));
    const signatures = styles.map((style) => [style.color, JSON.stringify(style.dash), style.marker].join("|"));
    assert.equal(new Set(signatures).size, count);
    assert.ok(new Set(styles.map((style) => style.color)).size <= Math.min(count, 12));
    assert.ok(styles.every((style) => style.dash && style.marker));
  }
  const before = JSON.stringify(context.gpuHistoryServerStyle("server-3"));
  context.gpuHistoryServerStyle("server-new");
  assert.equal(JSON.stringify(context.gpuHistoryServerStyle("server-3")), before);
  const usage = context.gpuHistoryServerStyleColorUsage();
  assert.equal(context.gpuHistoryServerStyleColorUsage(), usage);
  assert.equal(Array.from(usage.values()).reduce((sum, count) => sum + count, 0), Object.keys(context.gpuHistoryServerStyles).length);
});

test("GPU history style eviction keeps the color usage index consistent", () => {
  const context = chartContext([
    "gpuHistoryServerStyleColorUsage", "adjustGpuHistoryServerStyleColorUsage", "gpuHistoryServerStyle", "chooseGpuHistoryColor", "gpuHistoryColorDistance", "gpuHistoryOklab",
    "gpuStableIndex", "lineDashForStyle",
  ]);
  context.GPU_HISTORY_SERVER_STYLE_LIMIT = 4;
  for (let index = 0; index < 7; index += 1) context.gpuHistoryServerStyle("bounded-" + index);
  const usage = context.gpuHistoryServerStyleColorUsage();
  assert.equal(Object.keys(context.gpuHistoryServerStyles).length, 4);
  assert.equal(Array.from(usage.values()).reduce((sum, count) => sum + count, 0), 4);
  assert.ok(Array.from(usage.values()).every((count) => count > 0));
});

test("GPU history style eviction indexes persisted styles before decrementing", () => {
  const context = chartContext([
    "gpuHistoryServerStyleColorUsage", "adjustGpuHistoryServerStyleColorUsage", "gpuHistoryServerStyle", "chooseGpuHistoryColor", "gpuHistoryColorDistance", "gpuHistoryOklab",
    "gpuStableIndex", "lineDashForStyle",
  ]);
  context.GPU_HISTORY_SERVER_STYLE_LIMIT = 2;
  context.gpuHistoryServerStyles = {
    oldest: { color: "#2885EF", dash: [], marker: "circle" },
    retained: { color: "#2885EF", dash: [], marker: "square" },
  };
  context.gpuHistoryServerStyleColorUsageCache = null;
  context.gpuHistoryServerStyle("new-server");
  const usage = context.gpuHistoryServerStyleColorUsage();
  const actualUsage = new Map();
  Object.values(context.gpuHistoryServerStyles).forEach((style) => actualUsage.set(style.color, (actualUsage.get(style.color) || 0) + 1));
  assert.equal(Object.keys(context.gpuHistoryServerStyles).length, 2);
  assert.equal(Object.hasOwn(context.gpuHistoryServerStyles, "oldest"), false);
  assert.equal(JSON.stringify(Array.from(usage.entries()).sort()), JSON.stringify(Array.from(actualUsage.entries()).sort()));
  assert.equal(Array.from(usage.values()).reduce((sum, count) => sum + count, 0), 2);
});

test("GPU history palette uses OKLCH candidates and OKLab color distance", () => {
  const context = chartContext(["chooseGpuHistoryColor", "gpuHistoryColorDistance", "gpuHistoryOklab", "gpuHistoryOklchToHex"]);
  assert.equal(context.gpuHistoryOklchToHex([0.62, 0.18, 255]), "#2885EF");
  const blueOrangeDistance = context.gpuHistoryColorDistance("#2885EF", "#CD8300");
  const blueOrangeRgbDistance = Math.sqrt((40 - 205) ** 2 + (133 - 131) ** 2 + (239 - 0) ** 2);
  assert.ok(blueOrangeDistance > 0.1);
  assert.notEqual(blueOrangeDistance, blueOrangeRgbDistance);
  assert.equal(context.chooseGpuHistoryColor(["#E64343"], ["#DE6907"]), "");
});

test("GPU history OKLab conversion cache reuses colors and stays bounded", () => {
  const context = chartContext(["gpuHistoryOklab"]);
  const first = context.gpuHistoryOklab("#2885EF");
  assert.equal(context.gpuHistoryOklab("#2885EF"), first);
  for (let index = 0; index < 300; index += 1) {
    context.gpuHistoryOklab("#" + index.toString(16).padStart(6, "0"));
  }
  assert.equal(context.gpuHistoryOklabCache.size, context.GPU_HISTORY_OKLAB_CACHE_LIMIT);
});

test("GPU history gap detection distinguishes explicit gaps from regular downsampling", () => {
  const context = chartContext(["historyExpectedStepFromSortedTimes", "historyExpectedStep", "gpuHistoryPointIndex", "historyPointStartsGap", "historyGapCountFromIndex", "historyGapCount"]);
  const source = inlineFunction("historyExpectedStepFromSortedTimes");
  assert.match(source, /for \(let index = 1; index < values\.length; index \+= 1\)/);
  assert.doesNotMatch(source, /\.slice\(|\.map\(|\.filter\(/);
  assert.equal(context.historyExpectedStepFromSortedTimes([0, 0, 300, 900]), 600);
  assert.equal(context.historyExpectedStepFromSortedTimes([300]), 300);
  context.GPU_HISTORY_GAP_FACTOR = 1.75;
  const sampled = [0, 2700, 5400].map((bucketEpoch) => ({ bucketEpoch }));
  assert.equal(context.historyGapCount(sampled), 0);
  const raw = Array.from({ length: 10 }, (_, index) => ({ bucketEpoch: index < 5 ? index * 300 : index * 300 + 300 }));
  assert.equal(context.historyGapCount(raw), 1);
  assert.equal(context.historyPointStartsGap({ bucketEpoch: 300, gapBefore: true }, { bucketEpoch: 0 }, 300), true);
});

test("GPU history summary stats reuse per-series indexes across servers", () => {
  const context = chartContext(["historyExpectedStepFromSortedTimes", "gpuHistoryPointIndex", "historyPointStartsGap", "historyGapCountFromIndex", "gpuHistorySeriesStats"]);
  const source = inlineFunction("gpuHistorySeriesStats");
  assert.doesNotMatch(source, /historyGapCountFromIndex\(index\)/);
  assert.match(source, /indexed\.forEach/);
  assert.match(source, /index\.rows\.filter/);
  const first = [{ bucketEpoch: 600, imputed: true }, { bucketEpoch: 300, imputed: false }];
  const second = [{ bucketEpoch: 900, imputed: false }, { bucketEpoch: 1200, imputed: true, gapBefore: true }];
  const stats = context.gpuHistorySeriesStats([{ points: first }, { points: second }]);
  assert.equal(JSON.stringify(stats), JSON.stringify({ pointCount: 4, imputedCount: 2, gapCount: 1, min: 300, max: 1200 }));
  assert.equal(context.gpuHistoryPointIndex(first), context.gpuHistoryPointIndex(first));
});

test("GPU overview curve uses per-time-bucket server GPU peak without zero filling", () => {
  const context = chartContext(["gpuHistoryOverviewSeries", "finiteHistoryPercent"]);
  context.gpuHistorySeriesCache.set("server-a::0", {
    serverId: "server-a", gpuId: "0", points: [
      { bucketEpoch: 100, timestamp: "t1", gpuUtilPercent: 20 },
      { bucketEpoch: 200, timestamp: "t2", gpuUtilPercent: 80 },
    ],
  });
  context.gpuHistorySeriesCache.set("server-a::1", {
    serverId: "server-a", gpuId: "1", points: [
      { bucketEpoch: 100, timestamp: "t1", gpuUtilPercent: 70 },
    ],
  });
  const result = context.gpuHistoryOverviewSeries({}, [{ serverId: "server-a" }]);
  assert.equal(JSON.stringify(result[0].points.map((point) => [point.bucketEpoch, point.gpuUtilPercent])), JSON.stringify([[100, 70], [200, 80]]));
  assert.equal(result[0].points.some((point) => point.gpuUtilPercent === 0), false);
});

test("GPU overview curve reuses aggregation until history revision changes", () => {
  const context = chartContext(["gpuHistoryOverviewSeries", "finiteHistoryPercent"]);
  const state = {};
  const servers = [{ serverId: "server-a" }];
  context.gpuHistorySeriesCache.set("server-a::0", {
    serverId: "server-a", gpuId: "0", points: [{ bucketEpoch: 100, gpuUtilPercent: 20 }],
  });
  const first = context.gpuHistoryOverviewSeries(state, servers);
  const reused = context.gpuHistoryOverviewSeries(state, servers);
  assert.equal(reused, first);

  context.gpuHistorySeriesCache.set("server-a::0", {
    serverId: "server-a", gpuId: "0", points: [{ bucketEpoch: 100, gpuUtilPercent: 80 }],
  });
  context.gpuHistorySeriesRevision += 1;
  const refreshed = context.gpuHistoryOverviewSeries(state, servers);
  assert.notEqual(refreshed, first);
  assert.equal(refreshed[0].points[0].gpuUtilPercent, 80);
});

test("GPU card hover text reports percentage and memory MB", () => {
  const context = chartContext(["finiteHistoryPercent", "historyPercentText", "historyMemoryText"]);
  assert.equal(context.historyPercentText(42.34), "42.3%");
  assert.equal(context.historyMemoryText({ memoryUsedMb: 1024.4, memoryTotalMb: 8192 }), "1024 / 8192 MB");
});

test("GPU history point index caches sorted points and uses gap-aware binary lookup", () => {
  const context = chartContext([
    "historyExpectedStepFromSortedTimes", "gpuHistoryPointIndex", "nearestHistoryPointFromIndex", "nearestHistoryPoint",
    "gpuHistoryTimeRange", "gpuHistoryNearestTimestamp",
  ]);
  const points = [
    { id: "late", bucketEpoch: 300 },
    { id: "early", bucketEpoch: 100 },
    { id: "middle", bucketEpoch: 200 },
  ];
  const firstIndex = context.gpuHistoryPointIndex(points);
  assert.equal(context.gpuHistoryPointIndex(points), firstIndex);
  assert.deepEqual(Array.from(firstIndex.times), [100, 200, 300]);
  assert.equal(context.nearestHistoryPoint(points, 220).id, "middle");
  assert.equal(context.nearestHistoryPoint(points, 2000), null);
  assert.equal(JSON.stringify(context.gpuHistoryTimeRange([{ points }])), JSON.stringify({ min: 100, max: 300 }));
  assert.equal(context.gpuHistoryNearestTimestamp([{ points }], 260), 300);
});

test("GPU history time maps every hour to the same width across a 24 hour chart", () => {
  const context = chartContext(["gpuHistoryTimeTransform", "gpuHistoryTimeInverseTransform"]);
  assert.equal(context.gpuHistoryTimeTransform(6 * 3600, 0, 24 * 3600, 960), 240);
  assert.equal(context.gpuHistoryTimeInverseTransform(240, 0, 24 * 3600, 960), 6 * 3600);
});

test("GPU history drawing uses straight gap-safe segments", () => {
  const context = chartContext(["finiteHistoryPercent", "historyPointStartsGap", "gpuHistoryTimeTransform", "drawHistoryMarker", "drawHistoryLine"]);
  const calls = { beginPath: 0, moveTo: 0, lineTo: 0, bezierCurveTo: 0, stroke: 0, fill: 0 };
  const canvas = {
    save() {}, restore() {}, setLineDash() {}, arc() {}, rect() {}, closePath() {}, bezierCurveTo() { calls.bezierCurveTo += 1; },
    beginPath() { calls.beginPath += 1; },
    moveTo() { calls.moveTo += 1; },
    lineTo() { calls.lineTo += 1; },
    stroke() { calls.stroke += 1; },
    fill() { calls.fill += 1; },
  };
  const points = Array.from({ length: 100 }, (_, index) => ({
    bucketEpoch: index * 300,
    gpuUtilPercent: index % 101,
    gapBefore: index === 50,
  }));
  context.drawHistoryLine(canvas, points, { field: "gpuUtilPercent", color: "#2563EB", dash: [], marker: "circle", focus: "util" }, 0, 99 * 300, { left: 0, top: 0 }, 990, 100, "", 300);
  assert.equal(calls.stroke, 2);
  assert.equal(calls.moveTo, 2);
  assert.equal(calls.lineTo, 98);
  assert.equal(calls.bezierCurveTo, 0);
  assert.equal(calls.fill, 0);
});

test("GPU history drawing skips imputed samples instead of inventing connecting values", () => {
  const context = chartContext(["finiteHistoryPercent", "historyPointStartsGap", "gpuHistoryTimeTransform", "drawHistoryLine"]);
  const calls = { lineTo: [], moveTo: [], stroke: 0 };
  const canvas = {
    save() {}, restore() {}, setLineDash() {},
    beginPath() {}, moveTo(x, y) { calls.moveTo.push([x, y]); }, lineTo(x, y) { calls.lineTo.push([x, y]); }, stroke() { calls.stroke += 1; },
  };
  const points = [
    { bucketEpoch: 0, gpuUtilPercent: 10 },
    { bucketEpoch: 300, gpuUtilPercent: 0, imputed: true },
    { bucketEpoch: 600, gpuUtilPercent: 80 },
  ];
  context.drawHistoryLine(canvas, points, { field: "gpuUtilPercent", color: "#2563EB", dash: [], focus: "util" }, 0, 600, { left: 0, top: 0 }, 600, 100, "", 300);
  assert.equal(calls.stroke, 2);
  assert.deepEqual(calls.lineTo, calls.moveTo);
});
