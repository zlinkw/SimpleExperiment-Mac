const test = require("node:test");
const assert = require("node:assert/strict");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("GPU history chart leaves missing buckets disconnected and exposes accessible legends", () => {
  const html = renderPanelHtml();
  assert.match(html, /GPU_HISTORY_GAP_FACTOR/);
  assert.match(html, /缺失数据不连接，也不补零/);
  assert.match(html, /GPU_HISTORY_SERIES_CACHE_LIMIT = 128/);
  assert.match(html, /point\.imputed === true/);
  assert.match(html, /gpuHistorySeriesStats/);
  assert.match(html, /historyGapCountFromIndex\(index\)/);
  assert.match(html, /function gpuHistoryTextSummary\(series, kind\) \{\s+const stats = gpuHistorySeriesStats\(series\)/);
  assert.match(html, /class="gpuLegendItem"/);
  assert.match(html, /data-gpu-history-focus/);
  assert.match(html, /tabindex="0" role="img"/);
  assert.match(html, /class="gpuHistoryTooltip" role="status"/);
  assert.match(html, /updateGpuHistoryTooltip/);
  assert.match(html, /let activeGpuHistoryTooltip = null/);
  assert.match(html, /activeGpuHistoryTooltip !== tooltip/);
  assert.doesNotMatch(html, /querySelectorAll\("\.gpuHistoryTooltip:not\(\[hidden\]\)"\)/);
  assert.match(html, /historyMemoryText/);
  assert.match(html, /GPU_HISTORY_LINE_STYLES/);
  assert.match(html, /GPU_HISTORY_MARKERS/);
  assert.match(html, /const timeRange = gpuHistoryTimeRange\(series\)/);
  assert.match(html, /GPU 利用率 \(%\)/);
  assert.match(html, /显存已用 \(MB\)/);
  assert.match(html, /最近 24 小时，线性时间/);
  assert.doesNotMatch(html, /近 3 小时占 52%|近 3 小时放大/);
  assert.match(html, /const pointIndex = gpuHistoryPointIndex\(item\.points \|\| \[\]\)/);
  assert.doesNotMatch(html, /asArray\(series\)\.flatMap\(\(item\) => asArray\(item\.points\)\)/);
});

test("GPU history server styling persists by server id and has fallback patterns", () => {
  const html = renderPanelHtml();
  assert.match(html, /simpleExperiment\.gpuHistoryServerStyles/);
  assert.match(html, /let gpuHistoryServerStylesSaveTimer = 0/);
  assert.match(html, /if \(gpuHistoryServerStylesSaveTimer\) return/);
  assert.match(html, /gpuHistoryServerStylesSaveTimer = setTimeout/);
  assert.match(html, /gpuHistoryServerStylesSaveTimer = 0;[\s\S]{0,180}localStorage\.setItem/);
  assert.match(html, /GPU_HISTORY_SERVER_STYLE_LIMIT = 128/);
  assert.match(html, /Object\.entries\(parsed\)[\s\S]{0,180}slice\(-GPU_HISTORY_SERVER_STYLE_LIMIT\)/);
  assert.match(html, /gpuHistoryServerStyleColorUsageCache/);
  assert.match(html, /function gpuHistoryServerStyleColorUsage\(/);
  assert.match(html, /adjustGpuHistoryServerStyleColorUsage\(removed && removed\.color, -1\)/);
  assert.match(html, /adjustGpuHistoryServerStyleColorUsage\(color, 1\)/);
  assert.match(html, /gpuHistoryServerStyle\(serverId\)/);
  assert.match(html, /lineDashForStyle/);
  assert.match(html, /gpuStableIndex/);
  assert.match(html, /GPU_HISTORY_OKLCH_CANDIDATES/);
  assert.match(html, /gpuHistoryOklchToHex/);
  assert.match(html, /gpuHistoryOklab/);
  assert.match(html, /chooseGpuHistoryColor/);
  assert.match(html, /GPU_HISTORY_MIN_COLOR_DISTANCE/);
});
